'use client';
import { useSyncExternalStore } from 'react';
import { Monitor, Moon, Sun } from 'lucide-react';
import {
  applyThemeChoice,
  readThemeChoice,
  subscribeThemeChoice,
  type ThemeChoice,
} from '../lib/theme';

const OPTIONS: { value: ThemeChoice; label: string; icon: typeof Moon }[] = [
  { value: 'dark', label: 'Dark', icon: Moon },
  { value: 'light', label: 'Paper', icon: Sun },
  { value: 'system', label: 'System', icon: Monitor },
];

/**
 * Segmented control (BRAND §8 Tabs): surface-2 track, active surface-1 + strong border.
 * Following the OS under System is done by THEME_INIT_SCRIPT, so it works while this is unmounted.
 */
export function ThemeSwitcher() {
  const choice = useSyncExternalStore(subscribeThemeChoice, readThemeChoice, () => 'dark' as const);

  return (
    <div role="radiogroup" aria-label="Theme" className="theme-switcher">
      {OPTIONS.map(({ value, label, icon: Icon }) => (
        <button
          key={value}
          type="button"
          role="radio"
          aria-checked={choice === value}
          onClick={() => applyThemeChoice(value)}
        >
          <Icon size={14} aria-hidden="true" />
          {label}
        </button>
      ))}
    </div>
  );
}
