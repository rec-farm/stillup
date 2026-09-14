import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import { checkSchema, evaluateHealth, visibleHealth } from './index';
import { executeCheck, isPublicAddress, resolveSecrets } from './executor';
let origin: string;
const server = createServer((req, res) => {
  if (req.url === '/slow') {
    setTimeout(() => res.end('{}'), 250);
    return;
  }
  if (req.url === '/large') {
    res.end('x'.repeat(1024 * 1024 + 1));
    return;
  }
  if (req.url === '/redirect') {
    res.writeHead(302, { location: '/ok' });
    res.end();
    return;
  }
  if (req.url === '/bad-json') {
    res.end('not json');
    return;
  }
  if (req.url === '/fail') {
    res.writeHead(503);
    res.end('{}');
    return;
  }
  res.setHeader('content-type', 'application/json');
  res.end(
    JSON.stringify({ status: 'ok', items: [{ id: 42 }], authorization: req.headers.authorization }),
  );
});
beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});
const config = (path = '/ok', extra = {}) =>
  checkSchema.parse({ name: 'API', url: origin + path, ...extra });
describe('check execution', () => {
  it('checks JSON fields and array indexes with secret headers', async () => {
    const result = await executeCheck(
      config('/ok', {
        headers: { Authorization: 'Bearer {{TOKEN}}' },
        jsonAssertions: [
          { path: '$.status', equals: 'ok' },
          { path: '$.items.0.id', equals: 42 },
          { path: '$.authorization', equals: 'Bearer private-secret' },
        ],
      }),
      { allowPrivateNetworks: true, secrets: { CHECK_SECRET_TOKEN: 'private-secret' } },
    );
    expect(result.outcome).toBe('pass');
    expect(JSON.stringify(result)).not.toContain('private-secret');
  });
  it('reports status and JSON assertion failures without saving response data', async () => {
    const result = await executeCheck(
      config('/ok', { expectedStatus: 201, jsonAssertions: [{ path: '$.missing', equals: null }] }),
      { allowPrivateNetworks: true },
    );
    expect(result.outcome).toBe('fail');
    expect(result.failures).toHaveLength(2);
  });
  it('handles invalid JSON', async () => {
    expect(
      (
        await executeCheck(
          config('/bad-json', { jsonAssertions: [{ path: '$.status', equals: 'ok' }] }),
          { allowPrivateNetworks: true },
        )
      ).failures,
    ).toContain('Response is not valid JSON');
  });
  it('enforces a total timeout', async () => {
    const result = await executeCheck(config('/slow', { timeoutMs: 100 }), {
      allowPrivateNetworks: true,
    });
    expect(result.outcome).toBe('fail');
    expect(result.durationMs).toBeLessThan(240);
  });
  it('bounds response size', async () => {
    expect((await executeCheck(config('/large'), { allowPrivateNetworks: true })).outcome).toBe(
      'fail',
    );
  });
  it('does not follow redirects', async () => {
    expect(
      (await executeCheck(config('/redirect'), { allowPrivateNetworks: true })).statusCode,
    ).toBe(302);
  });
  it('blocks private IPs by default as an execution error', async () => {
    expect((await executeCheck(config())).outcome).toBe('error');
  });
  it('blocks DNS-resolved private targets', async () => {
    expect(
      (
        await executeCheck(
          checkSchema.parse({ name: 'local', url: origin.replace('127.0.0.1', 'localhost') }),
        )
      ).outcome,
    ).toBe('error');
  });
  it('missing secrets are not target outages', async () => {
    expect(
      (
        await executeCheck(config('/ok', { headers: { Authorization: '{{MISSING}}' } }), {
          allowPrivateNetworks: true,
        })
      ).outcome,
    ).toBe('error');
  });
});
describe('health transitions', () => {
  it('requires consecutive failures, recovers, and ignores execution errors', () => {
    let state = { status: 'up' as const, failures: 0, successes: 1 };
    const first = evaluateHealth(state, 'fail', 2, 2);
    expect(first.status).toBe('up');
    const down = evaluateHealth(first, 'fail', 2, 2);
    expect(down.status).toBe('down');
    expect(evaluateHealth(down, 'error', 2, 2)).toEqual(down);
    const recovering = evaluateHealth(down, 'pass', 2, 2);
    expect(recovering.status).toBe('down');
    expect(evaluateHealth(recovering, 'pass', 2, 2).status).toBe('up');
    expect(evaluateHealth(evaluateHealth(first, 'pass', 2, 1), 'fail', 2, 1).status).toBe('up');
  });
  it('stale and absent observations are unknown, paused stays paused', () => {
    expect(visibleHealth('up', true, null, 60)).toBe('unknown');
    expect(visibleHealth('up', true, new Date(0).toISOString(), 60, 181000)).toBe('unknown');
    expect(visibleHealth('down', false, null, 60)).toBe('paused');
  });
});
describe('configuration boundaries', () => {
  it.each(['ftp://example.com', 'http://user:password@example.com', 'https://example.com/#secret'])(
    'rejects unsafe URL %s',
    (url) => {
      expect(checkSchema.safeParse({ name: 'API', url }).success).toBe(false);
    },
  );
  it('rejects bodies for GET and short schedules', () => {
    expect(checkSchema.safeParse({ name: 'API', url: origin, body: '{}' }).success).toBe(false);
    expect(checkSchema.safeParse({ name: 'API', url: origin, intervalSeconds: 1 }).success).toBe(
      false,
    );
  });
  it.each([
    '127.0.0.1',
    '10.0.0.1',
    '169.254.169.254',
    '::1',
    '::ffff:127.0.0.1',
    'fc00::1',
    '100.64.0.1',
  ])('restricts %s', (address) => expect(isPublicAddress(address)).toBe(false));
  it('allows public addresses', () => expect(isPublicAddress('1.1.1.1')).toBe(true));
  it('does not include secret names or values in errors', () =>
    expect(() => resolveSecrets('{{PASSWORD}}', {})).toThrow(
      'A referenced check secret is not configured',
    ));
});
