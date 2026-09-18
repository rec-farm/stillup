/** Only the actual Host is trusted. The ingress must preserve it and strip forwarded headers. */
export function isStatusDomain(host: string | null, domains = ''): boolean {
  const hostname = (host ?? '').toLowerCase().replace(/:\d+$/, '').replace(/\.$/, '');
  return domains.split(',').some((domain) => {
    const allowed = domain.trim().toLowerCase().replace(/\.$/, '');
    return !!allowed && hostname === allowed;
  });
}

export function statusDomainAction(path: string, method: string) {
  if (!['GET', 'HEAD'].includes(method)) return 'deny';
  if (path === '/') return 'rewrite';
  if (
    path === '/status' ||
    path === '/icon.svg' ||
    path === '/apple-icon.png' ||
    path === '/api/v1/public/status' ||
    path.startsWith('/_next/static/')
  )
    return 'allow';
  return 'deny';
}
