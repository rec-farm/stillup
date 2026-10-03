import type { Metadata } from 'next';
import { cookies } from 'next/headers';
import './reciam.css';
import './globals.css';
import './status.css';
import { readWorkspace } from '../lib/workspace';
import { WorkspaceProvider } from '../components/workspace-provider';
import { parseThemeChoice, THEME_COOKIE, THEME_INIT_SCRIPT } from '../lib/theme';
export const dynamic = 'force-dynamic';
// Product name, not the workspace name (same as Paramtune). Public status pages set their own.
export const metadata: Metadata = {
  title: { default: 'StillUp · API monitoring', template: '%s · StillUp' },
  description: 'Open-source API monitoring. Know before your users do.',
  robots: { index: false, follow: false },
};
export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const initial = await readWorkspace();
  const choice = parseThemeChoice((await cookies()).get(THEME_COOKIE)?.value);
  // System renders Dark here; the init script swaps it before paint, hence suppressHydrationWarning.
  const theme = choice === 'light' ? 'light' : 'dark';
  return (
    <html lang="en" data-theme={theme} data-product="stillup" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
      </head>
      <body>
        <WorkspaceProvider initial={initial}>{children}</WorkspaceProvider>
      </body>
    </html>
  );
}
