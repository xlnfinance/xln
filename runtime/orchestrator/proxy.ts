import { isLocalOperatorRequest } from '../health-redaction';
import { safeStringify } from '../serialization-utils';
import type { HubChild } from './orchestrator-types';

type ProxyHubEndpoint =
  | '/api/faucet/offchain'
  | '/api/lending/offer'
  | '/api/lending/borrow'
  | '/api/lending/repay';

type OrchestratorProxyDeps = {
  host: string;
  defaultRpcUrl: string;
  pollAllHubHealth: () => Promise<void>;
  getHubChildByEntityId: (hubEntityId: string) => HubChild | null;
  getHealthyHub: () => HubChild | null;
};

const CORS_JSON_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': '*',
  'Access-Control-Allow-Headers': '*',
  'Content-Type': 'application/json',
};

const FORBIDDEN_RPC_PROXY_METHODS = new Set([
  'eth_accounts',
  'eth_coinbase',
  'eth_sendTransaction',
  'eth_sign',
  'eth_signTransaction',
  'eth_submitHashrate',
  'eth_submitWork',
]);

const FORBIDDEN_RPC_PROXY_PREFIXES = [
  'admin_',
  'anvil_',
  'debug_',
  'evm_',
  'hardhat_',
  'miner_',
  'personal_',
  'txpool_',
  'wallet_',
];

const MAX_RPC_PROXY_INDEX = 8;

const serializeError = (error: unknown): string => error instanceof Error ? error.message : String(error);

export const resolveRpcProxyIndex = (pathname: string): number | null => {
  const match = String(pathname || '').match(/^\/(?:api\/)?rpc([2-8])?$/);
  if (!match) return null;
  if (!match[1]) return 1;
  const index = Number(match[1]);
  return Number.isInteger(index) && index >= 2 && index <= MAX_RPC_PROXY_INDEX ? index : null;
};

const findForbiddenRpcProxyMethod = (bodyText: string): string | null => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return 'invalid-json';
  }

  const calls = Array.isArray(parsed) ? parsed : [parsed];
  if (calls.length === 0) return 'empty-batch';

  for (const call of calls) {
    if (!call || typeof call !== 'object' || typeof (call as { method?: unknown }).method !== 'string') {
      return 'invalid-json-rpc';
    }
    const method = (call as { method: string }).method;
    if (FORBIDDEN_RPC_PROXY_METHODS.has(method) || FORBIDDEN_RPC_PROXY_PREFIXES.some(prefix => method.startsWith(prefix))) {
      return method;
    }
  }

  return null;
};

export const createOrchestratorProxyHandlers = (deps: OrchestratorProxyDeps) => {
  const proxyRpc = async (request: Request, upstreamRpcUrl = deps.defaultRpcUrl): Promise<Response> => {
    if (!upstreamRpcUrl) {
      return new Response(
        JSON.stringify({ error: 'RPC upstream is not configured' }),
        { status: 503, headers: CORS_JSON_HEADERS },
      );
    }
    try {
      const bodyText = await request.text();
      if (!isLocalOperatorRequest(request)) {
        const forbidden = findForbiddenRpcProxyMethod(bodyText);
        if (forbidden) {
          return new Response(
            JSON.stringify({ error: 'RPC proxy method is not allowed', method: forbidden }),
            { status: forbidden.startsWith('invalid') || forbidden === 'empty-batch' ? 400 : 403, headers: CORS_JSON_HEADERS },
          );
        }
      }
      const response = await fetch(upstreamRpcUrl, {
        method: 'POST',
        headers: {
          'content-type': request.headers.get('content-type') || 'application/json',
        },
        body: bodyText,
      });
      const text = await response.text();
      return new Response(text, {
        status: response.status,
        headers: {
          ...CORS_JSON_HEADERS,
          'content-type': response.headers.get('content-type') || 'application/json',
        },
      });
    } catch (error) {
      return new Response(
        JSON.stringify({ error: serializeError(error), upstream: upstreamRpcUrl }),
        { status: 502, headers: CORS_JSON_HEADERS },
      );
    }
  };

  const proxyHubApi = async (request: Request, endpoint: ProxyHubEndpoint): Promise<Response> => {
    let bodyText = '';
    let bodyJson: { hubEntityId?: string } | null = null;
    try {
      bodyText = await request.text();
      bodyJson = bodyText ? JSON.parse(bodyText) as { hubEntityId?: string } : {};
    } catch (error) {
      return new Response(safeStringify({ success: false, error: `Invalid JSON: ${serializeError(error)}` }), {
        status: 400,
        headers: CORS_JSON_HEADERS,
      });
    }

    await deps.pollAllHubHealth();
    const requestedHubId = String(bodyJson?.hubEntityId || '').toLowerCase();
    const child = deps.getHubChildByEntityId(requestedHubId);
    if (!child) {
      return new Response(safeStringify({
        success: false,
        error: `Hub not found for hubEntityId=${requestedHubId || 'missing'}`,
        code: 'FAUCET_HUB_NOT_FOUND',
      }), {
        status: 404,
        headers: CORS_JSON_HEADERS,
      });
    }

    try {
      const response = await fetch(`http://${deps.host}:${child.apiPort}${endpoint}`, {
        method: 'POST',
        headers: {
          'content-type': request.headers.get('content-type') || 'application/json',
        },
        body: bodyText,
      });
      const text = await response.text();
      return new Response(text, {
        status: response.status,
        headers: {
          ...CORS_JSON_HEADERS,
          'content-type': response.headers.get('content-type') || 'application/json',
        },
      });
    } catch (error) {
      return new Response(safeStringify({
        success: false,
        error: serializeError(error),
        code: 'FAUCET_PROXY_FAILED',
      }), {
        status: 502,
        headers: CORS_JSON_HEADERS,
      });
    }
  };

  const proxyAnyHubGet = async (request: Request, endpointWithQuery: string): Promise<Response> => {
    await deps.pollAllHubHealth();
    let requestedHubId = '';
    try {
      const parsed = new URL(endpointWithQuery, 'http://orchestrator.local');
      requestedHubId = String(parsed.searchParams.get('hubEntityId') || '').trim().toLowerCase();
    } catch {
      requestedHubId = '';
    }
    const child = requestedHubId ? deps.getHubChildByEntityId(requestedHubId) : deps.getHealthyHub();
    if (!child) {
      return new Response(safeStringify(requestedHubId
        ? { error: 'Requested hub API unavailable', hubEntityId: requestedHubId }
        : { error: 'No healthy hub API available' }), {
        status: requestedHubId ? 404 : 503,
        headers: CORS_JSON_HEADERS,
      });
    }

    try {
      const response = await fetch(`http://${deps.host}:${child.apiPort}${endpointWithQuery}`, {
        method: 'GET',
        headers: {
          'content-type': request.headers.get('content-type') || 'application/json',
        },
      });
      const text = await response.text();
      return new Response(text, {
        status: response.status,
        headers: {
          ...CORS_JSON_HEADERS,
          'content-type': response.headers.get('content-type') || 'application/json',
        },
      });
    } catch (error) {
      return new Response(safeStringify({
        error: serializeError(error),
        ...(requestedHubId ? { hubEntityId: requestedHubId, apiPort: child.apiPort } : {}),
      }), {
        status: 502,
        headers: CORS_JSON_HEADERS,
      });
    }
  };

  const proxyAnyHubRequest = async (request: Request, endpointWithQuery: string): Promise<Response> => {
    await deps.pollAllHubHealth();
    const child = deps.getHealthyHub();
    if (!child) {
      return new Response(safeStringify({ error: 'No healthy hub API available' }), {
        status: 503,
        headers: CORS_JSON_HEADERS,
      });
    }

    let bodyText = '';
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      bodyText = await request.text();
    }

    try {
      const response = await fetch(`http://${deps.host}:${child.apiPort}${endpointWithQuery}`, {
        method: request.method,
        headers: {
          'content-type': request.headers.get('content-type') || 'application/json',
        },
        ...(bodyText.length > 0 ? { body: bodyText } : {}),
      });
      const text = await response.text();
      return new Response(text, {
        status: response.status,
        headers: {
          ...CORS_JSON_HEADERS,
          'content-type': response.headers.get('content-type') || 'application/json',
        },
      });
    } catch (error) {
      return new Response(safeStringify({ error: serializeError(error) }), {
        status: 502,
        headers: CORS_JSON_HEADERS,
      });
    }
  };

  return {
    proxyAnyHubGet,
    proxyAnyHubRequest,
    proxyHubApi,
    proxyRpc,
  };
};
