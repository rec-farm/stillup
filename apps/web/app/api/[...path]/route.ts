import type { NextRequest } from 'next/server';
export const dynamic = 'force-dynamic';
async function proxy(request: NextRequest, context: { params: Promise<{ path: string[] }> }) {
  const { path } = await context.params;
  if (path[0] !== 'v1') return Response.json({ error: 'Not found' }, { status: 404 });
  const target = new URL(
    path.map(encodeURIComponent).join('/') + request.nextUrl.search,
    (process.env.API_URL ?? 'http://127.0.0.1:3001') + '/',
  );
  const headers = new Headers();
  for (const name of ['content-type', 'cookie', 'origin', 'sec-fetch-site', 'authorization']) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  try {
    const body = ['GET', 'HEAD'].includes(request.method) ? undefined : await request.text();
    if (body && Buffer.byteLength(body) > 100000)
      return Response.json({ error: 'Request is too large' }, { status: 413 });
    const response = await fetch(target, {
      method: request.method,
      headers,
      body,
      cache: 'no-store',
      redirect: 'manual',
      signal: AbortSignal.timeout(40000),
    });
    const output = new Headers({ 'content-type': 'application/json', 'cache-control': 'no-store' });
    for (const value of response.headers.getSetCookie()) output.append('set-cookie', value);
    // Sign-in with OIDC is a chain of redirects through the API (start, then callback).
    const location = response.headers.get('location');
    if (location && response.status >= 300 && response.status < 400)
      output.set('location', location);
    return new Response(response.body, { status: response.status, headers: output });
  } catch {
    return Response.json(
      { error: 'Cannot reach StillUp. Check that the API service is running.' },
      { status: 503 },
    );
  }
}
export { proxy as GET, proxy as POST, proxy as PATCH, proxy as PUT, proxy as DELETE };
