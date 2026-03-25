import type { RequestHandler } from './$types';

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

const getRpcUrl = (requestUrl: string): string => {
  const url = new URL(requestUrl);
  const isLocalHost = url.hostname === 'localhost';
  if (isLocalHost) {
    return resolveLocalRpcUrlFromRequest(requestUrl);
  }
  const rpcUrl = process.env.RPC_ETHEREUM ?? process.env.ANVIL_RPC;
  if (!rpcUrl) {
    throw new Error('RPC_PROXY_MISCONFIGURED: set RPC_ETHEREUM or ANVIL_RPC for non-local host');
  }
  return rpcUrl;
};

export const POST: RequestHandler = async ({ request }) => {
  try {
    const body = await request.text();
    const upstream = await fetch(getRpcUrl(request.url), {
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
