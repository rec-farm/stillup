import { afterAll, beforeAll, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createServer as httpServer } from 'node:http';
import { connectDatabase } from '@stillup/db';
import type { Service } from './service';
import type { createServer } from './server';
const baseUrl = process.env.DATABASE_URL;
const suite = it.skipIf(!baseUrl);
const databaseName = `stillup_test_${randomUUID().replaceAll('-', '')}`;
let service: Service;
let app: Awaited<ReturnType<typeof createServer>>;
let stopWorker: (() => Promise<void>) | undefined;
let status = 200;
let origin = '';
const notifications: unknown[] = [];
const fixture = httpServer((req, res) => {
  if (req.url === '/webhook') {
    let data = '';
    req.on('data', (chunk) => (data += chunk));
    req.on('end', () => {
      notifications.push(JSON.parse(data));
      res.end('ok');
    });
  } else {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', private: 'do-not-store' }));
  }
});
const token = 'test-admin-token-at-least-thirty-two-characters';
async function eventually(predicate: () => Promise<boolean>, timeout = 15000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error('Timed out waiting for monitoring state');
}
beforeAll(async () => {
  if (!baseUrl) return;
  const admin = connectDatabase(baseUrl);
  try {
    await admin.pool.query(`CREATE DATABASE ${databaseName}`);
  } finally {
    await admin.pool.end();
  }
  const url = new URL(baseUrl);
  url.pathname = '/' + databaseName;
  await new Promise<void>((resolve) => fixture.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(fixture.address() as { port: number }).port}`;
  Object.assign(process.env, {
    DATABASE_URL: url.toString(),
    ADMIN_TOKEN: token,
    ALLOW_PRIVATE_NETWORKS: 'true',
    ALERT_WEBHOOK_URL: origin + '/webhook',
    APP_ORIGIN: 'http://localhost:3000',
  });
  service = await (await import('./service')).createService();
  app = await (await import('./server')).createServer(service);
  stopWorker = await service.startWorker();
}, 30000);
afterAll(async () => {
  if (!baseUrl) return;
  await stopWorker?.();
  await app?.close();
  await service?.close();
  fixture.closeAllConnections();
  await new Promise<void>((resolve) => fixture.close(() => resolve()));
  const admin = connectDatabase(baseUrl);
  try {
    await admin.pool.query(`DROP DATABASE ${databaseName}`);
  } finally {
    await admin.pool.end();
  }
}, 30000);
suite('protects management, validates inputs, and rejects cross-origin writes', async () => {
  expect((await app.inject({ url: '/v1/dashboard' })).statusCode).toBe(401);
  expect((await app.inject({ url: '/v1/public/status' })).statusCode).toBe(200);
  expect(
    (await app.inject({ url: '/v1/session', method: 'POST', payload: { token: 'incorrect' } }))
      .statusCode,
  ).toBe(401);
  const login = await app.inject({ url: '/v1/session', method: 'POST', payload: { token } });
  expect(login.statusCode).toBe(200);
  expect(login.headers['set-cookie']).toContain('HttpOnly');
  const session = (login.headers['set-cookie'] as string).split(';')[0]!;
  expect(
    (await app.inject({ url: '/v1/dashboard', headers: { cookie: session } })).statusCode,
  ).toBe(200);
  expect(
    (
      await app.inject({
        url: '/v1/checks',
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, origin: 'https://attacker.example' },
        payload: { name: 'bad', url: origin },
      })
    ).statusCode,
  ).toBe(403);
  expect(
    (
      await app.inject({
        url: '/v1/checks',
        method: 'POST',
        headers: { authorization: `Bearer ${token}` },
        payload: { name: 'bad', url: 'file:///etc/passwd' },
      })
    ).statusCode,
  ).toBe(400);
});
suite(
  'runs scheduled checks, opens one incident, delivers alerts, recovers, and preserves privacy',
  async () => {
    const headers = { authorization: `Bearer ${token}` };
    const created = await app.inject({
      url: '/v1/checks',
      method: 'POST',
      headers,
      payload: {
        name: 'Public API',
        url: origin,
        public: true,
        intervalSeconds: 86400,
        failureThreshold: 2,
      },
    });
    expect(created.statusCode).toBe(201);
    const id = created.json().id;
    await app.inject({
      url: '/v1/checks',
      method: 'POST',
      headers,
      payload: { name: 'Private API', url: origin + '/private', intervalSeconds: 86400 },
    });
    await eventually(
      async () => (await service.dashboard()).monitors.find((m) => m.id === id)?.health === 'up',
    );
    const perform = async () => {
      const previous = (await service.getRuns(id)).length;
      await eventually(
        async () =>
          !(
            await service.pool.query(
              "SELECT 1 FROM pgboss.job WHERE name='http-check' AND singleton_key=$1 AND state IN ('created','retry','active')",
              [id],
            )
          ).rowCount,
      );
      await service.enqueue(id);
      await eventually(async () => (await service.getRuns(id)).length > previous);
    };
    status = 503;
    await perform();
    expect((await service.dashboard()).incidents).toHaveLength(0);
    await perform();
    expect((await service.dashboard()).monitors.find((m) => m.id === id)?.health).toBe('down');
    await eventually(async () => notifications.length === 1);
    await perform();
    expect((await service.dashboard()).incidents).toHaveLength(1);
    const latest = (await service.getRuns(id))[0]!;
    await service.runJob({ id: latest.id, data: { monitorId: id, scheduledAt: Date.now() } });
    expect((await service.dashboard()).incidents).toHaveLength(1);
    status = 200;
    await perform();
    await eventually(async () => notifications.length === 2);
    expect((await service.dashboard()).incidents[0]?.resolvedAt).not.toBeNull();
    const publicData = (await app.inject({ url: '/v1/public/status' })).json();
    expect(publicData.components).toHaveLength(1);
    expect(JSON.stringify(publicData)).not.toContain(origin);
    expect(JSON.stringify(publicData)).not.toContain('Private API');
    expect(JSON.stringify(await service.getRuns(id))).not.toContain('do-not-store');
    await app.inject({
      url: `/v1/checks/${id}`,
      method: 'PATCH',
      headers,
      payload: { enabled: false },
    });
    expect((await service.dashboard()).monitors.find((m) => m.id === id)?.health).toBe('paused');
    expect(
      (await app.inject({ url: `/v1/checks/${id}/run`, method: 'POST', headers })).statusCode,
    ).toBe(409);
    await service.pool.query(
      "UPDATE monitors SET last_observed_at=now()-interval '4 days',enabled=true WHERE id=$1",
      [id],
    );
    expect((await service.publicStatus()).components[0]?.health).toBe('unknown');
  },
  45000,
);
