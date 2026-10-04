import { useEffect, useRef, useState } from 'react';
import { ChevronDown, LogOut } from 'lucide-react';
import { ThemeSwitcher } from './theme-switcher';

/**
 * Top-bar account menu, same pattern as Paramtune: 32px square avatar, then identity, the theme
 * setting and sign out. StillUp has a single administrator, reached with the installation's
 * ADMIN_TOKEN or through single sign-on (OIDC, e.g. Handstamp), so the identity is the
 * administrator rather than a named user.
 */
export function UserMenu({ onSignOut }: { onSignOut: () => void }) {
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
        aria-label="Account menu for Administrator"
        onClick={() => setOpen(!open)}
      >
        <span className="user-avatar">A</span>
        <ChevronDown size={16} aria-hidden="true" />
      </button>
      {open && (
        <div role="menu" className="user-menu-popover">
          <div className="user-menu-section">
            <strong>Administrator</strong>
            <small>Signed in to this installation</small>
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
