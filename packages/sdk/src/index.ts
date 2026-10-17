import {
  codeConfigSchema,
  type CodeConfigInput,
  type CodeConfig,
  type CodePlan,
} from '@stillup/core/code-config';
import type { CheckConfig, CheckResult } from '@stillup/core';
export { codeConfigSchema };
export type { CodeConfigInput, CodeConfig, CodePlan };

/** Typed authoring with runtime validation. Files execute only in the caller's process. */
export function defineConfig(config: CodeConfigInput): CodeConfig {
  const result = codeConfigSchema.safeParse(config);
  if (!result.success)
    throw new ConfigurationError(
      result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('\n'),
    );
  return result.data;
}

export class ConfigurationError extends Error {}

function apiBase(baseUrl: string) {
  const base = new URL(baseUrl);
  if (
    !['http:', 'https:'].includes(base.protocol) ||
    base.username ||
    base.password ||
    base.search ||
    base.hash
  )
    throw new Error('Use an HTTP(S) StillUp base URL without credentials, query, or fragment.');
  return base.href.replace(/\/$/, '');
}
async function json<T>(request: Promise<Response>, failure: string): Promise<T> {
  let response: Response;
  try {
    response = await request;
  } catch {
    throw new Error(failure);
  }
  const body = (await response.json().catch(() => null)) as (T & { error?: string }) | null;
  if (!response.ok || !body)
    throw new Error(`${failure} HTTP ${response.status}: ${body?.error ?? 'Request failed'}`);
  return body;
}

/**
 * Signs in as a trusted GitHub Actions workflow and returns a deploy token that lasts fifteen
 * minutes. Pass the job's ACTIONS_ID_TOKEN_REQUEST_URL and ACTIONS_ID_TOKEN_REQUEST_TOKEN, which
 * GitHub sets when the job has `permissions: id-token: write`. No secret is stored in GitHub;
 * an administrator adds a trust rule for the repository and workflow under API access.
 */
export async function githubActionsToken({
  baseUrl,
  requestUrl,
  requestToken,
}: {
  baseUrl: string;
  requestUrl?: string;
  requestToken?: string;
}): Promise<string> {
  const base = apiBase(baseUrl);
  if (!requestUrl || !requestToken)
    throw new Error(
      'GitHub did not offer an OpenID Connect token. Add `permissions: id-token: write` to the workflow job.',
    );
  const signal = () => AbortSignal.timeout(30000);
  const { audience } = await json<{ audience?: string }>(
    fetch(`${base}/v1/auth/config`, { redirect: 'error', signal: signal() }),
    'Cannot read StillUp sign-in settings. Check STILLUP_URL.',
  );
  if (!audience) throw new Error('This StillUp version does not support trusted GitHub workflows.');
  const url = new URL(requestUrl);
  url.searchParams.set('audience', audience);
  const { value } = await json<{ value?: string }>(
    fetch(url, { headers: { authorization: `Bearer ${requestToken}` }, signal: signal() }),
    'GitHub did not issue an OpenID Connect token.',
  );
  if (!value) throw new Error('GitHub did not issue an OpenID Connect token.');
  const { token } = await json<{ token: string }>(
    fetch(`${base}/v1/auth/github`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: value }),
      redirect: 'error',
      signal: signal(),
    }),
    'StillUp did not accept this workflow.',
  );
  return token;
}

/**
 * baseUrl: browser origin + /api, or a private API origin without /api. token: an API key, a
 * token from githubActionsToken, or the installation administrator token.
 */
export function createClient({ baseUrl, token }: { baseUrl: string; token: string }) {
  const base = apiBase(baseUrl);
  if (!token) throw new Error('A StillUp API key or token is required.');
  async function post<T>(path: string, body: unknown): Promise<T> {
    const encoded = JSON.stringify(body);
    if (new TextEncoder().encode(encoded).length > 100000)
      throw new Error(
        'The request exceeds the 100,000-byte API limit. Split checks into smaller projects.',
      );
    let response: Response;
    try {
      response = await fetch(`${base}/v1/${path}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: encoded,
        redirect: 'error',
        signal: AbortSignal.timeout(60000),
      });
    } catch {
      throw new Error('Cannot reach StillUp. Check STILLUP_URL, TLS, and API availability.');
    }
    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as { error?: string } | null;
      throw new Error(`StillUp HTTP ${response.status}: ${body?.error ?? 'Request failed'}`);
    }
    return response.json() as Promise<T>;
  }
  return {
    plan: (config: CodeConfig) => post<CodePlan>('code/plan', config),
    apply: (config: CodeConfig, token: string) => post<CodePlan>('code/apply', { config, token }),
    test: (config: CheckConfig) => post<CheckResult>('checks/test', config),
  };
}
