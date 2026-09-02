import type { EntityInput } from '../../entity/types';
import type { RoutedEntityInput, RuntimeReplica, RuntimeTx } from '../types';
import type { JInput } from '../../jurisdiction/machine/input';
import {
  buildPendingNetworkOutputs,
  planEntityOutputs,
  pruneSettledOutputs,
  type RuntimeOutputRoutingDeps,
} from '../delivery/topology/output-routing';
import { createPreparedOutputGraph } from './prepared-output';
import { timePerfPhase } from '../../support/performance/profile';
import { capturePlannedLocalContinuations } from '../observability/parity-evidence';

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
  const originated = timePerfPhase('recovery.output.originated', () => entityOutbox.map(output =>
    output.sourceRuntimeFrame
      ? output
      : {
          ...output,
          sourceRuntimeFrame: {
            height: env.state.height,
            timestamp: env.state.timestamp,
          },
        },
  ));
  const pending = timePerfPhase('recovery.output.pending', () => buildPendingNetworkOutputs(
    pruneSettledOutputs(env, [...(env.pendingNetworkOutputs ?? []), ...originated]),
    preparedOutputGraph,
  ));
  const plan = timePerfPhase('recovery.output.plan', () =>
    planEntityOutputs(env, pending, routing, preparedOutputGraph));
  if (plan.deferredOutputs.length > 0) {
    throw new Error(`ROUTE_DEFERRED_OUTPUTS_FORBIDDEN:${plan.deferredOutputs.length}`);
  }
  const localContinuations = plan.localOutputs.map(({
    sourceRuntimeFrame: _sourceRuntimeFrame,
    ...output
  }) => output);
  capturePlannedLocalContinuations(env, localContinuations);
  timePerfPhase('recovery.output.enqueueLocal', () => enqueueRuntimeContinuation(
    env,
    localContinuations,
    undefined,
    undefined,
    env.state.timestamp,
  ));
  env.pendingNetworkOutputs = timePerfPhase('recovery.output.remotePending', () =>
    buildPendingNetworkOutputs(
      plan.remoteOutputs.map(({ output }) => output),
      preparedOutputGraph,
    ));
  return plan;
};
