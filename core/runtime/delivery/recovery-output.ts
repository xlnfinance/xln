import type { EntityInput } from '../../entity/types';
import type { RoutedEntityInput, RuntimeReplica, RuntimeTx } from '../types';
import type { JInput } from '../../jurisdiction/machine/input';
import {
  buildPendingNetworkOutputs,
  planEntityOutputs,
  pruneSettledOutputs,
  splitPendingOutputsByRetryWindow,
  type RuntimeOutputRoutingDeps,
} from '../delivery/topology/output-routing';
import { createPreparedOutputGraph } from './prepared-output';

export type RuntimeContinuationEnqueuer = (
  env: RuntimeReplica,
  inputs?: EntityInput[],
  runtimeTxs?: RuntimeTx[],
  jInputs?: JInput[],
  explicitTimestamp?: number,
) => void;

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
    pruneSettledOutputs(env, [...(env.pendingNetworkOutputs ?? []), ...originated]),
    preparedOutputGraph,
  );
  const { ready, waiting } = splitPendingOutputsByRetryWindow(env, pending, routing, preparedOutputGraph);
  const plan = planEntityOutputs(env, ready, routing, preparedOutputGraph);
  enqueueRuntimeContinuation(
    env,
    plan.localOutputs.map(({ sourceRuntimeFrame: _sourceRuntimeFrame, ...output }) => output),
    undefined,
    undefined,
    env.state.timestamp,
  );
  env.pendingNetworkOutputs = buildPendingNetworkOutputs([
    ...waiting,
    ...plan.deferredOutputs,
    ...plan.remoteOutputs.map(({ output }) => output),
  ], preparedOutputGraph);
  return {
    ...plan,
    readyPendingOutputs: ready,
    waitingPendingOutputs: waiting,
  };
};
