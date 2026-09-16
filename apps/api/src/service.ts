import { isDeepStrictEqual } from 'node:util';
import { PgBoss, type Db } from 'pg-boss';
import {
  connectDatabase,
  monitors,
  runs,
  incidents,
  checkRevisions,
  eq,
  desc,
  sql,
  and,
} from '@stillup/db';
import {
  evaluateHealth,
  visibleHealth,
  type CheckConfig,
  type Monitor,
  type Dashboard,
  type PublicStatus,
  type RevisionPage,
} from '@stillup/core';
import { executeCheck } from '@stillup/core/executor';
import { env } from './env';
import { migrate } from './migrate';

import { CheckError } from './errors';
export { CheckError } from './errors';
import { createNotifications } from './notifications';
import { createSecrets } from './secrets';
import { createStatusManagement } from './status-management';
import { createProbes } from './probes';
import type { PoolClient } from '@stillup/db';
import type { CheckResult } from '@stillup/core';
type CheckJob = {
  monitorId: string;
  scheduledAt: number;
  configRevision?: number;
  executionEpoch?: number;
};
type CheckChange =
  | { kind: 'edit'; config: CheckConfig }
  | { kind: 'enabled'; enabled: boolean }
  | { kind: 'archive' | 'restore' };

export async function createService() {
  let activePreviews = 0;
  await migrate(env.DATABASE_URL);
  const { pool, db } = connectDatabase(env.DATABASE_URL);
  const secrets = createSecrets(pool);
  const statusManagement = createStatusManagement(pool);
  const notifications = createNotifications(pool, secrets);
  await notifications.initialize();
  const probes = createProbes(pool, secrets, recordResult);
  const boss = new PgBoss({ connectionString: env.DATABASE_URL });
  boss.on('error', (error) => console.error('Queue error:', error.message));
  await boss.start();
  await boss.createQueue('http-check', {
    policy: 'exclusive',
    retryLimit: 2,
    retryDelay: 10,
    expireInSeconds: 90,
    retentionSeconds: 3600,
    deleteAfterSeconds: 86400,
  });
  await boss.createQueue('notify', {
    retryLimit: 5,
    retryDelay: 30,
    retryBackoff: true,
    expireInSeconds: 30,
    deleteAfterSeconds: 86400,
  });
  const toMonitor = (row: typeof monitors.$inferSelect): Monitor => ({
    id: row.id,
    config: row.config,
    configRevision: row.configRevision,
    archivedAt: row.archivedAt,
    enabled: row.enabled,
    health: row.archivedAt
      ? 'archived'
      : visibleHealth(row.status, row.enabled, row.lastObservedAt, row.config.intervalSeconds),
    lastRunAt: row.lastRunAt,
    lastObservedAt: row.lastObservedAt,
    lastDurationMs: row.lastDurationMs,
    lastOutcome: row.lastOutcome,
    createdAt: row.createdAt,
  });
  async function dashboard(): Promise<Dashboard> {
    const [rows, history, heartbeat] = await Promise.all([
      db.select().from(monitors).orderBy(desc(monitors.createdAt)),
      db.select().from(incidents).orderBy(desc(incidents.openedAt)).limit(50),
      pool.query<{ seen_at: Date }>('SELECT max(seen_at) AS seen_at FROM worker_health'),
    ]);
    return {
      monitors: rows.map(toMonitor),
      incidents: history,
      workerAt: heartbeat.rows[0]?.seen_at?.toISOString() ?? null,
      notificationsEnabled: (await notifications.listChannels()).some((c) => c.enabled),
    };
  }
  async function publicStatus(): Promise<PublicStatus> {
    const published = sql`(${monitors.config}->>'public')::boolean IS TRUE AND ${monitors.archivedAt} IS NULL`;
    const [components, history] = await Promise.all([
      db
        .select({
          id: monitors.id,
          name: sql<string>`${monitors.config}->>'name'`,
          status: monitors.status,
          enabled: monitors.enabled,
          lastObservedAt: monitors.lastObservedAt,
          intervalSeconds: sql<number>`(${monitors.config}->>'intervalSeconds')::integer`,
        })
        .from(monitors)
        .where(published)
        .orderBy(monitors.createdAt),
      db
        .select({
          id: incidents.id,
          monitorId: incidents.monitorId,
          name: incidents.name,
          openedAt: incidents.openedAt,
          resolvedAt: incidents.resolvedAt,
        })
        .from(incidents)
        .innerJoin(monitors, eq(incidents.monitorId, monitors.id))
        .where(published)
        .orderBy(desc(incidents.openedAt))
        .limit(50),
    ]);
    return statusManagement.decorate({
      title: env.STATUS_PAGE_TITLE,
      updatedAt: new Date().toISOString(),
      components: components.map((row) => ({
        id: row.id,
        name: row.name,
        health: visibleHealth(row.status, row.enabled, row.lastObservedAt, row.intervalSeconds),
        lastObservedAt: row.lastObservedAt,
      })),
      incidents: history,
    });
  }
  async function enqueue(id?: string) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const due = await client.query<{
        id: string;
        config: CheckConfig;
        config_revision: number;
        execution_epoch: number;
        enabled: boolean;
        archived_at: Date | null;
      }>(
        id
          ? 'SELECT * FROM monitors WHERE id=$1 FOR UPDATE'
          : 'SELECT * FROM monitors WHERE enabled AND archived_at IS NULL AND next_run_at <= now() ORDER BY next_run_at LIMIT 100 FOR UPDATE SKIP LOCKED',
        id ? [id] : [],
      );
      if (id && !due.rows.length) throw new CheckError(404, 'Check not found');
      if (id && (due.rows[0]!.archived_at || !due.rows[0]!.enabled))
        throw new CheckError(409, 'Restore and resume the check before running it');
      const adapter: Db = { executeSql: (text, values) => client.query(text, values) };
      let count = 0;
      for (const row of due.rows) {
        if (row.config.locationIds?.some((id) => id !== 'local')) {
          if (await probes.schedule(client, row)) count++;
          await client.query(
            "UPDATE monitors SET next_run_at=now() + ($2 * interval '1 second') WHERE id=$1",
            [row.id, row.config.intervalSeconds],
          );
          continue;
        }
        const jobId = await boss.send(
          'http-check',
          {
            monitorId: row.id,
            scheduledAt: Date.now(),
            configRevision: row.config_revision,
            executionEpoch: row.execution_epoch,
          },
          { singletonKey: `${row.id}:${row.execution_epoch}`, db: adapter },
        );
        if (jobId) count++;
        await client.query(
          "UPDATE monitors SET next_run_at=now() + ($2 * interval '1 second') WHERE id=$1",
          [row.id, row.config.intervalSeconds],
        );
      }
      await client.query('COMMIT');
      return count;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
  async function runJob(job: { id: string; data: CheckJob }) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const {
        rows: [row],
      } = await client.query('SELECT * FROM monitors WHERE id=$1 FOR UPDATE', [job.data.monitorId]);
      if (
        !row?.enabled ||
        row.config.locationIds?.some((id: string) => id !== 'local') ||
        row.archived_at ||
        row.config_revision !== (job.data.configRevision ?? 1) ||
        row.execution_epoch !== (job.data.executionEpoch ?? 1) ||
        (await client.query('SELECT 1 FROM runs WHERE id=$1', [job.id])).rowCount ||
        Date.now() - job.data.scheduledAt > Math.max(row.config.intervalSeconds * 2, 120) * 1000
      ) {
        await client.query('COMMIT');
        return;
      }
      const config = row.config as CheckConfig;
      const result = await executeCheck(config, {
        allowPrivateNetworks: env.ALLOW_PRIVATE_NETWORKS === 'true',
        secrets: await secrets.resolve([...Object.values(config.headers), config.body], client),
      });
      await recordResult(client, row, result, job.id);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
  async function recordResult(client: PoolClient, row: any, result: CheckResult, runId: string) {
    const config = row.config as CheckConfig;
    const state = evaluateHealth(
      { status: row.status, failures: row.failures, successes: row.successes },
      result.outcome,
      config.failureThreshold,
      config.recoveryThreshold,
    );
    await client.query(
      'INSERT INTO runs (id,monitor_id,outcome,status_code,duration_ms,failures,checked_at,config_revision,assertions) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT DO NOTHING',
      [
        runId,
        row.id,
        result.outcome,
        result.statusCode,
        result.durationMs,
        JSON.stringify(result.failures),
        result.checkedAt,
        row.config_revision,
        JSON.stringify(result.assertions ?? []),
      ],
    );
    await client.query(
      "UPDATE monitors SET status=$2, failures=$3, successes=$4, last_run_at=$5, last_duration_ms=$6, last_outcome=$7, last_observed_at=CASE WHEN $7='error' THEN last_observed_at ELSE $5 END WHERE id=$1",
      [
        row.id,
        state.status,
        state.failures,
        state.successes,
        result.checkedAt,
        result.durationMs,
        result.outcome,
      ],
    );
    let event: import('@stillup/core').AlertEvent | null = null;
    if (state.status === 'down' && row.status !== 'down') {
      const {
        rows: [incident],
      } = await client.query(
        'INSERT INTO incidents (monitor_id,name,opened_at) VALUES ($1,$2,$3) RETURNING id',
        [row.id, config.name, result.checkedAt],
      );
      event = {
        id: incident.id,
        type: 'incident.opened',
        name: config.name,
        at: result.checkedAt,
      };
    } else if (state.status === 'up' && row.status === 'down') {
      const {
        rows: [incident],
      } = await client.query(
        'UPDATE incidents SET resolved_at=$2 WHERE monitor_id=$1 AND resolved_at IS NULL RETURNING id',
        [row.id, result.checkedAt],
      );
      if (incident)
        event = {
          id: incident.id,
          type: 'incident.resolved',
          name: config.name,
          at: result.checkedAt,
        };
    }
    if (event) {
      Object.assign(event, {
        monitorId: row.id,
        runId: runId,
        configRevision: row.config_revision,
      });
      await client.query(
        'INSERT INTO incident_events(incident_id,type,at,run_id,config_revision,result) VALUES($1,$2,$3,$4,$5,$6)',
        [event.id, event.type, event.at, runId, row.config_revision, JSON.stringify(result)],
      );
      await notifications.queueEvent(client, event, config, `${event.id}:${event.type}`);
    }
  }
  async function changeCheck(id: string, change: CheckChange, expectedRevision?: number) {
    if (change.kind === 'edit') {
      await notifications.validateRoutes(change.config);
      await probes.validate(change.config);
    }
    return db.transaction(async (tx) => {
      const [row] = await tx.select().from(monitors).where(eq(monitors.id, id)).for('update');
      if (!row) throw new CheckError(404, 'Check not found');
      if (expectedRevision !== undefined && row.configRevision !== expectedRevision) {
        throw new CheckError(
          409,
          'This check was edited elsewhere. Reopen the editor to load the latest configuration. Your changes have not been saved.',
        );
      }
      if (
        (change.kind === 'archive' && row.archivedAt) ||
        (change.kind === 'restore' && !row.archivedAt)
      )
        return toMonitor(row);
      if (row.archivedAt && change.kind !== 'restore')
        throw new CheckError(409, 'Restore this archived check before changing it');
      if (change.kind === 'edit' && isDeepStrictEqual(change.config, row.config))
        return toMonitor(row);
      if (change.kind === 'enabled' && change.enabled === row.enabled) return toMonitor(row);
      const now = new Date().toISOString();
      const values: Partial<typeof monitors.$inferInsert> = {
        executionEpoch: row.executionEpoch + 1,
      };
      if (change.kind === 'edit') {
        values.config = change.config;
        values.configRevision = row.configRevision + 1;
        await tx
          .insert(checkRevisions)
          .values({ monitorId: id, revision: values.configRevision, config: change.config });
      }
      if (change.kind === 'archive') Object.assign(values, { archivedAt: now, enabled: false });
      if (change.kind === 'restore') Object.assign(values, { archivedAt: null, enabled: false });
      if (change.kind === 'enabled') values.enabled = change.enabled;
      if (change.kind === 'edit' || (change.kind === 'enabled' && change.enabled)) {
        // An edit is not a recovery: retain an open incident until real observations resolve it.
        Object.assign(values, {
          nextRunAt: now,
          failures: 0,
          successes: 0,
          lastObservedAt: null,
          lastRunAt: null,
          lastOutcome: null,
          lastDurationMs: null,
          status: row.status === 'down' ? 'down' : 'unknown',
        });
      }
      const [updated] = await tx
        .update(monitors)
        .set(values)
        .where(eq(monitors.id, id))
        .returning();
      return toMonitor(updated!);
    });
  }
  async function requireCheck(id: string) {
    const [row] = await db.select().from(monitors).where(eq(monitors.id, id));
    if (!row) throw new CheckError(404, 'Check not found');
    return row;
  }
  async function getRevisions(id: string, before?: number): Promise<RevisionPage> {
    await requireCheck(id);
    const rows = await db
      .select()
      .from(checkRevisions)
      .where(
        and(
          eq(checkRevisions.monitorId, id),
          before ? sql`${checkRevisions.revision} < ${before}` : undefined,
        ),
      )
      .orderBy(desc(checkRevisions.revision))
      .limit(21);
    const revisions = rows.slice(0, 20);
    return { revisions, nextBefore: rows.length > 20 ? revisions.at(-1)!.revision : null };
  }
  async function getRevision(id: string, revision: number) {
    const [row] = await db
      .select()
      .from(checkRevisions)
      .where(and(eq(checkRevisions.monitorId, id), eq(checkRevisions.revision, revision)));
    if (!row) throw new CheckError(404, 'Configuration revision not found');
    return row;
  }
  async function incidentTimeline(
    id: string,
    before?: string,
  ): Promise<import('@stillup/core').IncidentTimeline> {
    const [incident] = await db.select().from(incidents).where(eq(incidents.id, id));
    if (!incident) throw new CheckError(404, 'Incident not found');
    const [events, observations] = await Promise.all([
      pool.query('SELECT * FROM incident_events WHERE incident_id=$1 ORDER BY at,id', [id]),
      db
        .select()
        .from(runs)
        .where(
          and(
            eq(runs.monitorId, incident.monitorId),
            sql`${runs.checkedAt} >= ${incident.openedAt}::timestamptz`,
            incident.resolvedAt
              ? sql`${runs.checkedAt} <= ${incident.resolvedAt}::timestamptz`
              : undefined,
            before
              ? sql`(${runs.checkedAt},${runs.id}) < (SELECT checked_at,id FROM runs WHERE id=${before}::uuid)`
              : undefined,
          ),
        )
        .orderBy(desc(runs.checkedAt), desc(runs.id))
        .limit(51),
    ]);
    return {
      incident,
      events: events.rows.map((e) => ({
        id: e.id,
        type: e.type,
        at: e.at.toISOString(),
        runId: e.run_id,
        configRevision: e.config_revision,
        result: e.result,
      })),
      observations: observations.slice(0, 50),
      nextBefore: observations.length > 50 ? observations[49]!.id : null,
    };
  }
  async function startWorker() {
    await boss.work<CheckJob>(
      'http-check',
      { localConcurrency: 5, pollingIntervalSeconds: 1 },
      async (jobs) => {
        for (const job of jobs) await runJob(job);
      },
    );
    // Drain jobs queued by older versions into the durable delivery ledger.
    await boss.work<import('@stillup/core').AlertEvent>(
      'notify',
      { pollingIntervalSeconds: 1 },
      async (jobs) => {
        for (const job of jobs) await notifications.legacy(job);
      },
    );
    let stopping = false;
    let lastCleanup = 0;
    const loop = async () => {
      while (!stopping) {
        try {
          await probes.expire();
          await enqueue();
          await pool.query(
            "INSERT INTO worker_health(id,seen_at) VALUES ('primary',now()) ON CONFLICT (id) DO UPDATE SET seen_at=now()",
          );
          if (Date.now() - lastCleanup > 3600000) {
            await pool.query(
              "DELETE FROM runs WHERE checked_at < now() - ($1 * interval '1 day')",
              [env.RUN_RETENTION_DAYS],
            );
            await pool.query(
              "DELETE FROM probe_rounds WHERE finished_at IS NOT NULL AND created_at < now() - ($1 * interval '1 day')",
              [env.RUN_RETENTION_DAYS],
            );
            lastCleanup = Date.now();
          }
        } catch (error) {
          console.error('Scheduler error:', error instanceof Error ? error.message : 'Unknown');
        }
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    };
    const alertLoop = async () => {
      while (!stopping) {
        try {
          await notifications.reminders();
          const results = await Promise.allSettled(
            Array.from({ length: 5 }, () => notifications.deliverOne()),
          );
          if (results.some((result) => result.status === 'rejected'))
            console.error('A notification attempt could not be recorded; its lease will recover');
        } catch {
          console.error('Notification worker could not complete a delivery cycle');
        }
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    };
    const probeLoop = async () => {
      while (!stopping) {
        try {
          await probes.local();
        } catch {
          console.error('Local probe could not complete its cycle');
        }
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    };
    const task = Promise.all([
      loop(),
      alertLoop(),
      ...Array.from({ length: 5 }, () => probeLoop()),
    ]);
    return async () => {
      stopping = true;
      await task;
    };
  }
  return {
    probes,
    secrets,
    statusManagement,
    notifications,
    incidentTimeline,
    db,
    pool,
    boss,
    dashboard,
    publicStatus,
    enqueue,
    runJob,
    startWorker,
    toMonitor,
    changeCheck,
    getRevisions,
    getRevision,
    async testCheck(config: CheckConfig) {
      if (activePreviews >= 2)
        throw new CheckError(429, 'Two request tests are already running. Try again shortly.');
      activePreviews++;
      try {
        return await executeCheck(config, {
          allowPrivateNetworks: env.ALLOW_PRIVATE_NETWORKS === 'true',
          secrets: await secrets.resolve([...Object.values(config.headers), config.body]),
        });
      } finally {
        activePreviews--;
      }
    },
    async getCheck(id: string) {
      return toMonitor(await requireCheck(id));
    },
    async createCheck(config: CheckConfig) {
      await notifications.validateRoutes(config);
      await probes.validate(config);
      return db.transaction(async (tx) => {
        const [row] = await tx.insert(monitors).values({ config }).returning();
        await tx
          .insert(checkRevisions)
          .values({ monitorId: row!.id, revision: 1, config, createdAt: row!.createdAt });
        return toMonitor(row!);
      });
    },
    async getRuns(id: string) {
      await requireCheck(id);
      return db
        .select()
        .from(runs)
        .where(eq(runs.monitorId, id))
        .orderBy(desc(runs.checkedAt))
        .limit(50);
    },
    async close() {
      await boss.stop({ graceful: true, timeout: 40000 });
      await pool.end();
    },
  };
}
export type Service = Awaited<ReturnType<typeof createService>>;
