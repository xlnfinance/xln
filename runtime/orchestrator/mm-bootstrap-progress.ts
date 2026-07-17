import { createHash } from 'node:crypto';
import { compareStableText, safeStringify } from '../protocol/serialization';
import { computeCanonicalRuntimeStateHash } from '../storage/canonical-hash';
import { computeStorageFrameHash } from '../storage/hashes';
import type { StorageFrameRecord } from '../storage/types';

export type MarketMakerRuntimeBacklogSnapshot = Readonly<{
  processing: boolean;
  runtimeTxs: number;
  entityInputs: number;
  inFlightEntityInputs: number;
  jInputs: number;
}>;

export type MarketMakerCanonicalEntityHash = Readonly<{
  entityId: string;
  hash: string;
  cellCount: number;
}>;

export const buildMarketMakerBootstrapEntityStateHashFromCanonicalHashes = (
  canonicalEntityHashes: readonly MarketMakerCanonicalEntityHash[],
): string => createHash('sha256').update(safeStringify({
  schema: 'market-maker-bootstrap-entity-state-v1',
  entities: canonicalEntityHashes
    .map(({ entityId, hash, cellCount }) => ({ entityId, hash, cellCount }))
    .sort((left, right) => compareStableText(left.entityId, right.entityId)),
})).digest('hex');

export const assertMarketMakerReadySnapshotParity = (
  expected: Readonly<{
    height: number;
    entityStateHash: string;
  }>,
  persistedFrame: StorageFrameRecord | null,
): string => {
  if (!persistedFrame) {
    throw new Error(`MARKET_MAKER_READY_SNAPSHOT_FRAME_MISSING:height=${expected.height}`);
  }
  if (persistedFrame.height !== expected.height) {
    throw new Error(
      `MARKET_MAKER_READY_SNAPSHOT_FRAME_HEIGHT_MISMATCH:` +
      `expected=${expected.height}:actual=${persistedFrame.height}`,
    );
  }
  if (!persistedFrame.frameHash || computeStorageFrameHash(persistedFrame) !== persistedFrame.frameHash) {
    throw new Error(`MARKET_MAKER_READY_SNAPSHOT_FRAME_HASH_MISMATCH:height=${expected.height}`);
  }
  if (!persistedFrame.runtimeMachine || !persistedFrame.runtimeStateHash) {
    throw new Error(`MARKET_MAKER_READY_SNAPSHOT_RUNTIME_ORACLE_MISSING:height=${expected.height}`);
  }
  if (!Array.isArray(persistedFrame.canonicalEntityHashes)) {
    throw new Error(`MARKET_MAKER_READY_SNAPSHOT_ENTITY_HASHES_MISSING:height=${expected.height}`);
  }
  const persistedRuntimeStateHash = computeCanonicalRuntimeStateHash(
    persistedFrame.height,
    persistedFrame.timestamp,
    persistedFrame.canonicalEntityHashes,
    persistedFrame.runtimeMachine,
  );
  if (persistedFrame.runtimeStateHash !== persistedRuntimeStateHash) {
    throw new Error(
      `MARKET_MAKER_READY_SNAPSHOT_RUNTIME_HASH_MISMATCH:` +
      `height=${expected.height}:stored=${persistedFrame.runtimeStateHash}:` +
      `computed=${persistedRuntimeStateHash}`,
    );
  }
  if (
    persistedFrame.canonicalStateHash !== undefined &&
    persistedFrame.canonicalStateHash !== persistedFrame.runtimeStateHash
  ) {
    throw new Error(`MARKET_MAKER_READY_SNAPSHOT_CANONICAL_HASH_MISMATCH:height=${expected.height}`);
  }
  const persistedEntityStateHash = buildMarketMakerBootstrapEntityStateHashFromCanonicalHashes(
    persistedFrame.canonicalEntityHashes,
  );
  if (persistedEntityStateHash !== expected.entityStateHash) {
    throw new Error(
      `MARKET_MAKER_READY_SNAPSHOT_ENTITY_HASH_MISMATCH:` +
      `height=${expected.height}:persisted=${persistedEntityStateHash}:ready=${expected.entityStateHash}`,
    );
  }
  return persistedFrame.runtimeStateHash;
};

type BootstrapHealthLike = {
  hubs?: Array<{
    hubEntityId: string;
    offers: number;
    depthReady: boolean;
    blockers?: unknown[];
  }>;
  cross?: {
    expectedRoutes?: number;
    routeCount?: number;
    routes?: Array<{
      sourceHubEntityId: string;
      targetHubEntityId: string;
      offers: number;
      depthReady: boolean;
      blockers?: unknown[];
    }>;
  };
};

/**
 * Runtime-only bookkeeping may overlap quote production. Entity work may not:
 * once a runtime frame detaches its batch, the live mempool is empty even
 * though those quote inputs are not committed yet. Ignoring the detached
 * count lets the producer enqueue the same missing offer twice.
 */
export const runtimeBacklogBlocksMarketMakerQuotes = (
  backlog: MarketMakerRuntimeBacklogSnapshot,
): boolean => backlog.entityInputs > 0 || backlog.inFlightEntityInputs > 0;

export const resolveMarketMakerReadySnapshotAction = (
  runtimeHeight: number,
  persistedHeight: number,
): 'seed-recovery-base' | 'already-persisted' => {
  if (!Number.isSafeInteger(runtimeHeight) || runtimeHeight <= 0) {
    throw new Error(`MARKET_MAKER_READY_SNAPSHOT_RUNTIME_HEIGHT_INVALID:${runtimeHeight}`);
  }
  if (!Number.isSafeInteger(persistedHeight) || persistedHeight < 0) {
    throw new Error(`MARKET_MAKER_READY_SNAPSHOT_STORAGE_HEIGHT_INVALID:${persistedHeight}`);
  }
  if (persistedHeight === 0) return 'seed-recovery-base';
  if (persistedHeight === runtimeHeight) return 'already-persisted';
  throw new Error(
    `MARKET_MAKER_READY_SNAPSHOT_STORAGE_POSITION_MISMATCH:` +
    `runtime=${runtimeHeight}:persisted=${persistedHeight}`,
  );
};

export const marketMakerBootstrapProgressSignature = (health: BootstrapHealthLike | null): string =>
  safeStringify({
    same: (health?.hubs ?? []).map(hub => ({
      hubEntityId: hub.hubEntityId,
      offers: hub.offers,
      depthReady: hub.depthReady,
      blockers: hub.blockers?.length ?? 0,
    })),
    cross: {
      expectedRoutes: health?.cross?.expectedRoutes ?? 0,
      routeCount: health?.cross?.routeCount ?? health?.cross?.routes?.length ?? 0,
      routes: (health?.cross?.routes ?? []).map(route => ({
        sourceHubEntityId: route.sourceHubEntityId,
        targetHubEntityId: route.targetHubEntityId,
        offers: route.offers,
        depthReady: route.depthReady,
        blockers: route.blockers?.length ?? 0,
      })),
    },
  });
