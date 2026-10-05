import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import * as oidc from 'openid-client';
import { z } from 'zod';
import {
  checkSchema,
  editCheckSchema,
  revisionGuardSchema,
  probeReportSchema,
} from '@stillup/core';
import { codeConfigSchema } from '@stillup/core/code-config';
import { env } from './env';
import { oidcConfig, oidcEnabled, postLogoutRedirectUri, redirectUri } from './oidc';
import { flowLifetimeMs, openFlow, safeNext, sealFlow } from './oidc-state';
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
const secure = env.APP_ORIGIN.startsWith('https:');
const flowCookie = 'stillup_oidc_flow';
// Present only on sessions that came from OIDC: the ID token, kept as the end-session hint.
const idTokenCookie = 'stillup_oidc_idt';
function startSession(reply: FastifyReply, sameSite: 'strict' | 'lax') {
  const expires = String(Date.now() + 86400000);
  const options = { httpOnly: true, secure, path: '/', maxAge: 86400 };
  reply.setCookie('stillup_session', `${expires}.${sign(expires)}`, { ...options, sameSite });
  return options;
}
const loginError = (key: string) => new URL(`/login?error=${key}`, env.APP_ORIGIN).href;
const publicRoutes = new Set([
  'GET /v1/auth/config',
  'GET /v1/auth/oidc/start',
  'GET /v1/auth/oidc/callback',
  'POST /v1/session',
  'DELETE /v1/session',
]);
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
      (path === '/v1/public/workspace' && ['GET', 'HEAD'].includes(request.method)) ||
      publicRoutes.has(`${request.method === 'HEAD' ? 'GET' : request.method} ${path}`)
    )
      return;
    if (path?.startsWith('/v1/probe/')) return; // These routes authenticate scoped probe credentials below.
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
  const probeId = async (request: { headers: { authorization?: string } }) =>
    service.probes.authenticate(request.headers.authorization?.replace(/^Bearer /, '') ?? '');
  app.post(
    '/v1/probe/enroll',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (request) => {
      const body = z
        .object({
          enrollmentToken: z.string().regex(/^[a-f0-9]{64}$/),
          credential: z.string().regex(/^[a-f0-9]{64}$/),
          protocolVersion: z.literal(1),
        })
        .parse(request.body);
      return service.probes.enroll(body.enrollmentToken, body.credential);
    },
  );
  const probeRateLimit = {
    max: 600,
    timeWindow: '1 minute',
    keyGenerator: (request: FastifyRequest) =>
      createHash('sha256')
        .update(request.headers.authorization ?? request.ip)
        .digest('hex'),
  };
  app.post('/v1/probe/poll', { config: { rateLimit: probeRateLimit } }, async (request) => {
    z.object({ protocolVersion: z.literal(1) }).parse(request.body);
    return service.probes.claim(
      await probeId(request),
      request.headers.authorization?.replace(/^Bearer /, '') ?? '',
    );
  });
  app.post('/v1/probe/results', { config: { rateLimit: probeRateLimit } }, async (request) => {
    const id = await probeId(request);
    const body = z
      .object({
        protocolVersion: z.literal(1),
        jobId: z.uuid(),
        leaseToken: z.uuid(),
        result: probeReportSchema,
      })
      .parse(request.body);
    return service.probes.complete(
      id,
      body.jobId,
      body.leaseToken,
      body.result,
      request.headers.authorization?.replace(/^Bearer /, '') ?? '',
    );
  });
  app.get('/v1/locations', () => service.probes.list());
  app.post('/v1/locations', async (request, reply) =>
    reply.code(201).send(await service.probes.create(request.body)),
  );
  app.post('/v1/locations/:id/enrollment', async (request) =>
    service.probes.renew(z.object({ id: z.uuid() }).parse(request.params).id),
  );
  app.delete('/v1/locations/:id', async (request) =>
    service.probes.revoke(z.object({ id: z.uuid() }).parse(request.params).id),
  );
  app.get('/v1/checks/:id/locations', async (request) =>
    service.probes.observations(z.object({ id: z.uuid() }).parse(request.params).id),
  );
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
      startSession(reply, 'strict');
      reply.clearCookie(idTokenCookie, { path: '/' });
      return { ok: true };
    },
  );
  app.delete('/v1/session', async (request, reply) => {
    const idToken = request.cookies[idTokenCookie];
    reply.clearCookie('stillup_session', { path: '/' }).clearCookie(idTokenCookie, { path: '/' });
    if (!oidcEnabled || !idToken) return { ok: true };
    try {
      const logoutUrl = oidc.buildEndSessionUrl(await oidcConfig(), {
        id_token_hint: idToken,
        post_logout_redirect_uri: postLogoutRedirectUri,
      }).href;
      return { ok: true, logoutUrl };
    } catch (error) {
      request.log.warn(error, 'OIDC end-session URL unavailable');
      return { ok: true };
    }
  });
  const authLimit = { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } };
  app.get('/v1/auth/config', authLimit, () => ({
    oidc: oidcEnabled,
    displayName: env.OIDC_DISPLAY_NAME,
  }));
  app.get('/v1/auth/oidc/start', authLimit, async (request, reply) => {
    if (!oidcEnabled) return reply.redirect(loginError('oidc_disabled'));
    try {
      const config = await oidcConfig();
      const flow = {
        state: oidc.randomState(),
        nonce: oidc.randomNonce(),
        verifier: oidc.randomPKCECodeVerifier(),
        next: safeNext((request.query as { next?: unknown }).next),
        expires: Date.now() + flowLifetimeMs,
      };
      // Lax, not Strict: the callback arrives as a top-level navigation from the provider.
      reply.setCookie(flowCookie, sealFlow(flow, env.ADMIN_TOKEN), {
        httpOnly: true,
        sameSite: 'lax',
        secure,
        path: '/',
        maxAge: flowLifetimeMs / 1000,
      });
      const url = oidc.buildAuthorizationUrl(config, {
        redirect_uri: redirectUri,
        scope: env.OIDC_SCOPES,
        state: flow.state,
        nonce: flow.nonce,
        code_challenge: await oidc.calculatePKCECodeChallenge(flow.verifier),
        code_challenge_method: 'S256',
      });
      return reply.redirect(url.href);
    } catch (error) {
      request.log.error(error, 'OIDC discovery failed');
      return reply.redirect(loginError('oidc_unavailable'));
    }
  });
  app.get('/v1/auth/oidc/callback', authLimit, async (request, reply) => {
    const flow = openFlow(request.cookies[flowCookie], env.ADMIN_TOKEN);
    reply.clearCookie(flowCookie, { path: '/' });
    const query = new URLSearchParams(request.url.split('?')[1] ?? '');
    if (query.get('error'))
      return reply.redirect(
        loginError(query.get('error') === 'access_denied' ? 'oidc_denied' : 'oidc_failed'),
      );
    if (!oidcEnabled || !flow) return reply.redirect(loginError('oidc_expired'));
    try {
      const tokens = await oidc.authorizationCodeGrant(
        await oidcConfig(),
        new URL(`${redirectUri}?${query}`),
        {
          pkceCodeVerifier: flow.verifier,
          expectedState: flow.state,
          expectedNonce: flow.nonce,
          idTokenExpected: true,
        },
      );
      // Who may sign in is Handstamp's decision, so anyone it lets through is the administrator.
      // Lax so the redirect chain that started at the provider still carries the session.
      const options = startSession(reply, 'lax');
      if (tokens.id_token && tokens.id_token.length < 3800)
        reply.setCookie(idTokenCookie, tokens.id_token, { ...options, sameSite: 'strict' });
      else reply.clearCookie(idTokenCookie, { path: '/' });
      return reply.redirect(new URL(flow.next, env.APP_ORIGIN).href);
    } catch (error) {
      request.log.warn(error, 'OIDC sign-in failed');
      return reply.redirect(loginError('oidc_failed'));
    }
  });
  app.post('/v1/code/plan', async (request) =>
    service.code.plan(codeConfigSchema.parse(request.body)),
  );
  app.post('/v1/code/apply', async (request) => {
    const { config, token } = z
      .strictObject({ config: codeConfigSchema, token: z.string().regex(/^[a-f0-9]{64}$/) })
      .parse(request.body);
    return service.code.apply(config, token);
  });
  app.get('/v1/dashboard', async () => service.dashboard());
  app.get('/v1/public/status', async () => service.publicStatus());
  app.post(
    '/v1/checks/test',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (request) => service.testCheck(checkSchema.parse(request.body)),
  );
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
  app.get('/v1/secrets', () => service.secrets.overview());
  app.post('/v1/secrets', async (request, reply) =>
    reply.code(201).send(await service.secrets.save(request.body)),
  );
  app.put('/v1/secrets/:name', async (request) => {
    const { name } = z.object({ name: z.string() }).parse(request.params);
    return service.secrets.save(request.body, name);
  });
  app.get('/v1/public/workspace', async () => (await service.workspace.read()).settings);
  app.get('/v1/workspace', () => service.workspace.read());
  app.put('/v1/workspace', async (request) => {
    const { config, expectedRevision } = z
      .object({ config: z.unknown(), expectedRevision: z.number().int().min(0) })
      .parse(request.body);
    return service.workspace.save(config, expectedRevision);
  });
  app.get('/v1/status-management', () => service.statusManagement.admin());
  app.put('/v1/status-management/settings', async (request) => {
    const { config, expectedRevision } = z
      .object({ config: z.unknown(), expectedRevision: z.number().int().min(0) })
      .parse(request.body);
    return service.statusManagement.saveSettings(config, expectedRevision);
  });
  app.post('/v1/status-management/maintenance', async (request, reply) =>
    reply.code(201).send(await service.statusManagement.saveMaintenance(request.body)),
  );
  app.put('/v1/status-management/maintenance/:id', async (request) => {
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const { expectedRevision } = z
      .object({ expectedRevision: z.number().int().positive() })
      .parse(request.body);
    return service.statusManagement.saveMaintenance(request.body, id, expectedRevision);
  });
  app.post('/v1/status-management/incidents', async (request, reply) =>
    reply.code(201).send(await service.statusManagement.createIncident(request.body)),
  );
  app.post('/v1/status-management/incidents/:id/updates', async (request) => {
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    return service.statusManagement.updateIncident(id, request.body);
  });
  return app;
}
