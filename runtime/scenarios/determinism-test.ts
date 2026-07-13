/**
 * Scenario determinism oracle.
 *
 * Runs each deterministic scenario multiple times with the same runtime seed and
 * compares the complete runtime history hash sequence plus final state hash.
 */

import type { Env } from '../types';
import { createHash } from 'node:crypto';
import { safeStringify } from '../protocol/serialization';
import { clearSignerKeys } from '../account/crypto';
import { createGossipLayer } from '../networking/gossip';
import { scenarioRegistry, type ScenarioEntry } from './index';
import { assertRuntimeIdle } from './helpers';
import { setEntityFrameHashDebugRecorder, type EntityFrameHashDebugRecord } from '../entity/consensus/frame';
import { stopManagedScenarioAnvil } from './boot';
import { buildCanonicalJReplicaSnapshot } from '../wal/snapshot';
import {
  setAccountStateRootDebugRecorder,
  type AccountStateRootDebugRecord,
} from '../account/state-root';
import {
  setJEventIngressTransform,
  setJHistoryCheckpointIngressTransform,
  type JEventIngressBatch,
  type JHistoryCheckpointIngress,
  type RawJEvent,
} from '../jadapter/watcher';

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
  accountStateRootTrace: unknown[];
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

type JEventTraceMode = 'record' | 'replay';

type JEventTrace = {
  batches: JEventIngressBatch[];
  cursor: number;
  checkpoints: JHistoryCheckpointIngress[];
  checkpointCursor: number;
};

const cloneJEventTraceValue = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(cloneJEventTraceValue);
  if (value instanceof Uint8Array) return value.slice();
  if (value instanceof Map) {
    return new Map(Array.from(value.entries()).map(([key, entry]) => [
      cloneJEventTraceValue(key),
      cloneJEventTraceValue(entry),
    ]));
  }
  if (value instanceof Set) return new Set(Array.from(value.values()).map(cloneJEventTraceValue));
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
    key,
    cloneJEventTraceValue(entry),
  ]));
};

const cloneJEventIngressBatch = (batch: JEventIngressBatch): JEventIngressBatch =>
  cloneJEventTraceValue(batch) as JEventIngressBatch;

const cloneJHistoryCheckpointIngress = (
  checkpoint: JHistoryCheckpointIngress,
): JHistoryCheckpointIngress => cloneJEventTraceValue(checkpoint) as JHistoryCheckpointIngress;

const jEventSemanticProjection = (events: RawJEvent[]): unknown => toDebugTraceValue(
  events.map((event) => ({
    name: event.name,
    args: event.args,
    ...(event.disputeFinalizationEvidence
      ? { disputeFinalizationEvidence: event.disputeFinalizationEvidence }
      : {}),
  })),
);

const createJEventTraceTransform = (
  mode: JEventTraceMode,
  trace: JEventTrace,
): ((batch: JEventIngressBatch) => JEventIngressBatch) => (batch) => {
  if (mode === 'record') {
    trace.batches.push(cloneJEventIngressBatch(batch));
    return batch;
  }

  const expected = trace.batches[trace.cursor];
  if (!expected) {
    throw new Error(`J_EVENT_TRACE_UNEXPECTED_BATCH:index=${trace.cursor}`);
  }
  const expectedSemantics = jEventSemanticProjection(expected.rawEvents);
  const actualSemantics = jEventSemanticProjection(batch.rawEvents);
  const semanticDiff = findFirstDiff(expectedSemantics, actualSemantics);
  if (semanticDiff) {
    throw new Error(
      `J_EVENT_TRACE_SEMANTIC_MISMATCH:index=${trace.cursor} path=${semanticDiff.path} ` +
      `expected=${previewValue(semanticDiff.left)} actual=${previewValue(semanticDiff.right)}`,
    );
  }
  trace.cursor += 1;
  return cloneJEventIngressBatch(expected);
};

const createJHistoryCheckpointTraceTransform = (
  mode: JEventTraceMode,
  trace: JEventTrace,
): ((checkpoint: JHistoryCheckpointIngress) => JHistoryCheckpointIngress) => (checkpoint) => {
  if (mode === 'record') {
    trace.checkpoints.push(cloneJHistoryCheckpointIngress(checkpoint));
    return checkpoint;
  }

  const expected = trace.checkpoints[trace.checkpointCursor];
  if (!expected) {
    throw new Error(`J_CHECKPOINT_TRACE_UNEXPECTED:index=${trace.checkpointCursor}`);
  }
  if (checkpoint.scannedThroughHeight !== expected.scannedThroughHeight) {
    throw new Error(
      `J_CHECKPOINT_TRACE_HEIGHT_MISMATCH:index=${trace.checkpointCursor} ` +
      `expected=${expected.scannedThroughHeight} actual=${checkpoint.scannedThroughHeight}`,
    );
  }
  trace.checkpointCursor += 1;
  return cloneJHistoryCheckpointIngress(expected);
};

const normalizeOracleValue = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(normalizeOracleValue);
  if (typeof value === 'string') {
    return value.replace(/https?:\/\/(?:127\.0\.0\.1|localhost):\d+/g, 'http://<local-rpc>');
  }
  if (value === null || typeof value !== 'object') return value;

  const source = value as Record<string, unknown>;
  const normalized: Record<string, unknown> = {};
  for (const key of Object.keys(source)) normalized[key] = normalizeOracleValue(source[key]);
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
    projected.set(key, buildCanonicalJReplicaSnapshot(replica));
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

const buildOracle = (
  env: Env,
  frameHashRecords: EntityFrameHashDebugRecord[],
  accountStateRootRecords: AccountStateRootDebugRecord[],
): ScenarioOracle => {
  const frameValues = (env.history ?? []).map((snapshot) => toOracleValue(snapshotProjection(snapshot)));
  const frameHashes = frameValues.map((snapshot) => hashOracleValue(snapshot, 24));
  const frameHashTrace = buildFrameHashTrace(frameHashRecords);
  const accountStateRootTrace = accountStateRootRecords.map((record) => toDebugTraceValue(record));
  const finalValue = toOracleValue(snapshotEnvProjection(env));
  const finalHash = hashOracleValue(finalValue, 32);
  const frameCount = frameHashes.length;
  const combinedHash = hashOracleValue(toOracleValue({ frameCount, frameHashes, finalHash }), 32);
  return { frameCount, frameHashes, frameValues, frameHashTrace, accountStateRootTrace, finalValue, finalHash, combinedHash };
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

const DERIVED_DEBUG_FIELDS = new Set([
  'accountStateRoot',
  'counterpartyDisputeHanko',
  'counterpartyFrameHanko',
  'disputeHash',
  'hanko',
  'hankoWitness',
  'leftHanko',
  'prevFrameHash',
  'proofbodyHash',
  'rightHanko',
  'signature',
  'stateHash',
]);

const stripDerivedEvidenceForDebug = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(stripDerivedEvidenceForDebug);
  if (value === null || typeof value !== 'object') return value;
  const source = value as Record<string, unknown>;
  return Object.fromEntries(Object.entries(source).map(([key, entry]) => [
    key,
    DERIVED_DEBUG_FIELDS.has(key) || key.toLowerCase().endsWith('hanko')
      ? '<derived-evidence>'
      : stripDerivedEvidenceForDebug(entry),
  ]));
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
    const accountRootTraceDiff = findFirstDiff(expected.accountStateRootTrace, actual.accountStateRootTrace);
    const accountRootTraceText = accountRootTraceDiff
      ? ` accountRootInputDiff=${accountRootTraceDiff.path} left=${previewValue(accountRootTraceDiff.left)} right=${previewValue(accountRootTraceDiff.right)}`
      : '';
    const finalDiff = findFirstDiff(expected.finalValue, actual.finalValue);
    const finalDiffText = finalDiff
      ? ` finalDiff=${finalDiff.path} left=${previewValue(finalDiff.left)} right=${previewValue(finalDiff.right)}`
      : '';
    const finalStateDiff = findFirstDiff(
      stripDerivedEvidenceForDebug(expected.finalValue),
      stripDerivedEvidenceForDebug(actual.finalValue),
    );
    const finalStateDiffText = finalStateDiff
      ? ` finalStateDiff=${finalStateDiff.path} left=${previewValue(finalStateDiff.left)} right=${previewValue(finalStateDiff.right)}`
      : '';
    throw new Error(
      `${scenario.key}: non-deterministic replay between run 1 and run ${index + 2}: ${mismatch}${diffText}${traceText}${accountRootTraceText}${finalDiffText}${finalStateDiffText}`,
    );
  }
};

const cleanupScenarioEnv = async (env: Env): Promise<void> => {
  const { closeRuntimeDb, closeInfraDb, stopRuntimeLoopAndWait } = await import('../runtime');
  await stopRuntimeLoopAndWait(env, 5_000);

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

  await closeRuntimeDb(env);
  await closeInfraDb(env);
};

const rpcUrlForScenarioRun = (scenarioIndex: number, runIndex: number): string =>
  `http://127.0.0.1:${RPC_BASE_PORT + scenarioIndex * RUNS + runIndex - 1}`;

const runScenarioOnce = async (
  scenario: ScenarioEntry,
  runIndex: number,
  scenarioIndex: number,
  jEventTraceMode: JEventTraceMode,
  jEventTrace: JEventTrace,
): Promise<ScenarioOracle> => {
  const { createEmptyEnv } = await import('../runtime');
  const originalConsole = captureConsole();
  const previousJAdapterMode = process.env['JADAPTER_MODE'];
  const previousAnvilRpc = process.env['ANVIL_RPC'];
  const previousForceFreshAnvil = process.env['XLN_FORCE_FRESH_ANVIL'];
  let env: Env | null = null;
  let activeEnv: Env | null = null;
  const frameHashRecords: EntityFrameHashDebugRecord[] = [];
  const accountStateRootRecords: AccountStateRootDebugRecord[] = [];
  const restoreFrameHashRecorder = setEntityFrameHashDebugRecorder((record) => {
    frameHashRecords.push(record);
  });
  const restoreAccountStateRootRecorder = setAccountStateRootDebugRecorder((record) => {
    accountStateRootRecords.push(record);
  });
  const restoreJEventIngressTransform = setJEventIngressTransform(
    createJEventTraceTransform(jEventTraceMode, jEventTrace),
  );
  const restoreJHistoryCheckpointIngressTransform = setJHistoryCheckpointIngressTransform(
    createJHistoryCheckpointTraceTransform(jEventTraceMode, jEventTrace),
  );
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
    if (jEventTraceMode === 'replay' && jEventTrace.cursor !== jEventTrace.batches.length) {
      throw new Error(
        `J_EVENT_TRACE_INCOMPLETE:consumed=${jEventTrace.cursor} total=${jEventTrace.batches.length}`,
      );
    }
    if (
      jEventTraceMode === 'replay' &&
      jEventTrace.checkpointCursor !== jEventTrace.checkpoints.length
    ) {
      throw new Error(
        `J_CHECKPOINT_TRACE_INCOMPLETE:consumed=${jEventTrace.checkpointCursor} ` +
        `total=${jEventTrace.checkpoints.length}`,
      );
    }
    return buildOracle(activeEnv, frameHashRecords, accountStateRootRecords);
  } finally {
    restoreFrameHashRecorder();
    restoreAccountStateRootRecorder();
    restoreJEventIngressTransform();
    restoreJHistoryCheckpointIngressTransform();
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
    await stopManagedScenarioAnvil();
    restoreConsole(originalConsole);
  }
};

async function verifyScenarioDeterminism(scenario: ScenarioEntry, scenarioIndex: number): Promise<ScenarioResult> {
  const runs: ScenarioOracle[] = [];
  const jEventTrace: JEventTrace = { batches: [], cursor: 0, checkpoints: [], checkpointCursor: 0 };
  try {
    for (let runIndex = 0; runIndex < RUNS; runIndex += 1) {
      jEventTrace.cursor = 0;
      jEventTrace.checkpointCursor = 0;
      const oracle = await runScenarioOnce(
        scenario,
        runIndex + 1,
        scenarioIndex,
        runIndex === 0 ? 'record' : 'replay',
        jEventTrace,
      );
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
