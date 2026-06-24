/**
 * Standalone watchtower service for blind backup recovery and future
 * last-resort dispute appointments. This stays outside runtime/server.ts so
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
  close: () => void;
};

const SWEEP_PRUNE_INTERVAL_MS = 60 * 60 * 1000;

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
    return { enabled: false, intervalMs, close: () => {} };
  }
  if (!towerPrivateKey) {
    throw new Error('WATCHTOWER_LAST_RESORT_AGENT_PRIVATE_KEY_REQUIRED');
  }

  let closed = false;
  let running = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let nextPruneAt = Date.now() + SWEEP_PRUNE_INTERVAL_MS;

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
        console.log(`[WATCHTOWER] sweep ${JSON.stringify(result)}`);
      }
    } catch (error) {
      console.error(`[WATCHTOWER] sweep failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      running = false;
      schedule();
    }
  };

  schedule();
  return {
    enabled: true,
    intervalMs,
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
    return { enabled: false, intervalMs, close: () => {} };
  }

  let closed = false;
  let running = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let nextPruneAt = Date.now() + SWEEP_PRUNE_INTERVAL_MS;

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
        console.log(`[PUSH-WATCH] sweep ${JSON.stringify(result)}`);
      }
    } catch (error) {
      console.error(`[PUSH-WATCH] sweep failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      running = false;
      schedule();
    }
  };

  schedule();
  return {
    enabled: true,
    intervalMs,
    close: () => {
      closed = true;
      if (timer) clearTimeout(timer);
    },
  };
};

export const startStandaloneWatchtowerServer = (options: StandaloneWatchtowerOptions): StandaloneWatchtowerServer => {
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
    : { enabled: false, intervalMs: 0, close: () => {} };
  const operatorApiEnabled = options.enableOperatorApi === true;
  const operatorToken = String(options.operatorToken || '').trim();
  const bindHost = options.host || '0.0.0.0';
  const localOperatorHost = bindHost === '127.0.0.1' || bindHost === 'localhost' || bindHost === '::1';
  if (operatorApiEnabled && !operatorToken && !localOperatorHost) {
    throw new Error('WATCHTOWER_OPERATOR_TOKEN_REQUIRED_FOR_PUBLIC_BIND');
  }

  const operatorAllowed = (req: Request): boolean => {
    if (!operatorApiEnabled) return false;
    if (!operatorToken) return true;
    return req.headers.get('authorization') === `Bearer ${operatorToken}`
      || req.headers.get('x-watchtower-operator-token') === operatorToken;
  };

  const operatorDenied = (): Response => new Response(JSON.stringify({
    ok: false,
    error: operatorApiEnabled ? 'WATCHTOWER_OPERATOR_AUTH_REQUIRED' : 'WATCHTOWER_OPERATOR_API_DISABLED',
  }), {
    status: operatorApiEnabled ? 401 : 404,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store, max-age=0' },
  });

  const pushDisabled = (): Response => new Response(JSON.stringify({
    ok: false,
    error: 'WATCHTOWER_PUSH_WAKE_DISABLED',
  }), {
    status: 404,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store, max-age=0' },
  });

  const server = Bun.serve({
    hostname: bindHost,
    port: options.port,
    async fetch(req) {
      const url = new URL(req.url);
      const pathname = url.pathname;

      if (pathname === '/' || pathname === '/healthz' || pathname === '/api/tower/healthz') {
        const stats = await store.getStats();
        const pushStats = pushStore ? await pushStore.getStats() : null;
        return new Response(JSON.stringify({
          ok: true,
          service: 'xln-watchtower',
          towerId: store.towerId,
          signerAddress: store.signerAddress,
          maxStoredBytesPerLookupKey: store.maxStoredBytesPerLookupKey,
          maxBundlesPerLookupKey: store.maxBundlesPerLookupKey,
          sweep: {
            enabled: scheduler.enabled,
            intervalMs: scheduler.intervalMs,
          },
          pushWake: {
            enabled: pushScheduler.enabled,
            intervalMs: pushScheduler.intervalMs,
            sender: pushSender.kind,
            ...(pushStats ? { stats: pushStats } : {}),
          },
          operatorApi: {
            enabled: operatorApiEnabled,
            auth: operatorToken ? 'bearer' : 'local-only',
          },
          stats,
        }), {
          headers: { 'content-type': 'application/json', 'cache-control': 'no-store, max-age=0' },
        });
      }

      if (pathname === '/api/tower/appointment' && req.method === 'PUT') {
        return handleTowerAppointment(req, store);
      }
      if (pathname === '/api/tower/restore' && req.method === 'POST') {
        return handleTowerRestore(req, store);
      }
      const towerReceiptMatch = pathname.match(/^\/api\/tower\/receipt\/([^/]+)$/);
      if (towerReceiptMatch && req.method === 'GET') {
        return handleTowerReceipt(decodeURIComponent(towerReceiptMatch[1] || ''), store);
      }
      if (pathname === '/api/recovery/discover' && req.method === 'POST') {
        return handleRecoveryDiscover(req, store);
      }
      if (pathname === '/api/recovery/state' && req.method === 'POST') {
        return handleRecoveryState(req, store);
      }
      if (pathname === '/api/recovery/complaint' && req.method === 'POST') {
        return handleRecoveryComplaint(req, store);
      }
      if (pathname === '/api/watchtower/sweep' && req.method === 'POST') {
        if (!operatorAllowed(req)) return operatorDenied();
        return handleWatchtowerSweep(req, store, {
          ...(options.towerPrivateKey ? { towerPrivateKey: options.towerPrivateKey } : {}),
        });
      }
      const actionReceiptMatch = pathname.match(/^\/api\/watchtower\/actions\/([^/]+)$/);
      if (actionReceiptMatch && req.method === 'GET') {
        if (!operatorAllowed(req)) return operatorDenied();
        return handleWatchtowerActions(decodeURIComponent(actionReceiptMatch[1] || ''), store);
      }

      if (pathname === '/api/push/register' && (req.method === 'PUT' || req.method === 'POST')) {
        if (!pushStore) return pushDisabled();
        return handlePushRegister(req, pushStore);
      }
      if (pathname === '/api/push/unregister' && req.method === 'POST') {
        if (!pushStore) return pushDisabled();
        return handlePushUnregister(req, pushStore);
      }

      return new Response('Not found', { status: 404 });
    },
  });

  console.log(
    `[WATCHTOWER] "${store.towerId}" listening on ${bindHost}:${server.port} (quota=${store.maxStoredBytesPerLookupKey}B)`,
  );

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
