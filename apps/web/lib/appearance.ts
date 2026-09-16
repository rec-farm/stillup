import type { CSSProperties } from 'react';
import type { WorkspaceSettings } from '@stillup/core';

// Keep white button labels legible, including when a company chooses a pale accent.
export function accessibleAccent(hex: string) {
  let rgb = [1, 3, 5].map((offset) => parseInt(hex.slice(offset, offset + 2), 16));
  const luminance = () =>
    rgb.reduce((total, value, index) => {
      const s = value / 255;
      return (
        total +
        (s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4) * [0.2126, 0.7152, 0.0722][index]!
      );
    }, 0);
  while (1.05 / (luminance() + 0.05) < 4.5) rgb = rgb.map((value) => Math.floor(value * 0.94));
  return '#' + rgb.map((value) => value.toString(16).padStart(2, '0')).join('');
}
export function appearanceStyle(settings: WorkspaceSettings): CSSProperties {
  return {
    '--accent': settings.accentColor,
    '--action': accessibleAccent(settings.accentColor),
    '--green': accessibleAccent(settings.accentColor),
  } as CSSProperties;
}
export const appearancePresets = [
  { name: 'Forest', color: '#087f67' },
  { name: 'Ocean', color: '#2563eb' },
  { name: 'Iris', color: '#7c3aed' },
  { name: 'Ember', color: '#c45824' },
  { name: 'Graphite', color: '#475569' },
];
