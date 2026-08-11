import { assertCrossJurisdictionSwapTargetReadyInEnv } from './swap-target-readiness';
import { withCanonicalCrossJurisdictionRouteHash } from '../extensions/cross-j';
import { normalizeRuntimeId } from '../network/p2p/runtime-id';
import type { createRuntimeLoopApi } from './loop';
import type { CrossJurisdictionSwapRoute } from '../types/cross-jurisdiction';
import type { RuntimeReplica } from './types';
import {
  buildCrossJurisdictionSwapSubmission,
  type CrossJurisdictionSwapSubmitParams,
  type CrossJurisdictionSwapSubmitResult,
} from './jurisdiction-api';
import { assertRuntimeCommandReady } from './lifecycle';
import { assertCrossJLocalOwnerCohort, requireCrossJRuntimeTopology } from './cross-j-topology';

type RuntimeCommandDependencies = Pick<
  ReturnType<typeof createRuntimeLoopApi>,
  'enqueueRuntimeInputs' | 'getRuntimeOutputRoutingDeps'
>;

/** Commands enter the owning Runtime through its normal ingress/WAL path. */
export const createRuntimeCommandApi = (dependencies: RuntimeCommandDependencies) => {
  const submitCrossJurisdictionIntent = async (
    env: RuntimeReplica,
    route: CrossJurisdictionSwapRoute,
  ): Promise<CrossJurisdictionSwapSubmitResult> => {
    assertRuntimeCommandReady(env);
    const canonicalRoute = withCanonicalCrossJurisdictionRouteHash(route);
    if (canonicalRoute.status !== 'intent' || canonicalRoute.sourcePull || canonicalRoute.targetPull) {
      throw new Error(`CROSS_J_INTENT_STATE_INVALID:${canonicalRoute.orderId}`);
    }
    const routing = dependencies.getRuntimeOutputRoutingDeps();
    assertCrossJLocalOwnerCohort(env, canonicalRoute, 'user', routing);
    assertCrossJurisdictionSwapTargetReadyInEnv(env, canonicalRoute);
    const sourceRuntimeId = normalizeRuntimeId(env.runtimeId);
    if (!sourceRuntimeId) throw new Error('CROSS_J_INTENT_SOURCE_RUNTIME_INVALID');
    const topology = requireCrossJRuntimeTopology(
      canonicalRoute,
      (entityId, signerId) => routing.resolveRuntimeIdForCrossJurisdictionEntity(
        env,
        entityId,
        signerId,
      ),
    );
    if (topology.userRuntimeId !== sourceRuntimeId) {
      throw new Error(`CROSS_J_RUNTIME_TOPOLOGY_INVALID:${canonicalRoute.orderId}:USER_RUNTIME_MISMATCH`);
    }
    const sourceSignerId = String(canonicalRoute.sourceSignerId || '').trim().toLowerCase();
    const targetSignerId = String(canonicalRoute.targetSignerId || '').trim().toLowerCase();
    if (!sourceSignerId || !targetSignerId) {
      throw new Error(`CROSS_J_USER_SIGNERS_MISSING:${canonicalRoute.orderId}`);
    }
    // One RuntimeInput is the durable owner command for both user siblings.
    // The target authorization is intentionally ordered first: the source
    // authorization may emit the certified source-user -> source-hub command,
    // but no money can pass the later Account boundary without both records.
    dependencies.enqueueRuntimeInputs(env, [
      {
        entityId: canonicalRoute.target.counterpartyEntityId,
        signerId: targetSignerId,
        entityTxs: [{ type: 'prepareCrossJurisdictionSwap', data: { route: structuredClone(canonicalRoute) } }],
      },
      {
        entityId: canonicalRoute.source.entityId,
        signerId: sourceSignerId,
        entityTxs: [{ type: 'prepareCrossJurisdictionSwap', data: { route: structuredClone(canonicalRoute) } }],
      },
    ], undefined, undefined, env.state.timestamp);
    return { route: canonicalRoute };
  };

  const submitCrossJurisdictionSwap = async (
    env: RuntimeReplica,
    params: CrossJurisdictionSwapSubmitParams,
  ): Promise<CrossJurisdictionSwapSubmitResult> => {
    const { route } = buildCrossJurisdictionSwapSubmission(env, params);
    return submitCrossJurisdictionIntent(env, route);
  };

  return {
    submitCrossJurisdictionIntent,
    submitCrossJurisdictionSwap,
  };
};
