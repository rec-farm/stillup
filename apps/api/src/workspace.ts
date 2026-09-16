import { connectDatabase } from '@stillup/db';
import {
  workspaceSettingsSchema,
  defaultWorkspaceSettings,
  type WorkspaceAppearance,
} from '@stillup/core';
import { CheckError } from './errors';
type Pool = ReturnType<typeof connectDatabase>['pool'];

export function createWorkspaceSettings(pool: Pool) {
  async function read(): Promise<WorkspaceAppearance> {
    const row = (await pool.query('SELECT config, revision FROM workspace_settings WHERE id=1'))
      .rows[0];
    return {
      settings: row ? workspaceSettingsSchema.parse(row.config) : defaultWorkspaceSettings,
      revision: row?.revision ?? 0,
    };
  }
  async function save(input: unknown, expectedRevision: number) {
    const config = workspaceSettingsSchema.parse(input);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT pg_advisory_xact_lock(hashtext('stillup-workspace-settings'))");
      const row = (await client.query('SELECT revision FROM workspace_settings WHERE id=1'))
        .rows[0];
      if ((row?.revision ?? 0) !== expectedRevision)
        throw new CheckError(
          409,
          'Appearance changed elsewhere. Close and reopen this editor to load the latest settings.',
        );
      const result = await client.query(
        'INSERT INTO workspace_settings(id,config,revision) VALUES(1,$1,1) ON CONFLICT(id) DO UPDATE SET config=$1,revision=workspace_settings.revision+1 RETURNING revision',
        [JSON.stringify(config)],
      );
      await client.query('COMMIT');
      return { settings: config, revision: result.rows[0].revision };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
  return { read, save };
}
