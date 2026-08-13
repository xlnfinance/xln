import { assertCrossJurisdictionSwapTargetReadyInEnv } from './finance/swap-target-readiness';
import { withCanonicalCrossJurisdictionRouteHash } from '../extensions/cross-j';
import { normalizeRuntimeId } from '../network/p2p/auth/runtime-id';
import type { createRuntimeLoopApi } from './loop/loop.ts';
import type { CrossJurisdictionSwapRoute } from '../types/cross-jurisdiction';
import type { RuntimeReplica } from './types';
import {
  buildCrossJurisdictionSwapSubmission,
  type CrossJurisdictionSwapSubmitParams,
  type CrossJurisdictionSwapSubmitResult,
} from './jurisdiction-api';
import { assertRuntimeCommandReady } from './lifecycle';
import { assertCrossJLocalOwnerCohort, requireCrossJRuntimeTopology } from './routing/cross-j-topology';

type RuntimeCommandDependencies = Pick<
  ReturnType<typeof createRuntimeLoopApi>,
  'enqueueRuntimeInputs' | 'getRuntimeOutputRoutingDeps'
>;

type PreparedCrossJurisdictionIntent = {
  route: CrossJurisdictionSwapRoute;
  sourceSignerId: string;
  targetSignerId: string;
};

const prepareCrossJurisdictionIntent = (
  dependencies: RuntimeCommandDependencies,
  env: RuntimeReplica,
  route: CrossJurisdictionSwapRoute,
): PreparedCrossJurisdictionIntent => {
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
    (entityId, signerId) => routing.resolveRuntimeIdForCrossJurisdictionEntity(env, entityId, signerId),
  );
  if (topology.userRuntimeId !== sourceRuntimeId) {
    throw new Error(`CROSS_J_RUNTIME_TOPOLOGY_INVALID:${canonicalRoute.orderId}:USER_RUNTIME_MISMATCH`);
  }
  const sourceSignerId = String(canonicalRoute.sourceSignerId || '').trim().toLowerCase();
  const targetSignerId = String(canonicalRoute.targetSignerId || '').trim().toLowerCase();
  if (!sourceSignerId || !targetSignerId) {
    throw new Error(`CROSS_J_USER_SIGNERS_MISSING:${canonicalRoute.orderId}`);
  }
  return { route: canonicalRoute, sourceSignerId, targetSignerId };
};

/** Commands enter the owning Runtime through its normal ingress/WAL path. */
export const createRuntimeCommandApi = (dependencies: RuntimeCommandDependencies) => {
  const submitCrossJurisdictionIntents = async (
    env: RuntimeReplica,
    routes: readonly CrossJurisdictionSwapRoute[],
  ): Promise<CrossJurisdictionSwapSubmitResult[]> => {
    assertRuntimeCommandReady(env);
    if (routes.length === 0) throw new Error('CROSS_J_INTENT_BATCH_EMPTY');
    const prepared = routes.map(route => prepareCrossJurisdictionIntent(dependencies, env, route));
    const target = prepared.at(0);
    if (!target) throw new Error('CROSS_J_INTENT_BATCH_EMPTY');
    const sourceEntityId = target.route.source.entityId;
    const targetEntityId = target.route.target.counterpartyEntityId;
    if (prepared.some(intent =>
      intent.route.source.entityId !== sourceEntityId ||
      intent.route.target.counterpartyEntityId !== targetEntityId ||
      intent.sourceSignerId !== target.sourceSignerId ||
      intent.targetSignerId !== target.targetSignerId
    )) throw new Error('CROSS_J_INTENT_BATCH_OWNER_MISMATCH');
    // One RuntimeInput durably binds the full quote batch across both user
    // siblings. Target authorization remains first; no source Account money
    // can move until both exact route arrays commit.
    dependencies.enqueueRuntimeInputs(env, [
      {
        entityId: targetEntityId,
        signerId: target.targetSignerId,
        entityTxs: prepared.map(intent => ({
          type: 'prepareCrossJurisdictionSwap' as const,
          data: { route: structuredClone(intent.route) },
        })),
      },
      {
        entityId: sourceEntityId,
        signerId: target.sourceSignerId,
        entityTxs: prepared.map(intent => ({
          type: 'prepareCrossJurisdictionSwap' as const,
          data: { route: structuredClone(intent.route) },
        })),
      },
    ], undefined, undefined, env.state.timestamp);
    return prepared.map(intent => ({ route: intent.route }));
  };

  const submitCrossJurisdictionIntent = async (
    env: RuntimeReplica,
    route: CrossJurisdictionSwapRoute,
  ): Promise<CrossJurisdictionSwapSubmitResult> => {
    const [result] = await submitCrossJurisdictionIntents(env, [route]);
    if (!result) throw new Error('CROSS_J_INTENT_BATCH_RESULT_MISSING');
    return result;
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
    submitCrossJurisdictionIntents,
    submitCrossJurisdictionSwap,
  };
};
