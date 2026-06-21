#!/usr/bin/env bun

import { spawn, type ChildProcess } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, openSync, rmSync, closeSync, readFileSync, writeFileSync } from 'node:fs';
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
    expectedOffersPerHub?: number;
    hubs?: Array<{ offers?: number; blockers?: unknown[] }>;
    cross?: { ok?: boolean; expectedRoutes?: number; routes?: Array<{ blockers?: unknown[] }> };
  };
  custody?: { ok?: boolean };
  bootstrapReserves?: { ok?: boolean; targetMet?: boolean };
  reset?: { inProgress?: boolean; lastError?: string | null; completedAt?: number | null };
  degraded?: string[];
  bootstrap?: BootstrapHashInfo;
};

type BootstrapHashInfo = {
  readyHash?: string | null;
  runtimeStateHash?: string | null;
  entityStateHash?: string | null;
  readyAt?: number | null;
};

type MarketMakerInfoPayload = {
  bootstrap?: BootstrapHashInfo;
  runtimeBacklog?: {
    runtimeTxs?: number;
    entityInputs?: number;
    jInputs?: number;
    processing?: boolean;
  };
};

type BootstrapStage = {
  stage: string;
  elapsedMs: number;
  at: string;
  details?: unknown;
};

type BootstrapMetrics = {
  schema: 'xln-local-prod-bootstrap-benchmark-v1';
  elapsedMs: number;
  stages: BootstrapStage[];
  bootstrapHash: string;
  runtimeStateHash: string;
  entityStateHash: string;
  workDir: string;
  templateDir?: string;
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
const templateDir = String(process.env['XLN_LOCAL_PROD_SMOKE_TEMPLATE_DIR'] || '').trim();
const useSnapshotTemplate = templateDir.length > 0;
const persistMarketMakerStorage = useSnapshotTemplate || process.env['XLN_LOCAL_PROD_SMOKE_PERSIST_MM'] === '1';
const children: ManagedProcess[] = [];
const marketMakerInfoLatencyMaxMs = Math.max(
  250,
  Number(process.env['XLN_LOCAL_PROD_SMOKE_MM_INFO_MAX_MS'] || '1500'),
);
const postBootstrapStabilityMs = Math.max(
  0,
  Number(process.env['XLN_LOCAL_PROD_SMOKE_POST_BOOTSTRAP_STABILITY_MS'] || '2000'),
);
const smokeStartedAt = Date.now();
const stages: BootstrapStage[] = [];
const recordedStages = new Set<string>();

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

const recordStage = (stage: string, details?: unknown): void => {
  const entry: BootstrapStage = {
    stage,
    elapsedMs: Date.now() - smokeStartedAt,
    at: new Date().toISOString(),
    ...(details === undefined ? {} : { details }),
  };
  stages.push(entry);
  console.log(`[local-prod-smoke] stage ${JSON.stringify(entry)}`);
};

const recordStageOnce = (stage: string, details?: unknown): void => {
  if (recordedStages.has(stage)) return;
  recordedStages.add(stage);
  recordStage(stage, details);
};

const isHash64 = (value: unknown): value is string =>
  typeof value === 'string' && /^(?:0x)?[a-f0-9]{64}$/i.test(value);

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

const copySnapshotTemplate = (sourceDir: string, targetDir: string): void => {
  const requiredEntries = ['anvil-state.json', 'anvil2-state.json', 'prod-main', 'prod-mesh'] as const;
  for (const entry of requiredEntries) {
    const source = join(sourceDir, entry);
    if (!existsSync(source)) {
      throw new Error(`LOCAL_PROD_SMOKE_TEMPLATE_ENTRY_MISSING:${source}`);
    }
    cpSync(source, join(targetDir, entry), { recursive: true, force: true });
  }
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
        recordStageOnce(`rpc:${label.toLowerCase()}-ready`, { port, chainId: expectedChainId });
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

const assertMarketMakerInfoResponsive = async (): Promise<MarketMakerInfoPayload> => {
  const startedAt = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), marketMakerInfoLatencyMaxMs);
  try {
    const response = await fetch(`http://127.0.0.1:${marketMakerApiPort}/api/info`, {
      signal: controller.signal,
    });
    const elapsedMs = Date.now() - startedAt;
    if (!response.ok) throw new Error(`MM_INFO_HTTP_${response.status}`);
    const payload = await response.json() as MarketMakerInfoPayload;
    if (elapsedMs > marketMakerInfoLatencyMaxMs) {
      throw new Error(`MM_INFO_SLOW elapsedMs=${elapsedMs} maxMs=${marketMakerInfoLatencyMaxMs}`);
    }
    return payload;
  } catch (error) {
    const elapsedMs = Date.now() - startedAt;
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`MM_INFO_UNRESPONSIVE elapsedMs=${elapsedMs} maxMs=${marketMakerInfoLatencyMaxMs} error=${message}`);
  } finally {
    clearTimeout(timer);
  }
};

const assertNoMarketMakerBootstrapBacklog = (payload: MarketMakerInfoPayload): void => {
  const runtimeTxs = Number(payload.runtimeBacklog?.runtimeTxs ?? 0);
  const entityInputs = Number(payload.runtimeBacklog?.entityInputs ?? 0);
  if (runtimeTxs !== 0 || entityInputs !== 0) {
    throw new Error(
      `LOCAL_PROD_SMOKE_POST_BOOTSTRAP_BACKLOG runtimeTxs=${runtimeTxs} entityInputs=${entityInputs}`,
    );
  }
};

const healthReady = (health: HealthPayload): boolean => {
  const offers = health.marketMaker?.hubs?.map(hub => Number(hub.offers || 0)) ?? [];
  const expectedOffersPerHub = Number(health.marketMaker?.expectedOffersPerHub || 0);
  return health.coreOk === true &&
    health.systemOk === true &&
    Number(health.hubs?.length || 0) >= 3 &&
    health.system?.relay === true &&
    health.hubMesh?.ok === true &&
    health.marketMaker?.ok === true &&
    health.marketMaker?.startupPhase === 'offers-ready' &&
    Boolean(health.marketMaker?.entityId) &&
    expectedOffersPerHub > 0 &&
    offers.length >= 3 &&
    offers.every(offerCount => offerCount >= expectedOffersPerHub) &&
    (health.marketMaker?.hubs ?? []).every(hub => (hub.blockers ?? []).length === 0) &&
    Number(health.marketMaker?.cross?.expectedRoutes || 0) > 0 &&
    health.marketMaker?.cross?.ok === true &&
    (health.marketMaker?.cross?.routes ?? []).every(route => (route.blockers ?? []).length === 0) &&
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
    expectedOffersPerHub: health.marketMaker?.expectedOffersPerHub ?? null,
    offers: health.marketMaker?.hubs?.map(hub => hub.offers ?? 0) ?? [],
    blockers: health.marketMaker?.hubs?.map(hub => hub.blockers?.length ?? 0) ?? [],
    cross: {
      ok: health.marketMaker?.cross?.ok ?? null,
      expectedRoutes: health.marketMaker?.cross?.expectedRoutes ?? null,
      blockers: health.marketMaker?.cross?.routes?.map(route => route.blockers?.length ?? 0) ?? [],
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
  let lastMarketMakerPhase: string | null = null;
  while (Date.now() < deadline) {
    try {
      const health = await fetchHealth();
      last = summarizeHealth(health);
      const marketMakerPhase = String(health.marketMaker?.startupPhase || '');
      if (marketMakerPhase && marketMakerPhase !== lastMarketMakerPhase) {
        lastMarketMakerPhase = marketMakerPhase;
        recordStage(`marketMaker:${marketMakerPhase}`, last);
      }
      if (health.custody?.ok === true) recordStageOnce('custody:ready', last);
      if (health.bootstrapReserves?.ok === true) recordStageOnce('bootstrap-reserves:ready', last);
      if (health.hubMesh?.ok === true) recordStageOnce('hubMesh:ready', last);
      if (health.marketMaker?.cross?.ok === true) recordStageOnce('marketMaker:cross-ready', last);
      if (health.marketMaker?.ok === true) recordStageOnce('marketMaker:ready', last);
      if (health.marketMaker?.entityId || health.marketMaker?.startupPhase) {
        await assertMarketMakerInfoResponsive();
      }
      if (iteration % 10 === 0 || healthReady(health)) {
        console.log(`[local-prod-smoke] health ${JSON.stringify(last)}`);
      }
      if (healthReady(health)) {
        recordStageOnce('system:ready', last);
        return;
      }
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    iteration += 1;
    await sleep(1_000);
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
  recordStage('smoke:start', { workDir, portBase });
  if (useSnapshotTemplate) {
    copySnapshotTemplate(templateDir, workDir);
    recordStage('snapshot:copied', { templateDir, workDir });
  }
  startManaged('anvil', 'scripts/start-anvil.sh', useSnapshotTemplate ? [] : ['--reset'], {
    XLN_PORT_BASE: String(portBase),
    ANVIL_STATE: join(workDir, 'anvil-state.json'),
    ANVIL_LOG: join(workDir, 'anvil.log'),
    ANVIL_TMPDIR: join(workDir, 'anvil-tmp'),
  });
  startManaged('anvil2', 'scripts/start-anvil2.sh', useSnapshotTemplate ? [] : ['--reset'], {
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
    MARKET_MAKER_BOOTSTRAP_LOOP_MS: process.env['MARKET_MAKER_BOOTSTRAP_LOOP_MS'] || '25',
    MARKET_MAKER_MAX_ENTITY_INPUTS_PER_RUNTIME_FRAME:
      process.env['MARKET_MAKER_MAX_ENTITY_INPUTS_PER_RUNTIME_FRAME'] || '1000',
    MARKET_MAKER_BOOTSTRAP_MAX_NEW_OFFERS_PER_TICK: '1000',
    MARKET_MAKER_BOOTSTRAP_MAX_NEW_CROSS_OFFERS_PER_TICK: '1000',
    ...(useSnapshotTemplate ? { XLN_MESH_PRESERVE_STATE_ON_RESET: '1' } : {}),
    ...(persistMarketMakerStorage ? {
      XLN_MARKET_MAKER_DISABLE_STORAGE: '0',
      XLN_MARKET_MAKER_DISABLE_RESTORE: '0',
    } : {}),
  });
  recordStage('server:started', { apiPort, marketMakerApiPort });

  await waitForHealth();
  const marketMakerInfo = await assertMarketMakerInfoResponsive();
  const serverLog = readFileSync(logPath('server'), 'utf8');
  const hashMatch = serverLog.match(
    /BOOTSTRAP_READY_HASH hash=((?:0x)?[a-f0-9]{64})\s+runtimeStateHash=((?:0x)?[a-f0-9]{64})\s+entityStateHash=((?:0x)?[a-f0-9]{64})/,
  );
  if (!hashMatch || !isHash64(hashMatch[1]) || !isHash64(hashMatch[2]) || !isHash64(hashMatch[3])) {
    throw new Error('LOCAL_PROD_SMOKE_BOOTSTRAP_HASH_MISSING');
  }
  const bootstrap = marketMakerInfo.bootstrap ?? {};
  if (!isHash64(bootstrap.readyHash)) {
    throw new Error('LOCAL_PROD_SMOKE_BOOTSTRAP_INFO_HASH_MISSING');
  }
  if (!isHash64(bootstrap.runtimeStateHash)) {
    throw new Error('LOCAL_PROD_SMOKE_BOOTSTRAP_INFO_RUNTIME_HASH_MISSING');
  }
  if (!isHash64(bootstrap.entityStateHash)) {
    throw new Error('LOCAL_PROD_SMOKE_BOOTSTRAP_INFO_ENTITY_HASH_MISSING');
  }
  if (bootstrap.readyHash !== hashMatch[1]) {
    throw new Error(`LOCAL_PROD_SMOKE_BOOTSTRAP_HASH_MISMATCH info=${bootstrap.readyHash} log=${hashMatch[1]}`);
  }
  if (bootstrap.runtimeStateHash !== hashMatch[2]) {
    throw new Error(`LOCAL_PROD_SMOKE_BOOTSTRAP_RUNTIME_HASH_MISMATCH info=${bootstrap.runtimeStateHash} log=${hashMatch[2]}`);
  }
  if (bootstrap.entityStateHash !== hashMatch[3]) {
    throw new Error(`LOCAL_PROD_SMOKE_BOOTSTRAP_ENTITY_HASH_MISMATCH info=${bootstrap.entityStateHash} log=${hashMatch[3]}`);
  }
  assertNoMarketMakerBootstrapBacklog(marketMakerInfo);
  if (postBootstrapStabilityMs > 0) {
    recordStage('post-bootstrap:observed', { stabilityMs: postBootstrapStabilityMs });
    await sleep(postBootstrapStabilityMs);
    const postBootstrapHealth = await fetchHealth();
    if (!healthReady(postBootstrapHealth)) {
      throw new Error(
        `LOCAL_PROD_SMOKE_POST_BOOTSTRAP_HEALTH_REGRESSED last=${JSON.stringify(summarizeHealth(postBootstrapHealth))}`,
      );
    }
    const postBootstrapInfo = await assertMarketMakerInfoResponsive();
    assertNoMarketMakerBootstrapBacklog(postBootstrapInfo);
    if (postBootstrapInfo.bootstrap?.readyHash !== bootstrap.readyHash) {
      throw new Error(
        `LOCAL_PROD_SMOKE_POST_BOOTSTRAP_HASH_CHANGED before=${String(bootstrap.readyHash)} after=${String(postBootstrapInfo.bootstrap?.readyHash)}`,
      );
    }
    recordStage('post-bootstrap:stable', summarizeHealth(postBootstrapHealth));
  }
  const metrics: BootstrapMetrics = {
    schema: 'xln-local-prod-bootstrap-benchmark-v1',
    elapsedMs: Date.now() - smokeStartedAt,
    stages,
    bootstrapHash: bootstrap.readyHash,
    runtimeStateHash: bootstrap.runtimeStateHash,
    entityStateHash: bootstrap.entityStateHash,
    workDir,
    ...(useSnapshotTemplate ? { templateDir } : {}),
  };
  const metricsPath = process.env['XLN_LOCAL_PROD_SMOKE_METRICS_JSON'] || join(workDir, 'bootstrap-metrics.json');
  writeFileSync(metricsPath, `${JSON.stringify(metrics, null, 2)}\n`);
  console.log(
    `[local-prod-smoke] bootstrapHash=${metrics.bootstrapHash} runtimeStateHash=${metrics.runtimeStateHash} entityStateHash=${metrics.entityStateHash} metrics=${metricsPath}`,
  );
  console.log('[local-prod-smoke] green');
};

try {
  await main();
} finally {
  await stopManaged();
}
