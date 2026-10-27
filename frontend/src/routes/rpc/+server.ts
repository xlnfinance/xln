import type { RequestHandler } from './$types';
import { createRpcProxyHandler } from '../rpc-proxy-handler';
import { isLocalProxyRequest } from '../rpc-proxy-safety';

const DEFAULT_LOCAL_RPC_URL = 'http://localhost:8545';

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
  if (isLocalProxyRequest(requestUrl, clientAddress)) {
    return resolveLocalRpcUrlFromRequest(requestUrl);
  }
  const rpcUrl = process.env['RPC_ETHEREUM'] ?? process.env['ANVIL_RPC'];
  if (!rpcUrl) {
    throw new Error('RPC_PROXY_MISCONFIGURED: set RPC_ETHEREUM or ANVIL_RPC for non-local host');
  }
  return rpcUrl;
};

export const POST: RequestHandler = createRpcProxyHandler(getRpcUrl, 'RPC');

export const GET: RequestHandler = async () => {
  return new Response(
    JSON.stringify({ error: 'RPC proxy requires POST requests' }),
    { status: 405, headers: { 'Content-Type': 'application/json' } },
  );
};
