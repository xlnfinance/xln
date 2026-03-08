#!/usr/bin/env bun

import { mkdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { startCustodySupport, stopManagedChild, waitForHttpReady } from '../orchestrator/custody-bootstrap';

const API_BASE_URL = process.env.DEV_API_BASE_URL || 'http://127.0.0.1:8082';
const ANVIL_RPC = process.env.DEV_ANVIL_RPC || 'http://127.0.0.1:8545';
const RELAY_URL = process.env.DEV_RELAY_URL || 'ws://127.0.0.1:8082/relay';
const WALLET_PORT = Number(process.env.VITE_DEV_PORT || process.env.DEV_WALLET_PORT || '8080');
const WALLET_BASE_URL = process.env.DEV_WALLET_BASE_URL || `https://localhost:${WALLET_PORT}`;
const WALLET_URL = process.env.DEV_WALLET_URL || new URL('/app', WALLET_BASE_URL).toString();
const DAEMON_PORT = Number(process.env.DEV_CUSTODY_DAEMON_PORT || '8088');
const CUSTODY_PORT = Number(process.env.DEV_CUSTODY_PORT || '8087');
const DB_ROOT = resolve(process.env.DEV_CUSTODY_DB_ROOT || './db-tmp/dev-custody');
const SEED = process.env.DEV_CUSTODY_SEED || 'xln-dev-custody-seed';
const SIGNER_LABEL = process.env.DEV_CUSTODY_SIGNER_LABEL || 'custody-dev-1';
const PROFILE_NAME = process.env.DEV_CUSTODY_NAME || 'Custody';
const VERBOSE = /^(1|true)$/i.test(process.env.DEV_VERBOSE ?? '');

let shuttingDown = false;

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

  console.log('[dev-custody] ready');
  console.log(`[dev-custody] wallet ${WALLET_URL}`);
  console.log(`[dev-custody] custody dashboard http://127.0.0.1:${CUSTODY_PORT}`);
  console.log(`[dev-custody] custody daemon http://127.0.0.1:${DAEMON_PORT}`);
  console.log(`[dev-custody] custody entity ${support.identity.entityId}`);
  console.log(`[dev-custody] verbose ${VERBOSE ? 'on' : 'off'} (set DEV_VERBOSE=1 for child logs)`);

  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
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
    if (!shuttingDown) {
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
