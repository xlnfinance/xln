/**
 * Standalone watchtower service for blind backup recovery and future
 * last-resort dispute appointments. This stays outside runtime/server.ts so
 * runtime logs and operator surface remain separated from tower storage.
 */

import {
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
import { createWatchtowerStore, type WatchtowerStore } from './store';

export type StandaloneWatchtowerOptions = {
  host?: string;
  port: number;
  towerId?: string;
  dbPath?: string;
  maxStoredBytesPerLookupKey?: number;
  maxBundlesPerLookupKey?: number;
  receiptTtlMs?: number;
  towerPrivateKey?: string;
  sweepIntervalMs?: number;
  allowedRpcUrls?: string[];
};

export type StandaloneWatchtowerServer = {
  server: ReturnType<typeof Bun.serve>;
  store: WatchtowerStore;
  close: () => Promise<void>;
};

type SweepScheduler = {
  enabled: boolean;
  intervalMs: number;
  close: () => void;
};

const startSweepScheduler = (
  store: WatchtowerStore,
  options: {
    towerPrivateKey?: string;
    intervalMs?: number;
    allowedRpcUrls?: string[];
  },
): SweepScheduler => {
  const towerPrivateKey = String(options.towerPrivateKey || '').trim();
  const intervalMs = Math.max(1_000, Math.floor(Number(options.intervalMs ?? 30_000)));
  if (!towerPrivateKey) {
    return { enabled: false, intervalMs, close: () => {} };
  }

  let closed = false;
  let running = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

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
    ...(options.sweepIntervalMs !== undefined ? { intervalMs: options.sweepIntervalMs } : {}),
    ...(options.allowedRpcUrls ? { allowedRpcUrls: options.allowedRpcUrls } : {}),
  });

  const server = Bun.serve({
    hostname: options.host || '0.0.0.0',
    port: options.port,
    async fetch(req) {
      const url = new URL(req.url);
      const pathname = url.pathname;

      if (pathname === '/' || pathname === '/healthz' || pathname === '/api/tower/healthz') {
        const stats = await store.getStats();
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
        return handleWatchtowerSweep(req, store, {
          ...(options.towerPrivateKey ? { towerPrivateKey: options.towerPrivateKey } : {}),
        });
      }
      const actionReceiptMatch = pathname.match(/^\/api\/watchtower\/actions\/([^/]+)$/);
      if (actionReceiptMatch && req.method === 'GET') {
        return handleWatchtowerActions(decodeURIComponent(actionReceiptMatch[1] || ''), store);
      }

      return new Response('Not found', { status: 404 });
    },
  });

  console.log(
    `[WATCHTOWER] "${store.towerId}" listening on ${options.host || '0.0.0.0'}:${server.port} (quota=${store.maxStoredBytesPerLookupKey}B)`,
  );

  return {
    server,
    store,
    close: async () => {
      scheduler.close();
      server.stop(true);
      await store.close();
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
    : Number(process.env['XLN_WATCHTOWER_MAX_BYTES'] || 10 * 1024);
  const maxBundlesPerLookupKey = bundlesArgIdx !== -1 && args[bundlesArgIdx + 1]
    ? Number(args[bundlesArgIdx + 1])
    : Number(process.env['XLN_WATCHTOWER_MAX_BUNDLES'] || 3);
  const towerId = process.env['XLN_WATCHTOWER_ID'] || 'watchtower';
  const sweepIntervalMs = sweepIntervalArgIdx !== -1 && args[sweepIntervalArgIdx + 1]
    ? Number(args[sweepIntervalArgIdx + 1])
    : Number(process.env['XLN_WATCHTOWER_SWEEP_INTERVAL_MS'] || 30_000);
  const allowedRpcUrls = String(process.env['XLN_WATCHTOWER_ALLOWED_RPC_URLS'] || '')
    .split(',')
    .map(value => value.trim())
    .filter(Boolean);

  startStandaloneWatchtowerServer({
    host,
    port,
    ...(dbPath ? { dbPath } : {}),
    towerId,
    maxStoredBytesPerLookupKey,
    maxBundlesPerLookupKey,
    sweepIntervalMs,
    ...(allowedRpcUrls.length > 0 ? { allowedRpcUrls } : {}),
    ...(process.env['XLN_WATCHTOWER_PRIVATE_KEY'] ? { towerPrivateKey: process.env['XLN_WATCHTOWER_PRIVATE_KEY'] } : {}),
  });
}
