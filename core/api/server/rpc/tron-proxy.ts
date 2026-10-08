import { loadJurisdictionsAsync, validateJurisdictionsDataValue, type JurisdictionsData } from '../../../jurisdiction/adapter/kernel/jurisdiction-loader';
import { isActiveJurisdictionStatus } from '../../../jurisdiction/adapter/kernel/config';
import { isLoopbackUrl } from '../../../network/p2p/loopback-url';
import { createStructuredLogger } from '../../../support/logger';
import { safeStringify } from '../../../protocol/serialization';
import { fetchRpcProxyText, readBoundedProxyRequest, RpcProxyError } from './proxy-safety';

// Only SDK read/build calls and already-signed broadcasts. Never expose node signing,
// account management, arbitrary paths or caller-selected upstream URLs.
const FULL_METHODS = new Map([
  ['getnowblock', ['GET', 'POST']], ['getblock', ['POST']],
  ['getchainparameters', ['POST']], ['gettransactioninfobyid', ['POST']],
  ['triggerconstantcontract', ['POST']], ['estimateenergy', ['POST']],
  ['triggersmartcontract', ['POST']], ['broadcasthex', ['POST']],
]);

export function nativeRestUpstream(data: JurisdictionsData, pathname: string, method: string): string {
  const match = /^\/api\/tron\/(\d+)\/(wallet|walletsolidity)\/([a-z]+)$/.exec(pathname);
  if (!match) throw new RpcProxyError(400, 'TRON_PROXY_PATH_DENIED', pathname);
  const [, chain, lane, operation] = match;
  const allowed = lane === 'walletsolidity' && operation === 'getnowblock'
    ? ['GET', 'POST'] : lane === 'wallet' && operation ? FULL_METHODS.get(operation) : undefined;
  if (!allowed?.includes(method)) throw new RpcProxyError(400, 'TRON_PROXY_METHOD_DENIED', method);
  const configs = Object.values(data.jurisdictions).filter(config => config.chainId === Number(chain) && config.mode === 'tron' && isActiveJurisdictionStatus(config.status));
  const config = configs[0];
  if (configs.length !== 1 || !config || config.mode !== 'tron') throw new RpcProxyError(400, 'TRON_PROXY_JURISDICTION_UNKNOWN', String(chain));
  const host = lane === 'walletsolidity' ? config.tronSolidityHost ?? config.tronFullHost : config.tronFullHost;
  return `${host.replace(/\/$/, '')}/${lane}/${operation}`;
}

export function nativeRestProxyHost(chainId: number): string {
  if (!Number.isSafeInteger(chainId) || chainId <= 0) throw new Error('TRON_PROXY_CHAIN_ID_INVALID');
  return `/api/tron/${chainId}`;
}

export function publicNativeTransports(payload: string): string {
  const data = validateJurisdictionsDataValue(JSON.parse(payload));
  for (const config of Object.values(data['jurisdictions'] as Record<string, Record<string, unknown>>)) {
    if (config['mode'] !== 'tron') continue;
    const host = nativeRestProxyHost(Number(config['chainId']));
    config['tronFullHost'] = host;
    config['tronSolidityHost'] = host;
  }
  return safeStringify(data);
}

function requireNativeRequestObject(body: string): void {
  let value: unknown;
  try { value = JSON.parse(body); }
  catch { throw new RpcProxyError(400, 'TRON_PROXY_JSON_INVALID', 'invalid JSON'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new RpcProxyError(400, 'TRON_PROXY_JSON_INVALID', 'object required');
  }
}

export async function handleNativeRestProxy(
  req: Request, headers: HeadersInit,
  readJurisdictions: () => JurisdictionsData | Promise<JurisdictionsData> = loadJurisdictionsAsync,
): Promise<Response> {
  try {
    const url = new URL(req.url);
    if (url.search) throw new RpcProxyError(400, 'TRON_PROXY_QUERY_DENIED', 'query');
    const upstream = nativeRestUpstream(await readJurisdictions(), url.pathname, req.method);
    if (isLoopbackUrl(upstream) && (process.env['BLOCK_LOCAL_RPC_PROXY'] === 'true' ||
      (process.env['NODE_ENV'] === 'production' && process.env['XLN_ALLOW_LOCAL_RPC_PROXY'] !== '1'))) {
      return new Response(safeStringify({ error: 'Local RPC upstream is blocked in this environment' }), { status: 503, headers });
    }
    const body = req.method === 'POST' ? await readBoundedProxyRequest(req) : undefined;
    // TronWeb sends a null HTTP body for this parameterless read (not JSON null).
    if (body !== undefined && !(body === '' && url.pathname.endsWith('/wallet/getchainparameters'))) requireNativeRequestObject(body);
    const result = await fetchRpcProxyText(upstream, { method: req.method, headers: { 'content-type': 'application/json' }, ...(body === undefined ? {} : { body }), redirect: 'error' }, 5_000);
    return new Response(result.text, { status: result.response.status, headers });
  } catch (error) {
    createStructuredLogger('server.tron-proxy').error('request_failed', { path: new URL(req.url).pathname, error: error instanceof Error ? error.message : String(error) });
    return new Response(safeStringify({ error: error instanceof RpcProxyError ? error.code : 'TRON_PROXY_UPSTREAM_FAILED' }), { status: error instanceof RpcProxyError ? error.status : 502, headers });
  }
}
