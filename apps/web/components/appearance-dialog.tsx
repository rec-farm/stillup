'use client';
import { WatchfulArt } from './watchful-art';
import { EyeMark } from './eye-mark';
import { useEffect, useRef, useState } from 'react';
import { Check, Palette, RotateCcw, X } from 'lucide-react';
import {
  defaultWorkspaceSettings,
  workspaceSettingsSchema,
  type WorkspaceAppearance,
  type WorkspaceSettings,
} from '@stillup/core';
import { useWorkspace } from './workspace-provider';
import { notificationApi } from './notifications';

export function AppearanceDialog({ onClose }: { onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const { update } = useWorkspace();
  const [loaded, setLoaded] = useState<WorkspaceAppearance | null>(null);
  const [draft, setDraft] = useState<WorkspaceSettings>(defaultWorkspaceSettings);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [failedLogo, setFailedLogo] = useState('');
  const patch = (change: Partial<WorkspaceSettings>) =>
    setDraft((current) => ({ ...current, ...change }));
  useEffect(() => {
    dialog.current?.showModal();
    let active = true;
    notificationApi<WorkspaceAppearance>('workspace')
      .then((data) => {
        if (active) {
          setLoaded(data);
          setDraft(data.settings);
        }
      })
      .catch((e) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
    };
  }, []);
  const parsed = workspaceSettingsSchema.safeParse(draft);
  const safeLogo =
    workspaceSettingsSchema.shape.logoUrl.safeParse(draft.logoUrl).success &&
    draft.logoUrl &&
    draft.logoUrl !== failedLogo;
  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (!loaded) return;
    if (!parsed.success) {
      setError(parsed.error.issues.map((issue) => issue.message).join('. '));
      return;
    }
    setBusy(true);
    setError('');
    try {
      const result = await notificationApi<WorkspaceAppearance>(
        'workspace',
        { config: parsed.data, expectedRevision: loaded.revision },
        'PUT',
      );
      update(result.settings);
      document.title = `${result.settings.name} · API monitoring`;
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unable to save appearance');
    } finally {
      setBusy(false);
    }
  }
  return (
    <dialog
      ref={dialog}
      className="check-dialog appearance-dialog"
      aria-labelledby="appearance-title"
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onClose();
      }}
    >
      <form onSubmit={save}>
        <header className="dialog-header">
          <div>
            <span className="eyebrow">Make yourself at home</span>
            <h2 id="appearance-title">Your workspace. Your identity.</h2>
            <p>Set the look for everyone on this installation.</p>
          </div>
          <button
            type="button"
            className="icon-button"
            aria-label="Close appearance editor"
            disabled={busy}
            onClick={onClose}
          >
            <X size={20} />
          </button>
        </header>
        {error && (
          <p className="error-message appearance-error" role="alert">
            {error}
          </p>
        )}
        {!loaded ? (
          <p className="appearance-loading" role="status">
            {error ? 'Close and reopen the editor to try again.' : 'Loading workspace appearance…'}
          </p>
        ) : (
          <div className="appearance-body">
            <fieldset className="appearance-fields" disabled={busy}>
              <div className="appearance-section-label">
                <Palette size={16} />
                <h3>Brand identity</h3>
              </div>
              <label htmlFor="workspace-name">Company or workspace name</label>
              <input
                id="workspace-name"
                value={draft.name}
                maxLength={60}
                required
                onChange={(e) => patch({ name: e.target.value })}
              />
              <label htmlFor="workspace-tagline">Welcome message</label>
              <textarea
                id="workspace-tagline"
                value={draft.tagline}
                rows={2}
                maxLength={160}
                onChange={(e) => patch({ tagline: e.target.value })}
              />
              <label htmlFor="workspace-logo">
                Logo URL <span className="optional-label">Optional</span>
              </label>
              <input
                id="workspace-logo"
                type="url"
                placeholder="https://company.com/logo.svg"
                value={draft.logoUrl}
                onChange={(e) => patch({ logoUrl: e.target.value })}
                aria-describedby="logo-hint"
              />
              <p id="logo-hint" className="field-hint">
                Use a public HTTPS image. A square logo works best. This identity is also visible on
                sign-in.
              </p>
              {draft.logoUrl && failedLogo === draft.logoUrl && (
                <p className="field-hint" role="status">
                  That logo could not be loaded. Check its URL; the StillUp mark will be used as a
                  fallback.
                </p>
              )}
              <label htmlFor="workspace-density">Dashboard spacing</label>
              <select
                id="workspace-density"
                value={draft.density}
                onChange={(e) => patch({ density: e.target.value as WorkspaceSettings['density'] })}
              >
                <option value="comfortable">Comfortable · room to breathe</option>
                <option value="compact">Compact · more checks at a glance</option>
              </select>
            </fieldset>
            <aside className="appearance-preview-area">
              <div className="preview-caption">
                <span className="eyebrow">Live preview</span>
                <span>Unsaved changes</span>
              </div>
              <div className="appearance-preview" data-density={draft.density}>
                <div className="preview-rail">
                  <span className="preview-logo">
                    {safeLogo ? (
                      <img
                        src={draft.logoUrl}
                        width={26}
                        height={26}
                        alt=""
                        onError={() => setFailedLogo(draft.logoUrl)}
                      />
                    ) : (
                      <EyeMark className="preview-eye" />
                    )}
                  </span>
                  <span className="preview-rail-line" />
                  <span className="preview-rail-line" />
                  <span className="preview-rail-line" />
                </div>
                <div className="preview-main">
                  <span className="preview-name">{draft.name || 'Your workspace'}</span>
                  <h3>
                    Overview<span className="period">.</span>
                  </h3>
                  <p>{draft.tagline || 'Your monitoring workspace'}</p>
                  <WatchfulArt className="preview-art" />
                  <div className="preview-banner">
                    <Check size={14} />
                    All systems operational
                  </div>
                  <div className="preview-metrics">
                    <div>
                      <small>Healthy</small>
                      <strong>12</strong>
                    </div>
                    <div>
                      <small>Failing</small>
                      <strong>0</strong>
                    </div>
                  </div>
                  <div className="preview-row">
                    <span className="tiny-dot" />
                    Production API<span>Healthy</span>
                  </div>
                  <div className="preview-row">
                    <span className="tiny-dot" />
                    Payments<span>Healthy</span>
                  </div>
                  <span className="preview-button">Create check</span>
                </div>
              </div>
              <p className="preview-footnote">
                Illustrative data. Saving updates the dashboard and sign-in screen for your team.
              </p>
              <div className="appearance-public-note">
                <strong>Customer-facing status page</strong>
                <p>
                  Its logo, colors, and messaging are configured separately in “Customize status
                  page”.
                </p>
              </div>
            </aside>
          </div>
        )}
        <footer className="dialog-footer appearance-footer">
          <button
            type="button"
            className="button appearance-reset"
            disabled={busy || !loaded}
            onClick={() =>
              // The workspace accent no longer drives the UI; keep whatever is stored.
              setDraft((current) => ({
                ...defaultWorkspaceSettings,
                accentColor: current.accentColor,
              }))
            }
          >
            <RotateCcw size={14} />
            Reset draft
          </button>
          <button type="button" className="button secondary" disabled={busy} onClick={onClose}>
            Cancel
          </button>
          <button className="button primary" disabled={busy || !loaded}>
            {busy ? 'Saving…' : 'Save appearance'}
          </button>
        </footer>
      </form>
    </dialog>
  );
}
