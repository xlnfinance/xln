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
import { localOutputIncludedIn } from './local-outbox';

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
  const queued = localOutputIncludedIn(env.runtimeMempool?.entityInputs ?? [], plan.localOutputs);
  const localContinuations = plan.localOutputs.filter(output => !queued(output)).map(({
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
  // Local delivery is still only RAM admission. Keep its signed ACK/proposal
  // in the same ordered WAL outbox until the recipient input commits.
  // Otherwise a crash after the receiver commits loses its
  // ACK and strands the co-hosted proposer with a permanently pending debit.
  env.pendingNetworkOutputs = timePerfPhase('recovery.output.pendingCommit', () =>
    buildPendingNetworkOutputs(
      plan.orderedOutputs,
      preparedOutputGraph,
    ));
  return plan;
};
