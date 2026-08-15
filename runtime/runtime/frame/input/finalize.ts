import { isLocalEntityLeaderTimeoutVote } from '../../../entity/consensus/leader';
import { createStructuredLogger } from '../../../infra/logger';
import { createGossipLayer } from '../../../network/p2p/gossip';
import type {
  ReliableDeliveryReceipt,
  RuntimeReplica,
  RoutedEntityInput,
  RuntimeInput,
  RuntimeTx,
} from '../../types';
import type { JInput } from '../../../jurisdiction/machine/input';
import {
  commitReliableIngress,
  getInputReliableIdentity,
  releaseUncommittedReliableIngress,
  type ReliableIngressCommit,
} from '../../reliable/reliable-delivery.ts';
import { mergeDurableReceiptOnlyInputs } from '../../reliable/reliable-durable-inputs.ts';
import {
  parseReceiverFrontierKey,
  reliableIdentityExactKey,
  reliableReceiptCoversIdentity,
} from '../../reliable/reliable-frontier.ts';
import { splitRoutedOutputByDeliveryLane } from '../../routing/output-routing';

const runtimeLog = createStructuredLogger('runtime');

export type RuntimeReliableCommitDeps = {
  applyCommittedLocalReceipts(
    env: RuntimeReplica,
    commits: ReliableIngressCommit[],
    options: {
      isReplay: boolean;
      replayInputs: RoutedEntityInput[];
    },
  ): void;
};

export const commitRuntimeReliableIngress = (
  env: RuntimeReplica,
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

const emitQueuedJBatches = (env: RuntimeReplica, jOutbox: readonly JInput[]): void => {
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
  env: RuntimeReplica,
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
      height: env.state.height + 1,
      runtimeTxs: runtimeTxs.length,
      entityInputs: entityInputCount,
      outputs: entityOutbox.length,
    });
    env.state.height++;
  } else {
    if (env.quietRuntimeLogs !== true) runtimeLog.debug('frame.skip_empty');
    env.extra = undefined;
  }
  if (!env.gossip) {
    runtimeLog.warn('gossip.missing_recreate', { height: env.state.height });
    env.gossip = createGossipLayer();
    runtimeLog.info('gossip.recreated', { height: env.state.height });
  }
  return entityInputCount;
};

type DurableReceiptSource = {
  receipt: ReliableDeliveryReceipt;
  source: string;
};

const collectDurableReceiptSources = (
  env: RuntimeReplica,
  commits: readonly ReliableIngressCommit[],
): DurableReceiptSource[] => {
  const sources: DurableReceiptSource[] = [];
  for (const commit of commits) {
    const receipt = commit.receipt;
    if (!receipt) continue;
    commit.targetRuntimeIds.forEach(source => sources.push({ receipt, source }));
  }
  for (const ledger of [
    env.infrastructure?.reliableIngressReceiptLedger,
    env.infrastructure?.reliableIngressTerminalWatermarks,
  ]) {
    for (const [frontierKey, receipt] of ledger ?? []) {
      sources.push({
        receipt,
        source: parseReceiverFrontierKey(frontierKey).sourceRuntimeId,
      });
    }
  }
  return sources;
};

const indexReceiptSourcesByLane = (
  sources: readonly DurableReceiptSource[],
): Map<string, DurableReceiptSource[]> => {
  const byLane = new Map<string, DurableReceiptSource[]>();
  for (const candidate of sources) {
    const lane = byLane.get(candidate.receipt.body.identity.laneKey) ?? [];
    lane.push(candidate);
    byLane.set(candidate.receipt.body.identity.laneKey, lane);
  }
  return byLane;
};

const durableIngressSources = (
  env: RuntimeReplica,
  commits: readonly ReliableIngressCommit[],
  receivedInputs: readonly RoutedEntityInput[],
): Map<string, Set<string>> => {
  const byLane = indexReceiptSourcesByLane(collectDurableReceiptSources(env, commits));
  const sourcesByIdentity = new Map<string, Set<string>>();
  for (const input of receivedInputs) {
    for (const lane of splitRoutedOutputByDeliveryLane(input)) {
      const identity = getInputReliableIdentity(lane);
      if (!identity) continue;
      const key = reliableIdentityExactKey(identity);
      const sources = sourcesByIdentity.get(key) ?? new Set<string>();
      for (const candidate of byLane.get(identity.laneKey) ?? []) {
        if (reliableReceiptCoversIdentity(candidate.receipt, identity)) {
          sources.add(candidate.source);
        }
      }
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
  env: RuntimeReplica,
  sourceInput: RuntimeInput,
  runtimeTxs: RuntimeTx[],
  receivedInputs: RoutedEntityInput[],
  appliedInputs: RoutedEntityInput[],
  commits: ReliableIngressCommit[],
): RuntimeInput => {
  const receiptInputs = durableReceiptInputs(
    receivedInputs,
    durableIngressSources(env, commits, receivedInputs),
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
