'use client';
import { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import type { ProbeLocation, RegionalObservation, Monitor } from '@stillup/core';
async function request<T>(
  path: string,
  body?: unknown,
  method = body === undefined ? 'GET' : 'POST',
): Promise<T> {
  const response = await fetch(`/api/v1/${path}`, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(10000),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error ?? 'Cannot reach StillUp');
  return data;
}
type Enrollment = { id: string; enrollmentToken: string; expiresAt: string };
const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
export function LocationsDialog({ onClose }: { onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [locations, setLocations] = useState<ProbeLocation[]>([]);
  const [enrollment, setEnrollment] = useState<Enrollment | null>(null);
  const [origin, setOrigin] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<{
    location: ProbeLocation;
    action: 'revoke' | 'replace';
  } | null>(null);
  useEffect(() => {
    dialog.current?.showModal();
    setOrigin(window.location.origin);
    let active = true;
    let running = false;
    const refresh = async () => {
      if (running) return;
      running = true;
      try {
        const rows = await request<ProbeLocation[]>('locations');
        if (active) setLocations(rows);
      } catch (e) {
        if (active) setError((e as Error).message);
      } finally {
        running = false;
      }
    };
    void refresh();
    const timer = setInterval(refresh, 10000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, []);
  async function action(fn: () => Promise<void>) {
    setBusy(true);
    setError('');
    try {
      await fn();
      setLocations(await request('locations'));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  let command = '';
  try {
    const url = new URL(origin);
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== '/'
    )
      throw new Error();
    if (enrollment)
      command = `STILLUP_URL=${quote(url.origin)} STILLUP_ENROLLMENT_TOKEN=${quote(enrollment.enrollmentToken)} docker compose -p stillup-probe-${enrollment.id.slice(0, 8)}-${enrollment.enrollmentToken.slice(0, 8)} -f deploy/probe/compose.yaml up -d --build`;
  } catch {
    /* Keep the deployment command hidden until an externally reachable HTTPS origin is supplied. */
  }
  return (
    <dialog
      ref={dialog}
      className="check-dialog notification-dialog"
      aria-labelledby="locations-title"
      onCancel={(e) => {
        e.preventDefault();
        if (!busy) onClose();
      }}
    >
      <header className="dialog-header">
        <div>
          <span className="eyebrow">DISTRIBUTED MONITORING</span>
          <h2 id="locations-title">Monitoring locations</h2>
        </div>
        <button
          className="icon-button"
          aria-label="Close locations"
          disabled={busy}
          onClick={onClose}
        >
          <X size={20} />
        </button>
      </header>
      <div className="dialog-content">
        <p className="field-hint">
          Your local probe is included. Run a remote probe on a server in each region you want to
          monitor from. Region names are labels you provide; StillUp does not verify physical
          geography.
        </p>
        {error && (
          <p className="error-message" role="alert">
            {error}
          </p>
        )}
        <ul className="location-list">
          {locations.map((l) => (
            <li key={l.id}>
              <div>
                <strong>{l.name}</strong>
                <span>
                  {l.region} · {l.status}
                </span>
                <small>
                  {l.lastSeenAt
                    ? `Last connected ${new Date(l.lastSeenAt).toLocaleString()}`
                    : 'Not connected yet'}
                </small>
              </div>
              {l.id !== 'local' && (
                <div className="detail-actions">
                  <button
                    className="button secondary"
                    disabled={busy}
                    onClick={() => setConfirm({ location: l, action: 'replace' })}
                  >
                    Replace enrollment
                  </button>
                  {l.status !== 'revoked' && (
                    <button
                      className="button secondary"
                      disabled={busy}
                      onClick={() => setConfirm({ location: l, action: 'revoke' })}
                    >
                      Revoke {l.name}
                    </button>
                  )}
                </div>
              )}
            </li>
          ))}
        </ul>
        {confirm && (
          <div className="archive-note">
            <p>
              {confirm.action === 'revoke'
                ? `Revoke ${confirm.location.name}? Its probe will stop receiving checks. Selected checks retain this location and may show missing coverage.`
                : `Replace ${confirm.location.name}? Its current credential will stop working. Enroll the replacement with a fresh data volume.`}
            </p>
            <button className="button secondary" disabled={busy} onClick={() => setConfirm(null)}>
              Cancel
            </button>{' '}
            <button
              className="button primary"
              disabled={busy}
              onClick={() =>
                void action(async () => {
                  if (confirm.action === 'replace')
                    setEnrollment(await request(`locations/${confirm.location.id}/enrollment`, {}));
                  else {
                    await request(`locations/${confirm.location.id}`, undefined, 'DELETE');
                    if (enrollment?.id === confirm.location.id) setEnrollment(null);
                  }
                  setConfirm(null);
                })
              }
            >
              Confirm {confirm.action}
            </button>
          </div>
        )}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const form = e.currentTarget;
            const data = new FormData(form);
            void action(async () => {
              setEnrollment(
                await request('locations', { name: data.get('name'), region: data.get('region') }),
              );
              form.reset();
            });
          }}
        >
          <h3>Add a location</h3>
          <label htmlFor="location-name">Location name</label>
          <input
            id="location-name"
            name="name"
            placeholder="Europe probe"
            required
            maxLength={80}
          />
          <label htmlFor="location-region">Region label</label>
          <input
            id="location-region"
            name="region"
            placeholder="Frankfurt, Germany"
            required
            maxLength={80}
          />
          <button className="button primary" disabled={busy}>
            Create enrollment
          </button>
        </form>
        {enrollment && (
          <section aria-label="Probe enrollment">
            <h3>Connect your probe</h3>
            <p className="field-hint">
              Use this one-time enrollment before{' '}
              {new Date(enrollment.expiresAt).toLocaleTimeString()}. The token is shown only here.
              On the regional server, install Docker Compose and open a checkout of this StillUp
              version, then run the command below.
            </p>
            <label htmlFor="probe-origin">Public StillUp URL (HTTPS)</label>
            <input
              id="probe-origin"
              type="url"
              value={origin}
              onChange={(e) => setOrigin(e.target.value)}
              placeholder="https://status.example.com"
            />
            {command ? (
              <>
                <pre className="probe-command">{command}</pre>
                <button
                  className="button secondary"
                  onClick={() =>
                    void navigator.clipboard
                      .writeText(command)
                      .catch(() =>
                        setError('Copy the command manually; clipboard access was blocked.'),
                      )
                  }
                >
                  Copy installation command
                </button>
              </>
            ) : (
              <p className="field-hint">
                Enter an HTTPS address that the regional server can reach. Localhost cannot be
                reached from another server.
              </p>
            )}
            <p className="field-hint">
              The first run builds the probe image. Its Docker volume stores its identity; keep that
              volume on restart. No inbound ports or database access are needed. Only assign checks
              whose request credentials you trust this server to use. Private-network access is
              blocked by default.
            </p>
          </section>
        )}
      </div>
    </dialog>
  );
}
export function LocationRouting({ monitor }: { monitor?: Monitor }) {
  const [locations, setLocations] = useState<ProbeLocation[]>([]);
  const [error, setError] = useState('');
  const [ids, setIds] = useState(monitor?.config.locationIds ?? ['local']);
  const [threshold, setThreshold] = useState(monitor?.config.locationFailureThreshold ?? 1);
  useEffect(() => {
    let active = true;
    request<ProbeLocation[]>('locations')
      .then((v) => {
        if (active) setLocations(v);
      })
      .catch((e) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
    };
  }, []);
  const all = [
    ...locations,
    ...ids
      .filter((id) => !locations.some((l) => l.id === id))
      .map((id) => ({
        id,
        name: id === 'local' ? 'Local probe' : 'Unavailable location',
        region: '',
        status: 'offline' as const,
        lastSeenAt: null,
        enrollmentExpiresAt: null,
      })),
  ];
  return (
    <section aria-label="Check locations">
      <h3>Locations</h3>
      {error && <p className="error-message">{error}</p>}
      <input type="hidden" name="locationIds" value={JSON.stringify(ids)} />
      {all.map((l) => (
        <label className="checkbox-label" key={l.id}>
          <input
            type="checkbox"
            checked={ids.includes(l.id)}
            disabled={l.status === 'revoked' && !ids.includes(l.id)}
            onChange={(e) => {
              const next = e.target.checked ? [...ids, l.id] : ids.filter((id) => id !== l.id);
              setIds(next);
              setThreshold(Math.min(threshold, Math.max(1, next.length)));
            }}
          />
          {l.name} {l.region && `· ${l.region}`} ({l.status})
        </label>
      ))}
      <label htmlFor="location-threshold">Failing locations needed for an outage</label>
      <input
        id="location-threshold"
        name="locationFailureThreshold"
        type="number"
        min={1}
        max={Math.max(1, ids.length)}
        value={threshold}
        onChange={(e) => setThreshold(Number(e.target.value))}
        required
      />
      <p className="field-hint">
        Each round runs from every selected location. The failure and recovery counts above apply to
        rounds. Offline or unavailable probes do not count as failures or recovery votes. Test
        request still runs only from the API server.
      </p>
    </section>
  );
}
export function RegionalResults({ monitor }: { monitor: Monitor }) {
  const [rows, setRows] = useState<RegionalObservation[]>([]);
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    let running = false;
    setRows([]);
    setError('');
    const refresh = async () => {
      if (running) return;
      running = true;
      try {
        const data = await request<RegionalObservation[]>(`checks/${monitor.id}/locations`);
        if (active) {
          setRows(data);
          setError('');
        }
      } catch (e) {
        if (active) setError((e as Error).message);
      } finally {
        running = false;
      }
    };
    void refresh();
    const timer = setInterval(refresh, 10000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [monitor.id, monitor.configRevision, monitor.enabled]);
  return (
    <section aria-label="Regional check results">
      <h3>Location results</h3>
      {error && <p className="error-message">{error}</p>}
      <ul className="location-list">
        {rows.map((r) => (
          <li key={r.locationId}>
            <div>
              <strong>{r.name}</strong>
              <span>
                {r.region} · probe {r.probeStatus}
              </span>
              <span>
                {!r.fresh
                  ? 'Awaiting fresh coverage'
                  : r.outcome === 'pass'
                    ? 'Passing'
                    : r.outcome === 'fail'
                      ? 'Failing'
                      : 'Could not execute'}
                {r.fresh && r.durationMs !== null ? ` · ${r.durationMs} ms` : ''}
                {r.fresh && r.statusCode ? ` · HTTP ${r.statusCode}` : ''}
              </span>
              <small>
                {r.checkedAt
                  ? new Date(r.checkedAt).toLocaleString()
                  : 'No observation in this round'}
              </small>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
