'use client';
import { useRef, useState, useEffect } from 'react';
import { X, ArrowRight, Globe2, Code2 } from 'lucide-react';
import { checkSchema, type Monitor, type CheckResult } from '@stillup/core';
import { AssertionEditor } from './assertion-editor';
import { NotificationRouting } from './notification-routing';
import { LocationRouting } from './locations';
export function CheckForm({
  onClose,
  onSaved,
  monitor,
}: {
  onClose: () => void;
  onSaved: (monitor: Monitor) => void;
  monitor?: Monitor;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const resultPanel = useRef<HTMLElement>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState(false);
  const [preview, setPreview] = useState<CheckResult | null>(null);
  const submitting = useRef(false);
  const [method, setMethod] = useState(monitor?.config.method ?? 'GET');
  const [body, setBody] = useState(monitor?.config.body ?? '');
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  useEffect(() => {
    if (preview) resultPanel.current?.scrollIntoView({ block: 'center' });
  }, [preview]);
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting.current) return;
    const isTest = (event.nativeEvent as SubmitEvent).submitter?.getAttribute('value') === 'test';
    setError('');
    const form = new FormData(event.currentTarget);
    const number = (name: string) => Number(form.get(name));
    try {
      const parsed = checkSchema.safeParse({
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
        body: ['GET', 'HEAD'].includes(method) ? '' : body,
        jsonAssertions: JSON.parse(String(form.get('assertions') || '[]')),
        headerAssertions:
          form.get('headerAssertions') === '[]' && !monitor?.config.headerAssertions
            ? undefined
            : JSON.parse(String(form.get('headerAssertions') || '[]')),
        responseSchema: String(form.get('responseSchema') || '').trim()
          ? JSON.parse(String(form.get('responseSchema')))
          : undefined,
        notificationChannelIds:
          form.get('notificationRouting') === 'default'
            ? undefined
            : form.get('notificationRouting') === 'none'
              ? []
              : form.getAll('notificationChannelId'),
        reminderIntervalSeconds: form.get('reminderIntervalSeconds')
          ? number('reminderIntervalSeconds')
          : undefined,
        locationIds: JSON.parse(String(form.get('locationIds') || '["local"]')),
        locationFailureThreshold: Number(form.get('locationFailureThreshold') || 1),
        public: form.get('public') === 'on',
      });
      if (!parsed.success)
        throw new Error(
          parsed.error.issues
            .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
            .join('; '),
        );
      const config = parsed.data;
      submitting.current = true;
      setBusy(true);
      setTesting(isTest);
      if (isTest) setPreview(null);
      const res = await fetch(
        isTest
          ? '/api/v1/checks/test'
          : monitor
            ? `/api/v1/checks/${monitor.id}`
            : '/api/v1/checks',
        {
          method: !isTest && monitor ? 'PUT' : 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(
            !isTest && monitor ? { config, expectedRevision: monitor.configRevision } : config,
          ),
        },
      );
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      if (isTest) setPreview(data);
      else onSaved(data);
    } catch (error) {
      setError(
        error instanceof SyntaxError
          ? 'Headers and response schema must contain valid JSON.'
          : error instanceof Error
            ? error.message
            : 'Could not create check',
      );
    } finally {
      submitting.current = false;
      setBusy(false);
      setTesting(false);
    }
  }
  return (
    <dialog
      ref={dialog}
      className="check-dialog"
      aria-labelledby="check-editor-title"
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onClose();
      }}
    >
      <form onSubmit={submit} onChange={() => setPreview(null)}>
        <header className="dialog-header">
          <div>
            <span className="eyebrow">
              {monitor ? `EDIT CHECK · REVISION ${monitor.configRevision}` : 'START MONITORING'}
            </span>
            <h2 id="check-editor-title">
              {monitor ? `Edit ${monitor.config.name}` : 'Give your API a checkup.'}
            </h2>
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
        <fieldset className="dialog-content check-form-fields" disabled={busy}>
          {monitor && (
            <p className="edit-note">
              Saving starts a fresh evaluation. Earlier results and any open incident stay in
              history.{!monitor.enabled && ' This check will remain paused.'}
            </p>
          )}
          <div className="form-section-title">
            <Globe2 size={18} />
            <h3>Request</h3>
          </div>
          <label htmlFor="check-name">Check name</label>
          <input
            id="check-name"
            name="name"
            defaultValue={monitor?.config.name}
            placeholder="Production API"
            maxLength={80}
            required
            autoFocus
          />
          <div className="request-fields">
            <div>
              <label htmlFor="method">Method</label>
              <select
                id="method"
                value={method}
                onChange={(e) => setMethod(e.target.value as Monitor['config']['method'])}
              >
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
                defaultValue={monitor?.config.url}
                type="url"
                placeholder="https://api.example.com/health"
                required
              />
            </div>
          </div>
          <div className="form-grid">
            <div>
              <label htmlFor="interval">Run every</label>
              <select
                id="interval"
                name="intervalSeconds"
                defaultValue={monitor?.config.intervalSeconds ?? 60}
              >
                <option value="30">30 seconds</option>
                <option value="60">1 minute</option>
                <option value="300">5 minutes</option>
                <option value="900">15 minutes</option>
                <option value="3600">1 hour</option>
                <option value="86400">1 day</option>
                {monitor &&
                  ![30, 60, 300, 900, 3600, 86400].includes(monitor.config.intervalSeconds) && (
                    <option value={monitor.config.intervalSeconds}>
                      {monitor.config.intervalSeconds} seconds
                    </option>
                  )}
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
                defaultValue={monitor?.config.timeoutMs ?? 10000}
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
                defaultValue={monitor?.config.expectedStatus ?? 200}
                required
              />
            </div>
            <div>
              <label htmlFor="latency">Response limit (ms)</label>
              <input
                id="latency"
                name="maxResponseMs"
                defaultValue={monitor?.config.maxResponseMs ?? ''}
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
                defaultValue={monitor?.config.failureThreshold ?? 2}
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
                defaultValue={monitor?.config.recoveryThreshold ?? 1}
                required
              />
            </div>
          </div>
          <p className="field-hint">
            <a href="/docs/checks-and-assertions" target="_blank" rel="noreferrer">
              Guide to assertions and response schemas ↗
            </a>
          </p>
          <AssertionEditor kind="json" initial={monitor?.config.jsonAssertions} />
          <AssertionEditor kind="header" initial={monitor?.config.headerAssertions} />
          <details className="advanced" open={monitor?.config.responseSchema !== undefined}>
            <summary>JSON Schema validation</summary>
            <label htmlFor="response-schema">Response schema (optional)</label>
            <textarea
              id="response-schema"
              name="responseSchema"
              rows={6}
              maxLength={16384}
              defaultValue={
                monitor?.config.responseSchema !== undefined
                  ? JSON.stringify(monitor.config.responseSchema, null, 2)
                  : ''
              }
              placeholder={
                '{"type":"object","required":["status"],"properties":{"status":{"type":"string"}}}'
              }
            />
            <p className="field-hint">
              Draft-07 subset: type, properties, required, additionalProperties (boolean), items,
              enum (scalar values), minimum, maximum, minLength, maxLength, minItems, maxItems,
              title, description. Up to 16 KiB and 8 nested levels; references and regex patterns
              are not supported. Leave empty to disable.
            </p>
          </details>
          <details className="advanced">
            <summary>Request headers & body</summary>
            <label htmlFor="headers">Headers (JSON object)</label>
            <textarea
              id="headers"
              name="headers"
              defaultValue={monitor ? JSON.stringify(monitor.config.headers, null, 2) : ''}
              rows={3}
              placeholder={'{"Authorization": "Bearer {{API_TOKEN}}"}'}
            />
            <p className="field-hint">
              Use {'{{NAME}}'} for managed secrets or CHECK_SECRET_NAME environment values. Literal
              values are stored in the database.{' '}
              <a href="/docs/secrets" target="_blank" rel="noreferrer">
                Set up secret references ↗
              </a>
            </p>
            {!['GET', 'HEAD'].includes(method) && (
              <>
                <label htmlFor="body">Request body</label>
                <textarea
                  id="body"
                  name="body"
                  value={body}
                  onChange={(e) => setBody(e.target.value)}
                  rows={3}
                  placeholder={'{"example": true}'}
                />
              </>
            )}
          </details>
          <p className="field-hint">
            <a href="/docs/locations" target="_blank" rel="noreferrer">
              Regional locations guide ↗
            </a>{' '}
            ·{' '}
            <a href="/docs/notifications" target="_blank" rel="noreferrer">
              Alert routing guide ↗
            </a>
          </p>
          <LocationRouting monitor={monitor} />
          <NotificationRouting config={monitor?.config} />
          <label className="checkbox-label">
            <input name="public" type="checkbox" defaultChecked={monitor?.config.public ?? false} />
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
          <p className="field-hint">
            Test request sends one real {method} request from the API server using this draft. It
            does not save the check, change its health, or send alerts.
            {!['GET', 'HEAD'].includes(method) && ' This request can change data at the endpoint.'}
          </p>
          {preview && (
            <section ref={resultPanel} aria-label="Request test result" aria-live="polite">
              <h3>
                {preview.outcome === 'pass'
                  ? 'Test passed'
                  : preview.outcome === 'error'
                    ? 'Test could not run'
                    : 'Test failed'}
              </h3>
              <p className="field-hint">
                {preview.statusCode === null ? 'No HTTP response' : `HTTP ${preview.statusCode}`} ·{' '}
                {preview.durationMs} ms. Results from the last test; test again after changes.
                Response bodies and header values are not displayed.
              </p>
              <ul className="assertion-results">
                {preview.assertions?.length
                  ? preview.assertions.map((assertion, index) => (
                      <li key={index} data-passed={assertion.passed}>
                        <strong>
                          {assertion.passed ? 'Passed' : 'Failed'} · {assertion.kind}
                        </strong>
                        <span>{assertion.message}</span>
                      </li>
                    ))
                  : preview.failures.map((failure, index) => (
                      <li key={index} data-passed="false">
                        {failure}
                      </li>
                    ))}
              </ul>
            </section>
          )}
          {error && (
            <p className="error-message" role="alert">
              {error}
            </p>
          )}
        </fieldset>
        <footer className="dialog-footer check-editor-footer">
          <button className="button secondary" type="button" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button
            className="button secondary"
            type="submit"
            name="action"
            value="test"
            disabled={busy}
          >
            {testing ? 'Testing…' : 'Test request'}
          </button>
          <button
            className="button primary"
            type="submit"
            name="action"
            value="save"
            disabled={busy}
          >
            {busy && !testing
              ? monitor
                ? 'Saving…'
                : 'Creating…'
              : monitor
                ? 'Save changes'
                : 'Create check'}
            <ArrowRight size={16} />
          </button>
        </footer>
      </form>
    </dialog>
  );
}
