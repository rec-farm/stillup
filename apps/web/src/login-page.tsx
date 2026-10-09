import { useEffect, useState } from 'react';
import { LoginForm } from '../app/login/login-form';
const messages: Record<string, (name: string) => string> = {
  oidc_denied: (name) => `${name} did not let this sign-in through.`,
  oidc_expired: () => 'The sign-in took too long or started in another browser. Try again.',
  oidc_failed: (name) => `Signing in with ${name} did not complete. Try again.`,
  oidc_unavailable: (name) => `${name} cannot be reached right now. Try again shortly.`,
  oidc_disabled: () => 'Single sign-on is not set up on this installation.',
};
export default function LoginPage() {
  const [config, setConfig] = useState<{ oidc: boolean; displayName: string } | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    fetch('/api/v1/auth/config', { credentials: 'omit', signal: controller.signal })
      .then(async (r) => {
        const value = r.ok ? await r.json() : null;
        setConfig({
          oidc: value?.oidc === true,
          displayName: typeof value?.displayName === 'string' ? value.displayName : '',
        });
      })
      .catch(() => {
        if (!controller.signal.aborted) setConfig({ oidc: false, displayName: '' });
      });
    return () => controller.abort();
  }, []);
  if (!config)
    return (
      <main className="unavailable" role="status">
        Loading sign-in…
      </main>
    );
  const error = new URLSearchParams(window.location.search).get('error') ?? '';
  return (
    <LoginForm
      oidc={config.oidc ? config.displayName : null}
      initialError={messages[error]?.(config.displayName || 'The identity provider') ?? ''}
    />
  );
}
