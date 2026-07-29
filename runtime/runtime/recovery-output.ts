import type { EntityInput } from '../entity/types';
import type { ReliableDeliveryReceipt, RoutedEntityInput, RuntimeState, RuntimeTx } from './types';
import type { JInput } from '../jurisdiction/input';
import { normalizeRuntimeId } from '../networking/runtime-id';
import {
  buildPendingNetworkOutputs,
  getReliableOutputIdentity,
  planEntityOutputs,
  pruneReceiptedReliableOutputs,
  splitPendingOutputsByRetryWindow,
  splitRoutedOutputByDeliveryLane,
  type RuntimeOutputRoutingDeps,
} from './output-routing';
import {
  applyReliableDeliveryReceipts,
  matchReceiptsToOutputs,
  registerReliableIngress,
  registerReliableReceiptIngress,
  type ReliableIngressCommit,
} from './reliable-delivery';

export type RuntimeContinuationEnqueuer = (
  env: RuntimeState,
  inputs?: EntityInput[],
  runtimeTxs?: RuntimeTx[],
  jInputs?: JInput[],
  explicitTimestamp?: number,
  reliableReceipts?: ReliableDeliveryReceipt[],
) => void;

export const hasPendingLocalReliableOutput = (
  env: RuntimeState,
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
  env: RuntimeState,
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
  const receipts: ReliableDeliveryReceipt[] = [];
  const retained: RoutedEntityInput[] = [];
  for (const originated of localOutputs) {
    const { sourceRuntimeFrame: _sourceRuntimeFrame, ...output } = originated;
    if (!getReliableOutputIdentity(output)) {
      inputs.push(output);
      continue;
    }
    const deliverable = { ...output, runtimeId: runtimeId! };
    retained.push(deliverable);
    const registration = registerReliableIngress(
      env,
      runtimeId!,
      deliverable,
    );
    if (registration.kind === 'enqueue') inputs.push(deliverable);
    if (registration.kind === 'receipt') {
      registerReliableReceiptIngress(env, registration.receipt);
      receipts.push(registration.receipt);
    }
  }
  enqueueRuntimeContinuation(
    env,
    inputs,
    undefined,
    undefined,
    env.timestamp,
    receipts,
  );
  return retained;
};

export const applyRecoveryRuntimeOutputPlan = (
  env: RuntimeState,
  entityOutbox: readonly RoutedEntityInput[],
  routing: RuntimeOutputRoutingDeps,
  enqueueRuntimeContinuation: RuntimeContinuationEnqueuer,
) => {
  const originated = entityOutbox.map(output =>
    output.sourceRuntimeFrame
      ? output
      : {
          ...output,
          sourceRuntimeFrame: {
            height: env.height,
            timestamp: env.timestamp,
          },
        },
  );
  const pending = buildPendingNetworkOutputs(
    pruneReceiptedReliableOutputs(env, [
      ...(env.pendingNetworkOutputs ?? []),
      ...originated,
    ]),
  );
  const { ready, waiting } = splitPendingOutputsByRetryWindow(
    env,
    pending,
    routing,
  );
  const plan = planEntityOutputs(env, ready, routing);
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
  ]);
  return {
    ...plan,
    readyPendingOutputs: ready,
    waitingPendingOutputs: waiting,
    retainedLocalReliableOutputs,
  };
};

export const applyCommittedLocalReliableReceipts = (
  env: RuntimeState,
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
