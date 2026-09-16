import { z } from 'zod';
import type { CheckResult } from './index';
export const locationIdSchema = z.union([z.literal('local'), z.uuid()]);
export const locationCreateSchema = z.object({
  name: z.string().trim().min(1).max(80),
  region: z.string().trim().min(1).max(80),
});
export const probeReportSchema = z.object({
  outcome: z.enum(['pass', 'fail', 'error']),
  statusCode: z.number().int().min(100).max(599).nullable(),
  durationMs: z.number().int().min(0).max(120000),
  assertions: z
    .array(z.object({ passed: z.boolean() }))
    .max(43)
    .optional(),
});
export type ProbeLocation = {
  id: string;
  name: string;
  region: string;
  status: 'online' | 'offline' | 'pending' | 'revoked';
  lastSeenAt: string | null;
  enrollmentExpiresAt: string | null;
};
export type RegionalObservation = {
  locationId: string;
  name: string;
  region: string;
  outcome: CheckResult['outcome'] | null;
  statusCode: number | null;
  durationMs: number | null;
  checkedAt: string | null;
  fresh: boolean;
  probeStatus: ProbeLocation['status'];
};
// Unknown observations can neither create an outage nor supply a recovery vote.
export function aggregateLocations(
  results: (CheckResult | null)[],
  threshold: number,
  checkedAt: string,
): CheckResult {
  const failed = results.filter((r) => r?.outcome === 'fail').length;
  const passed = results.filter((r) => r?.outcome === 'pass').length;
  const outcome =
    failed >= threshold ? 'fail' : passed > results.length - threshold ? 'pass' : 'error';
  return {
    outcome,
    statusCode: null,
    durationMs: Math.max(0, ...results.map((r) => r?.durationMs ?? 0)),
    checkedAt,
    failures:
      outcome === 'fail'
        ? [`${failed} locations failed; threshold is ${threshold}`]
        : outcome === 'error'
          ? ['Insufficient location coverage to determine health']
          : [],
  };
}
