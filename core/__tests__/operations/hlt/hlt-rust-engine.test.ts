import { expect, test } from 'bun:test';

import { deriveEncryptionKeyPair, pubKeyToHex } from '../../../protocol/crypto/p2p-crypto';
import { safeStringify } from '../../../protocol/serialization';
import {
  decodeSovereignRuntimeSeeds,
  encodeSovereignRuntimeSeeds,
} from '../../../scripts/operations/hlt/lanes/sovereign-runtime-sharding';
import {
  HLT_PROFILE_PLAN,
  assertRustLiveMixedCardinality,
  assertRustLivePaymentCardinality,
  diffRustH1EconomicMetrics,
  isRustLiveMixedTpsAuthority,
  parseHltEngineSelection,
  type RustH1Metrics,
  type RustAccountPhaseMetric,
} from '../../../scripts/operations/hlt/rust/rust-h1';
import {
  decodeNativeProfileResponse,
  rustH1SessionPopulationIntact,
  rustH1SessionPopulationReady,
} from '../../../scripts/operations/hlt/rust/rust-h1-settlement';
import { hltLanePortsPerSlot } from '../../../scripts/operations/hlt/lanes/lane-port-capacity';

const accountPhase = (
  kind: RustAccountPhaseMetric['kind'],
  value = 0,
): RustAccountPhaseMetric => ({
  kind,
  invocations: value,
  coordinatorWallMicros: value,
  workerSamples: value,
  workerWorkSumMicros: value,
  workerCriticalPathMicros: value,
  workerPhaseSpanMicros: value,
  coordinatorDispatchJoinMicros: value,
  workerBarrierWaitSumMicros: value,
  coordinatorFoldMicros: value,
  touchedRows: value,
  touchedShards: value,
  workersWithWork: value,
  valueClones: value,
  candidateBaseReads: value,
  continuationRounds: value,
  restartRounds: value,
});

const rustMetrics = (overrides: Partial<RustH1Metrics> = {}): RustH1Metrics => ({
  windowMs: 100, height: 1, frames: 0, acceptedBatches: 0, acceptedEntityInputs: 0,
  openSessions: 0, queueRejections: 0, outputsPublished: 0, outboxTargetsPending: 0,
  outboxRowsPending: 0, outboxBytesPending: 0, outboxFailures: 0, acceptedPayments: 0,
  completedPayments: 0, matchedSwaps: 0, zeroFillSwapCancels: 0, lockBookOpen: 0,
  orderbookTradeCount: 0, openBookOrders: 0, openSwapOffers: 0, resolvingSwapOffers: 0,
  lastCompletedAtUnixMicros: 0, lastAcceptedAtUnixMicros: 0, lastMatchedAtUnixMicros: 0,
  postStateHash: `0x${'00'.repeat(32)}`, htlcFeesEarned: '0',
  applyMicros: 0, projectionMicros: 0, storageMicros: 0, publicationMicros: 0,
  totalFrames: 0, totalOutputsPublished: 0, totalEnvelopesPublished: 0,
  totalApplyMicros: 0, totalProjectionMicros: 0, totalStorageMicros: 0,
  totalPublicationMicros: 0, totalRuntimeEntityInputs: 0, totalAccountInputs: 0,
  totalCanonicalInputBytes: 0, totalEntityTxsSelected: 0, entityTxsPending: 0,
  totalProjectionInputMicros: 0,
  totalProjectionMachineMicros: 0, totalProjectionMetaMicros: 0,
  totalProjectionContextMicros: 0, totalProjectionCheckpointMicros: 0,
  totalProjectionEncodeMicros: 0, accountCoordinatorWallMicros: 0,
  accountCoordinatorFoldMicros: 0, accountWorkerWorkSumMicros: 0,
  accountWorkerWorkMaxMicros: 0, accountWorkerCriticalPathMicros: 0,
  accountWorkerPhaseSpanMicros: 0, accountCoordinatorDispatchJoinMicros: 0,
  accountWorkerBarrierWaitSumMicros: 0,
  accountWorkerBarrierWaitMaxMicros: 0, accountWorkersWithWork: 0,
  accountTouchedShards: 0, activeShards: 0, workerItems: [0, 0], workerNanos: [0, 0],
  entityWorkerItems: [0, 0], entityWorkerNanos: [0, 0],
  accountPhaseMetrics: [
    accountPhase('inbound'),
    accountPhase('outboundReset'),
    accountPhase('outboundContinue'),
  ],
  ...overrides,
});

test('engine selection defaults to ts/smoke and rejects unknown values', () => {
  expect(parseHltEngineSelection({})).toEqual({ engine: 'ts', profile: 'smoke' });
  expect(parseHltEngineSelection({ XLN_HLT_ENGINE: 'rust', XLN_HLT_PROFILE: 'heavy' }))
    .toEqual({ engine: 'rust', profile: 'heavy' });
  expect(() => parseHltEngineSelection({ XLN_HLT_ENGINE: 'shadow' }))
    .toThrow('HLT_ENGINE_INVALID:shadow');
  expect(() => parseHltEngineSelection({ XLN_HLT_PROFILE: 'mega' }))
    .toThrow('HLT_PROFILE_INVALID:mega');
});

test('mixed Rust drain retains baseline peers in addition to all load users', () => {
  expect(rustH1SessionPopulationReady(5_001, 1, 5_000)).toBe(true);
  expect(rustH1SessionPopulationReady(5_000, 1, 5_000)).toBe(false);
  expect(rustH1SessionPopulationIntact(5_001, 5_001, 5_000)).toBe(true);
  expect(rustH1SessionPopulationIntact(5_000, 5_001, 5_000)).toBe(false);
  expect(rustH1SessionPopulationIntact(5_001, 5_001, 5_002)).toBe(false);
});

test('profile plan encodes the canonical medium packing and heavy target', () => {
  expect(HLT_PROFILE_PLAN['medium']).toEqual({ users: 1_000, runtimesPerProcess: 200 });
  expect(HLT_PROFILE_PLAN['heavy'].users).toBe(10_000);
});

test('lane TCP namespace scales independently from Account shard cardinality', () => {
  expect(hltLanePortsPerSlot(4_096)).toBe(4_096);
  expect(hltLanePortsPerSlot(5_000)).toBe(8_192);
  expect(hltLanePortsPerSlot(10_000)).toBe(16_384);
  expect(() => hltLanePortsPerSlot(32_769)).toThrow('HLT_USERS_OUTSIDE_LANE_PORT_CAPACITY');
});

test('1,000 ephemeral Runtime seeds fit the private child pipe without JSON fan-out', () => {
  const seeds = Array.from({ length: 1_000 }, (_, index) =>
    index.toString(16).padStart(64, '0'),
  );
  const encoded = encodeSovereignRuntimeSeeds(seeds);
  expect(Buffer.byteLength(safeStringify({ authSeed: 'a'.repeat(64), laneSeedsBase64: encoded })))
    .toBeLessThan(64 * 1_024);
  expect(decodeSovereignRuntimeSeeds(encoded)).toEqual(seeds);
  expect(() => encodeSovereignRuntimeSeeds(['not-a-seed'])).toThrow('HLT_SOVEREIGN_HOST_LANE_SEED_INVALID:0');
  expect(() => decodeSovereignRuntimeSeeds(`${encoded.slice(0, -1)}!`))
    .toThrow('HLT_SOVEREIGN_HOST_LANE_SEEDS_INVALID');
});

test('Rust live TPS authority rejects smoke-sized populations and rates', () => {
  expect(() => assertRustLivePaymentCardinality({ users: 999, payments: 20_000, offeredPerSecond: 1_000, durationSeconds: 20 }))
    .toThrow('HLT_RUST_LIVE_CARDINALITY_TOO_SMALL');
  expect(() => assertRustLivePaymentCardinality({ users: 1_000, payments: 999, offeredPerSecond: 1_000, durationSeconds: 20 }))
    .toThrow('HLT_RUST_LIVE_CARDINALITY_TOO_SMALL');
  expect(() => assertRustLivePaymentCardinality({ users: 1_000, payments: 19_980, offeredPerSecond: 999, durationSeconds: 20 }))
    .toThrow('HLT_RUST_LIVE_CARDINALITY_TOO_SMALL');
  expect(() => assertRustLivePaymentCardinality({ users: 1_000, payments: 1_000, offeredPerSecond: 1_000, durationSeconds: 1 }))
    .toThrow('HLT_RUST_LIVE_CARDINALITY_TOO_SMALL');
  expect(assertRustLivePaymentCardinality({ users: 1_000, payments: 20_000, offeredPerSecond: 1_000, durationSeconds: 20 }))
    .toBeUndefined();
});

test('Rust mixed authority forbids repeated operations per user', () => {
  expect(isRustLiveMixedTpsAuthority({ users: 10, ratePerUser: 1, durationSeconds: 1 })).toBe(false);
  expect(isRustLiveMixedTpsAuthority({ users: 5_000, ratePerUser: 1, durationSeconds: 20 })).toBe(true);
  expect(assertRustLiveMixedCardinality({ users: 5_000, ratePerUser: 1, durationSeconds: 20 }))
    .toBeUndefined();
  expect(() => assertRustLiveMixedCardinality({ users: 5_000, ratePerUser: 2, durationSeconds: 20 }))
    .toThrow('HLT_RUST_MIXED_CARDINALITY_INVALID');
  expect(() => assertRustLiveMixedCardinality({ users: 4_998, ratePerUser: 1, durationSeconds: 20 }))
    .toThrow('HLT_RUST_MIXED_CARDINALITY_INVALID');
  expect(() => assertRustLiveMixedCardinality({ users: 5_000, ratePerUser: 1, durationSeconds: 1 }))
    .toThrow('HLT_RUST_MIXED_CARDINALITY_INVALID');
});

test('Rust live telemetry isolates the economic phase and proves worker distribution', () => {
  const before = rustMetrics({
    totalFrames: 10, totalApplyMicros: 100, accountCoordinatorWallMicros: 50,
    totalRuntimeEntityInputs: 20, totalAccountInputs: 40, totalCanonicalInputBytes: 4_000,
    totalEntityTxsSelected: 60, entityTxsPending: 0, zeroFillSwapCancels: 3,
    accountWorkerWorkSumMicros: 40, accountTouchedShards: 8,
    workerItems: [100, 100], workerNanos: [1_000, 1_100],
    entityWorkerItems: [20, 20], entityWorkerNanos: [200, 210],
    accountPhaseMetrics: [accountPhase('inbound', 1), accountPhase('outboundReset'), accountPhase('outboundContinue')],
  });
  const after = rustMetrics({
    totalFrames: 14, totalOutputsPublished: 8, totalEnvelopesPublished: 4,
    totalApplyMicros: 260, totalProjectionMicros: 30, totalStorageMicros: 40,
    totalPublicationMicros: 20, accountCoordinatorWallMicros: 150,
    totalRuntimeEntityInputs: 28, totalAccountInputs: 56, totalCanonicalInputBytes: 5_600,
    totalEntityTxsSelected: 84, entityTxsPending: 0, zeroFillSwapCancels: 5,
    totalProjectionInputMicros: 2, totalProjectionMachineMicros: 3,
    totalProjectionMetaMicros: 4, totalProjectionContextMicros: 5,
    totalProjectionCheckpointMicros: 6, totalProjectionEncodeMicros: 10,
    accountCoordinatorFoldMicros: 10, accountWorkerWorkSumMicros: 120,
    accountWorkerBarrierWaitSumMicros: 12, accountTouchedShards: 24,
    workerItems: [106, 105], workerNanos: [1_600, 1_650],
    entityWorkerItems: [24, 23], entityWorkerNanos: [260, 255],
    accountPhaseMetrics: [accountPhase('inbound', 4), accountPhase('outboundReset', 2), accountPhase('outboundContinue', 1)],
  });
  expect(diffRustH1EconomicMetrics(before, after)).toEqual({
    frames: 4, outputsPublished: 8, envelopesPublished: 4,
    applyMicros: 160, projectionMicros: 30, storageMicros: 40, publicationMicros: 20,
    runtimeEntityInputs: 8, accountInputs: 16, canonicalInputBytes: 1_600,
    entityTxsSelected: 24, entityTxsPending: 0, zeroFillSwapCancels: 2,
    projectionInputMicros: 2, projectionMachineMicros: 3, projectionMetaMicros: 4,
    projectionContextMicros: 5, projectionCheckpointMicros: 6, projectionEncodeMicros: 10,
    accountCoordinatorWallMicros: 100, accountCoordinatorFoldMicros: 10,
    accountWorkerWorkSumMicros: 80, accountWorkerCriticalPathMicros: 0,
    accountWorkerPhaseSpanMicros: 0, accountCoordinatorDispatchJoinMicros: 0,
    accountWorkerBarrierWaitSumMicros: 12,
    accountTouchedShards: 16, workersWithWork: 2,
    workerItems: [6, 5], workerNanos: [600, 550],
    entityWorkerItems: [4, 3], entityWorkerNanos: [60, 45],
    accountPhaseMetrics: [accountPhase('inbound', 3), accountPhase('outboundReset', 2), accountPhase('outboundContinue', 1)],
  });
  expect(() => diffRustH1EconomicMetrics(after, before))
    .toThrow('HLT_RUST_H1_WORKER_METRIC_REGRESSION');
});

/**
 * Byte-pinned TS<->Rust transport identity interop. The pinned public key is
 * asserted identically in rscore/crates/runtime/src/transport/tests.rs for
 * Rust `encryption_identity("transport-test-seed")`; any divergence in the
 * domain string, hash or clamping fails this test.
 */
test('transport encryption identity matches the pinned Rust vector', () => {
  const keyPair = deriveEncryptionKeyPair('transport-test-seed');
  expect(pubKeyToHex(keyPair.publicKey)).toBe(
    '0x953809ce01c5b3abacd9d9526a454e983aa2231c3e284e526cf433b82b5ddf7c',
  );
  expect(Buffer.from(keyPair.privateKey).toString('hex')).toBe(
    'b821ec130f8f2d23e5825cdb543b3e5a845ff262eefbea1b8f9becd74afe8c5c',
  );
});

test('native H1 profile client decodes the canonical profile bundle, never the wrapper as a profile', () => {
  const entityId = `0x${'11'.repeat(32)}`;
  const profile = {
    entityId,
    entityEncryptionPublicKey: `0x${'22'.repeat(32)}`,
    name: 'H1', avatar: '', bio: '', website: '', lastUpdated: 1,
    runtimeId: `0x${'33'.repeat(20)}`,
    runtimeEncPubKey: `0x${'44'.repeat(32)}`,
    publicAccounts: [], wsUrl: 'ws://127.0.0.1:22001', relays: [],
    metadata: { isHub: true, routingFeePPM: 1, baseFee: '0' },
    accounts: [],
  };
  expect(decodeNativeProfileResponse({
    ok: true, entityId, found: true, profile, peers: [],
  }, entityId)).toMatchObject({ entityId, name: 'H1', runtimeId: profile.runtimeId });
  expect(() => decodeNativeProfileResponse(profile, entityId))
    .toThrow('HLT_RUST_H1_PROFILE_NOT_FOUND');
});
