import { afterAll, beforeAll, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { checkSchema } from '@stillup/core';
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
const legacyId = randomUUID();
let hold: { entered: () => void; release: Promise<void> } | null = null;
let targetRequests = 0;
const notifications: unknown[] = [];
const fixture = httpServer((req, res) => {
  if (req.url === '/webhook') {
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
