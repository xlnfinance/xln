#!/usr/bin/env bun

import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { deriveManagedEntityIdentity, DaemonControlClient, setupCustody } from '../orchestrator/daemon-control';
import {
  fetchDebugEntities,
  spawnBunChild,
  stopManagedChild,
  waitForDebugEntity,
  waitForHttpReady,
  type ManagedChild,
} from '../orchestrator/custody-bootstrap';

type MainHealthPayload = {
  hubs?: Array<{ entityId?: string }>;
  hubMesh?: { ok?: boolean };
  marketMaker?: { ok?: boolean };
  system?: { runtime?: boolean; relay?: boolean };
};

const MAIN_API_BASE_URL = process.env.CUSTODY_MAIN_API_BASE_URL || 'http://127.0.0.1:8080';
const MAIN_RPC_URL = process.env.CUSTODY_MAIN_RPC_URL || 'http://127.0.0.1:8545';
const PUBLIC_RPC_URL = process.env.CUSTODY_PUBLIC_RPC_URL || 'https://xln.finance/rpc';
const RELAY_URL = process.env.CUSTODY_RELAY_URL || 'wss://xln.finance/relay';
const WALLET_URL = process.env.CUSTODY_WALLET_URL || 'https://xln.finance/app';
const DAEMON_PORT = Number(process.env.CUSTODY_DAEMON_PORT || '8088');
const CUSTODY_PORT = Number(process.env.CUSTODY_PORT || '8087');
const DB_ROOT = resolve(process.env.CUSTODY_DB_ROOT || './db-tmp/prod-custody');
const SEED = process.env.CUSTODY_SEED || 'xln-prod-custody-seed';
const SIGNER_LABEL = process.env.CUSTODY_SIGNER_LABEL || 'custody-prod-1';
const PROFILE_NAME = process.env.CUSTODY_PROFILE_NAME || 'Custody';
const JURISDICTION_ID = process.env.CUSTODY_JURISDICTION_ID || 'arrakis';
const GOSSIP_POLL_MS = Number(process.env.CUSTODY_GOSSIP_POLL_MS || '250');

let shuttingDown = false;

const sleep = async (ms: number): Promise<void> => {
  await new Promise(resolve => setTimeout(resolve, ms));
};

const mirrorChildLogs = (prefix: string, child: ManagedChild): void => {
  child.proc.stdout.on('data', (chunk: Buffer | string) => {
    process.stdout.write(`[${prefix}] ${chunk.toString()}`);
  });
  child.proc.stderr.on('data', (chunk: Buffer | string) => {
    process.stderr.write(`[${prefix}:err] ${chunk.toString()}`);
  });
};

const readMainHealth = async (): Promise<MainHealthPayload> => {
  const response = await fetch(new URL('/api/health', MAIN_API_BASE_URL));
  if (!response.ok) {
    throw new Error(`main API health failed (${response.status})`);
  }
  return await response.json() as MainHealthPayload;
};

const waitForMainStackReady = async (): Promise<string[]> => {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    try {
      const payload = await readMainHealth();
      const hubIds = Array.isArray(payload.hubs)
        ? payload.hubs
          .map(hub => String(hub?.entityId || '').toLowerCase())
          .filter(Boolean)
        : [];
      const runtimeOk = payload.system?.runtime === true;
      const relayOk = payload.system?.relay === true;
      const meshOk = payload.hubMesh?.ok === true;
      const mmOk = payload.marketMaker?.ok === true;
      if (runtimeOk && relayOk && meshOk && mmOk && hubIds.length >= 3) {
        return hubIds.slice(0, 3);
      }
    } catch {
      // keep polling
    }
    await sleep(500);
  }
  throw new Error('MAIN_STACK_NOT_READY: expected runtime+relay+3 hubs+MM on main API');
};

const ensureExistingCustodyState = async (
  daemonBaseUrl: string,
  entityId: string,
  expectedHubCount: number,
): Promise<void> => {
  const entry = await waitForDebugEntity(
    daemonBaseUrl,
    entityId,
    candidate => Math.max(candidate.accounts?.length ?? 0, candidate.publicAccounts?.length ?? 0) >= expectedHubCount,
    30_000,
  );
  const accountCount = Math.max(entry.accounts?.length ?? 0, entry.publicAccounts?.length ?? 0);
  if (accountCount < expectedHubCount) {
    throw new Error(`CUSTODY_STATE_INCOMPLETE: expected >=${expectedHubCount} hub accounts, got ${accountCount}`);
  }
};

const startDaemon = async (): Promise<ManagedChild> => {
  const daemonChild = spawnBunChild(
    'custody-daemon',
    ['runtime/server.ts', '--port', String(DAEMON_PORT), '--host', '127.0.0.1', '--server-id', `custody-daemon-${DAEMON_PORT}`],
    {
      USE_ANVIL: 'true',
      BOOTSTRAP_LOCAL_HUBS: '0',
      ANVIL_RPC: MAIN_RPC_URL,
      PUBLIC_RPC: PUBLIC_RPC_URL,
      PUBLIC_RELAY_URL: RELAY_URL,
      RELAY_URL,
      XLN_DB_PATH: `${DB_ROOT}/daemon-db`,
    },
  );
  mirrorChildLogs('custody-daemon', daemonChild);
  await waitForHttpReady(`http://127.0.0.1:${DAEMON_PORT}/api/health`, daemonChild, 120_000);
  return daemonChild;
};

const ensureCustodyIdentity = async (hubIds: string[]): Promise<{ entityId: string; signerId: string }> => {
  const daemonBaseUrl = `http://127.0.0.1:${DAEMON_PORT}`;
  const client = new DaemonControlClient({ baseUrl: daemonBaseUrl, timeoutMs: 20_000 });
  const identity = deriveManagedEntityIdentity({
    name: PROFILE_NAME,
    seed: SEED,
    signerLabel: SIGNER_LABEL,
  });

  await client.registerSigner(identity.signerId, identity.privateKeyHex);
  const existing = await client.listEntities();
  const alreadyPresent = existing.some(entity => entity.entityId.toLowerCase() === identity.entityId.toLowerCase());

  if (!alreadyPresent) {
    await setupCustody(client, {
      name: PROFILE_NAME,
      seed: SEED,
      signerLabel: SIGNER_LABEL,
      hubEntityIds: hubIds,
      relayUrl: RELAY_URL,
      gossipPollMs: GOSSIP_POLL_MS,
      creditTokenIds: [1, 2, 3],
      routingEnabled: false,
    });
    await ensureExistingCustodyState(daemonBaseUrl, identity.entityId, hubIds.length);
  } else {
    await ensureExistingCustodyState(daemonBaseUrl, identity.entityId, hubIds.length);
    await client.configureP2P({
      relayUrls: [RELAY_URL],
      advertiseEntityIds: [identity.entityId],
      isHub: false,
      profileName: PROFILE_NAME,
      gossipPollMs: GOSSIP_POLL_MS,
    });
  }

  const entities = await fetchDebugEntities(daemonBaseUrl);
  const found = entities.find(entity => String(entity.entityId || '').toLowerCase() === identity.entityId.toLowerCase());
  if (!found) {
    throw new Error(`CUSTODY_ENTITY_MISSING: ${identity.entityId}`);
  }

  return { entityId: identity.entityId, signerId: identity.signerId };
};

const startCustodyService = async (identity: { entityId: string; signerId: string }): Promise<ManagedChild> => {
  const custodyChild = spawnBunChild(
    'custody-service',
    ['custody/server.ts'],
    {
      CUSTODY_HOST: '127.0.0.1',
      CUSTODY_PORT: String(CUSTODY_PORT),
      CUSTODY_DAEMON_WS: `ws://127.0.0.1:${DAEMON_PORT}/rpc`,
      CUSTODY_WALLET_URL: WALLET_URL,
      CUSTODY_ENTITY_ID: identity.entityId,
      CUSTODY_SIGNER_ID: identity.signerId,
      CUSTODY_DB_PATH: `${DB_ROOT}/custody.sqlite`,
      CUSTODY_JURISDICTION_ID: JURISDICTION_ID,
    },
  );
  mirrorChildLogs('custody', custodyChild);
  await waitForHttpReady(`http://127.0.0.1:${CUSTODY_PORT}/api/me`, custodyChild, 120_000);
  return custodyChild;
};

const main = async (): Promise<void> => {
  await mkdir(DB_ROOT, { recursive: true });
  await waitForHttpReady(`${MAIN_API_BASE_URL}/api/health`, null, 120_000);
  const hubIds = await waitForMainStackReady();
  const daemonChild = await startDaemon();
  const identity = await ensureCustodyIdentity(hubIds);
  const custodyChild = await startCustodyService(identity);

  console.log('[custody-prod] ready');
  console.log(`[custody-prod] main api ${MAIN_API_BASE_URL}`);
  console.log(`[custody-prod] wallet ${WALLET_URL}`);
  console.log(`[custody-prod] custody dashboard http://127.0.0.1:${CUSTODY_PORT}`);
  console.log(`[custody-prod] custody daemon http://127.0.0.1:${DAEMON_PORT}`);
  console.log(`[custody-prod] custody entity ${identity.entityId}`);

  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[custody-prod] shutting down on ${signal}`);
    await stopManagedChild(custodyChild);
    await stopManagedChild(daemonChild);
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  daemonChild.proc.on('close', (code) => {
    if (!shuttingDown) {
      console.error(`[custody-prod] daemon exited with code=${String(code)}`);
      void shutdown('daemon-exit');
    }
  });
  custodyChild.proc.on('close', (code) => {
    if (!shuttingDown) {
      console.error(`[custody-prod] custody exited with code=${String(code)}`);
      void shutdown('custody-exit');
    }
  });

  await new Promise<void>(() => {});
};

main().catch((error) => {
  console.error(`[custody-prod] ${(error as Error).stack || (error as Error).message}`);
  process.exit(1);
});
