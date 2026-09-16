'use client';
import { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import type { SecretOverview, SecretMetadata } from '@stillup/core';
import { notificationApi } from './notifications';
export function SecretsDialog({ onClose }: { onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [data, setData] = useState<SecretOverview | null>(null);
  const [editing, setEditing] = useState<SecretMetadata | 'new' | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const reload = async () => {
    const next = await notificationApi<SecretOverview>('secrets');
    setData(next);
    return next;
  };
  useEffect(() => {
    dialog.current?.showModal();
    let active = true;
    void notificationApi<SecretOverview>('secrets')
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
  async function edit(name: string) {
    setBusy(true);
    try {
      const next = await reload();
      setEditing(next.secrets.find((s) => s.name === name) ?? null);
      setError('');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function save(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setBusy(true);
    setError('');
    setNotice('');
    const current = editing && editing !== 'new' ? editing : null;
    try {
      await notificationApi(
        `secrets${current ? `/${current.name}` : ''}`,
        {
          name: form.get('name'),
          value: String(form.get('value') || '') || undefined,
          enabled: form.get('enabled') === 'on',
          ...(current ? { expectedRevision: current.revision } : {}),
        },
        current ? 'PUT' : 'POST',
      );
      setEditing(null);
      await reload();
      setNotice('Secret saved. Future executions use its current value.');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const current = editing && editing !== 'new' ? editing : null;
  return (
    <dialog
      ref={dialog}
      className="check-dialog notification-dialog"
      aria-labelledby="secrets-title"
      onCancel={(e) => {
        e.preventDefault();
        if (!busy) onClose();
      }}
    >
      <header className="dialog-header">
        <div>
          <span className="eyebrow">PRIVATE CREDENTIALS</span>
          <h2 id="secrets-title">Secrets</h2>
        </div>
        <button
          className="icon-button"
          disabled={busy}
          aria-label="Close secrets"
          onClick={onClose}
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
        {notice && <p role="status">{notice}</p>}
        <p>
          Use {'{{NAME}}'} in request headers, request bodies, or webhook destinations. Stored
          values are encrypted and never shown again. Rotation takes effect on future attempts;
          in-flight requests may finish with the prior value.
        </p>
        {data && !data.encryptionConfigured && (
          <p className="error-message">
            Set SECRETS_ENCRYPTION_KEY on the API and worker to enable stored secrets. Environment
            references continue to work.
          </p>
        )}
        <button
          className="button primary"
          disabled={busy || !data?.encryptionConfigured}
          onClick={() => {
            setEditing('new');
            setError('');
          }}
        >
          Add secret
        </button>
        {editing && (
          <form className="channel-form" key={current?.name ?? 'new'} onSubmit={save}>
            <h3>{current ? `Update ${current.name}` : 'New secret'}</h3>
            {!current && (
              <>
                <label htmlFor="secret-name">Name</label>
                <input
                  autoFocus
                  id="secret-name"
                  name="name"
                  required
                  maxLength={80}
                  pattern="[A-Z][A-Z0-9_]*"
                  placeholder="API_TOKEN"
                />
              </>
            )}
            <label htmlFor="secret-value">
              {current ? 'Replacement value (leave blank to keep)' : 'Secret value'}
            </label>
            <input
              id="secret-value"
              name="value"
              type="password"
              autoComplete="new-password"
              required={!current}
              maxLength={65536}
            />
            <label className="checkbox-label">
              <input name="enabled" type="checkbox" defaultChecked={current?.enabled ?? true} />
              Enabled
            </label>
            {current && (
              <p className="field-hint">
                Disabling this secret prevents its references from resolving. Dependent checks will
                report a configuration error; webhook deliveries will retry.
              </p>
            )}
            <div className="notification-actions">
              <button className="button primary" disabled={busy}>
                Save secret
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
        {!data ? (
          <p>Loading secrets…</p>
        ) : !data.secrets.length ? (
          <p>No secrets or references yet.</p>
        ) : (
          data.secrets.map((s) => (
            <article className="notification-card" key={s.name}>
              <strong>{s.name}</strong>
              <small>
                {s.source} · {s.enabled ? 'Enabled' : 'Unavailable'}
                {s.revision ? ` · Revision ${s.revision}` : ''}
              </small>
              <code>{`{{${s.name}}}`}</code>
              {s.source === 'database' && (
                <button
                  className="button secondary"
                  disabled={busy || !data.encryptionConfigured}
                  onClick={() => void edit(s.name)}
                >
                  Update {s.name}
                </button>
              )}
              {s.source === 'environment' && (
                <p className="field-hint">
                  Managed through CHECK_SECRET_{s.name}; restart the worker after changing it.
                </p>
              )}
              {s.source === 'missing' && (
                <p className="error-message">This reference has no configured value.</p>
              )}
              <h4>Used by</h4>
              {s.usages.length ? (
                <ul>
                  {s.usages.map((u) => (
                    <li key={`${u.kind}:${u.id}`}>
                      {u.name} · {u.kind}
                      {u.archived ? ' (archived)' : ''}
                    </li>
                  ))}
                </ul>
              ) : (
                <p>No current references.</p>
              )}
            </article>
          ))
        )}
      </div>
    </dialog>
  );
}
