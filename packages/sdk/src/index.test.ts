import { afterEach, describe, expect, it, vi } from 'vitest';
import { createClient, githubActionsToken } from './index';

const reply = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

afterEach(() => vi.unstubAllGlobals());

describe('githubActionsToken', () => {
  it('requests a GitHub token for this installation and exchanges it', async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL, init?: RequestInit) => {
        calls.push({ url: String(url), init });
        if (String(url).endsWith('/v1/auth/config'))
          return reply({ audience: 'https://status.example.com' });
        if (String(url).startsWith('https://github.test/')) return reply({ value: 'github-jwt' });
        return reply({ token: 'sut_deploy', projects: ['api'] });
      }),
    );
    const token = await githubActionsToken({
      baseUrl: 'https://status.example.com/api/',
      requestUrl: 'https://github.test/token?api-version=2.0',
      requestToken: 'request-secret',
    });
    expect(token).toBe('sut_deploy');
    expect(calls.map((c) => c.url)).toEqual([
      'https://status.example.com/api/v1/auth/config',
      'https://github.test/token?api-version=2.0&audience=https%3A%2F%2Fstatus.example.com',
      'https://status.example.com/api/v1/auth/github',
    ]);
    expect(calls[1].init?.headers).toEqual({ authorization: 'Bearer request-secret' });
    expect(JSON.parse(String(calls[2].init?.body))).toEqual({ token: 'github-jwt' });
  });

  it('explains the missing permission and refused workflows', async () => {
    await expect(githubActionsToken({ baseUrl: 'https://status.example.com/api' })).rejects.toThrow(
      'id-token: write',
    );
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL) =>
        String(url).endsWith('/v1/auth/config')
          ? reply({ audience: 'https://status.example.com' })
          : String(url).startsWith('https://github.test/')
            ? reply({ value: 'github-jwt' })
            : reply({ error: 'No trust rule lets acme/api deploy from workflow x.yml' }, 401),
      ),
    );
    await expect(
      githubActionsToken({
        baseUrl: 'https://status.example.com/api',
        requestUrl: 'https://github.test/token',
        requestToken: 'request-secret',
      }),
    ).rejects.toThrow('StillUp did not accept this workflow. HTTP 401: No trust rule');
  });
});

describe('createClient', () => {
  it('rejects base URLs with credentials and requires a token', () => {
    expect(() => createClient({ baseUrl: 'https://a:b@x.io/api', token: 't' })).toThrow();
    expect(() => createClient({ baseUrl: 'https://x.io/api', token: '' })).toThrow(
      'API key or token',
    );
  });
});
