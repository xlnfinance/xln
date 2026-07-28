import { createStructuredLogger } from '../../infra/logger';
import type { Env, RoutedEntityInput } from '../../types';
import type {
  PlannedRemoteOutput,
  RuntimeOutputRoutingDeps,
} from '../output-routing';
import type { RuntimeProcessProfile } from './process-profile';

const runtimeLog = createStructuredLogger('runtime');

export type RuntimeFrameOutputPlan = {
  localOutputs: RoutedEntityInput[];
  remoteOutputs: PlannedRemoteOutput[];
  deferredOutputs: RoutedEntityInput[];
  readyPendingOutputs: RoutedEntityInput[];
  waitingPendingOutputs: RoutedEntityInput[];
  retainedLocalReliableOutputs: RoutedEntityInput[];
};

export type RuntimeFrameOutputPlanningDeps = {
  applyOutputPlan(
    env: Env,
    entityOutbox: readonly RoutedEntityInput[],
    routing: RuntimeOutputRoutingDeps,
  ): RuntimeFrameOutputPlan;
  generateHookPings(env: Env): void;
};

export const planRuntimeFrameOutputs = (
  env: Env,
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
  profile.metrics.readyPendingOutputs = plan.readyPendingOutputs.length;
  profile.metrics.waitingPendingOutputs = plan.waitingPendingOutputs.length;
  profile.mark('planOutputs');
  if (plan.localOutputs.length > 0 && !quietLogs) {
    runtimeLog.debug('tick.local_outputs.queued', {
      localOutputs: plan.localOutputs.length,
      reliableRetained: plan.retainedLocalReliableOutputs.length,
      entityIds: plan.localOutputs.map(output => output.entityId.slice(-4)),
    });
  }

  // Hooks scheduled by the just-applied frame run on the next Runtime tick.
  // Re-evaluating the deterministic index here avoids wall-clock polling.
  deps.generateHookPings(env);
  return plan;
};
