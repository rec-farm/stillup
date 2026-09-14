import { lookup } from 'node:dns';
import { performance } from 'node:perf_hooks';
import { Agent, request } from 'undici';
import ipaddr from 'ipaddr.js';
import type { CheckConfig, CheckResult } from './index';

class PolicyError extends Error {}
export function isPublicAddress(address: string): boolean {
  try {
    return ipaddr.process(address).range() === 'unicast';
  } catch {
    return false;
  }
}
export function resolveSecrets(value: string, secrets: Record<string, string | undefined>): string {
  return value.replace(/\{\{([A-Z][A-Z0-9_]*)\}\}/g, (_, key: string) => {
    const secret = secrets[`CHECK_SECRET_${key}`];
    if (secret === undefined) throw new PolicyError('A referenced check secret is not configured');
    return secret;
  });
}
export async function executeCheck(
  config: CheckConfig,
  options: { allowPrivateNetworks?: boolean; secrets?: Record<string, string | undefined> } = {},
): Promise<CheckResult> {
  const started = performance.now();
  const checkedAt = new Date().toISOString();
  const agent = new Agent({
    connect: {
      lookup: (hostname, lookupOptions, callback) => {
        lookup(hostname, { all: true }, (error, addresses) => {
          if (error) return callback(error, [], undefined as never);
          if (!options.allowPrivateNetworks && addresses.some((a) => !isPublicAddress(a.address))) {
            return callback(
              new PolicyError('Target resolves to a restricted network'),
              [],
              undefined as never,
            );
          }
          if (lookupOptions.all) callback(null, addresses, undefined as never);
          else callback(null, addresses[0]!.address, addresses[0]!.family);
        });
      },
    },
  });
  let statusCode: number | null = null;
  try {
    const url = new URL(config.url);
    const literal = url.hostname.replace(/^\[|\]$/g, '');
    if (!options.allowPrivateNetworks && ipaddr.isValid(literal) && !isPublicAddress(literal))
      throw new PolicyError('Target resolves to a restricted network');
    const headers = Object.fromEntries(
      Object.entries(config.headers).map(([key, value]) => [
        key,
        resolveSecrets(value, options.secrets ?? {}),
      ]),
    );
    const response = await request(url, {
      method: config.method,
      headers: { 'user-agent': 'StillUp/0.1', ...headers },
      body: config.body ? resolveSecrets(config.body, options.secrets ?? {}) : undefined,
      dispatcher: agent,
      signal: AbortSignal.timeout(config.timeoutMs),
      headersTimeout: config.timeoutMs,
      bodyTimeout: config.timeoutMs,
    });
    statusCode = response.statusCode;
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > 1024 * 1024) {
        response.body.destroy();
        throw new Error('Response exceeds 1 MiB limit');
      }
      chunks.push(Buffer.from(chunk));
    }
    const durationMs = Math.round(performance.now() - started);
    const failures: string[] = [];
    if (statusCode !== config.expectedStatus)
      failures.push(`Expected HTTP ${config.expectedStatus}, received ${statusCode}`);
    if (config.maxResponseMs !== null && durationMs > config.maxResponseMs)
      failures.push(`Response exceeded ${config.maxResponseMs} ms`);
    if (config.jsonAssertions.length) {
      try {
        const json: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        for (const assertion of config.jsonAssertions) {
          let value = json;
          for (const key of assertion.path.split('.').slice(1))
            value =
              value !== null && typeof value === 'object' && Object.hasOwn(value, key)
                ? (value as Record<string, unknown>)[key]
                : undefined;
          // Do not persist actual values: responses may contain credentials or personal data.
          if (value !== assertion.equals)
            failures.push(`JSON assertion failed at ${assertion.path}`);
        }
      } catch {
        failures.push('Response is not valid JSON');
      }
    }
    return {
      outcome: failures.length ? 'fail' : 'pass',
      statusCode,
      durationMs,
      failures,
      checkedAt,
    };
  } catch (error) {
    const policy =
      error instanceof PolicyError ||
      (error instanceof Error && error.cause instanceof PolicyError);
    return {
      outcome: policy ? 'error' : 'fail',
      statusCode,
      durationMs: Math.round(performance.now() - started),
      checkedAt,
      failures: [
        policy
          ? 'Check configuration or network policy prevented execution'
          : error instanceof Error && ['TimeoutError', 'AbortError'].includes(error.name)
            ? `Request timed out after ${config.timeoutMs} ms`
            : 'Request failed (connection, TLS, or response limit)',
      ],
    };
  } finally {
    await agent.destroy();
  }
}
