import { describe, it, expect } from 'vitest';
import { codeConfigSchema, canonicalJson, changedConfigFields } from './code-config';
import { checkSchema } from './index';

const input = {
  version: 1,
  project: 'production',
  checks: [
    {
      id: 'api',
      config: {
        name: 'API',
        url: 'https://example.com',
        headers: { Authorization: 'Bearer {{TOKEN}}' },
      },
    },
  ],
};
describe('code configuration contracts', () => {
  it('normalizes defaults without resolving named secrets', () => {
    const result = codeConfigSchema.parse(input);
    expect(result.checks[0]!.config.intervalSeconds).toBe(60);
    expect(result.checks[0]!.config.headers.Authorization).toBe('Bearer {{TOKEN}}');
  });
  it('rejects duplicate identity, typos, and invalid identities', () => {
    for (const value of [
      { ...input, checks: [...input.checks, ...input.checks] },
      { ...input, project: '../production' },
      {
        ...input,
        checks: [
          { ...input.checks[0], config: { ...input.checks[0]!.config, intervalseconds: 10 } },
        ],
      },
      { ...input, prune: true },
      {
        ...input,
        checks: Array.from({ length: 101 }, (_, i) => ({ ...input.checks[0], id: `api-${i}` })),
      },
    ])
      expect(codeConfigSchema.safeParse(value).success).toBe(false);
  });
  it('compares object order structurally and reports fields without their values', () => {
    const before = checkSchema.parse({
      ...input.checks[0]!.config,
      headers: { Authorization: 'sensitive', Accept: 'json' },
    });
    const after = checkSchema.parse({
      ...before,
      headers: { Accept: 'json', Authorization: 'sensitive' },
    });
    expect(changedConfigFields(before, after)).toEqual([]);
    expect(canonicalJson(before)).toBe(canonicalJson(after));
    after.headers.Authorization = 'rotated';
    expect(changedConfigFields(before, after)).toEqual(['headers']);
  });
});
