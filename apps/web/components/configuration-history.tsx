'use client';
import { useEffect, useRef, useState } from 'react';
import { History, X } from 'lucide-react';
import type { CheckRevision, Monitor, RevisionPage } from '@stillup/core';

function timestamp(value: string) {
  return new Date(value).toLocaleString('en-GB', { timeZone: 'UTC' }) + ' UTC';
}
async function fetchJson<T>(path: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(`/api/v1/${path}`, { signal });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Could not load configuration history');
  return data;
}
export function ConfigurationHistory({
  monitor,
  onView,
}: {
  monitor: Monitor;
  onView: (revision: number) => void;
}) {
  const [page, setPage] = useState<RevisionPage>({ revisions: [], nextBefore: null });
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    setBusy(true);
    setError('');
    setPage({ revisions: [], nextBefore: null });
    fetchJson<RevisionPage>(`checks/${monitor.id}/revisions`, controller.signal)
      .then(setPage)
      .catch((e) => {
        if (!controller.signal.aborted) setError(e.message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setBusy(false);
      });
    return () => controller.abort();
  }, [monitor.id, monitor.configRevision]);
  async function more() {
    setBusy(true);
    setError('');
    try {
      const next = await fetchJson<RevisionPage>(
        `checks/${monitor.id}/revisions?before=${page.nextBefore}`,
      );
      setPage((previous) => ({
        revisions: [...previous.revisions, ...next.revisions],
        nextBefore: next.nextBefore,
      }));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load history');
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="configuration-history" aria-label="Configuration history">
      <p className="history-note">
        Each version preserves the configuration used at that time. Pausing and archiving do not
        change it.
      </p>
      {page.revisions.map((revision) => (
        <button
          className="revision-row"
          key={revision.revision}
          onClick={() => onView(revision.revision)}
        >
          <History size={17} />
          <span>
            <strong>
              Revision {revision.revision}
              {revision.revision === monitor.configRevision && <em>Current</em>}
            </strong>
            <small>
              {revision.revision === 1 ? 'Check created' : 'Configuration updated'} ·{' '}
              {timestamp(revision.createdAt)}
            </small>
          </span>
          <span>View →</span>
        </button>
      ))}
      {error && (
        <p className="error-message" role="alert">
          {error}
        </p>
      )}
      {busy && (
        <p className="muted" role="status">
          Loading history…
        </p>
      )}
      {page.nextBefore && (
        <button className="button secondary" disabled={busy} onClick={() => void more()}>
          Load older revisions
        </button>
      )}
    </section>
  );
}
export function RevisionViewer({
  monitorId,
  revision,
  onClose,
}: {
  monitorId: string;
  revision: number;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [data, setData] = useState<CheckRevision | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    fetchJson<CheckRevision>(`checks/${monitorId}/revisions/${revision}`, controller.signal)
      .then(setData)
      .catch((e) => {
        if (!controller.signal.aborted) setError(e.message);
      });
    return () => controller.abort();
  }, [monitorId, revision]);
  return (
    <dialog
      ref={dialog}
      className="check-dialog revision-dialog"
      aria-labelledby="revision-title"
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
    >
      <header className="dialog-header">
        <div>
          <span className="eyebrow">CONFIGURATION SNAPSHOT</span>
          <h2 id="revision-title">Revision {revision}</h2>
        </div>
        <button className="icon-button" aria-label="Close configuration snapshot" onClick={onClose}>
          <X size={20} />
        </button>
      </header>
      <div className="dialog-content">
        {error ? (
          <p className="error-message" role="alert">
            {error}
          </p>
        ) : !data ? (
          <p role="status">Loading configuration…</p>
        ) : (
          <>
            <h3 className="snapshot-name">{data.config.name}</h3>
            <p className="history-note">
              Saved {timestamp(data.createdAt)}. This snapshot is read-only.
            </p>
            <dl className="check-config">
              <div>
                <dt>Endpoint</dt>
                <dd>
                  {data.config.method} {data.config.url}
                </dd>
              </div>
              <div>
                <dt>Interval</dt>
                <dd>{data.config.intervalSeconds} seconds</dd>
              </div>
              <div>
                <dt>Expected status</dt>
                <dd>HTTP {data.config.expectedStatus}</dd>
              </div>
              <div>
                <dt>Timeout</dt>
                <dd>{data.config.timeoutMs} ms</dd>
              </div>
              <div>
                <dt>Response limit</dt>
                <dd>
                  {data.config.maxResponseMs === null ? 'None' : `${data.config.maxResponseMs} ms`}
                </dd>
              </div>
              <div>
                <dt>Failure / recovery threshold</dt>
                <dd>
                  {data.config.failureThreshold} / {data.config.recoveryThreshold}
                </dd>
              </div>
              <div>
                <dt>Public visibility at this revision</dt>
                <dd>{data.config.public ? 'Published' : 'Private'}</dd>
              </div>
            </dl>
            <details className="advanced">
              <summary>View complete configuration</summary>
              <pre className="config-json">{JSON.stringify(data.config, null, 2)}</pre>
            </details>
            <p className="history-note">
              Secret references are preserved; the worker’s environment secret values are not
              recorded in snapshots.
            </p>
          </>
        )}
      </div>
      <footer className="dialog-footer">
        <button className="button secondary" onClick={onClose}>
          Close
        </button>
      </footer>
    </dialog>
  );
}
