import { expect, test } from 'bun:test';
import {
  assertMarketMakerReadySnapshotParity,
  buildMarketMakerBootstrapEntityStateHashFromCanonicalHashes,
  marketMakerBootstrapProgressSignature,
  resolveMarketMakerReadySnapshotAction,
  runtimeBacklogBlocksMarketMakerQuotes,
} from '../orchestrator/mm-bootstrap-progress';
import {
  evaluateBootstrapProgressDeadline,
  isBootstrapWorkWithinDeadline,
  updateBootstrapWorkStartedAt,
} from '../orchestrator/bootstrap-progress-deadline';
import { computeCanonicalRuntimeStateHash } from '../storage/canonical-hash';
import { computeStorageFrameHash } from '../storage/hashes';
import type { StorageFrameRecord } from '../storage/types';

const buildReadyFrame = (
  canonicalEntityHashes: NonNullable<StorageFrameRecord['canonicalEntityHashes']>,
  runtimeMachine: Record<string, unknown> = { pendingNetworkOutputs: ['durable-output'] },
): StorageFrameRecord => {
  const frameBase: StorageFrameRecord = {
    height: 165,
    timestamp: 1_000,
    replicaMetaDigest: '0xmeta',
    postStateHash: '0xpost-state',
    stateHash: '0xstate',
    canonicalEntityHashes,
    runtimeStateHash: computeCanonicalRuntimeStateHash(165, 1_000, canonicalEntityHashes, runtimeMachine),
    runtimeInput: { runtimeTxs: [], entityInputs: [] },
    runtimeMachine,
    touchedEntities: [],
    touchedAccounts: [],
    touchedBookEntities: [],
  };
  return { ...frameBase, frameHash: computeStorageFrameHash(frameBase) };
};

test('ready snapshot parity binds Entity state and publishes the durable runtime hash', () => {
  const canonicalEntityHashes = [
    { entityId: '0x02', hash: '0xentity-b', cellCount: 2 },
    { entityId: '0x01', hash: '0xentity-a', cellCount: 1 },
  ];
  const expected = {
    height: 165,
    entityStateHash: buildMarketMakerBootstrapEntityStateHashFromCanonicalHashes(canonicalEntityHashes),
  };
  const persistedFrame = buildReadyFrame(canonicalEntityHashes);

  expect(assertMarketMakerReadySnapshotParity(expected, persistedFrame))
    .toBe(persistedFrame.runtimeStateHash);
  // Runtime output dispatch happens after the frame commit. The live runtime
  // can therefore have a different outbox hash at the same Entity state and
  // height; the ready marker must name the authoritative persisted boundary.
  expect(assertMarketMakerReadySnapshotParity(expected, buildReadyFrame(
    canonicalEntityHashes,
    { pendingNetworkOutputs: [] },
  ))).not.toBe(persistedFrame.runtimeStateHash);

  const wrongEntities = canonicalEntityHashes.map((entry, index) =>
    index === 0 ? { ...entry, hash: '0xwrong-entity' } : entry);
  expect(() => assertMarketMakerReadySnapshotParity(expected, buildReadyFrame(wrongEntities)))
    .toThrow('MARKET_MAKER_READY_SNAPSHOT_ENTITY_HASH_MISMATCH');

  expect(() => assertMarketMakerReadySnapshotParity(expected, {
    ...persistedFrame,
    runtimeMachine: { pendingNetworkOutputs: ['corrupt'] },
    frameHash: computeStorageFrameHash({
      ...persistedFrame,
      runtimeMachine: { pendingNetworkOutputs: ['corrupt'] },
      frameHash: undefined,
    }),
  })).toThrow('MARKET_MAKER_READY_SNAPSHOT_RUNTIME_HASH_MISMATCH');
  expect(() => assertMarketMakerReadySnapshotParity(expected, {
    ...persistedFrame,
    frameHash: '0xcorrupt-frame',
  })).toThrow('MARKET_MAKER_READY_SNAPSHOT_FRAME_HASH_MISMATCH');
  expect(() => assertMarketMakerReadySnapshotParity(expected, null))
    .toThrow('MARKET_MAKER_READY_SNAPSHOT_FRAME_MISSING');
});

test('ready snapshot advances only at a newer finalized runtime height', () => {
  expect(resolveMarketMakerReadySnapshotAction(165, 0)).toBe('seed-recovery-base');
  expect(resolveMarketMakerReadySnapshotAction(165, 165)).toBe('already-persisted');
  expect(resolveMarketMakerReadySnapshotAction(165, 164)).toBe('advance-recovery-base');
  expect(() => resolveMarketMakerReadySnapshotAction(165, 166))
    .toThrow('MARKET_MAKER_READY_SNAPSHOT_STORAGE_POSITION_MISMATCH');
});

test('background runtime bookkeeping neither blocks quotes nor fakes semantic progress', () => {
  const health = {
    hubs: [{ hubEntityId: 'hub-1', offers: 60, depthReady: true, blockers: [] }],
    cross: { expectedRoutes: 6, routes: [] },
  };
  const signature = marketMakerBootstrapProgressSignature(health);

  for (const runtimeTxs of [0, 2, 4]) {
    expect(runtimeBacklogBlocksMarketMakerQuotes({
      processing: runtimeTxs !== 0,
      runtimeTxs,
      entityInputs: 0,
      inFlightEntityInputs: 0,
      jInputs: 0,
    })).toBe(false);
    expect(marketMakerBootstrapProgressSignature(health)).toBe(signature);
  }
});

test('durable frontier movement is semantic bootstrap progress before book depth changes', () => {
  const health = {
    hubs: [{ hubEntityId: 'hub-1', offers: 60, depthReady: true, blockers: [] }],
    cross: { expectedRoutes: 6, routes: [] },
  };
  const before = marketMakerBootstrapProgressSignature(health, {
    pendingReliable: [{ lane: 'generic', sequence: 1n }],
    terminalReceipts: [],
    consumptionRoots: ['0xroot-1'],
  });
  const after = marketMakerBootstrapProgressSignature(health, {
    pendingReliable: [],
    terminalReceipts: [{ lane: 'generic', sequence: 1n }],
    consumptionRoots: ['0xroot-2'],
  });

  expect(after).not.toBe(before);
});

test('market-maker health collection order does not fabricate progress', () => {
  const hub = (hubEntityId: string) => ({
    hubEntityId,
    offers: 60,
    depthReady: true,
    blockers: [],
  });
  const route = (sourceHubEntityId: string, targetHubEntityId: string) => ({
    sourceHubEntityId,
    targetHubEntityId,
    offers: 20,
    depthReady: true,
    blockers: [],
  });
  const before = marketMakerBootstrapProgressSignature({
    hubs: [hub('h2'), hub('h1')],
    cross: { expectedRoutes: 2, routes: [route('h2', 'h1'), route('h1', 'h2')] },
  });
  const after = marketMakerBootstrapProgressSignature({
    hubs: [hub('h1'), hub('h2')],
    cross: { expectedRoutes: 2, routes: [route('h1', 'h2'), route('h2', 'h1')] },
  });

  expect(after).toBe(before);
});

test('queued entity inputs retain quote backpressure until the prior quote batch is admitted', () => {
  expect(runtimeBacklogBlocksMarketMakerQuotes({
    processing: true,
    runtimeTxs: 0,
    entityInputs: 1,
    inFlightEntityInputs: 0,
    jInputs: 0,
  })).toBe(true);
});

test('entity inputs captured by an in-flight runtime frame retain quote backpressure', () => {
  expect(runtimeBacklogBlocksMarketMakerQuotes({
    processing: true,
    runtimeTxs: 0,
    entityInputs: 0,
    inFlightEntityInputs: 1,
    jInputs: 0,
  })).toBe(true);
});

test('causal progress completed after the old deadline is observed before stall rejection', () => {
  const afterLongFrame = evaluateBootstrapProgressDeadline(
    { signature: 'height-89', lastProgressAt: 1_000 },
    'height-90',
    62_000,
    60_000,
  );
  expect(afterLongFrame).toEqual({
    progressed: true,
    signature: 'height-90',
    lastProgressAt: 62_000,
    idleMs: 0,
    stalled: false,
  });

  expect(evaluateBootstrapProgressDeadline(
    { signature: afterLongFrame.signature, lastProgressAt: afterLongFrame.lastProgressAt },
    'height-90',
    122_000,
    60_000,
  ).stalled).toBe(true);

  expect(() => evaluateBootstrapProgressDeadline(
    { signature: 'height-90', lastProgressAt: 62_000 },
    'height-91',
    61_999,
    60_000,
  )).toThrow('BOOTSTRAP_PROGRESS_CLOCK_REGRESSION');
});

test('active bootstrap frame gets its own bounded window without fabricating progress', () => {
  const semanticDeadline = evaluateBootstrapProgressDeadline(
    { signature: 'account-height-6', lastProgressAt: 1_000 },
    'account-height-6',
    96_000,
    60_000,
  );

  expect(semanticDeadline.stalled).toBe(true);
  expect(isBootstrapWorkWithinDeadline(41_000, 96_000, 60_000)).toBe(true);
  expect(isBootstrapWorkWithinDeadline(36_000, 96_000, 60_000)).toBe(false);
  expect(isBootstrapWorkWithinDeadline(null, 96_000, 60_000)).toBe(false);
});

test('remote follow-up work starts a fresh bounded window after a quiescent gap', () => {
  const localBatchStartedAt = updateBootstrapWorkStartedAt(null, true, 10_000);
  expect(updateBootstrapWorkStartedAt(localBatchStartedAt, true, 20_000)).toBe(10_000);

  const quiescent = updateBootstrapWorkStartedAt(localBatchStartedAt, false, 30_000);
  expect(quiescent).toBeNull();

  const remoteFollowUpStartedAt = updateBootstrapWorkStartedAt(quiescent, true, 65_000);
  expect(remoteFollowUpStartedAt).toBe(65_000);
  expect(isBootstrapWorkWithinDeadline(remoteFollowUpStartedAt, 100_000, 60_000)).toBe(true);
});

test('each actively processing Runtime frame gets one bounded execution window', () => {
  const firstFrameStartedAt = updateBootstrapWorkStartedAt(null, true, 10_000, 9_000);
  expect(firstFrameStartedAt).toBe(9_000);

  const nextFrameStartedAt = updateBootstrapWorkStartedAt(
    firstFrameStartedAt,
    true,
    100_000,
    70_000,
  );
  expect(nextFrameStartedAt).toBe(70_000);
  expect(isBootstrapWorkWithinDeadline(nextFrameStartedAt, 100_000, 60_000)).toBe(true);
  expect(isBootstrapWorkWithinDeadline(nextFrameStartedAt, 130_000, 60_000)).toBe(false);
});

test('active Runtime phase progress renews only the current bounded execution window', () => {
  const applyStartedAt = updateBootstrapWorkStartedAt(9_000, true, 61_000, 54_000);

  expect(applyStartedAt).toBe(54_000);
  expect(isBootstrapWorkWithinDeadline(applyStartedAt, 61_000, 60_000)).toBe(true);
  expect(isBootstrapWorkWithinDeadline(applyStartedAt, 114_000, 60_000)).toBe(false);
});
