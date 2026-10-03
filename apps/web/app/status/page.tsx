import type { Metadata, Viewport } from 'next';
import { cache } from 'react';
import { CircleHelp } from 'lucide-react';
import { statusPalettes, type PublicStatus } from '@stillup/core';
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
    const brand = data.branding;
    return {
      title: { absolute: data.title },
      icons: brand?.faviconUrl ? { icon: brand.faviconUrl } : undefined,
      description: brand?.description || undefined,
      openGraph: {
        type: 'website',
        title: data.title,
        description: brand?.description || undefined,
        siteName: brand?.brandName,
        images: brand?.logoUrl ? [{ url: brand.logoUrl, alt: brand.brandName }] : undefined,
      },
      robots: { index: true, follow: true },
    };
  } catch {
    return { title: 'Service status', robots: { index: true, follow: true } };
  }
}
// Browser chrome matches the page background the visitor will see.
export async function generateViewport(): Promise<Viewport> {
  try {
    const brand = (await readStatus()).branding;
    if (!brand) return {};
    const palettes = statusPalettes(brand);
    return {
      themeColor:
        brand.theme === 'auto'
          ? [
              { media: '(prefers-color-scheme: light)', color: palettes.light.background },
              { media: '(prefers-color-scheme: dark)', color: palettes.dark.background },
            ]
          : palettes[brand.theme].background,
    };
  } catch {
    return {};
  }
}
export const dynamic = 'force-dynamic';
export default async function StatusPage() {
  let data: PublicStatus;
  try {
    data = await readStatus();
  } catch {
    return (
      <div className="status-canvas" data-product="stillup">
        <main className="status-page">
          <header>
            <Brand />
          </header>
          <section className="status-hero unknown">
            <div className="status-symbol">
              <CircleHelp size={24} strokeWidth={1.5} aria-hidden="true" />
            </div>
            <h1>
              Status is temporarily unavailable<span className="period">.</span>
            </h1>
            <p>We can’t retrieve fresh observations right now. Please check again shortly.</p>
          </section>
        </main>
      </div>
    );
  }
  return <StatusView initial={data} />;
}
