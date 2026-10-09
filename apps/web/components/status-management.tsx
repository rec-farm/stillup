'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import { X } from 'lucide-react';
import {
  statusSettingsSchema,
  type StatusManagement,
  type StatusSettings,
  type Monitor,
  type Maintenance,
  type CommunicationIncident,
  type PublicStatus,
  type Uptime,
} from '@stillup/core';
import { StatusView } from './status-view';
import { StatusDesignFields, isWebLink } from './status-design-fields';
import { notificationApi } from './notifications';
const time = (s: string) => new Date(s).toLocaleString('en-GB', { timeZone: 'UTC' }) + ' UTC';
const localTime = (s: string) => {
  const d = new Date(s);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
};
export function StatusManagementDialog({
  monitors,
  onClose,
}: {
  monitors: Monitor[];
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [data, setData] = useState<StatusManagement | null>(null);
  const [tab, setTab] = useState<'page' | 'maintenance' | 'incidents'>('page');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [window, setWindow] = useState<Maintenance | 'new' | null>(null);
  const [incident, setIncident] = useState<CommunicationIncident | 'new' | null>(null);
  const published = monitors.filter((m) => m.config.public && !m.archivedAt);
  const reload = async () => {
    const next = await notificationApi<StatusManagement>('status-management');
    setData(next);
    return next;
  };
  useEffect(() => {
    dialog.current?.showModal();
    let active = true;
    void notificationApi<StatusManagement>('status-management')
      .then((d) => {
        if (active) setData(d);
      })
      .catch((e) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
    };
  }, []);
  async function perform(action: () => Promise<unknown>, success: string) {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await action();
      await reload();
      setNotice(success);
      setWindow(null);
      setIncident(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function editWindow(id: string) {
    setBusy(true);
    try {
      const latest = await reload();
      setWindow(latest.maintenance.find((w) => w.id === id) ?? null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function editIncident(id: string) {
    setBusy(true);
    try {
      const latest = await reload();
      setIncident(latest.incidents.find((i) => i.id === id) ?? null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const currentWindow = window && window !== 'new' ? window : null;
  const currentIncident = incident && incident !== 'new' ? incident : null;
  return (
    <dialog
      ref={dialog}
      className={`check-dialog notification-dialog${tab === 'page' ? ' status-editor-dialog' : ''}`}
      aria-labelledby="status-editor-title"
      onCancel={(e) => {
        e.preventDefault();
        if (!busy) onClose();
      }}
    >
      <header className="dialog-header">
        <div>
          <span className="eyebrow">PUBLIC COMMUNICATION</span>
          <h2 id="status-editor-title">Public status page</h2>
        </div>
        <button
          className="icon-button"
          disabled={busy}
          aria-label="Close status page editor"
          onClick={onClose}
        >
          <X size={20} />
        </button>
      </header>
      <div className="dialog-content">
        <nav className="detail-tabs section-tabs" aria-label="Status page sections">
          {(['page', 'maintenance', 'incidents'] as const).map((t) => (
            <button
              key={t}
              aria-pressed={tab === t}
              disabled={busy}
              onClick={() => {
                setTab(t);
                setError('');
                setNotice('');
              }}
            >
              {t === 'page'
                ? 'Design & content'
                : t === 'maintenance'
                  ? 'Maintenance'
                  : 'Incident updates'}
            </button>
          ))}
        </nav>
        {error && (
          <p className="error-message" role="alert">
            {error}
          </p>
        )}
        {notice && <p role="status">{notice}</p>}
        <p>
          Published text appears on your public status page. Check URLs, credentials, and private
          components remain hidden.{' '}
          <a href="/status" target="_blank" rel="noreferrer">
            Preview public page ↗
          </a>
        </p>
        {!data ? (
          <p>Loading page settings…</p>
        ) : (
          <>
            {tab === 'page' && (
              <BrandingEditor
                key={data.revision}
                data={data}
                monitors={monitors}
                busy={busy}
                onSave={(config) =>
                  perform(
                    () =>
                      notificationApi(
                        'status-management/settings',
                        { config, expectedRevision: data.revision },
                        'PUT',
                      ),
                    'Public page settings saved.',
                  )
                }
              />
            )}
            {tab === 'maintenance' && (
              <>
                <button className="button primary" disabled={busy} onClick={() => setWindow('new')}>
                  Schedule maintenance
                </button>
                <p className="field-hint">
                  Maintenance changes public labels during the scheduled window. Checks and alerts
                  continue running. Times below use your browser’s local timezone when editing.
                </p>
                {window && (
                  <form
                    className="channel-form"
                    key={currentWindow?.id ?? 'new'}
                    onSubmit={(e) => {
                      e.preventDefault();
                      const form = new FormData(e.currentTarget);
                      if (form.get('all') !== 'on' && !form.getAll('monitorId').length) {
                        setError(
                          'Choose at least one component or select all published components.',
                        );
                        return;
                      }
                      void perform(
                        () =>
                          notificationApi(
                            `status-management/maintenance${currentWindow ? `/${currentWindow.id}` : ''}`,
                            {
                              title: form.get('title'),
                              description: form.get('description'),
                              monitorIds: form.get('all') === 'on' ? [] : form.getAll('monitorId'),
                              startsAt: new Date(String(form.get('startsAt'))).toISOString(),
                              endsAt: new Date(String(form.get('endsAt'))).toISOString(),
                              cancelled: form.get('cancelled') === 'on',
                              ...(currentWindow
                                ? { expectedRevision: currentWindow.revision }
                                : {}),
                            },
                            currentWindow ? 'PUT' : 'POST',
                          ),
                        'Maintenance notice saved.',
                      );
                    }}
                  >
                    <h3>{currentWindow ? 'Edit maintenance' : 'New maintenance window'}</h3>
                    <label htmlFor="maintenance-title">Title</label>
                    <input
                      autoFocus
                      id="maintenance-title"
                      name="title"
                      required
                      maxLength={160}
                      defaultValue={currentWindow?.title}
                    />
                    <label htmlFor="maintenance-description">Public description</label>
                    <textarea
                      id="maintenance-description"
                      name="description"
                      rows={3}
                      maxLength={4000}
                      defaultValue={currentWindow?.description}
                    />
                    <label htmlFor="maintenance-start">Starts (local time)</label>
                    <input
                      id="maintenance-start"
                      name="startsAt"
                      type="datetime-local"
                      required
                      defaultValue={currentWindow ? localTime(currentWindow.startsAt) : ''}
                    />
                    <label htmlFor="maintenance-end">Ends (local time)</label>
                    <input
                      id="maintenance-end"
                      name="endsAt"
                      type="datetime-local"
                      required
                      defaultValue={currentWindow ? localTime(currentWindow.endsAt) : ''}
                    />
                    <ComponentChoices
                      monitors={published}
                      initial={currentWindow?.monitorIds}
                      allowAll
                    />
                    {currentWindow && (
                      <label className="checkbox-label">
                        <input
                          name="cancelled"
                          type="checkbox"
                          defaultChecked={currentWindow.cancelled}
                        />
                        Cancel this maintenance notice
                      </label>
                    )}
                    <div className="notification-actions">
                      <button className="button primary" disabled={busy}>
                        Publish maintenance
                      </button>
                      <button
                        className="button secondary"
                        type="button"
                        disabled={busy}
                        onClick={() => setWindow(null)}
                      >
                        Cancel editing
                      </button>
                    </div>
                  </form>
                )}
                {data.maintenance.map((w) => (
                  <article className="notification-card" key={w.id}>
                    <strong>{w.title}</strong>
                    <small>
                      {w.cancelled
                        ? 'Cancelled'
                        : Date.parse(w.endsAt) < Date.now()
                          ? 'Completed'
                          : Date.parse(w.startsAt) > Date.now()
                            ? 'Scheduled'
                            : 'In progress'}{' '}
                      · {time(w.startsAt)} – {time(w.endsAt)}
                    </small>
                    <p>{w.description}</p>
                    <button
                      className="button secondary"
                      disabled={busy}
                      onClick={() => void editWindow(w.id)}
                    >
                      Edit {w.title}
                    </button>
                  </article>
                ))}
              </>
            )}
            {tab === 'incidents' && (
              <>
                <button
                  className="button primary"
                  disabled={busy || !published.length}
                  onClick={() => setIncident('new')}
                >
                  Publish manual incident
                </button>
                <p className="field-hint">
                  Manual incidents mark the selected public components as disrupted until resolved.
                  Updates to detected incidents explain progress; actual monitoring confirms their
                  recovery.
                </p>
                {incident && (
                  <form
                    className="channel-form"
                    key={currentIncident?.id ?? 'new'}
                    onSubmit={(e) => {
                      e.preventDefault();
                      const form = new FormData(e.currentTarget);
                      void perform(
                        () =>
                          notificationApi(
                            currentIncident
                              ? `status-management/incidents/${currentIncident.id}/updates`
                              : 'status-management/incidents',
                            currentIncident
                              ? {
                                  source: currentIncident.source,
                                  stage: form.get('stage'),
                                  body: form.get('body'),
                                  expectedRevision: currentIncident.revision,
                                }
                              : {
                                  title: form.get('title'),
                                  monitorIds: form.getAll('monitorId'),
                                  body: form.get('body'),
                                },
                          ),
                        'Incident update published.',
                      );
                    }}
                  >
                    <h3>
                      {currentIncident ? `Update ${currentIncident.name}` : 'New public incident'}
                    </h3>
                    {!currentIncident && (
                      <>
                        <label htmlFor="public-incident-title">Incident title</label>
                        <input
                          autoFocus
                          id="public-incident-title"
                          name="title"
                          required
                          maxLength={160}
                        />
                        <ComponentChoices monitors={published} />
                      </>
                    )}
                    {currentIncident && (
                      <>
                        <label htmlFor="incident-stage">Progress</label>
                        <select
                          id="incident-stage"
                          name="stage"
                          defaultValue={currentIncident.stage}
                        >
                          <option value="investigating">Investigating</option>
                          <option value="identified">Identified</option>
                          <option value="monitoring">Monitoring</option>
                          {(currentIncident.source === 'manual' || currentIncident.resolvedAt) && (
                            <option value="resolved">Resolved</option>
                          )}
                        </select>
                      </>
                    )}
                    <label htmlFor="incident-update-body">Public update</label>
                    <textarea
                      id="incident-update-body"
                      name="body"
                      rows={4}
                      required
                      maxLength={4000}
                    />
                    <div className="notification-actions">
                      <button className="button primary" disabled={busy}>
                        Publish update
                      </button>
                      <button
                        className="button secondary"
                        type="button"
                        disabled={busy}
                        onClick={() => setIncident(null)}
                      >
                        Cancel editing
                      </button>
                    </div>
                  </form>
                )}
                {data.incidents.map((i) => (
                  <article className="notification-card" key={`${i.source}:${i.id}`}>
                    <strong>{i.name}</strong>
                    <small>
                      {i.source === 'manual' ? 'Manual' : 'Detected'} · {i.stage} ·{' '}
                      {time(i.openedAt)}
                      {!i.monitorIds.some((id) => published.some((m) => m.id === id))
                        ? ' · Hidden: no published components'
                        : ''}
                    </small>
                    {i.updates[0] && <p>{i.updates[0].body}</p>}
                    <button
                      className="button secondary"
                      disabled={busy}
                      onClick={() => void editIncident(i.id)}
                    >
                      Update {i.name}
                    </button>
                  </article>
                ))}
              </>
            )}
          </>
        )}
      </div>
    </dialog>
  );
}
function ComponentChoices({
  monitors,
  initial = [],
  allowAll = false,
}: {
  monitors: Monitor[];
  initial?: string[];
  allowAll?: boolean;
}) {
  const [all, setAll] = useState(allowAll && !initial.length);
  return (
    <fieldset className="component-choices">
      <legend>Affected public components</legend>
      {!all &&
        initial
          .filter((id) => !monitors.some((m) => m.id === id))
          .map((id) => <input key={id} type="hidden" name="monitorId" value={id} />)}
      {allowAll && (
        <label className="checkbox-label">
          <input
            type="checkbox"
            name="all"
            checked={all}
            onChange={(e) => setAll(e.target.checked)}
          />
          All published components
        </label>
      )}
      {!all &&
        monitors.map((m) => (
          <label className="checkbox-label" key={m.id}>
            <input
              type="checkbox"
              name="monitorId"
              value={m.id}
              defaultChecked={initial.includes(m.id)}
            />
            {m.config.name}
          </label>
        ))}
      {!all && !monitors.length && <p>No published components. Publish a check first.</p>}
    </fieldset>
  );
}
const sampleNames = ['Website', 'API', 'Webhooks'];
/** Deterministic sample history so the preview shows how uptime bars will look. */
function sampleUptime(now: Date, index: number, today: number): Uptime {
  const days = Array.from({ length: 90 }, (_, ago) => {
    const date = new Date(now.getTime() - (89 - ago) * 86_400_000).toISOString().slice(0, 10);
    const dip = (89 - ago + index * 7) % 37 === 11 ? 99.4 : 100;
    return { date, percentage: ago === 89 ? today : dip };
  });
  const total = days.reduce((sum, d) => sum + d.percentage, 0) / days.length;
  return { windowDays: 90, percentage: Math.floor(total * 1000) / 1000, days };
}
function previewStatus(
  settings: StatusSettings,
  monitors: Monitor[],
  sample: 'up' | 'down' | 'maintenance',
): PublicStatus {
  const now = new Date();
  const published = monitors.filter((m) => m.config.public && !m.archivedAt);
  const components = (
    published.length
      ? published.map((m) => ({ id: m.id, name: m.config.name }))
      : sampleNames.map((name, index) => ({ id: `sample-${index}`, name }))
  ).map((c, index) => ({
    ...c,
    health: index === 0 && sample !== 'up' ? sample : ('up' as const),
    lastObservedAt: null,
    groupId: settings.groups.find((g) => g.monitorIds.includes(c.id))?.id,
    uptime: sampleUptime(now, index, index === 0 && sample === 'down' ? 91.2 : 100),
  }));
  const first = components[0]!;
  const minutesAgo = (n: number) => new Date(now.getTime() - n * 60000).toISOString();
  return {
    title: settings.title,
    branding: settings,
    groups: settings.groups.filter((g) => components.some((c) => c.groupId === g.id)),
    updatedAt: now.toISOString(),
    incidents: [],
    communications:
      sample === 'down'
        ? [
            {
              id: 'sample-incident',
              name: `${first.name} errors`,
              monitorIds: [first.id],
              source: 'manual',
              openedAt: minutesAgo(18),
              resolvedAt: null,
              revision: 1,
              stage: 'identified',
              updates: [
                {
                  id: 'sample-update',
                  stage: 'identified',
                  body: 'We found the cause and are rolling out a fix.',
                  createdAt: minutesAgo(6),
                },
              ],
            },
          ]
        : [],
    maintenance:
      sample === 'maintenance'
        ? [
            {
              id: 'sample-maintenance',
              revision: 1,
              title: 'Database upgrade',
              description: 'Short interruptions are possible while we upgrade.',
              monitorIds: [first.id],
              startsAt: minutesAgo(10),
              endsAt: new Date(now.getTime() + 50 * 60000).toISOString(),
              cancelled: false,
            },
          ]
        : [],
    components,
  };
}
function BrandingEditor({
  data,
  monitors,
  busy,
  onSave,
}: {
  data: StatusManagement;
  monitors: Monitor[];
  busy: boolean;
  onSave: (config: StatusSettings) => Promise<void>;
}) {
  const [draft, setDraft] = useState<StatusSettings>(data.settings);
  const [error, setError] = useState('');
  const [previewTheme, setPreviewTheme] = useState<'light' | 'dark'>('light');
  const [sample, setSample] = useState<'up' | 'down' | 'maintenance'>('up');
  const patch = (change: Partial<StatusSettings>) =>
    setDraft((current) => ({ ...current, ...change }));
  const dirty = JSON.stringify(draft) !== JSON.stringify(data.settings);
  // Preview what can be shown while the draft is mid-edit: half-typed URLs are left out.
  const previewSettings = useMemo(() => {
    const parsed = statusSettingsSchema.safeParse(draft);
    if (parsed.success) return parsed.data;
    const link = (value: string) => (isWebLink(value) ? value : '');
    return {
      ...draft,
      logoUrl: link(draft.logoUrl),
      homepageUrl: link(draft.homepageUrl),
      faviconUrl: link(draft.faviconUrl),
      links: draft.links.filter((l) => l.label && isWebLink(l.url)),
    };
  }, [draft]);
  const preview = useMemo(
    () => previewStatus(previewSettings, monitors, sample),
    [previewSettings, monitors, sample],
  );
  const shownTheme = draft.theme === 'auto' ? previewTheme : draft.theme;
  return (
    <form
      className="status-editor"
      onSubmit={(e) => {
        e.preventDefault();
        const parsed = statusSettingsSchema.safeParse(draft);
        if (!parsed.success) {
          setError(parsed.error.issues.map((i) => i.message).join('; '));
          return;
        }
        setError('');
        void onSave(parsed.data);
      }}
    >
      <div className="status-editor-fields">
        <StatusDesignFields draft={draft} patch={patch} monitors={monitors} />
      </div>
      <aside className="status-editor-preview" aria-label="Live preview">
        <div className="status-preview-toolbar">
          <span className="eyebrow">Live preview</span>
          <div className="status-preview-controls">
            <div className="detail-tabs" role="group" aria-label="Preview theme">
              {(['light', 'dark'] as const).map((t) => (
                <button
                  key={t}
                  type="button"
                  aria-pressed={shownTheme === t}
                  disabled={draft.theme !== 'auto'}
                  title={
                    draft.theme === 'auto'
                      ? undefined
                      : 'Set the theme to follow the visitor’s system to preview both'
                  }
                  onClick={() => setPreviewTheme(t)}
                >
                  {t === 'light' ? 'Light' : 'Dark'}
                </button>
              ))}
            </div>
            <div className="detail-tabs" role="group" aria-label="Sample status">
              {(
                [
                  ['up', 'Operational'],
                  ['down', 'Incident'],
                  ['maintenance', 'Maintenance'],
                ] as const
              ).map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  aria-pressed={sample === value}
                  onClick={() => setSample(value)}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
        </div>
        <div className="status-preview">
          <StatusView preview previewTheme={previewTheme} initial={preview} />
        </div>
        <p className="field-hint">Sample health only, not your live service status.</p>
      </aside>
      <footer className="status-editor-footer">
        {error ? (
          <p className="error-message" role="alert">
            {error}
          </p>
        ) : (
          <span className="status-editor-state" role="status">
            {dirty ? 'Unsaved changes' : 'All changes saved'}
          </span>
        )}
        <button
          type="button"
          className="button secondary"
          disabled={busy || !dirty}
          onClick={() => {
            setDraft(data.settings);
            setError('');
          }}
        >
          Discard changes
        </button>
        <button className="button primary" disabled={busy || !dirty}>
          {busy ? 'Saving…' : 'Save public page'}
        </button>
      </footer>
    </form>
  );
}
