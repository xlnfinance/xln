/** HTTP only; the officer's governance capability never crosses this proxy. */
export async function proxyCreditOfficer(request: Request, port: number | null): Promise<Response | null> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith('/api/credit-officer/')) return null;
  if (port === null) {
    return Response.json({ success: true, enabled: false, error: 'CREDIT_OFFICER_DISABLED' });
  }
  if (request.method !== 'GET' && request.method !== 'POST') return new Response(null, { status: 405 });
  if (Number(request.headers.get('content-length')) > 4096) return new Response(null, { status: 413 });
  try {
    const body = request.method === 'POST' ? await request.text() : undefined;
    if (body && body.length > 4096) return new Response(null, { status: 413 });
    const target = new URL(url.pathname + url.search, `http://127.0.0.1:${port}`);
    return await fetch(target, {
      method: request.method,
      headers: { 'Content-Type': 'application/json' },
      ...(body !== undefined ? { body } : {}),
      signal: AbortSignal.timeout(25_000),
    });
  } catch (cause) {
    console.error('CREDIT_OFFICER_PROXY_FAILED', cause);
    return Response.json({ success: false, error: 'CREDIT_OFFICER_UNAVAILABLE' }, { status: 503 });
  }
}
