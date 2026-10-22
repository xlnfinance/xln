/** Record each live scenario once, then replay its immutable checkpoint/WAL through TS W1 and W4. */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { RuntimeReplica } from '../../runtime/types';
import { getLiveJAdapterEntries } from '../../runtime/j-submit/live-jadapters';
import { clearSignerKeys } from '../../account/crypto';
import { createGossipLayer } from '../../network/p2p/gossip';
import { formatRuntime } from '../../qa/runtime-ascii';
import { safeStringify } from '../../protocol/serialization';
import { registerStructuredLogSink } from '../../support/logger';
import { computeCanonicalStateHashFromEnv } from '../../storage/canonical-hash';
import { buildRuntimeRecoveryCheckpointSnapshot } from '../../storage/wal/snapshot';
import type { RuntimeRecording } from '../../storage/recovery/bundle/types';
import { scenarioRegistry, type ScenarioEntry } from '..';
import { assertRuntimeIdle, commitRuntimeInput } from '../harness/helpers';
import { createCheckpointBarrierRuntimeTx } from '../../runtime/checkpoint/barrier';
import { stopManagedScenarioAnvil } from '../harness/boot';
import { assertRecordedReplaysMatch, recordedEvidenceHash, replayRecordedScenario } from './recorded-replay';

const SEED = 'determinism-test-seed-42';
const RPC_BASE_PORT = Math.floor(
  Number(process.env['XLN_DETERMINISM_RPC_BASE_PORT'] ?? 29_000 + (process.pid % 1_000) * 20),
);
const EXCLUDED_SCENARIOS = new Set([
  'ahb', // triangle demo does not drain under the RPC determinism harness
  'grid', // visual scalability demo; not a consensus correctness oracle
  'rapid-fire', // explicitly stress-only in the registry
]);
const requestedScenarioKeys = (): Set<string> =>
  new Set(
    (process.env['XLN_DETERMINISM_SCENARIOS'] ?? '')
      .split(',')
      .map(key => key.trim())
      .filter(Boolean),
  );

const cleanupScenarioEnv = async (env: RuntimeReplica): Promise<void> => {
  const { closeRuntimeDb, closeInfraDb, stopRuntimeLoopAndWait } = await import('../../runtime');
  await stopRuntimeLoopAndWait(env, 5_000);
  for (const { adapter } of getLiveJAdapterEntries(env)) await adapter.close();
  await closeRuntimeDb(env);
  await closeInfraDb(env);
};

const recordScenario = async (
  scenario: ScenarioEntry,
  scenarioIndex: number,
  evidenceDirectory: string,
): Promise<{ recording: RuntimeRecording; finalHash: string; runtimeSeed: string }> => {
  const {
    createEmptyEnv,
    buildPersistedRuntimeRecording,
    readPersistedCheckpointSnapshot,
    readPersistedFrameJournals,
    readPersistedFrameJournal,
    waitForRuntimeWorkDrained,
  } = await import('../../runtime');
  const originalConsole = {
    log: console.log,
    info: console.info,
    warn: console.warn,
    debug: console.debug,
    error: console.error,
  };
  const previous = {
    JADAPTER_MODE: process.env['JADAPTER_MODE'],
    ANVIL_RPC: process.env['ANVIL_RPC'],
    XLN_FORCE_FRESH_ANVIL: process.env['XLN_FORCE_FRESH_ANVIL'],
  };
  Object.assign(process.env, {
    JADAPTER_MODE: 'rpc',
    ANVIL_RPC: `http://127.0.0.1:${RPC_BASE_PORT + scenarioIndex}`,
    XLN_FORCE_FRESH_ANVIL: '1',
  });
  clearSignerKeys(SEED);
  const env = createEmptyEnv(SEED);
  let activeEnv = env;
  env.gossip = createGossipLayer();
  env.scenarioMode = true;
  env.quietRuntimeLogs = process.env['XLN_DETERMINISM_VERBOSE'] !== '1';
  env.scenarioLogLevel = env.quietRuntimeLogs ? 'error' : 'debug';
  env.state.timestamp = 1;
  env.runtimeConfig = { ...env.runtimeConfig, storage: { ...env.runtimeConfig?.storage, enabled: true } };
  if (env.infrastructure) env.infrastructure.persistencePaused = false;
  const submitObservations: unknown[] = [];
  const stopObservations = registerStructuredLogSink(event => {
    if (event.scope === 'runtime.jsubmit') submitObservations.push(event);
  });
  try {
    const run = (await scenario.load()) as (target: RuntimeReplica) => Promise<RuntimeReplica | void>;
    activeEnv = (await run(env)) ?? env;
    if (!(await waitForRuntimeWorkDrained(activeEnv, 5_000))) throw new Error('DETERMINISM_RECORDING_DRAIN_TIMEOUT');
    assertRuntimeIdle(activeEnv, scenario.name);
    // Idle scenario polls can advance the controlled clock without a commit.
    // Seal only that outstanding input. Already durable scenarios need no new
    // frame (which could legitimately wake an unrelated scheduled deadline).
    const tip = await readPersistedFrameJournal(activeEnv, activeEnv.state.height);
    if (!tip) throw new Error('DETERMINISM_LIVE_TIP_MISSING');
    if (tip.timestamp !== activeEnv.state.timestamp) {
      await commitRuntimeInput(activeEnv, { runtimeTxs: [createCheckpointBarrierRuntimeTx()], entityInputs: [] });
      assertRuntimeIdle(activeEnv, `${scenario.name} recording barrier`);
    }
    writeFileSync(
      join(evidenceDirectory, 'live-final.json'),
      safeStringify(buildRuntimeRecoveryCheckpointSnapshot(activeEnv)),
      { mode: 0o600 },
    );
    if (!activeEnv.runtimeId || !activeEnv.runtimeSeed) throw new Error('DETERMINISM_RUNTIME_IDENTITY_MISSING');
    // Preserve the actual accepted inputs before export performs its own verified
    // replay. An export failure must leave enough evidence to reproduce its first frame.
    const checkpoint = await readPersistedCheckpointSnapshot(activeEnv, 1);
    if (!checkpoint) throw new Error('DETERMINISM_INITIAL_CHECKPOINT_MISSING');
    const frames = await readPersistedFrameJournals(activeEnv, {
      fromHeight: 2,
      toHeight: activeEnv.state.height,
      limit: activeEnv.state.height,
    });
    if (frames.length !== activeEnv.state.height - 1) throw new Error('DETERMINISM_INITIAL_WAL_INCOMPLETE');
    writeFileSync(join(evidenceDirectory, 'accepted-wal.json'), safeStringify({ checkpoint, frames }), { mode: 0o600 });
    const recording = await buildPersistedRuntimeRecording(activeEnv, {
      signers: [{ index: 0, address: activeEnv.runtimeId, name: scenario.key }],
    });
    if (recording.baseHeight !== 1) throw new Error(`DETERMINISM_INITIAL_PREFIX_MISSING:${recording.baseHeight}`);
    writeFileSync(join(evidenceDirectory, 'recording.json'), safeStringify(recording), { mode: 0o600 });
    return { recording, finalHash: computeCanonicalStateHashFromEnv(activeEnv), runtimeSeed: activeEnv.runtimeSeed };
  } catch (error) {
    writeFileSync(
      join(evidenceDirectory, 'recording-failure.json'),
      safeStringify({
        scenario: scenario.key,
        pendingInput: activeEnv.runtimeMempool,
        actual: buildRuntimeRecoveryCheckpointSnapshot(activeEnv),
        error: error instanceof Error ? error.message : String(error),
      }),
      { mode: 0o600 },
    );
    writeFileSync(join(evidenceDirectory, 'recording-failure.txt'), formatRuntime(activeEnv), { mode: 0o600 });
    throw error;
  } finally {
    stopObservations();
    Object.assign(console, originalConsole);
    writeFileSync(join(evidenceDirectory, 'submit-observations.json'), safeStringify(submitObservations), {
      mode: 0o600,
    });
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    for (const target of new Set([env, activeEnv])) await cleanupScenarioEnv(target);
    await stopManagedScenarioAnvil();
  }
};

export const selectDeterminismScenarios = (requested: ReadonlySet<string>): ScenarioEntry[] => {
  const unavailable = [...requested].flatMap(key => {
    const scenario = scenarioRegistry.find(entry => entry.key === key);
    if (!scenario) return [`${key}:unknown`];
    if (EXCLUDED_SCENARIOS.has(key)) return [`${key}:excluded`];
    if (scenario.requiresStress) return [`${key}:stress-only`];
    return [];
  });
  if (unavailable.length > 0) {
    throw new Error(`DETERMINISM_REQUESTED_SCENARIO_UNAVAILABLE:${unavailable.join(',')}`);
  }
  const scenarios = scenarioRegistry.filter(
    scenario =>
      !scenario.requiresStress &&
      !EXCLUDED_SCENARIOS.has(scenario.key) &&
      (requested.size === 0 || requested.has(scenario.key)),
  );
  if (scenarios.length === 0) throw new Error('DETERMINISM_SCENARIO_SELECTION_EMPTY');
  return scenarios;
};

export async function runDeterminismTests(resetStorage: () => void): Promise<void> {
  const scenarios = selectDeterminismScenarios(requestedScenarioKeys());
  const root = resolve(process.env['XLN_DETERMINISM_ARTIFACT_DIR'] ?? `.logs/determinism/${Date.now()}-${process.pid}`);
  console.log(`== Immutable scenario WAL replay: seed=${SEED} workers=1,4 artifacts=${root} ==`);
  const results = [];
  for (const [index, scenario] of scenarios.entries()) {
    const directory = join(root, scenario.key);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    resetStorage();
    console.log(`[${scenario.key}] recording live RPC scenario`);
    const { recording, finalHash, runtimeSeed } = await recordScenario(scenario, index, directory);
    const w1 = await replayRecordedScenario(recording, runtimeSeed, 1, directory);
    const w4 = await replayRecordedScenario(recording, runtimeSeed, 4, directory);
    assertRecordedReplaysMatch(w1, w4, directory);
    if (w1.at(-1)?.stateHash !== finalHash || w4.at(-1)?.stateHash !== finalHash) {
      throw new Error(`DETERMINISM_LIVE_FINAL_HASH_MISMATCH:${scenario.key}`);
    }
    const result = {
      scenario: scenario.key,
      baseHeight: recording.baseHeight,
      targetHeight: recording.targetHeight,
      frames: w1.length,
      workers: [1, 4],
      finalHash,
      evidenceHash: recordedEvidenceHash(w1),
      recordingManifestHash: recording.manifestHash,
    };
    writeFileSync(join(directory, 'result.json'), safeStringify(result, 2));
    results.push(result);
    console.log(`PASS ${scenario.key}: frames=${w1.length} workers=1,4 hash=${finalHash}`);
  }
  writeFileSync(join(root, 'results.json'), safeStringify(results, 2));
  console.log(`Immutable WAL replay passed ${results.length}/${scenarios.length} scenarios`);
}
