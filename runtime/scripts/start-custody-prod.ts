#!/usr/bin/env bun

import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { deriveManagedEntityIdentity, DaemonControlClient, setupCustody } from '../orchestrator/daemon-control';
import { resolveJurisdictionsJsonPath } from '../jurisdictions-path';
import {
  spawnBunChild,
  stopManagedChild,
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
const DAEMON_RUNTIME_SEED = process.env.CUSTODY_DAEMON_RUNTIME_SEED || `${SEED}:runtime`;

let shuttingDown = false;

type ExistingCustodyPayload = {
  custody?: {
    entityId?: string | null;
  };
};

const sleep = async (ms: number): Promise<void> => {
  await new Promise(resolve => setTimeout(resolve, ms));
};

const isDaemonHealthReady = (payload: unknown): boolean => {
  const body = payload as {
    system?: { runtime?: boolean };
    database?: boolean;
  } | null;
  return body?.system?.runtime === true;
};

const findProcessIdsByPattern = async (pattern: string): Promise<number[]> => {
  return await new Promise<number[]>((resolve, reject) => {
    const child = spawn('pgrep', ['-f', '--', pattern], {
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', chunk => {
      stderr += chunk.toString();
    });

    child.on('error', reject);
    child.on('close', code => {
      if (code !== 0 && stdout.trim().length === 0) {
        resolve([]);
        return;
      }
      if (code !== 0) {
        reject(new Error(stderr.trim() || `pgrep exited with code ${String(code)}`));
        return;
      }
      const pids = stdout
        .split(/\r?\n/)
        .map(line => Number.parseInt(line.trim(), 10))
        .filter(pid => Number.isFinite(pid) && pid > 0 && pid !== process.pid);
      resolve(pids);
    });
  });
};

const killStaleCustodyDaemon = async (): Promise<void> => {
  const pattern = `runtime/server.ts --port ${DAEMON_PORT} --host 127.0.0.1 --server-id custody-daemon-${DAEMON_PORT}`;
  const pids = await findProcessIdsByPattern(pattern);
  if (pids.length === 0) return;

  console.log(`[custody-prod] killing stale custody daemon(s): ${pids.join(' ')}`);
  for (const pid of pids) {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      // Ignore already-dead processes.
    }
  }
  await sleep(1000);

  const remaining = await findProcessIdsByPattern(pattern);
  for (const pid of remaining) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // Ignore already-dead processes.
    }
  }
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
  client: DaemonControlClient,
  entityId: string,
  expectedHubCount: number,
): Promise<void> => {
  const deadline = Date.now() + 30_000;
  const target = entityId.toLowerCase();
  let lastCount = 0;
  while (Date.now() < deadline) {
    const entries = await client.listEntities();
    const entry = entries.find(candidate => candidate.entityId.toLowerCase() === target);
    if (entry) {
      lastCount = Math.max(entry.accountCount, entry.publicAccountCount);
      if (lastCount >= expectedHubCount) return;
    }
    await sleep(500);
  }
  throw new Error(`CUSTODY_STATE_INCOMPLETE: expected >=${expectedHubCount} hub accounts, got ${lastCount}`);
};

const isHttpReady = async (url: string): Promise<boolean> => {
  try {
    const response = await fetch(url);
    if (response.status >= 500) return false;
    if (url.endsWith('/api/health')) {
      return isDaemonHealthReady(await response.json());
    }
    return true;
  } catch {
    return false;
  }
};

const isDaemonControlReady = async (): Promise<boolean> => {
  try {
    const response = await fetch(`http://127.0.0.1:${DAEMON_PORT}/api/control/entities`);
    return response.ok;
  } catch {
    return false;
  }
};

const readExistingCustodyPayload = async (): Promise<ExistingCustodyPayload | null> => {
  try {
    const response = await fetch(`http://127.0.0.1:${CUSTODY_PORT}/api/me`);
    if (!response.ok) return null;
    return await response.json() as ExistingCustodyPayload;
  } catch {
    return null;
  }
};

const startDaemon = async (): Promise<ManagedChild | null> => {
  if (
    await isHttpReady(`http://127.0.0.1:${DAEMON_PORT}/api/health`)
    && await isDaemonControlReady()
  ) {
    console.log(`[custody-prod] reusing existing custody daemon on :${DAEMON_PORT}`);
    return null;
  }

  await killStaleCustodyDaemon();

  const daemonChild = spawnBunChild(
    'custody-daemon',
    ['runtime/server.ts', '--port', String(DAEMON_PORT), '--host', '127.0.0.1', '--server-id', `custody-daemon-${DAEMON_PORT}`],
    {
      USE_ANVIL: 'true',
      BOOTSTRAP_LOCAL_HUBS: '0',
      XLN_SKIP_SERVER_BOOTSTRAP: '1',
      XLN_EARLY_HTTP_BIND: '1',
      ANVIL_RPC: MAIN_RPC_URL,
      PUBLIC_RPC: PUBLIC_RPC_URL,
      PUBLIC_RELAY_URL: RELAY_URL,
      RELAY_URL,
      XLN_USE_PREDEPLOYED_ADDRESSES: 'true',
      XLN_JURISDICTIONS_PATH: resolveJurisdictionsJsonPath(),
      XLN_RUNTIME_SEED: DAEMON_RUNTIME_SEED,
      XLN_DB_PATH: `${DB_ROOT}/daemon-db`,
    },
  );
  mirrorChildLogs('custody-daemon', daemonChild);
  await waitForHttpReady(
    `http://127.0.0.1:${DAEMON_PORT}/api/health`,
    daemonChild,
    240_000,
    async (_response, bodyText) => isDaemonHealthReady(JSON.parse(bodyText)),
  );
  const controlDeadline = Date.now() + 60_000;
  while (Date.now() < controlDeadline) {
    if (await isDaemonControlReady()) {
      return daemonChild;
    }
    await sleep(500);
  }
  throw new Error(`CUSTODY_DAEMON_CONTROL_NOT_READY: http://127.0.0.1:${DAEMON_PORT}/api/control/entities`);
};

const ensureCustodyIdentity = async (hubIds: string[]): Promise<{ entityId: string; signerId: string }> => {
  const client = new DaemonControlClient({ baseUrl: `http://127.0.0.1:${DAEMON_PORT}`, timeoutMs: 20_000 });
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
    await ensureExistingCustodyState(client, identity.entityId, hubIds.length);
  } else {
    await ensureExistingCustodyState(client, identity.entityId, hubIds.length);
    await client.configureP2P({
      relayUrls: [RELAY_URL],
      advertiseEntityIds: [identity.entityId],
      isHub: false,
      gossipPollMs: GOSSIP_POLL_MS,
    });
  }

  const entities = await client.listEntities();
  const found = entities.find(entity => entity.entityId.toLowerCase() === identity.entityId.toLowerCase());
  if (!found) {
    throw new Error(`CUSTODY_ENTITY_MISSING: ${identity.entityId}`);
  }

  return { entityId: identity.entityId, signerId: identity.signerId };
};

const startCustodyService = async (identity: { entityId: string; signerId: string }): Promise<ManagedChild | null> => {
  const existing = await readExistingCustodyPayload();
  if (existing?.custody?.entityId?.toLowerCase() === identity.entityId.toLowerCase()) {
    console.log(`[custody-prod] reusing existing custody service on :${CUSTODY_PORT}`);
    return null;
  }
  if (existing?.custody?.entityId) {
    throw new Error(
      `CUSTODY_PORT_CONFLICT: port ${CUSTODY_PORT} is already serving ${existing.custody.entityId}, expected ${identity.entityId}`,
    );
  }

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
  await waitForHttpReady(`http://127.0.0.1:${CUSTODY_PORT}/api/me`, custodyChild, 240_000);
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

  if (daemonChild) {
    daemonChild.proc.on('close', (code) => {
      if (!shuttingDown) {
        console.error(`[custody-prod] daemon exited with code=${String(code)}`);
        void shutdown('daemon-exit');
      }
    });
  }
  if (custodyChild) {
    custodyChild.proc.on('close', (code) => {
      if (!shuttingDown) {
        console.error(`[custody-prod] custody exited with code=${String(code)}`);
        void shutdown('custody-exit');
      }
    });
  }

  await new Promise<void>(() => {});
};

main().catch((error) => {
  console.error(`[custody-prod] ${(error as Error).stack || (error as Error).message}`);
  process.exit(1);
});
