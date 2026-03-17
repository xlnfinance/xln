#!/usr/bin/env bun

import { watch } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawnBunChild, startCustodySupport, stopManagedChild, waitForHttpReady } from '../orchestrator/custody-bootstrap';

const API_BASE_URL = process.env.DEV_API_BASE_URL || 'http://127.0.0.1:8082';
const ANVIL_RPC = process.env.DEV_ANVIL_RPC || 'http://127.0.0.1:8545';
const RELAY_URL = process.env.DEV_RELAY_URL || 'ws://127.0.0.1:8082/relay';
const WALLET_PORT = Number(process.env.VITE_DEV_PORT || process.env.DEV_WALLET_PORT || '8080');
const WALLET_BASE_URL = process.env.DEV_WALLET_BASE_URL || `https://localhost:${WALLET_PORT}`;
const WALLET_URL = process.env.DEV_WALLET_URL || new URL('/app', WALLET_BASE_URL).toString();
const CUSTODY_HTTPS = !/^(0|false|no)$/i.test(process.env.CUSTODY_HTTPS ?? '1');
const DAEMON_PORT = Number(process.env.DEV_CUSTODY_DAEMON_PORT || '8088');
const CUSTODY_PORT = Number(process.env.DEV_CUSTODY_PORT || '8087');
const CUSTODY_BASE_URL = `${CUSTODY_HTTPS ? 'https' : 'http'}://localhost:${CUSTODY_PORT}`;
const DB_ROOT = resolve(process.env.DEV_CUSTODY_DB_ROOT || './db/dev/custody');
const SEED = process.env.DEV_CUSTODY_SEED || 'xln-dev-custody-seed';
const SIGNER_LABEL = process.env.DEV_CUSTODY_SIGNER_LABEL || 'custody-dev-1';
const PROFILE_NAME = process.env.DEV_CUSTODY_NAME || 'Custody';
const VERBOSE = /^(1|true)$/i.test(process.env.DEV_VERBOSE ?? '');

let shuttingDown = false;
let restartingCustody = false;

const mirrorChildLogs = (prefix: string, child: { proc: { stdout: NodeJS.ReadableStream; stderr: NodeJS.ReadableStream } }): void => {
  child.proc.stdout.on('data', (chunk: Buffer | string) => {
    process.stdout.write(`[${prefix}] ${chunk.toString()}`);
  });
  child.proc.stderr.on('data', (chunk: Buffer | string) => {
    process.stderr.write(`[${prefix}:err] ${chunk.toString()}`);
  });
};

const main = async (): Promise<void> => {
  await rm(DB_ROOT, { recursive: true, force: true });
  await mkdir(DB_ROOT, { recursive: true });

  console.log(`[dev-custody] waiting for shared dev API ${API_BASE_URL}`);
  await waitForHttpReady(`${API_BASE_URL}/api/health`, null, 120_000);

  const support = await startCustodySupport({
    apiBaseUrl: API_BASE_URL,
    daemonPort: DAEMON_PORT,
    custodyPort: CUSTODY_PORT,
    relayUrl: RELAY_URL,
    rpcUrl: ANVIL_RPC,
    walletUrl: WALLET_URL,
    dbRoot: DB_ROOT,
    seed: SEED,
    signerLabel: SIGNER_LABEL,
    profileName: PROFILE_NAME,
  });

  if (VERBOSE) {
    mirrorChildLogs('custody-daemon', support.daemonChild);
    mirrorChildLogs('custody', support.custodyChild);
  }

  const createCustodyChild = () => {
    return spawnBunChild(
      'custody-service',
      ['custody/server.ts'],
      {
        CUSTODY_HOST: 'localhost',
        CUSTODY_PORT: String(CUSTODY_PORT),
        CUSTODY_HTTPS: '1',
        CUSTODY_WALLET_URL: WALLET_URL,
        CUSTODY_DAEMON_WS: `ws://127.0.0.1:${DAEMON_PORT}/rpc`,
        CUSTODY_ENTITY_ID: support.identity.entityId,
        CUSTODY_SIGNER_ID: support.identity.signerId,
        CUSTODY_PROFILE_NAME: PROFILE_NAME,
        CUSTODY_JURISDICTION_ID: 'arrakis',
        CUSTODY_DB_PATH: `${DB_ROOT}/custody.sqlite`,
      },
    );
  };

  const restartCustody = async (reason: string): Promise<void> => {
    if (shuttingDown || restartingCustody) return;
    restartingCustody = true;
    console.log(`[dev-custody] restarting custody server (${reason})`);
    await stopManagedChild(support.custodyChild);
    support.custodyChild = createCustodyChild();
    if (VERBOSE) {
      mirrorChildLogs('custody', support.custodyChild);
    }
    try {
      await waitForHttpReady(`${CUSTODY_BASE_URL}/api/me`, support.custodyChild, 30_000);
    } finally {
      restartingCustody = false;
    }
  };

  let restartTimer: ReturnType<typeof setTimeout> | null = null;
  const queueRestart = (reason: string): void => {
    if (restartTimer) clearTimeout(restartTimer);
    restartTimer = setTimeout(() => {
      restartTimer = null;
      void restartCustody(reason).catch((error) => {
        console.error(`[dev-custody] failed to restart custody server: ${(error as Error).stack || (error as Error).message}`);
      });
    }, 120);
  };

  const serverWatcher = watch(resolve('custody', 'server.ts'), () => queueRestart('server.ts changed'));

  console.log('[dev-custody] ready');
  console.log(`[dev-custody] wallet ${WALLET_URL}`);
  console.log(`[dev-custody] custody dashboard ${CUSTODY_BASE_URL}`);
  console.log(`[dev-custody] custody daemon http://localhost:${DAEMON_PORT}`);
  console.log(`[dev-custody] custody entity ${support.identity.entityId}`);
  console.log('[dev-custody] custody static files are read from disk; refresh the browser for app.js/styles.css changes');
  console.log(`[dev-custody] verbose ${VERBOSE ? 'on' : 'off'} (set DEV_VERBOSE=1 for child logs)`);

  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    restartingCustody = false;
    serverWatcher.close();
    if (restartTimer) clearTimeout(restartTimer);
    console.log(`[dev-custody] shutting down on ${signal}`);
    await stopManagedChild(support.custodyChild);
    await stopManagedChild(support.daemonChild);
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  support.daemonChild.proc.on('close', (code) => {
    if (!shuttingDown) {
      console.error(`[dev-custody] daemon exited with code=${String(code)}`);
      void shutdown('daemon-exit');
    }
  });
  support.custodyChild.proc.on('close', (code) => {
    if (!shuttingDown && !restartingCustody) {
      console.error(`[dev-custody] custody server exited with code=${String(code)}`);
      void shutdown('custody-exit');
    }
  });

  await new Promise<void>(() => {});
};

main().catch((error) => {
  console.error(`[dev-custody] ${(error as Error).stack || (error as Error).message}`);
  process.exit(1);
});
