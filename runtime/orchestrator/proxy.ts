import { classifyRuntimeTransportFailure, type RuntimeFailureSignal } from '../protocol/failure-taxonomy';
import { safeStringify } from '../protocol/serialization';
import type { HubChild } from './orchestrator-types';

type ProxyHubEndpoint =
  | '/api/faucet/offchain';

type ProxyEntityHubEndpoint =
  | '/api/external-wallet/snapshot';

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
  'Access-Control-Expose-Headers': 'X-XLN-Proxy-Health-Polled, X-XLN-Proxy-Health-Poll-Ms, X-XLN-Proxy-Upstream-Ms, X-XLN-Proxy-Total-Ms',
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
const DEFAULT_RPC_PROXY_TIMEOUT_MS = 5_000;
const DEFAULT_HUB_API_PROXY_TIMEOUT_MS = 5_000;
const DEFAULT_HUB_FAUCET_PROXY_TIMEOUT_MS = 30_000;
const LONG_RUNNING_HUB_ENDPOINTS = new Set([
  '/api/faucet/erc20',
  '/api/faucet/gas',
]);

const serializeError = (error: unknown): string => error instanceof Error ? error.message : String(error);

const proxyFailureBody = (input: {
  code: string;
  error: string;
  success?: false;
  extra?: Record<string, unknown>;
}): Record<string, unknown> & { failure: RuntimeFailureSignal } => {
  const failure = classifyRuntimeTransportFailure(input.code, input.error);
  return {
    ...(input.success === false ? { success: false } : {}),
    ...(input.extra ?? {}),
    error: input.error,
    code: failure.code,
    category: failure.category,
    retryable: failure.retryable,
    fatal: failure.fatal,
    failure,
  };
};

const rewriteHubRuntimeInputStatusUrl = (value: unknown, hubEntityId: string): string | null => {
  const statusUrl = String(value || '').trim();
  const match = statusUrl.match(/^\/api\/control\/runtime-input\/([^/]+)\/status$/);
  if (!match) return null;
  const receiptId = match[1] || '';
  if (!receiptId || !hubEntityId) return null;
  return `/api/hub/runtime-input/${receiptId}/status?hubEntityId=${encodeURIComponent(hubEntityId)}`;
};

const rewriteProxiedHubJsonBody = (text: string, hubEntityId: string): string => {
  if (!text || !hubEntityId) return text;
  try {
    const parsed = JSON.parse(text) as { statusUrl?: unknown };
    const rewrittenStatusUrl = rewriteHubRuntimeInputStatusUrl(parsed?.statusUrl, hubEntityId);
    if (!rewrittenStatusUrl) return text;
    return safeStringify({ ...parsed, statusUrl: rewrittenStatusUrl });
  } catch {
    return text;
  }
};

const readPositiveIntEnv = (name: string, fallback: number): number => {
  const value = Number(process.env[name] || '');
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
};

const readHubApiProxyTimeoutMs = (endpointWithQuery = ''): number => {
  const defaultTimeoutMs = readPositiveIntEnv(
    'XLN_HUB_API_PROXY_TIMEOUT_MS',
    readPositiveIntEnv('XLN_RPC_PROXY_TIMEOUT_MS', DEFAULT_HUB_API_PROXY_TIMEOUT_MS),
  );
  const pathname = endpointWithQuery.split('?', 1)[0] || '';
  if (!LONG_RUNNING_HUB_ENDPOINTS.has(pathname)) return defaultTimeoutMs;
  return readPositiveIntEnv(
    'XLN_HUB_FAUCET_PROXY_TIMEOUT_MS',
    Math.max(defaultTimeoutMs, DEFAULT_HUB_FAUCET_PROXY_TIMEOUT_MS),
  );
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
      throw new Error(`PROXY_UPSTREAM_TIMEOUT:${timeoutMs}`);
    }
    throw error;
  } finally {
    clearTimeout(timeoutHandle);
  }
};

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
  const proxyRpc = async (
    request: Request,
    upstreamRpcUrl = deps.defaultRpcUrl,
    operatorAuthorized = false,
  ): Promise<Response> => {
    if (!upstreamRpcUrl) {
      return new Response(
        safeStringify(proxyFailureBody({
          code: 'RPC_UPSTREAM_NOT_CONFIGURED',
          error: 'RPC upstream is not configured',
        })),
        { status: 503, headers: CORS_JSON_HEADERS },
      );
    }
    try {
      const bodyText = await request.text();
      if (!operatorAuthorized) {
        const forbidden = findForbiddenRpcProxyMethod(bodyText);
        if (forbidden) {
          return new Response(
            JSON.stringify({ error: 'RPC proxy method is not allowed', method: forbidden }),
            { status: forbidden.startsWith('invalid') || forbidden === 'empty-batch' ? 400 : 403, headers: CORS_JSON_HEADERS },
          );
        }
      }
      const timeoutMs = readPositiveIntEnv('XLN_RPC_PROXY_TIMEOUT_MS', DEFAULT_RPC_PROXY_TIMEOUT_MS);
      const { response, text } = await fetchTextWithTimeout(upstreamRpcUrl, {
        method: 'POST',
        headers: {
          'content-type': request.headers.get('content-type') || 'application/json',
        },
        body: bodyText,
      }, timeoutMs);
      return new Response(text, {
        status: response.status,
        headers: {
          ...CORS_JSON_HEADERS,
          'content-type': response.headers.get('content-type') || 'application/json',
        },
      });
    } catch (error) {
      return new Response(
        safeStringify(proxyFailureBody({
          code: 'RPC_PROXY_UPSTREAM_FAILED',
          error: serializeError(error),
          extra: { upstream: upstreamRpcUrl },
        })),
        { status: 502, headers: CORS_JSON_HEADERS },
      );
    }
  };

  const proxyHubApi = async (request: Request, endpoint: ProxyHubEndpoint): Promise<Response> => {
    const proxyStartedAt = Date.now();
    let healthPolled = false;
    let healthPollMs = 0;
    const proxyHeaders = (extra: Record<string, string> = {}): HeadersInit => ({
      ...CORS_JSON_HEADERS,
      'X-XLN-Proxy-Health-Polled': healthPolled ? '1' : '0',
      'X-XLN-Proxy-Health-Poll-Ms': String(healthPollMs),
      'X-XLN-Proxy-Total-Ms': String(Date.now() - proxyStartedAt),
      ...extra,
    });
    let bodyText = '';
    let bodyJson: { hubEntityId?: string } | null = null;
    try {
      bodyText = await request.text();
      bodyJson = bodyText ? JSON.parse(bodyText) as { hubEntityId?: string } : {};
    } catch (error) {
      return new Response(safeStringify({ success: false, error: `Invalid JSON: ${serializeError(error)}` }), {
        status: 400,
        headers: proxyHeaders(),
      });
    }

    const requestedHubId = String(bodyJson?.hubEntityId || '').toLowerCase();
    let child = deps.getHubChildByEntityId(requestedHubId);
    if (!child) {
      const pollStartedAt = Date.now();
      await deps.pollAllHubHealth();
      healthPolled = true;
      healthPollMs = Date.now() - pollStartedAt;
      child = deps.getHubChildByEntityId(requestedHubId);
    }
    if (!child) {
      return new Response(safeStringify(proxyFailureBody({
        success: false,
        code: 'FAUCET_HUB_NOT_FOUND',
        error: `Hub not found for hubEntityId=${requestedHubId || 'missing'}`,
      })), {
        status: 404,
        headers: proxyHeaders(),
      });
    }

    try {
      const upstreamStartedAt = Date.now();
      const timeoutMs = readHubApiProxyTimeoutMs(endpoint);
      const { response, text } = await fetchTextWithTimeout(`http://${deps.host}:${child.apiPort}${endpoint}`, {
        method: 'POST',
        headers: {
          'content-type': request.headers.get('content-type') || 'application/json',
        },
        body: bodyText,
      }, timeoutMs);
      const responseText = rewriteProxiedHubJsonBody(text, requestedHubId);
      return new Response(responseText, {
        status: response.status,
        headers: proxyHeaders({
          'content-type': response.headers.get('content-type') || 'application/json',
          'X-XLN-Proxy-Upstream-Ms': String(Date.now() - upstreamStartedAt),
        }),
      });
    } catch (error) {
      return new Response(safeStringify(proxyFailureBody({
        success: false,
        code: 'FAUCET_PROXY_FAILED',
        error: serializeError(error),
      })), {
        status: 502,
        headers: proxyHeaders(),
      });
    }
  };

  const proxyEntityHubApi = async (request: Request, endpoint: ProxyEntityHubEndpoint): Promise<Response> => {
    const proxyStartedAt = Date.now();
    let healthPolled = false;
    let healthPollMs = 0;
    const proxyHeaders = (extra: Record<string, string> = {}): HeadersInit => ({
      ...CORS_JSON_HEADERS,
      'X-XLN-Proxy-Health-Polled': healthPolled ? '1' : '0',
      'X-XLN-Proxy-Health-Poll-Ms': String(healthPollMs),
      'X-XLN-Proxy-Total-Ms': String(Date.now() - proxyStartedAt),
      ...extra,
    });
    let bodyText = '';
    let bodyJson: { entityId?: string } | null = null;
    try {
      bodyText = await request.text();
      bodyJson = bodyText ? JSON.parse(bodyText) as { entityId?: string } : {};
    } catch (error) {
      return new Response(safeStringify({ success: false, error: `Invalid JSON: ${serializeError(error)}` }), {
        status: 400,
        headers: proxyHeaders(),
      });
    }

    const requestedEntityId = String(bodyJson?.entityId || '').toLowerCase();
    let child = deps.getHubChildByEntityId(requestedEntityId);
    const routedByEntity = true;
    if (!child) {
      const pollStartedAt = Date.now();
      await deps.pollAllHubHealth();
      healthPolled = true;
      healthPollMs = Date.now() - pollStartedAt;
      child = deps.getHubChildByEntityId(requestedEntityId);
    }
    if (!child) {
      return new Response(safeStringify(proxyFailureBody({
        success: false,
        code: 'ENTITY_HUB_PROXY_ENTITY_NOT_FOUND',
        error: `Entity hub not found for entityId=${requestedEntityId || 'missing'}`,
      })), {
        // The orchestrator cannot distinguish an unknown Entity from a known
        // hub while its managed process is being replaced and has not
        // republished /api/info yet. Tell clients to retry; never turn a
        // transient restart into a permanent "not found" result.
        status: 503,
        headers: proxyHeaders(),
      });
    }

    try {
      const upstreamStartedAt = Date.now();
      const timeoutMs = readHubApiProxyTimeoutMs(endpoint);
      const { response, text } = await fetchTextWithTimeout(`http://${deps.host}:${child.apiPort}${endpoint}`, {
        method: 'POST',
        headers: {
          'content-type': request.headers.get('content-type') || 'application/json',
        },
        body: bodyText,
      }, timeoutMs);
      return new Response(text, {
        status: response.status,
        headers: proxyHeaders({
          'content-type': response.headers.get('content-type') || 'application/json',
          'X-XLN-Proxy-Upstream-Ms': String(Date.now() - upstreamStartedAt),
          'X-XLN-Proxy-Routed-By-Entity': routedByEntity ? '1' : '0',
        }),
      });
    } catch (error) {
      return new Response(safeStringify(proxyFailureBody({
        success: false,
        code: 'ENTITY_HUB_PROXY_FAILED',
        error: serializeError(error),
      })), {
        status: 502,
        headers: proxyHeaders(),
      });
    }
  };

  const proxyAnyHubGet = async (request: Request, endpointWithQuery: string): Promise<Response> => {
    await deps.pollAllHubHealth();
    let parsedEndpoint: URL;
    try {
      parsedEndpoint = new URL(endpointWithQuery, 'http://orchestrator.local');
    } catch (error) {
      return new Response(safeStringify(proxyFailureBody({
        code: 'HUB_PROXY_ENDPOINT_INVALID',
        error: serializeError(error),
      })), { status: 400, headers: CORS_JSON_HEADERS });
    }
    const requestedHubId = String(parsedEndpoint.searchParams.get('hubEntityId') || '').trim().toLowerCase();
    const child = requestedHubId ? deps.getHubChildByEntityId(requestedHubId) : deps.getHealthyHub();
    if (!child) {
      return new Response(safeStringify(requestedHubId
        ? proxyFailureBody({
          code: 'REQUESTED_HUB_API_UNAVAILABLE',
          error: 'Requested hub API unavailable',
          extra: { hubEntityId: requestedHubId },
        })
        : proxyFailureBody({
          code: 'NO_HEALTHY_HUB_API_AVAILABLE',
          error: 'No healthy hub API available',
        })), {
        status: requestedHubId ? 404 : 503,
        headers: CORS_JSON_HEADERS,
      });
    }

    try {
      const { response, text } = await fetchTextWithTimeout(`http://${deps.host}:${child.apiPort}${endpointWithQuery}`, {
        method: 'GET',
        headers: {
          'content-type': request.headers.get('content-type') || 'application/json',
        },
      }, readHubApiProxyTimeoutMs(endpointWithQuery));
      return new Response(text, {
        status: response.status,
        headers: {
          ...CORS_JSON_HEADERS,
          'content-type': response.headers.get('content-type') || 'application/json',
        },
      });
    } catch (error) {
      return new Response(safeStringify(proxyFailureBody({
        code: 'HUB_API_PROXY_FAILED',
        error: serializeError(error),
        extra: requestedHubId ? { hubEntityId: requestedHubId, apiPort: child.apiPort } : {},
      })), {
        status: 502,
        headers: CORS_JSON_HEADERS,
      });
    }
  };

  const proxyAnyHubRequest = async (request: Request, endpointWithQuery: string): Promise<Response> => {
    await deps.pollAllHubHealth();
    const child = deps.getHealthyHub();
    if (!child) {
      return new Response(safeStringify(proxyFailureBody({
        code: 'NO_HEALTHY_HUB_API_AVAILABLE',
        error: 'No healthy hub API available',
      })), {
        status: 503,
        headers: CORS_JSON_HEADERS,
      });
    }

    let bodyText = '';
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      bodyText = await request.text();
    }

    try {
      const { response, text } = await fetchTextWithTimeout(`http://${deps.host}:${child.apiPort}${endpointWithQuery}`, {
        method: request.method,
        headers: {
          'content-type': request.headers.get('content-type') || 'application/json',
        },
        ...(bodyText.length > 0 ? { body: bodyText } : {}),
      }, readHubApiProxyTimeoutMs(endpointWithQuery));
      return new Response(text, {
        status: response.status,
        headers: {
          ...CORS_JSON_HEADERS,
          'content-type': response.headers.get('content-type') || 'application/json',
        },
      });
    } catch (error) {
      return new Response(safeStringify(proxyFailureBody({
        code: 'HUB_API_PROXY_FAILED',
        error: serializeError(error),
      })), {
        status: 502,
        headers: CORS_JSON_HEADERS,
      });
    }
  };

  return {
    proxyAnyHubGet,
    proxyAnyHubRequest,
    proxyEntityHubApi,
    proxyHubApi,
    proxyRpc,
  };
};
