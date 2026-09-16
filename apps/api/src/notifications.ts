import { randomUUID } from 'node:crypto';
import { connectDatabase, type PoolClient } from '@stillup/db';
import type {
  AlertEvent,
  Channel,
  CheckConfig,
  Delivery,
  DeliveryAttempt,
  DeliveryPage,
} from '@stillup/core';
import { channelSchema, channelEditSchema, secretReferences } from '@stillup/core';
import { resolveSecrets } from '@stillup/core/executor';
import type { createSecrets } from './secrets';
import { sendWebhook } from '@stillup/core/webhook';
import { env } from './env';
import { CheckError } from './errors';

type Pool = ReturnType<typeof connectDatabase>['pool'];
type Client = PoolClient;
const environmentId = '00000000-0000-4000-8000-000000000001';
const iso = (value: Date | null) => value?.toISOString() ?? null;
function delivery(row: Record<string, any>): Delivery {
  return {
    id: row.id,
    channelId: row.channel_id,
    channelName: row.channel_name,
    incidentId: row.incident_id,
    event: row.event,
    status: row.status,
    attempts: row.attempts,
    cycleAttempts: row.cycle_attempts,
    nextAttemptAt: iso(row.next_attempt_at),
    lastError: row.last_error,
    createdAt: iso(row.created_at)!,
    deliveredAt: iso(row.delivered_at),
  };
}
export function createNotifications(pool: Pool, secrets: ReturnType<typeof createSecrets>) {
  async function transaction<T>(fn: (client: Client) => Promise<T>): Promise<T> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
  async function initialize() {
    if (env.ALERT_WEBHOOK_URL)
      await pool.query(
        "INSERT INTO notification_channels(id,name,is_default,source) VALUES ($1,'Environment webhook',true,'environment') ON CONFLICT DO NOTHING",
        [environmentId],
      );
  }
  function channel(row: Record<string, any>): Channel {
    const url = row.source === 'environment' ? env.ALERT_WEBHOOK_URL : row.url;
    let destination = 'Not configured';
    const references = secretReferences([url ?? '']);
    try {
      destination = references.length
        ? `Secret reference: ${references.join(', ')}`
        : new URL(url).origin;
    } catch {
      /* Never return an invalid URL or secret path. */
    }
    return {
      id: row.id,
      name: row.name,
      enabled: row.enabled && !!url,
      isDefault: row.is_default,
      source: row.source,
      revision: row.revision,
      destination,
      createdAt: iso(row.created_at)!,
    };
  }
  async function listChannels() {
    return (
      await pool.query('SELECT * FROM notification_channels ORDER BY created_at,id')
    ).rows.map(channel);
  }
  async function saveChannel(input: unknown, id?: string) {
    const config = id ? channelEditSchema.parse(input) : channelSchema.parse(input);
    return transaction(async (client) => {
      // Serialize the installation limit, including concurrent channel creation.
      await client.query("SELECT pg_advisory_xact_lock(hashtext('stillup-notification-channels'))");
      if (id) {
        const row = (
          await client.query('SELECT * FROM notification_channels WHERE id=$1 FOR UPDATE', [id])
        ).rows[0];
        if (!row) throw new CheckError(404, 'Channel not found');
        if (!('expectedRevision' in config) || row.revision !== config.expectedRevision)
          throw new CheckError(409, 'Channel changed elsewhere. Reopen it before saving.');
        if (row.source === 'environment' && config.url)
          throw new CheckError(
            400,
            'Update the environment webhook URL in your installation configuration',
          );
        const result = await client.query(
          'UPDATE notification_channels SET name=$2,url=COALESCE($3,url),enabled=$4,is_default=$5,revision=revision+1 WHERE id=$1 RETURNING *',
          [id, config.name, config.url, config.enabled, config.isDefault],
        );
        return channel(result.rows[0]);
      }
      if (
        Number((await client.query('SELECT count(*) FROM notification_channels')).rows[0].count) >=
        100
      )
        throw new CheckError(409, 'An installation supports up to 100 channels');
      return channel(
        (
          await client.query(
            'INSERT INTO notification_channels(name,url,enabled,is_default) VALUES($1,$2,$3,$4) RETURNING *',
            [config.name, config.url, config.enabled, config.isDefault],
          )
        ).rows[0],
      );
    });
  }
  async function validateRoutes(config: CheckConfig) {
    if (!config.notificationChannelIds?.length) return;
    const found = await pool.query(
      'SELECT id FROM notification_channels WHERE id=ANY($1::uuid[])',
      [config.notificationChannelIds],
    );
    if (found.rowCount !== config.notificationChannelIds.length)
      throw new CheckError(400, 'A selected notification channel does not exist');
  }
  async function queueEvent(
    client: Client,
    event: AlertEvent,
    config: CheckConfig,
    dedupe: string,
    explicitChannel?: string,
    deliveryId?: string,
  ) {
    const channels = await client.query(
      'SELECT * FROM notification_channels WHERE enabled AND ($1::uuid IS NOT NULL AND id=$1 OR $1::uuid IS NULL AND ($2::uuid[] IS NULL AND is_default OR id=ANY($2::uuid[])))',
      [explicitChannel ?? null, config.notificationChannelIds ?? null],
    );
    const ids: string[] = [];
    for (const ch of channels.rows) {
      const url = ch.source === 'environment' ? env.ALERT_WEBHOOK_URL : ch.url;
      if (!url) continue;
      const id = deliveryId ?? randomUUID();
      const result = await client.query(
        'INSERT INTO notification_deliveries(id,channel_id,channel_name,incident_id,event,target_url,dedupe_key) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING RETURNING id',
        [
          id,
          ch.id,
          ch.name,
          event.type === 'notification.test' ? null : event.id,
          JSON.stringify(event),
          url,
          `${dedupe}:${ch.id}`,
        ],
      );
      if (result.rowCount) ids.push(id);
    }
    return ids;
  }
  async function testChannel(id: string) {
    return transaction(async (client) => {
      const row = (
        await client.query('SELECT * FROM notification_channels WHERE id=$1 FOR UPDATE', [id])
      ).rows[0];
      if (!row) throw new CheckError(404, 'Channel not found');
      if (!channel(row).enabled)
        throw new CheckError(409, 'Enable and configure this channel before sending a test');
      const idempotency = randomUUID();
      const ids = await queueEvent(
        client,
        {
          id: idempotency,
          type: 'notification.test',
          name: 'StillUp test notification',
          at: new Date().toISOString(),
        },
        {} as CheckConfig,
        idempotency,
        id,
      );
      return { deliveryId: ids[0] };
    });
  }
  async function legacy(job: { id: string; data: AlertEvent }) {
    return transaction((client) =>
      queueEvent(client, job.data, {} as CheckConfig, `legacy:${job.id}`, environmentId, job.id),
    );
  }
  async function claim(id?: string) {
    return transaction(async (client) => {
      const row = (
        await client.query(
          "SELECT d.* FROM notification_deliveries d WHERE d.status IN ('pending','retrying','delivering') AND d.next_attempt_at<=now() AND ($1::uuid IS NULL OR d.id=$1) AND NOT EXISTS (SELECT 1 FROM notification_deliveries earlier WHERE earlier.incident_id=d.incident_id AND earlier.channel_id=d.channel_id AND earlier.status IN ('pending','retrying','delivering') AND (earlier.created_at,earlier.id)<(d.created_at,d.id)) ORDER BY d.next_attempt_at,d.id LIMIT 1 FOR UPDATE OF d SKIP LOCKED",
          [id ?? null],
        )
      ).rows[0];
      if (!row) return null;
      if (row.claim_id)
        await client.query(
          "UPDATE notification_attempts SET finished_at=now(),error='Worker interrupted before acknowledgement was recorded' WHERE id=$1 AND finished_at IS NULL",
          [row.claim_id],
        );
      const ch = (
        await client.query('SELECT * FROM notification_channels WHERE id=$1', [row.channel_id])
      ).rows[0];
      if (!ch || !channel(ch).enabled || row.cycle_attempts >= 6) {
        await client.query(
          'UPDATE notification_deliveries SET status=$2,last_error=$3,next_attempt_at=NULL,lease_until=NULL,claim_id=NULL WHERE id=$1',
          [
            row.id,
            row.cycle_attempts >= 6 ? 'failed' : 'cancelled',
            row.cycle_attempts >= 6
              ? 'Delivery retry limit reached after worker interruption'
              : 'Channel is disabled or unconfigured',
          ],
        );
        return null;
      }
      // Reminders are only useful while the incident and monitor still qualify.
      if (row.event.type === 'incident.reminder') {
        const current = (
          await client.query(
            'SELECT m.*,i.resolved_at FROM incidents i JOIN monitors m ON m.id=i.monitor_id WHERE i.id=$1',
            [row.incident_id],
          )
        ).rows[0];
        if (
          !reminderEligible(current) ||
          (current.config.notificationChannelIds &&
            !current.config.notificationChannelIds.includes(row.channel_id)) ||
          (!current.config.notificationChannelIds && !ch.is_default)
        ) {
          await client.query(
            "UPDATE notification_deliveries SET status='cancelled',last_error='Outage reminder is no longer applicable',next_attempt_at=NULL,claim_id=NULL,lease_until=NULL WHERE id=$1",
            [row.id],
          );
          return null;
        }
      }
      const claimId = randomUUID();
      const updated = (
        await client.query(
          "UPDATE notification_deliveries SET status='delivering',attempts=attempts+1,cycle_attempts=cycle_attempts+1,claim_id=$2,lease_until=now()+interval '30 seconds',next_attempt_at=now()+interval '30 seconds' WHERE id=$1 RETURNING *",
          [row.id, claimId],
        )
      ).rows[0];
      await client.query(
        'INSERT INTO notification_attempts(id,delivery_id,number) VALUES($1,$2,$3)',
        [claimId, row.id, updated.attempts],
      );
      return updated;
    });
  }
  async function deliverOne(id?: string) {
    const row = await claim(id);
    if (!row) return false;
    let result: { statusCode: number | null; error: string | null };
    try {
      const values = await secrets.resolve([row.target_url]);
      const destination = resolveSecrets(row.target_url, values);
      result = await sendWebhook(
        destination,
        row.event,
        row.id,
        env.ALLOW_PRIVATE_NETWORKS === 'true',
      );
    } catch {
      result = { statusCode: null, error: 'A referenced webhook secret is unavailable' };
    }
    await transaction(async (client) => {
      const current = (
        await client.query('SELECT claim_id FROM notification_deliveries WHERE id=$1 FOR UPDATE', [
          row.id,
        ])
      ).rows[0];
      if (current?.claim_id !== row.claim_id) return;
      await client.query(
        'UPDATE notification_attempts SET finished_at=now(),status_code=$2,error=$3 WHERE id=$1',
        [row.claim_id, result.statusCode, result.error],
      );
      const state = result.error ? (row.cycle_attempts >= 6 ? 'failed' : 'retrying') : 'delivered';
      await client.query(
        "UPDATE notification_deliveries SET status=$2,last_error=$3,next_attempt_at=CASE WHEN $2='retrying' THEN now()+($4 * interval '1 second') ELSE NULL END,delivered_at=CASE WHEN $2='delivered' THEN now() ELSE NULL END,claim_id=NULL,lease_until=NULL WHERE id=$1",
        [row.id, state, result.error, Math.min(30 * 2 ** (row.cycle_attempts - 1), 1800)],
      );
    });
    return true;
  }
  async function retry(id: string) {
    return transaction(async (client) => {
      const row = (
        await client.query('SELECT * FROM notification_deliveries WHERE id=$1 FOR UPDATE', [id])
      ).rows[0];
      if (!row) throw new CheckError(404, 'Delivery not found');
      if (!['failed', 'cancelled'].includes(row.status))
        throw new CheckError(409, 'Only failed or cancelled deliveries can be retried');
      const ch = (
        await client.query('SELECT * FROM notification_channels WHERE id=$1', [row.channel_id])
      ).rows[0];
      if (!channel(ch).enabled)
        throw new CheckError(409, 'Enable and configure the channel before retrying');
      await client.query(
        "UPDATE notification_deliveries SET status='pending',cycle_attempts=0,next_attempt_at=now(),last_error=NULL WHERE id=$1",
        [id],
      );
      return { queued: true };
    });
  }
  async function history(incidentId?: string, before?: string): Promise<DeliveryPage> {
    const result = await pool.query(
      'SELECT * FROM notification_deliveries WHERE ($1::uuid IS NULL OR incident_id=$1) AND ($2::uuid IS NULL OR (created_at,id)<(SELECT created_at,id FROM notification_deliveries WHERE id=$2)) ORDER BY created_at DESC,id DESC LIMIT 26',
      [incidentId ?? null, before ?? null],
    );
    return {
      deliveries: result.rows.slice(0, 25).map(delivery),
      nextBefore: result.rows.length > 25 ? result.rows[24].id : null,
    };
  }
  async function attempts(id: string) {
    const row = (await pool.query('SELECT * FROM notification_deliveries WHERE id=$1', [id]))
      .rows[0];
    if (!row) throw new CheckError(404, 'Delivery not found');
    const result = await pool.query(
      'SELECT * FROM notification_attempts WHERE delivery_id=$1 ORDER BY number DESC LIMIT 100',
      [id],
    );
    return {
      delivery: delivery(row),
      attempts: result.rows.map((a): DeliveryAttempt => ({
        id: a.id,
        number: a.number,
        startedAt: iso(a.started_at)!,
        finishedAt: iso(a.finished_at),
        statusCode: a.status_code,
        error: a.error,
      })),
    };
  }
  function reminderEligible(row: Record<string, any> | undefined) {
    return (
      !!row &&
      !row.resolved_at &&
      row.enabled &&
      !row.archived_at &&
      row.status === 'down' &&
      row.last_outcome === 'fail' &&
      !!row.config.reminderIntervalSeconds &&
      row.last_observed_at &&
      Date.now() - new Date(row.last_observed_at).getTime() <=
        Math.max(row.config.intervalSeconds * 3, 120) * 1000
    );
  }
  async function reminders() {
    await transaction(async (client) => {
      const due = await client.query(
        "SELECT i.id AS incident_id,i.name AS incident_name,i.opened_at,i.resolved_at,i.last_reminder_at,m.* FROM incidents i JOIN monitors m ON m.id=i.monitor_id WHERE i.resolved_at IS NULL AND m.enabled AND m.archived_at IS NULL AND (m.config->>'reminderIntervalSeconds')::int IS NOT NULL AND COALESCE(i.last_reminder_at,i.opened_at) + ((m.config->>'reminderIntervalSeconds')::int * interval '1 second') <= now() ORDER BY i.opened_at LIMIT 100 FOR UPDATE OF i SKIP LOCKED",
      );
      for (const row of due.rows) {
        if (!reminderEligible(row)) continue;
        const at = new Date().toISOString();
        await queueEvent(
          client,
          {
            id: row.incident_id,
            type: 'incident.reminder',
            name: row.incident_name,
            at,
            monitorId: row.id,
          },
          row.config,
          `reminder:${row.incident_id}:${at}`,
        );
        await client.query('UPDATE incidents SET last_reminder_at=$2 WHERE id=$1', [
          row.incident_id,
          at,
        ]);
      }
    });
  }
  return {
    initialize,
    listChannels,
    saveChannel,
    validateRoutes,
    queueEvent,
    testChannel,
    legacy,
    deliverOne,
    retry,
    history,
    attempts,
    reminders,
  };
}
