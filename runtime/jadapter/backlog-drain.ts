import {
  type EntityInput,
  type EntityReplica,
  type EntityTx,
  type Env,
  type JReplica,
} from '../types';
import type { JAdapter } from './types';
import {
  findWatcherJurisdictionReplica,
  isEntityReplicaRelevantToWatcher,
} from './watcher';
import { safeStringify } from '../protocol/serialization';

export type CapturedJWatcherTarget = {
  adapter: JAdapter;
  targetBlock: number;
};

export type JWatcherDrainStatus = {
  chainId: number;
  depositoryAddress: string;
  targetBlock: number;
  committedCursor: number;
  replicas: Array<{
    key: string;
    localScannedThrough: number;
    entityFinalizedThrough: number;
    pendingDueFinality: boolean;
  }>;
};

type ProcessRuntimeFrame = (env: Env, inputs?: EntityInput[]) => Promise<Env>;

const requireSafeBlock = (value: unknown, label: string): number => {
  const block = Number(value);
  if (!Number.isSafeInteger(block) || block < 0) {
    throw new Error(`${label}:${String(value)}`);
  }
  return block;
};

const getUniqueWatcherAdapters = (env: Env): JAdapter[] => {
  const adapters = new Set<JAdapter>();
  for (const replica of env.jReplicas.values()) {
    const adapter = replica.jadapter;
    if (adapter) adapters.add(adapter);
  }
  return [...adapters];
};

const requireWatcherReplica = (env: Env, adapter: JAdapter): JReplica => {
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

export const captureTrustedJWatcherTargets = async (env: Env): Promise<CapturedJWatcherTarget[]> => {
  const targets: CapturedJWatcherTarget[] = [];
  for (const adapter of getUniqueWatcherAdapters(env)) {
    if (!adapter.pollNow || !adapter.getCurrentBlockNumber || !adapter.getFinalityDepth) {
      throw new Error(`J_WATCHER_DRAIN_API_MISSING:${adapter.chainId}:${adapter.addresses.depository}`);
    }
    const chainHead = requireSafeBlock(await adapter.getCurrentBlockNumber(), 'J_WATCHER_CHAIN_HEAD_INVALID');
    const finalityDepth = requireSafeBlock(adapter.getFinalityDepth(), 'J_WATCHER_FINALITY_DEPTH_INVALID');
    // Validate the trusted stack selector now, but never retain the mutable
    // JReplica object. Atomic frame publication replaces canonical replicas.
    requireWatcherReplica(env, adapter);
    targets.push({
      adapter,
      targetBlock: Math.max(0, chainHead - finalityDepth),
    });
  }
  return targets;
};

const relevantReplicas = (
  env: Env,
  watcherReplica: JReplica,
): Array<[string, EntityReplica]> => [...env.eReplicas.entries()]
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
  env: Env,
  target: CapturedJWatcherTarget,
): JWatcherDrainStatus => {
  const watcherReplica = requireWatcherReplica(env, target.adapter);
  return {
    chainId: Number(target.adapter.chainId),
    depositoryAddress: target.adapter.addresses.depository.toLowerCase(),
    targetBlock: target.targetBlock,
    committedCursor: requireSafeBlock(watcherReplica.blockNumber, 'J_WATCHER_COMMITTED_CURSOR_INVALID'),
    replicas: relevantReplicas(env, watcherReplica).map(([key, replica]) => replicaDrainStatus(key, replica)),
  };
};

export const isJWatcherDrainComplete = (status: JWatcherDrainStatus): boolean =>
  status.committedCursor >= status.targetBlock &&
  status.replicas.every((replica) =>
    replica.localScannedThrough >= status.targetBlock && !replica.pendingDueFinality
  );

export const needsJWatcherPoll = (status: JWatcherDrainStatus): boolean =>
  status.committedCursor < status.targetBlock ||
  status.replicas.some((replica) => replica.localScannedThrough < status.targetBlock);

const jTxSummary = (tx: EntityTx): unknown => ({
  baseHeight: Number((tx.data as { baseHeight?: number }).baseHeight ?? 0),
  scannedThroughHeight: Number((tx.data as { scannedThroughHeight?: number }).scannedThroughHeight ?? 0),
  rangeHash: String((tx.data as { rangeHash?: string }).rangeHash ?? ''),
});

const jInputSummary = (input: EntityInput): unknown => ({
  entityId: input.entityId,
  signerId: input.signerId,
  txs: (input.entityTxs ?? []).filter((tx) => tx.type === 'j_event').map(jTxSummary),
  jPrefixAttestations: input.jPrefixAttestations ?? new Map(),
  proposalHash: input.proposedFrame?.hash ?? '',
  proposalSignatures: input.proposedFrame?.collectedSigs ?? new Map(),
  proposalHankos: input.proposedFrame?.hankos ?? [],
  hashPrecommitFrame: input.hashPrecommitFrame ?? null,
  hashPrecommits: input.hashPrecommits ?? new Map(),
  leaderTimeoutVote: input.leaderTimeoutVote
    ? {
        voterId: input.leaderTimeoutVote.voterId,
        signature: input.leaderTimeoutVote.signature,
        preparedFrameHash: input.leaderTimeoutVote.preparedFrame?.hash ?? '',
      }
    : null,
});

const replicaConsensusSummary = (key: string, replica: EntityReplica): unknown => ({
  key,
  mempool: replica.mempool.filter((tx) => tx.type === 'j_event').map(jTxSummary),
  jPrefixRound: replica.jPrefixRound ?? null,
  proposalHash: replica.proposal?.hash ?? '',
  proposalSignatures: replica.proposal?.collectedSigs ?? new Map(),
  proposalHankos: replica.proposal?.hankos ?? [],
  lockedFrameHash: replica.lockedFrame?.hash ?? '',
  lockedFrameSignatures: replica.lockedFrame?.collectedSigs ?? new Map(),
  validatorFrameHash: replica.validatorExecution?.frameHash ?? '',
  leaderVotes: replica.leaderVotes ?? new Map(),
  pendingLeaderCertificate: replica.pendingLeaderCertificate ?? null,
  lastConsensusProgressAt: replica.lastConsensusProgressAt ?? null,
});

const getDrainFingerprint = (
  env: Env,
  targets: CapturedJWatcherTarget[],
  statuses: JWatcherDrainStatus[],
): string => safeStringify({
  statuses,
  queuedJInputs: (env.runtimeInput?.entityInputs ?? [])
    .filter((input) =>
      input.entityTxs?.some((tx) => tx.type === 'j_event') ||
      input.proposedFrame ||
      (input.jPrefixAttestations?.size ?? 0) > 0
    )
    .map(jInputSummary),
  mempoolInputs: (env.runtimeMempool?.entityInputs ?? []).map(jInputSummary),
  networkInbox: (env.networkInbox ?? []).map(jInputSummary),
  pendingNetworkOutputs: (env.pendingNetworkOutputs ?? []).map(jInputSummary),
  consensus: targets.flatMap((target) => relevantReplicas(env, requireWatcherReplica(env, target.adapter))
    .map(([key, replica]) => replicaConsensusSummary(key, replica))),
});

const pollCapturedTargets = async (
  targets: CapturedJWatcherTarget[],
  statuses: JWatcherDrainStatus[],
): Promise<void> => {
  for (const [index, target] of targets.entries()) {
    const status = statuses[index];
    if (!status || !needsJWatcherPoll(status)) continue;
    const pollNow = target.adapter.pollNow;
    if (!pollNow) throw new Error(`J_WATCHER_DRAIN_API_LOST:${target.adapter.chainId}`);
    await pollNow.call(target.adapter);
  }
};

export const drainJWatcherBacklog = async (
  env: Env,
  processFrame: ProcessRuntimeFrame,
): Promise<JWatcherDrainStatus[]> => {
  const targets = await captureTrustedJWatcherTargets(env);
  if (targets.length === 0) {
    if ((env.runtimeInput?.entityInputs.length ?? 0) > 0) await processFrame(env);
    return [];
  }

  const seen = new Set<string>();
  while (true) {
    const statuses = targets.map((target) => getJWatcherDrainStatus(env, target));
    if (statuses.every(isJWatcherDrainComplete)) return statuses;
    const fingerprint = getDrainFingerprint(env, targets, statuses);
    if (seen.has(fingerprint)) {
      throw new Error(`J_WATCHER_DRAIN_STALLED:${fingerprint}`);
    }
    seen.add(fingerprint);
    // Freeze the captured target while Entity consensus finalizes it. Polling
    // a continuously advancing chain here creates a moving target: every slow
    // quorum frame observes a newer empty suffix and the drain never returns.
    await pollCapturedTargets(targets, statuses);
    await processFrame(env);
  }
};
