import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';

/** What the sign-in start hands to the callback, in a short-lived signed cookie. */
const flowSchema = z.object({
  state: z.string().min(1),
  nonce: z.string().min(1),
  verifier: z.string().min(43),
  next: z.string(),
  expires: z.number(),
});
export type OidcFlow = z.infer<typeof flowSchema>;
export const flowLifetimeMs = 10 * 60 * 1000;

const mac = (payload: string, secret: string) =>
  createHmac('sha256', secret).update(`oidc-flow:${payload}`).digest('base64url');

export function sealFlow(flow: OidcFlow, secret: string) {
  const payload = Buffer.from(JSON.stringify(flow)).toString('base64url');
  return `${payload}.${mac(payload, secret)}`;
}

export function openFlow(value: string | undefined, secret: string, now = Date.now()) {
  const [payload, signature, extra] = value?.split('.') ?? [];
  if (!payload || !signature || extra !== undefined) return null;
  const expected = Buffer.from(mac(payload, secret));
  const actual = Buffer.from(signature);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;
  try {
    const flow = flowSchema.parse(JSON.parse(Buffer.from(payload, 'base64url').toString()));
    return flow.expires > now ? flow : null;
  } catch {
    return null;
  }
}

/** Keeps `?next=` to a path on this app; anything else signs in to the dashboard. */
export function safeNext(next: unknown) {
  if (typeof next !== 'string' || !/^\/(?![/\\])/.test(next) || /[\u0000-\u001f\\]/.test(next))
    return '/';
  const base = 'http://app.invalid';
  const url = new URL(next, base);
  // Dot segments normalise away ("/.//evil.example" becomes "//evil.example"), so check again after.
  if (url.origin !== base || url.pathname.startsWith('//') || url.pathname.startsWith('/login'))
    return '/';
  return url.pathname + url.search + url.hash;
}
