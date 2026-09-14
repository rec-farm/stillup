import { PgBoss, type Db } from 'pg-boss';
import { connectDatabase, monitors, runs, incidents, eq, desc, sql } from '@stillup/db';
import {
  evaluateHealth,
  visibleHealth,
  type CheckConfig,
  type Monitor,
  type Dashboard,
  type PublicStatus,
} from '@stillup/core';
import { executeCheck } from '@stillup/core/executor';
import { env } from './env';
import { migrate } from './migrate';

export async function createService() {
  await migrate(env.DATABASE_URL);
  const { pool, db } = connectDatabase(env.DATABASE_URL);
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
    enabled: row.enabled,
    health: visibleHealth(row.status, row.enabled, row.lastObservedAt, row.config.intervalSeconds),
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
      notificationsEnabled: Boolean(env.ALERT_WEBHOOK_URL),
    };
  }
  async function publicStatus(): Promise<PublicStatus> {
    const published = sql`(${monitors.config}->>'public')::boolean IS TRUE`;
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
    return {
      title: env.STATUS_PAGE_TITLE,
      updatedAt: new Date().toISOString(),
      components: components.map((row) => ({
        id: row.id,
        name: row.name,
        health: visibleHealth(row.status, row.enabled, row.lastObservedAt, row.intervalSeconds),
        lastObservedAt: row.lastObservedAt,
      })),
      incidents: history,
    };
  }
  async function enqueue(id?: string) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const due = await client.query<{ id: string; config: CheckConfig }>(
        id
          ? 'SELECT id, config FROM monitors WHERE id=$1 AND enabled FOR UPDATE'
          : 'SELECT id, config FROM monitors WHERE enabled AND next_run_at <= now() ORDER BY next_run_at LIMIT 100 FOR UPDATE SKIP LOCKED',
        id ? [id] : [],
      );
      const adapter: Db = { executeSql: (text, values) => client.query(text, values) };
      let count = 0;
      for (const row of due.rows) {
        const jobId = await boss.send(
          'http-check',
          { monitorId: row.id, scheduledAt: Date.now() },
          { singletonKey: row.id, db: adapter },
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
  async function runJob(job: { id: string; data: { monitorId: string; scheduledAt: number } }) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const {
        rows: [row],
      } = await client.query('SELECT * FROM monitors WHERE id=$1 FOR UPDATE', [job.data.monitorId]);
      if (
        !row?.enabled ||
        (await client.query('SELECT 1 FROM runs WHERE id=$1', [job.id])).rowCount ||
        Date.now() - job.data.scheduledAt > Math.max(row.config.intervalSeconds * 2, 120) * 1000
      ) {
        await client.query('COMMIT');
        return;
      }
      const config = row.config as CheckConfig;
      const result = await executeCheck(config, {
        allowPrivateNetworks: env.ALLOW_PRIVATE_NETWORKS === 'true',
        secrets: process.env,
      });
      const state = evaluateHealth(
        { status: row.status, failures: row.failures, successes: row.successes },
        result.outcome,
        config.failureThreshold,
        config.recoveryThreshold,
      );
      await client.query(
        'INSERT INTO runs (id,monitor_id,outcome,status_code,duration_ms,failures,checked_at) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING',
        [
          job.id,
          row.id,
          result.outcome,
          result.statusCode,
          result.durationMs,
          JSON.stringify(result.failures),
          result.checkedAt,
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
      let event: { id: string; type: string; name: string; at: string } | null = null;
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
      if (event && env.ALERT_WEBHOOK_URL)
        await boss.send('notify', event, {
          db: { executeSql: (text, values) => client.query(text, values) },
        });
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
  async function startWorker() {
    await boss.work<{ monitorId: string; scheduledAt: number }>(
      'http-check',
      { localConcurrency: 5, pollingIntervalSeconds: 1 },
      async (jobs) => {
        for (const job of jobs) await runJob(job);
      },
    );
    await boss.work<{ id: string; type: string; name: string; at: string }>(
      'notify',
      { pollingIntervalSeconds: 1 },
      async (jobs) => {
        for (const job of jobs) {
          if (!env.ALERT_WEBHOOK_URL) throw new Error('Webhook is not configured');
          const response = await fetch(env.ALERT_WEBHOOK_URL, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'idempotency-key': job.id },
            body: JSON.stringify({ eventId: job.id, ...job.data }),
            redirect: 'error',
            signal: AbortSignal.timeout(10000),
          });
          await response.body?.cancel();
          if (!response.ok) throw new Error(`Webhook returned ${response.status}`);
        }
      },
    );
    let stopping = false;
    let lastCleanup = 0;
    const loop = async () => {
      while (!stopping) {
        try {
          await enqueue();
          await pool.query(
            "INSERT INTO worker_health(id,seen_at) VALUES ('primary',now()) ON CONFLICT (id) DO UPDATE SET seen_at=now()",
          );
          if (Date.now() - lastCleanup > 3600000) {
            await pool.query(
              "DELETE FROM runs WHERE checked_at < now() - ($1 * interval '1 day')",
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
    const task = loop();
    return async () => {
      stopping = true;
      await task;
    };
  }
  return {
    db,
    pool,
    boss,
    dashboard,
    publicStatus,
    enqueue,
    runJob,
    startWorker,
    toMonitor,
    async createCheck(config: CheckConfig) {
      const [row] = await db.insert(monitors).values({ config }).returning();
      return toMonitor(row!);
    },
    async getRuns(id: string) {
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
