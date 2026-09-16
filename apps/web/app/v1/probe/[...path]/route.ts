import type { NextRequest } from 'next/server';
import { POST as proxy } from '../../../api/[...path]/route';
export const dynamic = 'force-dynamic';
export async function POST(request: NextRequest, context: { params: Promise<{ path: string[] }> }) {
  const { path } = await context.params;
  if (path.length !== 1 || !['enroll', 'poll', 'results'].includes(path[0]!))
    return Response.json({ error: 'Not found' }, { status: 404 });
  return proxy(request, { params: Promise.resolve({ path: ['v1', 'probe', ...path] }) });
}
