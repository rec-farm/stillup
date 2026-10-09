import { useEffect, useState } from 'react';
import type { Dashboard } from '@stillup/core';
import { DashboardView } from '../components/dashboard';
export default function DashboardPage() {
  const [data, setData] = useState<Dashboard | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    fetch('/api/v1/dashboard', { signal: controller.signal })
      .then(async (response) => {
        if (response.status === 401) {
          window.location.replace('/login');
          return;
        }
        if (!response.ok) throw new Error('Unable to load monitoring data');
        setData(await response.json());
      })
      .catch(() => {
        if (!controller.signal.aborted) setError(true);
      });
    return () => controller.abort();
  }, []);
  if (data) return <DashboardView initial={data} />;
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
