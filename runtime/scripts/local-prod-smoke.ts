#!/usr/bin/env bun

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, openSync, rmSync, closeSync } from 'node:fs';
import { createConnection } from 'node:net';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

type ManagedProcess = {
  name: string;
  proc: ChildProcess;
};

type HealthPayload = {
  coreOk?: boolean;
  systemOk?: boolean;
  system?: { relay?: boolean };
  hubs?: Array<{ online?: boolean }>;
  hubMesh?: { ok?: boolean; direct?: { openLinkCount?: number } };
  marketMaker?: {
    ok?: boolean;
    entityId?: string | null;
    startupPhase?: string | null;
    hubs?: Array<{ offers?: number }>;
    cross?: { ok?: boolean; expectedRoutes?: number };
  };
  custody?: { ok?: boolean };
  bootstrapReserves?: { ok?: boolean; targetMet?: boolean };
  reset?: { inProgress?: boolean; lastError?: string | null; completedAt?: number | null };
  degraded?: string[];
};

const repoRoot = process.cwd();
const portBase = Number(process.env['XLN_LOCAL_PROD_SMOKE_PORT_BASE'] || '19300');
if (!Number.isInteger(portBase) || portBase < 10_000 || portBase > 60_000) {
  throw new Error(`Invalid XLN_LOCAL_PROD_SMOKE_PORT_BASE: ${String(portBase)}`);
}

const rpcPort = portBase;
const rpc2Port = portBase + 1;
const apiPort = portBase + 4;
const custodyPort = portBase + 7;
const custodyDaemonPort = portBase + 8;
const nodePortBase = portBase + 10;
const marketMakerApiPort = nodePortBase + 3;
const workDir = process.env['XLN_LOCAL_PROD_SMOKE_DIR'] || join(tmpdir(), `xln-local-prod-smoke-${portBase}`);
const children: ManagedProcess[] = [];
const marketMakerInfoLatencyMaxMs = Math.max(
  250,
  Number(process.env['XLN_LOCAL_PROD_SMOKE_MM_INFO_MAX_MS'] || '1500'),
);

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

const isPortOpen = async (port: number): Promise<boolean> => {
  return await new Promise<boolean>((resolve) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    const finish = (open: boolean): void => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(open);
    };
    socket.setTimeout(750);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
};

const assertPortsFree = async (ports: number[]): Promise<void> => {
  const busy: number[] = [];
  for (const port of ports) {
    if (await isPortOpen(port)) busy.push(port);
  }
  if (busy.length > 0) {
    throw new Error(`LOCAL_PROD_SMOKE_PORTS_BUSY: ${busy.join(',')}`);
  }
};

const logPath = (name: string): string => join(workDir, `${name}.log`);

const startManaged = (name: string, command: string, args: string[], env: Record<string, string>): void => {
  mkdirSync(workDir, { recursive: true });
  const out = openSync(logPath(name), 'a');
  const proc = spawn(command, args, {
    cwd: repoRoot,
    detached: true,
    env: {
      ...process.env,
      ...env,
    },
    stdio: ['ignore', out, out],
  });
  closeSync(out);
  children.push({ name, proc });
};

const stopManaged = async (): Promise<void> => {
  for (const child of children.reverse()) {
    if (!child.proc.pid || child.proc.exitCode !== null) continue;
    try {
      process.kill(-child.proc.pid, 'SIGTERM');
    } catch {}
  }
  await sleep(2_000);
  for (const child of children) {
    if (!child.proc.pid || child.proc.exitCode !== null) continue;
    try {
      process.kill(-child.proc.pid, 'SIGKILL');
    } catch {}
  }
};

const rpcChainId = async (port: number): Promise<string> => {
  const response = await fetch(`http://127.0.0.1:${port}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }),
  });
  if (!response.ok) throw new Error(`RPC_HTTP_${response.status}`);
  const payload = await response.json() as { result?: unknown };
  return String(payload.result || '');
};

const waitForRpc = async (port: number, expectedChainId: string, label: string): Promise<void> => {
  const deadline = Date.now() + 45_000;
  let last = '';
  while (Date.now() < deadline) {
    try {
      last = await rpcChainId(port);
      if (last === expectedChainId) {
        console.log(`[local-prod-smoke] ${label} chainId=${expectedChainId}`);
        return;
      }
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    await sleep(1_000);
  }
  throw new Error(`${label} RPC not ready on :${port}; last=${last}`);
};

const fetchHealth = async (): Promise<HealthPayload> => {
  const response = await fetch(`http://127.0.0.1:${apiPort}/api/health`);
  if (!response.ok) throw new Error(`HEALTH_HTTP_${response.status}`);
  return await response.json() as HealthPayload;
};

const assertMarketMakerInfoResponsive = async (): Promise<void> => {
  const startedAt = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), marketMakerInfoLatencyMaxMs);
  try {
    const response = await fetch(`http://127.0.0.1:${marketMakerApiPort}/api/info`, {
      signal: controller.signal,
    });
    const elapsedMs = Date.now() - startedAt;
    if (!response.ok) throw new Error(`MM_INFO_HTTP_${response.status}`);
    await response.json();
    if (elapsedMs > marketMakerInfoLatencyMaxMs) {
      throw new Error(`MM_INFO_SLOW elapsedMs=${elapsedMs} maxMs=${marketMakerInfoLatencyMaxMs}`);
    }
  } catch (error) {
    const elapsedMs = Date.now() - startedAt;
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`MM_INFO_UNRESPONSIVE elapsedMs=${elapsedMs} maxMs=${marketMakerInfoLatencyMaxMs} error=${message}`);
  } finally {
    clearTimeout(timer);
  }
};

const healthReady = (health: HealthPayload): boolean => {
  const offers = health.marketMaker?.hubs?.map(hub => Number(hub.offers || 0)) ?? [];
  return health.coreOk === true &&
    health.systemOk === true &&
    Number(health.hubs?.length || 0) >= 3 &&
    health.system?.relay === true &&
    health.hubMesh?.ok === true &&
    health.marketMaker?.ok === true &&
    Boolean(health.marketMaker?.entityId) &&
    offers.some(offerCount => offerCount > 0) &&
    Number(health.marketMaker?.cross?.expectedRoutes || 0) > 0 &&
    health.marketMaker?.cross?.ok === true &&
    health.custody?.ok === true &&
    health.bootstrapReserves?.ok === true;
};

const summarizeHealth = (health: HealthPayload): Record<string, unknown> => ({
  coreOk: health.coreOk ?? null,
  systemOk: health.systemOk ?? null,
  hubs: health.hubs?.length ?? 0,
  relay: health.system?.relay ?? null,
  hubMesh: health.hubMesh?.ok ?? null,
  directOpen: health.hubMesh?.direct?.openLinkCount ?? null,
  marketMaker: {
    ok: health.marketMaker?.ok ?? null,
    entity: Boolean(health.marketMaker?.entityId),
    offers: health.marketMaker?.hubs?.map(hub => hub.offers ?? 0) ?? [],
    cross: {
      ok: health.marketMaker?.cross?.ok ?? null,
      expectedRoutes: health.marketMaker?.cross?.expectedRoutes ?? null,
    },
    startupPhase: health.marketMaker?.startupPhase ?? null,
  },
  custody: health.custody?.ok ?? null,
  bootstrapReserves: health.bootstrapReserves?.ok ?? null,
  degraded: health.degraded ?? [],
  reset: {
    inProgress: health.reset?.inProgress ?? null,
    completed: Boolean(health.reset?.completedAt),
    lastError: health.reset?.lastError ?? null,
  },
});

const waitForHealth = async (): Promise<void> => {
  const deadline = Date.now() + 420_000;
  let last: unknown = null;
  let iteration = 0;
  while (Date.now() < deadline) {
    try {
      const health = await fetchHealth();
      last = summarizeHealth(health);
      if (health.marketMaker?.entityId || health.marketMaker?.startupPhase) {
        await assertMarketMakerInfoResponsive();
      }
      if (iteration % 3 === 0 || healthReady(health)) {
        console.log(`[local-prod-smoke] health ${JSON.stringify(last)}`);
      }
      if (healthReady(health)) return;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    iteration += 1;
    await sleep(10_000);
  }
  throw new Error(`LOCAL_PROD_SMOKE_HEALTH_TIMEOUT last=${JSON.stringify(last)}`);
};

const main = async (): Promise<void> => {
  await assertPortsFree([
    rpcPort,
    rpc2Port,
    apiPort,
    custodyPort,
    custodyDaemonPort,
    nodePortBase,
    nodePortBase + 1,
    nodePortBase + 2,
    nodePortBase + 3,
  ]);
  if (existsSync(workDir)) rmSync(workDir, { recursive: true, force: true });
  mkdirSync(workDir, { recursive: true });

  console.log(`[local-prod-smoke] workDir=${workDir} portBase=${portBase}`);
  startManaged('anvil', 'scripts/start-anvil.sh', ['--reset'], {
    XLN_PORT_BASE: String(portBase),
    ANVIL_STATE: join(workDir, 'anvil-state.json'),
    ANVIL_LOG: join(workDir, 'anvil.log'),
    ANVIL_TMPDIR: join(workDir, 'anvil-tmp'),
  });
  startManaged('anvil2', 'scripts/start-anvil2.sh', ['--reset'], {
    XLN_PORT_BASE: String(portBase),
    ANVIL2_STATE: join(workDir, 'anvil2-state.json'),
    ANVIL2_LOG: join(workDir, 'anvil2.log'),
    ANVIL_TMPDIR: join(workDir, 'anvil2-tmp'),
  });

  await waitForRpc(rpcPort, '0x7a69', 'Testnet');
  await waitForRpc(rpc2Port, '0x7a6a', 'Tron');

  startManaged('server', 'scripts/start-server.sh', [], {
    XLN_PORT_BASE: String(portBase),
    XLN_SERVER_PORT: String(apiPort),
    XLN_DB_PATH: join(workDir, 'prod-main'),
    XLN_JURISDICTIONS_PATH: join(workDir, 'prod-main', 'jurisdictions.json'),
    XLN_MESH_DB_ROOT: join(workDir, 'prod-mesh'),
    XLN_MESH_API_PORT_BASE: String(nodePortBase),
    XLN_MESH_PUBLIC_PORT_BASE: String(nodePortBase),
    XLN_MESH_CUSTODY_PORT: String(custodyPort),
    XLN_MESH_CUSTODY_DAEMON_PORT: String(custodyDaemonPort),
    PUBLIC_WS_BASE_URL: `ws://127.0.0.1:${apiPort}`,
    PUBLIC_RELAY_URL: `ws://127.0.0.1:${apiPort}/relay`,
    INTERNAL_RELAY_URL: `ws://127.0.0.1:${apiPort}/relay`,
    RELAY_URL: `ws://127.0.0.1:${apiPort}/relay`,
    PUBLIC_RPC: `http://127.0.0.1:${apiPort}/rpc`,
    XLN_MIN_DISK_FREE_BYTES: '1',
    MARKET_MAKER_BOOTSTRAP_MAX_NEW_OFFERS_PER_TICK: '180',
    MARKET_MAKER_BOOTSTRAP_MAX_NEW_CROSS_OFFERS_PER_TICK: '180',
    MARKET_MAKER_MAX_ENTITY_INPUTS_PER_RUNTIME_FRAME: '1',
    MARKET_MAKER_MAX_CONNECTIVITY_TXS_PER_ENTITY_INPUT: '1',
    MARKET_MAKER_MAX_NEW_OFFERS_PER_ENTITY_INPUT: '4',
    MARKET_MAKER_MAX_NEW_CROSS_REQUESTS_PER_ENTITY_INPUT: '2',
    MARKET_MAKER_MAX_NEW_CROSS_DEPTH_REQUESTS_PER_ENTITY_INPUT: '2',
  });

  await waitForHealth();
  console.log('[local-prod-smoke] green');
};

try {
  await main();
} finally {
  await stopManaged();
}
