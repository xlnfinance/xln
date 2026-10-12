import { type EntityInput, type EntityReplica } from '../../../entity/types';
import { type RuntimeReplica } from '../../../runtime/types';
import { type EntityTx } from '../../../types/entity-tx';
import type { JAdapter } from '../types';
import { safeStringify } from '../../../protocol/serialization';
import { scheduler } from 'node:timers/promises';
import { getLiveJAdapterEntries } from '../../../runtime/j-submit/live-jadapters';

import {
  getJWatcherDrainStatus,
  getJWatcherDrainProgressKey,
  observeJWatcherDrainProgress,
  type JWatcherDrainProgress,
  isJWatcherDrainComplete,
  needsJWatcherPoll,
  relevantReplicas,
  requireSafeBlock,
  requireWatcherReplica,
  type CapturedJWatcherTarget,
  type JWatcherDrainStatus,
} from './backlog-drain-status';

const J_WATCHER_DRAIN_RETRY_DELAY_MS = 100;

type ProcessRuntimeFrame = (env: RuntimeReplica, inputs?: EntityInput[]) => Promise<RuntimeReplica>;

const getUniqueWatcherAdapters = (env: RuntimeReplica): JAdapter[] => {
  const adapters = new Set<JAdapter>();
  for (const { adapter } of getLiveJAdapterEntries(env)) {
    adapters.add(adapter);
  }
  return [...adapters];
};

const captureTrustedJWatcherTargets = async (env: RuntimeReplica): Promise<CapturedJWatcherTarget[]> => {
  const targets: CapturedJWatcherTarget[] = [];
  for (const adapter of getUniqueWatcherAdapters(env)) {
    if (
      !adapter.pollNow ||
      !adapter.getCurrentBlockNumber ||
      !adapter.getFinalityDepth ||
      !adapter.getWatcherScanProgress
    ) {
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
  validatorFrameHash: replica.candidate?.frameHash ?? '',
  leaderVotes: replica.leaderVotes ?? new Map(),
  pendingLeaderCertificate: replica.pendingLeaderCertificate ?? null,
  lastConsensusProgressAt: replica.lastConsensusProgressAt ?? null,
});

const getDrainFingerprint = (
  env: RuntimeReplica,
  targets: CapturedJWatcherTarget[],
  statuses: JWatcherDrainStatus[],
): string => safeStringify({
  statuses: statuses.map(getJWatcherDrainProgressKey),
  queuedJInputs: (env.runtimeMempool?.entityInputs ?? [])
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
  env: RuntimeReplica,
  processFrame: ProcessRuntimeFrame,
): Promise<JWatcherDrainStatus[]> => {
  const targets = await captureTrustedJWatcherTargets(env);
  if (targets.length === 0) {
    if ((env.runtimeMempool?.entityInputs.length ?? 0) > 0) await processFrame(env);
    return [];
  }

  let progress: JWatcherDrainProgress | null = null;
  while (true) {
    const statuses = targets.map((target) => getJWatcherDrainStatus(env, target));
    if (statuses.every(isJWatcherDrainComplete)) return statuses;
    const fingerprint = getDrainFingerprint(env, targets, statuses);
    progress = observeJWatcherDrainProgress(progress, fingerprint, performance.now());
    if (progress.retrying) {
      // RPC watchers intentionally absorb transient read races. Avoid a hot
      // loop while the same bounded target is retried, but retain a hard stall
      // deadline so a lost watcher cannot hide behind that retry policy.
      await scheduler.wait(J_WATCHER_DRAIN_RETRY_DELAY_MS);
    }
    // Freeze the captured target while Entity consensus finalizes it. Polling
    // a continuously advancing chain here creates a moving target: every slow
    // quorum frame observes a newer empty suffix and the drain never returns.
    await pollCapturedTargets(targets, statuses);
    await processFrame(env);
  }
};
