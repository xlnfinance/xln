import { assertCrossJurisdictionSwapTargetReadyInEnv } from '../account/swap-command-plan';
import { withCanonicalCrossJurisdictionRouteHash } from '../extensions/cross-j';
import { normalizeRuntimeId } from '../networking/runtime-id';
import { isDeliveryDelivered, requireDeliveryResult } from '../protocol/payments/delivery-result';
import {
  getRuntimeEntityDisplayInfo,
  resolveRuntimeEntityName,
  searchRuntimeEntityNames,
} from '../routing/name-resolution';
import type { createRuntimeLoopApi } from './loop';
import type {
  CrossJurisdictionSwapRoute,
  RuntimeState,
  RuntimeEntityInputsEnvelope,
} from '../types';
import {
  buildCrossJurisdictionSwapSubmission,
  type CrossJurisdictionSwapSubmitParams,
  type CrossJurisdictionSwapSubmitResult,
} from './jurisdiction-api';
import { assertRuntimeCommandReady } from './lifecycle';
import { ensureRuntimeState } from './runtime-state';

type RuntimeCommandDependencies = Pick<
  ReturnType<typeof createRuntimeLoopApi>,
  'getP2P' | 'getRuntimeOutputRoutingDeps'
>;

export const searchEntityNames = (query: string, limit?: number) =>
  searchRuntimeEntityNames(null, query, limit);

export const resolveEntityName = (entityId: string) =>
  resolveRuntimeEntityName(null, entityId);

export const getEntityDisplayInfoFromProfile = (entityId: string) =>
  getRuntimeEntityDisplayInfo(null, entityId);

/**
 * Commands cross the Runtime transport boundary but never mutate Runtime
 * state directly. The recipient's normal ingress/WAL path owns all effects.
 */
export const createRuntimeCommandApi = (dependencies: RuntimeCommandDependencies) => {
  const submitCrossJurisdictionIntent = async (
    env: RuntimeState,
    route: CrossJurisdictionSwapRoute,
  ): Promise<CrossJurisdictionSwapSubmitResult> => {
    assertRuntimeCommandReady(env);
    const canonicalRoute = withCanonicalCrossJurisdictionRouteHash(route);
    if (canonicalRoute.status !== 'intent' || canonicalRoute.sourcePull || canonicalRoute.targetPull) {
      throw new Error(`CROSS_J_INTENT_STATE_INVALID:${canonicalRoute.orderId}`);
    }
    assertCrossJurisdictionSwapTargetReadyInEnv(env, canonicalRoute);

    const targetRuntimeId = dependencies
      .getRuntimeOutputRoutingDeps()
      .resolveRuntimeIdForCrossJurisdictionEntity(
        env,
        canonicalRoute.source.counterpartyEntityId,
      );
    if (!targetRuntimeId) {
      throw new Error(
        `CROSS_J_INTENT_HUB_RUNTIME_UNKNOWN:${canonicalRoute.source.counterpartyEntityId}`,
      );
    }
    const sourceRuntimeId = normalizeRuntimeId(env.runtimeId);
    if (!sourceRuntimeId) throw new Error('CROSS_J_INTENT_SOURCE_RUNTIME_INVALID');

    const envelope: RuntimeEntityInputsEnvelope = {
      sourceRuntimeId,
      sourceRuntimeHeight: Math.max(0, Math.floor(Number(env.height || 0))),
      sourceRuntimeTimestamp: Math.max(0, Math.floor(Number(env.timestamp || 0))),
      entityInputs: [],
      crossJurisdictionIntent: structuredClone(canonicalRoute),
    };
    const direct = ensureRuntimeState(env).directEntityInputsDispatch;
    let delivery = direct
      ? requireDeliveryResult(
          direct(targetRuntimeId, envelope, envelope.sourceRuntimeTimestamp),
          'CROSS_J_INTENT_DIRECT_DELIVERY_INVALID',
        )
      : null;
    if (!delivery || !isDeliveryDelivered(delivery)) {
      const p2p = dependencies.getP2P(env);
      if (p2p) {
        delivery = requireDeliveryResult(
          p2p.enqueueEntityInputsDelivery(
            targetRuntimeId,
            envelope,
            envelope.sourceRuntimeTimestamp,
          ),
          'CROSS_J_INTENT_P2P_DELIVERY_INVALID',
        );
      }
    }
    if (!delivery) throw new Error('CROSS_J_INTENT_NOT_DELIVERED:NO_TRANSPORT');
    if (!isDeliveryDelivered(delivery)) {
      // M1 is intentionally best-effort. The caller may retry the same
      // orderId after reconnect; no hidden outbox is created here.
      throw new Error(`CROSS_J_INTENT_NOT_DELIVERED:${delivery.code}`);
    }
    return { route: canonicalRoute };
  };

  const submitCrossJurisdictionSwap = async (
    env: RuntimeState,
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
