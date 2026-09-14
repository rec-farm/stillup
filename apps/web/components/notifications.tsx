'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import type {
  Channel,
  Delivery,
  DeliveryAttempt,
  DeliveryPage,
  IncidentTimeline,
} from '@stillup/core';
export async function notificationApi<T>(path: string, body?: object, method = 'POST'): Promise<T> {
  const response = await fetch(
    `/api/v1/${path}`,
    body === undefined
      ? undefined
      : { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) },
  );
  if (response.status === 401) {
    window.location.assign('/login');
    throw new Error('Session expired');
  }
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Request failed');
  return data;
}
const timestamp = (value: string | null) =>
  value ? new Date(value).toLocaleString('en-GB', { timeZone: 'UTC' }) + ' UTC' : '—';
const eventName = (type: string) =>
  ({
    'incident.opened': 'Incident opened',
    'incident.resolved': 'Recovery',
    'incident.reminder': 'Outage reminder',
    'notification.test': 'Test notification',
  })[type] ?? type;
const message = (error: unknown) => (error instanceof Error ? error.message : 'Request failed');
export function NotificationDialog({
  onClose,
  onChanged,
}: {
  onClose: () => void;
  onChanged: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [editing, setEditing] = useState<Channel | 'new' | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [version, setVersion] = useState(0);
  const refresh = useCallback(
    async () => setChannels(await notificationApi<Channel[]>('notification-channels')),
    [],
  );
  useEffect(() => {
    dialog.current?.showModal();
    void refresh().catch((e) => setError(message(e)));
  }, [refresh]);
  async function save(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const current = editing && editing !== 'new' ? editing : null;
      const url = String(form.get('url') || '').trim();
      await notificationApi(
        `notification-channels${current ? `/${current.id}` : ''}`,
        {
          name: form.get('name'),
          url: url || undefined,
          enabled: form.get('enabled') === 'on',
          isDefault: form.get('isDefault') === 'on',
          ...(current ? { expectedRevision: current.revision } : {}),
        },
        current ? 'PUT' : 'POST',
      );
      setEditing(null);
      await refresh();
      onChanged();
      setNotice('Channel saved. Existing deliveries keep their original destination.');
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }
  async function editChannel(channel: Channel) {
    setBusy(true);
    setError('');
    try {
      const latest = await notificationApi<Channel[]>('notification-channels');
      setChannels(latest);
      setEditing(latest.find((c) => c.id === channel.id) ?? null);
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }
  async function test(channel: Channel) {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await notificationApi(`notification-channels/${channel.id}/test`, {});
      setNotice(`Test notification queued for ${channel.name}. Check delivery history below.`);
      setVersion((v) => v + 1);
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }
  const current = editing && editing !== 'new' ? editing : null;
  return (
    <dialog
      ref={dialog}
      className="check-dialog notification-dialog"
      aria-labelledby="notifications-title"
      onCancel={(e) => {
        e.preventDefault();
        if (!busy) onClose();
      }}
    >
      <header className="dialog-header">
        <div>
          <span className="eyebrow">STAY INFORMED</span>
          <h2 id="notifications-title">Notifications</h2>
        </div>
        <button
          className="icon-button"
          aria-label="Close notifications"
          onClick={onClose}
          disabled={busy}
        >
          <X size={20} />
        </button>
      </header>
      <div className="dialog-content">
        {error && (
          <p className="error-message" role="alert">
            {error}
          </p>
        )}
        {notice && (
          <p className="edit-note" role="status">
            {notice}
          </p>
        )}
        <div className="section-heading">
          <h3>Webhook channels</h3>
          <button
            className="button secondary"
            onClick={() => {
              setEditing('new');
              setError('');
            }}
            disabled={busy}
          >
            Add channel
          </button>
        </div>
        <p className="field-hint">
          Default channels receive incident and recovery events unless a check chooses specific
          channels. Tests send a clearly labeled message to the selected destination.
        </p>
        {!channels.length && <p>No channels yet. Add a webhook to receive alerts.</p>}
        {channels.map((c) => (
          <article className="notification-card" key={c.id}>
            <div>
              <strong>{c.name}</strong>
              <small>
                {c.destination} · {c.enabled ? 'Enabled' : 'Disabled'}
                {c.isDefault ? ' · Default' : ''}
                {c.source === 'environment' ? ' · Environment' : ''}
              </small>
            </div>
            <div className="notification-actions">
              <button
                className="button secondary"
                disabled={busy}
                onClick={() => void editChannel(c)}
              >
                Edit {c.name}
              </button>
              <button
                className="button secondary"
                disabled={busy || !c.enabled}
                onClick={() => void test(c)}
              >
                Send test to {c.name}
              </button>
            </div>
          </article>
        ))}
        {editing && (
          <form className="channel-form" key={current?.id ?? 'new'} onSubmit={save}>
            <h3>{current ? `Edit ${current.name}` : 'New webhook channel'}</h3>
            <label htmlFor="channel-name">Channel name</label>
            <input
              autoFocus
              id="channel-name"
              name="name"
              required
              maxLength={80}
              defaultValue={current?.name}
            />
            {current?.source !== 'environment' ? (
              <>
                <label htmlFor="channel-url">
                  {current ? 'Replacement webhook URL (optional)' : 'Webhook URL'}
                </label>
                <input
                  id="channel-url"
                  name="url"
                  type="url"
                  required={!current}
                  maxLength={4096}
                  placeholder="https://hooks.example.com/…"
                />
                <p className="field-hint">
                  The full URL is stored privately and never returned to the browser. Leave blank
                  when editing to keep it.
                </p>
              </>
            ) : (
              <p className="field-hint">
                The URL comes from ALERT_WEBHOOK_URL. Restart the API and worker after changing it.
              </p>
            )}
            <label className="checkbox-label">
              <input name="enabled" type="checkbox" defaultChecked={current?.enabled ?? true} />
              Enabled
            </label>
            <label className="checkbox-label">
              <input name="isDefault" type="checkbox" defaultChecked={current?.isDefault ?? true} />
              Use as a default channel
            </label>
            <div className="notification-actions">
              <button className="button primary" disabled={busy}>
                {busy ? 'Saving…' : 'Save channel'}
              </button>
              <button
                className="button secondary"
                type="button"
                disabled={busy}
                onClick={() => setEditing(null)}
              >
                Cancel editing
              </button>
            </div>
          </form>
        )}
        <h3 className="notification-heading">Delivery history</h3>
        <DeliveryHistory key={version} />
      </div>
    </dialog>
  );
}
export function DeliveryHistory({ incidentId }: { incidentId?: string }) {
  const [page, setPage] = useState<DeliveryPage>({ deliveries: [], nextBefore: null });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [detail, setDetail] = useState<{ delivery: Delivery; attempts: DeliveryAttempt[] } | null>(
    null,
  );
  const [loading, setLoading] = useState(true);
  const detailId = detail?.delivery.id;
  useEffect(() => {
    if (!detailId) return;
    let active = true;
    const timer = setInterval(() => {
      void notificationApi<{ delivery: Delivery; attempts: DeliveryAttempt[] }>(
        `notification-deliveries/${detailId}`,
      )
        .then((value) => {
          if (active) setDetail(value);
        })
        .catch((e) => {
          if (active) setError(message(e));
        });
    }, 10000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [detailId]);
  const cursor = useRef<string | null>(null);
  const generation = useRef(0);
  const browsingOlder = useRef(false);
  const path = `notification-deliveries${incidentId ? `?incidentId=${incidentId}` : ''}`;
  const refresh = useCallback(async () => {
    const sequence = ++generation.current;
    const next = await notificationApi<DeliveryPage>(path);
    if (sequence === generation.current) {
      setPage(next);
      cursor.current = next.nextBefore;
      setError('');
      setLoading(false);
    }
  }, [path]);
  useEffect(() => {
    let active = true;
    void refresh().catch((e) => {
      if (active) {
        setError(message(e));
        setLoading(false);
      }
    });
    const timer = setInterval(
      () =>
        !browsingOlder.current &&
        void refresh().catch((e) => {
          if (active) setError(message(e));
        }),
      10000,
    );
    return () => {
      active = false;
      generation.current++;
      clearInterval(timer);
    };
  }, [refresh]);
  async function more() {
    if (!cursor.current) return;
    setBusy(true);
    browsingOlder.current = true;
    generation.current++;
    try {
      const next = await notificationApi<DeliveryPage>(
        `${path}${incidentId ? '&' : '?'}before=${cursor.current}`,
      );
      setPage((p) => ({
        deliveries: [
          ...p.deliveries,
          ...next.deliveries.filter((d) => !p.deliveries.some((old) => old.id === d.id)),
        ],
        nextBefore: next.nextBefore,
      }));
      cursor.current = next.nextBefore;
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }
  async function inspect(id: string) {
    setBusy(true);
    try {
      setDetail(await notificationApi(`notification-deliveries/${id}`));
      setError('');
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }
  async function retry(id: string) {
    setBusy(true);
    try {
      await notificationApi(`notification-deliveries/${id}/retry`, {});
      await refresh();
      await inspect(id);
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section aria-label="Notification delivery history">
      <p className="field-hint">
        Six automatic attempts with backoff. Retries reuse the original destination and idempotency
        key. Receivers should deduplicate this key.
      </p>
      {error && (
        <p className="error-message" role="alert">
          {error}
        </p>
      )}
      {loading ? (
        <p>Loading deliveries…</p>
      ) : (
        !page.deliveries.length && <p>No notifications have been queued.</p>
      )}
      {page.deliveries.map((d) => (
        <article className="notification-card" key={d.id}>
          <div>
            <strong>
              {eventName(d.event.type)} · {d.channelName}
            </strong>
            <small>
              {d.event.name} · {timestamp(d.createdAt)}
            </small>
            <span className={`delivery-state ${d.status}`}>{d.status}</span>
            <small>
              {d.attempts} attempt{d.attempts === 1 ? '' : 's'}
              {d.status === 'retrying' ? ` · Next: ${timestamp(d.nextAttemptAt)}` : ''}
            </small>
            {d.lastError && <p>{d.lastError}</p>}
          </div>
          <div className="notification-actions">
            <button className="button secondary" disabled={busy} onClick={() => void inspect(d.id)}>
              View attempts
            </button>
            {['failed', 'cancelled'].includes(d.status) && (
              <button className="button secondary" disabled={busy} onClick={() => void retry(d.id)}>
                Retry delivery
              </button>
            )}
          </div>
        </article>
      ))}
      {browsingOlder.current && (
        <p className="field-hint">
          Viewing a history snapshot. Reopen notifications to resume live updates.
        </p>
      )}
      {page.nextBefore && (
        <button className="button secondary" disabled={busy} onClick={() => void more()}>
          Older deliveries
        </button>
      )}
      {detail && (
        <section className="attempt-history" aria-label="Delivery attempts">
          <div className="section-heading">
            <h4>
              {detail.delivery.channelName} · {eventName(detail.delivery.event.type)}
            </h4>
            <button className="button secondary" onClick={() => setDetail(null)}>
              Close attempts
            </button>
          </div>
          <p className="field-hint">
            Idempotency key: {detail.delivery.id}. Latest 100 attempts; updates every 10 seconds.
          </p>
          {!detail.attempts.length && <p>Waiting for the notification worker.</p>}
          {detail.attempts.map((a) => (
            <p key={a.id}>
              <strong>Attempt {a.number}</strong> · {timestamp(a.startedAt)}
              <br />
              {a.finishedAt
                ? (a.error ?? `Delivered · HTTP ${a.statusCode}`)
                : 'In progress; an interrupted attempt is recovered after its lease expires.'}
            </p>
          ))}
        </section>
      )}
    </section>
  );
}
export function IncidentDialog({
  id,
  onClose,
  onRevision,
}: {
  id: string;
  onClose: () => void;
  onRevision: (monitorId: string, revision: number) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [data, setData] = useState<IncidentTimeline | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const browsingOlder = useRef(false);
  useEffect(() => {
    dialog.current?.showModal();
    let active = true;
    const refresh = () => {
      if (browsingOlder.current) return;
      void notificationApi<IncidentTimeline>(`incidents/${id}`)
        .then((value) => {
          if (active && !browsingOlder.current) {
            setData(value);
            setError('');
          }
        })
        .catch((e) => {
          if (active) setError(message(e));
        });
    };
    refresh();
    const timer = setInterval(refresh, 10000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [id]);
  async function more() {
    if (!data?.nextBefore) return;
    setBusy(true);
    browsingOlder.current = true;
    try {
      const next = await notificationApi<IncidentTimeline>(
        `incidents/${id}?before=${data.nextBefore}`,
      );
      setData({ ...next, observations: [...data.observations, ...next.observations] });
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <dialog
      ref={dialog}
      className="check-dialog notification-dialog"
      aria-labelledby="incident-title"
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
    >
      <header className="dialog-header">
        <div>
          <span className="eyebrow">INCIDENT TIMELINE</span>
          <h2 id="incident-title">{data?.incident.name ?? 'Loading incident…'}</h2>
        </div>
        <button className="icon-button" aria-label="Close incident timeline" onClick={onClose}>
          <X size={20} />
        </button>
      </header>
      <div className="dialog-content">
        {error && (
          <p className="error-message" role="alert">
            {error}
          </p>
        )}
        {data && (
          <>
            <p>
              Opened {timestamp(data.incident.openedAt)}
              <br />
              {data.incident.resolvedAt
                ? `Recovered ${timestamp(data.incident.resolvedAt)}`
                : 'Recovery has not been confirmed.'}
            </p>
            <h3>Incident transitions</h3>
            {!data.events.length && (
              <p>Run snapshots are unavailable for incidents created before this upgrade.</p>
            )}
            {data.events.map((e) => (
              <article className="notification-card" key={e.id}>
                <strong>{eventName(e.type)}</strong>
                <small>{timestamp(e.at)}</small>
                <button
                  className="revision-link"
                  onClick={() => onRevision(data.incident.monitorId, e.configRevision)}
                >
                  View configuration · Revision {e.configRevision}
                </button>
                {e.result.failures.map((f, index) => (
                  <p key={index}>{f}</p>
                ))}
                {!e.result.failures.length && <p>All assertions passed.</p>}
              </article>
            ))}
            <h3 className="notification-heading">Observations</h3>
            <p className="field-hint">
              Most recent first. Observations follow run retention; transition snapshots remain
              available.
            </p>
            {data.observations.map((r) => (
              <details className="timeline-observation" key={r.id}>
                <summary>
                  {r.outcome} · {timestamp(r.checkedAt)} · {r.durationMs} ms
                </summary>
                <button
                  className="revision-link"
                  onClick={() => onRevision(data.incident.monitorId, r.configRevision)}
                >
                  View configuration · Revision {r.configRevision}
                </button>
                {r.failures.length ? (
                  r.failures.map((f, i) => <p key={i}>{f}</p>)
                ) : (
                  <p>All assertions passed.</p>
                )}
              </details>
            ))}
            {!data.observations.length && <p>No retained observations.</p>}
            {data.nextBefore && (
              <button className="button secondary" onClick={() => void more()} disabled={busy}>
                Older observations
              </button>
            )}
            <h3 className="notification-heading">Associated notifications</h3>
            <DeliveryHistory incidentId={id} />
          </>
        )}
      </div>
    </dialog>
  );
}
