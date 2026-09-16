import { createHash } from 'node:crypto';
import type { connectDatabase } from '@stillup/db';
import {
  canonicalJson,
  changedConfigFields,
  type CodeConfig,
  type CodePlan,
} from '@stillup/core/code-config';
import type { CheckConfig } from '@stillup/core';
import { CheckError } from './errors';

type Row = {
  id: string;
  code_key: string;
  config: CheckConfig;
  config_revision: number;
  execution_epoch: number;
  archived_at: Date | null;
  enabled: boolean;
};
export function createCodeManagement(
  pool: ReturnType<typeof connectDatabase>['pool'],
  validate: (config: CheckConfig) => Promise<void>,
) {
  async function reconcile(config: CodeConfig, expectedToken?: string): Promise<CodePlan> {
    for (const check of config.checks) await validate(check.config);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // Serialize creation as well as edits, including a project's first deployment.
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
        `stillup-code:${config.project}`,
      ]);
      const { rows } = await client.query<Row>(
        'SELECT * FROM monitors WHERE code_project=$1 ORDER BY code_key FOR UPDATE',
        [config.project],
      );
      const existing = new Map(rows.map((r) => [r.code_key, r]));
      const desired = new Set(config.checks.map((c) => c.id));
      const changes: CodePlan['changes'] = config.checks.map((check) => {
        const row = existing.get(check.id);
        const fields = row
          ? changedConfigFields(row.config, check.config)
          : Object.keys(check.config).sort();
        return {
          id: check.id,
          action: !row ? 'create' : fields.length ? 'update' : 'unchanged',
          fields,
          ...(row
            ? {
                monitorId: row.id,
                revision: row.config_revision,
                paused: !row.enabled,
                archived: !!row.archived_at,
              }
            : {}),
        };
      });
      for (const row of rows)
        if (!desired.has(row.code_key))
          changes.push({
            id: row.code_key,
            action: 'retained',
            fields: [],
            monitorId: row.id,
            revision: row.config_revision,
            paused: !row.enabled,
            archived: !!row.archived_at,
          });
      const token = createHash('sha256')
        .update(
          canonicalJson({
            desired: {
              ...config,
              checks: [...config.checks].sort((a, b) => a.id.localeCompare(b.id)),
            },
            existing: rows.map((r) => ({
              id: r.id,
              key: r.code_key,
              config: r.config,
              revision: r.config_revision,
              epoch: r.execution_epoch,
              archived: r.archived_at?.toISOString() ?? null,
              enabled: r.enabled,
            })),
          }),
        )
        .digest('hex');
      const plan: CodePlan = { project: config.project, token, changes };
      if (expectedToken !== undefined) {
        if (expectedToken !== token)
          throw new CheckError(
            409,
            'The project changed after this preview. Run diff and apply again. Nothing was applied.',
          );
        for (const check of config.checks) {
          const row = existing.get(check.id);
          if (row && !changedConfigFields(row.config, check.config).length) continue;
          if (row?.archived_at)
            throw new CheckError(
              409,
              `Restore code check ${check.id} in the dashboard before updating it. Nothing was applied.`,
            );
          if (!row) {
            const result = await client.query<{ id: string }>(
              'INSERT INTO monitors(config,code_project,code_key) VALUES($1,$2,$3) RETURNING id',
              [JSON.stringify(check.config), config.project, check.id],
            );
            await client.query(
              'INSERT INTO check_revisions(monitor_id,revision,config) VALUES($1,1,$2)',
              [result.rows[0]!.id, JSON.stringify(check.config)],
            );
          } else {
            const revision = row.config_revision + 1;
            await client.query(
              'INSERT INTO check_revisions(monitor_id,revision,config) VALUES($1,$2,$3)',
              [row.id, revision, JSON.stringify(check.config)],
            );
            await client.query(
              `UPDATE monitors SET config=$2, config_revision=$3, execution_epoch=execution_epoch+1,
              next_run_at=now(), failures=0, successes=0, last_observed_at=NULL, last_run_at=NULL,
              last_outcome=NULL, last_duration_ms=NULL, status=CASE WHEN status='down' THEN 'down' ELSE 'unknown' END WHERE id=$1`,
              [row.id, JSON.stringify(check.config), revision],
            );
          }
        }
      }
      await client.query('COMMIT');
      return plan;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
  return {
    plan: (config: CodeConfig) => reconcile(config),
    apply: (config: CodeConfig, token: string) => reconcile(config, token),
  };
}
