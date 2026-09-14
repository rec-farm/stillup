import type { Metadata } from 'next';
import './globals.css';
export const metadata: Metadata = {
  title: { default: 'StillUp · API monitoring', template: '%s · StillUp' },
  description: 'Open-source API monitoring. Know before your users do.',
  robots: { index: false, follow: false },
};
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
