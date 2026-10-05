import { lazy, Suspense, useEffect, useState, type ComponentType } from 'react';
import { createRoot } from 'react-dom/client';
import { defaultWorkspaceSettings, workspaceSettingsSchema } from '@stillup/core';
import { WorkspaceProvider } from '../components/workspace-provider';
import '../app/reciam.css';
import '../app/globals.css';
import '../app/status.css';

const Dashboard = lazy(() => import('./dashboard-page'));
const Login = lazy(() => import('./login-page'));
const Status = lazy(() => import('./status-page'));
const Docs = lazy(() => import('./docs-page'));

function App() {
  const [workspace, setWorkspace] = useState(defaultWorkspaceSettings);
  useEffect(() => {
    const controller = new AbortController();
    fetch('/api/v1/public/workspace', { credentials: 'omit', signal: controller.signal })
      .then(async (response) => {
        if (response.ok) setWorkspace(workspaceSettingsSchema.parse(await response.json()));
      })
      .catch(() => {});
    return () => controller.abort();
  }, []);
  const path =
    document.documentElement.dataset.page === 'status' ? '/status' : window.location.pathname;
  let Page: ComponentType;
  if (path === '/') Page = Dashboard;
  else if (path === '/login') Page = Login;
  else if (path === '/status') Page = Status;
  else if (path === '/docs' || path.startsWith('/docs/')) Page = Docs;
  else
    Page = () => (
      <main className="unavailable">
        <h1>Page not found.</h1>
        <a href="/">Return home</a>
      </main>
    );
  return (
    <WorkspaceProvider initial={workspace}>
      <Suspense
        fallback={
          <main className="unavailable" role="status">
            Loading StillUp…
          </main>
        }
      >
        <Page />
      </Suspense>
    </WorkspaceProvider>
  );
}
createRoot(document.getElementById('root')!).render(<App />);
