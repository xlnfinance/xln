/** HLT selection, cardinality gates, native H1 telemetry and attach-only client. */

import { safeStringify } from '../../../../protocol/serialization';
import type { RuntimeInput } from '../../../../runtime/types';

export const HLT_ENGINES = ['ts', 'rust'] as const;
export const HLT_PROFILES = ['smoke', 'medium', 'heavy'] as const;
export type HltEngine = (typeof HLT_ENGINES)[number];
export type HltProfile = (typeof HLT_PROFILES)[number];

export type HltEngineSelection = Readonly<{ engine: HltEngine; profile: HltProfile }>;

export type HltLivePaymentCounts = Readonly<{
  users: number;
  payments: number;
  offeredPerSecond: number;
  durationSeconds: number;
}>;

export type HltLivePaymentEvidence = 'functional-smoke' | 'tps-authority';

export type RustLiveSameCounts = Readonly<{
  users: number;
  orders: number;
  offeredOrdersPerSecond: number;
  durationSeconds: number;
}>;

export type RustLiveSameEvidence = 'functional-smoke' | 'tps-authority';

/**
 * Live TPS authority (docs/fints/AGENTS): one sovereign H1 run,
 * deliveredPayments/deliveredElapsed. medium = the canonical 1,000 user
 * Runtimes packed 200 per OS process; heavy targets 10,000 active users.
 */
export const HLT_PROFILE_PLAN: Readonly<Record<HltProfile, Readonly<{
  users: number; runtimesPerProcess: number;
}>>> = {
  smoke: { users: 10, runtimesPerProcess: 10 },
  medium: { users: 1_000, runtimesPerProcess: 200 },
  heavy: { users: 10_000, runtimesPerProcess: 200 },
};

const isHltLivePaymentTpsAuthority = (counts: HltLivePaymentCounts): boolean =>
  Number.isSafeInteger(counts.users) &&
  Number.isSafeInteger(counts.payments) &&
  Number.isSafeInteger(counts.offeredPerSecond) &&
  Number.isSafeInteger(counts.durationSeconds) &&
  counts.users >= 1_000 &&
  counts.payments >= 1_000 &&
  counts.offeredPerSecond >= 1_000 &&
  counts.durationSeconds === 20 &&
  counts.payments === counts.offeredPerSecond * counts.durationSeconds;

export const assertHltLivePaymentCardinality = (counts: HltLivePaymentCounts): void => {
  if (
    !isHltLivePaymentTpsAuthority(counts)
  ) {
    throw new Error(
      `HLT_LIVE_PAYMENT_CARDINALITY_TOO_SMALL:users=${counts.users}:` +
      `payments=${counts.payments}:offered=${counts.offeredPerSecond}:` +
      `duration=${counts.durationSeconds}:requiredDuration=20`,
    );
  }
};

const isHltLivePaymentDiagnostic = (counts: HltLivePaymentCounts): boolean => {
  const values = [counts.users, counts.payments, counts.offeredPerSecond, counts.durationSeconds];
  return values.every(value => Number.isSafeInteger(value) && value > 0) &&
    counts.payments === counts.offeredPerSecond * counts.durationSeconds;
};

/**
 * Any internally consistent smaller run may exercise the production path,
 * but only the exact authority cardinality is allowed to expose rate fields.
 */
export const classifyHltLivePaymentRun = (
  counts: HltLivePaymentCounts,
): HltLivePaymentEvidence => {
  if (isHltLivePaymentTpsAuthority(counts)) return 'tps-authority';
  if (isHltLivePaymentDiagnostic(counts)) return 'functional-smoke';
  throw new Error(
    `HLT_LIVE_PAYMENT_COUNTS_INVALID:users=${counts.users}:payments=${counts.payments}:` +
    `offered=${counts.offeredPerSecond}:duration=${counts.durationSeconds}`,
  );
};

/** Result rates exist only for the exact 20-second TPS authority. */
export const hltLivePaymentRateEvidence = (
  evidence: HltLivePaymentEvidence,
  counts: Readonly<{ offeredPerSecond: number; deliveredPayments: number; deliveredElapsedMs: number }>,
): Readonly<{ offeredPaymentRate: number; deliveredTps: number }> | Readonly<Record<never, never>> =>
  evidence === 'tps-authority'
    ? {
        offeredPaymentRate: counts.offeredPerSecond,
        deliveredTps: counts.deliveredPayments * 1_000 / counts.deliveredElapsedMs,
      }
    : {};

const isRustLiveSameTpsAuthority = (counts: RustLiveSameCounts): boolean =>
  Number.isSafeInteger(counts.users) &&
  Number.isSafeInteger(counts.orders) &&
  Number.isSafeInteger(counts.offeredOrdersPerSecond) &&
  Number.isSafeInteger(counts.durationSeconds) &&
  counts.users >= 1_000 &&
  counts.users % 2 === 0 &&
  counts.orders >= 1_000 &&
  counts.offeredOrdersPerSecond >= 1_000 &&
  counts.durationSeconds === 20 &&
  counts.orders === counts.offeredOrdersPerSecond * counts.durationSeconds;

const isRustLiveSameSmoke = (counts: RustLiveSameCounts): boolean =>
  counts.users === 1_000 &&
  counts.orders === 5_000 &&
  counts.offeredOrdersPerSecond === 1_000 &&
  counts.durationSeconds === 5;

/** Same-chain functional smoke is real production execution but never TPS evidence. */
export const classifyRustLiveSameRun = (
  counts: RustLiveSameCounts,
): RustLiveSameEvidence => {
  if (isRustLiveSameSmoke(counts)) return 'functional-smoke';
  if (!isRustLiveSameTpsAuthority(counts)) {
    throw new Error(
      `HLT_RUST_SAME_CARDINALITY_INVALID:users=${counts.users}:orders=${counts.orders}:` +
      `offered=${counts.offeredOrdersPerSecond}:duration=${counts.durationSeconds}:requiredDuration=20`,
    );
  }
  return 'tps-authority';
};

/** Rate fields are absent from the five-second functional smoke by construction. */
export const rustLiveSameRateEvidence = (
  evidence: RustLiveSameEvidence,
  counts: Readonly<{
    offeredOrdersPerSecond: number;
    matchedEconomicSwaps: number;
    matchedElapsedMs: number;
    fullySettledElapsedMs: number;
  }>,
): Readonly<{
  offeredOrderRate: number;
  matchedTps: number;
  fullySettledTps: number;
}> | Readonly<Record<never, never>> => evidence === 'tps-authority'
  ? {
      offeredOrderRate: counts.offeredOrdersPerSecond,
      matchedTps: counts.matchedEconomicSwaps * 1_000 / counts.matchedElapsedMs,
      fullySettledTps: counts.matchedEconomicSwaps * 1_000 / counts.fullySettledElapsedMs,
    }
  : {};

export const assertRustLiveMixedCardinality = (counts: Readonly<{
  users: number;
  ratePerUser: number;
  durationSeconds: number;
}>): void => {
  if (!isRustLiveMixedTpsAuthority(counts)) {
    throw new Error(
      `HLT_RUST_MIXED_CARDINALITY_INVALID:users=${counts.users}:` +
      `ratePerUser=${counts.ratePerUser}:duration=${counts.durationSeconds}:` +
      'required=at-least-5000-even-users-one-operation-per-user-per-second-for-20-seconds',
    );
  }
};

/**
 * Classification only: a smaller run still executes the complete production
 * path, but must never expose a rate that can be mistaken for HLT authority.
 */
export const isRustLiveMixedTpsAuthority = (counts: Readonly<{
  users: number;
  ratePerUser: number;
  durationSeconds: number;
}>): boolean =>
  Number.isSafeInteger(counts.users) && counts.users >= 5_000 && counts.users % 2 === 0 &&
  counts.ratePerUser === 1 && counts.durationSeconds === 20;

export const parseHltEngineSelection = (env: Record<string, string | undefined>): HltEngineSelection => {
  const engineRaw = String(env['XLN_HLT_ENGINE'] || 'ts').trim();
  if (!HLT_ENGINES.includes(engineRaw as HltEngine)) {
    throw new Error(`HLT_ENGINE_INVALID:${engineRaw}`);
  }
  const profileRaw = String(env['XLN_HLT_PROFILE'] || 'smoke').trim();
  if (!HLT_PROFILES.includes(profileRaw as HltProfile)) {
    throw new Error(`HLT_PROFILE_INVALID:${profileRaw}`);
  }
  return { engine: engineRaw as HltEngine, profile: profileRaw as HltProfile };
};

export type RustH1Ready = Readonly<{
  runtimeId: string;
  entityId: string;
  signerId: string;
  listen: string;
  workers: number;
  minFrameDelayMs: number;
  height: number;
  runtimeFrameHash: string;
  accountsRoot: string;
  orderbookMinTradeSize: bigint;
  restoredFrames?: number;
  restoreMicros?: number;
}>;
export type RustH1Metrics = Readonly<{
  windowMs: number;
  height: number;
  frames: number;
  acceptedBatches: number;
  acceptedEntityInputs: number;
  pendingBatches: number;
  pendingBatchesHighWater: number;
  backpressureEvents: number;
  backpressureWaitMicros: number;
  backpressureWaitMaxMicros: number;
  acceptedConnections: number;
  authenticatedSessions: number;
  rejectedSessions: number;
  openSessions: number;
  lastSessionError: string | null;
  queueRejections: number;
  outputsPublished: number;
  outboxTargetsPending: number;
  outboxRowsPending: number;
  outboxBytesPending: number;
  outboxFailures: number;
  retainedWalBytes: number;
  acceptedPayments: number;
  completedPayments: number;
  matchedSwaps: number;
  zeroFillSwapCancels: number;
  paybookOpen: number;
  orderbookTradeCount: number;
  openBookOrders: number;
  openSwapOffers: number;
  resolvingSwapOffers: number;
  openSwapOfferIds: readonly string[];
  openSwapOfferIdsTruncated: boolean;
  lastCompletedAtUnixMicros: number;
  lastAcceptedAtUnixMicros: number;
  lastMatchedAtUnixMicros: number;
  postStateHash: string;
  paybookFeesEarned: string;
  applyMicros: number;
  projectionMicros: number;
  storageMicros: number;
  publicationMicros: number;
  totalFrames: number;
  totalOutputsPublished: number;
  totalEnvelopesPublished: number;
  totalApplyMicros: number;
  totalProjectionMicros: number;
  totalStorageMicros: number;
  totalPublicationMicros: number;
  totalRuntimeEntityInputs: number;
  /** Frame counts for EntityInput cardinalities: 0,1,2..7,8..31,32..127,128..511,512+. */
  runtimeEntityInputFrameBuckets: readonly number[];
  totalAccountInputs: number;
  totalCanonicalInputBytes: number;
  totalEntityTxsSelected: number;
  entityTxsPending: number;
  totalProjectionInputMicros: number;
  totalProjectionMachineMicros: number;
  totalProjectionMetaMicros: number;
  totalProjectionContextMicros: number;
  totalProjectionCheckpointMicros: number;
  totalProjectionEncodeMicros: number;
  totalStoragePrepareValidateMicros: number;
  totalStorageBatchBuildMicros: number;
  totalStorageDbWriteSyncMicros: number;
  totalStorageDirectorySyncMicros: number;
  totalStoragePostCommitMicros: number;
  totalBarrierWaitForPreviousCommitMicros: number;
  totalCommitterBusyMicros: number;
  totalCommitterIdleMicros: number;
  accountCoordinatorWallMicros: number;
  accountCoordinatorPreDispatchMicros: number;
  accountRunLanesWallMicros: number;
  accountCoordinatorPostJoinMicros: number;
  accountCoordinatorFoldMicros: number;
  accountWorkerWorkSumMicros: number;
  accountWorkerWorkMaxMicros: number;
  accountWorkerCriticalPathMicros: number;
  accountWorkerPhaseSpanMicros: number;
  accountCoordinatorDispatchJoinMicros: number;
  accountWorkerBarrierWaitSumMicros: number;
  accountWorkerBarrierWaitMaxMicros: number;
  accountWorkersWithWork: number;
  accountTouchedShards: number;
  activeShards: number;
  workerItems: readonly number[];
  workerNanos: readonly number[];
  workerFoldLeaves: readonly number[];
  workerFoldNanos: readonly number[];
  entityWorkerItems: readonly number[];
  entityWorkerNanos: readonly number[];
  accountPhaseMetrics: readonly RustAccountPhaseMetric[];
}>;

export type RustAccountPhaseMetric = Readonly<{
  kind: 'inbound' | 'outboundReset' | 'outboundContinue';
  invocations: number;
  coordinatorWallMicros: number;
  coordinatorPreDispatchMicros: number;
  runLanesWallMicros: number;
  coordinatorPostJoinMicros: number;
  workerSamples: number;
  workerWorkSumMicros: number;
  workerCriticalPathMicros: number;
  workerPhaseSpanMicros: number;
  coordinatorDispatchJoinMicros: number;
  workerBarrierWaitSumMicros: number;
  coordinatorFoldMicros: number;
  touchedRows: number;
  touchedShards: number;
  workersWithWork: number;
  shardHandleClones: number;
  candidateBaseReads: number;
  continuationRounds: number;
  restartRounds: number;
}>;

export type RustH1EconomicPhaseMetrics = Readonly<{
  frames: number;
  outputsPublished: number;
  envelopesPublished: number;
  applyMicros: number;
  projectionMicros: number;
  storageMicros: number;
  publicationMicros: number;
  runtimeEntityInputs: number;
  /** Economic-window delta of RustH1Metrics.runtimeEntityInputFrameBuckets. */
  runtimeEntityInputFrameBuckets: readonly number[];
  accountInputs: number;
  canonicalInputBytes: number;
  entityTxsSelected: number;
  entityTxsPending: number;
  zeroFillSwapCancels: number;
  projectionInputMicros: number;
  projectionMachineMicros: number;
  projectionMetaMicros: number;
  projectionContextMicros: number;
  projectionCheckpointMicros: number;
  projectionEncodeMicros: number;
  storagePrepareValidateMicros: number;
  storageBatchBuildMicros: number;
  storageDbWriteSyncMicros: number;
  storageDirectorySyncMicros: number;
  storagePostCommitMicros: number;
  barrierWaitForPreviousCommitMicros: number;
  committerBusyMicros: number;
  committerIdleMicros: number;
  accountCoordinatorWallMicros: number;
  accountCoordinatorPreDispatchMicros: number;
  accountRunLanesWallMicros: number;
  accountCoordinatorPostJoinMicros: number;
  accountCoordinatorFoldMicros: number;
  accountWorkerWorkSumMicros: number;
  accountWorkerCriticalPathMicros: number;
  accountWorkerPhaseSpanMicros: number;
  accountCoordinatorDispatchJoinMicros: number;
  accountWorkerBarrierWaitSumMicros: number;
  accountTouchedShards: number;
  workersWithWork: number;
  workerItems: readonly number[];
  workerNanos: readonly number[];
  workerFoldLeaves: readonly number[];
  workerFoldNanos: readonly number[];
  entityWorkerItems: readonly number[];
  entityWorkerNanos: readonly number[];
  accountPhaseMetrics: readonly RustAccountPhaseMetric[];
}>;

export const diffRustH1EconomicMetrics = (
  before: RustH1Metrics,
  after: RustH1Metrics,
): RustH1EconomicPhaseMetrics => {
  const delta = (field: keyof RustH1Metrics): number => {
    const start = before[field];
    const finish = after[field];
    if (typeof start !== 'number' || typeof finish !== 'number' || finish < start) {
      throw new Error(`HLT_RUST_H1_METRIC_REGRESSION:${String(field)}:${String(start)}:${String(finish)}`);
    }
    return finish - start;
  };
  if (
    before.workerItems.length !== after.workerItems.length ||
    before.workerNanos.length !== after.workerNanos.length ||
    after.workerItems.length !== after.workerNanos.length ||
    before.workerFoldLeaves.length !== after.workerFoldLeaves.length ||
    before.workerFoldNanos.length !== after.workerFoldNanos.length ||
    before.entityWorkerItems.length !== after.entityWorkerItems.length ||
    before.entityWorkerNanos.length !== after.entityWorkerNanos.length ||
    after.workerFoldLeaves.length !== after.workerFoldNanos.length ||
    after.entityWorkerItems.length !== after.entityWorkerNanos.length
  ) {
    throw new Error('HLT_RUST_H1_WORKER_METRIC_CARDINALITY_DRIFT');
  }
  const workerDelta = (
    field: 'workerItems' | 'workerNanos' | 'workerFoldLeaves' | 'workerFoldNanos' |
      'entityWorkerItems' | 'entityWorkerNanos',
  ): readonly number[] => after[field].map((value, index) => {
    const start = before[field][index]!;
    if (value < start) throw new Error(`HLT_RUST_H1_WORKER_METRIC_REGRESSION:${field}:${index}`);
    return value - start;
  });
  const workerItems = workerDelta('workerItems');
  const workerNanos = workerDelta('workerNanos');
  const workerFoldLeaves = workerDelta('workerFoldLeaves');
  const workerFoldNanos = workerDelta('workerFoldNanos');
  const entityWorkerItems = workerDelta('entityWorkerItems');
  const entityWorkerNanos = workerDelta('entityWorkerNanos');
  if (
    before.runtimeEntityInputFrameBuckets.length !== 7 ||
    after.runtimeEntityInputFrameBuckets.length !== 7
  ) throw new Error('HLT_RUST_H1_FRAME_BUCKET_CARDINALITY');
  const runtimeEntityInputFrameBuckets = after.runtimeEntityInputFrameBuckets.map((value, index) => {
    const start = before.runtimeEntityInputFrameBuckets[index]!;
    if (value < start) throw new Error(`HLT_RUST_H1_FRAME_BUCKET_REGRESSION:${index}`);
    return value - start;
  });
  const frames = delta('totalFrames');
  const bucketedFrames = runtimeEntityInputFrameBuckets.reduce((sum, count) => sum + count, 0);
  if (bucketedFrames !== frames) {
    throw new Error(`HLT_RUST_H1_FRAME_BUCKET_COVERAGE:${bucketedFrames}:${frames}`);
  }
  if (
    before.accountPhaseMetrics.length !== after.accountPhaseMetrics.length ||
    before.accountPhaseMetrics.some((metric, index) => metric.kind !== after.accountPhaseMetrics[index]?.kind)
  ) throw new Error('HLT_RUST_H1_ACCOUNT_PHASE_CARDINALITY_DRIFT');
  const phaseFields = [
    'invocations', 'coordinatorWallMicros', 'coordinatorPreDispatchMicros',
    'runLanesWallMicros', 'coordinatorPostJoinMicros', 'workerSamples', 'workerWorkSumMicros',
    'workerCriticalPathMicros', 'workerPhaseSpanMicros', 'coordinatorDispatchJoinMicros',
    'workerBarrierWaitSumMicros', 'coordinatorFoldMicros', 'touchedRows', 'touchedShards',
    'workersWithWork', 'shardHandleClones', 'candidateBaseReads', 'continuationRounds', 'restartRounds',
  ] as const;
  const accountPhaseMetrics = after.accountPhaseMetrics.map((finish, index) => {
    const start = before.accountPhaseMetrics[index]!;
    return {
      kind: finish.kind,
      ...Object.fromEntries(phaseFields.map(field => {
        if (finish[field] < start[field]) {
          throw new Error(`HLT_RUST_H1_ACCOUNT_PHASE_REGRESSION:${finish.kind}:${field}`);
        }
        return [field, finish[field] - start[field]];
      })),
    } as RustAccountPhaseMetric;
  });
  return {
    frames,
    outputsPublished: delta('totalOutputsPublished'),
    envelopesPublished: delta('totalEnvelopesPublished'),
    applyMicros: delta('totalApplyMicros'),
    projectionMicros: delta('totalProjectionMicros'),
    storageMicros: delta('totalStorageMicros'),
    publicationMicros: delta('totalPublicationMicros'),
    runtimeEntityInputs: delta('totalRuntimeEntityInputs'),
    runtimeEntityInputFrameBuckets,
    accountInputs: delta('totalAccountInputs'),
    canonicalInputBytes: delta('totalCanonicalInputBytes'),
    entityTxsSelected: delta('totalEntityTxsSelected'),
    entityTxsPending: after.entityTxsPending,
    zeroFillSwapCancels: delta('zeroFillSwapCancels'),
    projectionInputMicros: delta('totalProjectionInputMicros'),
    projectionMachineMicros: delta('totalProjectionMachineMicros'),
    projectionMetaMicros: delta('totalProjectionMetaMicros'),
    projectionContextMicros: delta('totalProjectionContextMicros'),
    projectionCheckpointMicros: delta('totalProjectionCheckpointMicros'),
    projectionEncodeMicros: delta('totalProjectionEncodeMicros'),
    storagePrepareValidateMicros: delta('totalStoragePrepareValidateMicros'),
    storageBatchBuildMicros: delta('totalStorageBatchBuildMicros'),
    storageDbWriteSyncMicros: delta('totalStorageDbWriteSyncMicros'),
    storageDirectorySyncMicros: delta('totalStorageDirectorySyncMicros'),
    storagePostCommitMicros: delta('totalStoragePostCommitMicros'),
    barrierWaitForPreviousCommitMicros: delta('totalBarrierWaitForPreviousCommitMicros'),
    committerBusyMicros: delta('totalCommitterBusyMicros'),
    committerIdleMicros: delta('totalCommitterIdleMicros'),
    accountCoordinatorWallMicros: delta('accountCoordinatorWallMicros'),
    accountCoordinatorPreDispatchMicros: delta('accountCoordinatorPreDispatchMicros'),
    accountRunLanesWallMicros: delta('accountRunLanesWallMicros'),
    accountCoordinatorPostJoinMicros: delta('accountCoordinatorPostJoinMicros'),
    accountCoordinatorFoldMicros: delta('accountCoordinatorFoldMicros'),
    accountWorkerWorkSumMicros: delta('accountWorkerWorkSumMicros'),
    accountWorkerCriticalPathMicros: delta('accountWorkerCriticalPathMicros'),
    accountWorkerPhaseSpanMicros: delta('accountWorkerPhaseSpanMicros'),
    accountCoordinatorDispatchJoinMicros: delta('accountCoordinatorDispatchJoinMicros'),
    accountWorkerBarrierWaitSumMicros: delta('accountWorkerBarrierWaitSumMicros'),
    accountTouchedShards: delta('accountTouchedShards'),
    workersWithWork: workerItems.filter((items, index) => items > 0 || workerNanos[index]! > 0).length,
    workerItems,
    workerNanos,
    workerFoldLeaves,
    workerFoldNanos,
    entityWorkerItems,
    entityWorkerNanos,
    accountPhaseMetrics,
  };
};

export const summarizeRustH1WorkerExecution = (
  metrics: RustH1EconomicPhaseMetrics,
  configuredWorkers: number,
  economicOperations: number,
): Readonly<Record<string, number>> => {
  if (!Number.isSafeInteger(configuredWorkers) || configuredWorkers < 1) {
    throw new Error(`HLT_RUST_H1_WORKERS_INVALID:${configuredWorkers}`);
  }
  if (!Number.isSafeInteger(economicOperations) || economicOperations < 1) {
    throw new Error(`HLT_RUST_H1_OPERATIONS_INVALID:${economicOperations}`);
  }
  if (metrics.runtimeEntityInputFrameBuckets.reduce((sum, count) => sum + count, 0) !== metrics.frames) {
    throw new Error('HLT_RUST_H1_FRAME_BUCKET_COVERAGE');
  }
  if (
    metrics.workerItems.length !== configuredWorkers ||
    metrics.workerNanos.length !== configuredWorkers ||
    metrics.workerFoldLeaves.length !== configuredWorkers ||
    metrics.workerFoldNanos.length !== configuredWorkers ||
    metrics.entityWorkerItems.length !== configuredWorkers ||
    metrics.entityWorkerNanos.length !== configuredWorkers
  ) {
    throw new Error(
      `HLT_RUST_H1_WORKER_COVERAGE_CARDINALITY:${configuredWorkers}:` +
      `${metrics.workerItems.length}:${metrics.workerNanos.length}:` +
      `${metrics.workerFoldLeaves.length}:${metrics.workerFoldNanos.length}:` +
      `${metrics.entityWorkerItems.length}:${metrics.entityWorkerNanos.length}`,
    );
  }
  const activeAccountWorkers = metrics.workerItems.filter((items, index) =>
    items > 0 && metrics.workerNanos[index]! > 0).length;
  if (activeAccountWorkers !== configuredWorkers) {
    throw new Error(`HLT_RUST_H1_ACCOUNT_WORKER_IDLE:${activeAccountWorkers}:${configuredWorkers}`);
  }
  const activeEntityWorkers = metrics.entityWorkerItems.filter((items, index) =>
    items > 0 && metrics.entityWorkerNanos[index]! > 0).length;
  const minWorkerItems = Math.min(...metrics.workerItems);
  const maxWorkerItems = Math.max(...metrics.workerItems);
  const capacityMicros = metrics.accountWorkerPhaseSpanMicros * configuredWorkers;
  const phase = (kind: RustAccountPhaseMetric['kind']): RustAccountPhaseMetric => {
    const found = metrics.accountPhaseMetrics.find(metric => metric.kind === kind);
    if (!found) throw new Error(`HLT_RUST_H1_ACCOUNT_PHASE_MISSING:${kind}`);
    return found;
  };
  const accountRootRequests =
    phase('outboundReset').invocations + phase('outboundContinue').invocations;
  return {
    configuredWorkers,
    activeAccountWorkers,
    activeEntityWorkers,
    frames: metrics.frames,
    framesPerMillionOperations: Math.round(metrics.frames * 1_000_000 / economicOperations),
    framesWithZeroEntityInputs: metrics.runtimeEntityInputFrameBuckets[0]!,
    framesWithOneEntityInput: metrics.runtimeEntityInputFrameBuckets[1]!,
    framesWithTwoToSevenEntityInputs: metrics.runtimeEntityInputFrameBuckets[2]!,
    framesWithEightToThirtyOneEntityInputs: metrics.runtimeEntityInputFrameBuckets[3]!,
    framesWithThirtyTwoToOneTwentySevenEntityInputs: metrics.runtimeEntityInputFrameBuckets[4]!,
    framesWithOneTwentyEightToFiveElevenEntityInputs: metrics.runtimeEntityInputFrameBuckets[5]!,
    framesWithAtLeastFiveTwelveEntityInputs: metrics.runtimeEntityInputFrameBuckets[6]!,
    runtimeEntityInputsPerMillionOperations:
      Math.round(metrics.runtimeEntityInputs * 1_000_000 / economicOperations),
    accountInputsPerMillionOperations:
      Math.round(metrics.accountInputs * 1_000_000 / economicOperations),
    canonicalInputBytesPerOperation: Math.round(metrics.canonicalInputBytes / economicOperations),
    accountRootRequests,
    accountRootRequestsPerMillionOperations:
      Math.round(accountRootRequests * 1_000_000 / economicOperations),
    accountFoldLeaves: metrics.workerFoldLeaves.reduce((sum, count) => sum + count, 0),
    accountFoldMicros: Math.round(
      metrics.workerFoldNanos.reduce((sum, nanos) => sum + nanos, 0) / 1_000,
    ),
    minWorkerItems,
    maxWorkerItems,
    workerItemImbalancePpm: Math.round((maxWorkerItems - minWorkerItems) * 1_000_000 / maxWorkerItems),
    accountWorkerUsefulPpm: capacityMicros === 0
      ? 0
      : Math.round(metrics.accountWorkerWorkSumMicros * 1_000_000 / capacityMicros),
  };
};

export type RustH1Handle = Readonly<{
  ready: RustH1Ready;
  pid: number | null;
  stop: () => Promise<void>;
  /** Bounded stderr tail for HLT result surfacing. */
  errorTail: () => string;
  /** Latest one-second native phase/outbox sample; null before the first window. */
  metrics: () => RustH1Metrics | null;
  /** Process-local submission; success means the canonical Rust WAL frame fsynced. */
  submitLocalEntityInputs: (
    commandId: string,
    entityInputs: RuntimeInput['entityInputs'],
  ) => Promise<number>;
}>;

export const parseMetricsLine = (line: string): RustH1Metrics | null => {
  if (!line.includes('"status":"metrics"')) return null;
  const record = JSON.parse(line) as Record<string, unknown>;
  if (record['status'] !== 'metrics') return null;
  const fields = [
    'windowMs', 'height', 'frames', 'acceptedBatches', 'acceptedEntityInputs',
    'pendingBatches', 'pendingBatchesHighWater', 'backpressureEvents',
    'backpressureWaitMicros', 'backpressureWaitMaxMicros',
    'acceptedConnections', 'authenticatedSessions', 'rejectedSessions', 'openSessions',
    'queueRejections', 'outputsPublished', 'outboxTargetsPending',
    'outboxRowsPending', 'outboxBytesPending', 'outboxFailures', 'retainedWalBytes',
    'applyMicros', 'projectionMicros',
    'storageMicros', 'publicationMicros', 'acceptedPayments', 'completedPayments',
    'matchedSwaps', 'zeroFillSwapCancels', 'paybookOpen', 'orderbookTradeCount', 'openBookOrders',
    'openSwapOffers', 'resolvingSwapOffers', 'lastCompletedAtUnixMicros',
    'lastAcceptedAtUnixMicros', 'lastMatchedAtUnixMicros',
    'accountCoordinatorWallMicros', 'accountCoordinatorPreDispatchMicros',
    'accountRunLanesWallMicros', 'accountCoordinatorPostJoinMicros',
    'accountCoordinatorFoldMicros',
    'accountWorkerWorkSumMicros', 'accountWorkerWorkMaxMicros',
    'accountWorkerCriticalPathMicros', 'accountWorkerPhaseSpanMicros',
    'accountCoordinatorDispatchJoinMicros',
    'accountWorkerBarrierWaitSumMicros', 'accountWorkerBarrierWaitMaxMicros',
    'accountWorkersWithWork', 'accountTouchedShards', 'activeShards',
    'totalFrames', 'totalOutputsPublished', 'totalEnvelopesPublished',
    'totalApplyMicros', 'totalProjectionMicros', 'totalStorageMicros',
    'totalPublicationMicros',
    'totalRuntimeEntityInputs', 'totalAccountInputs', 'totalCanonicalInputBytes',
    'totalEntityTxsSelected', 'entityTxsPending',
    'totalProjectionInputMicros', 'totalProjectionMachineMicros',
    'totalProjectionMetaMicros', 'totalProjectionContextMicros',
    'totalProjectionCheckpointMicros', 'totalProjectionEncodeMicros',
    'totalStoragePrepareValidateMicros', 'totalStorageBatchBuildMicros',
    'totalStorageDbWriteSyncMicros', 'totalStorageDirectorySyncMicros',
    'totalStoragePostCommitMicros', 'totalBarrierWaitForPreviousCommitMicros',
    'totalCommitterBusyMicros', 'totalCommitterIdleMicros',
  ] as const;
  const values = Object.fromEntries(fields.map(field => {
    const value = Number(record[field]);
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(`HLT_RUST_H1_METRIC_INVALID:${field}:${String(record[field])}`);
    }
    return [field, value];
  })) as Record<(typeof fields)[number], number>;
  const postStateHash = String(record['postStateHash'] || '');
  if (!/^0x[0-9a-f]{64}$/.test(postStateHash)) {
    throw new Error(`HLT_RUST_H1_METRIC_INVALID:postStateHash:${postStateHash}`);
  }
  const paybookFeesEarned = String(record['paybookFeesEarned'] || '');
  if (!/^(0|[1-9][0-9]*)$/.test(paybookFeesEarned)) {
    throw new Error(`HLT_RUST_H1_METRIC_INVALID:paybookFeesEarned:${paybookFeesEarned}`);
  }
  const lastSessionError = record['lastSessionError'] === null
    ? null
    : String(record['lastSessionError'] || '');
  if (lastSessionError !== null && lastSessionError.length < 1) {
    throw new Error('HLT_RUST_H1_METRIC_INVALID:lastSessionError');
  }
  const rawOpenSwapOfferIds = record['openSwapOfferIds'];
  if (
    !Array.isArray(rawOpenSwapOfferIds) || rawOpenSwapOfferIds.length > 256 ||
    rawOpenSwapOfferIds.some(value => typeof value !== 'string' || value.length < 1 || value.length > 256)
  ) throw new Error('HLT_RUST_H1_METRIC_INVALID:openSwapOfferIds');
  const openSwapOfferIdsTruncated = record['openSwapOfferIdsTruncated'];
  if (typeof openSwapOfferIdsTruncated !== 'boolean') {
    throw new Error('HLT_RUST_H1_METRIC_INVALID:openSwapOfferIdsTruncated');
  }
  const integerArray = (
    field: 'workerItems' | 'workerNanos' | 'entityWorkerItems' | 'entityWorkerNanos' |
      'workerFoldLeaves' | 'workerFoldNanos' | 'runtimeEntityInputFrameBuckets',
    expectedLength?: number,
  ): readonly number[] => {
    const raw = record[field];
    if (
      !Array.isArray(raw) || raw.length < 1 || raw.length > 16 ||
      (expectedLength !== undefined && raw.length !== expectedLength) ||
      raw.some(value => !Number.isSafeInteger(value) || Number(value) < 0)
    ) throw new Error(`HLT_RUST_H1_METRIC_INVALID:${field}:${safeStringify(raw)}`);
    return raw.map(Number);
  };
  const workerItems = integerArray('workerItems');
  const workerNanos = integerArray('workerNanos');
  const workerFoldLeaves = integerArray('workerFoldLeaves');
  const workerFoldNanos = integerArray('workerFoldNanos');
  const entityWorkerItems = integerArray('entityWorkerItems');
  const entityWorkerNanos = integerArray('entityWorkerNanos');
  const runtimeEntityInputFrameBuckets = integerArray('runtimeEntityInputFrameBuckets', 7);
  if (
    workerItems.length !== workerNanos.length ||
    entityWorkerItems.length !== entityWorkerNanos.length ||
    entityWorkerItems.length !== workerItems.length
  ) {
    throw new Error(`HLT_RUST_H1_METRIC_INVALID:workerCardinality:${workerItems.length}:${workerNanos.length}`);
  }
  const rawAccountPhases = record['accountPhaseMetrics'];
  if (!Array.isArray(rawAccountPhases) || rawAccountPhases.length !== 3) {
    throw new Error('HLT_RUST_H1_METRIC_INVALID:accountPhaseMetrics');
  }
  const phaseKinds = ['inbound', 'outboundReset', 'outboundContinue'] as const;
  const phaseFields = [
    'invocations', 'coordinatorWallMicros', 'coordinatorPreDispatchMicros',
    'runLanesWallMicros', 'coordinatorPostJoinMicros', 'workerSamples', 'workerWorkSumMicros',
    'workerCriticalPathMicros', 'workerPhaseSpanMicros', 'coordinatorDispatchJoinMicros',
    'workerBarrierWaitSumMicros', 'coordinatorFoldMicros', 'touchedRows', 'touchedShards',
    'workersWithWork', 'shardHandleClones', 'candidateBaseReads', 'continuationRounds', 'restartRounds',
  ] as const;
  const accountPhaseMetrics = rawAccountPhases.map((value, index): RustAccountPhaseMetric => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new Error(`HLT_RUST_H1_METRIC_INVALID:accountPhaseMetrics:${index}`);
    }
    const phase = value as Record<string, unknown>;
    const kind = phaseKinds[index]!;
    if (phase['kind'] !== kind) {
      throw new Error(`HLT_RUST_H1_METRIC_INVALID:accountPhaseMetrics:${index}:kind`);
    }
    return {
      kind,
      ...Object.fromEntries(phaseFields.map(field => {
        const metric = Number(phase[field]);
        if (!Number.isSafeInteger(metric) || metric < 0) {
          throw new Error(`HLT_RUST_H1_METRIC_INVALID:accountPhaseMetrics:${kind}:${field}`);
        }
        return [field, metric];
      })),
    } as RustAccountPhaseMetric;
  });
  return {
    ...values,
    postStateHash,
    paybookFeesEarned,
    lastSessionError,
    openSwapOfferIds: rawOpenSwapOfferIds,
    openSwapOfferIdsTruncated,
    workerItems,
    workerNanos,
    workerFoldLeaves,
    workerFoldNanos,
    entityWorkerItems,
    entityWorkerNanos,
    runtimeEntityInputFrameBuckets,
    accountPhaseMetrics,
  } as RustH1Metrics;
};

export const fetchNativeJson = async (url: string, init: RequestInit = {}): Promise<unknown> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(`HLT_RUST_H1_HTTP_TIMEOUT:${url}`), 5_000);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    const text = await response.text();
    const payload: unknown = text.trim() ? JSON.parse(text) : {};
    if (!response.ok) {
      throw new Error(`HLT_RUST_H1_HTTP_REJECTED:${response.status}:${url}:${safeStringify(payload)}`);
    }
    return payload;
  } finally {
    clearTimeout(timer);
  }
};

/** Attach the HLT to the canonical H1 already supervised by the mesh.
 * This client cannot start, stop, import, or replace H1. */
export const attachRustH1 = async (apiBaseUrl: string): Promise<RustH1Handle> => {
  const apiBase = apiBaseUrl.replace(/\/+$/, '');
  const rawInfo = await fetchNativeJson(`${apiBase}/api/info`);
  if (!rawInfo || typeof rawInfo !== 'object' || Array.isArray(rawInfo)) {
    throw new Error('HLT_RUST_H1_INFO_INVALID');
  }
  const info = rawInfo as Record<string, unknown>;
  const runtimeId = String(info['runtimeId'] || '').trim().toLowerCase();
  const directWsUrl = String(info['directWsUrl'] || '').trim();
  const workers = Number(info['workers']);
  const minFrameDelayMs = Number(info['minFrameDelayMs']);
  const height = Number(info['height']);
  const runtimeFrameHash = String(info['runtimeFrameHash'] || '');
  const accountsRoot = String(info['accountsRoot'] || '');
  const orderbookMinTradeSizeText = String(info['orderbookMinTradeSize'] ?? '');
  const hubEntities = Array.isArray(info['hubEntities']) ? info['hubEntities'] : [];
  const primaryEntities = hubEntities.filter(row =>
    row !== null && typeof row === 'object' && !Array.isArray(row) &&
    (row as Record<string, unknown>)['primary'] === true,
  );
  const primary = primaryEntities.length === 1
    ? primaryEntities[0] as Record<string, unknown>
    : null;
  const entityId = String(primary?.['entityId'] ?? '').toLowerCase();
  const signerId = String(primary?.['signerId'] ?? '').trim();
  let orderbookMinTradeSize: bigint;
  try {
    orderbookMinTradeSize = BigInt(orderbookMinTradeSizeText);
  } catch {
    throw new Error(`HLT_RUST_H1_MIN_TRADE_INVALID:${orderbookMinTradeSizeText}`);
  }
  if (
    !/^0x[0-9a-f]{40}$/.test(runtimeId) ||
    !/^0x[0-9a-f]{64}$/.test(entityId) ||
    signerId.length === 0 ||
    !/^ws:\/\//.test(directWsUrl) ||
    !Number.isSafeInteger(workers) || workers < 1 ||
    !Number.isSafeInteger(minFrameDelayMs) || minFrameDelayMs < 0 || minFrameDelayMs > 10_000 ||
    !Number.isSafeInteger(height) || height < 0 ||
    !/^0x[0-9a-f]{64}$/.test(runtimeFrameHash) ||
    !/^0x[0-9a-f]{64}$/.test(accountsRoot) ||
    orderbookMinTradeSize < 0n
  ) throw new Error(`HLT_RUST_H1_INFO_FIELDS:${safeStringify(info)}`);
  const listen = new URL(directWsUrl).host;
  let latestMetrics: RustH1Metrics | null = null;
  let lastError = '';
  let stopped = false;
  let polling = false;
  const refreshMetrics = async (): Promise<void> => {
    if (stopped || polling) return;
    polling = true;
    try {
      const payload = await fetchNativeJson(`${apiBase}/api/metrics`);
      const parsed = parseMetricsLine(safeStringify(payload));
      if (parsed) latestMetrics = parsed;
      lastError = '';
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    } finally {
      polling = false;
    }
  };
  await refreshMetrics();
  const poller = setInterval(() => void refreshMetrics(), 100);
  poller.unref?.();
  return {
    ready: {
      runtimeId, entityId, signerId, listen, workers, height,
      minFrameDelayMs, runtimeFrameHash, accountsRoot, orderbookMinTradeSize,
    },
    pid: null,
    errorTail: () => lastError,
    metrics: () => latestMetrics,
    submitLocalEntityInputs: async (commandId, entityInputs) => {
      if (stopped) throw new Error(`HLT_RUST_H1_CLIENT_STOPPED:${commandId}`);
      const payload = await fetchNativeJson(`${apiBase}/api/control/runtime/entity-inputs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: safeStringify({ commandId, entityInputs }),
      });
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        throw new Error(`HLT_RUST_H1_COMMAND_RESPONSE_INVALID:${commandId}`);
      }
      const response = payload as Record<string, unknown>;
      const height = Number(response['height']);
      if (
        response['ok'] !== true || response['commandId'] !== commandId ||
        !Number.isSafeInteger(height) || height < 1
      ) throw new Error(`HLT_RUST_H1_COMMAND_RESPONSE_FIELDS:${commandId}:${safeStringify(response)}`);
      await refreshMetrics();
      return height;
    },
    stop: async () => {
      stopped = true;
      clearInterval(poller);
    },
  };
};
