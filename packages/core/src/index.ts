import { z } from 'zod';
export * from './notifications';
export * from './secrets';
export * from './status';
export * from './status-theme';
export * from './probes';
import { locationIdSchema } from './probes';
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
    locationIds: z
      .array(locationIdSchema)
      .min(1)
      .max(10)
      .refine((ids) => new Set(ids).size === ids.length, 'Choose each location once')
      .optional(),
    locationFailureThreshold: z.number().int().min(1).max(10).optional(),
    public: z.boolean().default(false),
  })
  .superRefine((value, ctx) => {
    if ((value.locationFailureThreshold ?? 1) > (value.locationIds?.length ?? 1))
      ctx.addIssue({
        code: 'custom',
        path: ['locationFailureThreshold'],
        message: 'Failure threshold cannot exceed the selected locations',
      });
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
/** Interval-weighted daily uptime (UTC days, oldest first); only days with observations. */
export type Uptime = {
  windowDays: number;
  percentage: number | null;
  days: { date: string; percentage: number | null }[];
};
export type Monitor = {
  codeOwnership?: { project: string; id: string } | null;
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
  /** Dashboard only: interval-weighted uptime over the last 30 UTC days, or null without data. */
  uptime30d?: number | null;
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
  branding?: Omit<import('./status').StatusSettings, 'groups'>;
  groups?: { id: string; name: string }[];
  maintenance?: import('./status').Maintenance[];
  communications?: import('./status').CommunicationIncident[];
  title: string;
  updatedAt: string;
  components: {
    id: string;
    name: string;
    health: Health | 'maintenance';
    lastObservedAt: string | null;
    groupId?: string;
    uptime?: Uptime;
  }[];
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

/** Administrators manage everything; viewers read checks, incidents and the dashboard. */
export type Role = 'admin' | 'viewer';
export type User = {
  id: string;
  email: string;
  name: string | null;
  role: Role;
  /** Whether this person has signed in with single sign-on at least once. */
  linked: boolean;
  createdAt: string;
  lastSignInAt: string | null;
};
/** The installation token (or single sign-on before any users exist) acts as an administrator. */
/** The @rec/stillup version that generated workflows run; kept equal to apps/cli/package.json. */
export const CLI_VERSION = '0.1.0';

export type CredentialRole = 'viewer' | 'deployer' | 'admin';
export type Me =
  | ({ kind: 'user' } & User)
  | { kind: 'installation'; role: 'admin' }
  | { kind: 'credential'; role: CredentialRole; projects: string[] | null };
export type UserList = { users: User[]; oidc: boolean };
export type ApiKey = {
  id: string;
  name: string;
  role: CredentialRole;
  /** Projects a deploy key may change; null means every project. */
  projects: string[] | null;
  /** The key's first characters, to tell keys apart. */
  hint: string;
  createdBy: string;
  createdAt: string;
  expiresAt: string | null;
  lastUsedAt: string | null;
};
/** A GitHub Actions workflow trusted to deploy monitoring as code without a stored secret. */
export type TrustedPublisher = {
  id: string;
  repository: string;
  workflow: string;
  branch: string | null;
  environment: string | null;
  projects: string[];
  /** Whether a run has bound the rule to GitHub's repository and owner IDs. */
  linked: boolean;
  createdBy: string;
  createdAt: string;
  lastUsedAt: string | null;
};

export { workspaceSettingsSchema, defaultWorkspaceSettings } from './workspace';
export type { WorkspaceSettings, WorkspaceAppearance } from './workspace';

/** Truncates rather than rounds, so 99.999% never reads as 100%. */
export const formatUptime = (percentage: number) =>
  percentage === 100 ? '100%' : `${(Math.floor(percentage * 100) / 100).toFixed(2)}%`;
