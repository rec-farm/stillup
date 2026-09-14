import { redirect } from 'next/navigation';
import { serverApi } from '../lib/api';
import { DashboardView } from '../components/dashboard';
import type { Dashboard } from '@stillup/core';
export const dynamic = 'force-dynamic';
export default async function Page() {
  let response: Response;
  try {
    response = await serverApi('dashboard');
  } catch {
    return (
      <main className="unavailable">
        <h1>StillUp is reconnecting</h1>
        <p>The API service is unavailable. Start the API and database, then reload this page.</p>
        <a href="/">Try again</a>
      </main>
    );
  }
  if (response.status === 401) redirect('/login');
  if (!response.ok) throw new Error('Unable to load monitoring data');
  return <DashboardView initial={(await response.json()) as Dashboard} />;
}
