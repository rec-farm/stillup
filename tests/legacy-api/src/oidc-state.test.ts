import { describe, expect, it } from 'vitest';
import { openFlow, safeNext, sealFlow } from './oidc-state';

const secret = 'a'.repeat(64);
const flow = {
  state: 'state-value',
  nonce: 'nonce-value',
  verifier: 'v'.repeat(43),
  next: '/',
  expires: Date.now() + 60000,
};

describe('OIDC flow cookie', () => {
  it('round-trips a sealed flow', () => {
    expect(openFlow(sealFlow(flow, secret), secret)).toEqual(flow);
  });
  it('rejects tampering, another secret, expiry and junk', () => {
    const sealed = sealFlow(flow, secret);
    const [payload, signature] = sealed.split('.');
    const forged = Buffer.from(JSON.stringify({ ...flow, next: '/evil' })).toString('base64url');
    expect(openFlow(`${forged}.${signature}`, secret)).toBeNull();
    expect(openFlow(`${payload}.${signature!.slice(1)}`, secret)).toBeNull();
    expect(openFlow(sealed, 'b'.repeat(64))).toBeNull();
    expect(openFlow(sealed, secret, flow.expires)).toBeNull();
    expect(openFlow(`${sealed}.x`, secret)).toBeNull();
    expect(openFlow(undefined, secret)).toBeNull();
    expect(openFlow('', secret)).toBeNull();
    expect(openFlow('not-a-cookie', secret)).toBeNull();
  });
});

describe('safeNext', () => {
  it('keeps paths on this app', () => {
    expect(safeNext('/')).toBe('/');
    expect(safeNext('/docs/hosting?tab=a#auth')).toBe('/docs/hosting?tab=a#auth');
    expect(safeNext('/status/../docs')).toBe('/docs');
  });
  it('falls back to the dashboard for anything else', () => {
    for (const next of [
      undefined,
      ['/docs'],
      '',
      'docs',
      'https://evil.example/',
      '//evil.example/',
      '/.//evil.example/',
      '/..//evil.example/',
      '/a/..//evil.example/',
      '/\\evil.example',
      '/\t/evil.example',
      'javascript:alert(1)',
      '/login?error=x',
    ])
      expect(safeNext(next)).toBe('/');
  });
});
