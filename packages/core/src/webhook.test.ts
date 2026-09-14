import { afterAll, beforeAll, expect, it } from 'vitest';
import { createServer } from 'node:http';
import { sendWebhook } from './webhook';
let origin = '';
let requests = 0;
const server = createServer((req, res) => {
  requests++;
  if (req.url === '/redirect') {
    res.writeHead(302, { location: origin + '/ok' });
    res.end();
  } else {
    res.writeHead(202);
    res.end('private webhook response');
  }
});
beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});
it('accepts all 2xx acknowledgements and discards bodies safely', async () => {
  expect(
    await sendWebhook(origin + '/ok', { type: 'notification.test' }, 'event-id', true),
  ).toEqual({ statusCode: 202, error: null });
});
it('does not follow redirects', async () => {
  const before = requests;
  expect((await sendWebhook(origin + '/redirect', {}, 'id', true)).statusCode).toBe(302);
  expect(requests - before).toBe(1);
});
it('blocks private destinations and never exposes the target in errors', async () => {
  const before = requests;
  const result = await sendWebhook(origin + '/private-secret', {}, 'id');
  expect(result.statusCode).toBeNull();
  expect(JSON.stringify(result)).not.toContain('private-secret');
  expect(requests).toBe(before);
});
