import type { RequestHandler } from './$types';

const getRpcUrl = (): string => {
  const rpcUrl = process.env.RPC_ETHEREUM ?? process.env.ANVIL_RPC;
  if (!rpcUrl) {
    throw new Error('RPC_PROXY_MISCONFIGURED: set RPC_ETHEREUM or ANVIL_RPC');
  }
  return rpcUrl;
};

export const POST: RequestHandler = async ({ request }) => {
  try {
    const body = await request.text();
    const upstream = await fetch(getRpcUrl(), {
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
