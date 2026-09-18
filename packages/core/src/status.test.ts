import { describe, expect, it } from 'vitest';
import { statusSettingsSchema } from './status';

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
