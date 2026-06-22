#!/usr/bin/env bun

import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { appendFileSync, cpSync, existsSync, mkdirSync, openSync, rmSync, closeSync, readFileSync, writeFileSync } from 'node:fs';
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
  eventsJsonl: string;
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
let fatalStageBudgetError: string | null = null;
const eventsJsonlPath = process.env['XLN_LOCAL_PROD_SMOKE_EVENTS_JSONL'] || join(workDir, 'bootstrap-events.jsonl');
const enforceStageBudgets = process.env['XLN_LOCAL_PROD_SMOKE_ENFORCE_STAGE_BUDGETS'] === '1';
const healthPollMaxMs = Math.max(
  250,
  Number(process.env['XLN_LOCAL_PROD_SMOKE_HEALTH_POLL_MAX_MS'] || '2000'),
);
const stageBudgetsMs = {
  hubMesh: Math.max(1, Number(process.env['XLN_LOCAL_PROD_SMOKE_HUB_MESH_BUDGET_MS'] || '5000')),
  sameChain: Math.max(1, Number(process.env['XLN_LOCAL_PROD_SMOKE_SAME_CHAIN_BUDGET_MS'] || '8000')),
  cross: Math.max(1, Number(process.env['XLN_LOCAL_PROD_SMOKE_CROSS_BUDGET_MS'] || '25000')),
};

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

const recordStage = (stage: string, details?: unknown): void => {
  const entry: BootstrapStage = {
    stage,
    elapsedMs: Date.now() - smokeStartedAt,
    at: new Date().toISOString(),
    ...(details === undefined ? {} : { details }),
  };
  stages.push(entry);
  emitDebugEvent('stage', { stage, details });
  console.log(`[local-prod-smoke] stage ${JSON.stringify(entry)}`);
};

const recordStageOnce = (stage: string, details?: unknown): void => {
  if (recordedStages.has(stage)) return;
  recordedStages.add(stage);
  recordStage(stage, details);
};

const isHash64 = (value: unknown): value is string =>
  typeof value === 'string' && /^(?:0x)?[a-f0-9]{64}$/i.test(value);

const normalizeError = (error: unknown): Record<string, unknown> => {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
    };
  }
  return { message: String(error) };
};

function emitDebugEvent(event: string, fields: Record<string, unknown> = {}): void {
  const record = {
    schema: 'xln-bootstrap-debug-event-v1',
    at: new Date().toISOString(),
    elapsedMs: Date.now() - smokeStartedAt,
    event,
    ...fields,
  };
  try {
    mkdirSync(workDir, { recursive: true });
    appendFileSync(eventsJsonlPath, `${JSON.stringify(record)}\n`);
  } catch {
    // Smoke assertions must not be hidden by diagnostic file I/O.
  }
}

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
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('LOCAL_PROD_SMOKE_STAGE_BUDGET_EXCEEDED')) {
        throw error;
      }
      last = message;
    }
    await sleep(1_000);
  }
  throw new Error(`${label} RPC not ready on :${port}; last=${last}`);
};

const fetchJsonWithCurl = <T>(url: string, maxMs: number, label: string): T => {
  const startedAt = Date.now();
  const maxTimeSeconds = (Math.max(250, maxMs) / 1000).toFixed(3);
  const result = spawnSync('curl', ['-sS', '--max-time', maxTimeSeconds, url], {
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
    timeout: Math.max(1000, maxMs + 500),
  });
  const elapsedMs = Date.now() - startedAt;
  if (result.error) {
    throw new Error(`${label}_UNRESPONSIVE elapsedMs=${elapsedMs} maxMs=${maxMs} error=${result.error.message}`);
  }
  if (result.status !== 0) {
    const stderr = String(result.stderr || '').trim();
    throw new Error(`${label}_UNRESPONSIVE elapsedMs=${elapsedMs} maxMs=${maxMs} status=${String(result.status)} stderr=${stderr}`);
  }
  try {
    return JSON.parse(String(result.stdout || '')) as T;
  } catch (error) {
    throw new Error(
      `${label}_JSON_INVALID elapsedMs=${elapsedMs} maxMs=${maxMs} error=${
        error instanceof Error ? error.message : String(error)
      } body=${String(result.stdout || '').slice(0, 500)}`,
    );
  }
};

const fetchHealth = async (): Promise<HealthPayload> => {
  const startedAt = Date.now();
  try {
    const payload = fetchJsonWithCurl<HealthPayload>(
      `http://127.0.0.1:${apiPort}/api/health`,
      healthPollMaxMs,
      'HEALTH_POLL',
    );
    const elapsedMs = Date.now() - startedAt;
    emitDebugEvent('health-poll', { stage: 'health-poll', elapsedMs, ok: true });
    return payload;
  } catch (error) {
    const elapsedMs = Date.now() - startedAt;
    throw new Error(
      `LOCAL_PROD_SMOKE_HEALTH_POLL_FAILED elapsedMs=${elapsedMs} maxMs=${healthPollMaxMs} error=${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
};

const assertMarketMakerInfoResponsive = async (): Promise<MarketMakerInfoPayload> => {
  const startedAt = Date.now();
  try {
    const payload = fetchJsonWithCurl<MarketMakerInfoPayload>(
      `http://127.0.0.1:${marketMakerApiPort}/api/info`,
      marketMakerInfoLatencyMaxMs,
      'MM_INFO',
    );
    const elapsedMs = Date.now() - startedAt;
    if (elapsedMs > marketMakerInfoLatencyMaxMs) {
      throw new Error(`MM_INFO_SLOW elapsedMs=${elapsedMs} maxMs=${marketMakerInfoLatencyMaxMs}`);
    }
    return payload;
  } catch (error) {
    const elapsedMs = Date.now() - startedAt;
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`MM_INFO_UNRESPONSIVE elapsedMs=${elapsedMs} maxMs=${marketMakerInfoLatencyMaxMs} error=${message}`);
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

const stageElapsed = (stage: string): number | null =>
  stages.find(entry => entry.stage === stage)?.elapsedMs ?? null;

const requireStageBudget = (
  stage: string,
  elapsedMs: number,
  maxMs: number,
  snapshot: unknown,
): void => {
  if (!enforceStageBudgets || elapsedMs <= maxMs) return;
  emitDebugEvent('stage-budget-exceeded', {
    stage,
    elapsedMs,
    maxMs,
    snapshot,
  });
  fatalStageBudgetError =
    `LOCAL_PROD_SMOKE_STAGE_BUDGET_EXCEEDED stage=${stage} elapsedMs=${elapsedMs} maxMs=${maxMs} ` +
    `events=${eventsJsonlPath} snapshot=${JSON.stringify(snapshot)}`;
  throw new Error(fatalStageBudgetError);
};

const enforceBootstrapStageBudgets = (health: HealthPayload, snapshot: Record<string, unknown>): void => {
  if (!enforceStageBudgets) return;
  const nowElapsedMs = Date.now() - smokeStartedAt;
  const serverStartedAt = stageElapsed('server:started') ?? 0;
  const hubMeshReadyAt = stageElapsed('hubMesh:ready');
  if (hubMeshReadyAt === null) {
    requireStageBudget('hubMesh', nowElapsedMs - serverStartedAt, stageBudgetsMs.hubMesh, snapshot);
  } else {
    requireStageBudget('hubMesh', hubMeshReadyAt - serverStartedAt, stageBudgetsMs.hubMesh, snapshot);
  }

  const sameStartedAt = stageElapsed('marketMaker:bootstrap-same-chain');
  const crossStartedAt = stageElapsed('marketMaker:bootstrap-cross');
  const crossReadyAt = stageElapsed('marketMaker:cross-ready');
  const phase = String(health.marketMaker?.startupPhase || '');
  if (sameStartedAt !== null && crossStartedAt === null && phase === 'bootstrap-same-chain') {
    requireStageBudget('marketMaker:same-chain', nowElapsedMs - sameStartedAt, stageBudgetsMs.sameChain, snapshot);
  }
  if (sameStartedAt !== null && crossStartedAt !== null) {
    requireStageBudget('marketMaker:same-chain', crossStartedAt - sameStartedAt, stageBudgetsMs.sameChain, snapshot);
  }
  if (crossStartedAt !== null && crossReadyAt === null) {
    requireStageBudget('marketMaker:cross', nowElapsedMs - crossStartedAt, stageBudgetsMs.cross, snapshot);
  }
  if (crossStartedAt !== null && crossReadyAt !== null) {
    requireStageBudget('marketMaker:cross', crossReadyAt - crossStartedAt, stageBudgetsMs.cross, snapshot);
  }
};

const waitForHealth = async (): Promise<HealthPayload> => {
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
      if (
        health.marketMaker?.cross?.ok === true &&
        Number(health.marketMaker?.cross?.expectedRoutes || 0) > 0
      ) {
        recordStageOnce('marketMaker:cross-ready', last);
      }
      if (health.marketMaker?.ok === true) recordStageOnce('marketMaker:ready', last);
      enforceBootstrapStageBudgets(health, last as Record<string, unknown>);
      if (iteration % 10 === 0 || healthReady(health)) {
        console.log(`[local-prod-smoke] health ${JSON.stringify(last)}`);
      }
      if (healthReady(health)) {
        recordStageOnce('system:ready', last);
        return health;
      }
    } catch (error) {
      if (fatalStageBudgetError) throw new Error(fatalStageBudgetError);
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('LOCAL_PROD_SMOKE_STAGE_BUDGET_EXCEEDED')) throw error;
      last = message;
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
  recordStage('smoke:start', { workDir, portBase, strictBudgets: enforceStageBudgets, stageBudgetsMs });
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

  const readyHealth = await waitForHealth();
  const marketMakerInfo = process.env['XLN_LOCAL_PROD_SMOKE_ASSERT_MM_INFO'] === '1'
    ? await assertMarketMakerInfoResponsive()
    : null;
  const serverLog = readFileSync(logPath('server'), 'utf8');
  const hashMatch = serverLog.match(
    /BOOTSTRAP_READY_HASH hash=((?:0x)?[a-f0-9]{64})\s+runtimeStateHash=((?:0x)?[a-f0-9]{64})\s+entityStateHash=((?:0x)?[a-f0-9]{64})/,
  );
  if (!hashMatch || !isHash64(hashMatch[1]) || !isHash64(hashMatch[2]) || !isHash64(hashMatch[3])) {
    throw new Error('LOCAL_PROD_SMOKE_BOOTSTRAP_HASH_MISSING');
  }
  const bootstrap = marketMakerInfo?.bootstrap ?? readyHealth.bootstrap ?? {
    readyHash: hashMatch[1],
    runtimeStateHash: hashMatch[2],
    entityStateHash: hashMatch[3],
  };
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
  if (marketMakerInfo) assertNoMarketMakerBootstrapBacklog(marketMakerInfo);
  if (postBootstrapStabilityMs > 0) {
    recordStage('post-bootstrap:observed', { stabilityMs: postBootstrapStabilityMs });
    await sleep(postBootstrapStabilityMs);
    const postBootstrapHealth = await fetchHealth();
    if (!healthReady(postBootstrapHealth)) {
      throw new Error(
        `LOCAL_PROD_SMOKE_POST_BOOTSTRAP_HEALTH_REGRESSED last=${JSON.stringify(summarizeHealth(postBootstrapHealth))}`,
      );
    }
    const postBootstrapInfo = process.env['XLN_LOCAL_PROD_SMOKE_ASSERT_MM_INFO'] === '1'
      ? await assertMarketMakerInfoResponsive()
      : null;
    if (postBootstrapInfo) assertNoMarketMakerBootstrapBacklog(postBootstrapInfo);
    const postBootstrapHash = postBootstrapInfo?.bootstrap?.readyHash ?? postBootstrapHealth.bootstrap?.readyHash ?? bootstrap.readyHash;
    if (postBootstrapHash !== bootstrap.readyHash) {
      throw new Error(
        `LOCAL_PROD_SMOKE_POST_BOOTSTRAP_HASH_CHANGED before=${String(bootstrap.readyHash)} after=${String(postBootstrapHash)}`,
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
    eventsJsonl: eventsJsonlPath,
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
} catch (error) {
  emitDebugEvent('fatal', { stage: 'local-prod-smoke', error: normalizeError(error) });
  throw error;
} finally {
  await stopManaged();
}
