import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { connectDatabase, type PoolClient } from '@stillup/db';
import {
  aggregateLocations,
  locationCreateSchema,
  probeReportSchema,
  type CheckConfig,
  type CheckResult,
  type ProbeLocation,
  type RegionalObservation,
} from '@stillup/core';
import { executeCheck } from '@stillup/core/executor';
import { CheckError } from './errors';
import { env } from './env';
import type { createSecrets } from './secrets';
type Pool = ReturnType<typeof connectDatabase>['pool'];
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const locationStatus = (row: any): ProbeLocation['status'] =>
  row.revoked_at
    ? 'revoked'
    : row.last_seen_at && Date.now() - new Date(row.last_seen_at).getTime() < 45000
      ? 'online'
      : row.token_hash || row.id === 'local'
        ? 'offline'
        : 'pending';
export function createProbes(
  pool: Pool,
  secrets: ReturnType<typeof createSecrets>,
  record: (client: PoolClient, row: any, result: CheckResult, runId: string) => Promise<void>,
) {
  async function list(): Promise<ProbeLocation[]> {
    const { rows } = await pool.query(
      'SELECT id,name,region,last_seen_at,revoked_at,enrollment_expires_at,token_hash IS NOT NULL AS enrolled FROM probe_locations ORDER BY created_at',
    );
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      region: r.region,
      status: locationStatus({ ...r, token_hash: r.enrolled }),
      lastSeenAt: r.last_seen_at?.toISOString() ?? null,
      enrollmentExpiresAt: r.enrollment_expires_at?.toISOString() ?? null,
    }));
  }
  async function create(input: unknown) {
    const value = locationCreateSchema.parse(input);
    const token = randomBytes(32).toString('hex');
    const id = randomUUID();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT pg_advisory_xact_lock(hashtext('stillup-location-registration'))");
      if (Number((await client.query('SELECT count(*) FROM probe_locations')).rows[0].count) >= 100)
        throw new CheckError(409, 'This installation supports up to 100 locations');
      const { rows } = await client.query(
        "INSERT INTO probe_locations(id,name,region,enrollment_hash,enrollment_expires_at) VALUES($1,$2,$3,$4,now()+interval '15 minutes') RETURNING enrollment_expires_at",
        [id, value.name, value.region, hash(token)],
      );
      await client.query('COMMIT');
      return { id, enrollmentToken: token, expiresAt: rows[0].enrollment_expires_at.toISOString() };
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }
  async function renew(id: string) {
    const token = randomBytes(32).toString('hex');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query(
        "UPDATE probe_locations SET enrollment_hash=$2,enrollment_expires_at=now()+interval '15 minutes',token_hash=NULL,last_seen_at=NULL,revoked_at=NULL WHERE id=$1 AND id<>'local' RETURNING id,enrollment_expires_at",
        [id, hash(token)],
      );
      if (!rows.length) throw new CheckError(404, 'Remote location not found');
      await client.query(
        'UPDATE probe_jobs SET lease_until=NULL,lease_token=NULL WHERE location_id=$1 AND completed_at IS NULL',
        [id],
      );
      await client.query('COMMIT');
      return { id, enrollmentToken: token, expiresAt: rows[0].enrollment_expires_at.toISOString() };
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }
  async function revoke(id: string) {
    const r = await pool.query(
      "UPDATE probe_locations SET revoked_at=now(),token_hash=NULL,enrollment_hash=NULL WHERE id=$1 AND id<>'local'",
      [id],
    );
    if (!r.rowCount) throw new CheckError(404, 'Remote location not found');
    return { ok: true };
  }
  async function enroll(enrollmentToken: string, credential: string) {
    // The runner persists its chosen credential before enrollment. Repeating a lost response is safe.
    const r = await pool.query(
      'UPDATE probe_locations SET token_hash=$2,last_seen_at=now() WHERE enrollment_hash=$1 AND enrollment_expires_at>now() AND revoked_at IS NULL AND (token_hash IS NULL OR token_hash=$2) RETURNING id',
      [hash(enrollmentToken), hash(credential)],
    );
    if (!r.rowCount) throw new CheckError(401, 'Enrollment expired, already used, or revoked');
    return { locationId: r.rows[0].id, protocolVersion: 1 };
  }
  async function authenticate(token: string) {
    const r = await pool.query(
      'SELECT id FROM probe_locations WHERE token_hash=$1 AND revoked_at IS NULL',
      [hash(token)],
    );
    if (!r.rowCount) throw new CheckError(401, 'Probe credential is invalid or revoked');
    return r.rows[0].id as string;
  }
  async function validate(config: CheckConfig) {
    const ids = config.locationIds ?? ['local'];
    const r = await pool.query(
      'SELECT id FROM probe_locations WHERE id=ANY($1::text[]) AND revoked_at IS NULL',
      [ids],
    );
    if (r.rowCount !== ids.length)
      throw new CheckError(400, 'Choose existing, non-revoked locations');
  }
  async function schedule(client: PoolClient, row: any) {
    // Edits invalidate old work; a round must not block its replacement until the old deadline.
    await client.query(
      'UPDATE probe_rounds SET finished_at=now() WHERE monitor_id=$1 AND finished_at IS NULL AND (execution_epoch<>$2 OR config_revision<>$3)',
      [row.id, row.execution_epoch, row.config_revision],
    );
    const id = randomUUID();
    const r = await client.query(
      "INSERT INTO probe_rounds(id,monitor_id,config_revision,execution_epoch,deadline) VALUES($1,$2,$3,$4,now()+interval '60 seconds') ON CONFLICT DO NOTHING RETURNING id",
      [id, row.id, row.config_revision, row.execution_epoch],
    );
    if (!r.rowCount) return false;
    for (const location of row.config.locationIds ?? ['local'])
      await client.query('INSERT INTO probe_jobs(id,round_id,location_id) VALUES($1,$2,$3)', [
        randomUUID(),
        id,
        location,
      ]);
    return true;
  }
  async function claim(id: string, credential?: string) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const location = (
        await client.query(
          'SELECT * FROM probe_locations WHERE id=$1 AND revoked_at IS NULL FOR UPDATE',
          [id],
        )
      ).rows[0];
      if (!location || (credential !== undefined && location.token_hash !== hash(credential)))
        throw new CheckError(401, 'Probe credential is invalid or revoked');
      await client.query('UPDATE probe_locations SET last_seen_at=now() WHERE id=$1', [id]);
      const { rows } = await client.query(
        `SELECT j.id,j.round_id,m.config FROM probe_jobs j JOIN probe_rounds r ON r.id=j.round_id JOIN monitors m ON m.id=r.monitor_id
        WHERE j.location_id=$1 AND j.completed_at IS NULL AND (j.lease_until IS NULL OR j.lease_until<now())
        AND r.finished_at IS NULL AND r.deadline>now()+interval '5 seconds' AND m.enabled AND m.archived_at IS NULL
        AND m.config_revision=r.config_revision AND m.execution_epoch=r.execution_epoch ORDER BY r.created_at LIMIT 1 FOR UPDATE OF j SKIP LOCKED`,
        [id],
      );
      if (!rows.length) {
        await client.query('COMMIT');
        return { job: null, protocolVersion: 1 };
      }
      const row = rows[0];
      const leaseToken = randomUUID();
      const lease = (
        await client.query(
          "UPDATE probe_jobs SET lease_token=$2,lease_until=LEAST(now()+interval '45 seconds',(SELECT deadline FROM probe_rounds WHERE id=round_id)) WHERE id=$1 RETURNING lease_until",
          [row.id, leaseToken],
        )
      ).rows[0];
      const resolved = await secrets.resolve(
        [...(Object.values(row.config.headers) as string[]), row.config.body],
        client,
      );
      await client.query('COMMIT');
      return {
        protocolVersion: 1,
        job: {
          id: row.id,
          leaseToken,
          leaseUntil: lease.lease_until.toISOString(),
          config: row.config as CheckConfig,
          secrets: resolved,
        },
      };
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }
  function safeResult(input: unknown): CheckResult {
    const r = probeReportSchema.parse(input);
    // Remote agents report only bounded numeric fields and assertion booleans, never free text or response data.
    return {
      outcome: r.outcome,
      statusCode: r.statusCode,
      durationMs: r.durationMs,
      checkedAt: new Date().toISOString(),
      failures:
        r.outcome === 'pass'
          ? []
          : [
              r.outcome === 'error'
                ? 'Probe could not execute this check'
                : 'Check failed at this location',
            ],
      assertions: r.assertions?.map((a, i) => ({
        kind: 'status' as const,
        label: `Assertion ${i + 1}`,
        passed: a.passed,
        message: a.passed ? 'Passed' : 'Failed',
      })),
    };
  }
  async function finish(client: PoolClient, row: any, round: any) {
    if (round.finished_at) return;
    if (
      !row.enabled ||
      row.archived_at ||
      row.config_revision !== round.config_revision ||
      row.execution_epoch !== round.execution_epoch
    ) {
      await client.query('UPDATE probe_rounds SET finished_at=now() WHERE id=$1', [round.id]);
      return;
    }
    const jobs = (await client.query('SELECT result FROM probe_jobs WHERE round_id=$1', [round.id]))
      .rows;
    if (jobs.some((j) => !j.result) && new Date(round.deadline).getTime() > Date.now()) return;
    const result = aggregateLocations(
      jobs.map((j) => j.result),
      row.config.locationFailureThreshold ?? 1,
      new Date().toISOString(),
    );
    await record(client, row, result, round.id);
    await client.query('UPDATE probe_rounds SET finished_at=now() WHERE id=$1', [round.id]);
  }
  async function complete(
    locationId: string,
    jobId: string,
    leaseToken: string,
    input: unknown,
    credential?: string,
  ) {
    const result = safeResult(input);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const location = (
        await client.query(
          'SELECT id,token_hash FROM probe_locations WHERE id=$1 AND revoked_at IS NULL FOR SHARE',
          [locationId],
        )
      ).rows[0];
      if (!location || (credential !== undefined && location.token_hash !== hash(credential)))
        throw new CheckError(401, 'Probe credential is invalid or revoked');
      const info = (
        await client.query(
          'SELECT r.monitor_id,r.id FROM probe_rounds r JOIN probe_jobs j ON j.round_id=r.id WHERE j.id=$1 AND j.location_id=$2',
          [jobId, locationId],
        )
      ).rows[0];
      if (!info) throw new CheckError(404, 'Probe job not found');
      const row = (
        await client.query('SELECT * FROM monitors WHERE id=$1 FOR UPDATE', [info.monitor_id])
      ).rows[0];
      const round = (
        await client.query('SELECT * FROM probe_rounds WHERE id=$1 FOR UPDATE', [info.id])
      ).rows[0];
      const job = (await client.query('SELECT * FROM probe_jobs WHERE id=$1 FOR UPDATE', [jobId]))
        .rows[0];
      if (job.lease_token !== leaseToken)
        throw new CheckError(409, 'Probe lease has been replaced');
      if (job.completed_at) {
        await client.query('COMMIT');
        return { ok: true };
      }
      if (
        round.finished_at ||
        Date.now() > new Date(job.lease_until).getTime() ||
        Date.now() > new Date(round.deadline).getTime() ||
        !row.enabled ||
        row.archived_at ||
        row.execution_epoch !== round.execution_epoch ||
        row.config_revision !== round.config_revision
      )
        throw new CheckError(409, 'Probe job is expired or obsolete');
      await client.query('UPDATE probe_jobs SET result=$2,completed_at=now() WHERE id=$1', [
        jobId,
        JSON.stringify(result),
      ]);
      await client.query('UPDATE probe_locations SET last_seen_at=now() WHERE id=$1', [locationId]);
      await finish(client, row, round);
      await client.query('COMMIT');
      return { ok: true };
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }
  async function expire() {
    const due = (
      await pool.query(
        'SELECT id,monitor_id FROM probe_rounds WHERE finished_at IS NULL AND deadline<=now() ORDER BY deadline LIMIT 100',
      )
    ).rows;
    for (const r of due) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const row = (
          await client.query('SELECT * FROM monitors WHERE id=$1 FOR UPDATE', [r.monitor_id])
        ).rows[0];
        const round = (
          await client.query('SELECT * FROM probe_rounds WHERE id=$1 FOR UPDATE', [r.id])
        ).rows[0];
        if (row && round) await finish(client, row, round);
        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      } finally {
        client.release();
      }
    }
  }
  async function local() {
    const { job } = await claim('local');
    if (!job) return;
    const result = await executeCheck(job.config, {
      secrets: job.secrets,
      allowPrivateNetworks: env.ALLOW_PRIVATE_NETWORKS === 'true',
    });
    try {
      await complete('local', job.id, job.leaseToken, result);
    } catch (e) {
      if (!(e instanceof CheckError && e.statusCode === 409)) throw e;
    }
  }
  async function observations(monitorId: string): Promise<RegionalObservation[]> {
    const m = (await pool.query('SELECT * FROM monitors WHERE id=$1', [monitorId])).rows[0];
    if (!m) throw new CheckError(404, 'Check not found');
    const ids = m.config.locationIds ?? ['local'];
    const rows = (
      await pool.query(
        `SELECT p.*,o.result,o.completed_at FROM probe_locations p LEFT JOIN LATERAL (
      SELECT j.result,j.completed_at FROM probe_jobs j JOIN probe_rounds r ON r.id=j.round_id WHERE j.location_id=p.id AND r.monitor_id=$1 AND r.execution_epoch=$3 AND r.config_revision=$4 ORDER BY r.created_at DESC LIMIT 1
    ) o ON true WHERE p.id=ANY($2::text[]) ORDER BY p.created_at`,
        [monitorId, ids, m.execution_epoch, m.config_revision],
      )
    ).rows;
    return rows.map((r) => {
      const legacy = ids.length === 1 && ids[0] === 'local';
      const at = legacy ? m.last_run_at : r.completed_at;
      return {
        locationId: r.id,
        name: r.name,
        region: r.region,
        probeStatus: locationStatus(r),
        outcome: legacy ? m.last_outcome : (r.result?.outcome ?? null),
        statusCode: legacy ? null : (r.result?.statusCode ?? null),
        durationMs: legacy ? m.last_duration_ms : (r.result?.durationMs ?? null),
        checkedAt: at?.toISOString() ?? null,
        fresh:
          !!at &&
          m.enabled &&
          !m.archived_at &&
          Date.now() - at.getTime() < Math.max(m.config.intervalSeconds * 3, 120) * 1000,
      };
    });
  }
  return {
    list,
    create,
    renew,
    revoke,
    enroll,
    authenticate,
    validate,
    schedule,
    claim,
    complete,
    expire,
    local,
    observations,
  };
}
