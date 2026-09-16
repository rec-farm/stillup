import { describe, expect, it } from 'vitest';
import { aggregateLocations, checkSchema, type CheckResult } from './index';
const result = (outcome: CheckResult['outcome']): CheckResult => ({
  outcome,
  statusCode: 200,
  durationMs: 10,
  checkedAt: new Date().toISOString(),
  failures: [],
});
describe('regional health voting', () => {
  it('requires enough failures or recovery votes, never votes with missing coverage', () => {
    const at = new Date().toISOString();
    expect(aggregateLocations([result('fail'), result('pass'), null], 2, at).outcome).toBe('error');
    expect(aggregateLocations([result('pass'), result('pass'), null], 2, at).outcome).toBe('pass');
    expect(aggregateLocations([result('fail'), result('fail'), null], 2, at).outcome).toBe('fail');
    expect(aggregateLocations([result('pass'), result('error')], 1, at).outcome).toBe('error');
    expect(aggregateLocations([result('fail'), result('error')], 1, at).outcome).toBe('fail');
    expect(aggregateLocations([null, null], 1, at).outcome).toBe('error');
  });
  it('keeps default local monitoring compatible and validates location thresholds', () => {
    const config = { name: 'API', url: 'https://example.com' };
    expect(checkSchema.parse(config).locationIds).toBeUndefined();
    expect(checkSchema.safeParse({ ...config, locationIds: [] }).success).toBe(false);
    expect(checkSchema.safeParse({ ...config, locationIds: ['local', 'local'] }).success).toBe(
      false,
    );
    expect(checkSchema.safeParse({ ...config, locationFailureThreshold: 2 }).success).toBe(false);
    expect(
      checkSchema.safeParse({ ...config, locationIds: ['local'], locationFailureThreshold: 2 })
        .success,
    ).toBe(false);
  });
});
