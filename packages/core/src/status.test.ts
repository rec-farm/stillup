import { describe, expect, it } from 'vitest';
import { statusSettingsSchema } from './status';
import { formatUptime } from './index';
import { contrastRatio, statusContrastIssues, statusPalettes, statusPresets } from './status-theme';

describe('public page configuration', () => {
  it('loads saved configurations from before the design controls existed', () => {
    const config = statusSettingsSchema.parse({ title: 'Service status' });
    expect(config.theme).toBe('light');
    expect(config.showIncidentHistory).toBe(true);
    expect(config.content).toEqual([]);
  });
  it('retains custom appearance, links, and ordered content', () => {
    const input = {
      title: 'Acme',
      theme: 'dark',
      layout: 'wide',
      font: 'mono',
      cornerRadius: 0,
      showPoweredBy: false,
      showIncidentHistory: false,
      faviconUrl: 'https://example.com/favicon.png',
      links: [{ label: 'Support', url: 'https://example.com/support' }],
      content: [
        {
          id: '00000000-0000-4000-8000-000000000001',
          title: 'Support',
          body: '<script>plain text</script>',
          position: 'before-services',
        },
      ],
    };
    expect(statusSettingsSchema.parse(input)).toMatchObject(input);
  });
  it('rejects executable links, credentials, invalid colors, and unbounded content', () => {
    for (const fields of [
      { faviconUrl: 'javascript:alert(1)' },
      { links: [{ label: 'Bad', url: 'https://user:password@example.com' }] },
      { links: [{ label: 'Bad', url: '' }] },
      { backgroundColor: 'red; display:none' },
      { cornerRadius: 100 },
      { links: Array(9).fill({ label: 'Link', url: 'https://example.com' }) },
    ])
      expect(statusSettingsSchema.safeParse({ title: 'Status', ...fields }).success).toBe(false);
  });
});

describe('public page theming', () => {
  it('keeps the built-in dark palette unless dark colors are set', () => {
    const config = statusSettingsSchema.parse({ title: 'Status' });
    expect(config.darkBackgroundColor).toBe('');
    expect(statusPalettes(config).dark.background).toBe('#0a0b0c');
    expect(
      statusSettingsSchema.safeParse({ title: 'Status', darkTextColor: 'white' }).success,
    ).toBe(false);
  });
  it('measures contrast with WCAG ratios', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21);
    expect(contrastRatio('#777777', '#777777')).toBeCloseTo(1);
  });
  it('flags unreadable text only in themes visitors can see', () => {
    const base = statusSettingsSchema.parse({ title: 'Status', darkTextColor: '#111111' });
    expect(statusContrastIssues({ ...base, theme: 'light' })).toEqual([]);
    expect(statusContrastIssues({ ...base, theme: 'auto' }).map((i) => i.theme)).toEqual([
      'dark',
      'dark',
    ]);
  });
  it('ships presets that are valid and readable', () => {
    for (const preset of statusPresets) {
      const config = statusSettingsSchema.parse({ title: 'Status', ...preset.settings });
      expect(statusContrastIssues({ ...config, theme: 'auto' }), preset.name).toEqual([]);
    }
  });
});

describe('formatUptime', () => {
  it('truncates instead of rounding up to a perfect record', () => {
    expect(formatUptime(100)).toBe('100%');
    expect(formatUptime(99.999)).toBe('99.99%');
    expect(formatUptime(99.81)).toBe('99.81%');
    expect(formatUptime(0)).toBe('0.00%');
  });
});
