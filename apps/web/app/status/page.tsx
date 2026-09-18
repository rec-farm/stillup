import type { Metadata } from 'next';
import { cache } from 'react';
import type { PublicStatus } from '@stillup/core';
import { serverApi } from '../../lib/api';
import { Brand } from '../../components/brand';
import { StatusView } from '../../components/status-view';
const readStatus = cache(async (): Promise<PublicStatus> => {
  const response = await serverApi('public/status', false);
  if (!response.ok) throw new Error('Status unavailable');
  return response.json();
});
export async function generateMetadata(): Promise<Metadata> {
  try {
    const data = await readStatus();
    return {
      title: { absolute: data.title },
      icons: data.branding?.faviconUrl ? { icon: data.branding.faviconUrl } : undefined,
      description: data.branding?.description,
      robots: { index: true, follow: true },
    };
  } catch {
    return { title: 'Service status', robots: { index: true, follow: true } };
  }
}
export const dynamic = 'force-dynamic';
export default async function StatusPage() {
  let data: PublicStatus;
  try {
    data = await readStatus();
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
