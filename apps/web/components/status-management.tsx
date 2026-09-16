'use client';
import { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import {
  statusSettingsSchema,
  type StatusManagement,
  type StatusSettings,
  type Monitor,
  type Maintenance,
  type CommunicationIncident,
} from '@stillup/core';
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
      className="check-dialog notification-dialog"
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
        <nav className="notification-actions" aria-label="Status page sections">
          {(['page', 'maintenance', 'incidents'] as const).map((t) => (
            <button
              className={`button ${tab === t ? 'primary' : 'secondary'}`}
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
                ? 'Branding & groups'
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
  const [groups, setGroups] = useState(data.settings.groups);
  const [error, setError] = useState('');
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        const form = new FormData(e.currentTarget);
        const parsed = statusSettingsSchema.safeParse({
          title: form.get('title'),
          brandName: form.get('brandName'),
          description: form.get('description'),
          accentColor: form.get('accentColor'),
          logoUrl: form.get('logoUrl'),
          homepageUrl: form.get('homepageUrl'),
          groups,
        });
        if (!parsed.success) {
          setError(parsed.error.issues.map((i) => i.message).join('; '));
          return;
        }
        setError('');
        void onSave(parsed.data);
      }}
    >
      <h3 className="notification-heading">Branding</h3>
      <label htmlFor="status-title">Page title</label>
      <input
        id="status-title"
        name="title"
        required
        maxLength={100}
        defaultValue={data.settings.title}
      />
      <label htmlFor="brand-name">Brand name</label>
      <input
        id="brand-name"
        name="brandName"
        required
        maxLength={80}
        defaultValue={data.settings.brandName}
      />
      <label htmlFor="status-description">Introduction</label>
      <textarea
        id="status-description"
        name="description"
        maxLength={1000}
        rows={3}
        defaultValue={data.settings.description}
      />
      <label htmlFor="brand-accent">Accent color</label>
      <input
        id="brand-accent"
        name="accentColor"
        type="color"
        defaultValue={data.settings.accentColor}
      />
      <label htmlFor="brand-logo">Logo URL (optional, public image)</label>
      <input id="brand-logo" name="logoUrl" type="url" defaultValue={data.settings.logoUrl} />
      <label htmlFor="brand-home">Website URL (optional)</label>
      <input
        id="brand-home"
        name="homepageUrl"
        type="url"
        defaultValue={data.settings.homepageUrl}
      />
      <h3 className="notification-heading">Component groups</h3>
      {groups.map((g) => (
        <div className="notification-card" key={g.id}>
          <label htmlFor={`group-${g.id}`}>Group name</label>
          <input
            id={`group-${g.id}`}
            value={g.name}
            maxLength={80}
            required
            onChange={(e) =>
              setGroups((current) =>
                current.map((row) => (row.id === g.id ? { ...row, name: e.target.value } : row)),
              )
            }
          />
          <button
            type="button"
            className="button secondary"
            onClick={() => setGroups((current) => current.filter((row) => row.id !== g.id))}
          >
            Remove {g.name || 'group'}
          </button>
        </div>
      ))}
      <button
        type="button"
        className="button secondary"
        disabled={groups.length >= 30}
        onClick={() =>
          setGroups((current) => [
            ...current,
            { id: crypto.randomUUID(), name: '', monitorIds: [] },
          ])
        }
      >
        Add component group
      </button>
      {monitors
        .filter((m) => !m.archivedAt || groups.some((g) => g.monitorIds.includes(m.id)))
        .map((m) => (
          <div key={m.id}>
            <label htmlFor={`group-assignment-${m.id}`}>
              {m.config.name}
              {m.config.public && !m.archivedAt ? '' : ' (private or archived)'}
            </label>
            <select
              id={`group-assignment-${m.id}`}
              value={groups.find((g) => g.monitorIds.includes(m.id))?.id ?? ''}
              onChange={(e) =>
                setGroups((current) =>
                  current.map((g) => ({
                    ...g,
                    monitorIds:
                      g.id === e.target.value
                        ? [...g.monitorIds.filter((id) => id !== m.id), m.id]
                        : g.monitorIds.filter((id) => id !== m.id),
                  })),
                )
              }
            >
              <option value="">Ungrouped</option>
              {groups.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.name || 'Unnamed group'}
                </option>
              ))}
            </select>
          </div>
        ))}
      <p className="field-hint">
        Groups appear only when they contain a published component. Grouping a private check does
        not publish it.
      </p>
      {error && (
        <p className="error-message" role="alert">
          {error}
        </p>
      )}
      <button className="button primary" disabled={busy}>
        Save public page
      </button>
    </form>
  );
}
