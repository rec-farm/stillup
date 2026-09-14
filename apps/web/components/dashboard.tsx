'use client';
import { useCallback, useEffect, useState } from 'react';
import {
  Activity,
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
import type { Dashboard, Monitor, Run, Health } from '@stillup/core';
import { Brand } from './brand';
import { CheckForm } from './check-form';
const labels: Record<Health, string> = {
  up: 'Healthy',
  down: 'Failing',
  unknown: 'Awaiting data',
  paused: 'Paused',
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
  const [data, setData] = useState(initial);
  const [create, setCreate] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('all');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const refresh = useCallback(async () => {
    try {
      setData(await api<Dashboard>('dashboard'));
      setError('');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not refresh');
    }
  }, []);
  useEffect(() => {
    const timer = setInterval(() => void refresh(), 10000);
    return () => clearInterval(timer);
  }, [refresh]);
  const counts = {
    up: data.monitors.filter((m) => m.health === 'up').length,
    down: data.monitors.filter((m) => m.health === 'down').length,
    unknown: data.monitors.filter((m) => m.health === 'unknown').length,
  };
  const workerOnline = !!data.workerAt && Date.now() - Date.parse(data.workerAt) < 30000;
  const visible = data.monitors.filter(
    (m) =>
      (filter === 'all' || m.health === filter) &&
      `${m.config.name} ${m.config.url}`.toLowerCase().includes(query.toLowerCase()),
  );
  const current = data.monitors.find((m) => m.id === selected);
  async function action(monitor: Monitor, kind: 'run' | 'toggle') {
    setBusy(true);
    setNotice('');
    setError('');
    try {
      if (kind === 'run') {
        const result = await api<{ message: string }>(`checks/${monitor.id}/run`, {
          method: 'POST',
        });
        setNotice(result.message);
      } else {
        await api(`checks/${monitor.id}`, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ enabled: !monitor.enabled }),
        });
        setNotice(monitor.enabled ? 'Check paused' : 'Check resumed');
      }
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Action failed');
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <a className="brand-link" href="/" aria-label="StillUp home">
          <Brand />
        </a>
        <div className="workspace">
          <span className="workspace-avatar">S</span>
          <div>
            <strong>My workspace</strong>
            <small>Self-hosted installation</small>
          </div>
          <ShieldCheck size={16} />
        </div>
        <span className="nav-label">WORKSPACE</span>
        <nav>
          <a href="/" className="nav-item active">
            <LayoutDashboard size={18} />
            Overview
          </a>
          <a href="#checks" className="nav-item">
            <Activity size={18} />
            API checks<span className="nav-count">{data.monitors.length}</span>
          </a>
          <a href="#incidents" className="nav-item">
            <Radio size={18} />
            Incidents
          </a>
          <a href="/status" target="_blank" rel="noreferrer" className="nav-item">
            <Globe2 size={18} />
            Public status
            <ExternalLink size={13} />
          </a>
        </nav>
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
          <button
            className="nav-item signout"
            onClick={async () => {
              try {
                await api('session', { method: 'DELETE' });
                window.location.assign('/login');
              } catch (e) {
                setError(e instanceof Error ? e.message : 'Sign out failed');
              }
            }}
          >
            <LogOut size={17} />
            Sign out
          </button>
          <div className="version">
            <span className="tiny-dot" />
            StillUp <span>v0.1.0</span>
          </div>
        </div>
      </aside>
      <div className="main-area">
        <header className="topbar">
          <div className="breadcrumbs">
            Workspace<span>/</span>
            <strong>Overview</strong>
          </div>
          <a href="/status" target="_blank" rel="noreferrer">
            Status page
            <ArrowUpRight size={15} />
          </a>
        </header>
        <main className="dashboard-main">
          <div className="page-heading">
            <div>
              <div className="eyebrow">YOUR APIS, AT A GLANCE</div>
              <h1>
                Overview<span className="heading-dot">.</span>
              </h1>
              <p>A little peace of mind for everything you build.</p>
            </div>
            <button className="button primary" onClick={() => setCreate(true)}>
              <Plus size={17} />
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
          <section className={`overview-banner ${counts.down ? 'attention' : ''}`}>
            <div className="banner-icon">
              {counts.down ? (
                <Radio size={24} />
              ) : counts.up > 0 && counts.unknown === 0 && workerOnline ? (
                <ShieldCheck size={26} />
              ) : (
                <Activity size={26} />
              )}
            </div>
            <div>
              <h2>
                {counts.down
                  ? `${counts.down} ${counts.down === 1 ? 'API needs' : 'APIs need'} your attention`
                  : !data.monitors.length
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
                  : !data.monitors.length
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
              value={data.monitors.length}
              icon={<Activity size={18} />}
              detail="HTTP & API endpoints"
            />
            <Metric
              label="Healthy"
              value={counts.up}
              icon={<ArrowUpRight size={18} />}
              detail="Passing your expectations"
              tone="green"
            />
            <Metric
              label="Failing"
              value={counts.down}
              icon={<ArrowDownRight size={18} />}
              detail="Confirmed check failures"
              tone={counts.down ? 'red' : ''}
            />
            <Metric
              label="Awaiting data"
              value={counts.unknown}
              icon={<Clock3 size={18} />}
              detail="Pending or stale observations"
            />
          </section>
          <section className="checks-section" id="checks">
            <div className="section-heading">
              <div>
                <h2>
                  API checks <span className="count-pill">{data.monitors.length}</span>
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
                  ['paused', 'Paused'],
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
            {!data.monitors.length ? (
              <div className="empty-state">
                <div className="empty-illustration">
                  <div className="endpoint-chip">
                    <span className="method">GET</span>
                    <code>/health</code>
                    <span className="mini-check">
                      <Check size={14} />
                    </span>
                  </div>
                  <div className="empty-pulse" aria-hidden="true">
                    {Array.from({ length: 25 }, (_, i) => (
                      <span key={i} />
                    ))}
                  </div>
                </div>
                <h3>Meet your first API check.</h3>
                <p>
                  A healthy response is a great start.
                  <br />
                  Make sure it stays that way.
                </p>
                <button className="button primary" onClick={() => setCreate(true)}>
                  <Plus size={16} />
                  Create your first check
                </button>
                <span className="empty-footnote">
                  HTTP requests · JSON assertions · Incident alerts
                </span>
              </div>
            ) : visible.length === 0 ? (
              <div className="empty-state compact">
                <Search size={24} />
                <h3>No matching checks</h3>
                <p>Try another name or status filter.</p>
              </div>
            ) : (
              <div className="table-scroll">
                <table className="checks-table">
                  <thead>
                    <tr>
                      <th>CHECK / ENDPOINT</th>
                      <th>STATUS</th>
                      <th>RESPONSE</th>
                      <th>INTERVAL</th>
                      <th>LAST RUN</th>
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
                          {m.lastDurationMs === null ? '—' : `${m.lastDurationMs} ms`}
                        </td>
                        <td>
                          {m.config.intervalSeconds < 60
                            ? `${m.config.intervalSeconds}s`
                            : `${m.config.intervalSeconds / 60}m`}
                        </td>
                        <td className="muted">{time(m.lastRunAt)}</td>
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
                        <strong>{i.name}</strong>
                        <small>{time(i.openedAt)}</small>
                      </div>
                      <span className={`incident-state ${i.resolvedAt ? 'resolved' : ''}`}>
                        {i.resolvedAt ? 'Resolved' : 'Investigating'}
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
                Configure ALERT_WEBHOOK_URL to receive incident and recovery events.
              </p>
            </section>
          </div>
          <footer className="dashboard-footer">
            <span>Know before your users do.</span>
            <span>Made for APIs. Built in the open.</span>
          </footer>
        </main>
      </div>
      {create && (
        <CheckForm
          onClose={() => setCreate(false)}
          onCreated={(m) => {
            setCreate(false);
            setSelected(m.id);
            setData((d) => ({ ...d, monitors: [m, ...d.monitors] }));
            setNotice('Check created. Its first run will start shortly.');
            void refresh();
          }}
        />
      )}
      {current && (
        <CheckDetail
          monitor={current}
          onClose={() => setSelected(null)}
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
      <strong>{value.toString().padStart(2, '0')}</strong>
      <p>{detail}</p>
    </article>
  );
}
function CheckDetail({
  monitor,
  onClose,
  onAction,
  busy,
}: {
  monitor: Monitor;
  onClose: () => void;
  onAction: (kind: 'run' | 'toggle') => void;
  busy: boolean;
}) {
  const [runs, setRuns] = useState<Run[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let active = true;
    const load = async () => {
      try {
        const rows = await api<Run[]>(`checks/${monitor.id}/runs`);
        if (active) {
          setRuns(rows);
          setError('');
        }
      } catch (e) {
        if (active) setError(e instanceof Error ? e.message : 'Could not load runs');
      } finally {
        if (active) setLoading(false);
      }
    };
    setRuns([]);
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
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', listener);
    return () => window.removeEventListener('keydown', listener);
  }, [onClose]);
  return (
    <aside className="detail-panel" aria-label={`${monitor.config.name} details`}>
      <header>
        <span className="eyebrow">CHECK DETAILS</span>
        <button className="icon-button" onClick={onClose} aria-label="Close check details">
          <X size={20} />
        </button>
      </header>
      <h2>{monitor.config.name}</h2>
      <HealthBadge health={monitor.health} />
      <p className="detail-url">
        <span className="method">{monitor.config.method}</span>
        {monitor.config.url}
      </p>
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
      </div>
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
          <dd>{monitor.config.public ? 'Published' : 'Private'}</dd>
        </div>
      </dl>
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
                  {r.failures.length ? (
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
    </aside>
  );
}
