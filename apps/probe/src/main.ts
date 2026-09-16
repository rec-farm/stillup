import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { checkSchema } from '@stillup/core';
import { executeCheck } from '@stillup/core/executor';
const options = z
  .object({
    STILLUP_URL: z.url(),
    STILLUP_ENROLLMENT_TOKEN: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    STILLUP_PROBE_DATA: z.string().default('/data'),
    STILLUP_PROBE_ALLOW_PRIVATE_NETWORKS: z.enum(['true', 'false']).default('false'),
    STILLUP_PROBE_ALLOW_HTTP: z.enum(['true', 'false']).default('false'),
  })
  .parse({
    ...process.env,
    STILLUP_ENROLLMENT_TOKEN: process.env.STILLUP_ENROLLMENT_TOKEN || undefined,
  });
const base = new URL(options.STILLUP_URL);
if (
  base.username ||
  base.password ||
  base.search ||
  base.hash ||
  base.pathname !== '/' ||
  !['http:', 'https:'].includes(base.protocol)
)
  throw new Error('STILLUP_URL must be an HTTP(S) origin without credentials or a path');
if (base.protocol !== 'https:' && options.STILLUP_PROBE_ALLOW_HTTP !== 'true')
  throw new Error('HTTPS is required. Allow HTTP explicitly only for local development.');
let stopping = false;
process.on('SIGTERM', () => {
  stopping = true;
});
process.on('SIGINT', () => {
  stopping = true;
});
const pause = () => new Promise((r) => setTimeout(r, 2000));
class ApiError extends Error {
  constructor(readonly status: number) {
    super(`StillUp returned HTTP ${status}`);
  }
}
async function call(path: string, body: unknown, credential?: string) {
  const response = await fetch(new URL(`/v1/probe/${path}`, base), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(credential ? { authorization: `Bearer ${credential}` } : {}),
    },
    body: JSON.stringify({ protocolVersion: 1, ...(body as object) }),
    signal: AbortSignal.timeout(10000),
    redirect: 'error',
  });
  if (!response.ok) throw new ApiError(response.status);
  return response.json();
}
const stateSchema = z.object({
  token: z.string().regex(/^[a-f0-9]{64}$/),
  enrollmentToken: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
  locationId: z.uuid().optional(),
  origin: z.string(),
});
await mkdir(options.STILLUP_PROBE_DATA, { recursive: true, mode: 0o700 });
const statePath = join(options.STILLUP_PROBE_DATA, 'identity.json');
async function persist(state: z.infer<typeof stateSchema>) {
  await writeFile(statePath + '.tmp', JSON.stringify(state), { mode: 0o600 });
  await rename(statePath + '.tmp', statePath);
}
let identity: z.infer<typeof stateSchema>;
try {
  identity = stateSchema.parse(JSON.parse(await readFile(statePath, 'utf8')));
} catch (e) {
  if (!(e && typeof e === 'object' && 'code' in e && e.code === 'ENOENT'))
    throw new Error(
      'Cannot read probe identity; preserve the data volume and check its permissions',
    );
  if (!options.STILLUP_ENROLLMENT_TOKEN)
    throw new Error('Set STILLUP_ENROLLMENT_TOKEN for first enrollment');
  identity = {
    token: randomBytes(32).toString('hex'),
    enrollmentToken: options.STILLUP_ENROLLMENT_TOKEN,
    origin: base.origin,
  };
  await persist(identity);
}
if (identity.origin !== base.origin)
  throw new Error('This data volume belongs to a different StillUp installation');
while (identity.enrollmentToken && !stopping) {
  try {
    const result = z.object({ locationId: z.uuid(), protocolVersion: z.literal(1) }).parse(
      await call('enroll', {
        enrollmentToken: identity.enrollmentToken,
        credential: identity.token,
      }),
    );
    identity = { token: identity.token, locationId: result.locationId, origin: base.origin };
    await persist(identity);
    console.log('Probe enrolled. Keep the data volume to reconnect after restarts.');
  } catch (e) {
    if (e instanceof ApiError && [400, 401, 403].includes(e.status))
      throw new Error(
        'Enrollment rejected. Generate a replacement enrollment and use a new data volume.',
      );
    console.error('Enrollment unavailable; retrying.');
    await pause();
  }
}
const jobSchema = z.object({
  protocolVersion: z.literal(1),
  job: z
    .object({
      id: z.uuid(),
      leaseToken: z.uuid(),
      leaseUntil: z.iso.datetime(),
      config: checkSchema,
      secrets: z.record(z.string(), z.string()),
    })
    .nullable(),
});
console.log('Probe ready; polling for checks.');
let pending: { jobId: string; leaseToken: string; result: unknown; until: number } | null = null;
while (!stopping || pending) {
  try {
    if (pending) {
      if (Date.now() >= pending.until) {
        pending = null;
        continue;
      }
      await call(
        'results',
        { jobId: pending.jobId, leaseToken: pending.leaseToken, result: pending.result },
        identity.token,
      );
      pending = null;
      if (stopping) break;
    }
    const { job } = jobSchema.parse(await call('poll', {}, identity.token));
    if (!job) {
      await pause();
      continue;
    }
    if (Date.parse(job.leaseUntil) - Date.now() < job.config.timeoutMs + 2000) {
      await pause();
      continue;
    }
    const result = await executeCheck(job.config, {
      secrets: job.secrets,
      allowPrivateNetworks: options.STILLUP_PROBE_ALLOW_PRIVATE_NETWORKS === 'true',
    });
    pending = {
      jobId: job.id,
      leaseToken: job.leaseToken,
      until: Date.parse(job.leaseUntil),
      result: {
        outcome: result.outcome,
        statusCode: result.statusCode,
        durationMs: result.durationMs,
        assertions: result.assertions?.map((a) => ({ passed: a.passed })),
      },
    };
  } catch (e) {
    if (e instanceof ApiError && [401, 403].includes(e.status)) {
      console.error('Probe credential rejected. Re-enroll this location with a new data volume.');
      process.exitCode = 1;
      break;
    }
    if (e instanceof ApiError && [400, 404, 409].includes(e.status)) pending = null;
    console.error('Probe communication interrupted; retrying without logging request data.');
    await pause();
  }
}
