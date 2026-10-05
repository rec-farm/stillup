// Test-only: seed the installed pg-boss schema so the Rust handoff is checked
// against real queue partitions and enums, rather than a mock table.
import { PgBoss } from '../apps/api/node_modules/pg-boss/dist/index.js';
import { randomUUID } from 'node:crypto';
const [schema, monitorId] = process.argv.slice(2);
if (!/^rust_test_[a-f0-9]+$/.test(schema ?? '') || !monitorId || !process.env.TEST_DATABASE_URL)
  throw new Error('An isolated Rust test schema and database are required');
const boss = new PgBoss({ connectionString: process.env.TEST_DATABASE_URL, schema });
boss.on('error', () => {});
try {
  await boss.start();
  await boss.createQueue('http-check', {
    policy: 'exclusive',
    retryLimit: 2,
    retryDelay: 10,
    expireInSeconds: 90,
  });
  await boss.createQueue('notify', { retryLimit: 5, retryDelay: 30, expireInSeconds: 30 });
  const check = await boss.send(
    'http-check',
    { monitorId, scheduledAt: Date.now(), configRevision: 1, executionEpoch: 1 },
    { singletonKey: `${monitorId}:1` },
  );
  const notify = await boss.send('notify', {
    id: randomUUID(),
    type: 'notification.test',
    name: 'Legacy test notification',
    at: new Date().toISOString(),
  });
  process.stdout.write(JSON.stringify({ check, notify }));
} finally {
  await boss.stop({ graceful: false });
}
