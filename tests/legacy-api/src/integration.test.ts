import { afterAll, beforeAll, expect, it } from 'vitest';
import { randomUUID, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { checkSchema } from '@stillup/core';
import { createServer as httpServer } from 'node:http';
import { connectDatabase } from '@stillup/legacy-db';
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
const legacyId = randomUUID();
let hold: { entered: () => void; release: Promise<void> } | null = null;
let targetRequests = 0;
const notifications: unknown[] = [];
let hookStatus = 503;
const hookCalls: { key: string | undefined; body: Record<string, unknown>; path: string }[] = [];
let receivedCredential = '';
let receivedBody = '';
const fixture = httpServer((req, res) => {
  if (req.url === '/secret-check') {
    receivedCredential = String(req.headers.authorization ?? '');
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      receivedBody = body;
      res.end('{}');
    });
    return;
  }
  if (req.url?.startsWith('/delivery-hook')) {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      hookCalls.push({
        path: req.url!,
        key: req.headers['idempotency-key'] as string | undefined,
        body: JSON.parse(body),
      });
      res.writeHead(hookStatus);
      res.end('private-response-token');
    });
  } else if (req.url === '/webhook') {
    let data = '';
    req.on('data', (chunk) => (data += chunk));
    req.on('end', () => {
      notifications.push(JSON.parse(data));
      res.end('ok');
    });
  } else if (req.url === '/held' && hold) {
    targetRequests++;
    hold.entered();
    void hold.release.then(() => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"status":"ok"}');
    });
  } else {
    targetRequests++;
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
    SECRETS_ENCRYPTION_KEY: randomBytes(32).toString('hex'),
    ALLOW_PRIVATE_NETWORKS: 'true',
    ALERT_WEBHOOK_URL: origin + '/webhook',
    APP_ORIGIN: 'http://localhost:3000',
  });
  const previous = connectDatabase(url.toString());
  try {
    await previous.pool.query(
      await readFile(
        new URL('../../../packages/db/migrations/001_initial.sql', import.meta.url),
        'utf8',
      ),
    );
    await previous.pool.query(
      'CREATE TABLE stillup_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())',
    );
    await previous.pool.query("INSERT INTO stillup_migrations (name) VALUES ('001_initial.sql')");
    const config = checkSchema.parse({ name: 'Legacy check', url: origin, intervalSeconds: 86400 });
    await previous.pool.query('INSERT INTO monitors(id,config,enabled) VALUES ($1,$2,false)', [
      legacyId,
      JSON.stringify(config),
    ]);
    await previous.pool.query(
      "INSERT INTO runs(id,monitor_id,outcome,status_code,duration_ms,failures,checked_at) VALUES ($1,$2,'pass',200,1,'[]',now())",
      [randomUUID(), legacyId],
    );
  } finally {
    await previous.pool.end();
  }
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
  const sessionCookie = [login.headers['set-cookie'] ?? []]
    .flat()
    .find((value) => value.startsWith('stillup_session='));
  expect(sessionCookie).toContain('HttpOnly');
  const session = sessionCookie!.split(';')[0]!;
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
              "SELECT 1 FROM pgboss.job WHERE name='http-check' AND data->>'monitorId'=$1 AND state IN ('created','retry','active')",
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

suite('backfills existing checks and results with their original configuration', async () => {
  const history = await service.getRevisions(legacyId);
  expect(history.revisions).toHaveLength(1);
  expect(history.revisions[0]?.revision).toBe(1);
  expect(history.revisions[0]?.config.name).toBe('Legacy check');
  expect((await service.getRuns(legacyId))[0]?.configRevision).toBe(1);
  await (await import('./migrate')).migrate(process.env.DATABASE_URL!);
  expect((await service.getRevisions(legacyId)).revisions).toHaveLength(1);
});

suite(
  'versions edits, rejects stale writers and prevents queued old configurations from executing',
  async () => {
    // Use the real worker entry point with explicit jobs so race ordering is deterministic.
    await stopWorker?.();
    await service.boss.offWork('http-check');
    await service.boss.offWork('notify');
    const initial = checkSchema.parse({
      name: 'Versioned API',
      url: origin,
      intervalSeconds: 150,
      public: true,
    });
    const monitor = await service.createCheck(initial);
    const job = {
      id: randomUUID(),
      data: {
        monitorId: monitor.id,
        scheduledAt: Date.now(),
        configRevision: 1,
        executionEpoch: 1,
      },
    };
    await service.runJob(job);
    const changed = {
      ...initial,
      name: 'Updated API',
      url: origin + '/new',
      intervalSeconds: 300,
      expectedStatus: 201,
      headers: { Authorization: 'Bearer {{TOKEN}}' },
    };
    const headers = { authorization: `Bearer ${token}` };
    const response = await app.inject({
      url: `/v1/checks/${monitor.id}`,
      method: 'PUT',
      headers,
      payload: { config: changed, expectedRevision: 1 },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().configRevision).toBe(2);
    expect(response.json().health).toBe('unknown');
    expect(response.json().lastRunAt).toBeNull();
    const stale = await app.inject({
      url: `/v1/checks/${monitor.id}`,
      method: 'PUT',
      headers,
      payload: { config: initial, expectedRevision: 1 },
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error).toContain('edited elsewhere');
    const malformed = await app.inject({
      url: `/v1/checks/${monitor.id}`,
      method: 'PUT',
      headers,
      payload: { config: { ...changed, intervalSeconds: 1 }, expectedRevision: 2 },
    });
    expect(malformed.statusCode).toBe(400);
    expect(
      (
        await app.inject({
          url: `/v1/checks/${monitor.id}`,
          method: 'PUT',
          payload: { config: changed, expectedRevision: 2 },
        })
      ).statusCode,
    ).toBe(401);
    expect((await service.getRevision(monitor.id, 1)).config).toEqual(initial);
    expect((await service.getRevision(monitor.id, 2)).config).toEqual(changed);
    expect((await service.getRuns(monitor.id))[0]?.configRevision).toBe(1);
    const same = await service.changeCheck(monitor.id, { kind: 'edit', config: changed }, 2);
    expect(same.configRevision).toBe(2);
    const requestsBefore = targetRequests;
    await service.runJob({ ...job, id: randomUUID() });
    await service.runJob({
      id: randomUUID(),
      data: { monitorId: monitor.id, scheduledAt: Date.now() },
    }); // Legacy queued job.
    expect(targetRequests).toBe(requestsBefore);
    expect(await service.getRuns(monitor.id)).toHaveLength(1);
    await service.runJob({
      id: randomUUID(),
      data: {
        monitorId: monitor.id,
        scheduledAt: Date.now(),
        configRevision: 2,
        executionEpoch: 2,
      },
    });
    expect((await service.getRuns(monitor.id))[0]?.configRevision).toBe(2);
    // The missing secret is a configuration error, not a service recovery/failure.
    expect((await service.getRuns(monitor.id))[0]?.outcome).toBe('error');
    expect(JSON.stringify(await service.publicStatus())).not.toContain('TOKEN');
  },
);

suite(
  'serializes a running check with edits and archives without rewriting the run',
  async () => {
    const config = checkSchema.parse({
      name: 'In-flight API',
      url: origin + '/held',
      timeoutMs: 10000,
    });
    const monitor = await service.createCheck(config);
    let release!: () => void;
    let entered!: () => void;
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    hold = {
      entered,
      release: new Promise<void>((resolve) => {
        release = resolve;
      }),
    };
    const running = service.runJob({
      id: randomUUID(),
      data: {
        monitorId: monitor.id,
        scheduledAt: Date.now(),
        configRevision: 1,
        executionEpoch: 1,
      },
    });
    await ready;
    let editFinished = false;
    const editing = service
      .changeCheck(monitor.id, { kind: 'edit', config: { ...config, name: 'After edit' } }, 1)
      .then((value) => {
        editFinished = true;
        return value;
      });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(editFinished).toBe(false);
    release();
    await running;
    const edited = await editing;
    expect(edited.configRevision).toBe(2);
    expect((await service.getRuns(monitor.id))[0]?.configRevision).toBe(1);
    expect((await service.getRevision(monitor.id, 1)).config.name).toBe('In-flight API');
    expect(edited.health).toBe('unknown');
    let releaseSecond!: () => void;
    let enteredSecond!: () => void;
    const readySecond = new Promise<void>((resolve) => {
      enteredSecond = resolve;
    });
    hold = {
      entered: enteredSecond,
      release: new Promise<void>((resolve) => {
        releaseSecond = resolve;
      }),
    };
    const runningSecond = service.runJob({
      id: randomUUID(),
      data: {
        monitorId: monitor.id,
        scheduledAt: Date.now(),
        configRevision: 2,
        executionEpoch: 2,
      },
    });
    await readySecond;
    let archiveFinished = false;
    const archiving = service.changeCheck(monitor.id, { kind: 'archive' }, 2).then((value) => {
      archiveFinished = true;
      return value;
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(archiveFinished).toBe(false);
    releaseSecond();
    await runningSecond;
    const archived = await archiving;
    expect(archived.health).toBe('archived');
    expect((await service.getRuns(monitor.id)).map((run) => run.configRevision).sort()).toEqual([
      1, 2,
    ]);
    hold = null;
  },
  15000,
);

suite(
  'archives and restores without dropping history, inventing recovery, or reviving queued jobs',
  async () => {
    status = 503;
    const config = checkSchema.parse({
      name: 'Archived API',
      url: origin,
      public: true,
      failureThreshold: 1,
    });
    const monitor = await service.createCheck(config);
    const pending = {
      id: randomUUID(),
      data: {
        monitorId: monitor.id,
        scheduledAt: Date.now(),
        configRevision: 1,
        executionEpoch: 1,
      },
    };
    await service.runJob({ ...pending, id: randomUUID() });
    const beforeIncident = (await service.dashboard()).incidents.find(
      (i) => i.monitorId === monitor.id,
    )!;
    expect(beforeIncident.resolvedAt).toBeNull();
    const headers = { authorization: `Bearer ${token}` };
    const archive = await app.inject({
      url: `/v1/checks/${monitor.id}/archive`,
      method: 'POST',
      headers,
      payload: { expectedRevision: 1 },
    });
    expect(archive.statusCode).toBe(200);
    expect(archive.json().enabled).toBe(false);
    expect(archive.json().archivedAt).not.toBeNull();
    expect((await service.publicStatus()).components.some((c) => c.id === monitor.id)).toBe(false);
    expect((await service.publicStatus()).incidents.some((i) => i.monitorId === monitor.id)).toBe(
      false,
    );
    expect(
      (await app.inject({ url: `/v1/checks/${monitor.id}/run`, method: 'POST', headers }))
        .statusCode,
    ).toBe(409);
    expect(
      (
        await app.inject({
          url: `/v1/checks/${monitor.id}`,
          method: 'PATCH',
          headers,
          payload: { enabled: true },
        })
      ).statusCode,
    ).toBe(409);
    expect(
      (
        await app.inject({
          url: `/v1/checks/${monitor.id}`,
          method: 'PUT',
          headers,
          payload: { config, expectedRevision: 1 },
        })
      ).statusCode,
    ).toBe(409);
    expect(
      (await app.inject({ url: `/v1/checks/${monitor.id}/revisions`, headers })).statusCode,
    ).toBe(200);
    expect((await app.inject({ url: `/v1/checks/${monitor.id}/revisions/1` })).statusCode).toBe(
      401,
    );
    expect(
      (await app.inject({ url: `/v1/checks/${monitor.id}/revisions/999`, headers })).statusCode,
    ).toBe(404);
    const historyBefore = await service.getRevisions(monitor.id);
    const requestsBefore = targetRequests;
    await service.runJob(pending);
    expect(targetRequests).toBe(requestsBefore);
    const restored = await service.changeCheck(monitor.id, { kind: 'restore' }, 1);
    expect(restored.enabled).toBe(false);
    expect(restored.health).toBe('paused');
    expect((await service.publicStatus()).components.find((c) => c.id === monitor.id)?.health).toBe(
      'paused',
    );
    await service.changeCheck(monitor.id, { kind: 'enabled', enabled: true }, 1);
    await service.runJob(pending);
    expect(targetRequests).toBe(requestsBefore); // Still invalid after archive → restore → resume.
    expect(await service.getRevisions(monitor.id)).toEqual(historyBefore);
    expect(
      (await service.dashboard()).incidents.find((i) => i.id === beforeIncident.id)?.resolvedAt,
    ).toBeNull();
    status = 200;
    await service.runJob({
      id: randomUUID(),
      data: {
        monitorId: monitor.id,
        scheduledAt: Date.now(),
        configRevision: 1,
        executionEpoch: 4,
      },
    });
    expect(
      (await service.dashboard()).incidents.find((i) => i.id === beforeIncident.id)?.resolvedAt,
    ).not.toBeNull();
  },
);

suite(
  'resets failure thresholds on edit but keeps an existing incident until observed recovery',
  async () => {
    const config = checkSchema.parse({ name: 'Threshold API', url: origin, failureThreshold: 2 });
    const monitor = await service.createCheck(config);
    status = 503;
    const run = (revision: number) =>
      service.runJob({
        id: randomUUID(),
        data: {
          monitorId: monitor.id,
          scheduledAt: Date.now(),
          configRevision: revision,
          executionEpoch: revision,
        },
      });
    await run(1);
    const revised = { ...config, name: 'Threshold API v2' };
    await service.changeCheck(monitor.id, { kind: 'edit', config: revised }, 1);
    await run(2);
    expect(
      (await service.dashboard()).incidents.filter((i) => i.monitorId === monitor.id),
    ).toHaveLength(0);
    await run(2);
    const incident = (await service.dashboard()).incidents.find((i) => i.monitorId === monitor.id)!;
    await service.changeCheck(
      monitor.id,
      { kind: 'edit', config: { ...revised, expectedStatus: 503, recoveryThreshold: 2 } },
      2,
    );
    expect(
      (await service.dashboard()).incidents.find((i) => i.id === incident.id)?.resolvedAt,
    ).toBeNull();
    await run(3);
    expect(
      (await service.dashboard()).incidents.find((i) => i.id === incident.id)?.resolvedAt,
    ).toBeNull();
    await run(3);
    expect(
      (await service.dashboard()).incidents.find((i) => i.id === incident.id)?.resolvedAt,
    ).not.toBeNull();
    status = 200;
  },
);

suite(
  'paginates configuration history and allows only one concurrent edit of a revision',
  async () => {
    const config = checkSchema.parse({ name: 'History API', url: origin });
    const monitor = await service.createCheck(config);
    const responses = await Promise.allSettled([
      service.changeCheck(
        monitor.id,
        { kind: 'edit', config: { ...config, name: 'First writer' } },
        1,
      ),
      service.changeCheck(
        monitor.id,
        { kind: 'edit', config: { ...config, name: 'Second writer' } },
        1,
      ),
    ]);
    expect(responses.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(responses.filter((r) => r.status === 'rejected')).toHaveLength(1);
    for (let revision = 2; revision < 23; revision++)
      await service.changeCheck(
        monitor.id,
        { kind: 'edit', config: { ...config, name: `History ${revision + 1}` } },
        revision,
      );
    const first = await service.getRevisions(monitor.id);
    expect(first.revisions).toHaveLength(20);
    expect(first.revisions[0]?.revision).toBe(23);
    expect(first.nextBefore).toBe(4);
    const next = await service.getRevisions(monitor.id, first.nextBefore!);
    expect(next.revisions.map((r) => r.revision)).toEqual([3, 2, 1]);
    expect(next.nextBefore).toBeNull();
    expect((await service.getRevision(monitor.id, 1)).config).toEqual(config);
  },
);

suite(
  'persists individual contract results against the executed revision without response data',
  async () => {
    status = 200;
    const config = checkSchema.parse({
      name: 'Contract',
      url: origin,
      intervalSeconds: 86400,
      headerAssertions: [{ name: 'Content-Type', operator: 'contains', value: 'json' }],
      jsonAssertions: [{ path: '$.status', operator: 'startsWith', value: 'o' }],
      responseSchema: { type: 'object', required: ['missing'] },
    });
    const monitor = await service.createCheck(config);
    await service.runJob({
      id: randomUUID(),
      data: {
        monitorId: monitor.id,
        scheduledAt: Date.now(),
        configRevision: 1,
        executionEpoch: 1,
      },
    });
    const response = await app.inject({
      method: 'GET',
      url: `/v1/checks/${monitor.id}/runs`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(200);
    const runs = response.json();
    expect(runs[0].configRevision).toBe(1);
    expect(runs[0].assertions.map((r: { passed: boolean }) => r.passed)).toEqual([
      true,
      true,
      true,
      false,
    ]);
    expect(runs[0].outcome).toBe('fail');
    expect(response.body).not.toContain('do-not-store');
    expect((await service.getRuns(legacyId))[0]!.assertions).toEqual([]);
  },
);

suite(
  'manages private channel destinations, validates routing, and enforces authorization and revisions',
  async () => {
    const path = '/v1/notification-channels';
    expect((await app.inject({ url: path })).statusCode).toBe(401);
    const headers = { authorization: `Bearer ${token}` };
    const created = await app.inject({
      url: path,
      method: 'POST',
      headers,
      payload: {
        name: 'Operations',
        url: origin + '/delivery-hook/private-url-token',
        isDefault: false,
      },
    });
    expect(created.statusCode).toBe(201);
    const ch = created.json();
    expect(created.body).not.toContain('private-url-token');
    expect(ch.destination).toBe(origin);
    const edited = await app.inject({
      url: `${path}/${ch.id}`,
      method: 'PUT',
      headers,
      payload: { name: 'Operations renamed', enabled: true, isDefault: false, expectedRevision: 1 },
    });
    expect(edited.statusCode).toBe(200);
    expect(
      (
        await app.inject({
          url: `${path}/${ch.id}`,
          method: 'PUT',
          headers,
          payload: { name: 'Stale', enabled: true, isDefault: true, expectedRevision: 1 },
        })
      ).statusCode,
    ).toBe(409);
    expect(
      (
        await app.inject({
          url: '/v1/checks',
          method: 'POST',
          headers,
          payload: { name: 'Bad routing', url: origin, notificationChannelIds: [randomUUID()] },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          url: path,
          method: 'POST',
          headers,
          payload: { name: 'Bad URL', url: 'http://user:password@example.com' },
        })
      ).statusCode,
    ).toBe(400);
    const tested = await app.inject({ url: `${path}/${ch.id}/test`, method: 'POST', headers });
    expect(tested.statusCode).toBe(202);
    const detail = await service.notifications.attempts(tested.json().deliveryId);
    expect(detail.delivery.event.type).toBe('notification.test');
    expect(detail.delivery.incidentId).toBeNull();
    expect(JSON.stringify(detail)).not.toContain('private-url-token');
  },
);

suite(
  'retries durably with stable idempotency, records six failures, and supports manual retry',
  async () => {
    const channel = await service.notifications.saveChannel({
      name: 'Retry channel',
      url: origin + '/delivery-hook/private-destination',
    });
    const { deliveryId } = await service.notifications.testChannel(channel.id);
    hookStatus = 503;
    const start = hookCalls.length;
    for (let i = 1; i <= 6; i++) {
      await service.pool.query(
        'UPDATE notification_deliveries SET next_attempt_at=now() WHERE id=$1',
        [deliveryId],
      );
      expect(await service.notifications.deliverOne(deliveryId)).toBe(true);
      const result = await service.notifications.attempts(deliveryId!);
      expect(result.delivery.attempts).toBe(i);
      expect(result.delivery.status).toBe(i === 6 ? 'failed' : 'retrying');
      expect(result.attempts[0]?.statusCode).toBe(503);
      if (i < 6)
        expect(Date.parse(result.delivery.nextAttemptAt!) - Date.now()).toBeGreaterThan(29000);
      expect(JSON.stringify(result)).not.toMatch(/private-destination|private-response-token/);
    }
    expect(hookCalls.slice(start).map((c) => c.key)).toEqual(Array(6).fill(deliveryId));
    expect(
      hookCalls
        .slice(start)
        .every((c) => c.body.eventId === deliveryId && c.body.type === 'notification.test'),
    ).toBe(true);
    expect(await service.notifications.deliverOne(deliveryId)).toBe(false);
    const retries = await Promise.allSettled([
      service.notifications.retry(deliveryId!),
      service.notifications.retry(deliveryId!),
    ]);
    expect(retries.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    hookStatus = 204;
    const deliveries = await Promise.all([
      service.notifications.deliverOne(deliveryId),
      service.notifications.deliverOne(deliveryId),
    ]);
    expect(deliveries.filter(Boolean)).toHaveLength(1);
    const final = await service.notifications.attempts(deliveryId!);
    expect(final.delivery.status).toBe('delivered');
    expect(final.delivery.attempts).toBe(7);
    expect(final.delivery.cycleAttempts).toBe(1);
    expect(final.attempts).toHaveLength(7);
    await expect(service.notifications.retry(deliveryId!)).rejects.toMatchObject({
      statusCode: 409,
    });
  },
);

suite(
  'recovers expired delivery leases and cancels disabled channels without making a request',
  async () => {
    hookStatus = 204;
    const ch = await service.notifications.saveChannel({
      name: 'Lease recovery',
      url: origin + '/delivery-hook',
    });
    const { deliveryId } = await service.notifications.testChannel(ch.id);
    const claim = randomUUID();
    await service.pool.query(
      "UPDATE notification_deliveries SET status='delivering',attempts=1,cycle_attempts=1,claim_id=$2,lease_until=now()-interval '1 second',next_attempt_at=now()-interval '1 second' WHERE id=$1",
      [deliveryId, claim],
    );
    await service.pool.query(
      'INSERT INTO notification_attempts(id,delivery_id,number) VALUES($1,$2,1)',
      [claim, deliveryId],
    );
    await service.notifications.deliverOne(deliveryId);
    const recovered = await service.notifications.attempts(deliveryId!);
    expect(recovered.delivery.status).toBe('delivered');
    expect(recovered.attempts[1]?.error).toContain('interrupted');
    const next = await service.notifications.testChannel(ch.id);
    await service.notifications.saveChannel(
      { name: ch.name, enabled: false, isDefault: false, expectedRevision: ch.revision },
      ch.id,
    );
    const before = hookCalls.length;
    await service.notifications.deliverOne(next.deliveryId);
    expect(hookCalls).toHaveLength(before);
    expect((await service.notifications.attempts(next.deliveryId!)).delivery.status).toBe(
      'cancelled',
    );
  },
);

suite(
  'routes transitions once, orders recovery after opening, and retains incident snapshots after run retention',
  async () => {
    hookStatus = 503;
    status = 503;
    const ch = await service.notifications.saveChannel({
      name: 'Incident route',
      url: origin + '/delivery-hook',
    });
    const config = checkSchema.parse({
      name: 'Routed incident',
      url: origin,
      failureThreshold: 1,
      notificationChannelIds: [ch.id],
    });
    const monitor = await service.createCheck(config);
    const perform = () =>
      service.runJob({
        id: randomUUID(),
        data: {
          monitorId: monitor.id,
          scheduledAt: Date.now(),
          configRevision: 1,
          executionEpoch: 1,
        },
      });
    await perform();
    await perform();
    const incident = (await service.dashboard()).incidents.find((i) => i.monitorId === monitor.id)!;
    const opening = (await service.notifications.history(incident.id)).deliveries;
    expect(opening).toHaveLength(1);
    expect(opening[0]?.channelId).toBe(ch.id);
    await service.notifications.deliverOne(opening[0]!.id);
    status = 200;
    await perform();
    const history = (await service.notifications.history(incident.id)).deliveries;
    const recovery = history.find((d) => d.event.type === 'incident.resolved')!;
    expect(await service.notifications.deliverOne(recovery.id)).toBe(false);
    hookStatus = 204;
    await service.pool.query(
      'UPDATE notification_deliveries SET next_attempt_at=now() WHERE id=$1',
      [opening[0]!.id],
    );
    await service.notifications.deliverOne(opening[0]!.id);
    await service.notifications.deliverOne(recovery.id);
    expect((await service.notifications.attempts(recovery.id)).delivery.status).toBe('delivered');
    const timeline = await service.incidentTimeline(incident.id);
    expect(timeline.events.map((e) => e.type)).toEqual(['incident.opened', 'incident.resolved']);
    expect(timeline.observations).toHaveLength(3);
    expect(timeline.events[0]?.result.outcome).toBe('fail');
    expect(timeline.events[1]?.result.outcome).toBe('pass');
    await service.pool.query('DELETE FROM runs WHERE monitor_id=$1', [monitor.id]);
    expect((await service.incidentTimeline(incident.id)).events).toHaveLength(2);
    expect((await service.incidentTimeline(incident.id)).observations).toHaveLength(0);
    status = 503;
    const muted = await service.createCheck(
      checkSchema.parse({
        name: 'Muted',
        url: origin,
        failureThreshold: 1,
        notificationChannelIds: [],
      }),
    );
    await service.runJob({
      id: randomUUID(),
      data: { monitorId: muted.id, scheduledAt: Date.now() },
    });
    const mutedIncident = (await service.dashboard()).incidents.find(
      (i) => i.monitorId === muted.id,
    )!;
    expect((await service.notifications.history(mutedIncident.id)).deliveries).toHaveLength(0);
  },
);

suite(
  'queues opt-in reminders once and suppresses paused, stale, recovering, and resolved incidents',
  async () => {
    status = 503;
    hookStatus = 204;
    const ch = await service.notifications.saveChannel({
      name: 'Reminders',
      url: origin + '/delivery-hook',
    });
    const monitor = await service.createCheck(
      checkSchema.parse({
        name: 'Reminder check',
        url: origin,
        failureThreshold: 1,
        reminderIntervalSeconds: 300,
        notificationChannelIds: [ch.id],
      }),
    );
    await service.runJob({
      id: randomUUID(),
      data: { monitorId: monitor.id, scheduledAt: Date.now() },
    });
    const incident = (await service.dashboard()).incidents.find((i) => i.monitorId === monitor.id)!;
    const opening = (await service.notifications.history(incident.id)).deliveries[0]!;
    await service.notifications.deliverOne(opening.id);
    const due = () =>
      service.pool.query(
        "UPDATE incidents SET last_reminder_at=now()-interval '301 seconds' WHERE id=$1",
        [incident.id],
      );
    await due();
    await Promise.all([service.notifications.reminders(), service.notifications.reminders()]);
    let reminders = (await service.notifications.history(incident.id)).deliveries.filter(
      (d) => d.event.type === 'incident.reminder',
    );
    expect(reminders).toHaveLength(1);
    await service.notifications.deliverOne(reminders[0]!.id);
    for (const change of [
      'enabled=false',
      "enabled=true,last_observed_at=now()-interval '1 day'",
      "last_observed_at=now(),last_outcome='pass'",
    ]) {
      await service.pool.query(`UPDATE monitors SET ${change} WHERE id=$1`, [monitor.id]);
      await due();
      await service.notifications.reminders();
      expect((await service.notifications.history(incident.id)).deliveries).toHaveLength(2);
    }
    await service.pool.query("UPDATE monitors SET last_outcome='fail' WHERE id=$1", [monitor.id]);
    await due();
    await service.notifications.reminders();
    reminders = (await service.notifications.history(incident.id)).deliveries.filter(
      (d) => d.status === 'pending',
    );
    expect(reminders).toHaveLength(1);
    await service.pool.query('UPDATE incidents SET resolved_at=now() WHERE id=$1', [incident.id]);
    const before = hookCalls.length;
    await service.notifications.deliverOne(reminders[0]!.id);
    expect(hookCalls).toHaveLength(before);
    expect((await service.notifications.attempts(reminders[0]!.id)).delivery.status).toBe(
      'cancelled',
    );
  },
);

suite(
  'paginates delivery history, drains legacy notifications idempotently, and keeps management data private',
  async () => {
    const ch = await service.notifications.saveChannel({
      name: 'Paged channel',
      url: origin + '/delivery-hook/secret-page-token',
    });
    for (let i = 0; i < 27; i++) await service.notifications.testChannel(ch.id);
    const first = await service.notifications.history();
    expect(first.deliveries).toHaveLength(25);
    expect(first.nextBefore).not.toBeNull();
    const next = await service.notifications.history(undefined, first.nextBefore!);
    expect(next.deliveries.some((d) => first.deliveries.some((f) => f.id === d.id))).toBe(false);
    const incident = (await service.dashboard()).incidents[0]!;
    const legacy = {
      id: randomUUID(),
      data: {
        id: incident.id,
        type: 'incident.opened' as const,
        name: incident.name,
        at: incident.openedAt,
      },
    };
    await service.notifications.legacy(legacy);
    await service.notifications.legacy(legacy);
    expect(
      (await service.notifications.history(incident.id)).deliveries.filter(
        (d) => d.id === legacy.id,
      ),
    ).toHaveLength(1);
    const headers = { authorization: `Bearer ${token}` };
    for (const url of [
      '/v1/notification-deliveries',
      `/v1/notification-deliveries/${first.deliveries[0]!.id}`,
      `/v1/incidents/${incident.id}`,
    ]) {
      expect((await app.inject({ url })).statusCode).toBe(401);
      const response = await app.inject({ url, headers });
      expect(response.statusCode).toBe(200);
      expect(response.body).not.toMatch(/secret-page-token|private-response-token|target_url/);
    }
    expect((await app.inject({ url: '/v1/public/status' })).body).not.toMatch(
      /notification|secret-page-token|target_url/,
    );
  },
);

suite(
  'encrypts and rotates named secrets without persisting resolved credentials in runs or revisions',
  async () => {
    const headers = { authorization: `Bearer ${token}` };
    const secret = 'credential-v1-private';
    const create = await app.inject({
      url: '/v1/secrets',
      method: 'POST',
      headers,
      payload: { name: 'MANAGED_TOKEN', value: secret },
    });
    expect(create.statusCode).toBe(201);
    expect(create.body).not.toContain(secret);
    const stored = (
      await service.pool.query('SELECT * FROM managed_secrets WHERE name=$1', ['MANAGED_TOKEN'])
    ).rows[0];
    expect(JSON.stringify(stored)).not.toContain(secret);
    const monitor = await service.createCheck(
      checkSchema.parse({
        name: 'Secret check',
        url: origin + '/secret-check',
        method: 'POST',
        headers: { Authorization: 'Bearer {{MANAGED_TOKEN}}' },
        body: '{{MANAGED_TOKEN}}',
        notificationChannelIds: [],
      }),
    );
    const run = () =>
      service.runJob({
        id: randomUUID(),
        data: { monitorId: monitor.id, scheduledAt: Date.now() },
      });
    await run();
    expect(receivedCredential).toBe('Bearer ' + secret);
    expect(receivedBody).toBe(secret);
    await service.secrets.save(
      { value: 'credential-v2-private', enabled: true, expectedRevision: 1 },
      'MANAGED_TOKEN',
    );
    await run();
    expect(receivedCredential).toBe('Bearer credential-v2-private');
    expect((await service.getCheck(monitor.id)).configRevision).toBe(1);
    for (const output of [
      await service.getRuns(monitor.id),
      await service.getRevisions(monitor.id),
      await service.secrets.overview(),
    ])
      expect(JSON.stringify(output)).not.toMatch(/credential-v[12]-private|ciphertext/);
    const overview = await service.secrets.overview();
    expect(overview.secrets.find((s) => s.name === 'MANAGED_TOKEN')?.usages).toContainEqual({
      kind: 'check',
      id: monitor.id,
      name: 'Secret check',
      archived: false,
    });
    await expect(
      service.secrets.save({ enabled: true, expectedRevision: 1 }, 'MANAGED_TOKEN'),
    ).rejects.toMatchObject({ statusCode: 409 });
    process.env.CHECK_SECRET_MANAGED_TOKEN = 'environment-fallback-must-not-be-used';
    await service.secrets.save({ enabled: false, expectedRevision: 2 }, 'MANAGED_TOKEN');
    receivedCredential = '';
    await run();
    expect(receivedCredential).toBe('');
    expect((await service.getRuns(monitor.id))[0]?.outcome).toBe('error');
    delete process.env.CHECK_SECRET_MANAGED_TOKEN;
    expect((await app.inject({ url: '/v1/secrets' })).statusCode).toBe(401);
  },
);

suite(
  'resolves webhook references on each attempt, preserves reference-only delivery records, and supports environment secrets',
  async () => {
    await service.secrets.save({
      name: 'MANAGED_HOOK',
      value: origin + '/delivery-hook/rotating-private-v1',
    });
    const ch = await service.notifications.saveChannel({
      name: 'Secret webhook',
      url: '{{MANAGED_HOOK}}',
    });
    expect(ch.destination).toContain('MANAGED_HOOK');
    hookStatus = 503;
    const { deliveryId } = await service.notifications.testChannel(ch.id);
    await service.notifications.deliverOne(deliveryId);
    await service.secrets.save(
      { value: origin + '/delivery-hook/rotating-private-v2', enabled: true, expectedRevision: 1 },
      'MANAGED_HOOK',
    );
    await service.pool.query(
      'UPDATE notification_deliveries SET next_attempt_at=now() WHERE id=$1',
      [deliveryId],
    );
    hookStatus = 204;
    await service.notifications.deliverOne(deliveryId);
    const row = (
      await service.pool.query('SELECT * FROM notification_deliveries WHERE id=$1', [deliveryId])
    ).rows[0];
    expect(hookCalls.at(-1)?.path).toBe('/delivery-hook/rotating-private-v2');
    expect(row.target_url).toBe('{{MANAGED_HOOK}}');
    expect(row.status).toBe('delivered');
    expect(JSON.stringify(row)).not.toContain('rotating-private');
    const usages = (await service.secrets.overview()).secrets.find(
      (s) => s.name === 'MANAGED_HOOK',
    )!.usages;
    expect(usages.some((u) => u.kind === 'channel' && u.id === ch.id)).toBe(true);
    process.env.CHECK_SECRET_ENV_COMPAT = 'env-compat-value';
    expect(await service.secrets.resolve(['{{ENV_COMPAT}}'])).toEqual({
      CHECK_SECRET_ENV_COMPAT: 'env-compat-value',
    });
    await expect(
      service.secrets.save({ name: 'ENV_COMPAT', value: 'replacement' }),
    ).rejects.toMatchObject({ statusCode: 409 });
    delete process.env.CHECK_SECRET_ENV_COMPAT;
  },
);

suite(
  'publishes branding, visible component groups, scheduled maintenance, and manual incident communication without private data',
  async () => {
    status = 200;
    const pub = await service.createCheck(
      checkSchema.parse({
        name: 'Public payments',
        url: origin,
        public: true,
        notificationChannelIds: [],
      }),
    );
    const hidden = await service.createCheck(
      checkSchema.parse({
        name: 'Private billing',
        url: origin + '/private',
        notificationChannelIds: [],
      }),
    );
    for (const m of [pub, hidden])
      await service.runJob({
        id: randomUUID(),
        data: { monitorId: m.id, scheduledAt: Date.now() },
      });
    const baseline = await service.statusManagement.admin();
    const group = randomUUID();
    await service.statusManagement.saveSettings(
      {
        ...baseline.settings,
        title: 'Acme status',
        brandName: 'Acme',
        description: 'Service health',
        accentColor: '#123456',
        theme: 'dark',
        layout: 'wide',
        showPoweredBy: false,
        links: [{ label: 'Support', url: 'https://example.com/support' }],
        content: [
          {
            id: randomUUID(),
            title: 'Our commitment',
            body: 'Updates every hour.',
            position: 'before-services',
          },
        ],
        groups: [
          { id: group, name: 'Payments', monitorIds: [pub.id] },
          { id: randomUUID(), name: 'Secret internal group', monitorIds: [hidden.id] },
        ],
      },
      baseline.revision,
    );
    await expect(
      service.statusManagement.saveSettings(baseline.settings, baseline.revision),
    ).rejects.toMatchObject({ statusCode: 409 });
    let publicData = await service.publicStatus();
    expect(publicData.title).toBe('Acme status');
    expect(publicData.branding).toMatchObject({
      theme: 'dark',
      layout: 'wide',
      showPoweredBy: false,
      links: [{ label: 'Support', url: 'https://example.com/support' }],
      content: [
        { title: 'Our commitment', body: 'Updates every hour.', position: 'before-services' },
      ],
    });
    expect(publicData.groups).toContainEqual({ id: group, name: 'Payments' });
    expect(JSON.stringify(publicData)).not.toMatch(/Private billing|Secret internal group/);
    expect(JSON.stringify(publicData)).not.toContain(hidden.id);
    const maintenance = await service.statusManagement.saveMaintenance({
      title: 'Payments upgrade',
      description: 'Planned database upgrade',
      monitorIds: [pub.id],
      startsAt: new Date(Date.now() - 60000).toISOString(),
      endsAt: new Date(Date.now() + 60000).toISOString(),
    });
    publicData = await service.publicStatus();
    expect(publicData.components.find((c) => c.id === pub.id)?.health).toBe('maintenance');
    expect((await service.getCheck(pub.id)).health).toBe('up');
    await service.statusManagement.saveMaintenance(
      { ...maintenance, cancelled: true },
      maintenance.id,
      maintenance.revision,
    );
    expect((await service.publicStatus()).components.find((c) => c.id === pub.id)?.health).toBe(
      'up',
    );
    const manual = await service.statusManagement.createIncident({
      title: 'Delayed settlements',
      monitorIds: [pub.id],
      body: 'Investigating delayed processing.',
    });
    publicData = await service.publicStatus();
    expect(publicData.components.find((c) => c.id === pub.id)?.health).toBe('down');
    expect((await service.getCheck(pub.id)).health).toBe('up');
    await service.statusManagement.updateIncident(manual.id, {
      source: 'manual',
      stage: 'identified',
      body: 'The processing delay has been identified.',
      expectedRevision: 1,
    });
    await expect(
      service.statusManagement.updateIncident(manual.id, {
        source: 'manual',
        stage: 'resolved',
        body: 'stale update',
        expectedRevision: 1,
      }),
    ).rejects.toMatchObject({ statusCode: 409 });
    await service.statusManagement.updateIncident(manual.id, {
      source: 'manual',
      stage: 'resolved',
      body: 'Processing has recovered.',
      expectedRevision: 2,
    });
    publicData = await service.publicStatus();
    expect(publicData.communications?.find((i) => i.id === manual.id)?.updates).toHaveLength(3);
    expect(publicData.components.find((c) => c.id === pub.id)?.health).toBe('up');
    await service.changeCheck(
      pub.id,
      { kind: 'edit', config: { ...pub.config, public: false } },
      1,
    );
    publicData = await service.publicStatus();
    expect(publicData.communications?.some((i) => i.id === manual.id)).toBe(false);
    expect(publicData.groups?.some((g) => g.id === group)).toBe(false);
    await expect(
      service.statusManagement.createIncident({
        title: 'Private incident',
        monitorIds: [hidden.id],
        body: 'Should not publish',
      }),
    ).rejects.toMatchObject({ statusCode: 400 });
    expect((await app.inject({ url: '/v1/status-management' })).statusCode).toBe(401);
  },
);

suite(
  'publishes progress updates for detected incidents without manufacturing recovery',
  async () => {
    status = 503;
    const monitor = await service.createCheck(
      checkSchema.parse({
        name: 'Detected public issue',
        url: origin,
        public: true,
        failureThreshold: 1,
        notificationChannelIds: [],
      }),
    );
    await service.runJob({
      id: randomUUID(),
      data: { monitorId: monitor.id, scheduledAt: Date.now() },
    });
    const incident = (await service.dashboard()).incidents.find((i) => i.monitorId === monitor.id)!;
    await service.statusManagement.updateIncident(incident.id, {
      source: 'automatic',
      stage: 'identified',
      body: 'A fix is being prepared.',
      expectedRevision: 1,
    });
    expect(
      (await service.publicStatus()).communications?.find((i) => i.id === incident.id)?.stage,
    ).toBe('identified');
    await expect(
      service.statusManagement.updateIncident(incident.id, {
        source: 'automatic',
        stage: 'resolved',
        body: 'Not actually recovered',
        expectedRevision: 2,
      }),
    ).rejects.toMatchObject({ statusCode: 409 });
    expect((await service.getCheck(monitor.id)).health).toBe('down');
    status = 200;
    await service.runJob({
      id: randomUUID(),
      data: { monitorId: monitor.id, scheduledAt: Date.now() },
    });
    expect(
      (await service.publicStatus()).communications?.find((i) => i.id === incident.id)?.stage,
    ).toBe('resolved');
  },
);

suite(
  'retains public impact outside the history limit and excludes future or expired maintenance',
  async () => {
    status = 200;
    const monitor = await service.createCheck(
      checkSchema.parse({
        name: 'Long-running public issue',
        url: origin,
        public: true,
        notificationChannelIds: [],
      }),
    );
    await service.runJob({
      id: randomUUID(),
      data: { monitorId: monitor.id, scheduledAt: Date.now() },
    });
    const ongoing = await service.statusManagement.createIncident({
      title: 'Old open issue',
      monitorIds: [monitor.id],
      body: 'Still investigating.',
    });
    await service.pool.query(
      "UPDATE status_incidents SET created_at=now()-interval '1 year' WHERE id=$1",
      [ongoing.id],
    );
    await service.pool.query(
      "INSERT INTO status_incidents(title,monitor_ids,resolved_at) SELECT 'Resolved historical issue',ARRAY[$1::uuid],now() FROM generate_series(1,101)",
      [monitor.id],
    );
    expect((await service.publicStatus()).components.find((c) => c.id === monitor.id)?.health).toBe(
      'down',
    );
    await service.statusManagement.updateIncident(ongoing.id, {
      source: 'manual',
      stage: 'resolved',
      body: 'Resolved.',
      expectedRevision: 1,
    });
    await service.statusManagement.saveMaintenance({
      title: 'Later',
      monitorIds: [monitor.id],
      startsAt: new Date(Date.now() + 3600000).toISOString(),
      endsAt: new Date(Date.now() + 7200000).toISOString(),
    });
    await service.statusManagement.saveMaintenance({
      title: 'Already ended',
      monitorIds: [monitor.id],
      startsAt: new Date(Date.now() - 7200000).toISOString(),
      endsAt: new Date(Date.now() - 3600000).toISOString(),
    });
    const data = await service.publicStatus();
    expect(data.components.find((c) => c.id === monitor.id)?.health).toBe('up');
    expect(data.maintenance?.some((w) => w.title === 'Later')).toBe(true);
    expect(data.maintenance?.some((w) => w.title === 'Already ended')).toBe(false);
  },
);

suite(
  'tests draft requests with safe diagnostics without persisting monitoring state',
  async () => {
    status = 200;
    const headers = { authorization: `Bearer ${token}` };
    const config = checkSchema.parse({ name: 'Unsaved preview', url: origin });
    const counts = async () =>
      (
        await service.pool.query(`SELECT
    (SELECT count(*) FROM monitors) AS monitors,
    (SELECT count(*) FROM check_revisions) AS revisions,
    (SELECT count(*) FROM runs) AS runs,
    (SELECT count(*) FROM incidents) AS incidents,
    (SELECT count(*) FROM notification_deliveries) AS deliveries`)
      ).rows[0];
    const before = await counts();
    const requestsBefore = targetRequests;
    expect(
      (await app.inject({ method: 'POST', url: '/v1/checks/test', payload: config })).statusCode,
    ).toBe(401);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/v1/checks/test',
          headers: { ...headers, origin: 'https://other.example' },
          payload: config,
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/v1/checks/test',
          headers,
          payload: { ...config, timeoutMs: 999999 },
        })
      ).statusCode,
    ).toBe(400);
    expect(targetRequests).toBe(requestsBefore);
    const pass = await app.inject({
      method: 'POST',
      url: '/v1/checks/test',
      headers,
      payload: config,
    });
    expect(pass.statusCode).toBe(200);
    expect(pass.json()).toMatchObject({ outcome: 'pass', statusCode: 200 });
    expect(pass.body).not.toContain('do-not-store');
    const failed = await app.inject({
      method: 'POST',
      url: '/v1/checks/test',
      headers,
      payload: { ...config, expectedStatus: 201 },
    });
    expect(failed.json()).toMatchObject({
      outcome: 'fail',
      assertions: [{ kind: 'status', passed: false }],
    });
    expect(targetRequests).toBe(requestsBefore + 2);
    await service.secrets.save({ name: 'PREVIEW_TOKEN', value: 'private-preview-token' });
    const secretConfig = {
      ...config,
      url: origin + '/secret-check',
      method: 'POST',
      headers: { Authorization: 'Bearer {{PREVIEW_TOKEN}}' },
      body: '{{PREVIEW_TOKEN}}',
    };
    const secret = await app.inject({
      method: 'POST',
      url: '/v1/checks/test',
      headers,
      payload: secretConfig,
    });
    expect(secret.json().outcome).toBe('pass');
    expect(receivedCredential).toBe('Bearer private-preview-token');
    expect(receivedBody).toBe('private-preview-token');
    expect(secret.body).not.toContain('private-preview-token');
    const missing = await app.inject({
      method: 'POST',
      url: '/v1/checks/test',
      headers,
      payload: { ...config, headers: { Authorization: '{{PREVIEW_MISSING}}' } },
    });
    expect(missing.json()).toMatchObject({ outcome: 'error', statusCode: null });
    expect(targetRequests).toBe(requestsBefore + 2);
    expect(await counts()).toEqual(before);
  },
);

suite('bounds concurrent request previews and releases capacity after completion', async () => {
  let release!: () => void;
  let entered!: () => void;
  let arrivals = 0;
  const ready = new Promise<void>((resolve) => {
    entered = resolve;
  });
  hold = {
    release: new Promise<void>((resolve) => {
      release = resolve;
    }),
    entered: () => {
      if (++arrivals === 2) entered();
    },
  };
  const config = checkSchema.parse({
    name: 'Held preview',
    url: origin + '/held',
    timeoutMs: 2000,
  });
  const first = service.testCheck(config);
  const second = service.testCheck(config);
  try {
    await ready;
    await expect(service.testCheck(config)).rejects.toMatchObject({ statusCode: 429 });
  } finally {
    release();
    await Promise.all([first, second]);
    hold = null;
  }
  expect((await service.testCheck({ ...config, url: origin })).outcome).toBe('pass');
});

const probeHeaders = (credential: string) => ({ authorization: `Bearer ${credential}` });
async function newProbe(name = 'Regional probe') {
  const enrollment = await service.probes.create({ name, region: 'Test region' });
  const credential = randomBytes(32).toString('hex');
  await service.probes.enroll(enrollment.enrollmentToken, credential);
  return { id: enrollment.id, credential, enrollment };
}
const regionalResult = (outcome: 'pass' | 'fail' | 'error') => ({
  outcome,
  statusCode: outcome === 'error' ? null : outcome === 'pass' ? 200 : 503,
  durationMs: 15,
  assertions: [{ passed: outcome === 'pass' }],
});
suite(
  'enrolls scoped probes once, rejects expiration, and revokes or replaces credentials',
  async () => {
    expect((await app.inject({ url: '/v1/locations' })).statusCode).toBe(401);
    const p = await newProbe();
    expect(
      (await service.probes.enroll(p.enrollment.enrollmentToken, p.credential)).locationId,
    ).toBe(p.id);
    await expect(
      service.probes.enroll(p.enrollment.enrollmentToken, randomBytes(32).toString('hex')),
    ).rejects.toMatchObject({ statusCode: 401 });
    expect(
      (await app.inject({ url: '/v1/dashboard', headers: probeHeaders(p.credential) })).statusCode,
    ).toBe(401);
    expect(
      (
        await app.inject({
          url: '/v1/probe/poll',
          method: 'POST',
          payload: { protocolVersion: 1 },
          headers: probeHeaders(token),
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (
        await app.inject({
          url: '/v1/probe/poll',
          method: 'POST',
          payload: { protocolVersion: 2 },
          headers: probeHeaders(p.credential),
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          url: '/v1/probe/poll',
          method: 'POST',
          payload: { protocolVersion: 1 },
          headers: probeHeaders(p.credential),
        })
      ).statusCode,
    ).toBe(200);
    const metadata = JSON.stringify(await service.probes.list());
    expect(metadata).not.toContain(p.credential);
    expect(metadata).not.toContain(p.enrollment.enrollmentToken);
    expect((await service.probes.list()).find((l) => l.id === p.id)?.status).toBe('online');
    const replacement = await service.probes.renew(p.id);
    await expect(service.probes.authenticate(p.credential)).rejects.toMatchObject({
      statusCode: 401,
    });
    await expect(service.probes.claim(p.id, p.credential)).rejects.toMatchObject({
      statusCode: 401,
    });
    const newCredential = randomBytes(32).toString('hex');
    await service.probes.enroll(replacement.enrollmentToken, newCredential);
    await service.probes.revoke(p.id);
    expect(
      (
        await app.inject({
          url: '/v1/probe/poll',
          method: 'POST',
          payload: { protocolVersion: 1 },
          headers: probeHeaders(newCredential),
        })
      ).statusCode,
    ).toBe(401);
    const expired = await service.probes.create({ name: 'Expired', region: 'Test' });
    await service.pool.query(
      "UPDATE probe_locations SET enrollment_expires_at=now()-interval '1 second' WHERE id=$1",
      [expired.id],
    );
    await expect(
      service.probes.enroll(expired.enrollmentToken, randomBytes(32).toString('hex')),
    ).rejects.toMatchObject({ statusCode: 401 });
  },
);
suite(
  'coordinates local and remote observations into one incident decision per round',
  async () => {
    const p = await newProbe('Regional voting');
    const m = await service.createCheck(
      checkSchema.parse({
        name: 'Two locations',
        url: origin,
        locationIds: ['local', p.id],
        locationFailureThreshold: 2,
        failureThreshold: 2,
        recoveryThreshold: 1,
        notificationChannelIds: [],
      }),
    );
    const round = async (local: 'pass' | 'fail', remote: 'pass' | 'fail') => {
      expect(await service.enqueue(m.id)).toBe(1);
      expect(await service.enqueue(m.id)).toBe(0);
      const a = (await service.probes.claim('local')).job!;
      const b = (await service.probes.claim(p.id, p.credential)).job!;
      expect(a.config.name).toBe('Two locations');
      expect(b.config.name).toBe('Two locations');
      await service.probes.complete('local', a.id, a.leaseToken, regionalResult(local));
      const response = await app.inject({
        url: '/v1/probe/results',
        method: 'POST',
        headers: probeHeaders(p.credential),
        payload: {
          protocolVersion: 1,
          jobId: b.id,
          leaseToken: b.leaseToken,
          result: { ...regionalResult(remote), failures: ['do-not-persist-private-value'] },
        },
      });
      expect(response.statusCode).toBe(200);
      await service.probes.complete(p.id, b.id, b.leaseToken, regionalResult(remote), p.credential);
    };
    await round('fail', 'pass');
    expect((await service.getCheck(m.id)).health).toBe('up');
    await round('fail', 'fail');
    expect((await service.getCheck(m.id)).health).toBe('up');
    await round('fail', 'fail');
    expect((await service.getCheck(m.id)).health).toBe('down');
    const incidents = (
      await service.pool.query('SELECT * FROM incidents WHERE monitor_id=$1', [m.id])
    ).rows;
    expect(incidents).toHaveLength(1);
    await round('pass', 'pass');
    expect((await service.getCheck(m.id)).health).toBe('up');
    expect(
      (await service.pool.query('SELECT resolved_at FROM incidents WHERE monitor_id=$1', [m.id]))
        .rows[0].resolved_at,
    ).not.toBeNull();
    expect(await service.getRuns(m.id)).toHaveLength(4);
    const stored = JSON.stringify(
      (
        await service.pool.query(
          'SELECT result FROM probe_jobs j JOIN probe_rounds r ON r.id=j.round_id WHERE r.monitor_id=$1',
          [m.id],
        )
      ).rows,
    );
    expect(stored).not.toContain('do-not-persist-private-value');
    const observations = await service.probes.observations(m.id);
    expect(observations).toHaveLength(2);
    expect(observations.every((o) => o.fresh && o.outcome === 'pass')).toBe(true);
  },
);
suite(
  'treats offline probes as missing coverage and expires rounds without false outages',
  async () => {
    const p = await newProbe('Offline');
    const m = await service.createCheck(
      checkSchema.parse({
        name: 'Coverage',
        url: origin,
        locationIds: ['local', p.id],
        locationFailureThreshold: 2,
        failureThreshold: 1,
      }),
    );
    await service.enqueue(m.id);
    const a = (await service.probes.claim('local')).job!;
    await service.probes.complete('local', a.id, a.leaseToken, regionalResult('fail'));
    await service.pool.query(
      "UPDATE probe_rounds SET deadline=now()-interval '1 second' WHERE monitor_id=$1",
      [m.id],
    );
    await service.probes.expire();
    expect((await service.getCheck(m.id)).health).toBe('unknown');
    expect((await service.getRuns(m.id))[0]?.outcome).toBe('error');
    expect(
      (await service.pool.query('SELECT count(*) FROM incidents WHERE monitor_id=$1', [m.id]))
        .rows[0].count,
    ).toBe('0');
    await service.pool.query(
      "UPDATE probe_locations SET last_seen_at=now()-interval '1 minute' WHERE id=$1",
      [p.id],
    );
    expect((await service.probes.list()).find((l) => l.id === p.id)?.status).toBe('offline');
    expect(
      (await service.probes.observations(m.id)).find((o) => o.locationId === p.id)?.fresh,
    ).toBe(false);
    expect(await service.enqueue(m.id)).toBe(1);
    await service.changeCheck(m.id, { kind: 'enabled', enabled: false });
  },
);
suite(
  'rejects other locations, obsolete revisions, replaced leases, and revoked in-flight jobs',
  async () => {
    const p = await newProbe('Lease owner');
    const other = await newProbe('Other owner');
    const m = await service.createCheck(
      checkSchema.parse({ name: 'Leases', url: origin, locationIds: [p.id] }),
    );
    await service.enqueue(m.id);
    const first = (await service.probes.claim(p.id, p.credential)).job!;
    expect((await service.probes.claim(other.id, other.credential)).job).toBeNull();
    await expect(
      service.probes.complete(
        other.id,
        first.id,
        first.leaseToken,
        regionalResult('pass'),
        other.credential,
      ),
    ).rejects.toMatchObject({ statusCode: 404 });
    await service.pool.query(
      "UPDATE probe_jobs SET lease_until=now()-interval '1 second' WHERE id=$1",
      [first.id],
    );
    const retry = (await service.probes.claim(p.id, p.credential)).job!;
    expect(retry.id).toBe(first.id);
    expect(retry.leaseToken).not.toBe(first.leaseToken);
    await expect(
      service.probes.complete(
        p.id,
        first.id,
        first.leaseToken,
        regionalResult('pass'),
        p.credential,
      ),
    ).rejects.toMatchObject({ statusCode: 409 });
    const edited = await service.changeCheck(
      m.id,
      { kind: 'edit', config: { ...m.config, expectedStatus: 201 } },
      1,
    );
    await expect(
      service.probes.complete(
        p.id,
        retry.id,
        retry.leaseToken,
        regionalResult('pass'),
        p.credential,
      ),
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(await service.enqueue(m.id)).toBe(1);
    const current = (await service.probes.claim(p.id, p.credential)).job!;
    expect(current.config.expectedStatus).toBe(201);
    await service.probes.revoke(p.id);
    await expect(
      service.probes.complete(
        p.id,
        current.id,
        current.leaseToken,
        regionalResult('pass'),
        p.credential,
      ),
    ).rejects.toMatchObject({ statusCode: 401 });
    expect(await service.getRuns(m.id)).toHaveLength(0);
    await service.changeCheck(m.id, { kind: 'archive' }, edited.configRevision);
    await expect(
      service.createCheck(
        checkSchema.parse({ name: 'Invalid location', url: origin, locationIds: [randomUUID()] }),
      ),
    ).rejects.toMatchObject({ statusCode: 400 });
  },
);
suite(
  'distributes only assigned secrets and resolves rotations when jobs are claimed',
  async () => {
    const p = await newProbe('Secret receiver');
    const other = await newProbe('Unassigned');
    await service.secrets.save({ name: 'REGIONAL_TOKEN', value: 'regional-secret-one' });
    const m = await service.createCheck(
      checkSchema.parse({
        name: 'Regional secret check',
        url: origin,
        headers: { authorization: 'Bearer {{REGIONAL_TOKEN}}' },
        locationIds: [p.id],
      }),
    );
    await service.enqueue(m.id);
    await service.secrets.save(
      { value: 'regional-secret-two', enabled: true, expectedRevision: 1 },
      'REGIONAL_TOKEN',
    );
    expect((await service.probes.claim(other.id, other.credential)).job).toBeNull();
    const { job } = await service.probes.claim(p.id, p.credential);
    expect(job?.secrets).toEqual({ CHECK_SECRET_REGIONAL_TOKEN: 'regional-secret-two' });
    const stored = JSON.stringify(
      (
        await service.pool.query(
          'SELECT j.* FROM probe_jobs j JOIN probe_rounds r ON r.id=j.round_id WHERE r.monitor_id=$1',
          [m.id],
        )
      ).rows,
    );
    expect(stored).not.toContain('regional-secret');
    await service.probes.complete(
      p.id,
      job!.id,
      job!.leaseToken,
      regionalResult('pass'),
      p.credential,
    );
  },
);

suite(
  'runs the standalone probe over HTTP and reconnects using its persisted identity',
  async () => {
    const { spawn } = await import('node:child_process');
    const { mkdtemp, readFile, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const directory = await mkdtemp(join(tmpdir(), 'stillup-probe-test-'));
    const address = await app.listen({ port: 0, host: '127.0.0.1' });
    const enrollment = await service.probes.create({
      name: 'Standalone executable',
      region: 'Integration test',
    });
    await service.secrets.save({ name: 'STANDALONE_TOKEN', value: 'standalone-private-value' });
    const m = await service.createCheck(
      checkSchema.parse({
        name: 'Standalone API',
        url: origin + '/secret-check',
        headers: { authorization: 'Bearer {{STANDALONE_TOKEN}}' },
        locationIds: [enrollment.id],
        failureThreshold: 1,
      }),
    );
    let child: ReturnType<typeof spawn> | undefined;
    const start = (token?: string) => {
      child = spawn(
        process.execPath,
        [
          '--import',
          'tsx',
          fileURLToPath(new URL('../../legacy-probe/src/main.ts', import.meta.url)),
        ],
        {
          env: {
            PATH: process.env.PATH,
            STILLUP_URL: address,
            STILLUP_ENROLLMENT_TOKEN: token ?? '',
            STILLUP_PROBE_DATA: directory,
            STILLUP_PROBE_ALLOW_HTTP: 'true',
            STILLUP_PROBE_ALLOW_PRIVATE_NETWORKS: 'true',
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      // Read streams to avoid blocked pipes; never echo request data or identity state.
      child.stdout?.resume();
      child.stderr?.resume();
    };
    const stop = async () => {
      if (!child || child.exitCode !== null) return;
      const processToStop = child;
      await new Promise<void>((resolve) => {
        processToStop.once('exit', () => resolve());
        processToStop.kill('SIGTERM');
      });
      child = undefined;
    };
    try {
      await service.enqueue(m.id);
      start(enrollment.enrollmentToken);
      await eventually(async () => (await service.getCheck(m.id)).health === 'up', 10000);
      expect(receivedCredential).toBe('Bearer standalone-private-value');
      const identity = JSON.parse(await readFile(join(directory, 'identity.json'), 'utf8'));
      expect(identity.locationId).toBe(enrollment.id);
      expect(identity.enrollmentToken).toBeUndefined();
      await stop();
      await service.enqueue(m.id);
      start();
      await eventually(async () => (await service.getRuns(m.id)).length === 2, 10000);
      expect(JSON.parse(await readFile(join(directory, 'identity.json'), 'utf8')).token).toBe(
        identity.token,
      );
      expect((await service.probes.list()).find((l) => l.id === enrollment.id)?.status).toBe(
        'online',
      );
    } finally {
      await stop();
      await rm(directory, { recursive: true, force: true });
    }
  },
  30000,
);

suite(
  'persists workspace appearance with authenticated writes and revision protection',
  async () => {
    const headers = { authorization: `Bearer ${token}` };
    expect((await app.inject({ url: '/v1/workspace' })).statusCode).toBe(401);
    expect(
      (await app.inject({ url: '/v1/workspace', method: 'PUT', payload: {} })).statusCode,
    ).toBe(401);
    const initial = (await app.inject({ url: '/v1/workspace', headers })).json();
    const config = {
      name: 'Acme Operations',
      tagline: 'Always watching.',
      logoUrl: 'https://example.com/logo.svg',
      accentColor: '#7c3aed',
      density: 'compact',
    };
    const save = await app.inject({
      url: '/v1/workspace',
      method: 'PUT',
      headers,
      payload: { config, expectedRevision: initial.revision },
    });
    expect(save.statusCode).toBe(200);
    const stored = await service.workspace.read();
    expect(stored.settings).toEqual(config);
    expect(stored.revision).toBe(initial.revision + 1);
    expect((await app.inject({ url: '/v1/public/workspace' })).json()).toEqual(config);
    const stale = await app.inject({
      url: '/v1/workspace',
      method: 'PUT',
      headers,
      payload: { config: { ...config, name: 'Stale edit' }, expectedRevision: initial.revision },
    });
    expect(stale.statusCode).toBe(409);
    for (const change of [
      { logoUrl: 'javascript:alert(1)' },
      { logoUrl: 'https://user:password@example.com/logo.svg' },
      { accentColor: '#fff;display:none' },
      { density: 'invalid' },
    ]) {
      expect(
        (
          await app.inject({
            url: '/v1/workspace',
            method: 'PUT',
            headers,
            payload: { config: { ...config, ...change }, expectedRevision: stored.revision },
          })
        ).statusCode,
      ).toBe(400);
    }
    const crossOrigin = await app.inject({
      url: '/v1/workspace',
      method: 'PUT',
      headers: { ...headers, origin: 'https://untrusted.example' },
      payload: { config, expectedRevision: stored.revision },
    });
    expect(crossOrigin.statusCode).toBe(403);
    expect((await service.workspace.read()).settings).toEqual(config);
  },
);

suite('code projects apply atomically, preserve history, and enforce ownership', async () => {
  const headers = { authorization: `Bearer ${token}` };
  const { codeConfigSchema } = await import('@stillup/core/code-config');
  const config = codeConfigSchema.parse({
    version: 1,
    project: 'code-lifecycle',
    checks: [
      {
        id: 'health',
        config: {
          name: 'Code health',
          url: origin,
          intervalSeconds: 86400,
          headers: { Authorization: 'Bearer {{API_TOKEN}}' },
        },
      },
    ],
  });
  const unauthenticated = await app.inject({
    url: '/v1/code/plan',
    method: 'POST',
    payload: config,
  });
  expect(unauthenticated.statusCode).toBe(401);
  const preview = await app.inject({
    url: '/v1/code/plan',
    method: 'POST',
    headers,
    payload: config,
  });
  expect(preview.statusCode).toBe(200);
  expect(preview.body).not.toContain('API_TOKEN');
  expect(preview.json().changes[0].action).toBe('create');
  expect(
    (await service.pool.query('SELECT * FROM monitors WHERE code_project=$1', [config.project]))
      .rowCount,
  ).toBe(0);
  const applied = await app.inject({
    url: '/v1/code/apply',
    method: 'POST',
    headers,
    payload: { config, token: preview.json().token },
  });
  expect(applied.statusCode).toBe(200);
  const next = await service.code.plan(config);
  expect(next.changes[0]!.action).toBe('unchanged');
  const id = next.changes[0]!.monitorId!;
  const monitor = await service.getCheck(id);
  expect(monitor.codeOwnership).toEqual({ project: 'code-lifecycle', id: 'health' });
  await service.code.apply(config, next.token);
  expect((await service.getRevisions(id)).revisions).toHaveLength(1);
  expect(
    (
      await app.inject({
        url: `/v1/checks/${id}`,
        method: 'PUT',
        headers,
        payload: { config: monitor.config, expectedRevision: 1 },
      })
    ).statusCode,
  ).toBe(409);
  const changed = structuredClone(config);
  changed.checks[0]!.config.name = 'Renamed code health';
  const stale = await service.code.plan(changed);
  await service.changeCheck(id, { kind: 'enabled', enabled: false }, 1);
  await expect(service.code.apply(changed, stale.token)).rejects.toMatchObject({ statusCode: 409 });
  expect((await service.getCheck(id)).configRevision).toBe(1);
  const paused = await service.code.plan(changed);
  await service.code.apply(changed, paused.token);
  const updated = await service.getCheck(id);
  expect(updated.enabled).toBe(false);
  expect(updated.configRevision).toBe(2);
  expect((await service.getRevision(id, 1)).config.name).toBe('Code health');
  expect(updated.config.headers.Authorization).toBe('Bearer {{API_TOKEN}}');
  const omitted = { ...changed, checks: [] };
  const retain = await service.code.plan(omitted);
  expect(retain.changes[0]!.action).toBe('retained');
  await service.code.apply(omitted, retain.token);
  expect((await service.getCheck(id)).configRevision).toBe(2);
  await service.changeCheck(id, { kind: 'archive' }, 2);
  const batch = structuredClone(changed);
  batch.checks[0]!.config.name = 'Cannot update archived';
  batch.checks.unshift({
    id: 'must-roll-back',
    config: checkSchema.parse({ name: 'Atomic sibling', url: origin }),
  });
  const blocked = await service.code.plan(batch);
  await expect(service.code.apply(batch, blocked.token)).rejects.toMatchObject({ statusCode: 409 });
  expect(
    (
      await service.pool.query('SELECT 1 FROM monitors WHERE code_project=$1 AND code_key=$2', [
        config.project,
        'must-roll-back',
      ])
    ).rowCount,
  ).toBe(0);
  expect((await service.getCheck(id)).configRevision).toBe(2);
  await service.changeCheck(id, { kind: 'restore' }, 2);
  const restoredPlan = await service.code.plan(changed);
  await service.code.apply(changed, restoredPlan.token);
  expect((await service.getCheck(id)).enabled).toBe(false);
});

suite(
  'concurrent code deployments cannot duplicate identities or touch another project',
  async () => {
    const { codeConfigSchema } = await import('@stillup/core/code-config');
    const config = codeConfigSchema.parse({
      version: 1,
      project: 'code-concurrency',
      checks: [
        { id: 'health', config: { name: 'Shared name', url: origin, intervalSeconds: 86400 } },
      ],
    });
    const ui = await service.createCheck(config.checks[0]!.config);
    const preview = await service.code.plan(config);
    const results = await Promise.allSettled([
      service.code.apply(config, preview.token),
      service.code.apply(config, preview.token),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const failed = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(failed.reason.statusCode).toBe(409);
    const sibling = { ...config, project: 'code-other-project' };
    await service.code.apply(sibling, (await service.code.plan(sibling)).token);
    expect(
      (await service.pool.query('SELECT 1 FROM monitors WHERE code_project=$1', [config.project]))
        .rowCount,
    ).toBe(1);
    expect((await service.code.plan(sibling)).changes[0]!.monitorId).not.toBe(
      (await service.code.plan(config)).changes[0]!.monitorId,
    );
    expect((await service.getCheck(ui.id)).codeOwnership).toBeNull();
    for (const project of [config, sibling]) {
      const id = (await service.code.plan(project)).changes[0]!.monitorId!;
      await service.changeCheck(id, { kind: 'enabled', enabled: false });
    }
    await service.changeCheck(ui.id, { kind: 'enabled', enabled: false });
  },
);

suite(
  'CLI validates, previews, applies, tests, and returns useful exit codes against HTTP',
  async () => {
    const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const run = promisify(execFile);
    const directory = await mkdtemp(join(tmpdir(), 'stillup-cli-'));
    const filename = join(directory, 'checks.json');
    const root = fileURLToPath(new URL('../../../', import.meta.url));
    if (!app.server.listening) await app.listen({ port: 0, host: '127.0.0.1' });
    const address = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
    const config = {
      version: 1,
      project: 'cli-e2e',
      checks: [
        {
          id: 'health',
          config: { name: 'CLI check', url: origin, intervalSeconds: 86400, expectedStatus: 200 },
        },
      ],
    };
    async function cli(...args: string[]) {
      try {
        const result = await run(
          process.execPath,
          ['--import', 'tsx', 'apps/cli/src/main.ts', ...args, '--config', filename],
          {
            cwd: root,
            env: { ...process.env, STILLUP_URL: address, STILLUP_ADMIN_TOKEN: token },
            timeout: 10000,
          },
        );
        return { ...result, code: 0 };
      } catch (error) {
        const e = error as { stdout: string; stderr: string; code: number };
        return { stdout: e.stdout, stderr: e.stderr, code: e.code };
      }
    }
    try {
      status = 200;
      await writeFile(filename, JSON.stringify(config));
      expect((await cli('validate')).code).toBe(0);
      expect((await cli('apply')).code).toBe(1);
      const diff = await cli('diff', '--check', '--json');
      expect(diff.code).toBe(2);
      expect(JSON.parse(diff.stdout).changes[0].action).toBe('create');
      const apply = await cli('apply', '--yes', '--json');
      expect(apply.code, apply.stderr).toBe(0);
      expect(JSON.parse(apply.stdout).applied).toBe(true);
      expect((await cli('diff', '--check')).code).toBe(0);
      const test = await cli('test', '--yes', '--json');
      expect(test.code, test.stderr).toBe(0);
      expect(JSON.parse(test.stdout).results[0].outcome).toBe('pass');
      config.checks[0]!.config.expectedStatus = 418;
      await writeFile(filename, JSON.stringify(config));
      expect((await cli('test', '--yes')).code).toBe(1);
      expect((await cli('test', '--yes', '--id', 'missing')).code).toBe(1);
      await writeFile(filename, JSON.stringify({ ...config, unknownOption: true }));
      expect((await cli('validate')).code).toBe(1);
      const { codeConfigSchema } = await import('@stillup/core/code-config');
      const id = (await service.code.plan(codeConfigSchema.parse(config))).changes[0]!.monitorId!;
      await service.changeCheck(id, { kind: 'enabled', enabled: false });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
  30000,
);
