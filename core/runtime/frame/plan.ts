import { createStructuredLogger } from '../../support/logger';
import type { RuntimeReplica, RoutedEntityInput } from '../types';
import type {
  PlannedRemoteOutput,
  RuntimeOutputRoutingDeps,
} from '../delivery/topology/output-routing';
import type { RuntimeProcessProfile } from './process-profile';
import type { PreparedOutputGraph } from '../delivery/prepared-output';

const runtimeLog = createStructuredLogger('runtime');

export type RuntimeFrameOutputPlan = {
  localOutputs: RoutedEntityInput[];
  remoteOutputs: PlannedRemoteOutput[];
  deferredOutputs: RoutedEntityInput[];
  preparedOutputGraph: PreparedOutputGraph;
};

export type RuntimeFrameOutputPlanningDeps = {
  applyOutputPlan(
    env: RuntimeReplica,
    entityOutbox: readonly RoutedEntityInput[],
    routing: RuntimeOutputRoutingDeps,
  ): RuntimeFrameOutputPlan;
  generateHookPings(env: RuntimeReplica): void;
};

export const planRuntimeFrameOutputs = (
  env: RuntimeReplica,
  entityOutbox: readonly RoutedEntityInput[],
  routing: RuntimeOutputRoutingDeps,
  profile: RuntimeProcessProfile,
  quietLogs: boolean,
  deps: RuntimeFrameOutputPlanningDeps,
): RuntimeFrameOutputPlan => {
  const plan = deps.applyOutputPlan(env, entityOutbox, routing);
  profile.metrics.localOutputs = plan.localOutputs.length;
  profile.metrics.remoteOutputs = plan.remoteOutputs.length;
  profile.metrics.deferredOutputs = plan.deferredOutputs.length;
  profile.mark('planOutputs');
  if (plan.localOutputs.length > 0 && !quietLogs) {
    runtimeLog.debug('tick.local_outputs.queued', {
      localOutputs: plan.localOutputs.length,
      entityIds: plan.localOutputs.map(output => output.entityId.slice(-4)),
    });
  }

  // Hooks scheduled by the just-applied frame run on the next Runtime tick.
  // Re-evaluating the deterministic index here avoids wall-clock polling.
  deps.generateHookPings(env);
  return plan;
};
