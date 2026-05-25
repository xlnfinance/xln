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
};

export type StandaloneWatchtowerServer = {
  server: ReturnType<typeof Bun.serve>;
  store: WatchtowerStore;
  close: () => Promise<void>;
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

  const server = Bun.serve({
    hostname: options.host || '0.0.0.0',
    port: options.port,
    async fetch(req) {
      const url = new URL(req.url);
      const pathname = url.pathname;

      if (pathname === '/' || pathname === '/healthz') {
        return new Response(JSON.stringify({
          ok: true,
          service: 'xln-watchtower',
          towerId: store.towerId,
          signerAddress: store.signerAddress,
          maxStoredBytesPerLookupKey: store.maxStoredBytesPerLookupKey,
          maxBundlesPerLookupKey: store.maxBundlesPerLookupKey,
        }), {
          headers: { 'content-type': 'application/json' },
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
        return handleWatchtowerSweep(req, store);
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

  startStandaloneWatchtowerServer({
    host,
    port,
    ...(dbPath ? { dbPath } : {}),
    towerId,
    maxStoredBytesPerLookupKey,
    maxBundlesPerLookupKey,
    ...(process.env['XLN_WATCHTOWER_PRIVATE_KEY'] ? { towerPrivateKey: process.env['XLN_WATCHTOWER_PRIVATE_KEY'] } : {}),
  });
}
