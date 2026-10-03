// REC themes (BRAND §9 Settings): Dark (default) · Paper · System. The choice lives in a cookie
// so the server renders Dark and Paper directly; only System is resolved in the browser.

export type Theme = 'dark' | 'light';
export type ThemeChoice = Theme | 'system';
export const THEME_COOKIE = 'stillup-theme';

export function parseThemeChoice(value: string | undefined): ThemeChoice {
  return value === 'light' || value === 'system' ? value : 'dark';
}

export function resolveTheme(choice: ThemeChoice): Theme {
  if (choice !== 'system') return choice;
  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

export function readThemeChoice(): ThemeChoice {
  const match = document.cookie.match(new RegExp(`(?:^|; )${THEME_COOKIE}=([^;]*)`));
  return parseThemeChoice(match?.[1]);
}

const CHANGE_EVENT = 'stillup-theme-change';

export function applyThemeChoice(choice: ThemeChoice) {
  document.cookie = `${THEME_COOKIE}=${choice}; path=/; max-age=31536000; samesite=lax`;
  document.documentElement.dataset.theme = resolveTheme(choice);
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

// useSyncExternalStore subscription: every switcher on the page stays in sync.
export function subscribeThemeChoice(onChange: () => void) {
  window.addEventListener(CHANGE_EVENT, onChange);
  return () => window.removeEventListener(CHANGE_EVENT, onChange);
}

// Runs in <head> before paint so System users on a light OS never see a dark flash, and keeps
// following the OS on every page (dashboard, docs, login) while System is the saved choice.
export const THEME_INIT_SCRIPT = `(function(){try{var m=matchMedia('(prefers-color-scheme: light)');function a(){if(/(?:^|; )${THEME_COOKIE}=system(?:;|$)/.test(document.cookie)){document.documentElement.dataset.theme=m.matches?'light':'dark'}}a();m.addEventListener('change',a)}catch(e){}})()`;
