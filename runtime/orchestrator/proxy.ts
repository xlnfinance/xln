import { classifyRuntimeTransportFailure, type RuntimeFailureSignal } from '../protocol/errors/failure-taxonomy';
import { requireBoundaryRecord } from '../protocol/boundary-validation';
import { safeStringify } from '../protocol/serialization';
import { readPositiveIntegerEnv } from '../config/environment';
import {
  MAX_WALLET_SNAPSHOT_BODY_BYTES,
  readCappedRequestText,
  RequestBodyError,
} from '../api/public/external-wallet/http';
import type { HubChild } from './orchestrator-types';
import { fetchRpcProxyText, readRpcProxyRequest, RpcProxyError } from '../api/server/rpc/proxy-safety';

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

const MAX_RPC_PROXY_INDEX = 8;
const DEFAULT_RPC_PROXY_TIMEOUT_MS = 5_000;
const DEFAULT_HUB_API_PROXY_TIMEOUT_MS = 5_000;
const DEFAULT_HUB_FAUCET_PROXY_TIMEOUT_MS = 30_000;
const MAX_PUBLIC_HUB_PROXY_BODY_BYTES = 1024 * 1024;
const PUBLIC_HUB_PROXY_MARKER = { forwarded: 'for=_xln_public_proxy' } as const;
const LONG_RUNNING_HUB_ENDPOINTS = new Set([
  '/api/faucet/erc20',
  '/api/faucet/gas',
]);

const serializeError = (error: unknown): string => error instanceof Error ? error.message : String(error);

const publicRpcProxyError = (error: unknown): string => {
  const message = serializeError(error);
  const timeout = message.match(/PROXY_UPSTREAM_TIMEOUT:\d+/)?.[0];
  if (timeout) return timeout;
  if (error instanceof RpcProxyError) return error.code;
  return 'RPC upstream request failed';
};

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
    const parsed = requireBoundaryRecord(JSON.parse(text), 'HUB_PROXY_RESPONSE_INVALID');
    const rewrittenStatusUrl = rewriteHubRuntimeInputStatusUrl(parsed['statusUrl'], hubEntityId);
    if (!rewrittenStatusUrl) return text;
    return safeStringify({ ...parsed, statusUrl: rewrittenStatusUrl });
  } catch {
    return text;
  }
};

const readHubApiProxyTimeoutMs = (endpointWithQuery = ''): number => {
  const defaultTimeoutMs = readPositiveIntegerEnv(
    'XLN_HUB_API_PROXY_TIMEOUT_MS',
    readPositiveIntegerEnv('XLN_RPC_PROXY_TIMEOUT_MS', DEFAULT_HUB_API_PROXY_TIMEOUT_MS),
  );
  const pathname = endpointWithQuery.split('?', 1)[0] || '';
  if (!LONG_RUNNING_HUB_ENDPOINTS.has(pathname)) return defaultTimeoutMs;
  return readPositiveIntegerEnv(
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
  const match = String(pathname || '').match(/^\/rpc([2-8])?$/);
  if (!match) return null;
  if (!match[1]) return 1;
  const index = Number(match[1]);
  return Number.isInteger(index) && index >= 2 && index <= MAX_RPC_PROXY_INDEX ? index : null;
};

const proxyRpc = async (
  deps: OrchestratorProxyDeps,
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
      const { bodyText, forbiddenMethod } = await readRpcProxyRequest(request);
      if (!operatorAuthorized) {
        if (forbiddenMethod) {
          return new Response(
            JSON.stringify({ error: 'RPC proxy method is not allowed', method: forbiddenMethod }),
            { status: 403, headers: CORS_JSON_HEADERS },
          );
        }
      }
      const timeoutMs = readPositiveIntegerEnv('XLN_RPC_PROXY_TIMEOUT_MS', DEFAULT_RPC_PROXY_TIMEOUT_MS);
      const { response, text } = await fetchRpcProxyText(upstreamRpcUrl, {
        method: 'POST',
        headers: {
          'content-type': request.headers.get('content-type') || 'application/json',
        },
        body: bodyText,
      }, timeoutMs, 'PROXY_UPSTREAM_TIMEOUT');
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
          // This route is public. Fetch errors may embed credential-bearing RPC
          // URLs, so the response exposes only a stable failure class.
          error: publicRpcProxyError(error),
        })),
        { status: error instanceof RpcProxyError ? error.status : 502, headers: CORS_JSON_HEADERS },
      );
    }
};

const proxyHubApi = async (
  deps: OrchestratorProxyDeps,
  request: Request,
  endpoint: ProxyHubEndpoint,
): Promise<Response> => {
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
    let requestedHubId = '';
    try {
      bodyText = await readCappedRequestText(
        request,
        MAX_PUBLIC_HUB_PROXY_BODY_BYTES,
        'HUB_FAUCET_PROXY',
      );
      const bodyJson = bodyText
        ? requireBoundaryRecord(JSON.parse(bodyText), 'HUB_FAUCET_PROXY_BODY_INVALID')
        : {};
      const hubEntityId = bodyJson['hubEntityId'];
      if (hubEntityId !== undefined && typeof hubEntityId !== 'string') {
        throw new RequestBodyError(400, 'HUB_FAUCET_PROXY_HUB_ENTITY_ID_INVALID', 'hubEntityId');
      }
      requestedHubId = typeof hubEntityId === 'string' ? hubEntityId.trim().toLowerCase() : '';
    } catch (error) {
      const bodyError = error instanceof RequestBodyError ? error : null;
      return new Response(safeStringify({
        success: false,
        error: bodyError?.message ?? `Invalid JSON: ${serializeError(error)}`,
        ...(bodyError ? { code: bodyError.code } : {}),
      }), {
        status: bodyError?.status ?? 400,
        headers: proxyHeaders(),
      });
    }

    const child = deps.getHubChildByEntityId(requestedHubId);
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
          ...PUBLIC_HUB_PROXY_MARKER,
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

const proxyEntityHubApi = async (
  deps: OrchestratorProxyDeps,
  request: Request,
  endpoint: ProxyEntityHubEndpoint,
): Promise<Response> => {
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
    let requestedEntityId = '';
    try {
      bodyText = await readCappedRequestText(
        request,
        MAX_WALLET_SNAPSHOT_BODY_BYTES,
        'EXTERNAL_WALLET_SNAPSHOT',
      );
      const parsed = bodyText
        ? requireBoundaryRecord(JSON.parse(bodyText), 'EXTERNAL_WALLET_SNAPSHOT_BODY_INVALID')
        : {};
      if (typeof parsed['entityId'] !== 'string') {
        throw new RequestBodyError(400, 'EXTERNAL_WALLET_SNAPSHOT_ENTITY_ID_INVALID', 'entityId');
      }
      requestedEntityId = parsed['entityId'].trim().toLowerCase();
      if (!/^0x[0-9a-f]{64}$/.test(requestedEntityId)) {
        throw new RequestBodyError(400, 'EXTERNAL_WALLET_SNAPSHOT_ENTITY_ID_INVALID', 'entityId');
      }
    } catch (error) {
      const requestBodyError = error instanceof RequestBodyError ? error : null;
      return new Response(safeStringify({
        success: false,
        error: requestBodyError?.message ?? `Invalid JSON: ${serializeError(error)}`,
        ...(requestBodyError ? { code: requestBodyError.code } : {}),
      }), {
        status: requestBodyError?.status ?? 400,
        headers: proxyHeaders(),
      });
    }

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
          ...PUBLIC_HUB_PROXY_MARKER,
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

const proxyAnyHubGet = async (
  deps: OrchestratorProxyDeps,
  request: Request,
  endpointWithQuery: string,
): Promise<Response> => {
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
          ...PUBLIC_HUB_PROXY_MARKER,
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

const proxyAnyHubRequest = async (
  deps: OrchestratorProxyDeps,
  request: Request,
  endpointWithQuery: string,
): Promise<Response> => {
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
      try {
        bodyText = await readCappedRequestText(
          request,
          MAX_PUBLIC_HUB_PROXY_BODY_BYTES,
          'HUB_API_PROXY',
        );
      } catch (error) {
        const bodyError = error instanceof RequestBodyError ? error : null;
        return new Response(safeStringify(proxyFailureBody({
          code: bodyError?.code ?? 'HUB_API_PROXY_BODY_INVALID',
          error: bodyError?.message ?? 'Hub API proxy request body is invalid',
        })), {
          status: bodyError?.status ?? 400,
          headers: CORS_JSON_HEADERS,
        });
      }
    }

    try {
      const { response, text } = await fetchTextWithTimeout(`http://${deps.host}:${child.apiPort}${endpointWithQuery}`, {
        method: request.method,
        headers: {
          'content-type': request.headers.get('content-type') || 'application/json',
          ...PUBLIC_HUB_PROXY_MARKER,
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

export const createOrchestratorProxyHandlers = (deps: OrchestratorProxyDeps) => {
  return {
    proxyAnyHubGet: (request: Request, endpoint: string) =>
      proxyAnyHubGet(deps, request, endpoint),
    proxyAnyHubRequest: (request: Request, endpoint: string) =>
      proxyAnyHubRequest(deps, request, endpoint),
    proxyEntityHubApi: (request: Request, endpoint: ProxyEntityHubEndpoint) =>
      proxyEntityHubApi(deps, request, endpoint),
    proxyHubApi: (request: Request, endpoint: ProxyHubEndpoint) =>
      proxyHubApi(deps, request, endpoint),
    proxyRpc: (request: Request, upstreamRpcUrl?: string, operatorAuthorized?: boolean) =>
      proxyRpc(deps, request, upstreamRpcUrl, operatorAuthorized),
  };
};
