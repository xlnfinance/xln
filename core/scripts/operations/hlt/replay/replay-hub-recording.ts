#!/usr/bin/env bun

/** Replay phase: restore one H1 checkpoint and deterministically execute its WAL tail. */

import { startIdleShutdownWatch } from '../../../../support/process/idle-shutdown';
import { printAuthorityRecordReport } from '../../../../rscore/authority-wave';
import {
  accountAuthorityExecutionLedger,
  printAccountAuthorityExecutionLedger,
} from '../../../../rscore/authority/entity-stage';
import { rscoreTransportBytes } from '../../../../rscore/client';
import {
  authorityDriverEnabled,
  printAuthorityDriverReport,
  shutdownAuthorityDriver,
} from '../../../../rscore/authority-driver';
import {
  assertShadowParity,
  currentShadowMirror,
  primeShadowFromRuntimeState,
  shadowStrictEnabled,
} from '../../../../rscore/shadow-hook';
import { configureCryptoPoolEntry } from '../../../../protocol/crypto/crypto-pool';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { deriveSignerAddressSync, prewarmSignerLabels } from '../../../../account/crypto';
import { computeAccountStateRootCold } from '../../../../account/commitment/state-root';
import { computeBookCommitmentHash } from '../../../../orderbook/commitment';
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
import {
  buildStorageLiveReplicaMetaCommitment,
  buildStorageReplicaMetaCommitment,
  inspectStorageReplicaMetaEntries,
} from '../../../../storage/replica/replicas';
import type { RuntimeRecoveryBundleV1 } from '../../../../storage/recovery/bundle/types';
import type { PersistedFrameJournal } from '../../../../storage/types';
import { countEntityInputTxKinds } from '../../../../runtime/frame/process-profile';
import {
  computeEntityAccountDigests,
  computeEntityConsensusSectionDigestsCold,
} from '../../../../entity/consensus/state-root';
import {
  beginRuntimeParityEvidence,
  discardRuntimeParityEvidence,
  finishRuntimeParityEvidence,
} from '../../../../runtime/observability/parity-evidence';
import { readHltHubRecording } from './recording';
import { summarizePaymentWork } from './payment-work-ledger';
import {
  assertCompleteHltAuthorityEvidence,
  type HltLocalContinuationEvidence,
  type HltTsParityExpectations,
} from './authority-evidence';
import {
  buildHltEntityFrameEventEvidenceFromEvents,
  type HltEntityFrameEventEvidence,
} from './entity-frame-event-evidence';
import {
  buildHltEntityEffectEvidence,
  type HltEntityEffectEvidence,
} from './entity-effect-evidence';
import {
  canonicalTsAccountWorkerCount,
  TsAccountWorkerAuthority,
  type TsAccountWorkerTelemetry,
} from '../../../../rscore/ts-worker';

configureCryptoPoolEntry(new URL('../../../../protocol/crypto/crypto-pool.ts', import.meta.url));

type ReplayMode = 'max' | 'fixed' | 'sweep';

type EconomicCounters = Readonly<{
  deliveredPayments: number;
  matchedEconomicSwaps: number;
}>;

/**
 * A replay that stops making progress (a wedged shadow child, a stalled
 * recovery read) used to sit on the machine for hours holding its engine
 * children. Every replayed frame is progress; nothing else counts.
 */
/**
 * How much of the replay the main JS thread was busy, measured by a 1 ms
 * heartbeat that can only tick when the thread is free. Concurrency tricks on
 * the main thread (Promise.all over accounts) can only buy back the idle part,
 * so this number is the ceiling of that whole class of optimization.
 */
const measureBusyFraction = (ticks: number, sampledMs: number, intervalMs: number): number => {
  const expected = sampledMs / intervalMs;
  return expected <= 0 ? 0 : Math.max(0, Math.min(1, 1 - ticks / expected));
};

/**
 * A 1 ms timer cannot tick while the thread is busy, but it also cannot tick
 * at a true 1 ms on an idle Bun process — so the raw figure is only meaningful
 * against this runtime's own idle baseline, measured first and reported with
 * it. What it bounds is narrow: rearranging existing async waits (Promise.all
 * over account inputs) can reclaim at most the idle share. It says nothing
 * about moving synchronous work to workers or to Rust, which is a different
 * optimization entirely.
 */
const startMainThreadBusyProbe = async (): Promise<
  () => { busyFraction: number; idleBaselineFraction: number; sampledMs: number }
> => {
  const intervalMs = 1;
  const baselineMs = 200;
  let baselineTicks = 0;
  const baselineTimer = setInterval(() => { baselineTicks += 1; }, intervalMs);
  const baselineStartedAt = performance.now();
  await Bun.sleep(baselineMs);
  clearInterval(baselineTimer);
  const idleBaselineFraction = measureBusyFraction(
    baselineTicks,
    performance.now() - baselineStartedAt,
    intervalMs,
  );
  const startedAt = performance.now();
  let ticks = 0;
  const timer = setInterval(() => { ticks += 1; }, intervalMs);
  return () => {
    clearInterval(timer);
    const sampledMs = performance.now() - startedAt;
    return {
      busyFraction: measureBusyFraction(ticks, sampledMs, intervalMs),
      idleBaselineFraction,
      sampledMs,
    };
  };
};

const replayIdleWatch = startIdleShutdownWatch('hlt-replay-hub-recording', idleMs => {
  console.error(`HLT_REPLAY_IDLE_EXIT idleMs=${String(idleMs)} pid=${String(process.pid)}`);
  process.exit(1);
});

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
  certifiedEntityFrameBytes: number;
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
  offeredEntityInputsPerSecond: number | null;
  frames: number;
  runtimeEntityInputs: number;
  entityInputsPerFrame: number;
  /** Account-consensus admissions by kind, e.g. `accountInput:ack`. */
  accountInputKinds: Readonly<Record<string, number>>;
  /** Those inputs per wall-clock second, as observed in the recording. */
  accountInputsObservedPerSecond: number;
  /** Share of replay wall time the main JS thread was not free to run a timer. */
  mainThreadBusyFraction: number;
  /** The same measure on an idle process — the probe's own noise floor. */
  mainThreadIdleBaselineFraction: number;
  outboxEnvelopes: number;
  elapsedMs: number;
  cpuMs: number;
  deliveredPayments: number;
  replayPaymentsPerSecond: number;
  matchedEconomicSwaps: number;
  replaySwapsPerSecond: number;
  finalHeight: number;
  finalPendingOutbox: number;
  equivalent: true;
  /** false = per-frame recovery equivalence checks were skipped (pure apply cost). */
  frameVerified: boolean;
  amplification: ReplayAmplification;
  frameProfile?: readonly ReplayFrameProfile[];
  operations: OpCounterSnapshot;
  perf: ReturnType<typeof snapshotPerfPhases>;
  accountWorkerTelemetry?: TsAccountWorkerTelemetry;
  parityExpectations?: Readonly<{
    entityFrameEvents: readonly HltEntityFrameEventEvidence[];
    entityEffects: readonly HltEntityEffectEvidence[];
    localContinuations: readonly HltLocalContinuationEvidence[];
  }>;
}>;

const amplificationTotals = (operations: OpCounterSnapshot): ReplayAmplificationTotals => ({
  canonicalEncodeBytes: operations['canonical.encode']?.bytes ?? 0,
  storageEncodeBytes: operations['storage.encode']?.bytes ?? 0,
  certifiedEntityFrameBytes: operations['entity.frame.certified']?.bytes ?? 0,
  ecdsaSigns: operations['ecdsa.sign']?.calls ?? 0,
  ecdsaRecovers: operations['ecdsa.recover']?.calls ?? 0,
});

const divideAmplification = (
  totals: ReplayAmplificationTotals,
  units: number,
): ReplayAmplificationTotals => ({
  canonicalEncodeBytes: totals.canonicalEncodeBytes / units,
  storageEncodeBytes: totals.storageEncodeBytes / units,
  certifiedEntityFrameBytes: totals.certifiedEntityFrameBytes / units,
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
const diagnosticEventsHeightRaw = optionalArgument('diagnostic-events-height');
const diagnosticEventsHeight = diagnosticEventsHeightRaw === null
  ? null
  : Number(diagnosticEventsHeightRaw);
if (
  diagnosticEventsHeight !== null &&
  (!Number.isSafeInteger(diagnosticEventsHeight) || diagnosticEventsHeight < 1)
) {
  throw new Error(`HLT_REPLAY_DIAGNOSTIC_EVENTS_HEIGHT_INVALID:${diagnosticEventsHeightRaw}`);
}
// Hash-format changes (leaf/preimage encoding) legitimately diverge from the
// recorded frame hashes; terminal equivalence (height, outbox, payments) still holds.
// Pure Hub apply cost: skips per-frame recovery equivalence checks (outbox,
// journal, post-state). The report records verified=false.
const recoveryVerifyEnabled = !process.argv.includes('--no-verify');
const completeAuthorityEvidenceRequired = process.argv.includes('--require-complete-authority-evidence');
const parityEvidence = process.argv.includes('--parity-evidence');
const rustAccountAuthorityRequired = process.argv.includes('--require-rust-account-authority');
const tsAccountWorkersRaw = optionalArgument('ts-account-workers');
const tsAccountWorkers = tsAccountWorkersRaw === null ? null : Number(tsAccountWorkersRaw);
if (tsAccountWorkers !== null && (
  !Number.isSafeInteger(tsAccountWorkers) || tsAccountWorkers < 1 || tsAccountWorkers > 64
)) throw new Error(`HLT_REPLAY_TS_ACCOUNT_WORKERS_INVALID:${tsAccountWorkersRaw}`);
if (tsAccountWorkers !== null && rustAccountAuthorityRequired) {
  throw new Error('HLT_REPLAY_ACCOUNT_AUTHORITY_EXCLUSIVE');
}
if (parityEvidence && (mode !== 'max' || !completeAuthorityEvidenceRequired)) {
  throw new Error('HLT_REPLAY_PARITY_EVIDENCE_REQUIRES_MAX_COMPLETE');
}
await installGlobalOpCounters('hlt-replay');
const artifact = readHltHubRecording(recordingPath);
const replayTsAccountWorkers = tsAccountWorkers ?? (
  authorityDriverEnabled({ runtimeId: artifact.recording.runtimeId })
    ? null
    : canonicalTsAccountWorkerCount()
);
if (completeAuthorityEvidenceRequired) assertCompleteHltAuthorityEvidence(artifact.authorityEvidence);
const snapshot = artifact.recording.bundles.find(bundle => (bundle.kind ?? 'snapshot') === 'snapshot');
const tail = artifact.recording.bundles.find(bundle => bundle.kind === 'journal_tail');
if (!snapshot || !tail) throw new Error('HLT_REPLAY_RECORDING_BUNDLES_MISSING');
const frames = [...(tail.frames ?? [])];
const seedFileArgument = optionalArgument('seed-file');
const runtimeSeedFileArgument = optionalArgument('runtime-seed-file');
if (seedFileArgument && runtimeSeedFileArgument) {
  throw new Error('HLT_REPLAY_SEED_ARGUMENTS_EXCLUSIVE');
}
const runtimeSeed = runtimeSeedFileArgument
  ? (() => {
    const directSeed = readFileSync(resolve(runtimeSeedFileArgument), 'utf8').trim();
    if (!directSeed) throw new Error('HLT_REPLAY_RUNTIME_SEED_MISSING');
    return directSeed;
  })()
  : (() => {
    const seedPath = resolve(seedFileArgument ?? `${artifact.source.workDir}/secrets/mesh-root.seed`);
    const meshRootSeed = readFileSync(seedPath, 'utf8').trim();
    if (!meshRootSeed) throw new Error('HLT_REPLAY_MESH_ROOT_SEED_MISSING');
    return deriveMeshChildSeed(meshRootSeed, 'runtime:h1');
  })();

const entitySignerLabel = optionalArgument('entity-signer-label') ?? 'h1-hub';

const prewarmRecordedHubSigners = (
  env: Awaited<ReturnType<typeof restoreEnvFromRecoveryBundles>>,
): void => {
  const requiredSignerIds = new Set(
    Array.from(env.state.eReplicas.values(), replica => replica.signerId.toLowerCase()),
  );
  const baseLabel = entitySignerLabel;
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
  offeredEntityInputsPerSecond: number,
  cumulativeUnits: number,
  startedAt: number,
): Promise<void> => {
  if (offeredEntityInputsPerSecond <= 0 || cumulativeUnits <= 0) return;
  const dueAt = startedAt + cumulativeUnits * 1_000 / offeredEntityInputsPerSecond;
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

const runTrial = async (offeredEntityInputsPerSecond: number): Promise<ReplayTrial> => {
  const env = await restoreEnvFromRecoveryBundles([snapshot as RuntimeRecoveryBundleV1], {
    runtimeSeed,
    runtimeId: artifact.recording.runtimeId,
    targetHeight: artifact.recording.baseHeight,
    readOnly: true,
  });
  const tsWorkerAuthority = replayTsAccountWorkers === null
    ? null
    : new TsAccountWorkerAuthority(env, replayTsAccountWorkers);
  if (tsWorkerAuthority !== null) {
    env.accountAuthorityExecutionMode = 'cutover';
    env.accountAuthorityEntityStageProvider = tsWorkerAuthority.provider;
  }
  const authoritySelectedForRuntime = authorityDriverEnabled({ runtimeId: env.runtimeId });
  if (rustAccountAuthorityRequired && !authoritySelectedForRuntime) {
    throw new Error('HLT_REPLAY_RSCORE_AUTHORITY_REQUIRED');
  }
  if (authoritySelectedForRuntime && env.accountAuthoritySuppressed === true) {
    throw new Error(
      'HLT_REPLAY_RSCORE_AUTHORITY_REPLAY_REQUIRED:' +
      'set XLN_RSCORE_AUTHORITY_REPLAY=1 to execute Account transitions in Rust',
    );
  }
  // Max replay measures the deterministic machine, not terminal rendering.
  // Runtime logs are an envelope-side external effect and are intentionally
  // excluded alongside sockets and durable writes.
  env.quietRuntimeLogs = true;
  prewarmRecordedHubSigners(env);
  if (shadowStrictEnabled()) await primeShadowFromRuntimeState(env.state);
  const economicBaseline = readEconomicCounters(env);
  await startRuntimeSamplingProfiler('hlt-replay-tail');
  resetPerfPhases();
  const operationsBefore = snapshotOpCounters();
  // Calibrate the event-loop probe before the measured replay window. The
  // fixed 200 ms idle sample is harness setup, not Runtime or Account work;
  // including it made short, dense replays report an arbitrarily low TPS.
  const stopBusyProbe = await startMainThreadBusyProbe();
  const startedAt = performance.now();
  const cpuStarted = process.cpuUsage();
  let cumulativeUnits = 0;
  const frameProfile: ReplayFrameProfile[] = [];
  const entityFrameEvents: HltEntityFrameEventEvidence[] = [];
  const entityEffects: HltEntityEffectEvidence[] = [];
  const localContinuations: HltLocalContinuationEvidence[] = [];
  try {
    if (
      offeredEntityInputsPerSecond === 0 && !frameProfileEnabled &&
      !shadowStrictEnabled() && !parityEvidence && diagnosticEventsHeight === null
    ) {
      // Max mode measures the canonical recovery primitive over its native WAL
      // tail shape. Re-entering the public replay boundary for every frame
      // repeatedly toggled replay metadata and revalidated Runtime config; it
      // was harness overhead absent from both restore and live H1 execution.
      await replayRecoveryFrameJournals(env, frames, { verify: recoveryVerifyEnabled });
    } else {
      for (const frame of frames) {
        replayIdleWatch.noteActivity();
        cumulativeUnits += frameUnits(frame);
        await waitForOfferedRate(offeredEntityInputsPerSecond, cumulativeUnits, startedAt);
        const economicBefore = readEconomicCounters(env);
        const frameStartedAt = performance.now();
        if (parityEvidence) beginRuntimeParityEvidence(env);
        try {
          await replayRecoveryFrameJournals(env, [frame], { verify: recoveryVerifyEnabled });
          if (parityEvidence) {
            const capture = finishRuntimeParityEvidence(env);
            entityFrameEvents.push(buildHltEntityFrameEventEvidenceFromEvents(
              frame.height,
              capture.entityFrameEvents,
            ));
            entityEffects.push(buildHltEntityEffectEvidence(
              frame.height,
              capture.entityEffectLogs,
            ));
            localContinuations.push({
              runtimeHeight: frame.height,
              inputs: capture.localContinuations,
            });
          }
        } catch (error) {
          if (parityEvidence) discardRuntimeParityEvidence(env);
          throw error;
        }
        if (frame.height === diagnosticEventsHeight) {
          const replicaMetaCommitment = buildStorageLiveReplicaMetaCommitment(env);
          const checkpointReplicaMetaCommitment = buildStorageReplicaMetaCommitment(env);
          console.error(`HLT_REPLAY_ENTITY_EVENTS:${frame.height}:${safeStringify(
            {
              replicaMetaDigest: replicaMetaCommitment.digest,
              replicaMetaEntries: inspectStorageReplicaMetaEntries(replicaMetaCommitment.entries),
              checkpointReplicaMetaDigest: checkpointReplicaMetaCommitment.digest,
              checkpointReplicaMetaEntries: inspectStorageReplicaMetaEntries(
                checkpointReplicaMetaCommitment.entries,
              ),
              entities: Array.from(env.state.eReplicas.entries(), ([replicaKey, replica]) => ({
                replicaKey,
                entityHeight: replica.state.height,
                events: replica.certifiedFrameHead?.frame.events ?? [],
                sectionDigests: computeEntityConsensusSectionDigestsCold(replica.state),
                crontabState: replica.state.crontabState,
                crontabHooks: Array.from(replica.state.crontabState?.hooks.entries() ?? []),
                jBatchState: replica.state.jBatchState,
                accountDigests: computeEntityAccountDigests(replica.state),
                accountFrameRootDrift: Array.from(
                  replica.state.accounts.entries(),
                  ([counterpartyId, account]) => {
                    const liveRoot = computeAccountStateRootCold(account.state);
                    const frameRoot = account.currentFrame?.accountStateRoot ?? null;
                    return frameRoot === null || frameRoot === liveRoot ? null : {
                      counterpartyId,
                      currentHeight: account.currentHeight,
                      frameRoot,
                      liveRoot,
                      jNonce: account.state.jNonce,
                      lastFinalizedJHeight: account.state.lastFinalizedJHeight,
                      status: account.status,
                      hasActiveDispute: account.activeDispute !== undefined,
                    };
                  },
                ).filter(value => value !== null),
                orderbookBooks: Array.from(
                  replica.state.orderbookExt?.books.entries() ?? [],
                  ([pairId, book]) => ({
                    pairId,
                    digest: computeBookCommitmentHash(book),
                    params: book.params,
                    bidPagesRoot: book.bidPages.rootHash(),
                    askPagesRoot: book.askPages.rootHash(),
                    nextSeq: book.nextSeq,
                    tradeCount: book.tradeCount,
                    tradeQtySum: book.tradeQtySum,
                    lastTradePriceTicks: book.lastTradePriceTicks,
                    lastAcceptedUsdAskPriceTicks: book.lastAcceptedUsdAskPriceTicks,
                    eventHash: book.eventHash,
                  }),
                ),
              })),
            },
          )}`);
        }
        // Strict shadow: both engines have now consumed the same Runtime frame,
        // so their account trees must be identical before the next one starts.
        if (shadowStrictEnabled()) await assertShadowParity(`r-frame:${frame.height}`, env.state);
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
    const mainThread = stopBusyProbe();
    const elapsedMs = performance.now() - startedAt;
    // Account-consensus inputs the hub had to take in per second: every ack and
    // every proposal the recording carried. Counted as observed, not as
    // admitted — a rejected, duplicate or replayed input counts the same as one
    // that changed state, so this measures offered consensus traffic and never
    // replaces delivered pay/s as the authoritative outcome.
    const admission = countEntityInputTxKinds(frames.flatMap(frame => frame.runtimeInput.entityInputs)).txKinds;
    const cpu = process.cpuUsage(cpuStarted);
    const cpuMs = (cpu.user + cpu.system) / 1_000;
    const seconds = Math.max(elapsedMs / 1_000, Number.EPSILON);
    const economic = subtractEconomicCounters(readEconomicCounters(env), economicBaseline);
    const authorityExecution = accountAuthorityExecutionLedger();
    if (
      authoritySelectedForRuntime
      && economic.deliveredPayments + economic.matchedEconomicSwaps > 0
      && authorityExecution.authoritativeOperations === 0
    ) {
      throw new Error('HLT_REPLAY_RSCORE_UNARMED_ZERO_AUTHORITY_OPERATIONS');
    }
    if (
      rustAccountAuthorityRequired &&
      (authorityExecution.authoritativeOperations < 1 ||
        authorityExecution.typescriptApplyAccountInput !== 0 ||
        authorityExecution.typescriptProposeAccountFrame !== 0)
    ) {
      throw new Error(
        `HLT_REPLAY_RSCORE_NOT_EXCLUSIVE:${safeStringify(authorityExecution)}`,
      );
    }
    if (
      tsWorkerAuthority !== null
      && (authorityExecution.authoritativeOperations < 1
        || authorityExecution.typescriptApplyAccountInput !== 0
        || authorityExecution.typescriptProposeAccountFrame !== 0)
    ) {
      throw new Error(
        `HLT_REPLAY_TS_WORKER_NOT_EXCLUSIVE:${safeStringify(authorityExecution)}`,
      );
    }
    const operations = diffOpCounters(operationsBefore);
    const accountWorkerTelemetry = await tsWorkerAuthority?.telemetry();
    return {
      offeredEntityInputsPerSecond: offeredEntityInputsPerSecond > 0 ? offeredEntityInputsPerSecond : null,
      frames: artifact.totals.runtimeFrames,
      runtimeEntityInputs: artifact.totals.runtimeEntityInputs,
      entityInputsPerFrame: artifact.totals.runtimeEntityInputs / artifact.totals.runtimeFrames,
      accountInputKinds: admission,
      mainThreadBusyFraction: mainThread.busyFraction,
      mainThreadIdleBaselineFraction: mainThread.idleBaselineFraction,
      accountInputsObservedPerSecond: Object.entries(admission)
        .filter(([kind]) => kind.startsWith('accountInput:'))
        .reduce((total, [, count]) => total + count, 0) / Math.max(elapsedMs / 1_000, Number.EPSILON),
      outboxEnvelopes: artifact.totals.outboxEnvelopes,
      elapsedMs,
      cpuMs,
      deliveredPayments: economic.deliveredPayments,
      replayPaymentsPerSecond: economic.deliveredPayments / seconds,
      matchedEconomicSwaps: economic.matchedEconomicSwaps,
      replaySwapsPerSecond: economic.matchedEconomicSwaps / seconds,
      finalHeight: env.state.height,
      finalPendingOutbox: env.pendingNetworkOutputs?.length ?? 0,
      equivalent: assertReplayTerminalEquivalent(env.state.height),
      frameVerified: recoveryVerifyEnabled,
      amplification: summarizeReplayAmplification(
        operations,
        artifact.totals.runtimeEntityInputs,
        economic.deliveredPayments,
        economic.matchedEconomicSwaps,
      ),
      ...(frameProfileEnabled ? { frameProfile } : {}),
      operations,
      perf: snapshotPerfPhases(),
      ...(accountWorkerTelemetry === undefined ? {} : { accountWorkerTelemetry }),
      ...(parityEvidence
        ? { parityExpectations: { entityFrameEvents, entityEffects, localContinuations } }
        : {}),
    };
  } finally {
    await tsWorkerAuthority?.close();
    await closeRuntimeDb(env);
    await closeInfraDb(env);
  }
};

const trials: ReplayTrial[] = [];
for (const rate of rates) {
  const trial = await runTrial(rate);
  trials.push(trial);
  if (parityEvidence) {
    console.log(
      `HLT_REPLAY_PARITY_EQUIVALENT frameVerified=${trial.frameVerified} ` +
      `frames=${trial.frames} entityInputs=${trial.runtimeEntityInputs} ` +
      `payments=${trial.deliveredPayments} swaps=${trial.matchedEconomicSwaps} ` +
      `height=${trial.finalHeight} pendingOutbox=${trial.finalPendingOutbox}`,
    );
  } else {
    console.log(
      `HLT_REPLAY_EQUIVALENT offeredEntityInputsPerSecond=${trial.offeredEntityInputsPerSecond ?? 'max'} ` +
      `frameVerified=${trial.frameVerified} ` +
      `payments=${trial.deliveredPayments}/${trial.replayPaymentsPerSecond.toFixed(2)}pay/s ` +
      `swaps=${trial.matchedEconomicSwaps}/${trial.replaySwapsPerSecond.toFixed(2)}swap/s ` +
      `entityInputs=${trial.runtimeEntityInputs}/${trial.entityInputsPerFrame.toFixed(2)}perFrame ` +
      `mainThreadBusy=${(trial.mainThreadBusyFraction * 100).toFixed(1)}%` +
      `(idleBaseline=${(trial.mainThreadIdleBaselineFraction * 100).toFixed(1)}%) ` +
      `accountInputsObserved=${trial.accountInputsObservedPerSecond.toFixed(1)}/s${
        Object.entries(trial.accountInputKinds)
          .filter(([kind]) => kind.startsWith('accountInput:'))
          .map(([kind, count]) => ` ${kind.slice('accountInput:'.length)}=${String(count)}`)
          .join('')} ` +
      `height=${trial.finalHeight} pendingOutbox=${trial.finalPendingOutbox}`,
    );
  }
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

const parityTrial = (trial: ReplayTrial) => ({
  frames: trial.frames,
  runtimeEntityInputs: trial.runtimeEntityInputs,
  outboxEnvelopes: trial.outboxEnvelopes,
  deliveredPayments: trial.deliveredPayments,
  matchedEconomicSwaps: trial.matchedEconomicSwaps,
  finalHeight: trial.finalHeight,
  finalPendingOutbox: trial.finalPendingOutbox,
  equivalent: trial.equivalent,
  frameVerified: trial.frameVerified,
});

const report = {
  schema: 'xln-hlt-hub-replay-report-v1',
  createdAt: Date.now(),
  recordingPath,
  recordingManifestHash: artifact.recording.manifestHash,
  recordingSourceBinding: artifact.source.binding,
  authorityExpectations: parityEvidence
    ? (() => {
        const captured = trials[0]?.parityExpectations;
        if (!captured) throw new Error('HLT_REPLAY_PARITY_EXPECTATIONS_MISSING');
        return {
          ...artifact.authorityEvidence.expectations,
          entityFrameEvents: captured.entityFrameEvents,
          entityEffects: captured.entityEffects,
          localContinuations: captured.localContinuations,
        } satisfies HltTsParityExpectations;
      })()
    : artifact.authorityEvidence.expectations,
  mode,
  accountAuthority: replayTsAccountWorkers === null
    ? 'rust'
    : `typescript-workers:${replayTsAccountWorkers}`,
  ...(artifact.source.workload === 'payments'
    ? { paymentWork: summarizePaymentWork(frames, trials[0]?.deliveredPayments ?? 0) }
    : {}),
  trials: parityEvidence ? trials.map(parityTrial) : trials,
};
writeFileSync(outputPath, `${safeStringify(report, 2)}\n`, { mode: 0o600 });
console.log(`HLT_REPLAY_REPORT path=${outputPath}`);
printAuthorityRecordReport();
printAuthorityDriverReport();
printAccountAuthorityExecutionLedger();
console.error(`RSCORE_TRANSPORT ${safeStringify(rscoreTransportBytes)}`);
await shutdownAuthorityDriver();
const opCountersPath = dumpOpCounters('hlt-replay', 'complete');
if (opCountersPath) console.log(`HLT_REPLAY_OP_COUNTERS path=${opCountersPath}`);
await currentShadowMirror()?.shutdown();
