import { describe, expect, it } from 'vitest';
import { isStatusDomain, statusDomainAction } from './status-domain';

describe('public hostname routing', () => {
  it('matches exact configured hosts, including case, trailing dots, and development ports', () => {
    expect(isStatusDomain('STATUS.example.com:3000', 'status.example.com, status.other.com')).toBe(
      true,
    );
    expect(isStatusDomain('status.example.com.', 'status.example.com')).toBe(true);
    for (const host of [
      null,
      '',
      'evilstatus.example.com',
      'status.example.com.evil.com',
      'dashboard.example.com',
    ])
      expect(isStatusDomain(host, 'status.example.com')).toBe(false);
    expect(isStatusDomain('anything.example.com')).toBe(false);
  });
  it('permits the page and read-only public data while denying dashboard, login, and writes', () => {
    expect(statusDomainAction('/', 'GET')).toBe('rewrite');
    expect(statusDomainAction('/status', 'HEAD')).toBe('allow');
    expect(statusDomainAction('/_next/static/chunks/example.js', 'GET')).toBe('allow');
    expect(statusDomainAction('/api/v1/public/status', 'GET')).toBe('allow');
    for (const path of [
      '/login',
      '/docs',
      '/api/v1/status-management',
      '/api/v1/public/workspace',
      '/_next/image',
      '/api/v1/public/status/extra',
    ])
      expect(statusDomainAction(path, 'GET')).toBe('deny');
    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH'])
      expect(statusDomainAction('/api/v1/public/status', method)).toBe('deny');
  });
});
