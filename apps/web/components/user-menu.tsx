import { useEffect, useRef, useState } from 'react';
import { ChevronDown, LogOut } from 'lucide-react';
import type { Me } from '@stillup/core';
import { ThemeSwitcher } from './theme-switcher';

/**
 * Top-bar account menu, same pattern as Paramtune: 32px square avatar, then identity, the theme
 * setting and sign out. Named users come from single sign-on; the installation token (and single
 * sign-on before any users exist) is shown as the installation administrator.
 */
export function UserMenu({ me, onSignOut }: { me: Me; onSignOut: () => void }) {
  const name = me.kind === 'user' ? (me.name ?? me.email) : 'Administrator';
  const detail =
    me.kind === 'user'
      ? `${me.name ? `${me.email} · ` : ''}${me.role === 'admin' ? 'Administrator' : 'Viewer'}`
      : 'Signed in to this installation';
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setOpen(false);
      triggerRef.current?.focus();
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  return (
    <div className="user-menu" ref={menuRef}>
      <button
        ref={triggerRef}
        type="button"
        className="user-menu-trigger"
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label={`Account menu for ${name}`}
        onClick={() => setOpen(!open)}
      >
        <span className="user-avatar">{name.slice(0, 1).toUpperCase()}</span>
        <ChevronDown size={16} aria-hidden="true" />
      </button>
      {open && (
        <div role="menu" className="user-menu-popover">
          <div className="user-menu-section">
            <strong>{name}</strong>
            <small>{detail}</small>
          </div>
          <div className="user-menu-section">
            <span className="label-stamp">Theme</span>
            <ThemeSwitcher />
          </div>
          <div className="user-menu-actions">
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                onSignOut();
              }}
            >
              <LogOut size={16} aria-hidden="true" />
              Sign out
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
