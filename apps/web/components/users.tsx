'use client';
import { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import type { Me, Role, User, UserList } from '@stillup/core';
import { notificationApi } from './notifications';

const roleLabels: Record<Role, string> = { admin: 'Administrator', viewer: 'Viewer' };
const date = (value: string) =>
  new Date(value).toLocaleDateString('en-GB', {
    timeZone: 'UTC',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });

export function UsersDialog({ me, onClose }: { me: Me; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [data, setData] = useState<UserList | null>(null);
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const reload = async () => setData(await notificationApi<UserList>('users'));
  useEffect(() => {
    dialog.current?.showModal();
    let active = true;
    void notificationApi<UserList>('users')
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
  async function run(change: () => Promise<unknown>, message: string) {
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
  async function add(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const email = String(form.get('email'));
    const added = await run(
      () =>
        notificationApi('users', {
          email,
          name: String(form.get('name') || '') || null,
          role: form.get('role'),
        }),
      `${email} can now sign in with single sign-on.`,
    );
    if (added) setAdding(false);
  }
  const self = (user: User) => me.kind === 'user' && me.id === user.id;
  const empty = data?.users.length === 0;
  return (
    <dialog
      ref={dialog}
      className="check-dialog notification-dialog"
      aria-labelledby="users-title"
      onCancel={(e) => {
        e.preventDefault();
        if (!busy) onClose();
      }}
    >
      <header className="dialog-header">
        <div>
          <span className="eyebrow">ACCESS</span>
          <h2 id="users-title">Users</h2>
        </div>
        <button className="icon-button" disabled={busy} aria-label="Close users" onClick={onClose}>
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
          People sign in with single sign-on using the email address you add here. Administrators
          manage everything. Viewers see checks, results and incidents, but cannot change them or
          open settings.
        </p>
        {data && !data.oidc && (
          <p className="error-message">
            Single sign-on is not set up, so users cannot sign in yet. Set OIDC_ISSUER and
            OIDC_CLIENT_ID on the API service. The installation token keeps working either way.
          </p>
        )}
        {empty && (
          <p className="field-hint">
            While this list is empty, everyone your identity provider admits signs in as an
            administrator. After you add the first person, only people on this list can sign in, and
            earlier sessions end. Add yourself first, as an administrator.
          </p>
        )}
        {!adding && (
          <button
            className="button primary"
            disabled={busy || !data}
            onClick={() => {
              setAdding(true);
              setError('');
            }}
          >
            Add user
          </button>
        )}
        {adding && (
          <form className="channel-form" onSubmit={add}>
            <h3>New user</h3>
            <label htmlFor="user-email">Email</label>
            <input
              autoFocus
              id="user-email"
              name="email"
              type="email"
              required
              maxLength={254}
              autoComplete="off"
              placeholder="ada@example.com"
            />
            <label htmlFor="user-name">Name (optional)</label>
            <input id="user-name" name="name" maxLength={200} autoComplete="off" />
            <label htmlFor="user-role">Role</label>
            <select id="user-role" name="role" defaultValue={empty ? 'admin' : 'viewer'}>
              <option value="admin">Administrator</option>
              <option value="viewer">Viewer</option>
            </select>
            <p className="field-hint">
              Their email at your identity provider must match. On first sign-in the account is
              linked to that identity, so a later email change there keeps access.
            </p>
            <div className="notification-actions">
              <button className="button primary" disabled={busy}>
                Add user
              </button>
              <button
                className="button secondary"
                type="button"
                disabled={busy}
                onClick={() => setAdding(false)}
              >
                Cancel
              </button>
            </div>
          </form>
        )}
        {!data ? (
          <p>Loading users…</p>
        ) : (
          data.users.map((user) => (
            <article className="notification-card user-card" key={user.id}>
              <div>
                <strong>
                  {user.name ?? user.email}
                  {self(user) && ' (you)'}
                </strong>
                <small>
                  {user.name ? `${user.email} · ` : ''}
                  {user.lastSignInAt
                    ? `Last signed in ${date(user.lastSignInAt)}`
                    : user.linked
                      ? 'Linked'
                      : `Invited ${date(user.createdAt)} · not signed in yet`}
                </small>
              </div>
              <label className="sr-only" htmlFor={`role-${user.id}`}>
                Role for {user.email}
              </label>
              <select
                id={`role-${user.id}`}
                value={user.role}
                disabled={busy}
                onChange={(e) => {
                  const role = e.target.value as Role;
                  void run(
                    () => notificationApi(`users/${user.id}`, { role }, 'PATCH'),
                    `${user.email} is now ${role === 'admin' ? 'an administrator' : 'a viewer'}.`,
                  );
                }}
              >
                {(['admin', 'viewer'] as const).map((role) => (
                  <option key={role} value={role}>
                    {roleLabels[role]}
                  </option>
                ))}
              </select>
              {removing === user.id ? (
                <div className="archive-note">
                  <p>
                    Remove {user.email}? {self(user) ? 'You' : 'They'} will be signed out
                    immediately and cannot sign in again unless added back.
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
                      onClick={() => {
                        void run(
                          () => notificationApi(`users/${user.id}`, {}, 'DELETE'),
                          `${user.email} was removed.`,
                        ).then(() => {
                          setRemoving(null);
                          if (self(user)) window.location.assign('/login');
                        });
                      }}
                    >
                      Remove user
                    </button>
                  </div>
                </div>
              ) : (
                <button
                  className="archive-link"
                  disabled={busy}
                  onClick={() => setRemoving(user.id)}
                >
                  Remove
                </button>
              )}
            </article>
          ))
        )}
      </div>
    </dialog>
  );
}
