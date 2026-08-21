import { assertCrossJurisdictionSwapTargetReadyInEnv } from '../swap-cmd/swap-target-readiness';
import { withCanonicalCrossJurisdictionRouteHash } from '../../extensions/cross-j';
import { normalizeRuntimeId } from '../../network/p2p/auth/runtime-id';
import type { createRuntimeLoopApi } from '../loop/loop.ts';
import type { CrossJurisdictionSwapRoute } from '../../types/cross-jurisdiction';
import type { RuntimeReplica } from '../types';
import {
  buildCrossJurisdictionSwapSubmission,
  type CrossJurisdictionSwapSubmitParams,
  type CrossJurisdictionSwapSubmitResult,
} from '../j-submit/api';
import { assertRuntimeCommandReady } from '../replica/lifecycle';
import { assertCrossJLocalOwnerCohort, requireCrossJRuntimeTopology } from '../delivery/topology/cross-j-topology';

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
    const groups = new Map<string, PreparedCrossJurisdictionIntent[]>();
    for (const intent of prepared) {
      const key = [
        intent.route.source.entityId,
        intent.route.target.counterpartyEntityId,
        intent.sourceSignerId,
        intent.targetSignerId,
      ].join(':');
      const group = groups.get(key) ?? [];
      group.push(intent);
      groups.set(key, group);
    }
    // One RuntimeInput durably binds every cross-J book. Each owner cohort is
    // kept as an adjacent target/source pair because Runtime admission promotes
    // that pair atomically; different cohorts may share the same R-frame. Never
    // loop `submit -> wait` per route/book: every Entity first admits its whole
    // route array, then its end-of-input Account flush proposes once per Account.
    const compareText = (left: string, right: string): number =>
      left < right ? -1 : left > right ? 1 : 0;
    const entityInputs = [...groups.entries()]
      .sort(([left], [right]) => compareText(left, right))
      .flatMap(([, unsorted]) => {
        const intents = [...unsorted].sort((left, right) =>
          compareText(left.route.orderId, right.route.orderId));
        const target = intents[0];
        if (!target) throw new Error('CROSS_J_INTENT_BATCH_GROUP_EMPTY');
        const txs = intents.map(intent => ({
          type: 'prepareCrossJurisdictionSwap' as const,
          data: { route: structuredClone(intent.route) },
        }));
        return [{
          entityId: target.route.target.counterpartyEntityId,
          signerId: target.targetSignerId,
          entityTxs: txs.map(tx => structuredClone(tx)),
        }, {
          entityId: target.route.source.entityId,
          signerId: target.sourceSignerId,
          entityTxs: txs,
        }];
      });
    dependencies.enqueueRuntimeInputs(
      env,
      entityInputs,
      undefined,
      undefined,
      env.state.timestamp,
    );
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
