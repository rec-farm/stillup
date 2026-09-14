'use client';
import { useRef, useState, useEffect } from 'react';
import { X, ArrowRight, Globe2, Code2 } from 'lucide-react';
import { checkSchema, type Monitor } from '@stillup/core';
export function CheckForm({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (monitor: Monitor) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [method, setMethod] = useState('GET');
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError('');
    const form = new FormData(event.currentTarget);
    const number = (name: string) => Number(form.get(name));
    try {
      const config = checkSchema.parse({
        name: form.get('name'),
        url: form.get('url'),
        method,
        intervalSeconds: number('intervalSeconds'),
        timeoutMs: number('timeoutMs'),
        expectedStatus: number('expectedStatus'),
        maxResponseMs: form.get('maxResponseMs') ? number('maxResponseMs') : null,
        failureThreshold: number('failureThreshold'),
        recoveryThreshold: number('recoveryThreshold'),
        headers: JSON.parse(String(form.get('headers') || '{}')),
        body: String(form.get('body') || ''),
        jsonAssertions: JSON.parse(String(form.get('assertions') || '[]')),
        public: form.get('public') === 'on',
      });
      setBusy(true);
      const res = await fetch('/api/v1/checks', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(config),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      onCreated(data);
    } catch (error) {
      setError(
        error instanceof SyntaxError
          ? 'Headers and assertions must contain valid JSON.'
          : error instanceof Error
            ? error.message
            : 'Could not create check',
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <dialog
      ref={dialog}
      className="check-dialog"
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onClose();
      }}
    >
      <form onSubmit={submit}>
        <header className="dialog-header">
          <div>
            <span className="eyebrow">START MONITORING</span>
            <h2>Give your API a checkup.</h2>
          </div>
          <button
            type="button"
            className="icon-button"
            aria-label="Close check editor"
            onClick={onClose}
            disabled={busy}
          >
            <X size={20} />
          </button>
        </header>
        <div className="dialog-content">
          <div className="form-section-title">
            <Globe2 size={18} />
            <h3>Request</h3>
          </div>
          <label htmlFor="check-name">Check name</label>
          <input
            id="check-name"
            name="name"
            placeholder="Production API"
            maxLength={80}
            required
            autoFocus
          />
          <div className="request-fields">
            <div>
              <label htmlFor="method">Method</label>
              <select id="method" value={method} onChange={(e) => setMethod(e.target.value)}>
                {['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'].map((m) => (
                  <option key={m}>{m}</option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor="url">Endpoint URL</label>
              <input
                id="url"
                name="url"
                type="url"
                placeholder="https://api.example.com/health"
                required
              />
            </div>
          </div>
          <div className="form-grid">
            <div>
              <label htmlFor="interval">Run every</label>
              <select id="interval" name="intervalSeconds" defaultValue="60">
                <option value="30">30 seconds</option>
                <option value="60">1 minute</option>
                <option value="300">5 minutes</option>
                <option value="900">15 minutes</option>
                <option value="3600">1 hour</option>
              </select>
            </div>
            <div>
              <label htmlFor="timeout">Timeout (ms)</label>
              <input
                id="timeout"
                name="timeoutMs"
                type="number"
                min="100"
                max="30000"
                defaultValue="10000"
                required
              />
            </div>
          </div>
          <div className="form-section-title">
            <Code2 size={18} />
            <h3>Expectations</h3>
          </div>
          <div className="form-grid">
            <div>
              <label htmlFor="status-code">HTTP status</label>
              <input
                id="status-code"
                name="expectedStatus"
                type="number"
                min="100"
                max="599"
                defaultValue="200"
                required
              />
            </div>
            <div>
              <label htmlFor="latency">Response limit (ms)</label>
              <input
                id="latency"
                name="maxResponseMs"
                type="number"
                min="1"
                max="30000"
                placeholder="Optional"
              />
            </div>
            <div>
              <label htmlFor="failure-threshold">Failures to open incident</label>
              <input
                id="failure-threshold"
                name="failureThreshold"
                type="number"
                min="1"
                max="10"
                defaultValue="2"
                required
              />
            </div>
            <div>
              <label htmlFor="recovery-threshold">Passes to recover</label>
              <input
                id="recovery-threshold"
                name="recoveryThreshold"
                type="number"
                min="1"
                max="10"
                defaultValue="1"
                required
              />
            </div>
          </div>
          <details className="advanced">
            <summary>Headers, request body & JSON assertions</summary>
            <label htmlFor="headers">Headers (JSON object)</label>
            <textarea
              id="headers"
              name="headers"
              rows={3}
              placeholder={'{"Authorization": "Bearer {{API_TOKEN}}"}'}
            />
            <p className="field-hint">
              Use {'{{NAME}}'} for secrets supplied as CHECK_SECRET_NAME on the worker. Literal
              values are stored in the database.
            </p>
            {!['GET', 'HEAD'].includes(method) && (
              <>
                <label htmlFor="body">Request body</label>
                <textarea id="body" name="body" rows={3} placeholder={'{"example": true}'} />
              </>
            )}
            <label htmlFor="assertions">JSON assertions</label>
            <textarea
              id="assertions"
              name="assertions"
              rows={3}
              placeholder={'[{"path":"$.status","equals":"ok"}]'}
            />
            <p className="field-hint">
              Dot paths support object fields and array indexes, such as $.items.0.id.
            </p>
          </details>
          <label className="checkbox-label">
            <input name="public" type="checkbox" />
            <span>
              Show on public status page
              <small>
                Publishes this check’s name, health, and incident history. The URL stays private.
              </small>
            </span>
          </label>
          {!['GET', 'HEAD'].includes(method) && (
            <p className="field-hint">
              This request will run repeatedly. Use a dedicated test resource for requests that
              change data.
            </p>
          )}
          {error && (
            <p className="error-message" role="alert">
              {error}
            </p>
          )}
        </div>
        <footer className="dialog-footer">
          <button className="button secondary" type="button" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button className="button primary" disabled={busy}>
            {busy ? 'Creating…' : 'Create check'}
            <ArrowRight size={16} />
          </button>
        </footer>
      </form>
    </dialog>
  );
}
