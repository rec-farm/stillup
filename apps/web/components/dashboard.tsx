'use client';
import { useCallback, useEffect, useState, useRef } from 'react';
import {
  Activity,
  Archive,
  Pencil,
  Palette,
  RotateCcw,
  ArrowDownRight,
  ArrowUpRight,
  ArrowRight,
  Check,
  CircleHelp,
  Clock3,
  ExternalLink,
  Globe2,
  LayoutDashboard,
  LogOut,
  Pause,
  Play,
  Plus,
  Radio,
  Search,
  Server,
  ShieldCheck,
  Terminal,
  X,
} from 'lucide-react';
import {
  formatUptime,
  type Dashboard,
  type Health,
  type Monitor,
  type Run,
  type Uptime,
} from '@stillup/core';
import { useWorkspace } from './workspace-provider';
import { Brand } from './brand';
import { Illustration, WatchfulArt } from './watchful-art';
import { UserMenu } from './user-menu';
import { CheckForm } from './check-form';
import { ConfigurationHistory, RevisionViewer } from './configuration-history';
import { NotificationDialog, IncidentDialog } from './notifications';
import { SecretsDialog } from './secrets';
import { LocationsDialog, RegionalResults } from './locations';
import { StatusManagementDialog } from './status-management';
import { UptimeBars } from './status-view';
const labels: Record<Health, string> = {
  up: 'Healthy',
  down: 'Failing',
  unknown: 'Awaiting data',
  paused: 'Paused',
  archived: 'Archived',
};
export function HealthBadge({ health }: { health: Health }) {
  return (
    <span className={`health-badge ${health}`}>
      <span />
      {labels[health]}
    </span>
  );
}
function time(value: string | null) {
  return value
    ? new Date(value).toLocaleString('en-GB', {
        timeZone: 'UTC',
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      }) + ' UTC'
    : 'Not yet checked';
}
async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api/v1/${path}`, init);
  if (res.status === 401) {
    window.location.assign('/login');
    throw new Error('Session expired');
  }
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}
export function DashboardView({ initial }: { initial: Dashboard }) {
  const { settings } = useWorkspace();
  const [data, setData] = useState(initial);
  const [create, setCreate] = useState(false);
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const [secretsOpen, setSecretsOpen] = useState(false);
  const [statusEditorOpen, setStatusEditorOpen] = useState(false);
  const [incidentId, setIncidentId] = useState<string | null>(null);
  const [editing, setEditing] = useState<Monitor | null>(null);
  const [viewRevision, setViewRevision] = useState<{ monitorId: string; revision: number } | null>(
    null,
  );
  const [actionError, setActionError] = useState('');
  const refreshSequence = useRef(0);
  const [locationsOpen, setLocationsOpen] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('all');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [setupOpen, setSetupOpen] = useState(initial.monitors.length <= 1);
  useEffect(() => {
    try {
      if (localStorage.getItem('stillup:setup-dismissed') === 'true') setSetupOpen(false);
    } catch {
      // Setup remains usable when browser storage is unavailable.
    }
  }, []);
  function toggleSetup(open: boolean) {
    setSetupOpen(open);
    try {
      localStorage.setItem('stillup:setup-dismissed', String(!open));
    } catch {
      // Keep the preference for this visit even without persistent storage.
    }
  }
  const refresh = useCallback(async () => {
    const sequence = ++refreshSequence.current;
    try {
      const next = await api<Dashboard>('dashboard');
      if (sequence !== refreshSequence.current) return;
      setData(next);
      setError('');
    } catch (e) {
      if (sequence === refreshSequence.current)
        setError(e instanceof Error ? e.message : 'Could not refresh');
    }
  }, []);
  useEffect(() => {
    const timer = setInterval(() => void refresh(), 10000);
    return () => clearInterval(timer);
  }, [refresh]);
  const activeMonitors = data.monitors.filter((m) => !m.archivedAt);
  const counts = {
    up: data.monitors.filter((m) => m.health === 'up').length,
    down: data.monitors.filter((m) => m.health === 'down').length,
    unknown: data.monitors.filter((m) => m.health === 'unknown').length,
  };
  const workerOnline = !!data.workerAt && Date.now() - Date.parse(data.workerAt) < 30000;
  const visible = data.monitors.filter(
    (m) =>
      (filter === 'archived'
        ? !!m.archivedAt
        : !m.archivedAt && (filter === 'all' || m.health === filter)) &&
      `${m.config.name} ${m.config.url}`.toLowerCase().includes(query.toLowerCase()),
  );
  const current = data.monitors.find((m) => m.id === selected);
  const firstCheck = activeMonitors[0];
  const observedCheck = activeMonitors.find((m) => m.lastObservedAt !== null);
  const setupProgress =
    Number(!!firstCheck) + Number(!!observedCheck) + Number(data.notificationsEnabled);
  async function action(monitor: Monitor, kind: 'run' | 'toggle' | 'archive' | 'restore') {
    setBusy(true);
    setNotice('');
    setActionError('');
    try {
      if (kind === 'run') {
        const result = await api<{ message: string }>(`checks/${monitor.id}/run`, {
          method: 'POST',
        });
        setNotice(result.message);
      } else if (kind === 'archive' || kind === 'restore') {
        await api(`checks/${monitor.id}/${kind}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ expectedRevision: monitor.configRevision }),
        });
        setFilter(kind === 'archive' ? 'archived' : 'all');
        setNotice(
          kind === 'archive'
            ? 'Check archived. Its results and configuration history are preserved.'
            : 'Check restored in a paused state. Resume it when you are ready.',
        );
      } else {
        await api(`checks/${monitor.id}`, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            enabled: !monitor.enabled,
            expectedRevision: monitor.configRevision,
          }),
        });
        setNotice(monitor.enabled ? 'Check paused' : 'Check resumed');
      }
      await refresh();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : 'Action failed');
    } finally {
      setBusy(false);
    }
  }
  async function signOut() {
    try {
      const { logoutUrl } = await api<{ logoutUrl?: string }>('session', { method: 'DELETE' });
      // Sessions from single sign-on also end at the provider, which then returns to /login.
      window.location.assign(logoutUrl ?? '/login');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Sign out failed');
    }
  }
  return (
    <div className="app-shell" data-density={settings.density}>
      <aside className="sidebar">
        {/* Product wordmark top-left (BRAND §2); the workspace's own identity lives in the card below. */}
        <a className="brand-link" href="/" aria-label="StillUp home">
          <Brand />
        </a>
        <div className="workspace">
          <span className="workspace-avatar">
            {settings.logoUrl ? (
              <img src={settings.logoUrl} width={32} height={32} alt="" />
            ) : (
              settings.name.slice(0, 1).toUpperCase()
            )}
          </span>
          <div>
            <strong>{settings.name === 'StillUp' ? 'My workspace' : settings.name}</strong>
            <small>Self-hosted installation</small>
          </div>
          <ShieldCheck size={16} />
        </div>
        <span className="nav-label eyebrow">Workspace</span>
        <nav>
          <a href="/" className="nav-item active" aria-current="page">
            <LayoutDashboard size={20} />
            Overview
          </a>
          <a href="#checks" className="nav-item">
            <Activity size={20} />
            API checks<span className="nav-count">{activeMonitors.length}</span>
          </a>
          <button className="nav-item" onClick={() => toggleSetup(true)}>
            <Check size={20} />
            Getting started
          </button>
          <a href="#incidents" className="nav-item">
            <Radio size={20} />
            Incidents
          </a>
          <a href="/status" target="_blank" rel="noreferrer" className="nav-item">
            <Globe2 size={20} />
            Public status
            <ExternalLink size={13} />
          </a>
          <a href="/docs" className="nav-item">
            <CircleHelp size={20} />
            Documentation
          </a>
        </nav>
        <button className="nav-item status-design-nav" onClick={() => setStatusEditorOpen(true)}>
          <Palette size={20} /> Status page design
        </button>
        <div className="sidebar-bottom">
          <div className="ownership-note">
            <Terminal size={18} />
            <strong>Built to be yours.</strong>
            <p>
              Open source. Self hosted.
              <br />
              Always looking out.
            </p>
          </div>
          <button className="nav-item signout" onClick={signOut}>
            <LogOut size={20} />
            Sign out
          </button>
          {/* Endorsement (BRAND §2): Product vX.Y.Z · by REC, the chain at 8px cap height */}
          <div className="version">
            <span>
              StillUp <span className="mono">v0.1.0</span> · by
            </span>
            <img
              className="rec-chain"
              src="/brand/rec-mark-cream.svg"
              width={28}
              height={28}
              alt="R.E.C."
            />
          </div>
        </div>
      </aside>
      <div className="main-area">
        <header className="topbar">
          <div className="breadcrumbs">
            Workspace<span>/</span>
            <strong>Overview</strong>
          </div>
          <div className="topbar-actions">
            <a className="label-stamp" href="/status" target="_blank" rel="noreferrer">
              Status page
              <ArrowUpRight size={16} />
            </a>
            <UserMenu onSignOut={signOut} />
          </div>
        </header>
        <main className="dashboard-main">
          <div className="page-heading">
            <div>
              <div className="eyebrow">Your APIs, at a glance</div>
              <h1>
                Overview<span className="period">.</span>
              </h1>
              <p>{settings.tagline}</p>
            </div>
            <WatchfulArt />
            {/* The empty state carries the one primary action until the first check exists. */}
            <button
              className={`button ${activeMonitors.length ? 'primary' : 'secondary'}`}
              onClick={() => setCreate(true)}
            >
              <Plus size={16} />
              Create check
            </button>
          </div>
          {error && (
            <div className="error-message" role="alert">
              {error}
            </div>
          )}
          {notice && (
            <div className="notice" role="status">
              <Check size={16} />
              {notice}
              <button
                className="icon-button"
                aria-label="Dismiss notification"
                onClick={() => setNotice('')}
              >
                <X size={14} />
              </button>
            </div>
          )}
          {setupOpen && (
            <section className="setup-guide" aria-labelledby="setup-title">
              <div className="setup-heading">
                <div>
                  <span className="eyebrow">Getting started · {setupProgress} of 3 complete</span>
                  <h2 id="setup-title">
                    {setupProgress === 3
                      ? 'You’re ready to keep watch.'
                      : 'From your first check to your first alert.'}
                  </h2>
                  <p>
                    Start with an endpoint you own. We’ll help you check it, see a result, and
                    connect alerts.
                  </p>
                </div>
                <button
                  className="icon-button"
                  aria-label="Dismiss getting started guide"
                  onClick={() => toggleSetup(false)}
                >
                  <X size={18} />
                </button>
              </div>
              <ol className="setup-steps">
                <li data-complete={!!firstCheck}>
                  <span className="setup-number" aria-label={firstCheck ? 'Complete' : 'Step 1'}>
                    {firstCheck ? <Check size={18} /> : '01'}
                  </span>
                  <h3>Create your first check</h3>
                  <p>
                    A health endpoint is a good start. Use GET and expect HTTP 200; you can add
                    assertions later.
                  </p>
                  <button
                    className={`button ${firstCheck ? 'secondary' : 'primary'}`}
                    onClick={() => (firstCheck ? setSelected(firstCheck.id) : setCreate(true))}
                  >
                    {firstCheck ? 'View your check' : 'Create first check'}
                    <ArrowRight size={16} />
                  </button>
                </li>
                <li data-complete={!!observedCheck}>
                  <span className="setup-number" aria-label={observedCheck ? 'Complete' : 'Step 2'}>
                    {observedCheck ? <Check size={18} /> : '02'}
                  </span>
                  <h3>See your first result</h3>
                  <p>
                    {observedCheck
                      ? 'Your endpoint has returned a result. Open the check to review its health and response time.'
                      : !workerOnline
                        ? 'Your monitoring worker is offline. Start it so saved checks can run on schedule.'
                        : firstCheck
                          ? 'Your check is waiting for an observation. Results refresh here automatically every 10 seconds.'
                          : 'After saving, the worker runs your check on schedule. You can also request a run from its details.'}
                  </p>
                  {observedCheck || (firstCheck && workerOnline) ? (
                    <button
                      className="button secondary"
                      onClick={() => setSelected((observedCheck ?? firstCheck)!.id)}
                    >
                      View results
                      <ArrowRight size={16} />
                    </button>
                  ) : (
                    <a className="button secondary" href="/docs/self-hosting">
                      Worker setup
                      <ArrowRight size={16} />
                    </a>
                  )}
                </li>
                <li data-complete={data.notificationsEnabled}>
                  <span
                    className="setup-number"
                    aria-label={data.notificationsEnabled ? 'Complete' : 'Step 3'}
                  >
                    {data.notificationsEnabled ? <Check size={18} /> : '03'}
                  </span>
                  <h3>Connect incident alerts</h3>
                  <p>
                    {data.notificationsEnabled
                      ? 'Notifications are configured. Send a test from channel settings to verify delivery.'
                      : 'Add a notification channel for failures and recoveries, then send a test to verify delivery.'}
                  </p>
                  <button className="button secondary" onClick={() => setNotificationsOpen(true)}>
                    {data.notificationsEnabled ? 'Review notifications' : 'Set up notifications'}
                    <ArrowRight size={16} />
                  </button>
                </li>
              </ol>
              <div className="setup-footer">
                <a href="/docs/getting-started">
                  Read the getting started guide <ArrowUpRight size={14} />
                </a>
                <span>
                  Optional: share selected checks on your{' '}
                  <button onClick={() => setStatusEditorOpen(true)}>public status page</button>.
                </span>
              </div>
            </section>
          )}
          <section
            className={`overview-banner ${counts.down ? 'attention' : !workerOnline || !counts.up ? 'neutral' : ''}`}
          >
            <div className="banner-icon">
              {counts.down ? (
                <Radio size={20} />
              ) : counts.up > 0 && counts.unknown === 0 && workerOnline ? (
                <ShieldCheck size={20} />
              ) : (
                <Activity size={20} />
              )}
            </div>
            <div>
              <h2>
                {counts.down
                  ? `${counts.down} ${counts.down === 1 ? 'API needs' : 'APIs need'} your attention`
                  : !activeMonitors.length
                    ? 'Your next layer of confidence starts here'
                    : !workerOnline
                      ? 'Waiting for your monitoring worker'
                      : counts.unknown
                        ? 'Getting to know your APIs'
                        : counts.up === 0
                          ? 'Your checks are paused'
                          : 'Your monitored APIs are looking good'}
              </h2>
              <p>
                {counts.down
                  ? 'Review the latest failures and active incidents below.'
                  : !activeMonitors.length
                    ? 'Add an endpoint. Set your expectations. We’ll take it from there.'
                    : !workerOnline
                      ? 'Observations become unknown when they are no longer fresh.'
                      : counts.unknown
                        ? 'Checks without recent observations stay unknown until a result arrives.'
                        : counts.up === 0
                          ? 'Resume a check to start receiving fresh observations.'
                          : 'We’ll keep checking, so you can keep building.'}
              </p>
            </div>
            <span className={`worker-indicator ${workerOnline ? 'online' : ''}`}>
              <span />
              {workerOnline ? 'Worker online' : 'Worker offline'}
            </span>
          </section>
          <section className="metrics" aria-label="Monitoring summary">
            <Metric
              label="Total checks"
              value={activeMonitors.length}
              icon={<Activity size={18} />}
              detail="HTTP & API endpoints"
            />
            <Metric
              label="Healthy"
              value={counts.up}
              icon={<ArrowUpRight size={18} />}
              detail="Passing your expectations"
              tone={counts.up ? 'success' : ''}
            />
            <Metric
              label="Failing"
              value={counts.down}
              icon={<ArrowDownRight size={18} />}
              detail="Confirmed check failures"
              tone={counts.down ? 'danger' : ''}
            />
            <Metric
              label="Awaiting data"
              value={counts.unknown}
              icon={<Clock3 size={18} />}
              detail="Pending or stale observations"
              tone={counts.unknown ? 'info' : ''}
            />
          </section>
          <section className="checks-section" id="checks">
            <div className="section-heading">
              <div>
                <h2>
                  API checks <span className="count-pill">{activeMonitors.length}</span>
                </h2>
                <p>Your endpoints, under a watchful eye.</p>
              </div>
              <span className="refresh-note">
                <span className="tiny-dot" />
                Refreshes every 10s
              </span>
            </div>
            <div className="table-toolbar">
              <div className="filter-tabs" role="group" aria-label="Filter checks">
                {[
                  ['all', 'All checks'],
                  ['up', 'Healthy'],
                  ['down', 'Failing'],
                  ['unknown', 'Awaiting data'],
                  ['paused', 'Paused'],
                  ['archived', `Archived (${data.monitors.length - activeMonitors.length})`],
                ].map(([value, label]) => (
                  <button
                    key={value}
                    className={filter === value ? 'selected' : ''}
                    onClick={() => setFilter(value!)}
                    aria-pressed={filter === value}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <label className="search-box">
                <Search size={16} />
                <input
                  aria-label="Search checks"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Find a check…"
                />
              </label>
            </div>
            {data.monitors.length === 0 && filter === 'all' && !query ? (
              <div className="empty-state">
                <div className="empty-illustration bg-dot-grid">
                  <Illustration
                    name="empty-state-stillup"
                    className="empty-art"
                    width={200}
                    height={120}
                  />
                </div>
                <h3>
                  Meet your first API check<span className="period">.</span>
                </h3>
                <p>
                  Add a health endpoint you own. StillUp will check its response on a schedule and
                  keep a history of failures and recoveries.
                </p>
                <button className="button primary" onClick={() => setCreate(true)}>
                  <Plus size={16} />
                  Create your first check
                </button>
                <span className="empty-footnote">
                  Start with a name and URL · GET · HTTP 200 · Every minute
                </span>
              </div>
            ) : visible.length === 0 ? (
              <div className="empty-state compact">
                <Search size={24} />
                <h3>
                  {filter === 'archived' && !query ? 'No archived checks' : 'No matching checks'}
                </h3>
                <p>
                  {filter === 'archived' && !query
                    ? 'Checks you archive will appear here with their history.'
                    : 'Try another name or status filter.'}
                </p>
                {(query || filter !== 'all') && (
                  <button
                    className="button secondary"
                    onClick={() => {
                      setQuery('');
                      setFilter('all');
                    }}
                  >
                    Clear filters
                  </button>
                )}
              </div>
            ) : (
              <div className="table-scroll">
                <table className="checks-table">
                  <thead>
                    <tr>
                      <th>Check / endpoint</th>
                      <th>Status</th>
                      <th>Uptime (30d)</th>
                      <th>Response</th>
                      <th>Interval</th>
                      <th>Last run</th>
                      <th>
                        <span className="sr-only">Details</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {visible.map((m) => (
                      <tr key={m.id} className={selected === m.id ? 'selected-row' : ''}>
                        <td>
                          <button className="check-name" onClick={() => setSelected(m.id)}>
                            <span className="check-icon">
                              <Activity size={18} />
                            </span>
                            <span>
                              <strong>{m.config.name}</strong>
                              <small>
                                <span className="method">{m.config.method}</span>
                                {m.config.url}
                              </small>
                            </span>
                          </button>
                        </td>
                        <td>
                          <HealthBadge health={m.health} />
                        </td>
                        <td className="mono">
                          {m.uptime30d == null ? '—' : formatUptime(m.uptime30d)}
                        </td>
                        <td className="mono">
                          {m.lastDurationMs === null ? '—' : `${m.lastDurationMs} ms`}
                        </td>
                        <td className="mono">
                          {m.config.intervalSeconds < 60
                            ? `${m.config.intervalSeconds}s`
                            : `${m.config.intervalSeconds / 60}m`}
                        </td>
                        <td className="mono muted">{time(m.lastRunAt)}</td>
                        <td>
                          <button
                            className="icon-button"
                            aria-label={`View ${m.config.name} details`}
                            onClick={() => setSelected(m.id)}
                          >
                            <ArrowRight size={17} />
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
          <div className="bottom-grid">
            <section className="incident-section" id="incidents">
              <div className="section-heading">
                <h2>Recent incidents</h2>
                <Radio size={17} />
              </div>
              {data.incidents.length ? (
                <div className="incident-list">
                  {data.incidents.slice(0, 8).map((i) => (
                    <div className="incident" key={i.id}>
                      <span className={`incident-dot ${i.resolvedAt ? 'resolved' : ''}`} />
                      <div>
                        <button className="revision-link" onClick={() => setIncidentId(i.id)}>
                          {i.name}
                        </button>
                        <small>{time(i.openedAt)}</small>
                      </div>
                      <span className={`incident-state ${i.resolvedAt ? 'resolved' : ''}`}>
                        {i.resolvedAt
                          ? 'Resolved'
                          : data.monitors.find((m) => m.id === i.monitorId)?.archivedAt
                            ? 'Archived'
                            : 'Investigating'}
                      </span>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="incident-empty">
                  <span className="soft-icon">
                    <ShieldCheck size={23} />
                  </span>
                  <div>
                    <h3>No incidents to report</h3>
                    <p>Confirmed failures and recoveries will appear here.</p>
                  </div>
                </div>
              )}
            </section>
            <section className="setup-note">
              <div className="section-heading">
                <h2>Connected & configured</h2>
                <Server size={17} />
              </div>
              <div>
                <span className={`connection-dot ${workerOnline ? 'connected' : ''}`} />
                <strong>HTTP worker</strong>
                <span>{workerOnline ? 'Connected' : 'Offline'}</span>
              </div>
              <div>
                <span
                  className={`connection-dot ${data.notificationsEnabled ? 'connected' : ''}`}
                />
                <strong>Webhook alerts</strong>
                <span>{data.notificationsEnabled ? 'Configured' : 'Not configured'}</span>
              </div>
              <p>
                <CircleHelp size={14} />
                Receive incident and recovery events through your notification channels.
              </p>
              <button className="button secondary" onClick={() => setNotificationsOpen(true)}>
                Manage notifications
              </button>
              <div className="notification-actions">
                <button className="button secondary" onClick={() => setSecretsOpen(true)}>
                  Manage secrets
                </button>
                <button className="button secondary" onClick={() => setLocationsOpen(true)}>
                  Manage locations
                </button>
                <button className="button secondary" onClick={() => setStatusEditorOpen(true)}>
                  Customize status page
                </button>
              </div>
            </section>
          </div>
          <footer className="dashboard-footer">
            <span>Know before your users do.</span>
            <span>Made for APIs. Built in the open.</span>
          </footer>
        </main>
      </div>
      {locationsOpen && <LocationsDialog onClose={() => setLocationsOpen(false)} />}
      {secretsOpen && <SecretsDialog onClose={() => setSecretsOpen(false)} />}
      {statusEditorOpen && (
        <StatusManagementDialog
          monitors={data.monitors}
          onClose={() => setStatusEditorOpen(false)}
        />
      )}
      {notificationsOpen && (
        <NotificationDialog
          onClose={() => setNotificationsOpen(false)}
          onChanged={() => void refresh()}
        />
      )}
      {incidentId && (
        <IncidentDialog
          key={incidentId}
          id={incidentId}
          onClose={() => setIncidentId(null)}
          onRevision={(monitorId, revision) => setViewRevision({ monitorId, revision })}
        />
      )}
      {(create || editing) && (
        <CheckForm
          key={editing ? `${editing.id}:${editing.configRevision}` : 'create'}
          monitor={editing ?? undefined}
          onClose={() => {
            setCreate(false);
            setEditing(null);
          }}
          onSaved={(m) => {
            refreshSequence.current++;
            setNotice(
              editing
                ? `Saved revision ${m.configRevision}. Earlier results are preserved.`
                : 'Check created. Its first run will start shortly.',
            );
            setCreate(false);
            setEditing(null);
            setActionError('');
            setSelected(m.id);
            setFilter('all');
            setData((d) => ({
              ...d,
              monitors: [m, ...d.monitors.filter((existing) => existing.id !== m.id)],
            }));
            void refresh();
          }}
        />
      )}
      {viewRevision && (
        <RevisionViewer
          key={`${viewRevision.monitorId}:${viewRevision.revision}`}
          {...viewRevision}
          onClose={() => setViewRevision(null)}
        />
      )}
      {current && (
        <CheckDetail
          monitor={current}
          key={current.id}
          onClose={() => {
            setSelected(null);
            setActionError('');
          }}
          onEdit={() => {
            setBusy(true);
            setActionError('');
            void api<Monitor>(`checks/${current.id}`)
              .then((latest) => {
                if (latest.archivedAt)
                  throw new Error('This check was archived. Restore it before editing.');
                setEditing(latest);
              })
              .catch((e) =>
                setActionError(e instanceof Error ? e.message : 'Could not open editor'),
              )
              .finally(() => setBusy(false));
          }}
          onRevision={(revision) => setViewRevision({ monitorId: current.id, revision })}
          actionError={actionError}
          onAction={(kind) => void action(current, kind)}
          busy={busy}
        />
      )}
    </div>
  );
}
function Metric({
  label,
  value,
  icon,
  detail,
  tone = '',
}: {
  label: string;
  value: number;
  icon: React.ReactNode;
  detail: string;
  tone?: string;
}) {
  return (
    <article className={`metric ${tone}`}>
      <div>
        <span>{label}</span>
        {icon}
      </div>
      <strong>{value}</strong>
      <p>{detail}</p>
    </article>
  );
}
function CheckDetail({
  monitor,
  onClose,
  onAction,
  onEdit,
  onRevision,
  actionError,
  busy,
}: {
  monitor: Monitor;
  onClose: () => void;
  onAction: (kind: 'run' | 'toggle' | 'archive' | 'restore') => void;
  onEdit: () => void;
  onRevision: (revision: number) => void;
  actionError: string;
  busy: boolean;
}) {
  const [runs, setRuns] = useState<Run[]>([]);
  const [uptime, setUptime] = useState<Uptime | null>(null);
  const [tab, setTab] = useState<'runs' | 'history'>('runs');
  const [confirmArchive, setConfirmArchive] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let active = true;
    const load = async () => {
      try {
        const [rows, daily] = await Promise.all([
          api<Run[]>(`checks/${monitor.id}/runs`),
          api<Uptime>(`checks/${monitor.id}/uptime`),
        ]);
        if (active) {
          setRuns(rows);
          setUptime(daily);
          setError('');
        }
      } catch (e) {
        if (active) setError(e instanceof Error ? e.message : 'Could not load runs');
      } finally {
        if (active) setLoading(false);
      }
    };
    setRuns([]);
    setUptime(null);
    setLoading(true);
    void load();
    const timer = setInterval(() => void load(), 5000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [monitor.id]);
  useEffect(() => {
    const listener = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !document.querySelector('dialog[open]')) onClose();
    };
    window.addEventListener('keydown', listener);
    return () => window.removeEventListener('keydown', listener);
  }, [onClose]);
  return (
    <aside className="detail-panel" aria-label={`${monitor.config.name} details`}>
      <header>
        <span className="eyebrow">Check details</span>
        <button className="icon-button" onClick={onClose} aria-label="Close check details">
          <X size={20} />
        </button>
      </header>
      <h2>{monitor.config.name}</h2>
      <HealthBadge health={monitor.health} />
      {monitor.codeOwnership && (
        <div className="archive-note">
          <strong>Managed as code</strong>
          <p>
            Project {monitor.codeOwnership.project} · Check {monitor.codeOwnership.id}. Edit the
            project file and apply it with the CLI. Pausing and archiving remain available here.
          </p>
          <a href="/docs/monitoring-as-code#ownership" className="text-link">
            How code ownership works ↗
          </a>
        </div>
      )}
      <RegionalResults monitor={monitor} />
      {uptime && (
        <section className="detail-section detail-uptime" aria-label="Uptime history">
          <h3>Uptime</h3>
          <UptimeBars uptime={uptime} now={new Date().toISOString()} />
        </section>
      )}
      <p className="detail-url">
        <span className="method">{monitor.config.method}</span>
        {monitor.config.url}
      </p>
      {monitor.archivedAt ? (
        <div className="archive-note">
          <p>
            Archived {time(monitor.archivedAt)}. Results and configurations remain available. Open
            incidents are preserved; archiving does not signal recovery.
          </p>
          <button className="button secondary" disabled={busy} onClick={() => onAction('restore')}>
            <RotateCcw size={14} />
            Restore check
          </button>
          <small>Restores paused. Public visibility follows the saved configuration.</small>
        </div>
      ) : (
        <>
          <div className="detail-actions">
            <button
              className="button primary"
              disabled={busy || !monitor.enabled}
              onClick={() => onAction('run')}
            >
              <Play size={14} />
              Run now
            </button>
            <button className="button secondary" disabled={busy} onClick={() => onAction('toggle')}>
              {monitor.enabled ? <Pause size={14} /> : <Play size={14} />}{' '}
              {monitor.enabled ? 'Pause' : 'Resume'}
            </button>
            {!monitor.codeOwnership && (
              <button className="button secondary" disabled={busy} onClick={onEdit}>
                <Pencil size={14} />
                Edit check
              </button>
            )}
          </div>
          {confirmArchive ? (
            <div className="archive-note">
              <p>
                Archive {monitor.config.name}? This stops future checks and removes it from public
                status. All history is kept. An in-flight request may finish before archiving takes
                effect.
              </p>
              <div className="detail-actions">
                <button
                  className="button secondary"
                  disabled={busy}
                  onClick={() => setConfirmArchive(false)}
                >
                  Cancel
                </button>
                <button
                  className="button secondary"
                  disabled={busy}
                  onClick={() => {
                    onAction('archive');
                    setConfirmArchive(false);
                  }}
                >
                  Archive check
                </button>
              </div>
            </div>
          ) : (
            <button
              className="archive-link"
              disabled={busy}
              onClick={() => setConfirmArchive(true)}
            >
              <Archive size={14} />
              Archive check
            </button>
          )}
        </>
      )}
      {actionError && (
        <p className="error-message" role="alert">
          {actionError}
        </p>
      )}
      <dl className="check-config">
        <div>
          <dt>Expected status</dt>
          <dd>HTTP {monitor.config.expectedStatus}</dd>
        </div>
        <div>
          <dt>Timeout</dt>
          <dd>{monitor.config.timeoutMs} ms</dd>
        </div>
        <div>
          <dt>Incident threshold</dt>
          <dd>{monitor.config.failureThreshold} consecutive failures</dd>
        </div>
        <div>
          <dt>Public status</dt>
          <dd>
            {monitor.archivedAt
              ? 'Hidden while archived'
              : monitor.config.public
                ? 'Published'
                : 'Private'}
          </dd>
        </div>
      </dl>
      <div className="detail-tabs" role="group" aria-label="Check detail view">
        <button aria-pressed={tab === 'runs'} onClick={() => setTab('runs')}>
          Responses
        </button>
        <button aria-pressed={tab === 'history'} onClick={() => setTab('history')}>
          Configuration history
        </button>
      </div>
      {tab === 'history' ? (
        <ConfigurationHistory key={monitor.configRevision} monitor={monitor} onView={onRevision} />
      ) : (
        <>
          <div className="section-heading">
            <h3>Recent responses</h3>
            <span className="muted">Last {runs.length} runs</span>
          </div>
          {error && (
            <p className="error-message" role="alert">
              {error}
            </p>
          )}
          {loading ? (
            <p className="muted">Loading runs…</p>
          ) : !runs.length ? (
            <div className="detail-empty">
              <Clock3 size={24} />
              <p>Waiting for the first observation.</p>
            </div>
          ) : (
            <>
              <div className="run-bars" aria-label="Recent response times">
                {[...runs].reverse().map((r) => (
                  <div
                    key={r.id}
                    className={r.outcome}
                    style={{
                      height: `${Math.max(8, Math.round((r.durationMs / Math.max(...runs.map((r) => r.durationMs), 1)) * 70))}px`,
                    }}
                    title={`${r.outcome} · ${r.durationMs} ms · ${time(r.checkedAt)}`}
                  />
                ))}
              </div>
              <div className="run-list">
                {runs.map((r) => (
                  <details key={r.id} className={`run ${r.outcome}`}>
                    <summary>
                      <span className="run-dot" />
                      <span>
                        {r.outcome === 'pass'
                          ? 'Passed'
                          : r.outcome === 'fail'
                            ? 'Failed'
                            : 'Execution error'}
                        <small>{time(r.checkedAt)}</small>
                      </span>
                      <span className="mono">{r.durationMs} ms</span>
                    </summary>
                    <div>
                      <p>HTTP {r.statusCode ?? '—'}</p>
                      <button
                        className="revision-link"
                        onClick={() => onRevision(r.configRevision)}
                      >
                        View configuration · Revision {r.configRevision}
                      </button>
                      {r.assertions?.length ? (
                        <ul className="assertion-results">
                          {r.assertions.map((assertion, index) => (
                            <li key={index} data-passed={assertion.passed}>
                              <strong>
                                {assertion.passed ? 'Pass' : 'Fail'} · {assertion.label}
                              </strong>
                              <span>{assertion.message}</span>
                            </li>
                          ))}
                        </ul>
                      ) : r.failures.length ? (
                        r.failures.map((f, i) => <p key={i}>{f}</p>)
                      ) : (
                        <p>All assertions passed.</p>
                      )}
                    </div>
                  </details>
                ))}
              </div>
            </>
          )}
        </>
      )}
    </aside>
  );
}
