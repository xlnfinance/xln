import type { RequestHandler } from '@sveltejs/kit';
import { fetchRpcProxyText, readRpcProxyRequest, RpcProxyError } from './rpc-proxy-safety';

const DEFAULT_RPC_PROXY_TIMEOUT_MS = 5_000;

const readRpcProxyTimeoutMs = (): number => {
  const value = Number(process.env['XLN_RPC_PROXY_TIMEOUT_MS'] || '');
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : DEFAULT_RPC_PROXY_TIMEOUT_MS;
};

export const createRpcProxyHandler =
  (getRpcUrl: (requestUrl: string, clientAddress?: string) => string, label: string): RequestHandler =>
  async ({ request, getClientAddress }) => {
    try {
      const { bodyText, forbiddenMethod } = await readRpcProxyRequest(request);
      if (forbiddenMethod) {
        return new Response(
          JSON.stringify({ error: `${label} proxy method is not allowed`, method: forbiddenMethod }),
          { status: 403, headers: { 'Content-Type': 'application/json' } },
        );
      }
      const { response: upstream, text: data } = await fetchRpcProxyText(
        getRpcUrl(request.url, getClientAddress()),
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: bodyText,
        },
        readRpcProxyTimeoutMs(),
      );
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
          error: `${label} request failed`,
          details: error instanceof Error ? error.message : String(error),
        }),
        {
          status: error instanceof RpcProxyError ? error.status : 503,
          headers: { 'Content-Type': 'application/json' },
        },
      );
    }
  };
