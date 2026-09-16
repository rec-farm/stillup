import { connectDatabase, type PoolClient } from '@stillup/db';
import {
  secretCreateSchema,
  secretEditSchema,
  secretNameSchema,
  secretReferences,
  type SecretOverview,
  type SecretUsage,
} from '@stillup/core';
import { encryptSecret, decryptSecret } from '@stillup/core/secret-crypto';
import { env } from './env';
import { CheckError } from './errors';
type Pool = ReturnType<typeof connectDatabase>['pool'];
export function createSecrets(pool: Pool) {
  async function save(input: unknown, name?: string) {
    const value = name ? secretEditSchema.parse(input) : secretCreateSchema.parse(input);
    if (!env.SECRETS_ENCRYPTION_KEY)
      throw new CheckError(
        409,
        'Configure SECRETS_ENCRYPTION_KEY on the API and worker to manage encrypted secrets',
      );
    const key = name ? secretNameSchema.parse(name) : (value as { name: string }).name;
    if (!name && process.env[`CHECK_SECRET_${key}`] !== undefined)
      throw new CheckError(
        409,
        'This name is supplied by the environment; choose a different name',
      );
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT pg_advisory_xact_lock(hashtext('stillup-secrets'))");
      if (name) {
        const row = (
          await client.query('SELECT * FROM managed_secrets WHERE name=$1 FOR UPDATE', [key])
        ).rows[0];
        if (!row) throw new CheckError(404, 'Secret not found');
        if (!('expectedRevision' in value) || row.revision !== value.expectedRevision)
          throw new CheckError(409, 'Secret changed elsewhere. Reopen it before saving.');
        // Verify the configured key before allowing a replacement under a potentially wrong installation key.
        try {
          decryptSecret(key, row.encrypted_value, env.SECRETS_ENCRYPTION_KEY);
        } catch {
          throw new CheckError(409, 'The installation key cannot unlock this secret');
        }
        const encrypted =
          value.value === undefined
            ? null
            : JSON.stringify(encryptSecret(key, value.value, env.SECRETS_ENCRYPTION_KEY));
        await client.query(
          'UPDATE managed_secrets SET encrypted_value=COALESCE($2::jsonb,encrypted_value),enabled=$3,revision=revision+1,updated_at=now() WHERE name=$1',
          [key, encrypted, value.enabled],
        );
      } else {
        if ((await client.query('SELECT 1 FROM managed_secrets WHERE name=$1', [key])).rowCount)
          throw new CheckError(409, 'A secret with this name already exists');
        if (
          Number((await client.query('SELECT count(*) FROM managed_secrets')).rows[0].count) >= 500
        )
          throw new CheckError(409, 'An installation supports up to 500 stored secrets');
        // Catch accidental master-key changes before mixing encrypted values from different keys.
        const existing = (
          await client.query('SELECT name,encrypted_value FROM managed_secrets LIMIT 1')
        ).rows[0];
        if (existing)
          try {
            decryptSecret(existing.name, existing.encrypted_value, env.SECRETS_ENCRYPTION_KEY);
          } catch {
            throw new CheckError(409, 'The installation key cannot unlock existing secrets');
          }
        await client.query(
          'INSERT INTO managed_secrets(name,encrypted_value,enabled) VALUES($1,$2,$3)',
          [
            key,
            JSON.stringify(encryptSecret(key, value.value!, env.SECRETS_ENCRYPTION_KEY)),
            value.enabled,
          ],
        );
      }
      await client.query('COMMIT');
      return { ok: true };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
  async function resolve(
    values: string[],
    client?: PoolClient,
  ): Promise<Record<string, string | undefined>> {
    const names = secretReferences(values);
    if (!names.length) return {};
    const rows = (
      await (client ?? pool).query('SELECT * FROM managed_secrets WHERE name=ANY($1::text[])', [
        names,
      ])
    ).rows;
    const result: Record<string, string | undefined> = {};
    for (const name of names) {
      const row = rows.find((r) => r.name === name);
      // Managed names are authoritative even when disabled; never fall back to an environment value.
      if (row) {
        if (row.enabled)
          try {
            result[`CHECK_SECRET_${name}`] = decryptSecret(
              name,
              row.encrypted_value,
              env.SECRETS_ENCRYPTION_KEY,
            );
          } catch {
            /* Missing resolution produces a safe configuration error. */
          }
      } else result[`CHECK_SECRET_${name}`] = process.env[`CHECK_SECRET_${name}`];
    }
    return result;
  }
  async function overview(): Promise<SecretOverview> {
    const [stored, checks, channels, pending] = await Promise.all([
      pool.query('SELECT name,enabled,revision,updated_at FROM managed_secrets ORDER BY name'),
      pool.query('SELECT id,config,archived_at FROM monitors'),
      pool.query('SELECT id,name,url,source FROM notification_channels'),
      pool.query(
        "SELECT id,channel_name,target_url FROM notification_deliveries WHERE status <> 'delivered'",
      ),
    ]);
    const usages = new Map<string, SecretUsage[]>();
    const add = (values: string[], usage: SecretUsage) => {
      for (const name of secretReferences(values))
        usages.set(name, [...(usages.get(name) ?? []), usage]);
    };
    for (const row of checks.rows)
      add([...(Object.values(row.config.headers) as string[]), row.config.body], {
        kind: 'check',
        id: row.id,
        name: row.config.name,
        archived: !!row.archived_at,
      });
    for (const row of channels.rows)
      add([row.source === 'environment' ? env.ALERT_WEBHOOK_URL : (row.url ?? '')], {
        kind: 'channel',
        id: row.id,
        name: row.name,
      });
    for (const row of pending.rows)
      add([row.target_url], { kind: 'delivery', id: row.id, name: row.channel_name });
    const environment = Object.keys(process.env)
      .filter((k) => /^CHECK_SECRET_[A-Z][A-Z0-9_]*$/.test(k))
      .map((k) => k.slice(13));
    const names = [
      ...new Set([...stored.rows.map((r) => r.name), ...environment, ...usages.keys()]),
    ].sort();
    return {
      encryptionConfigured: !!env.SECRETS_ENCRYPTION_KEY,
      secrets: names.map((name) => {
        const row = stored.rows.find((r) => r.name === name);
        return {
          name,
          source: row ? 'database' : environment.includes(name) ? 'environment' : 'missing',
          enabled: row ? row.enabled : environment.includes(name),
          revision: row?.revision ?? null,
          updatedAt: row?.updated_at.toISOString() ?? null,
          usages: usages.get(name) ?? [],
        };
      }),
    };
  }
  return { save, resolve, overview };
}
