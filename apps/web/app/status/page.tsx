import type { Metadata } from 'next';
import type { PublicStatus } from '@stillup/core';
import { serverApi } from '../../lib/api';
import { Brand } from '../../components/brand';
import { StatusView } from '../../components/status-view';
export const metadata: Metadata = {
  title: 'Service status',
  robots: { index: true, follow: true },
};
export const dynamic = 'force-dynamic';
export default async function StatusPage() {
  let data: PublicStatus;
  try {
    const response = await serverApi('public/status', false);
    if (!response.ok) throw new Error();
    data = await response.json();
  } catch {
    return (
      <main className="status-page">
        <Brand />
        <section className="status-hero unknown">
          <h1>Status is temporarily unavailable</h1>
          <p>We cannot retrieve fresh observations. Please check again shortly.</p>
        </section>
      </main>
    );
  }
  return <StatusView initial={data} />;
}
