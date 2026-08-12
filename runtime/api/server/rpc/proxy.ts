import type { RuntimeReplica } from '../../../runtime/types';
import { isLoopbackUrl } from '../../../network/p2p/loopback-url';
import { fetchRpcProxyText, readRpcProxyRequest, RpcProxyError } from './proxy-safety';
import { pushDebugEvent, type RelayStore } from '../../../network/relay/store';
import { safeStringify } from '../../../protocol/serialization';

const DEFAULT_RPC_PROXY_TIMEOUT_MS = 5_000;

type RuntimeRpcProxyRequest = {
  req: Request;
  pathname: string;
  env: RuntimeReplica | null;
  relayStore: RelayStore;
  headers: HeadersInit;
  operatorAuthorized: boolean;
};

const readRpcProxyTimeoutMs = (): number => {
  const value = Number(process.env['XLN_RPC_PROXY_TIMEOUT_MS'] || '');
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : DEFAULT_RPC_PROXY_TIMEOUT_MS;
};

const rpcEndpointLabel = (value: string): string => {
  try {
    const url = new URL(value);
    return `${url.protocol}//${url.host}`;
  } catch {
    return 'invalid-rpc-endpoint';
  }
};

const publicRpcError = (error: unknown): string => {
  const message = error instanceof Error ? error.message : String(error);
  const timeout = message.match(/RPC_PROXY_TIMEOUT:\d+/)?.[0];
  if (timeout) return timeout;
  if (error instanceof RpcProxyError) return error.code;
  return 'RPC upstream request failed';
};

export const handleRuntimeRpcProxy = async ({
  req,
  pathname,
  env,
  relayStore,
  headers,
  operatorAuthorized,
}: RuntimeRpcProxyRequest): Promise<Response> => {
  const blockLocal = process.env['BLOCK_LOCAL_RPC_PROXY'] === 'true';
  const explicitUpstream = process.env['RPC_UPSTREAM_URL'] || process.env['PUBLIC_RPC_URL'] || process.env['ANVIL_RPC'];
  const jMachineRpc = env?.activeJurisdiction ? env.state.jReplicas.get(env.activeJurisdiction)?.rpcs?.[0] : undefined;
  const upstream = explicitUpstream || jMachineRpc || '';
  const isLocal = isLoopbackUrl(upstream);
  const isProduction = process.env['NODE_ENV'] === 'production';

  if (!upstream) {
    pushDebugEvent(relayStore, {
      event: 'error',
      reason: 'RPC_PROXY_NO_UPSTREAM',
      details: { path: pathname },
    });
    return new Response(safeStringify({ error: 'RPC upstream not configured' }), { status: 503, headers });
  }
  if (isLocal && (blockLocal || (isProduction && process.env['XLN_ALLOW_LOCAL_RPC_PROXY'] !== '1'))) {
    pushDebugEvent(relayStore, {
      event: 'error',
      reason: 'RPC_PROXY_LOCAL_BLOCKED',
      details: { endpoint: rpcEndpointLabel(upstream), path: pathname },
    });
    return new Response(
      safeStringify({ error: 'Local RPC upstream is blocked in this environment' }),
      { status: 503, headers },
    );
  }

  try {
    const { bodyText, forbiddenMethod } = await readRpcProxyRequest(req);
    if (!(process.env['XLN_ALLOW_UNSAFE_RPC_PROXY'] === '1' || (!isProduction && operatorAuthorized))) {
      if (forbiddenMethod) {
        return new Response(
          safeStringify({ error: 'RPC proxy method is not allowed', method: forbiddenMethod }),
          { status: 403, headers },
        );
      }
    }
    const { response: rpcRes, text: respBody } = await fetchRpcProxyText(upstream, {
      method: 'POST',
      headers: {
        'content-type': req.headers.get('content-type') || 'application/json',
      },
      body: bodyText,
    }, readRpcProxyTimeoutMs());
    return new Response(respBody, {
      status: rpcRes.status,
      headers: {
        ...headers,
        'Content-Type': rpcRes.headers.get('content-type') || 'application/json',
      },
    });
  } catch (error: unknown) {
    const safeError = publicRpcError(error);
    pushDebugEvent(relayStore, {
      event: 'error',
      reason: 'RPC_PROXY_FETCH_FAILED',
      details: { endpoint: rpcEndpointLabel(upstream), path: pathname, error: safeError },
    });
    return new Response(safeStringify({
      error: safeError,
      ...(error instanceof RpcProxyError ? { code: error.code } : {}),
    }), { status: error instanceof RpcProxyError ? error.status : 502, headers });
  }
};
