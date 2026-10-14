import { createStructuredLogger } from '../../support/logger';
import type { RuntimeReplica, RoutedEntityInput } from '../types';
import type {
  PlannedRemoteOutput,
  RuntimeOutputRoutingDeps,
} from '../delivery/topology/output-routing';
import { applyRecoveryRuntimeOutputPlan } from '../delivery/recovery-output';
import { enqueueRuntimeContinuation } from '../loop/loop-envelope';
import { generateHookPings } from '../loop/loop-work';
import type { RuntimeProcessProfile } from './process-profile';
import type { PreparedOutputGraph } from '../delivery/prepared-output';

const runtimeLog = createStructuredLogger('runtime');

export type RuntimeFrameOutputPlan = {
  localOutputs: RoutedEntityInput[];
  remoteOutputs: PlannedRemoteOutput[];
  preparedOutputGraph: PreparedOutputGraph;
};

export type RuntimeFrameOutputPlanningDeps = {
  applyOutputPlan?(
    env: RuntimeReplica,
    entityOutbox: readonly RoutedEntityInput[],
    routing: RuntimeOutputRoutingDeps,
  ): RuntimeFrameOutputPlan;
  generateHookPings?(env: RuntimeReplica): void;
};

export const planRuntimeFrameOutputs = (
  env: RuntimeReplica,
  entityOutbox: readonly RoutedEntityInput[],
  routing: RuntimeOutputRoutingDeps,
  profile: RuntimeProcessProfile,
  quietLogs: boolean,
  deps: RuntimeFrameOutputPlanningDeps = {},
): RuntimeFrameOutputPlan => {
  const applyPlan =
    deps.applyOutputPlan ??
    ((target: RuntimeReplica, outbox: readonly RoutedEntityInput[], routingDeps: RuntimeOutputRoutingDeps) =>
      applyRecoveryRuntimeOutputPlan(target, outbox, routingDeps, enqueueRuntimeContinuation));
  const plan = applyPlan(env, entityOutbox, routing);
  profile.metrics.localOutputs = plan.localOutputs.length;
  profile.metrics.remoteOutputs = plan.remoteOutputs.length;
  profile.mark('planOutputs');
  if (plan.localOutputs.length > 0 && !quietLogs) {
    runtimeLog.debug('tick.local_outputs.queued', {
      localOutputs: plan.localOutputs.length,
      entityIds: plan.localOutputs.map(output => output.entityId.slice(-4)),
    });
  }

  // Hooks scheduled by the just-applied frame run on the next Runtime tick.
  // Re-evaluating the deterministic index here avoids wall-clock polling.
  (deps.generateHookPings ?? generateHookPings)(env);
  return plan;
};
