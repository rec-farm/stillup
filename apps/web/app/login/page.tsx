'use client';
import { useState } from 'react';
import { ArrowRight, ShieldCheck } from 'lucide-react';
import { useWorkspace } from '../../components/workspace-provider';
import { appearanceStyle } from '../../lib/appearance';
import { Brand } from '../../components/brand';
export default function LoginPage() {
  const { settings } = useWorkspace();
  const [error, setError] = useState('');
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
    <main className="login-page themed-workspace" style={appearanceStyle(settings)}>
      <section className="login-story">
        <Brand workspace />
        <div>
          <span className="eyebrow">OPEN-SOURCE API MONITORING</span>
          <h1>
            Good APIs deserve
            <br />a watchful eye.
          </h1>
          <p>{settings.tagline || 'Know before your users do.'}</p>
          <div className="signal-art" aria-hidden="true">
            <svg viewBox="0 0 480 170" fill="none">
              <path d="M0 90H480" stroke="currentColor" opacity=".12" />
              <path
                className="signal-line"
                d="M0 90H90L108 78L126 101L152 90H182L203 90L222 35L243 139L265 69L280 90H335L350 78L368 90H480"
                stroke="currentColor"
                strokeWidth="2.5"
                strokeLinejoin="round"
                strokeLinecap="round"
              />
              <circle cx="280" cy="90" r="6" fill="currentColor" />
              <circle cx="280" cy="90" r="15" stroke="currentColor" opacity=".25" />
            </svg>
          </div>
        </div>
        <span className="login-footer">Your infrastructure. Your data. Your peace of mind.</span>
      </section>
      <section className="login-panel">
        <form onSubmit={login}>
          <div className="icon-tile">
            <ShieldCheck size={25} />
          </div>
          <h2>Welcome to {settings.name}</h2>
          <p>Sign in to your monitoring workspace.</p>
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
          <button className="button primary wide" disabled={busy}>
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
