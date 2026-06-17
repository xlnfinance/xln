/**
 * Scenario determinism oracle.
 *
 * Runs each deterministic scenario multiple times with the same runtime seed and
 * compares the complete runtime history hash sequence plus final state hash.
 */

import type { Env } from '../types';
import { createHash } from 'node:crypto';
import { safeStringify } from '../serialization-utils';
import { clearSignerKeys } from '../account-crypto';
import { createGossipLayer } from '../networking/gossip';
import { scenarioRegistry, type ScenarioEntry } from './index';
import { assertRuntimeIdle } from './helpers';
import { setEntityFrameHashDebugRecorder, type EntityFrameHashDebugRecord } from '../entity-consensus-frame';

const RUNS = 2;
const SEED = 'determinism-test-seed-42';
const INITIAL_TIMESTAMP = 1;
const DEFAULT_RPC_BASE_PORT = 29_000 + (process.pid % 1_000) * 20;
const RPC_BASE_PORT = Math.floor(Number(process.env['XLN_DETERMINISM_RPC_BASE_PORT'] ?? DEFAULT_RPC_BASE_PORT));
const EXCLUDED_SCENARIOS = new Set([
  'ahb', // legacy triangle demo does not drain under the RPC determinism harness
  'grid', // visual scalability demo; not a consensus correctness oracle
  'rapid-fire', // explicitly stress-only in the registry
  'swap-tps', // throughput benchmark, not a correctness scenario
]);

const requestedScenarioKeys = (): Set<string> => {
  const raw = process.env['XLN_DETERMINISM_SCENARIOS'] ?? '';
  return new Set(raw.split(',').map((key) => key.trim()).filter(Boolean));
};

type ScenarioOracle = {
  frameCount: number;
  frameHashes: string[];
  frameValues: unknown[];
  frameHashTrace: unknown[];
  finalValue: unknown;
  finalHash: string;
  combinedHash: string;
};

type ScenarioResult = {
  key: string;
  name: string;
  success: boolean;
  runs: ScenarioOracle[];
  error?: string;
};

const normalizeOracleValue = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(normalizeOracleValue);
  if (typeof value === 'string') {
    return value.replace(/https?:\/\/(?:127\.0\.0\.1|localhost):\d+/g, 'http://<local-rpc>');
  }
  if (value === null || typeof value !== 'object') return value;

  const source = value as Record<string, unknown>;
  const normalized: Record<string, unknown> = {};
  for (const key of Object.keys(source)) {
    // Anvil block hashes include external block metadata and can differ even
    // when event bodies, tx hashes, nonces, balances, and RJEA transitions match.
    normalized[key] = key === 'blockHash' || key === 'jBlockHash'
      ? '<external-block-hash>'
      : normalizeOracleValue(source[key]);
  }
  return normalized;
};

const toOracleValue = (value: unknown): unknown => {
  const tagged = JSON.parse(safeStringify(value));
  return normalizeOracleValue(tagged);
};

const normalizeDebugTraceValue = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(normalizeDebugTraceValue);
  if (typeof value === 'string') {
    return value.replace(/https?:\/\/(?:127\.0\.0\.1|localhost):\d+/g, 'http://<local-rpc>');
  }
  if (value === null || typeof value !== 'object') return value;

  const source = value as Record<string, unknown>;
  const normalized: Record<string, unknown> = {};
  for (const key of Object.keys(source)) {
    normalized[key] = normalizeDebugTraceValue(source[key]);
  }
  return normalized;
};

const toDebugTraceValue = (value: unknown): unknown =>
  normalizeDebugTraceValue(JSON.parse(safeStringify(value)));

const hashOracleValue = (value: unknown, length = 32): string =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, length);

type ConsoleFns = {
  log: typeof console.log;
  info: typeof console.info;
  warn: typeof console.warn;
  debug: typeof console.debug;
  error: typeof console.error;
};

const captureConsole = (): ConsoleFns => ({
  log: console.log,
  info: console.info,
  warn: console.warn,
  debug: console.debug,
  error: console.error,
});

const restoreConsole = (original: ConsoleFns): void => {
  console.log = original.log;
  console.info = original.info;
  console.warn = original.warn;
  console.debug = original.debug;
  console.error = original.error;
};

const projectJReplicas = (jReplicas: Env['jReplicas'] | undefined): Map<string, unknown> => {
  const projected = new Map<string, unknown>();
  for (const [key, replica] of jReplicas ?? new Map()) {
    projected.set(key, {
      name: replica.name,
      chainId: replica.chainId,
      blockNumber: replica.blockNumber,
      stateRoot: replica.stateRoot,
      blockDelayMs: replica.blockDelayMs,
      blockTimeMs: replica.blockTimeMs,
      lastBlockTimestamp: replica.lastBlockTimestamp,
      blockReady: replica.blockReady,
      depositoryAddress: replica.depositoryAddress,
      entityProviderAddress: replica.entityProviderAddress,
      contracts: replica.contracts,
      mempool: replica.mempool,
    });
  }
  return projected;
};

const snapshotEnvProjection = (env: Env): Record<string, unknown> => ({
  height: env.height,
  timestamp: env.timestamp,
  runtimeId: env.runtimeId,
  eReplicas: env.eReplicas,
  jReplicas: projectJReplicas(env.jReplicas),
  runtimeInput: env.runtimeInput,
  pendingOutputs: env.pendingOutputs ?? [],
  pendingNetworkOutputs: env.pendingNetworkOutputs ?? [],
  networkInbox: env.networkInbox ?? [],
  runtimeState: {
    pendingCommittedJOutbox: env.runtimeState?.pendingCommittedJOutbox ?? [],
  },
});

const snapshotProjection = (snapshot: Env['history'][number]): Record<string, unknown> => ({
  height: snapshot.height,
  timestamp: snapshot.timestamp,
  runtimeId: snapshot.runtimeId,
  eReplicas: snapshot.eReplicas,
  jReplicas: projectJReplicas(snapshot.jReplicas),
  runtimeInput: snapshot.runtimeInput,
  runtimeOutputs: snapshot.runtimeOutputs,
  description: snapshot.description,
  meta: snapshot.meta,
  logs: snapshot.logs ?? [],
});

const buildFrameHashTrace = (records: EntityFrameHashDebugRecord[]): unknown[] =>
  records.map((record) => toDebugTraceValue({
    entityId: record.entityId,
    height: record.height,
    payload: record.payload,
  }));

const buildOracle = (env: Env, frameHashRecords: EntityFrameHashDebugRecord[]): ScenarioOracle => {
  const frameValues = (env.history ?? []).map((snapshot) => toOracleValue(snapshotProjection(snapshot)));
  const frameHashes = frameValues.map((snapshot) => hashOracleValue(snapshot, 24));
  const frameHashTrace = buildFrameHashTrace(frameHashRecords);
  const finalValue = toOracleValue(snapshotEnvProjection(env));
  const finalHash = hashOracleValue(finalValue, 32);
  const frameCount = frameHashes.length;
  const combinedHash = hashOracleValue(toOracleValue({ frameCount, frameHashes, finalHash }), 32);
  return { frameCount, frameHashes, frameValues, frameHashTrace, finalValue, finalHash, combinedHash };
};

type DiffResult = {
  path: string;
  left: unknown;
  right: unknown;
};

const findFirstDiff = (left: unknown, right: unknown, path = '$'): DiffResult | null => {
  if (JSON.stringify(left) === JSON.stringify(right)) return null;
  if (
    left === null ||
    right === null ||
    typeof left !== 'object' ||
    typeof right !== 'object' ||
    Array.isArray(left) !== Array.isArray(right)
  ) {
    return { path, left, right };
  }

  if (Array.isArray(left) && Array.isArray(right)) {
    const max = Math.max(left.length, right.length);
    for (let index = 0; index < max; index += 1) {
      const diff = findFirstDiff(left[index], right[index], `${path}[${index}]`);
      if (diff) return diff;
    }
    return { path, left, right };
  }

  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const keys = [...new Set([...Object.keys(leftRecord), ...Object.keys(rightRecord)])].sort();
  for (const key of keys) {
    const escaped = /^[a-zA-Z_$][\w$]*$/.test(key) ? `.${key}` : `[${JSON.stringify(key)}]`;
    const diff = findFirstDiff(leftRecord[key], rightRecord[key], `${path}${escaped}`);
    if (diff) return diff;
  }
  return { path, left, right };
};

const previewValue = (value: unknown): string => {
  const encoded = safeStringify(value);
  return encoded.length > 700 ? `${encoded.slice(0, 700)}...` : encoded;
};

const findFirstMismatch = (left: string[], right: string[]): number => {
  const max = Math.max(left.length, right.length);
  for (let index = 0; index < max; index += 1) {
    if (left[index] !== right[index]) return index;
  }
  return -1;
};

const assertMatchingOracles = (scenario: ScenarioEntry, runs: ScenarioOracle[]): void => {
  const [expected, ...rest] = runs;
  if (!expected) throw new Error(`${scenario.key}: determinism oracle has no completed runs`);
  for (let index = 0; index < rest.length; index += 1) {
    const actual = rest[index];
    if (!actual) throw new Error(`${scenario.key}: determinism oracle missing run ${index + 2}`);
    if (actual.combinedHash === expected.combinedHash) continue;

    const mismatchIndex = findFirstMismatch(expected.frameHashes, actual.frameHashes);
    const mismatch =
      mismatchIndex === -1
        ? `final ${expected.finalHash} != ${actual.finalHash}`
        : `frame ${mismatchIndex + 1} ${expected.frameHashes[mismatchIndex] ?? 'missing'} != ${actual.frameHashes[mismatchIndex] ?? 'missing'}`;
    const diff = mismatchIndex === -1
      ? findFirstDiff(expected.finalValue, actual.finalValue)
      : findFirstDiff(expected.frameValues[mismatchIndex], actual.frameValues[mismatchIndex]);
    const diffText = diff
      ? ` diff=${diff.path} left=${previewValue(diff.left)} right=${previewValue(diff.right)}`
      : '';
    const traceDiff = findFirstDiff(expected.frameHashTrace, actual.frameHashTrace);
    const traceText = traceDiff
      ? ` frameHashInputDiff=${traceDiff.path} left=${previewValue(traceDiff.left)} right=${previewValue(traceDiff.right)}`
      : '';
    throw new Error(
      `${scenario.key}: non-deterministic replay between run 1 and run ${index + 2}: ${mismatch}${diffText}${traceText}`,
    );
  }
};

const cleanupScenarioEnv = async (env: Env): Promise<void> => {
  const adapters = new Set<unknown>();
  if (env.jAdapter) adapters.add(env.jAdapter);
  for (const replica of env.jReplicas?.values() ?? []) {
    if (replica.jadapter) adapters.add(replica.jadapter);
  }

  for (const adapter of adapters) {
    const close = (adapter as { close?: () => Promise<void> | void }).close;
    if (typeof close === 'function') {
      await close.call(adapter);
    }
  }

  const { closeRuntimeDb, closeInfraDb } = await import('../runtime');
  await closeRuntimeDb(env);
  await closeInfraDb(env);
};

const rpcUrlForScenarioRun = (scenarioIndex: number, runIndex: number): string =>
  `http://127.0.0.1:${RPC_BASE_PORT + scenarioIndex * RUNS + runIndex - 1}`;

const runScenarioOnce = async (
  scenario: ScenarioEntry,
  runIndex: number,
  scenarioIndex: number,
): Promise<ScenarioOracle> => {
  const { createEmptyEnv } = await import('../runtime');
  const originalConsole = captureConsole();
  const previousJAdapterMode = process.env['JADAPTER_MODE'];
  const previousAnvilRpc = process.env['ANVIL_RPC'];
  const previousForceFreshAnvil = process.env['XLN_FORCE_FRESH_ANVIL'];
  let env: Env | null = null;
  let activeEnv: Env | null = null;
  const frameHashRecords: EntityFrameHashDebugRecord[] = [];
  const restoreFrameHashRecorder = setEntityFrameHashDebugRecorder((record) => {
    frameHashRecords.push(record);
  });
  try {
    const rpcUrl = rpcUrlForScenarioRun(scenarioIndex, runIndex);
    process.env['JADAPTER_MODE'] = 'rpc';
    process.env['ANVIL_RPC'] = rpcUrl;
    process.env['XLN_FORCE_FRESH_ANVIL'] = '1';

    clearSignerKeys();
    env = createEmptyEnv(SEED);
    activeEnv = env;
    env.dbNamespace = `determinism-${scenario.key}-${runIndex}`;
    env.gossip = createGossipLayer();
    env.scenarioMode = true;
    env.quietRuntimeLogs = true;
    env.scenarioLogLevel = 'error';
    env.timestamp = INITIAL_TIMESTAMP;
    env.runtimeConfig = {
      ...env.runtimeConfig,
      storage: {
        ...env.runtimeConfig?.storage,
        enabled: false,
      },
    };
    if (env.runtimeState) env.runtimeState.persistencePaused = true;

    const run = await scenario.load() as (targetEnv: Env) => Promise<Env | void>;
    const returnedEnv = await run(env);
    if (returnedEnv) activeEnv = returnedEnv;
    assertRuntimeIdle(activeEnv, scenario.name);
    return buildOracle(activeEnv, frameHashRecords);
  } finally {
    restoreFrameHashRecorder();
    restoreConsole(originalConsole);
    if (previousJAdapterMode === undefined) delete process.env['JADAPTER_MODE'];
    else process.env['JADAPTER_MODE'] = previousJAdapterMode;
    if (previousAnvilRpc === undefined) delete process.env['ANVIL_RPC'];
    else process.env['ANVIL_RPC'] = previousAnvilRpc;
    if (previousForceFreshAnvil === undefined) delete process.env['XLN_FORCE_FRESH_ANVIL'];
    else process.env['XLN_FORCE_FRESH_ANVIL'] = previousForceFreshAnvil;
    const cleanupTargets = new Set<Env>();
    if (env) cleanupTargets.add(env);
    if (activeEnv) cleanupTargets.add(activeEnv);
    for (const targetEnv of cleanupTargets) {
      await cleanupScenarioEnv(targetEnv);
    }
    restoreConsole(originalConsole);
  }
};

async function verifyScenarioDeterminism(scenario: ScenarioEntry, scenarioIndex: number): Promise<ScenarioResult> {
  const runs: ScenarioOracle[] = [];
  try {
    for (let runIndex = 0; runIndex < RUNS; runIndex += 1) {
      const oracle = await runScenarioOnce(scenario, runIndex + 1, scenarioIndex);
      runs.push(oracle);
      console.log(
        `  ${scenario.key} run ${runIndex + 1}/${RUNS}: frames=${oracle.frameCount} hash=${oracle.combinedHash.slice(0, 12)}`,
      );
    }
    assertMatchingOracles(scenario, runs);
    return { key: scenario.key, name: scenario.name, success: true, runs };
  } catch (error) {
    return {
      key: scenario.key,
      name: scenario.name,
      success: false,
      runs,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

const scenariosToRun = (): ScenarioEntry[] =>
  scenarioRegistry.filter((scenario) => {
    if (scenario.requiresStress || EXCLUDED_SCENARIOS.has(scenario.key)) return false;
    const requested = requestedScenarioKeys();
    return requested.size === 0 || requested.has(scenario.key);
  });

export async function runDeterminismTests(): Promise<void> {
  console.log('== Scenario determinism oracle ==');
  console.log(`seed=${SEED} runs=${RUNS}`);
  console.log(`rpcBasePort=${RPC_BASE_PORT} freshAnvil=1`);
  const requested = requestedScenarioKeys();
  if (requested.size > 0) console.log(`filter=${Array.from(requested).join(',')}`);

  const results: ScenarioResult[] = [];
  const scenarios = scenariosToRun();
  for (let scenarioIndex = 0; scenarioIndex < scenarios.length; scenarioIndex += 1) {
    const scenario = scenarios[scenarioIndex];
    if (!scenario) throw new Error(`Scenario registry lookup failed at index ${scenarioIndex}`);
    console.log(`\n[${scenario.key}] ${scenario.name}`);
    results.push(await verifyScenarioDeterminism(scenario, scenarioIndex));
  }

  const failed = results.filter((result) => !result.success);
  console.log('\n== Summary ==');
  for (const result of results) {
    const status = result.success ? 'PASS' : 'FAIL';
    const frameCount = result.runs[0]?.frameCount ?? 0;
    const hash = result.runs[0]?.combinedHash.slice(0, 12) ?? 'no-hash';
    console.log(`${status} ${result.key}: frames=${frameCount} hash=${hash}`);
    if (!result.success && result.error) {
      console.log(`  error=${result.error}`);
    }
  }

  if (failed.length > 0) {
    throw new Error(`Determinism oracle failed for ${failed.map((result) => result.key).join(', ')}`);
  }
}

if (import.meta.main) {
  await runDeterminismTests();
}
