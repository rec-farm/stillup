import * as client from 'openid-client';
import { env } from './env';

export const oidcEnabled = Boolean(env.OIDC_ISSUER && env.OIDC_CLIENT_ID);
export const redirectUri = new URL('/api/v1/auth/oidc/callback', env.APP_ORIGIN).href;
export const postLogoutRedirectUri = new URL('/login', env.APP_ORIGIN).href;

let discovered: Promise<client.Configuration> | undefined;
/** Discovery is read once and kept; a failure is forgotten so the next sign-in retries it. */
export function oidcConfig() {
  const issuer = new URL(env.OIDC_ISSUER);
  // Plain HTTP is only for a provider on this machine, as in local development.
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(issuer.hostname);
  discovered ??= client
    .discovery(
      issuer,
      env.OIDC_CLIENT_ID,
      undefined,
      env.OIDC_CLIENT_SECRET ? client.ClientSecretBasic(env.OIDC_CLIENT_SECRET) : client.None(),
      {
        // Verify ID token signatures against the JWKS (refetched on an unknown kid), not only TLS.
        execute: [
          client.enableNonRepudiationChecks,
          ...(local && issuer.protocol === 'http:' ? [client.allowInsecureRequests] : []),
        ],
      },
    )
    .catch((error) => {
      discovered = undefined;
      throw error;
    });
  return discovered;
}
