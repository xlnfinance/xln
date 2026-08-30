/** HLT selection, cardinality gates, native H1 telemetry and attach-only client. */

import { safeStringify } from '../../../../protocol/serialization';
import type { RuntimeInput } from '../../../../runtime/types';

export const HLT_ENGINES = ['ts', 'rust'] as const;
export const HLT_PROFILES = ['smoke', 'medium', 'heavy'] as const;
export type HltEngine = (typeof HLT_ENGINES)[number];
export type HltProfile = (typeof HLT_PROFILES)[number];

export type HltEngineSelection = Readonly<{ engine: HltEngine; profile: HltProfile }>;

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

export const assertRustLivePaymentCardinality = (counts: Readonly<{
  users: number;
  payments: number;
  offeredPerSecond: number;
  durationSeconds: number;
}>): void => {
  if (
    !Number.isSafeInteger(counts.users) ||
    !Number.isSafeInteger(counts.payments) ||
    !Number.isSafeInteger(counts.offeredPerSecond) ||
    !Number.isSafeInteger(counts.durationSeconds) ||
    counts.users < 1_000 ||
    counts.payments < 1_000 ||
    counts.offeredPerSecond < 1_000 ||
    counts.durationSeconds !== 20 ||
    counts.payments !== counts.offeredPerSecond * counts.durationSeconds
  ) {
    throw new Error(
      `HLT_RUST_LIVE_CARDINALITY_TOO_SMALL:users=${counts.users}:` +
      `payments=${counts.payments}:offered=${counts.offeredPerSecond}:` +
      `duration=${counts.durationSeconds}:requiredDuration=20`,
    );
  }
};

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
  accountCoordinatorWallMicros: number;
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
  entityWorkerItems: readonly number[];
  entityWorkerNanos: readonly number[];
  accountPhaseMetrics: readonly RustAccountPhaseMetric[];
}>;

export type RustAccountPhaseMetric = Readonly<{
  kind: 'inbound' | 'outboundReset' | 'outboundContinue';
  invocations: number;
  coordinatorWallMicros: number;
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
  valueClones: number;
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
  accountCoordinatorWallMicros: number;
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
    before.entityWorkerItems.length !== after.entityWorkerItems.length ||
    before.entityWorkerNanos.length !== after.entityWorkerNanos.length ||
    after.entityWorkerItems.length !== after.entityWorkerNanos.length
  ) {
    throw new Error('HLT_RUST_H1_WORKER_METRIC_CARDINALITY_DRIFT');
  }
  const workerDelta = (
    field: 'workerItems' | 'workerNanos' | 'entityWorkerItems' | 'entityWorkerNanos',
  ): readonly number[] => after[field].map((value, index) => {
    const start = before[field][index]!;
    if (value < start) throw new Error(`HLT_RUST_H1_WORKER_METRIC_REGRESSION:${field}:${index}`);
    return value - start;
  });
  const workerItems = workerDelta('workerItems');
  const workerNanos = workerDelta('workerNanos');
  const entityWorkerItems = workerDelta('entityWorkerItems');
  const entityWorkerNanos = workerDelta('entityWorkerNanos');
  if (
    before.accountPhaseMetrics.length !== after.accountPhaseMetrics.length ||
    before.accountPhaseMetrics.some((metric, index) => metric.kind !== after.accountPhaseMetrics[index]?.kind)
  ) throw new Error('HLT_RUST_H1_ACCOUNT_PHASE_CARDINALITY_DRIFT');
  const phaseFields = [
    'invocations', 'coordinatorWallMicros', 'workerSamples', 'workerWorkSumMicros',
    'workerCriticalPathMicros', 'workerPhaseSpanMicros', 'coordinatorDispatchJoinMicros',
    'workerBarrierWaitSumMicros', 'coordinatorFoldMicros', 'touchedRows', 'touchedShards',
    'workersWithWork', 'valueClones', 'candidateBaseReads', 'continuationRounds', 'restartRounds',
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
    frames: delta('totalFrames'),
    outputsPublished: delta('totalOutputsPublished'),
    envelopesPublished: delta('totalEnvelopesPublished'),
    applyMicros: delta('totalApplyMicros'),
    projectionMicros: delta('totalProjectionMicros'),
    storageMicros: delta('totalStorageMicros'),
    publicationMicros: delta('totalPublicationMicros'),
    runtimeEntityInputs: delta('totalRuntimeEntityInputs'),
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
    accountCoordinatorWallMicros: delta('accountCoordinatorWallMicros'),
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
    entityWorkerItems,
    entityWorkerNanos,
    accountPhaseMetrics,
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
    'outboxRowsPending', 'outboxBytesPending', 'outboxFailures', 'applyMicros', 'projectionMicros',
    'storageMicros', 'publicationMicros', 'acceptedPayments', 'completedPayments',
    'matchedSwaps', 'zeroFillSwapCancels', 'paybookOpen', 'orderbookTradeCount', 'openBookOrders',
    'openSwapOffers', 'resolvingSwapOffers', 'lastCompletedAtUnixMicros',
    'lastAcceptedAtUnixMicros', 'lastMatchedAtUnixMicros',
    'accountCoordinatorWallMicros', 'accountCoordinatorFoldMicros',
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
    field: 'workerItems' | 'workerNanos' | 'entityWorkerItems' | 'entityWorkerNanos',
  ): readonly number[] => {
    const raw = record[field];
    if (
      !Array.isArray(raw) || raw.length < 1 || raw.length > 16 ||
      raw.some(value => !Number.isSafeInteger(value) || Number(value) < 0)
    ) throw new Error(`HLT_RUST_H1_METRIC_INVALID:${field}:${safeStringify(raw)}`);
    return raw.map(Number);
  };
  const workerItems = integerArray('workerItems');
  const workerNanos = integerArray('workerNanos');
  const entityWorkerItems = integerArray('entityWorkerItems');
  const entityWorkerNanos = integerArray('entityWorkerNanos');
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
    'invocations', 'coordinatorWallMicros', 'workerSamples', 'workerWorkSumMicros',
    'workerCriticalPathMicros', 'workerPhaseSpanMicros', 'coordinatorDispatchJoinMicros',
    'workerBarrierWaitSumMicros', 'coordinatorFoldMicros', 'touchedRows', 'touchedShards',
    'workersWithWork', 'valueClones', 'candidateBaseReads', 'continuationRounds', 'restartRounds',
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
    entityWorkerItems,
    entityWorkerNanos,
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
      runtimeFrameHash, accountsRoot, orderbookMinTradeSize,
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
