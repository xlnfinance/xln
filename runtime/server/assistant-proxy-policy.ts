import { parseAllowedAssistantModels } from './assistant-proxy-input';

export type AssistantProxyConfig = Readonly<{
  upstreamUrl: string;
  allowedModels: readonly string[];
  rateWindowMs: number;
  perClientRateLimit: number;
  globalRateLimit: number;
  maxConcurrentStreams: number;
  catalogTimeoutMs: number;
  streamTimeoutMs: number;
}>;

const readPositiveEnv = (name: string, fallback: number): number => {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
};

const readUpstreamUrl = (): string => {
  const raw = String(process.env['XLN_AI_SERVER_URL'] || 'http://127.0.0.1:3031').replace(/\/+$/, '');
  const url = new URL(raw);
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password) {
    throw new Error('XLN_AI_SERVER_URL must be an http(s) URL without embedded credentials');
  }
  return raw;
};

export const readAssistantProxyConfig = (): AssistantProxyConfig => ({
  upstreamUrl: readUpstreamUrl(),
  allowedModels: parseAllowedAssistantModels(process.env['XLN_ASSISTANT_ALLOWED_MODELS']),
  rateWindowMs: readPositiveEnv('XLN_ASSISTANT_RATE_WINDOW_MS', 60_000),
  perClientRateLimit: readPositiveEnv('XLN_ASSISTANT_PER_CLIENT_RATE_LIMIT', 30),
  globalRateLimit: readPositiveEnv('XLN_ASSISTANT_GLOBAL_RATE_LIMIT', 300),
  maxConcurrentStreams: readPositiveEnv('XLN_ASSISTANT_MAX_CONCURRENT_STREAMS', 4),
  catalogTimeoutMs: readPositiveEnv('XLN_ASSISTANT_CATALOG_TIMEOUT_MS', 2_500),
  streamTimeoutMs: readPositiveEnv('XLN_ASSISTANT_STREAM_TIMEOUT_MS', 180_000),
});

const LOOPBACK_CLIENTS = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

export const resolveAssistantDirectClientIp = (server: unknown, request: Request): string => {
  const requestIp = (server as { requestIP?: (value: Request) => { address?: string } | null }).requestIP;
  if (typeof requestIp !== 'function') return 'direct';
  return String(requestIp.call(server, request)?.address || 'direct');
};

export const resolveAssistantRateClientId = (request: Request, directClientIp: string): string => {
  const direct = String(directClientIp || 'direct').trim();
  // Forwarded headers are attacker-controlled on a public socket. Trust them
  // only when the TCP peer is our loopback reverse proxy; otherwise one caller
  // could rotate X-Forwarded-For values to evade the per-client budget.
  if (!LOOPBACK_CLIENTS.has(direct)) return direct;
  const realIp = request.headers.get('x-real-ip')?.trim();
  if (realIp) return realIp;
  // nginx's $proxy_add_x_forwarded_for appends the actual peer after any
  // attacker-supplied XFF values. With one trusted loopback proxy, the last
  // non-empty hop is therefore the client address; the first hop is spoofable.
  const forwarded = request.headers.get('x-forwarded-for')
    ?.split(',')
    .map(value => value.trim())
    .filter(Boolean)
    .at(-1);
  return forwarded || direct;
};

export const normalizeAssistantClientId = (value: string): string =>
  String(value || 'direct')
    .replace(/[^a-zA-Z0-9:._-]/g, '')
    .slice(0, 96) || 'direct';

export const isSameOriginAssistantRequest = (request: Request): boolean => {
  const fetchSite = request.headers.get('sec-fetch-site');
  if (fetchSite === 'cross-site') return false;
  // Browsers own Sec-Fetch-Site. Trust its same-origin verdict even when a dev or
  // production reverse proxy rewrites Host before the request reaches Bun.
  if (fetchSite === 'same-origin') return true;
  const origin = request.headers.get('origin');
  if (!origin) return true;
  try {
    const originUrl = new URL(origin);
    const requestUrl = new URL(request.url);
    return (originUrl.protocol === 'http:' || originUrl.protocol === 'https:') && originUrl.host === requestUrl.host;
  } catch {
    return false;
  }
};
