import { assertCrossJurisdictionSwapTargetReadyInEnv } from './swap-target-readiness';
import { withCanonicalCrossJurisdictionRouteHash } from '../extensions/cross-j';
import { normalizeRuntimeId } from '../network/p2p/runtime-id';
import {
  getRuntimeEntityDisplayInfo,
  resolveRuntimeEntityName,
  searchRuntimeEntityNames,
} from '../routing/name-resolution';
import type { createRuntimeLoopApi } from './loop';
import type { CrossJurisdictionSwapRoute } from '../types/cross-jurisdiction';
import type { RuntimeReplica } from './types';
import type { EntityInput } from '../entity/types';
import {
  buildCrossJurisdictionSwapSubmission,
  type CrossJurisdictionSwapSubmitParams,
  type CrossJurisdictionSwapSubmitResult,
} from './jurisdiction-api';
import { assertRuntimeCommandReady } from './lifecycle';
import { assertCrossJLocalOwnerCohort, requireCrossJRuntimeTopology } from './cross-j-topology';
import { mergeEntityInputs } from '../entity/consensus';

type RuntimeCommandDependencies = Pick<
  ReturnType<typeof createRuntimeLoopApi>,
  'enqueueRuntimeInputs' | 'getRuntimeOutputRoutingDeps'
>;

export const searchEntityNames = (query: string, limit?: number) =>
  searchRuntimeEntityNames(null, query, limit);

export const resolveEntityName = (entityId: string) =>
  resolveRuntimeEntityName(null, entityId);

export const getEntityDisplayInfoFromProfile = (entityId: string) =>
  getRuntimeEntityDisplayInfo(null, entityId);

/** Commands enter the owning Runtime through its normal ingress/WAL path. */
export const createRuntimeCommandApi = (dependencies: RuntimeCommandDependencies) => {
  const submitCrossJurisdictionIntents = async (
    env: RuntimeReplica,
    routes: readonly CrossJurisdictionSwapRoute[],
  ): Promise<CrossJurisdictionSwapSubmitResult[]> => {
    assertRuntimeCommandReady(env);
    const routing = dependencies.getRuntimeOutputRoutingDeps();
    const sourceRuntimeId = normalizeRuntimeId(env.runtimeId);
    if (!sourceRuntimeId) throw new Error('CROSS_J_INTENT_SOURCE_RUNTIME_INVALID');
    const results: CrossJurisdictionSwapSubmitResult[] = [];
    const inputs = routes.flatMap<EntityInput>(route => {
      const canonicalRoute = withCanonicalCrossJurisdictionRouteHash(route);
      if (canonicalRoute.status !== 'intent' || canonicalRoute.sourcePull || canonicalRoute.targetPull) {
        throw new Error(`CROSS_J_INTENT_STATE_INVALID:${canonicalRoute.orderId}`);
      }
      assertCrossJLocalOwnerCohort(env, canonicalRoute, 'user', routing);
      assertCrossJurisdictionSwapTargetReadyInEnv(env, canonicalRoute);
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
      results.push({ route: canonicalRoute });
      // Target authorization remains first for every route. Coalescing identical
      // owners here is exactly the merge the Runtime reducer would perform, while
      // allowing callers to choose a bounded Entity frame that does not expose
      // per-offer scheduler timing as consensus boundaries.
      return [{
        entityId: canonicalRoute.target.counterpartyEntityId,
        signerId: targetSignerId,
        entityTxs: [{ type: 'prepareCrossJurisdictionSwap', data: { route: structuredClone(canonicalRoute) } }],
      },
      {
        entityId: canonicalRoute.source.entityId,
        signerId: sourceSignerId,
        entityTxs: [{ type: 'prepareCrossJurisdictionSwap', data: { route: structuredClone(canonicalRoute) } }],
      }];
    });
    if (inputs.length > 0) {
      dependencies.enqueueRuntimeInputs(
        env,
        mergeEntityInputs(inputs),
        undefined,
        undefined,
        env.state.timestamp,
      );
    }
    return results;
  };

  const submitCrossJurisdictionIntent = async (
    env: RuntimeReplica,
    route: CrossJurisdictionSwapRoute,
  ): Promise<CrossJurisdictionSwapSubmitResult> => {
    const [result] = await submitCrossJurisdictionIntents(env, [route]);
    if (!result) throw new Error('CROSS_J_INTENT_RESULT_MISSING');
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
