import { isLocalEntityLeaderTimeoutVote } from '../../entity/consensus/leader';
import { createStructuredLogger } from '../../infra/logger';
import { createGossipLayer } from '../../networking/gossip';
import { normalizeRuntimeId } from '../../networking/runtime-id';
import type { RuntimeState, RoutedEntityInput, RuntimeInput, RuntimeTx } from '../types';
import type { JInput } from '../../jurisdiction/input';
import {
  commitReliableIngress,
  getInputReliableIdentity,
  releaseUncommittedReliableIngress,
  type ReliableIngressCommit,
} from '../reliable-delivery';
import { mergeDurableReceiptOnlyInputs } from '../reliable-durable-inputs';
import { reliableIdentityExactKey } from '../reliable-frontier';
import { splitRoutedOutputByDeliveryLane } from '../output-routing';

const runtimeLog = createStructuredLogger('runtime');

export type RuntimeReliableCommitDeps = {
  applyCommittedLocalReceipts(
    env: RuntimeState,
    commits: ReliableIngressCommit[],
    options: {
      isReplay: boolean;
      replayInputs: RoutedEntityInput[];
    },
  ): void;
};

export const commitRuntimeReliableIngress = (
  env: RuntimeState,
  receivedInputs: RoutedEntityInput[],
  appliedInputs: RoutedEntityInput[],
  isReplay: boolean,
  deps: RuntimeReliableCommitDeps,
): ReliableIngressCommit[] => {
  const commits = commitReliableIngress(env, appliedInputs);
  deps.applyCommittedLocalReceipts(env, commits, {
    isReplay,
    replayInputs: receivedInputs,
  });
  // A rejected/deferred registration is candidate-local and cannot survive
  // this frame. Durable active/terminal frontiers remain in committed state.
  releaseUncommittedReliableIngress(env, receivedInputs, appliedInputs);
  return commits;
};

const countMeaningfulEntityInputs = (
  inputs: readonly RoutedEntityInput[],
): number =>
  inputs.reduce((count, input) => {
    const meaningful =
      (input.entityTxs?.length ?? 0) > 0 ||
      Boolean(input.proposedFrame) ||
      (input.hashPrecommits?.size ?? 0) > 0 ||
      (input.jPrefixAttestations?.size ?? 0) > 0 ||
      Boolean(input.leaderTimeoutVote);
    return count + Number(meaningful);
  }, 0);

const emitQueuedJBatches = (env: RuntimeState, jOutbox: readonly JInput[]): void => {
  for (const jInput of jOutbox) {
    for (const jTx of jInput.jTxs) {
      env.emit('JBatchQueued', {
        entityId: jTx.entityId,
        batchSize: (jTx.data as { batchSize?: number } | undefined)?.batchSize,
        jurisdictionName: jInput.jurisdictionName,
      });
    }
  }
};

export const advanceAppliedRuntimeFrame = (
  env: RuntimeState,
  runtimeInput: RuntimeInput,
  runtimeTxs: readonly RuntimeTx[],
  appliedEntityInputs: readonly RoutedEntityInput[],
  entityFrameCommitted: boolean,
  entityOutbox: readonly RoutedEntityInput[],
  jOutbox: readonly JInput[],
  reliableIngressChanged: boolean,
): number => {
  emitQueuedJBatches(env, jOutbox);
  const meaningfulInputs = countMeaningfulEntityInputs(appliedEntityInputs);
  // An empty local trigger may still commit Entity/Account mempool work. The
  // actual Entity height transition is authoritative, not the trigger shape.
  const entityInputCount = entityFrameCommitted
    ? Math.max(meaningfulInputs, appliedEntityInputs.length)
    : meaningfulInputs;
  const advances =
    runtimeTxs.length > 0 ||
    entityInputCount > 0 ||
    (runtimeInput.reliableReceipts?.length ?? 0) > 0 ||
    entityOutbox.length > 0 ||
    jOutbox.length > 0 ||
    reliableIngressChanged;

  if (advances) {
    env.emit('RuntimeTick', {
      height: env.height + 1,
      runtimeTxs: runtimeTxs.length,
      entityInputs: entityInputCount,
      outputs: entityOutbox.length,
    });
    env.height++;
  } else {
    if (env.quietRuntimeLogs !== true) runtimeLog.debug('frame.skip_empty');
    env.extra = undefined;
  }
  if (!env.gossip) {
    runtimeLog.warn('gossip.missing_recreate', { height: env.height });
    env.gossip = createGossipLayer();
    runtimeLog.info('gossip.recreated', { height: env.height });
  }
  return entityInputCount;
};

const durableIngressSources = (
  env: RuntimeState,
  commits: readonly ReliableIngressCommit[],
): Map<string, Set<string>> => {
  const sourcesByIdentity = new Map<string, Set<string>>();
  for (const commit of commits) {
    if (!commit.key) continue;
    const sources = sourcesByIdentity.get(commit.key) ?? new Set<string>();
    commit.targetRuntimeIds.forEach(source => sources.add(source));
    sourcesByIdentity.set(commit.key, sources);
  }
  for (const ledger of [
    env.runtimeState?.reliableIngressReceiptLedger,
    env.runtimeState?.reliableIngressTerminalWatermarks,
  ]) {
    for (const [frontierKey, receipt] of ledger ?? []) {
      const parsed = JSON.parse(frontierKey) as { sourceRuntimeId?: unknown };
      const source = normalizeRuntimeId(parsed.sourceRuntimeId);
      if (!source) throw new Error('RELIABLE_INGRESS_FRONTIER_SOURCE_RUNTIME_INVALID');
      const key = reliableIdentityExactKey(receipt.body.identity);
      const sources = sourcesByIdentity.get(key) ?? new Set<string>();
      sources.add(source);
      sourcesByIdentity.set(key, sources);
    }
  }
  return sourcesByIdentity;
};

const durableReceiptInputs = (
  receivedInputs: readonly RoutedEntityInput[],
  sourcesByIdentity: ReadonlyMap<string, ReadonlySet<string>>,
): RoutedEntityInput[] =>
  receivedInputs.flatMap(input =>
    splitRoutedOutputByDeliveryLane(input).flatMap(lane => {
      if (
        lane.leaderTimeoutVote?.signature === '' &&
        isLocalEntityLeaderTimeoutVote(lane.leaderTimeoutVote)
      ) {
        return [];
      }
      const identity = getInputReliableIdentity(lane);
      if (!identity) return [];
      const sources = sourcesByIdentity.get(reliableIdentityExactKey(identity));
      if (!sources?.size) return [];
      if (lane.from) return [lane];
      return [...sources].sort().map(source => ({ ...lane, from: source }));
    }),
  );

export const buildAppliedRuntimeInput = (
  env: RuntimeState,
  sourceInput: RuntimeInput,
  runtimeTxs: RuntimeTx[],
  receivedInputs: RoutedEntityInput[],
  appliedInputs: RoutedEntityInput[],
  commits: ReliableIngressCommit[],
): RuntimeInput => {
  const receiptInputs = durableReceiptInputs(
    receivedInputs,
    durableIngressSources(env, commits),
  );
  // Annotate the canonical merged input. Replacing it with one receipt lane
  // would silently lose sibling txs and make crash replay diverge.
  const entityInputs = mergeDurableReceiptOnlyInputs(appliedInputs, receiptInputs);
  return {
    runtimeTxs,
    entityInputs,
    ...(sourceInput.jInputs?.length ? { jInputs: sourceInput.jInputs } : {}),
    ...(sourceInput.reliableReceipts?.length
      ? { reliableReceipts: sourceInput.reliableReceipts }
      : {}),
  };
};
