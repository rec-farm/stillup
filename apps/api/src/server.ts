import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import { z } from 'zod';
import { checkSchema, editCheckSchema, revisionGuardSchema } from '@stillup/core';
import { env } from './env';
import type { Service } from './service';

function equal(a: string, b: string) {
  return timingSafeEqual(
    createHash('sha256').update(a).digest(),
    createHash('sha256').update(b).digest(),
  );
}
function sign(value: string) {
  return createHmac('sha256', env.ADMIN_TOKEN).update(value).digest('hex');
}
function validSession(value?: string) {
  if (!value) return false;
  const [expires, signature] = value.split('.');
  return (
    !!expires && !!signature && Number(expires) > Date.now() && equal(sign(expires), signature)
  );
}
export async function createServer(service: Service) {
  const app = Fastify({
    logger: { redact: ['req.headers.authorization', 'req.headers.cookie'] },
    bodyLimit: 100000,
  });
  await app.register(cookie);
  await app.register(rateLimit, { global: true, max: 120, timeWindow: '1 minute' });
  app.addHook('onRequest', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    reply.header('X-Content-Type-Options', 'nosniff');
    const path = request.url.split('?')[0];
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method)) {
      const origin = request.headers.origin;
      if (origin && origin !== new URL(env.APP_ORIGIN).origin)
        return reply.code(403).send({ error: 'Request origin is not allowed' });
      if (!origin && request.headers['sec-fetch-site'] === 'cross-site')
        return reply.code(403).send({ error: 'Cross-site request is not allowed' });
    }
    if (
      path === '/health' ||
      path === '/v1/public/status' ||
      (path === '/v1/session' && request.method === 'POST')
    )
      return;
    const bearer = request.headers.authorization?.replace(/^Bearer /, '');
    if (
      !(bearer && equal(bearer, env.ADMIN_TOKEN)) &&
      !validSession(request.cookies.stillup_session)
    )
      return reply.code(401).send({ error: 'Sign in to manage your checks' });
  });
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof z.ZodError)
      return reply
        .code(400)
        .send({ error: error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') });
    if (
      error instanceof Error &&
      'statusCode' in error &&
      typeof error.statusCode === 'number' &&
      error.statusCode < 500
    )
      return reply.code(error.statusCode).send({ error: error.message });
    app.log.error(error);
    return reply.code(500).send({ error: 'StillUp could not complete this request' });
  });
  app.get('/health', async () => {
    await service.pool.query('SELECT 1');
    return { status: 'ok' };
  });
  app.post(
    '/v1/session',
    { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const { token } = z.object({ token: z.string().max(1024) }).parse(request.body);
      if (!equal(token, env.ADMIN_TOKEN))
        return reply.code(401).send({ error: 'The administrator token is incorrect' });
      const expires = String(Date.now() + 86400000);
      reply.setCookie('stillup_session', `${expires}.${sign(expires)}`, {
        httpOnly: true,
        sameSite: 'strict',
        secure: env.APP_ORIGIN.startsWith('https:'),
        path: '/',
        maxAge: 86400,
      });
      return { ok: true };
    },
  );
  app.delete('/v1/session', async (_request, reply) => {
    reply.clearCookie('stillup_session', { path: '/' });
    return { ok: true };
  });
  app.get('/v1/dashboard', async () => service.dashboard());
  app.get('/v1/public/status', async () => service.publicStatus());
  app.post('/v1/checks', async (request, reply) => {
    const row = await service.createCheck(checkSchema.parse(request.body));
    return reply.code(201).send(row);
  });
  app.get('/v1/checks/:id/runs', async (request) => {
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    return service.getRuns(id);
  });
  app.post('/v1/checks/:id/run', async (request, reply) => {
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const count = await service.enqueue(id);
    return reply.code(202).send({
      queued: count > 0,
      message: count ? 'Check queued' : 'Check already queued or running',
    });
  });
  app.patch('/v1/checks/:id', async (request, reply) => {
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const { enabled, expectedRevision } = revisionGuardSchema
      .partial()
      .extend({ enabled: z.boolean() })
      .parse(request.body);
    return service.changeCheck(id, { kind: 'enabled', enabled }, expectedRevision);
  });
  app.get('/v1/checks/:id', async (request) => {
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    return service.getCheck(id);
  });
  app.put('/v1/checks/:id', async (request) => {
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const { config, expectedRevision } = editCheckSchema.parse(request.body);
    return service.changeCheck(id, { kind: 'edit', config }, expectedRevision);
  });
  for (const kind of ['archive', 'restore'] as const) {
    app.post(`/v1/checks/:id/${kind}`, async (request) => {
      const { id } = z.object({ id: z.uuid() }).parse(request.params);
      const { expectedRevision } = revisionGuardSchema.parse(request.body);
      return service.changeCheck(id, { kind }, expectedRevision);
    });
  }
  app.get('/v1/checks/:id/revisions', async (request) => {
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const { before } = z
      .object({ before: z.coerce.number().int().positive().optional() })
      .parse(request.query);
    return service.getRevisions(id, before);
  });
  app.get('/v1/checks/:id/revisions/:revision', async (request) => {
    const { id, revision } = z
      .object({ id: z.uuid(), revision: z.coerce.number().int().positive() })
      .parse(request.params);
    return service.getRevision(id, revision);
  });
  app.get('/v1/notification-channels', () => service.notifications.listChannels());
  app.post('/v1/notification-channels', async (request, reply) =>
    reply.code(201).send(await service.notifications.saveChannel(request.body)),
  );
  app.put('/v1/notification-channels/:id', async (request) => {
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    return service.notifications.saveChannel(request.body, id);
  });
  app.post(
    '/v1/notification-channels/:id/test',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const { id } = z.object({ id: z.uuid() }).parse(request.params);
      return reply.code(202).send(await service.notifications.testChannel(id));
    },
  );
  app.get('/v1/notification-deliveries', async (request) => {
    const { incidentId, before } = z
      .object({ incidentId: z.uuid().optional(), before: z.uuid().optional() })
      .parse(request.query);
    return service.notifications.history(incidentId, before);
  });
  app.get('/v1/notification-deliveries/:id', async (request) => {
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    return service.notifications.attempts(id);
  });
  app.post(
    '/v1/notification-deliveries/:id/retry',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const { id } = z.object({ id: z.uuid() }).parse(request.params);
      return reply.code(202).send(await service.notifications.retry(id));
    },
  );
  app.get('/v1/incidents/:id', async (request) => {
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const { before } = z.object({ before: z.uuid().optional() }).parse(request.query);
    return service.incidentTimeline(id, before);
  });
  return app;
}
