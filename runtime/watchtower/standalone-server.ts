/**
 * Standalone watchtower service for blind backup recovery and future
 * last-resort dispute appointments. This stays outside runtime/server/index.ts so
 * runtime logs and operator surface remain separated from tower storage.
 */

import {
  handlePushRegister,
  handlePushUnregister,
  handleRecoveryComplaint,
  handleRecoveryDiscover,
  handleRecoveryState,
  handleTowerAppointment,
  handleTowerReceipt,
  handleTowerRestore,
  handleWatchtowerActions,
  handleWatchtowerSweep,
} from './http';
import { runWatchtowerSweep } from './action';
import { runDisputeWatchSweep } from './dispute-watch';
import { createWatchtowerStore, type WatchtowerStore } from './store';
import { createPushStore, type PushStore } from '../push/store';
import { createPushSender, type PushSenderConfig } from '../push/sender';
import { createStructuredLogger } from '../infra/logger';
import {
  createSweepHealthTracker,
  type SweepHealthSnapshot,
} from './sweep-health';

export type StandaloneWatchtowerOptions = {
  host?: string;
  port: number;
  towerId?: string;
  dbPath?: string;
  maxStoredBytesPerLookupKey?: number;
  maxBundlesPerLookupKey?: number;
  receiptTtlMs?: number;
  towerPrivateKey?: string;
  enableLastResortAgent?: boolean;
  enableOperatorApi?: boolean;
  operatorToken?: string;
  sweepIntervalMs?: number;
  allowedRpcUrls?: string[];
  enablePushWake?: boolean;
  pushDbPath?: string;
  pushSweepIntervalMs?: number;
  pushSender?: PushSenderConfig;
};

export type StandaloneWatchtowerServer = {
  server: ReturnType<typeof Bun.serve>;
  store: WatchtowerStore;
  pushStore: PushStore | null;
  close: () => Promise<void>;
};

type SweepScheduler = {
  enabled: boolean;
  intervalMs: number;
  health: () => SweepHealthSnapshot;
  close: () => void;
};

type StandaloneWatchtowerContext = {
  options: StandaloneWatchtowerOptions;
  store: WatchtowerStore;
  pushStore: PushStore | null;
  pushSender: ReturnType<typeof createPushSender>;
  scheduler: SweepScheduler;
  pushScheduler: SweepScheduler;
  operatorApiEnabled: boolean;
  operatorToken: string;
};

const SWEEP_PRUNE_INTERVAL_MS = 60 * 60 * 1000;
const watchtowerLog = createStructuredLogger('watchtower.standalone');
const WATCHTOWER_CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,PUT,OPTIONS',
  'Access-Control-Allow-Headers': 'authorization,content-type,x-watchtower-operator-token',
} as const;
const WATCHTOWER_JSON_HEADERS = {
  ...WATCHTOWER_CORS_HEADERS,
  'content-type': 'application/json',
  'cache-control': 'no-store, max-age=0',
} as const;

const formatError = (error: unknown): string => error instanceof Error ? error.message : String(error);

const withCors = (response: Response): Response => {
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(WATCHTOWER_CORS_HEADERS)) {
    headers.set(key, value);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
};

const startSweepScheduler = (
  store: WatchtowerStore,
  options: {
    towerPrivateKey?: string;
    enabled?: boolean;
    intervalMs?: number;
    allowedRpcUrls?: string[];
  },
): SweepScheduler => {
  const towerPrivateKey = String(options.towerPrivateKey || '').trim();
  const intervalMs = Math.max(1_000, Math.floor(Number(options.intervalMs ?? 30_000)));
  if (!options.enabled) {
    const health = createSweepHealthTracker();
    return { enabled: false, intervalMs, health: health.snapshot, close: () => {} };
  }
  if (!towerPrivateKey) {
    throw new Error('WATCHTOWER_LAST_RESORT_AGENT_PRIVATE_KEY_REQUIRED');
  }

  let closed = false;
  let running = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let nextPruneAt = Date.now() + SWEEP_PRUNE_INTERVAL_MS;
  const health = createSweepHealthTracker();

  const schedule = (): void => {
    if (closed) return;
    timer = setTimeout(tick, intervalMs);
    timer.unref?.();
  };

  const tick = async (): Promise<void> => {
    if (closed) return;
    if (running) {
      schedule();
      return;
    }
    running = true;
    try {
      const now = Date.now();
      if (now >= nextPruneAt) {
        nextPruneAt = now + SWEEP_PRUNE_INTERVAL_MS;
        await store.pruneExpired();
      }
      const result = await runWatchtowerSweep(store, {
        towerPrivateKey,
        ...(options.allowedRpcUrls ? { allowedRpcUrls: options.allowedRpcUrls } : {}),
      });
      if (result.scanned > 0 || result.submitted > 0 || result.errors > 0) {
        const fields = {
          scanned: result.scanned,
          submitted: result.submitted,
          errors: result.errors,
        };
        if (result.errors > 0) watchtowerLog.warn('sweep.complete', fields);
        else watchtowerLog.info('sweep.complete', fields);
      }
      if (result.errors > 0) health.failure(`WATCHTOWER_SWEEP_APPOINTMENT_ERRORS:${result.errors}`);
      else health.success();
    } catch (error) {
      const message = formatError(error);
      health.failure(message);
      watchtowerLog.error('sweep.failed', { error: message });
    } finally {
      running = false;
      schedule();
    }
  };

  schedule();
  return {
    enabled: true,
    intervalMs,
    health: health.snapshot,
    close: () => {
      closed = true;
      if (timer) clearTimeout(timer);
    },
  };
};

const startPushWatchScheduler = (
  store: PushStore,
  options: {
    enabled?: boolean;
    intervalMs?: number;
    allowedRpcUrls?: string[];
    sender: ReturnType<typeof createPushSender>;
  },
): SweepScheduler => {
  const intervalMs = Math.max(1_000, Math.floor(Number(options.intervalMs ?? 15_000)));
  if (!options.enabled) {
    const health = createSweepHealthTracker();
    return { enabled: false, intervalMs, health: health.snapshot, close: () => {} };
  }

  let closed = false;
  let running = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let nextPruneAt = Date.now() + SWEEP_PRUNE_INTERVAL_MS;
  const health = createSweepHealthTracker();

  const schedule = (): void => {
    if (closed) return;
    timer = setTimeout(tick, intervalMs);
    timer.unref?.();
  };

  const tick = async (): Promise<void> => {
    if (closed) return;
    if (running) {
      schedule();
      return;
    }
    running = true;
    try {
      const now = Date.now();
      if (now >= nextPruneAt) {
        nextPruneAt = now + SWEEP_PRUNE_INTERVAL_MS;
        await store.pruneExpired();
      }
      const result = await runDisputeWatchSweep(store, options.sender, {
        ...(options.allowedRpcUrls ? { allowedRpcUrls: options.allowedRpcUrls } : {}),
      });
      if (result.eventsObserved > 0 || result.notificationsSent > 0 || result.errors > 0) {
        const fields = {
          eventsObserved: result.eventsObserved,
          notificationsSent: result.notificationsSent,
          notificationsSkipped: result.notificationsSkipped,
          errors: result.errors,
        };
        if (result.errors > 0) watchtowerLog.warn('push_sweep.complete', fields);
        else watchtowerLog.info('push_sweep.complete', fields);
      }
      if (result.errors > 0) health.failure(`WATCHTOWER_PUSH_SWEEP_ERRORS:${result.errors}`);
      else health.success();
    } catch (error) {
      const message = formatError(error);
      health.failure(message);
      watchtowerLog.error('push_sweep.failed', { error: message });
    } finally {
      running = false;
      schedule();
    }
  };

  schedule();
  return {
    enabled: true,
    intervalMs,
    health: health.snapshot,
    close: () => {
      closed = true;
      if (timer) clearTimeout(timer);
    },
  };
};

const operatorAllowed = (
  context: StandaloneWatchtowerContext,
  request: Request,
): boolean => {
  if (!context.operatorApiEnabled) return false;
  if (!context.operatorToken) return true;
  return request.headers.get('authorization') === `Bearer ${context.operatorToken}`
    || request.headers.get('x-watchtower-operator-token') === context.operatorToken;
};

const operatorDenied = (context: StandaloneWatchtowerContext): Response =>
  new Response(JSON.stringify({
    ok: false,
    error: context.operatorApiEnabled
      ? 'WATCHTOWER_OPERATOR_AUTH_REQUIRED'
      : 'WATCHTOWER_OPERATOR_API_DISABLED',
  }), {
    status: context.operatorApiEnabled ? 401 : 404,
    headers: WATCHTOWER_JSON_HEADERS,
  });

const pushDisabled = (): Response => new Response(JSON.stringify({
  ok: false,
  error: 'WATCHTOWER_PUSH_WAKE_DISABLED',
}), {
  status: 404,
  headers: WATCHTOWER_JSON_HEADERS,
});

const handleHealth = async (
  context: StandaloneWatchtowerContext,
): Promise<Response> => {
  const { store, pushStore, pushSender, scheduler, pushScheduler } = context;
  const stats = await store.getStats();
  const pushStats = pushStore ? await pushStore.getStats() : null;
  const sweepHealth = scheduler.health();
  const pushHealth = pushScheduler.health();
  const ok = sweepHealth.healthy && pushHealth.healthy;
  return new Response(JSON.stringify({
    ok,
    service: 'xln-watchtower',
    towerId: store.towerId,
    signerAddress: store.signerAddress,
    maxStoredBytesPerLookupKey: store.maxStoredBytesPerLookupKey,
    maxBundlesPerLookupKey: store.maxBundlesPerLookupKey,
    sweep: { enabled: scheduler.enabled, intervalMs: scheduler.intervalMs, ...sweepHealth },
    pushWake: {
      enabled: pushScheduler.enabled,
      intervalMs: pushScheduler.intervalMs,
      sender: pushSender.kind,
      ...pushHealth,
      ...(pushStats ? { stats: pushStats } : {}),
    },
    operatorApi: {
      enabled: context.operatorApiEnabled,
      auth: context.operatorToken ? 'bearer' : 'local-only',
    },
    stats,
  }), { status: ok ? 200 : 503, headers: WATCHTOWER_JSON_HEADERS });
};

const handlePublicTowerRoute = async (
  context: StandaloneWatchtowerContext,
  request: Request,
  pathname: string,
): Promise<Response | null> => {
  const { store } = context;
  if (pathname === '/api/tower/appointment' && request.method === 'PUT') {
    return withCors(await handleTowerAppointment(request, store));
  }
  if (pathname === '/api/tower/restore' && request.method === 'POST') {
    return withCors(await handleTowerRestore(request, store));
  }
  const receiptMatch = pathname.match(/^\/api\/tower\/receipt\/([^/]+)$/);
  if (receiptMatch && request.method === 'GET') {
    return withCors(await handleTowerReceipt(decodeURIComponent(receiptMatch[1] || ''), store));
  }
  if (pathname === '/api/recovery/discover' && request.method === 'POST') {
    return withCors(await handleRecoveryDiscover(request, store));
  }
  if (pathname === '/api/recovery/state' && request.method === 'POST') {
    return withCors(await handleRecoveryState(request, store));
  }
  if (pathname === '/api/recovery/complaint' && request.method === 'POST') {
    return withCors(await handleRecoveryComplaint(request, store));
  }
  return null;
};

const handleOperatorRoute = async (
  context: StandaloneWatchtowerContext,
  request: Request,
  pathname: string,
): Promise<Response | null> => {
  if (pathname === '/api/watchtower/sweep' && request.method === 'POST') {
    if (!operatorAllowed(context, request)) return operatorDenied(context);
    return withCors(await handleWatchtowerSweep(request, context.store, {
      ...(context.options.towerPrivateKey
        ? { towerPrivateKey: context.options.towerPrivateKey }
        : {}),
    }));
  }
  const receiptMatch = pathname.match(/^\/api\/watchtower\/actions\/([^/]+)$/);
  if (!receiptMatch || request.method !== 'GET') return null;
  if (!operatorAllowed(context, request)) return operatorDenied(context);
  return withCors(await handleWatchtowerActions(
    decodeURIComponent(receiptMatch[1] || ''),
    context.store,
  ));
};

const handlePushRoute = async (
  context: StandaloneWatchtowerContext,
  request: Request,
  pathname: string,
): Promise<Response | null> => {
  if (pathname === '/api/push/register' && (request.method === 'PUT' || request.method === 'POST')) {
    if (!context.pushStore) return pushDisabled();
    return withCors(await handlePushRegister(request, context.pushStore));
  }
  if (pathname !== '/api/push/unregister' || request.method !== 'POST') return null;
  if (!context.pushStore) return pushDisabled();
  return withCors(await handlePushUnregister(request, context.pushStore));
};

const handleWatchtowerRequest = async (
  context: StandaloneWatchtowerContext,
  request: Request,
): Promise<Response> => {
  const pathname = new URL(request.url).pathname;
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: WATCHTOWER_CORS_HEADERS });
  }
  if (pathname === '/' || pathname === '/healthz' || pathname === '/api/tower/healthz') {
    return handleHealth(context);
  }
  const publicResponse = await handlePublicTowerRoute(context, request, pathname);
  if (publicResponse) return publicResponse;
  const operatorResponse = await handleOperatorRoute(context, request, pathname);
  if (operatorResponse) return operatorResponse;
  const pushResponse = await handlePushRoute(context, request, pathname);
  return pushResponse ?? new Response('Not found', {
    status: 404,
    headers: WATCHTOWER_CORS_HEADERS,
  });
};

export const startStandaloneWatchtowerServer = (options: StandaloneWatchtowerOptions): StandaloneWatchtowerServer => {
  const bindHost = options.host || '0.0.0.0';
  const operatorApiEnabled = options.enableOperatorApi === true;
  const operatorToken = String(options.operatorToken || '').trim();
  const localOperatorHost = bindHost === '127.0.0.1' || bindHost === 'localhost' || bindHost === '::1';
  if (!localOperatorHost && !options.towerPrivateKey) {
    throw new Error('WATCHTOWER_PRIVATE_KEY_REQUIRED_FOR_PUBLIC_BIND');
  }
  if (operatorApiEnabled && !operatorToken && !localOperatorHost) {
    throw new Error('WATCHTOWER_OPERATOR_TOKEN_REQUIRED_FOR_PUBLIC_BIND');
  }
  const store = createWatchtowerStore({
    ...(options.towerId ? { towerId: options.towerId } : {}),
    ...(options.dbPath ? { dbPath: options.dbPath } : {}),
    ...(options.maxStoredBytesPerLookupKey !== undefined ? { maxStoredBytesPerLookupKey: options.maxStoredBytesPerLookupKey } : {}),
    ...(options.maxBundlesPerLookupKey !== undefined ? { maxBundlesPerLookupKey: options.maxBundlesPerLookupKey } : {}),
    ...(options.receiptTtlMs !== undefined ? { receiptTtlMs: options.receiptTtlMs } : {}),
    ...(options.towerPrivateKey ? { towerPrivateKey: options.towerPrivateKey } : {}),
  });
  const scheduler = startSweepScheduler(store, {
    ...(options.towerPrivateKey ? { towerPrivateKey: options.towerPrivateKey } : {}),
    enabled: options.enableLastResortAgent === true,
    ...(options.sweepIntervalMs !== undefined ? { intervalMs: options.sweepIntervalMs } : {}),
    ...(options.allowedRpcUrls ? { allowedRpcUrls: options.allowedRpcUrls } : {}),
  });
  const pushEnabled = options.enablePushWake === true;
  const pushStore = pushEnabled
    ? createPushStore({ ...(options.pushDbPath ? { dbPath: options.pushDbPath } : {}) })
    : null;
  const pushSender = createPushSender(options.pushSender);
  const pushScheduler = pushStore
    ? startPushWatchScheduler(pushStore, {
        enabled: true,
        sender: pushSender,
        ...(options.pushSweepIntervalMs !== undefined ? { intervalMs: options.pushSweepIntervalMs } : {}),
        ...(options.allowedRpcUrls ? { allowedRpcUrls: options.allowedRpcUrls } : {}),
      })
    : (() => {
        const health = createSweepHealthTracker();
        return { enabled: false, intervalMs: 0, health: health.snapshot, close: () => {} };
      })();
  const context: StandaloneWatchtowerContext = {
    options,
    store,
    pushStore,
    pushSender,
    scheduler,
    pushScheduler,
    operatorApiEnabled,
    operatorToken,
  };

  const server = Bun.serve({
    hostname: bindHost,
    port: options.port,
    fetch: request => handleWatchtowerRequest(context, request),
  });

  watchtowerLog.info('service.listen', {
    towerId: store.towerId,
    host: bindHost,
    port: server.port,
    maxStoredBytesPerLookupKey: store.maxStoredBytesPerLookupKey,
  });

  return {
    server,
    store,
    pushStore,
    close: async () => {
      scheduler.close();
      pushScheduler.close();
      server.stop(true);
      await store.close();
      if (pushStore) await pushStore.close();
    },
  };
};

if (import.meta.main) {
  const args = process.argv;
  const portArgIdx = args.indexOf('--port');
  const hostArgIdx = args.indexOf('--host');
  const dbArgIdx = args.indexOf('--db');
  const quotaArgIdx = args.indexOf('--quota-bytes');
  const bundlesArgIdx = args.indexOf('--max-bundles');
  const sweepIntervalArgIdx = args.indexOf('--sweep-interval-ms');

  const port = portArgIdx !== -1 && args[portArgIdx + 1]
    ? Number(args[portArgIdx + 1])
    : Number(process.env['XLN_WATCHTOWER_PORT'] || 9100);
  const host = hostArgIdx !== -1 && args[hostArgIdx + 1]
    ? String(args[hostArgIdx + 1])
    : process.env['XLN_WATCHTOWER_HOST'] || '0.0.0.0';
  const dbPath = dbArgIdx !== -1 && args[dbArgIdx + 1]
    ? String(args[dbArgIdx + 1])
    : process.env['XLN_WATCHTOWER_DB_PATH'];
  const maxStoredBytesPerLookupKey = quotaArgIdx !== -1 && args[quotaArgIdx + 1]
    ? Number(args[quotaArgIdx + 1])
    : Number(process.env['XLN_WATCHTOWER_MAX_BYTES'] || 4 * 1024 * 1024);
  const maxBundlesPerLookupKey = bundlesArgIdx !== -1 && args[bundlesArgIdx + 1]
    ? Number(args[bundlesArgIdx + 1])
    : Number(process.env['XLN_WATCHTOWER_MAX_BUNDLES'] || 3);
  const towerId = process.env['XLN_WATCHTOWER_ID'] || 'watchtower';
  const sweepIntervalMs = sweepIntervalArgIdx !== -1 && args[sweepIntervalArgIdx + 1]
    ? Number(args[sweepIntervalArgIdx + 1])
    : Number(process.env['XLN_WATCHTOWER_SWEEP_INTERVAL_MS'] || 30_000);
  const enableLastResortAgent = args.includes('--enable-last-resort-agent')
    || process.env['XLN_WATCHTOWER_ENABLE_LAST_RESORT'] === '1';
  const enableOperatorApi = args.includes('--enable-operator-api')
    || process.env['XLN_WATCHTOWER_OPERATOR_API'] === '1';
  const operatorToken = process.env['XLN_WATCHTOWER_OPERATOR_TOKEN'];
  const allowedRpcUrls = String(process.env['XLN_WATCHTOWER_ALLOWED_RPC_URLS'] || '')
    .split(',')
    .map(value => value.trim())
    .filter(Boolean);

  const enablePushWake = args.includes('--enable-push-wake')
    || process.env['XLN_PUSH_ENABLE'] === '1';
  const pushDbPath = process.env['XLN_PUSH_DB_PATH'];
  const pushSweepIntervalMs = Number(process.env['XLN_PUSH_SWEEP_INTERVAL_MS'] || 15_000);
  const pushWebhookEndpoint = String(process.env['XLN_PUSH_WEBHOOK_URL'] || '').trim();
  const pushWebhookAuthToken = String(process.env['XLN_PUSH_WEBHOOK_TOKEN'] || '').trim();
  const pushSender: PushSenderConfig = pushWebhookEndpoint
    ? {
        kind: 'webhook',
        webhookEndpoint: pushWebhookEndpoint,
        ...(pushWebhookAuthToken ? { webhookAuthToken: pushWebhookAuthToken } : {}),
      }
    : { kind: 'console' };

  startStandaloneWatchtowerServer({
    host,
    port,
    ...(dbPath ? { dbPath } : {}),
    towerId,
    maxStoredBytesPerLookupKey,
    maxBundlesPerLookupKey,
    enableLastResortAgent,
    enableOperatorApi,
    sweepIntervalMs,
    ...(operatorToken ? { operatorToken } : {}),
    ...(allowedRpcUrls.length > 0 ? { allowedRpcUrls } : {}),
    ...(process.env['XLN_WATCHTOWER_PRIVATE_KEY'] ? { towerPrivateKey: process.env['XLN_WATCHTOWER_PRIVATE_KEY'] } : {}),
    enablePushWake,
    ...(pushDbPath ? { pushDbPath } : {}),
    ...(Number.isFinite(pushSweepIntervalMs) && pushSweepIntervalMs > 0 ? { pushSweepIntervalMs } : {}),
    pushSender,
  });
}
