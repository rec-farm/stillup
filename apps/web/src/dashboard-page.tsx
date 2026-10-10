import { useEffect, useState } from 'react';
import type { Dashboard, Me } from '@stillup/core';
import { DashboardView } from '../components/dashboard';
export default function DashboardPage() {
  const [data, setData] = useState<{ dashboard: Dashboard; me: Me } | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    Promise.all(
      ['dashboard', 'me'].map((path) => fetch(`/api/v1/${path}`, { signal: controller.signal })),
    )
      .then(async ([dashboard, me]) => {
        if (dashboard!.status === 401 || me!.status === 401) {
          window.location.replace('/login');
          return;
        }
        if (!dashboard!.ok || !me!.ok) throw new Error('Unable to load monitoring data');
        setData({ dashboard: await dashboard!.json(), me: await me!.json() });
      })
      .catch(() => {
        if (!controller.signal.aborted) setError(true);
      });
    return () => controller.abort();
  }, []);
  if (data) return <DashboardView initial={data.dashboard} me={data.me} />;
  return (
    <main className="unavailable" role="status">
      <h1>{error ? 'StillUp is reconnecting.' : 'Loading your workspace…'}</h1>
      {error && (
        <>
          <p>The API service is unavailable. Please try again shortly.</p>
          <a href="/">Try again</a>
        </>
      )}
    </main>
  );
}
