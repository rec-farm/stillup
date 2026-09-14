import 'server-only';
import { cookies } from 'next/headers';
export async function serverApi(path: string, authenticated = true) {
  const cookie = authenticated ? (await cookies()).toString() : '';
  return fetch(`${process.env.API_URL ?? 'http://127.0.0.1:3001'}/v1/${path}`, {
    headers: { cookie },
    cache: 'no-store',
    signal: AbortSignal.timeout(5000),
  });
}
