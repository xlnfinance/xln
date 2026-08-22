#!/usr/bin/env bun

/** Replay phase: restore one H1 checkpoint and deterministically execute its WAL tail. */

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { deriveSignerAddressSync, prewarmSignerLabels } from '../../../../account/crypto';
import { deriveMeshChildSeed } from '../../../../orchestrator/mesh/mesh-seeds';
import { safeStringify } from '../../../../protocol/serialization';
import {
  BOUNDARY_AUDIT_ENABLED,
  diffOpCounters,
  dumpOpCounters,
  installGlobalOpCounters,
  snapshotOpCounters,
  type OpCounterSnapshot,
} from '../../../../support/performance/op-counters';
import {
  dumpRuntimeSamplingProfile,
  startRuntimeSamplingProfiler,
} from '../../../../support/performance/sampling-profiler';
import {
  resetPerfPhases,
  snapshotPerfPhases,
} from '../../../../support/performance/profile';
import {
  closeInfraDb,
  closeRuntimeDb,
  replayRecoveryFrameJournals,
  restoreEnvFromRecoveryBundles,
} from '../../../../runtime';
import type { RuntimeRecoveryBundleV1 } from '../../../../storage/recovery/bundle/types';
import type { PersistedFrameJournal } from '../../../../storage/types';
import { countEntityInputTxKinds } from '../../../../runtime/frame/process-profile';
import { readHltHubRecording } from './recording';
import { summarizePaymentWork } from './payment-work-ledger';
import { buildEntityProposalReplayOracleMap } from '../../../../entity/consensus/proposal/replay-oracle';

type ReplayMode = 'max' | 'fixed' | 'sweep';

type EconomicCounters = Readonly<{
  deliveredPayments: number;
  matchedEconomicSwaps: number;
}>;

const subtractEconomicCounters = (
  final: EconomicCounters,
  baseline: EconomicCounters,
): EconomicCounters => {
  const deliveredPayments = final.deliveredPayments - baseline.deliveredPayments;
  const matchedEconomicSwaps = final.matchedEconomicSwaps - baseline.matchedEconomicSwaps;
  if (deliveredPayments < 0 || matchedEconomicSwaps < 0) {
    throw new Error(
      `HLT_REPLAY_ECONOMIC_COUNTER_REGRESSION:` +
      `payments=${baseline.deliveredPayments}:${final.deliveredPayments}:` +
      `swaps=${baseline.matchedEconomicSwaps}:${final.matchedEconomicSwaps}`,
    );
  }
  return { deliveredPayments, matchedEconomicSwaps };
};

type ReplayFrameProfile = Readonly<{
  height: number;
  timestamp: number;
  entityInputs: number;
  txKinds: Readonly<Record<string, number>>;
  elapsedMs: number;
  deliveredPayments: number;
  matchedEconomicSwaps: number;
}>;

type ReplayAmplificationTotals = Readonly<{
  canonicalEncodeBytes: number;
  storageEncodeBytes: number;
  sealedEntityFrameBytes: number;
  ecdsaSigns: number;
  ecdsaRecovers: number;
}>;

type ReplayAmplification = Readonly<{
  totals: ReplayAmplificationTotals;
  perRuntimeEntityInput: ReplayAmplificationTotals;
  perDeliveredPayment: ReplayAmplificationTotals | null;
  perMatchedEconomicSwap: ReplayAmplificationTotals | null;
}>;

type ReplayTrial = Readonly<{
  offeredTps: number | null;
  frames: number;
  runtimeEntityInputs: number;
  entityInputsPerFrame: number;
  outboxEnvelopes: number;
  elapsedMs: number;
  cpuMs: number;
  deliveredPayments: number;
  deliveredPaymentTps: number;
  matchedEconomicSwaps: number;
  matchedEconomicSwapTps: number;
  finalHeight: number;
  finalPendingOutbox: number;
  equivalent: true;
  amplification: ReplayAmplification;
  frameProfile?: readonly ReplayFrameProfile[];
  operations: OpCounterSnapshot;
  perf: ReturnType<typeof snapshotPerfPhases>;
}>;

const amplificationTotals = (operations: OpCounterSnapshot): ReplayAmplificationTotals => ({
  canonicalEncodeBytes: operations['canonical.encode']?.bytes ?? 0,
  storageEncodeBytes: operations['storage.encode']?.bytes ?? 0,
  sealedEntityFrameBytes: operations['entity.frame.sealed']?.bytes ?? 0,
  ecdsaSigns: operations['ecdsa.sign']?.calls ?? 0,
  ecdsaRecovers: operations['ecdsa.recover']?.calls ?? 0,
});

const divideAmplification = (
  totals: ReplayAmplificationTotals,
  units: number,
): ReplayAmplificationTotals => ({
  canonicalEncodeBytes: totals.canonicalEncodeBytes / units,
  storageEncodeBytes: totals.storageEncodeBytes / units,
  sealedEntityFrameBytes: totals.sealedEntityFrameBytes / units,
  ecdsaSigns: totals.ecdsaSigns / units,
  ecdsaRecovers: totals.ecdsaRecovers / units,
});

const summarizeReplayAmplification = (
  operations: OpCounterSnapshot,
  runtimeEntityInputs: number,
  deliveredPayments: number,
  matchedEconomicSwaps: number,
): ReplayAmplification => {
  const totals = amplificationTotals(operations);
  if (runtimeEntityInputs < 1) throw new Error('HLT_REPLAY_AMPLIFICATION_INPUTS_MISSING');
  return {
    totals,
    perRuntimeEntityInput: divideAmplification(totals, runtimeEntityInputs),
    perDeliveredPayment: deliveredPayments > 0
      ? divideAmplification(totals, deliveredPayments)
      : null,
    perMatchedEconomicSwap: matchedEconomicSwaps > 0
      ? divideAmplification(totals, matchedEconomicSwaps)
      : null,
  };
};

const optionalArgument = (name: string): string | null => {
  const index = process.argv.indexOf(`--${name}`);
  if (index < 0) return null;
  const value = String(process.argv[index + 1] || '').trim();
  if (!value) throw new Error(`HLT_REPLAY_ARGUMENT_MISSING:${name}`);
  return value;
};

const requiredArgument = (name: string): string => {
  const value = optionalArgument(name);
  if (!value) throw new Error(`HLT_REPLAY_ARGUMENT_MISSING:${name}`);
  return value;
};

const parseMode = (): ReplayMode => {
  const raw = optionalArgument('mode') ?? 'max';
  if (raw !== 'max' && raw !== 'fixed' && raw !== 'sweep') throw new Error(`HLT_REPLAY_MODE_INVALID:${raw}`);
  return raw;
};

const parseRates = (mode: ReplayMode): number[] => {
  if (mode === 'max') return [0];
  const raw = optionalArgument('rates') ?? (mode === 'fixed' ? '1000' : '250,500,750,1000,1500,2000');
  const rates = raw.split(',').map(value => Number(value.trim()));
  if (rates.length < 1 || rates.some(value => !Number.isSafeInteger(value) || value < 1 || value > 100_000)) {
    throw new Error(`HLT_REPLAY_RATES_INVALID:${raw}`);
  }
  return rates;
};

const recordingPath = resolve(requiredArgument('recording'));
const outputPath = resolve(optionalArgument('output') ?? `${recordingPath}.replay.json`);
const mode = parseMode();
const rates = parseRates(mode);
const frameProfileEnabled = process.argv.includes('--frame-profile');
await installGlobalOpCounters('hlt-replay');
const artifact = readHltHubRecording(recordingPath);
const snapshot = artifact.recording.bundles.find(bundle => (bundle.kind ?? 'snapshot') === 'snapshot');
const tail = artifact.recording.bundles.find(bundle => bundle.kind === 'journal_tail');
if (!snapshot || !tail) throw new Error('HLT_REPLAY_RECORDING_BUNDLES_MISSING');
const frames = [...(tail.frames ?? [])];
const seedPath = resolve(optionalArgument('seed-file') ?? `${artifact.source.workDir}/secrets/mesh-root.seed`);
const meshRootSeed = readFileSync(seedPath, 'utf8').trim();
if (!meshRootSeed) throw new Error('HLT_REPLAY_MESH_ROOT_SEED_MISSING');
const runtimeSeed = deriveMeshChildSeed(meshRootSeed, 'runtime:h1');

const prewarmRecordedHubSigners = (
  env: Awaited<ReturnType<typeof restoreEnvFromRecoveryBundles>>,
): void => {
  const requiredSignerIds = new Set(
    Array.from(env.state.eReplicas.values(), replica => replica.signerId.toLowerCase()),
  );
  const baseLabel = 'h1-hub';
  const candidateLabels = [
    baseLabel,
    ...Array.from(env.state.jReplicas.keys(), jurisdiction => `${baseLabel}:${jurisdiction}`),
  ];
  const matchedLabels = candidateLabels.filter(label =>
    requiredSignerIds.has(deriveSignerAddressSync(runtimeSeed, label).toLowerCase()),
  );
  const matchedSignerIds = new Set(
    matchedLabels.map(label => deriveSignerAddressSync(runtimeSeed, label).toLowerCase()),
  );
  const missingSignerIds = Array.from(requiredSignerIds).filter(id => !matchedSignerIds.has(id));
  if (missingSignerIds.length > 0) {
    throw new Error(`HLT_REPLAY_LOCAL_SIGNER_UNRESOLVED:${missingSignerIds.join(',')}`);
  }
  // Replay owns the same sovereign H1 seed as Build. Recover keys only after
  // proving that every derived label binds to an exact checkpoint replica;
  // never persist private keys or guess an unrelated signer during recovery.
  prewarmSignerLabels(runtimeSeed, matchedLabels);
};

const frameUnits = (frame: PersistedFrameJournal): number => {
  return frame.runtimeInput.entityInputs.length;
};

const waitForOfferedRate = async (
  offeredTps: number,
  cumulativeUnits: number,
  startedAt: number,
): Promise<void> => {
  if (offeredTps <= 0 || cumulativeUnits <= 0) return;
  const dueAt = startedAt + cumulativeUnits * 1_000 / offeredTps;
  const remaining = dueAt - performance.now();
  if (remaining > 0) await Bun.sleep(remaining);
};

const readEconomicCounters = (
  env: Awaited<ReturnType<typeof restoreEnvFromRecoveryBundles>>,
): EconomicCounters => [...(env.infrastructure?.entityMetricStats?.values() ?? [])]
  .reduce(
    (total, metrics) => ({
      deliveredPayments: total.deliveredPayments + metrics.completedPayments,
      matchedEconomicSwaps: total.matchedEconomicSwaps + metrics.matchedSwaps,
    }),
    { deliveredPayments: 0, matchedEconomicSwaps: 0 },
  );

const assertReplayTerminalEquivalent = (finalHeight: number): true => {
  if (finalHeight !== artifact.recording.targetHeight) {
    throw new Error(
      `HLT_REPLAY_TERMINAL_HEIGHT_MISMATCH:` +
      `${artifact.recording.targetHeight}:${finalHeight}`,
    );
  }
  const finalFrame = frames.at(-1);
  if (!finalFrame || finalFrame.height !== finalHeight) {
    throw new Error(
      `HLT_REPLAY_TERMINAL_FRAME_MISMATCH:` +
      `${finalHeight}:${String(finalFrame?.height ?? 'missing')}`,
    );
  }
  // replayRecoveryFrameJournals already fails each frame on postStateHash,
  // Runtime-machine state and exact ordered outbox refs. Reaching this terminal
  // boundary proves the complete Build recording, not merely equal counters.
  return true;
};

const runTrial = async (offeredTps: number): Promise<ReplayTrial> => {
  const env = await restoreEnvFromRecoveryBundles([snapshot as RuntimeRecoveryBundleV1], {
    runtimeSeed,
    runtimeId: artifact.recording.runtimeId,
    targetHeight: artifact.recording.baseHeight,
    readOnly: true,
  });
  // Max replay measures the deterministic machine, not terminal rendering.
  // Runtime logs are an envelope-side external effect and are intentionally
  // excluded alongside sockets and durable writes.
  env.quietRuntimeLogs = true;
  if (artifact.entityProposalOracle) {
    if (!env.infrastructure) throw new Error('HLT_REPLAY_INFRASTRUCTURE_MISSING');
    env.infrastructure.replayEntityProposalOracle = buildEntityProposalReplayOracleMap(
      artifact.entityProposalOracle,
    );
  }
  prewarmRecordedHubSigners(env);
  const economicBaseline = readEconomicCounters(env);
  await startRuntimeSamplingProfiler('hlt-replay-tail');
  resetPerfPhases();
  const operationsBefore = snapshotOpCounters();
  const startedAt = performance.now();
  const cpuStarted = process.cpuUsage();
  let cumulativeUnits = 0;
  const frameProfile: ReplayFrameProfile[] = [];
  try {
    if (offeredTps === 0 && !frameProfileEnabled) {
      // Max mode measures the canonical recovery primitive over its native WAL
      // tail shape. Re-entering the public replay boundary for every frame
      // repeatedly toggled replay metadata and revalidated Runtime config; it
      // was harness overhead absent from both restore and live H1 execution.
      await replayRecoveryFrameJournals(env, frames);
    } else {
      for (const frame of frames) {
        cumulativeUnits += frameUnits(frame);
        await waitForOfferedRate(offeredTps, cumulativeUnits, startedAt);
        const economicBefore = readEconomicCounters(env);
        const frameStartedAt = performance.now();
        await replayRecoveryFrameJournals(env, [frame]);
        if (frameProfileEnabled) {
          const economicAfter = readEconomicCounters(env);
          frameProfile.push({
            height: frame.height,
            timestamp: frame.timestamp,
            entityInputs: frame.runtimeInput.entityInputs.length,
            txKinds: countEntityInputTxKinds(frame.runtimeInput.entityInputs).txKinds,
            elapsedMs: performance.now() - frameStartedAt,
            deliveredPayments: economicAfter.deliveredPayments - economicBefore.deliveredPayments,
            matchedEconomicSwaps: economicAfter.matchedEconomicSwaps - economicBefore.matchedEconomicSwaps,
          });
        }
      }
    }
    const elapsedMs = performance.now() - startedAt;
    const cpu = process.cpuUsage(cpuStarted);
    const cpuMs = (cpu.user + cpu.system) / 1_000;
    const seconds = Math.max(elapsedMs / 1_000, Number.EPSILON);
    const economic = subtractEconomicCounters(readEconomicCounters(env), economicBaseline);
    const operations = diffOpCounters(operationsBefore);
    return {
      offeredTps: offeredTps > 0 ? offeredTps : null,
      frames: artifact.totals.runtimeFrames,
      runtimeEntityInputs: artifact.totals.runtimeEntityInputs,
      entityInputsPerFrame: artifact.totals.runtimeEntityInputs / artifact.totals.runtimeFrames,
      outboxEnvelopes: artifact.totals.outboxEnvelopes,
      elapsedMs,
      cpuMs,
      deliveredPayments: economic.deliveredPayments,
      deliveredPaymentTps: economic.deliveredPayments / seconds,
      matchedEconomicSwaps: economic.matchedEconomicSwaps,
      matchedEconomicSwapTps: economic.matchedEconomicSwaps / seconds,
      finalHeight: env.state.height,
      finalPendingOutbox: env.pendingNetworkOutputs?.length ?? 0,
      equivalent: assertReplayTerminalEquivalent(env.state.height),
      amplification: summarizeReplayAmplification(
        operations,
        artifact.totals.runtimeEntityInputs,
        economic.deliveredPayments,
        economic.matchedEconomicSwaps,
      ),
      ...(frameProfileEnabled ? { frameProfile } : {}),
      operations,
      perf: snapshotPerfPhases(),
    };
  } finally {
    await closeRuntimeDb(env);
    await closeInfraDb(env);
  }
};

const trials: ReplayTrial[] = [];
for (const rate of rates) {
  const trial = await runTrial(rate);
  trials.push(trial);
  console.log(
    `HLT_REPLAY_EQUIVALENT offered=${trial.offeredTps ?? 'max'} ` +
    `payments=${trial.deliveredPayments}/${trial.deliveredPaymentTps.toFixed(2)}tps ` +
    `swaps=${trial.matchedEconomicSwaps}/${trial.matchedEconomicSwapTps.toFixed(2)}tps ` +
    `entityInputs=${trial.runtimeEntityInputs}/${trial.entityInputsPerFrame.toFixed(2)}perFrame ` +
    `height=${trial.finalHeight} pendingOutbox=${trial.finalPendingOutbox}`,
  );
}
dumpRuntimeSamplingProfile('complete');

if (BOUNDARY_AUDIT_ENABLED) {
  const forbidden = Object.entries(snapshotOpCounters())
    .filter(([name, counter]) => counter.calls > 0 && [
      'boundary.socket.',
      'boundary.http.',
      'boundary.level.',
      'boundary.timer.',
    ].some(prefix => name.startsWith(prefix)));
  if (forbidden.length > 0) {
    throw new Error(`HLT_REPLAY_EXTERNAL_SIDE_EFFECT:${safeStringify(Object.fromEntries(forbidden))}`);
  }
}

const report = {
  schema: 'xln-hlt-hub-replay-report-v1',
  createdAt: Date.now(),
  recordingPath,
  recordingManifestHash: artifact.recording.manifestHash,
  mode,
  ...(artifact.source.workload === 'payments'
    ? { paymentWork: summarizePaymentWork(frames, trials[0]?.deliveredPayments ?? 0) }
    : {}),
  trials,
};
writeFileSync(outputPath, `${safeStringify(report, 2)}\n`, { mode: 0o600 });
console.log(`HLT_REPLAY_REPORT path=${outputPath}`);
const opCountersPath = dumpOpCounters('hlt-replay', 'complete');
if (opCountersPath) console.log(`HLT_REPLAY_OP_COUNTERS path=${opCountersPath}`);
