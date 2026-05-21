import type { Env } from '../types';
import { isLocalOperatorRequest } from '../health-redaction';
import { isLoopbackUrl } from '../loopback-url';
import { findForbiddenRpcProxyMethod } from '../rpc-proxy-safety';
import { pushDebugEvent, type RelayStore } from '../relay-store';
import { safeStringify } from '../serialization-utils';
import { getErrorMessage } from '../server-utils';

type RuntimeRpcProxyRequest = {
  req: Request;
  pathname: string;
  env: Env | null;
  relayStore: RelayStore;
  headers: HeadersInit;
};

export const handleRuntimeRpcProxy = async ({
  req,
  pathname,
  env,
  relayStore,
  headers,
}: RuntimeRpcProxyRequest): Promise<Response> => {
  const blockLocal = process.env['BLOCK_LOCAL_RPC_PROXY'] === 'true';
  const explicitUpstream = process.env['RPC_UPSTREAM_URL'] || process.env['PUBLIC_RPC_URL'] || process.env['ANVIL_RPC'];
  const jMachineRpc = env?.activeJurisdiction ? env.jReplicas.get(env.activeJurisdiction)?.rpcs?.[0] : undefined;
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
      details: { upstream, path: pathname },
    });
    return new Response(
      JSON.stringify({
        error: 'Local RPC upstream is blocked in this environment',
        upstream,
      }),
      { status: 503, headers },
    );
  }

  try {
    const bodyText = await req.text();
    if (!(process.env['XLN_ALLOW_UNSAFE_RPC_PROXY'] === '1' || (!isProduction && isLocalOperatorRequest(req)))) {
      const forbidden = findForbiddenRpcProxyMethod(bodyText);
      if (forbidden) {
        return new Response(
          safeStringify({ error: 'RPC proxy method is not allowed', method: forbidden }),
          { status: forbidden.startsWith('invalid') || forbidden === 'empty-batch' ? 400 : 403, headers },
        );
      }
    }
    const rpcRes = await fetch(upstream, {
      method: 'POST',
      headers: {
        'content-type': req.headers.get('content-type') || 'application/json',
      },
      body: bodyText,
    });
    const respBody = await rpcRes.text();
    return new Response(respBody, {
      status: rpcRes.status,
      headers: {
        ...headers,
        'Content-Type': rpcRes.headers.get('content-type') || 'application/json',
      },
    });
  } catch (error: unknown) {
    pushDebugEvent(relayStore, {
      event: 'error',
      reason: 'RPC_PROXY_FETCH_FAILED',
      details: { upstream, path: pathname, error: getErrorMessage(error, String(error)) },
    });
    return new Response(safeStringify({ error: getErrorMessage(error, 'RPC proxy failed') }), { status: 502, headers });
  }
};
