import type { Metadata } from 'next';
import './globals.css';
import './appearance.css';
import { readWorkspace } from '../lib/workspace';
import { WorkspaceProvider } from '../components/workspace-provider';
export const dynamic = 'force-dynamic';
export async function generateMetadata(): Promise<Metadata> {
  const { name } = await readWorkspace();
  return {
    title: { default: `${name} · API monitoring`, template: `%s · ${name}` },
    description: 'Open-source API monitoring. Know before your users do.',
    robots: { index: false, follow: false },
  };
}
export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const initial = await readWorkspace();
  return (
    <html lang="en">
      <body>
        <WorkspaceProvider initial={initial}>{children}</WorkspaceProvider>
      </body>
    </html>
  );
}
