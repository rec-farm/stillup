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

/** baseUrl: browser origin + /api, or a private API origin without /api. */
export function createClient({ baseUrl, token }: { baseUrl: string; token: string }) {
  const base = new URL(baseUrl);
  if (
    !['http:', 'https:'].includes(base.protocol) ||
    base.username ||
    base.password ||
    base.search ||
    base.hash
  )
    throw new Error('Use an HTTP(S) StillUp base URL without credentials, query, or fragment.');
  if (!token) throw new Error('A StillUp administrator token is required.');
  async function post<T>(path: string, body: unknown): Promise<T> {
    const encoded = JSON.stringify(body);
    if (new TextEncoder().encode(encoded).length > 100000)
      throw new Error(
        'The request exceeds the 100,000-byte API limit. Split checks into smaller projects.',
      );
    let response: Response;
    try {
      response = await fetch(`${base.href.replace(/\/$/, '')}/v1/${path}`, {
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
