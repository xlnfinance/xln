import type { RequestHandler } from './$types';
import { findForbiddenRpcProxyMethod, isLocalProxyRequest } from '../rpc-proxy-safety';

const DEFAULT_LOCAL_RPC_URL = 'http://localhost:8545';
const DEFAULT_RPC_PROXY_TIMEOUT_MS = 5_000;

const readRpcProxyTimeoutMs = (): number => {
  const value = Number(process.env['XLN_RPC_PROXY_TIMEOUT_MS'] || '');
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : DEFAULT_RPC_PROXY_TIMEOUT_MS;
};

const fetchTextWithTimeout = async (
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<{ response: Response; text: string }> => {
  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    const text = await response.text();
    return { response, text };
  } catch (error) {
    if ((error as Error)?.name === 'AbortError') {
      throw new Error(`RPC_PROXY_TIMEOUT:${timeoutMs}`);
    }
    throw error;
  } finally {
    clearTimeout(timeoutHandle);
  }
};

function resolveLocalRpcUrlFromRequest(requestUrl: string): string {
  const { hostname, port } = new URL(requestUrl);
  if (hostname !== 'localhost') return DEFAULT_LOCAL_RPC_URL;
  const currentPort = Number(port || 0);
  if (!Number.isFinite(currentPort) || currentPort < 1) return DEFAULT_LOCAL_RPC_URL;
  if (currentPort === 8080) return DEFAULT_LOCAL_RPC_URL;
  const shiftedRpcPort = currentPort - 4;
  if (shiftedRpcPort < 1) return DEFAULT_LOCAL_RPC_URL;
  return `http://localhost:${shiftedRpcPort}`;
}

const getRpcUrl = (requestUrl: string, clientAddress?: string): string => {
  const url = new URL(requestUrl);
  if (isLocalProxyRequest(requestUrl, clientAddress)) {
    return resolveLocalRpcUrlFromRequest(requestUrl);
  }
  const rpcUrl = process.env['RPC_ETHEREUM'] ?? process.env['ANVIL_RPC'];
  if (!rpcUrl) {
    throw new Error('RPC_PROXY_MISCONFIGURED: set RPC_ETHEREUM or ANVIL_RPC for non-local host');
  }
  return rpcUrl;
};

export const POST: RequestHandler = async ({ request, getClientAddress }) => {
  try {
    const body = await request.text();
    const forbidden = findForbiddenRpcProxyMethod(body);
    if (forbidden) {
      return new Response(
        JSON.stringify({ error: 'RPC proxy method is not allowed', method: forbidden }),
        { status: forbidden.startsWith('invalid') || forbidden === 'empty-batch' ? 400 : 403, headers: { 'Content-Type': 'application/json' } },
      );
    }
    const { response: upstream, text: data } = await fetchTextWithTimeout(getRpcUrl(request.url, getClientAddress()), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    }, readRpcProxyTimeoutMs());
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
        error: 'RPC request failed',
        details: error instanceof Error ? error.message : String(error),
      }),
      { status: 503, headers: { 'Content-Type': 'application/json' } },
    );
  }
};

export const GET: RequestHandler = async () => {
  return new Response(
    JSON.stringify({ error: 'RPC proxy requires POST requests' }),
    { status: 405, headers: { 'Content-Type': 'application/json' } },
  );
};
