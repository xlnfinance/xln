import type { RequestHandler } from './$types';
import { findForbiddenRpcProxyMethod, isLocalProxyRequest } from '../rpc-proxy-safety';

const DEFAULT_LOCAL_RPC2_URL = 'http://localhost:8546';

function resolveLocalRpc2UrlFromRequest(requestUrl: string): string {
  const { hostname, port } = new URL(requestUrl);
  if (hostname !== 'localhost') return DEFAULT_LOCAL_RPC2_URL;
  const currentPort = Number(port || 0);
  if (!Number.isFinite(currentPort) || currentPort < 1) return DEFAULT_LOCAL_RPC2_URL;
  if (currentPort === 8080) return DEFAULT_LOCAL_RPC2_URL;
  const shiftedRpcPort = currentPort - 3;
  if (shiftedRpcPort < 1) return DEFAULT_LOCAL_RPC2_URL;
  return `http://localhost:${shiftedRpcPort}`;
}

const getRpc2Url = (requestUrl: string): string => {
  if (isLocalProxyRequest(requestUrl)) {
    return resolveLocalRpc2UrlFromRequest(requestUrl);
  }
  const rpcUrl = process.env['RPC_TRON'] ?? process.env['ANVIL_RPC2'];
  if (!rpcUrl) {
    throw new Error('RPC2_PROXY_MISCONFIGURED: set RPC_TRON or ANVIL_RPC2 for non-local host');
  }
  return rpcUrl;
};

export const POST: RequestHandler = async ({ request }) => {
  try {
    const body = await request.text();
    const forbidden = findForbiddenRpcProxyMethod(body);
    if (forbidden) {
      return new Response(
        JSON.stringify({ error: 'RPC2 proxy method is not allowed', method: forbidden }),
        { status: forbidden.startsWith('invalid') || forbidden === 'empty-batch' ? 400 : 403, headers: { 'Content-Type': 'application/json' } },
      );
    }
    const upstream = await fetch(getRpc2Url(request.url), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });
    const data = await upstream.text();
    return new Response(data, {
      status: upstream.status,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-cache',
      },
    });
  } catch (error) {
    return new Response(
      JSON.stringify({
        error: 'RPC2 request failed',
        details: error instanceof Error ? error.message : String(error),
      }),
      { status: 503, headers: { 'Content-Type': 'application/json' } },
    );
  }
};

export const GET: RequestHandler = async () => {
  return new Response(
    JSON.stringify({ error: 'RPC2 proxy requires POST requests' }),
    { status: 405, headers: { 'Content-Type': 'application/json' } },
  );
};
