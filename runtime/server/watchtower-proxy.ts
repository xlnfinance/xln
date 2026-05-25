const ALLOWED_LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost']);

const isAllowedTowerPath = (path: string): boolean =>
  path === '/'
  || path === '/healthz'
  || path === '/api/tower/restore'
  || path === '/api/tower/appointment'
  || path.startsWith('/api/tower/receipt/');

const resolveLocalTowerUrl = (target: string, path: string): URL => {
  const baseUrl = new URL(target);
  if (baseUrl.protocol !== 'http:' || !ALLOWED_LOCAL_HOSTS.has(baseUrl.hostname)) {
    throw new Error('WATCHTOWER_PROXY_TARGET_NOT_ALLOWED');
  }
  if (!isAllowedTowerPath(path)) {
    throw new Error(`WATCHTOWER_PROXY_PATH_NOT_ALLOWED: ${path}`);
  }
  return new URL(path, `${baseUrl.toString().replace(/\/+$/, '')}/`);
};

export const handleWatchtowerProxy = async (req: Request): Promise<Response> => {
  try {
    const requestUrl = new URL(req.url);
    const target = String(requestUrl.searchParams.get('target') || '').trim();
    const path = String(requestUrl.searchParams.get('path') || '').trim() || '/';
    if (!target) {
      return new Response(JSON.stringify({ error: 'WATCHTOWER_PROXY_TARGET_REQUIRED' }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      });
    }

    const upstreamUrl = resolveLocalTowerUrl(target, path);
    const body = req.method === 'GET' || req.method === 'HEAD' ? undefined : await req.text();
    const upstream = await fetch(upstreamUrl, {
      method: req.method,
      headers: {
        accept: req.headers.get('accept') || 'application/json',
        ...(req.headers.get('content-type')
          ? { 'content-type': req.headers.get('content-type')! }
          : {}),
      },
      ...(body !== undefined ? { body } : {}),
    });
    const payload = await upstream.text();
    return new Response(payload, {
      status: upstream.status,
      headers: {
        'content-type': upstream.headers.get('content-type') || 'application/json',
        'cache-control': 'no-cache',
      },
    });
  } catch (error) {
    return new Response(JSON.stringify({
      error: 'WATCHTOWER_PROXY_FAILED',
      details: error instanceof Error ? error.message : String(error),
    }), {
      status: 503,
      headers: { 'content-type': 'application/json' },
    });
  }
};
