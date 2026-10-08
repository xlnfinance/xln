import { fetchRpcProxyText } from './proxy-safety';

const ALLOWED_LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost']);

/** Ordinary API bodies stay small; only the watchtower proxy carries an encrypted backup. */
export const API_MAX_BODY_BYTES = 1024 * 1024;
/** A tower's default per-key quota (core/watchtower/standalone-server.ts) plus its appointment envelope. */
export const WATCHTOWER_DEFAULT_MAX_STORED_BYTES = 4 * 1024 * 1024;
export const WATCHTOWER_PROXY_MAX_BODY_BYTES = WATCHTOWER_DEFAULT_MAX_STORED_BYTES + 64 * 1024;
export const WATCHTOWER_PROXY_PATH = '/api/watchtower-proxy';

/**
 * Bun applies one body limit to a whole server, so the server is sized for the
 * proxy and every other route is held to the ordinary limit here, before any
 * route reads its body. A declared length over the limit is refused with 413.
 */
export const oversizedBodyResponse = (req: Request, pathname: string, headers?: HeadersInit): Response | null => {
  const declared = Number(req.headers.get('content-length') ?? '0');
  const limit = pathname === WATCHTOWER_PROXY_PATH ? WATCHTOWER_PROXY_MAX_BODY_BYTES : API_MAX_BODY_BYTES;
  if (!Number.isFinite(declared) || declared <= limit) return null;
  return new Response(JSON.stringify({ error: 'Request body too large', limit }), { status: 413, ...(headers ? { headers } : {}) });
};
const WATCHTOWER_PROXY_TIMEOUT_MS = 5_000;

const allowedLocalPorts = (): ReadonlySet<string> => new Set(
  String(process.env['XLN_WATCHTOWER_PROXY_PORTS'] || process.env['XLN_WATCHTOWER_PORT'] || '9100')
    .split(',')
    .map(port => port.trim())
    .filter(port => /^\d{1,5}$/.test(port) && Number(port) <= 65_535),
);

const isAllowedTowerPath = (path: string): boolean =>
  path === '/'
  || path === '/healthz'
  || path === '/api/tower/healthz'
  || path === '/api/tower/restore'
  || path === '/api/tower/appointment'
  || path === '/api/recovery/discover'
  || path === '/api/recovery/state'
  || path === '/api/push/register'
  || path === '/api/push/unregister'
  || path.startsWith('/api/tower/receipt/');

const resolveLocalTowerUrl = (target: string, path: string): URL => {
  const baseUrl = new URL(target);
  if (baseUrl.protocol !== 'http:' || !ALLOWED_LOCAL_HOSTS.has(baseUrl.hostname)) {
    throw new Error('WATCHTOWER_PROXY_TARGET_NOT_ALLOWED');
  }
  if (!allowedLocalPorts().has(baseUrl.port || '80')) {
    throw new Error('WATCHTOWER_PROXY_PORT_NOT_ALLOWED');
  }
  const resolvedUrl = new URL(path, `${baseUrl.toString().replace(/\/+$/, '')}/`);
  if (resolvedUrl.origin !== baseUrl.origin || !isAllowedTowerPath(resolvedUrl.pathname)) {
    throw new Error(`WATCHTOWER_PROXY_PATH_NOT_ALLOWED: ${resolvedUrl.pathname}`);
  }
  return resolvedUrl;
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
    const { response: upstream, text: payload } = await fetchRpcProxyText(upstreamUrl.toString(), {
      method: req.method,
      headers: {
        accept: req.headers.get('accept') || 'application/json',
        ...(req.headers.get('content-type')
          ? { 'content-type': req.headers.get('content-type')! }
          : {}),
      },
      ...(body !== undefined ? { body } : {}),
    }, WATCHTOWER_PROXY_TIMEOUT_MS, 'WATCHTOWER_PROXY_TIMEOUT');
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
