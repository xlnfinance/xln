import { createStructuredLogger } from '../../infra/logger';
import {
  AssistantInputError,
  parseAssistantChatRequest,
  readAssistantCatalogPayload,
  sanitizeAssistantCatalog,
} from './assistant-proxy-input';
import {
  isSameOriginAssistantRequest,
  normalizeAssistantClientId,
  readAssistantProxyConfig,
  type AssistantProxyConfig,
} from './assistant-proxy-policy';

export {
  resolveAssistantDirectClientIp,
  resolveAssistantRateClientId,
} from './assistant-proxy-policy';
export type { AssistantProxyConfig } from './assistant-proxy-policy';

type AssistantLogger = Pick<ReturnType<typeof createStructuredLogger>, 'info' | 'warn' | 'error'>;
type Fetch = typeof fetch;

export type AssistantProxyOptions = Readonly<{
  config: AssistantProxyConfig;
  fetch?: Fetch;
  now?: () => number;
  logger?: AssistantLogger;
}>;

const DEFAULT_LOGGER = createStructuredLogger('assistant.proxy');
const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' };

const jsonResponse = (status: number, code: string, message: string, headers: HeadersInit = {}): Response =>
  Response.json({ code, message }, { status, headers: { ...JSON_HEADERS, ...headers } });

type RateWindow = { startedAt: number; count: number };
type AssistantProxyState = {
  clients: Map<string, RateWindow>;
  globalWindow: RateWindow;
  activeStreams: number;
};
type AssistantProxyContext = {
  config: AssistantProxyConfig;
  fetch: Fetch;
  now: () => number;
  log: AssistantLogger;
  allowedModels: Set<string>;
  state: AssistantProxyState;
};

const consumeWindow = (window: RateWindow, now: number, duration: number, limit: number): boolean => {
  if (now - window.startedAt >= duration) {
    window.startedAt = now;
    window.count = 0;
  }
  if (window.count >= limit) return false;
  window.count += 1;
  return true;
};

const checkRate = (context: AssistantProxyContext, clientId: string): Response | null => {
  const { config, state, log } = context;
  const timestamp = context.now();
  if (timestamp - state.globalWindow.startedAt >= config.rateWindowMs) {
    state.globalWindow = { startedAt: timestamp, count: 0 };
    state.clients.clear();
  }
  if (state.globalWindow.count >= config.globalRateLimit) {
    log.warn('rate_limited', { code: 'AI_GLOBAL_RATE_LIMITED', clientId });
    return jsonResponse(429, 'AI_GLOBAL_RATE_LIMITED', 'Assistant request rate limit exceeded.', {
      'retry-after': String(Math.max(1, Math.ceil(config.rateWindowMs / 1000))),
    });
  }
  const client = state.clients.get(clientId) ?? { startedAt: timestamp, count: 0 };
  state.clients.set(clientId, client);
  if (!consumeWindow(client, timestamp, config.rateWindowMs, config.perClientRateLimit)) {
    log.warn('rate_limited', { code: 'AI_CLIENT_RATE_LIMITED', clientId });
    return jsonResponse(429, 'AI_CLIENT_RATE_LIMITED', 'Assistant request rate limit exceeded.', {
      'retry-after': String(Math.max(1, Math.ceil(config.rateWindowMs / 1000))),
    });
  }
  state.globalWindow.count += 1;
  return null;
};

const handleCatalog = async (
  context: AssistantProxyContext,
  request: Request,
  clientId: string,
): Promise<Response> => {
  const { config, log } = context;
  if (request.method !== 'GET') return jsonResponse(405, 'AI_METHOD_NOT_ALLOWED', 'Use GET for model discovery.');
  const limited = checkRate(context, clientId);
  if (limited) return limited;
  const controller = new AbortController();
  const abort = () => controller.abort(request.signal.reason);
  request.signal.addEventListener('abort', abort, { once: true });
  if (request.signal.aborted) abort();
  const timeout = setTimeout(() => controller.abort('AI_CATALOG_TIMEOUT'), config.catalogTimeoutMs);
  try {
    const upstream = await context.fetch(`${config.upstreamUrl}/api/models`, {
      headers: { accept: 'application/json' },
      signal: controller.signal,
    });
    if (!upstream.ok) throw new Error(`AI_CATALOG_STATUS_${upstream.status}`);
    const models = sanitizeAssistantCatalog(
      await readAssistantCatalogPayload(upstream),
      config.allowedModels,
    );
    return Response.json({
      provider: 'local',
      available: models.length > 0,
      defaultModel: models[0]?.id ?? '',
      models,
      ...(models.length === 0 ? { message: 'No allowed local AI model is available.' } : {}),
    }, { headers: JSON_HEADERS });
  } catch (error) {
    log.warn('catalog_offline', {
      clientId,
      reason: error instanceof Error ? error.message : String(error),
    });
    return Response.json({
      provider: 'local',
      available: false,
      defaultModel: '',
      models: [],
      message: 'Local AI is offline. Start the xln AI service and retry.',
    }, { headers: JSON_HEADERS });
  } finally {
    clearTimeout(timeout);
    request.signal.removeEventListener('abort', abort);
  }
};

const handleInvalidChatInput = (
  context: AssistantProxyContext,
  clientId: string,
  error: unknown,
): Response => {
  const inputError = error instanceof AssistantInputError ? error : null;
  const code = inputError?.code ?? 'AI_REQUEST_INVALID';
  context.log.warn('request_rejected', { code, clientId });
  return jsonResponse(
    code === 'AI_MODEL_NOT_ALLOWED' ? 403 : 400,
    code,
    inputError?.message ?? 'Invalid assistant request.',
  );
};

const handleChat = async (
  context: AssistantProxyContext,
  request: Request,
  clientId: string,
): Promise<Response> => {
  const { config, log, state } = context;
  if (request.method !== 'POST') return jsonResponse(405, 'AI_METHOD_NOT_ALLOWED', 'Use POST for assistant chat.');
  const limited = checkRate(context, clientId);
  if (limited) return limited;
  let body: Awaited<ReturnType<typeof parseAssistantChatRequest>>;
  try {
    body = await parseAssistantChatRequest(request, context.allowedModels);
  } catch (error) {
    return handleInvalidChatInput(context, clientId, error);
  }
  if (state.activeStreams >= config.maxConcurrentStreams) {
    log.warn('concurrency_limited', { clientId, activeStreams: state.activeStreams });
    return jsonResponse(429, 'AI_CONCURRENCY_LIMITED', 'Assistant is busy. Retry shortly.', { 'retry-after': '1' });
  }

  state.activeStreams += 1;
  const upstreamController = new AbortController();
  let abortSource: 'client' | 'timeout' | 'downstream' | null = null;
  let cancelUpstreamBody: ((reason: unknown) => void) | null = null;
  let finishStream: (outcome: string) => void = () => undefined;
  const abortUpstream = (source: 'client' | 'timeout', reason: unknown): void => {
    abortSource = source;
    upstreamController.abort(reason);
    cancelUpstreamBody?.(reason);
    finishStream(source);
  };
  const abortFromClient = () => abortUpstream('client', request.signal.reason);
  request.signal.addEventListener('abort', abortFromClient, { once: true });
  const timeout = setTimeout(
    () => abortUpstream('timeout', 'AI_STREAM_TIMEOUT'),
    config.streamTimeoutMs,
  );
  let finished = false;
  const finish = (outcome: string): void => {
    if (finished) return;
    finished = true;
    clearTimeout(timeout);
    request.signal.removeEventListener('abort', abortFromClient);
    state.activeStreams -= 1;
    log.info('stream_finished', { clientId, model: body.model, outcome, activeStreams: state.activeStreams });
  };
  finishStream = finish;
  if (request.signal.aborted) abortFromClient();

  let upstream: Response;
  try {
    upstream = await context.fetch(`${config.upstreamUrl}/api/chat`, {
      method: 'POST',
      headers: { accept: 'text/event-stream', 'content-type': 'application/json' },
      body: JSON.stringify({ ...body, stream: true }),
      signal: upstreamController.signal,
    });
  } catch (error) {
    finish(abortSource ?? 'upstream_unavailable');
    log.error('upstream_failed', {
      clientId,
      model: body.model,
      reason: error instanceof Error ? error.message : String(error),
      abortSource,
    });
    if (abortSource === 'client') return jsonResponse(499, 'AI_CLIENT_ABORTED', 'Assistant request was cancelled.');
    if (abortSource === 'timeout') return jsonResponse(504, 'AI_UPSTREAM_TIMEOUT', 'Assistant response timed out.');
    return jsonResponse(503, 'AI_OFFLINE', 'Local AI is offline. Start the xln AI service and retry.');
  }
  const contentType = upstream.headers.get('content-type')?.toLowerCase() || '';
  if (!upstream.ok || !upstream.body || !contentType.includes('text/event-stream')) {
    try {
      await upstream.body?.cancel('AI_UPSTREAM_PROTOCOL_INVALID');
    } catch (error) {
      log.warn('upstream_cancel_failed', { clientId, reason: String(error) });
    }
    finish('invalid_upstream');
    log.error('upstream_protocol_invalid', { clientId, model: body.model, status: upstream.status, contentType });
    return jsonResponse(upstream.ok ? 502 : 503, 'AI_UPSTREAM_INVALID', 'Assistant upstream is unavailable.');
  }

  const reader = upstream.body.getReader();
  cancelUpstreamBody = reason => {
    void reader.cancel(reason).catch(error => {
      log.warn('upstream_cancel_failed', { clientId, reason: String(error) });
    });
  };
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const chunk = await reader.read();
        if (chunk.done) {
          if (abortSource === 'timeout') controller.error(new Error('AI_STREAM_TIMEOUT'));
          else controller.close();
          finish(abortSource ?? 'complete');
          return;
        }
        controller.enqueue(chunk.value);
      } catch (error) {
        if (!abortSource) {
          log.error('stream_failed', {
            clientId,
            model: body.model,
            reason: error instanceof Error ? error.message : String(error),
          });
        }
        try {
          controller.error(error);
        } catch (controllerError) {
          log.warn('stream_error_delivery_failed', { clientId, reason: String(controllerError) });
        }
        finish(abortSource ?? 'stream_error');
      }
    },
    async cancel(reason) {
      abortSource = 'downstream';
      upstreamController.abort(reason);
      try {
        await reader.cancel(reason);
      } catch (error) {
        log.warn('upstream_cancel_failed', { clientId, reason: String(error) });
      } finally {
        finish('downstream_cancel');
      }
    },
  });
  log.info('stream_started', { clientId, model: body.model, activeStreams: state.activeStreams });
  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-store',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    },
  });
};

const handleAssistantRequest = async (
  context: AssistantProxyContext,
  request: Request,
  pathname: string,
  rawClientId: string,
): Promise<Response | null> => {
  if (pathname !== '/api/assistant/models' && pathname !== '/api/assistant/chat') return null;
  const clientId = normalizeAssistantClientId(rawClientId);
  if (!isSameOriginAssistantRequest(request)) {
    context.log.warn('cross_origin_rejected', { clientId, pathname });
    return jsonResponse(403, 'AI_ORIGIN_NOT_ALLOWED', 'Assistant requests must use the xln origin.');
  }
  return pathname === '/api/assistant/models'
    ? handleCatalog(context, request, clientId)
    : handleChat(context, request, clientId);
};

export const createAssistantProxy = (options: AssistantProxyOptions) => {
  const context: AssistantProxyContext = {
    config: options.config,
    fetch: options.fetch ?? fetch,
    now: options.now ?? Date.now,
    log: options.logger ?? DEFAULT_LOGGER,
    allowedModels: new Set(options.config.allowedModels),
    state: {
      clients: new Map(),
      globalWindow: { startedAt: (options.now ?? Date.now)(), count: 0 },
      activeStreams: 0,
    },
  };
  return {
    handle: (request: Request, pathname: string, clientId: string) =>
      handleAssistantRequest(context, request, pathname, clientId),
    snapshot: () => ({
      activeStreams: context.state.activeStreams,
      clientWindows: context.state.clients.size,
      globalCount: context.state.globalWindow.count,
    }),
  };
};

export const createAssistantProxyFromEnv = (logger?: AssistantLogger) =>
  createAssistantProxy({ config: readAssistantProxyConfig(), ...(logger ? { logger } : {}) });
