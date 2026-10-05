import { readdir, readFile } from 'node:fs/promises';
import { connectDatabase } from '@stillup/legacy-db';
export async function migrate(url: string) {
  const { pool } = connectDatabase(url);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(782314)');
    await client.query(
      'CREATE TABLE IF NOT EXISTS stillup_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())',
    );
    const directory = new URL('../../../packages/db/migrations/', import.meta.url);
    for (const name of (await readdir(directory)).filter((n) => n.endsWith('.sql')).sort()) {
      if ((await client.query('SELECT 1 FROM stillup_migrations WHERE name=$1', [name])).rowCount)
        continue;
      await client.query(await readFile(new URL(name, directory), 'utf8'));
      await client.query('INSERT INTO stillup_migrations(name) VALUES ($1)', [name]);
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}
