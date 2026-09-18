import { NextResponse, type NextRequest } from 'next/server';
import { isStatusDomain, statusDomainAction } from './lib/status-domain';

export function proxy(request: NextRequest) {
  if (!isStatusDomain(request.headers.get('host'), process.env.STATUS_PAGE_DOMAINS))
    return NextResponse.next();

  const action = statusDomainAction(request.nextUrl.pathname, request.method);
  if (action === 'deny') return new NextResponse('Not found', { status: 404 });
  // Never forward dashboard credentials through a public hostname.
  const headers = new Headers(request.headers);
  headers.delete('cookie');
  headers.delete('authorization');
  const url = request.nextUrl.clone();
  url.pathname = '/status';
  const response =
    action === 'rewrite'
      ? NextResponse.rewrite(url, { request: { headers } })
      : NextResponse.next({ request: { headers } });
  if (!request.nextUrl.pathname.startsWith('/_next/static/'))
    response.headers.set('Cache-Control', 'no-store');
  response.headers.set('X-Content-Type-Options', 'nosniff');
  return response;
}
