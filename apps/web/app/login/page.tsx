import { serverApi } from '../../lib/api';
import { LoginForm } from './login-form';
export const dynamic = 'force-dynamic';

async function readAuthConfig() {
  try {
    const response = await serverApi('auth/config', false);
    const data = response.ok ? await response.json() : null;
    if (data?.oidc === true && typeof data.displayName === 'string')
      return { oidc: true, displayName: data.displayName as string };
  } catch {}
  return { oidc: false, displayName: '' };
}
// Keys the API's OIDC callback redirects back with; anything else is ignored.
const messages: Record<string, (name: string) => string> = {
  oidc_denied: (name) => `${name} did not let this sign-in through.`,
  oidc_expired: () => 'The sign-in took too long or started in another browser. Try again.',
  oidc_failed: (name) => `Signing in with ${name} did not complete. Try again.`,
  oidc_unavailable: (name) => `${name} cannot be reached right now. Try again shortly.`,
  oidc_disabled: () => 'Single sign-on is not set up on this installation.',
};
export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string | string[] }>;
}) {
  const [config, { error }] = await Promise.all([readAuthConfig(), searchParams]);
  const message = typeof error === 'string' ? messages[error] : undefined;
  return (
    <LoginForm
      oidc={config.oidc ? config.displayName : null}
      initialError={message?.(config.displayName || 'The identity provider') ?? ''}
    />
  );
}
