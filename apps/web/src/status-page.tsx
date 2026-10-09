import { useEffect, useState } from 'react';
import type { PublicStatus } from '@stillup/core';
import { StatusView } from '../components/status-view';
import { Brand } from '../components/brand';
export default function StatusPage() {
  const [data, setData] = useState<PublicStatus | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    fetch('/api/v1/public/status', { credentials: 'omit', signal: controller.signal })
      .then(async (r) => {
        if (!r.ok) throw new Error('Status unavailable');
        const value: PublicStatus = await r.json();
        document.title = value.title;
        setData(value);
      })
      .catch(() => {
        if (!controller.signal.aborted) setError(true);
      });
    return () => controller.abort();
  }, []);
  if (data) return <StatusView initial={data} />;
  return (
    <div className="status-canvas" data-product="stillup">
      <main className="status-page">
        <header>
          <Brand />
        </header>
        <section className="status-hero unknown" role="status">
          <h1>{error ? 'Status is temporarily unavailable.' : 'Retrieving fresh observations…'}</h1>
          {error && (
            <p>We can’t retrieve fresh observations right now. Please check again shortly.</p>
          )}
        </section>
      </main>
    </div>
  );
}
