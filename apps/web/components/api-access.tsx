'use client';
import { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import type { ApiKey, CredentialRole, TrustedPublisher } from '@stillup/core';
import { version as cliVersion } from '../../cli/package.json';
import {
  githubWorkflow,
  newWorkflowUrl,
  repositoryName,
  workflowName,
} from '../lib/github-workflow';
import { notificationApi } from './notifications';

const roleLabels: Record<CredentialRole, string> = {
  viewer: 'Read only',
  deployer: 'Deploy',
  admin: 'Administrator',
};
const roleHints: Record<CredentialRole, string> = {
  viewer:
    'Reads the dashboard, checks, results and incidents. Request headers and bodies stay hidden.',
  deployer:
    'Tests, previews and applies monitoring as code, nothing else. It can use any managed secret in the checks it deploys.',
  admin:
    'Everything an administrator can do in StillUp, except managing users and API access. Prefer a narrower key.',
};
const date = (value: string) =>
  new Date(value).toLocaleDateString('en-GB', {
    timeZone: 'UTC',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
const projectList = (value: FormDataEntryValue | null) =>
  String(value ?? '')
    .split(/[\s,]+/)
    .filter(Boolean);
const used = (value: string | null) => (value ? `Last used ${date(value)}` : 'Not used yet');

type KeyList = { keys: ApiKey[] };
type PublisherList = { publishers: TrustedPublisher[]; audience: string };
type Connected = { publisher: TrustedPublisher; config: string };

export function ApiAccessDialog({ onClose }: { onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [keys, setKeys] = useState<ApiKey[] | null>(null);
  const [publishers, setPublishers] = useState<TrustedPublisher[] | null>(null);
  const [form, setForm] = useState<'key' | 'publisher' | null>(null);
  const [role, setRole] = useState<CredentialRole>('deployer');
  const [revealed, setRevealed] = useState<{ name: string; token: string } | null>(null);
  const [connected, setConnected] = useState<Connected | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const [origin, setOrigin] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const reload = async () => {
    const [k, p] = await Promise.all([
      notificationApi<KeyList>('api-keys'),
      notificationApi<PublisherList>('trusted-publishers'),
    ]);
    setKeys(k.keys);
    setPublishers(p.publishers);
  };
  useEffect(() => {
    dialog.current?.showModal();
    setOrigin(window.location.origin);
    let active = true;
    Promise.all([
      notificationApi<KeyList>('api-keys'),
      notificationApi<PublisherList>('trusted-publishers'),
    ])
      .then(([k, p]) => {
        if (!active) return;
        setKeys(k.keys);
        setPublishers(p.publishers);
      })
      .catch((e) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
    };
  }, []);
  async function run(change: () => Promise<unknown>, message = '') {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await change();
      await reload();
      setNotice(message);
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  }
  const copy = (value: string) =>
    void navigator.clipboard
      .writeText(value)
      .then(() => setNotice('Copied.'))
      .catch(() => setError('Copy it manually; clipboard access was blocked.'));

  async function createKey(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const name = String(data.get('name')).trim();
    const days = String(data.get('expires'));
    await run(async () => {
      const created = await notificationApi<{ key: ApiKey; token: string }>('api-keys', {
        name,
        role,
        projects: role === 'deployer' ? projectList(data.get('projects')) : [],
        expiresInDays: days === 'never' ? null : Number(days),
      });
      setRevealed({ name: created.key.name, token: created.token });
      setForm(null);
    });
  }
  async function createPublisher(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const repository = repositoryName(String(data.get('repository')));
    if (!repository) {
      setError('Enter the repository as owner/name, e.g. acme/api, or paste its GitHub URL.');
      return;
    }
    const config = String(data.get('config')).trim() || 'stillup.config.ts';
    await run(async () => {
      const publisher = await notificationApi<TrustedPublisher>('trusted-publishers', {
        repository,
        workflow: workflowName(String(data.get('workflow'))),
        branch: String(data.get('branch')),
        environment: String(data.get('environment')),
        projects: projectList(data.get('projects')),
      });
      setConnected({ publisher, config });
      setForm(null);
    });
  }

  let stillupUrl = '';
  try {
    const url = new URL(origin);
    if (url.protocol === 'https:' && url.pathname === '/' && !url.search && !url.hash)
      stillupUrl = `${url.origin}/api`;
  } catch {
    /* Keep the workflow hidden until an HTTPS origin GitHub can reach is supplied. */
  }
  const workflow =
    connected && stillupUrl
      ? githubWorkflow({
          stillupUrl,
          branch: connected.publisher.branch,
          environment: connected.publisher.environment,
          config: connected.config,
          cliVersion,
        })
      : '';

  return (
    <dialog
      ref={dialog}
      className="check-dialog notification-dialog api-access-dialog"
      aria-labelledby="api-access-title"
      onCancel={(e) => {
        e.preventDefault();
        if (!busy) onClose();
      }}
    >
      <header className="dialog-header">
        <div>
          <span className="eyebrow">ACCESS</span>
          <h2 id="api-access-title">API access</h2>
        </div>
        <button
          className="icon-button"
          disabled={busy}
          aria-label="Close API access"
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
          Give other apps and automation their own access instead of the installation token. Each
          one can be limited and revoked on its own.
        </p>

        <div className="section-heading">
          <h3>GitHub Actions</h3>
        </div>
        <p className="field-hint">
          Let a workflow deploy monitoring as code. GitHub vouches for each run, so no key is stored
          in GitHub. Each run gets access for 15 minutes, only to the projects you name.
        </p>
        {publishers?.map((p) => (
          <article className="notification-card user-card" key={p.id}>
            <div>
              <strong>
                {p.repository} · {p.workflow}
              </strong>
              <small>
                {[
                  p.branch ? `Branch ${p.branch}` : 'Any branch',
                  p.environment ? `environment ${p.environment}` : 'any environment',
                  `${p.projects.length === 1 ? 'project' : 'projects'} ${p.projects.join(', ')}`,
                ].join(' · ')}
              </small>
              <small>
                {used(p.lastUsedAt)} · Added by {p.createdBy}
              </small>
            </div>
            {removing === p.id ? (
              <div className="archive-note">
                <p>
                  Stop trusting {p.workflow} in {p.repository}? Its runs can no longer deploy, and
                  access it already received ends now.
                </p>
                <div className="notification-actions">
                  <button
                    className="button secondary"
                    disabled={busy}
                    onClick={() => setRemoving(null)}
                  >
                    Cancel
                  </button>
                  <button
                    className="button secondary"
                    disabled={busy}
                    onClick={() =>
                      void run(
                        () => notificationApi(`trusted-publishers/${p.id}`, {}, 'DELETE'),
                        `${p.repository} can no longer deploy.`,
                      ).then(() => {
                        setRemoving(null);
                        if (connected?.publisher.id === p.id) setConnected(null);
                      })
                    }
                  >
                    Remove workflow
                  </button>
                </div>
              </div>
            ) : (
              <button className="archive-link" disabled={busy} onClick={() => setRemoving(p.id)}>
                Remove
              </button>
            )}
          </article>
        ))}
        {form !== 'publisher' && (
          <button
            className="button primary"
            disabled={busy || !publishers}
            onClick={() => {
              setForm('publisher');
              setConnected(null);
              setError('');
            }}
          >
            Connect a repository
          </button>
        )}
        {form === 'publisher' && (
          <form className="channel-form" onSubmit={createPublisher}>
            <h3>Connect a GitHub repository</h3>
            <label htmlFor="publisher-repository">Repository</label>
            <input
              autoFocus
              id="publisher-repository"
              name="repository"
              required
              maxLength={200}
              autoComplete="off"
              placeholder="acme/api"
            />
            <p className="field-hint">owner/name, or paste the repository’s GitHub URL.</p>
            <label htmlFor="publisher-projects">Projects</label>
            <input
              id="publisher-projects"
              name="projects"
              required
              maxLength={1400}
              autoComplete="off"
              placeholder="api-production"
            />
            <p className="field-hint">
              The <code>project</code> in its StillUp configuration. Separate several with commas.
            </p>
            <label htmlFor="publisher-workflow">Workflow file</label>
            <input
              id="publisher-workflow"
              name="workflow"
              required
              maxLength={255}
              defaultValue="monitoring.yml"
            />
            <p className="field-hint">In .github/workflows. Only this workflow may deploy.</p>
            <label htmlFor="publisher-branch">Branch</label>
            <input id="publisher-branch" name="branch" maxLength={255} defaultValue="main" />
            <p className="field-hint">
              Only runs on this branch may deploy, so pull requests cannot. Leave empty for any
              branch.
            </p>
            <label htmlFor="publisher-environment">GitHub environment (recommended)</label>
            <input
              id="publisher-environment"
              name="environment"
              maxLength={255}
              autoComplete="off"
              placeholder="production"
            />
            <p className="field-hint">
              Only jobs in this environment may deploy. In GitHub you can require a reviewer to
              approve each deploy.
            </p>
            <label htmlFor="publisher-config">Configuration file</label>
            <input
              id="publisher-config"
              name="config"
              maxLength={255}
              defaultValue="stillup.config.ts"
            />
            <p className="field-hint">Used only to write the workflow for you.</p>
            <div className="notification-actions">
              <button className="button primary" disabled={busy}>
                Connect repository
              </button>
              <button
                className="button secondary"
                type="button"
                disabled={busy}
                onClick={() => setForm(null)}
              >
                Cancel
              </button>
            </div>
          </form>
        )}
        {connected && (
          <section className="channel-form" aria-label="Finish in GitHub">
            <h3>Finish in GitHub</h3>
            {connected.publisher.environment && (
              <>
                <h4>1. Create the {connected.publisher.environment} environment</h4>
                <p className="field-hint">
                  <a
                    href={`https://github.com/${connected.publisher.repository}/settings/environments`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Open the repository’s environments
                  </a>
                  , add {connected.publisher.environment}, and optionally require reviewers.
                </p>
              </>
            )}
            <h4>{connected.publisher.environment ? '2.' : '1.'} Add the workflow</h4>
            <label htmlFor="publisher-origin">Public StillUp URL (HTTPS)</label>
            <input
              id="publisher-origin"
              type="url"
              value={origin}
              onChange={(e) => setOrigin(e.target.value)}
              placeholder="https://status.example.com"
            />
            {workflow ? (
              <>
                <pre className="probe-command">{workflow}</pre>
                <div className="notification-actions">
                  <a
                    className="button primary"
                    href={newWorkflowUrl(
                      connected.publisher.repository,
                      connected.publisher.branch,
                      connected.publisher.workflow,
                      workflow,
                    )}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Create it on GitHub
                  </a>
                  <button className="button secondary" onClick={() => copy(workflow)}>
                    Copy workflow
                  </button>
                </div>
              </>
            ) : (
              <p className="field-hint">
                Enter an HTTPS address that GitHub’s runners can reach. Localhost cannot be reached
                from GitHub.
              </p>
            )}
            <h4>{connected.publisher.environment ? '3.' : '2.'} Push and watch it run</h4>
            <p className="field-hint">
              The first run links this rule to the repository, so a different repository created
              later under the same name cannot deploy. If a run is refused, its log says why.
            </p>
            <div className="notification-actions">
              <button className="button secondary" onClick={() => setConnected(null)}>
                Done
              </button>
            </div>
          </section>
        )}

        <div className="section-heading notification-heading">
          <h3>API keys</h3>
        </div>
        <p className="field-hint">
          For other apps, scripts and CI services. Send the key as{' '}
          <code>Authorization: Bearer &lt;key&gt;</code>, or set it as <code>STILLUP_TOKEN</code>{' '}
          for the StillUp CLI.
        </p>
        {revealed && (
          <section className="channel-form" aria-label="New API key">
            <h3>Copy the key for {revealed.name}</h3>
            <p className="field-hint">
              StillUp shows it only now and stores only a fingerprint. Keep it in your app’s secret
              store.
            </p>
            <pre className="probe-command">{revealed.token}</pre>
            <div className="notification-actions">
              <button className="button primary" onClick={() => copy(revealed.token)}>
                Copy key
              </button>
              <button className="button secondary" onClick={() => setRevealed(null)}>
                Done
              </button>
            </div>
          </section>
        )}
        {keys?.map((k) => (
          <article className="notification-card user-card" key={k.id}>
            <div>
              <strong>{k.name}</strong>
              <small>
                {roleLabels[k.role]}
                {k.role === 'deployer' &&
                  (k.projects ? ` · projects ${k.projects.join(', ')}` : ' · every project')}{' '}
                · <code>{k.hint}…</code>
              </small>
              <small>
                {used(k.lastUsedAt)} ·{' '}
                {k.expiresAt
                  ? `${new Date(k.expiresAt) < new Date() ? 'Expired' : 'Expires'} ${date(k.expiresAt)}`
                  : 'Never expires'}{' '}
                · Created by {k.createdBy} on {date(k.createdAt)}
              </small>
            </div>
            {removing === k.id ? (
              <div className="archive-note">
                <p>Revoke {k.name}? Apps using it lose access immediately.</p>
                <div className="notification-actions">
                  <button
                    className="button secondary"
                    disabled={busy}
                    onClick={() => setRemoving(null)}
                  >
                    Cancel
                  </button>
                  <button
                    className="button secondary"
                    disabled={busy}
                    onClick={() =>
                      void run(
                        () => notificationApi(`api-keys/${k.id}`, {}, 'DELETE'),
                        `${k.name} was revoked.`,
                      ).then(() => setRemoving(null))
                    }
                  >
                    Revoke key
                  </button>
                </div>
              </div>
            ) : (
              <button className="archive-link" disabled={busy} onClick={() => setRemoving(k.id)}>
                Revoke
              </button>
            )}
          </article>
        ))}
        {form !== 'key' && (
          <button
            className="button primary"
            disabled={busy || !keys}
            onClick={() => {
              setForm('key');
              setRevealed(null);
              setError('');
            }}
          >
            Create API key
          </button>
        )}
        {form === 'key' && (
          <form className="channel-form" onSubmit={createKey}>
            <h3>New API key</h3>
            <label htmlFor="key-name">Name</label>
            <input
              autoFocus
              id="key-name"
              name="name"
              required
              maxLength={80}
              autoComplete="off"
              placeholder="Status board"
            />
            <label htmlFor="key-role">Access</label>
            <select
              id="key-role"
              value={role}
              onChange={(e) => setRole(e.target.value as CredentialRole)}
            >
              {(['viewer', 'deployer', 'admin'] as const).map((r) => (
                <option key={r} value={r}>
                  {roleLabels[r]}
                </option>
              ))}
            </select>
            <p className="field-hint">{roleHints[role]}</p>
            {role === 'deployer' && (
              <>
                <label htmlFor="key-projects">Projects (optional)</label>
                <input
                  id="key-projects"
                  name="projects"
                  maxLength={1400}
                  autoComplete="off"
                  placeholder="api-production"
                />
                <p className="field-hint">
                  Limit it to these monitoring-as-code projects. Leave empty for every project.
                </p>
              </>
            )}
            <label htmlFor="key-expires">Expires</label>
            <select id="key-expires" name="expires" defaultValue="90">
              <option value="30">In 30 days</option>
              <option value="90">In 90 days</option>
              <option value="365">In a year</option>
              <option value="never">Never</option>
            </select>
            <div className="notification-actions">
              <button className="button primary" disabled={busy}>
                Create key
              </button>
              <button
                className="button secondary"
                type="button"
                disabled={busy}
                onClick={() => setForm(null)}
              >
                Cancel
              </button>
            </div>
          </form>
        )}
      </div>
    </dialog>
  );
}
