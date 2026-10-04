'use client';
import { useState } from 'react';
import { ArrowRight, LogIn, ShieldCheck } from 'lucide-react';
import { useWorkspace } from '../../components/workspace-provider';
import { Brand } from '../../components/brand';
import { WatchfulArt } from '../../components/watchful-art';
/** `oidc` is the provider's display name when single sign-on is configured, else null. */
export function LoginForm({ oidc, initialError }: { oidc: string | null; initialError: string }) {
  const { settings } = useWorkspace();
  const [error, setError] = useState(initialError);
  const [busy, setBusy] = useState(false);
  async function login(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError('');
    const token = new FormData(event.currentTarget).get('token');
    try {
      const res = await fetch('/api/v1/session', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      window.location.assign('/');
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Unable to sign in');
      setBusy(false);
    }
  }
  return (
    <main className="login-page">
      <section className="login-story">
        <Brand workspace />
        <div>
          <span className="eyebrow">Open-source API monitoring</span>
          <h1>
            Good APIs deserve
            <br />a watchful eye<span className="period">.</span>
          </h1>
          <p>{settings.tagline || 'Know before your users do.'}</p>
          <WatchfulArt />
        </div>
        <span className="login-footer">Your infrastructure. Your data. Your peace of mind.</span>
      </section>
      <section className="login-panel">
        <form onSubmit={login}>
          <div className="icon-tile">
            <ShieldCheck size={24} />
          </div>
          <h2>Welcome to {settings.name}</h2>
          <p>Sign in to your monitoring workspace.</p>
          {oidc && (
            <>
              <a className="button primary wide" href="/api/v1/auth/oidc/start">
                Sign in with {oidc}
                <LogIn size={17} />
              </a>
              <p className="login-divider">or use the administrator token</p>
            </>
          )}
          <label htmlFor="token">Administrator token</label>
          <input
            id="token"
            name="token"
            type="password"
            autoComplete="current-password"
            placeholder="Enter your installation’s token"
            required
          />
          <p className="field-hint">Use the ADMIN_TOKEN from your installation’s .env file.</p>
          {error && (
            <p className="error-message" role="alert">
              {error}
            </p>
          )}
          <button className={`button wide ${oidc ? 'secondary' : 'primary'}`} disabled={busy}>
            {busy ? 'Signing in…' : 'Open workspace'}
            <ArrowRight size={17} />
          </button>
          <a className="subtle-link" href="/status">
            View public service status ↗
          </a>
        </form>
      </section>
    </main>
  );
}
