import { z } from 'zod';
export * from './notifications';
import {
  jsonAssertionSchema,
  headerAssertionSchema,
  responseSchema,
  type AssertionResult,
} from './assertion-config';
export type { JsonAssertion, HeaderAssertion, AssertionResult } from './assertion-config';

export const checkSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    url: z
      .url()
      .max(2048)
      .refine((value) => {
        const url = new URL(value);
        return (
          ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.hash
        );
      }, 'Use an HTTP(S) URL without embedded credentials or a fragment'),
    method: z.enum(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE']).default('GET'),
    headers: z
      .record(
        z.string().regex(/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/),
        z
          .string()
          .max(4096)
          .refine((v) => !/[\r\n]/.test(v)),
      )
      .default({}),
    body: z.string().max(65536).default(''),
    intervalSeconds: z.number().int().min(30).max(86400).default(60),
    timeoutMs: z.number().int().min(100).max(30000).default(10000),
    expectedStatus: z.number().int().min(100).max(599).default(200),
    maxResponseMs: z.number().int().min(1).max(30000).nullable().default(null),
    jsonAssertions: z.array(jsonAssertionSchema).max(20).default([]),
    headerAssertions: z.array(headerAssertionSchema).max(20).optional(),
    responseSchema: responseSchema.optional(),
    failureThreshold: z.number().int().min(1).max(10).default(2),
    recoveryThreshold: z.number().int().min(1).max(10).default(1),
    notificationChannelIds: z
      .array(z.uuid())
      .max(20)
      .refine((ids) => new Set(ids).size === ids.length, 'Choose each channel once')
      .optional(),
    reminderIntervalSeconds: z.number().int().min(300).max(86400).optional(),
    public: z.boolean().default(false),
  })
  .superRefine((value, ctx) => {
    if (['GET', 'HEAD'].includes(value.method) && value.body)
      ctx.addIssue({
        code: 'custom',
        path: ['body'],
        message: 'GET and HEAD checks cannot have a request body',
      });
    if (Object.keys(value.headers).length > 30)
      ctx.addIssue({
        code: 'custom',
        path: ['headers'],
        message: 'At most 30 headers are supported',
      });
  });
export type CheckConfig = z.infer<typeof checkSchema>;
export type Health = 'up' | 'down' | 'unknown' | 'paused' | 'archived';
export type CheckResult = {
  outcome: 'pass' | 'fail' | 'error';
  statusCode: number | null;
  durationMs: number;
  failures: string[];
  assertions?: AssertionResult[];
  checkedAt: string;
};
export type HealthState = {
  status: 'up' | 'down' | 'unknown';
  failures: number;
  successes: number;
};
export function evaluateHealth(
  previous: HealthState,
  outcome: CheckResult['outcome'],
  failureThreshold: number,
  recoveryThreshold: number,
): HealthState {
  if (outcome === 'error') return previous; // Configuration/runner errors are not target outages.
  const failures = outcome === 'fail' ? previous.failures + 1 : 0;
  const successes = outcome === 'pass' ? previous.successes + 1 : 0;
  const status =
    failures >= failureThreshold ? 'down' : successes >= recoveryThreshold ? 'up' : previous.status;
  return { status, failures, successes };
}
export function visibleHealth(
  status: HealthState['status'],
  enabled: boolean,
  lastObservedAt: string | null,
  intervalSeconds: number,
  now = Date.now(),
): Health {
  if (!enabled) return 'paused';
  if (
    !lastObservedAt ||
    now - Date.parse(lastObservedAt) > Math.max(intervalSeconds * 3, 120) * 1000
  )
    return 'unknown';
  return status;
}
export type Monitor = {
  id: string;
  config: CheckConfig;
  configRevision: number;
  archivedAt: string | null;
  enabled: boolean;
  health: Health;
  lastRunAt: string | null;
  lastObservedAt: string | null;
  lastDurationMs: number | null;
  lastOutcome: CheckResult['outcome'] | null;
  createdAt: string;
};
export type Run = CheckResult & { id: string; monitorId: string; configRevision: number };
export type CheckRevision = {
  monitorId: string;
  revision: number;
  config: CheckConfig;
  createdAt: string;
};
export type RevisionPage = { revisions: CheckRevision[]; nextBefore: number | null };
export const revisionGuardSchema = z.object({ expectedRevision: z.number().int().positive() });
export const editCheckSchema = revisionGuardSchema.extend({ config: checkSchema });
export type Incident = {
  id: string;
  monitorId: string;
  name: string;
  openedAt: string;
  resolvedAt: string | null;
};
export type Dashboard = {
  monitors: Monitor[];
  incidents: Incident[];
  workerAt: string | null;
  notificationsEnabled: boolean;
};
export type PublicStatus = {
  title: string;
  updatedAt: string;
  components: { id: string; name: string; health: Health; lastObservedAt: string | null }[];
  incidents: Incident[];
};

export type IncidentTimeline = {
  incident: Incident;
  events: {
    id: string;
    type: string;
    at: string;
    runId: string;
    configRevision: number;
    result: CheckResult;
  }[];
  observations: Run[];
  nextBefore: string | null;
};
