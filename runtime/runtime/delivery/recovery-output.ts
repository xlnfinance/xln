import type { EntityInput } from '../../entity/types';
import type { ReliableDeliveryReceipt, RoutedEntityInput, RuntimeReplica, RuntimeTx } from '../types';
import type { JInput } from '../../jurisdiction/machine/input';
import { normalizeRuntimeId } from '../../network/p2p/auth/runtime-id';
import {
  buildPendingNetworkOutputs,
  getReliableOutputIdentity,
  planEntityOutputs,
  pruneReceiptedReliableOutputs,
  splitPendingOutputsByRetryWindow,
  splitRoutedOutputByDeliveryLane,
  type RuntimeOutputRoutingDeps,
} from '../routing/output-routing';
import {
  applyReliableDeliveryReceipts,
  matchReceiptsToOutputs,
  type ReliableIngressCommit,
} from '../reliable/reliable-delivery.ts';
import { reliableIdentityExactKey } from '../reliable/reliable-frontier.ts';
import { createPreparedOutputGraph } from './prepared-output';

export type RuntimeContinuationEnqueuer = (
  env: RuntimeReplica,
  inputs?: EntityInput[],
  runtimeTxs?: RuntimeTx[],
  jInputs?: JInput[],
  explicitTimestamp?: number,
  reliableReceipts?: ReliableDeliveryReceipt[],
) => void;

export const hasPendingLocalReliableOutput = (
  env: RuntimeReplica,
): boolean => {
  const runtimeId = normalizeRuntimeId(env.runtimeId);
  if (!runtimeId) return false;
  return (env.pendingNetworkOutputs ?? []).some(
    output =>
      normalizeRuntimeId(output.runtimeId) === runtimeId &&
      getReliableOutputIdentity(output) !== null,
  );
};

const queueLocalReliableOutputs = (
  env: RuntimeReplica,
  localOutputs: readonly RoutedEntityInput[],
  enqueueRuntimeContinuation: RuntimeContinuationEnqueuer,
): RoutedEntityInput[] => {
  const runtimeId = normalizeRuntimeId(env.runtimeId);
  if (
    !runtimeId &&
    localOutputs.some(output => getReliableOutputIdentity(output) !== null)
  ) {
    throw new Error('RELIABLE_LOCAL_RUNTIME_ID_MISSING');
  }
  const inputs: RoutedEntityInput[] = [];
  const retained: RoutedEntityInput[] = [];
  const queuedReliableKeys = new Set(
    [
      ...(env.runtimeMempool?.entityInputs ?? []).flatMap(input => {
        const identity = getReliableOutputIdentity(input);
        return identity ? [reliableIdentityExactKey(identity)] : [];
      }),
      ...[...(env.infrastructure?.pendingReliableIngress?.values() ?? [])]
        .map(entry => reliableIdentityExactKey(entry.identity)),
      ...(env.infrastructure?.inFlightReliableInputKeys ?? []),
    ],
  );
  for (const originated of localOutputs) {
    const { sourceRuntimeFrame: _sourceRuntimeFrame, ...output } = originated;
    if (!getReliableOutputIdentity(output)) {
      inputs.push(output);
      continue;
    }
    // Loopback uses the same authenticated provenance and receipt protocol as
    // remote transport. Runtime creates both fields here, so the next frame
    // registers the input once and can durably retire the retained outbox item.
    const deliverable = {
      ...output,
      runtimeId: runtimeId!,
      from: runtimeId!,
    };
    retained.push(deliverable);
    // The current WAL persists both this retained outbox item and the next
    // Runtime mempool. Registering receiver ingress here would register it a
    // second time when that next frame actually applies the input, causing the
    // admission layer to suppress its own local continuation as "pending".
    // Registration therefore belongs exclusively to the applying frame.
    const reliableKey = reliableIdentityExactKey(
      getReliableOutputIdentity(deliverable)!,
    );
    if (!queuedReliableKeys.has(reliableKey)) {
      queuedReliableKeys.add(reliableKey);
      inputs.push(deliverable);
    }
  }
  enqueueRuntimeContinuation(
    env,
    inputs,
    undefined,
    undefined,
    env.state.timestamp,
  );
  return retained;
};

export const applyRecoveryRuntimeOutputPlan = (
  env: RuntimeReplica,
  entityOutbox: readonly RoutedEntityInput[],
  routing: RuntimeOutputRoutingDeps,
  enqueueRuntimeContinuation: RuntimeContinuationEnqueuer,
) => {
  const preparedOutputGraph = createPreparedOutputGraph();
  const originated = entityOutbox.map(output =>
    output.sourceRuntimeFrame
      ? output
      : {
          ...output,
          sourceRuntimeFrame: {
            height: env.state.height,
            timestamp: env.state.timestamp,
          },
        },
  );
  const pending = buildPendingNetworkOutputs(
    pruneReceiptedReliableOutputs(env, [
      ...(env.pendingNetworkOutputs ?? []),
      ...originated,
    ]),
    preparedOutputGraph,
  );
  const { ready, waiting } = splitPendingOutputsByRetryWindow(
    env,
    pending,
    routing,
    preparedOutputGraph,
  );
  const plan = planEntityOutputs(env, ready, routing, preparedOutputGraph);
  const retainedLocalReliableOutputs = queueLocalReliableOutputs(
    env,
    plan.localOutputs,
    enqueueRuntimeContinuation,
  );
  env.pendingNetworkOutputs = buildPendingNetworkOutputs([
    ...waiting,
    ...plan.deferredOutputs,
    ...plan.remoteOutputs.map(({ output }) => output),
    ...retainedLocalReliableOutputs,
  ], preparedOutputGraph);
  return {
    ...plan,
    readyPendingOutputs: ready,
    waitingPendingOutputs: waiting,
    retainedLocalReliableOutputs,
  };
};

export const applyCommittedLocalReliableReceipts = (
  env: RuntimeReplica,
  commits: ReliableIngressCommit[],
  options: {
    isReplay?: boolean;
    replayInputs?: readonly RoutedEntityInput[];
  } = {},
): void => {
  const runtimeId = normalizeRuntimeId(env.runtimeId);
  if (!runtimeId) return;
  const localCommits = commits.filter(
    commit =>
      commit.receipt !== undefined &&
      commit.targetRuntimeIds.includes(runtimeId),
  );
  const pendingMatches = matchReceiptsToOutputs(
    env.pendingNetworkOutputs ?? [],
    localCommits.flatMap(commit => commit.receipt ? [commit.receipt] : []),
  );
  const selected = new Map<ReliableDeliveryReceipt, RoutedEntityInput>(
    pendingMatches,
  );
  if (options.isReplay) {
    const uncovered = localCommits.filter(
      commit => commit.receipt && !selected.has(commit.receipt),
    );
    const replayMatches = matchReceiptsToOutputs(
      options.replayInputs?.flatMap(splitRoutedOutputByDeliveryLane) ?? [],
      uncovered.flatMap(commit => commit.receipt ? [commit.receipt] : []),
    );
    for (const commit of uncovered) {
      const receipt = commit.receipt!;
      const replayOutput = replayMatches.get(receipt);
      if (!replayOutput) {
        throw new Error(
          `RELIABLE_LOCAL_REPLAY_OUTPUT_PROOF_MISSING:` +
          `${receipt.body.identity.kind}:${receipt.body.identity.height}`,
        );
      }
      env.pendingNetworkOutputs = [
        ...(env.pendingNetworkOutputs ?? []),
        replayOutput,
      ];
      selected.set(receipt, replayOutput);
    }
  }
  const receipts = [...selected.keys()];
  const signatures = new Set(receipts.map(receipt => receipt.signature));
  for (const commit of localCommits) {
    if (commit.receipt && signatures.has(commit.receipt.signature)) {
      commit.targetRuntimeIds = commit.targetRuntimeIds.filter(
        target => target !== runtimeId,
      );
    }
  }
  if (receipts.length > 0) {
    const unique = [
      ...new Map(
        receipts.map(receipt => [receipt.signature, receipt]),
      ).values(),
    ];
    applyReliableDeliveryReceipts(env, unique);
  }
};
