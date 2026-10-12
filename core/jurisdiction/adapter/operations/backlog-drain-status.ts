import { safeStringify } from '../../../protocol/serialization';
import type { EntityReplica } from '../../../entity/types';
import type { RuntimeReplica } from '../../../runtime/types';
import type { JReplica } from '../../../types/jurisdiction-runtime';
import type { JAdapter } from '../types';
import {
  findWatcherJurisdictionReplica,
  isEntityReplicaRelevantToWatcher,
} from '../watcher/observe/watcher-replica';

const J_WATCHER_DRAIN_STALL_TIMEOUT_MS = 60_000;
export type JWatcherDrainProgress = {
  fingerprint: string;
  lastProgressAt: number;
  retrying: boolean;
};

export const observeJWatcherDrainProgress = (
  previous: JWatcherDrainProgress | null,
  fingerprint: string,
  nowMs: number,
  timeoutMs = J_WATCHER_DRAIN_STALL_TIMEOUT_MS,
): JWatcherDrainProgress => {
  if (!previous || previous.fingerprint !== fingerprint) {
    return { fingerprint, lastProgressAt: nowMs, retrying: false };
  }
  const idleMs = nowMs - previous.lastProgressAt;
  if (idleMs >= timeoutMs) {
    throw new Error(
      `J_WATCHER_DRAIN_STALLED:idleMs=${idleMs}:timeoutMs=${timeoutMs}:${fingerprint}`,
    );
  }
  return { ...previous, retrying: true };
};

export type CapturedJWatcherTarget = {
  adapter: JAdapter;
  targetBlock: number;
};

export type JWatcherDrainStatus = {
  chainId: number;
  depositoryAddress: string;
  targetBlock: number;
  committedCursor: number;
  authenticatedThrough: number;
  replicas: Array<{
    key: string;
    localScannedThrough: number;
    authenticatedThrough: number;
    entityFinalizedThrough: number;
    pendingDueFinality: boolean;
  }>;
};

/** Newer chain traffic cannot reset the deadline for a captured financial target. */
export const getJWatcherDrainProgressKey = (status: JWatcherDrainStatus): string => {
  const through = (height: number): number => Math.min(height, status.targetBlock);
  return safeStringify([
    through(status.committedCursor),
    through(status.authenticatedThrough),
    status.replicas.map(replica => [
      replica.key,
      through(replica.localScannedThrough),
      through(replica.authenticatedThrough),
      through(replica.entityFinalizedThrough),
      replica.pendingDueFinality,
    ]),
  ]);
};

export const requireSafeBlock = (value: unknown, label: string): number => {
  const block = Number(value);
  if (!Number.isSafeInteger(block) || block < 0) {
    throw new Error(`${label}:${String(value)}`);
  }
  return block;
};

export const requireWatcherReplica = (env: RuntimeReplica, adapter: JAdapter): JReplica => {
  const replica = findWatcherJurisdictionReplica(
    env,
    adapter.addresses.depository,
    Number(adapter.chainId),
  );
  if (!replica) {
    throw new Error(`J_WATCHER_DRAIN_REPLICA_MISSING:${adapter.chainId}:${adapter.addresses.depository}`);
  }
  return replica;
};

export const relevantReplicas = (
  env: RuntimeReplica,
  watcherReplica: JReplica,
): Array<[string, EntityReplica]> => [...env.state.eReplicas.entries()]
  .filter(([, replica]) => isEntityReplicaRelevantToWatcher(env, replica, watcherReplica))
  .sort(([left], [right]) => left.localeCompare(right));

const hasPendingDueFinality = (
  replica: EntityReplica,
  localScannedThrough: number,
  entityFinalizedThrough: number,
): boolean => {
  const certifiedThrough = replica.jPrefixRound?.certificate?.selected.scannedThroughHeight ?? 0;
  // A quorum-certified prefix is already authorized work. Catch-up may split
  // it across many bounded Entity frames, but the drain must not stop on a
  // final empty suffix shorter than the normal liveness interval.
  if (certifiedThrough > entityFinalizedThrough) return true;
  if (localScannedThrough <= entityFinalizedThrough) return false;
  // Empty authenticated headers are validator-local scan progress. An offline
  // Entity cannot sign them, and must never head-of-line block the shared
  // watcher cursor. They piggyback the next real frame or online liveness roll.
  for (const block of replica.jHistory?.eventBlocks.values() ?? []) {
    if (block.jHeight > entityFinalizedThrough && block.jHeight <= localScannedThrough) return true;
  }
  return false;
};

const replicaDrainStatus = (key: string, replica: EntityReplica) => {
  const localScannedThrough = requireSafeBlock(
    replica.jHistory?.scannedThroughHeight ?? replica.state.lastFinalizedJHeight,
    'J_WATCHER_LOCAL_HISTORY_HEIGHT_INVALID',
  );
  const entityFinalizedThrough = requireSafeBlock(
    replica.state.lastFinalizedJHeight,
    'J_WATCHER_ENTITY_FINALITY_HEIGHT_INVALID',
  );
  return {
    key,
    localScannedThrough,
    entityFinalizedThrough,
    pendingDueFinality: hasPendingDueFinality(replica, localScannedThrough, entityFinalizedThrough),
  };
};

export const getJWatcherDrainStatus = (
  env: RuntimeReplica,
  target: CapturedJWatcherTarget,
): JWatcherDrainStatus => {
  const watcherReplica = requireWatcherReplica(env, target.adapter);
  const scanProgress = target.adapter.getWatcherScanProgress?.();
  if (!scanProgress) {
    throw new Error(`J_WATCHER_DRAIN_SCAN_PROGRESS_MISSING:${target.adapter.chainId}`);
  }
  const authenticatedThrough = requireSafeBlock(
    scanProgress.scannedThroughHeight,
    'J_WATCHER_AUTHENTICATED_HEIGHT_INVALID',
  );
  const authenticatedByReplica = scanProgress.replicaScannedThrough;
  return {
    chainId: Number(target.adapter.chainId),
    depositoryAddress: target.adapter.addresses.depository.toLowerCase(),
    targetBlock: target.targetBlock,
    committedCursor: requireSafeBlock(watcherReplica.blockNumber, 'J_WATCHER_COMMITTED_CURSOR_INVALID'),
    authenticatedThrough,
    replicas: relevantReplicas(env, watcherReplica).map(([key, replica]) => ({
      ...replicaDrainStatus(key, replica),
      authenticatedThrough: requireSafeBlock(
        authenticatedByReplica[key] ?? 0,
        `J_WATCHER_REPLICA_AUTHENTICATED_HEIGHT_INVALID:${key}`,
      ),
    })),
  };
};

const requiresDurableWatcherCursor = (status: JWatcherDrainStatus): boolean =>
  status.replicas.length > 0 &&
  status.replicas.every((replica) => replica.entityFinalizedThrough >= status.targetBlock);

export const isJWatcherDrainComplete = (status: JWatcherDrainStatus): boolean =>
  status.authenticatedThrough >= status.targetBlock &&
  (!requiresDurableWatcherCursor(status) || status.committedCursor >= status.targetBlock) &&
  status.replicas.every((replica) =>
    Math.max(replica.localScannedThrough, replica.authenticatedThrough) >= status.targetBlock &&
    !replica.pendingDueFinality
  );

export const needsJWatcherPoll = (status: JWatcherDrainStatus): boolean =>
  status.authenticatedThrough < status.targetBlock ||
  (requiresDurableWatcherCursor(status) && status.committedCursor < status.targetBlock) ||
  status.replicas.some((replica) =>
    Math.max(replica.localScannedThrough, replica.authenticatedThrough) < status.targetBlock
  );
