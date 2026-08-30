import { haltRuntimeFailure } from "../../../protocol/errors/failure-taxonomy";

import type { CrossJurisdictionSwapRoute } from '../../../types/cross-jurisdiction';
import type { AccountTx } from '../../../types/account';
import type { EntityInput, EntityOutput, EntityState } from '../../types';
import type { EntityTx } from '../../../types/entity-tx';
import { crossJurisdictionRouteSigner } from '../../../extensions/cross-j/boundary';
import { buildCrossJurisdictionFillNoticeTx } from '../../../extensions/cross-j/fill-ack';

const normalizeEntityRef = (value: string): string => String(value || '').trim().toLowerCase();

export const crossJurisdictionRouteSignerHint = (
  route: CrossJurisdictionSwapRoute,
  entityId: string,
): string | null => crossJurisdictionRouteSigner(route, entityId);

export const buildCrossJurisdictionEntityOutput = (
  entityId: string,
  signerId: string | null | undefined,
  entityTxs: EntityTx[],
): EntityInput => {
  const normalizedEntityId = normalizeEntityRef(entityId);
  const normalizedSignerId = normalizeEntityRef(signerId || '');
  if (!normalizedEntityId || !normalizedSignerId) {
    throw haltRuntimeFailure("CROSS_J_ENTITY_OUTPUT_ROUTE_MISSING", `CROSS_J_ENTITY_OUTPUT_ROUTE_MISSING:${normalizedEntityId || 'entity'}:${normalizedSignerId || 'signer'}`);
  }

  // Cross-J routes commit every destination signer before either Account leg
  // can settle. Runtime resolves transport only after this Entity output is
  // committed; pure Entity replay never consults gossip or private keys.
  return {
    entityId: normalizedEntityId,
    signerId: normalizedSignerId,
    entityTxs,
  };
};

const buildCrossJurisdictionTargetFillNoticeOutput = (
  currentEntityState: EntityState,
  tx: Extract<AccountTx, { type: 'cross_swap_fill_ack' }>,
): EntityInput => {
  const route = currentEntityState.crossJurisdictionSwaps?.get(tx.data.offerId);
  if (!route) throw haltRuntimeFailure("CROSS_J_TARGET_PROGRESS_ROUTE_MISSING", `CROSS_J_TARGET_PROGRESS_ROUTE_MISSING:${tx.data.offerId}`);
  const current = normalizeEntityRef(currentEntityState.entityId);
  const sourceHub = normalizeEntityRef(route.source.counterpartyEntityId);
  if (current !== sourceHub) {
    throw haltRuntimeFailure("CROSS_J_TARGET_PROGRESS_SOURCE_HUB_REQUIRED", `CROSS_J_TARGET_PROGRESS_SOURCE_HUB_REQUIRED:${tx.data.offerId}:${current}:${sourceHub}`);
  }
  const targetHub = normalizeEntityRef(route.target.entityId);
  const targetSigner = normalizeEntityRef(route.targetHubSignerId || '');
  if (!targetHub || !targetSigner || targetHub === sourceHub) {
    throw haltRuntimeFailure("CROSS_J_TARGET_PROGRESS_ROUTE_INVALID", `CROSS_J_TARGET_PROGRESS_ROUTE_INVALID:${tx.data.offerId}:${sourceHub}:${targetHub}`);
  }
  return buildCrossJurisdictionEntityOutput(
    targetHub,
    targetSigner,
    [buildCrossJurisdictionFillNoticeTx(tx, route.source.entityId)],
  );
};

export const appendCrossJurisdictionTargetProgressAfterAdmission = (
  currentEntityState: EntityState,
  tx: Extract<AccountTx, { type: 'cross_swap_fill_ack' }>,
  outputs: EntityOutput[],
): void => {
  outputs.push(buildCrossJurisdictionTargetFillNoticeOutput(currentEntityState, tx));
};

/** Exact Account protocol output; publication revalidates its bilateral route. */
export const buildAccountEntityOutput = (
  entityId: string,
  signerId: string,
  entityTxs: EntityTx[],
): EntityInput => ({
  entityId: normalizeEntityRef(entityId),
  signerId: normalizeEntityRef(signerId),
  entityTxs,
});

export const pushCrossJurisdictionEntityOutput = (
  outputs: EntityInput[],
  entityId: string,
  entityTxs: EntityTx[],
  signerId: string | null | undefined,
): void => {
  outputs.push(buildCrossJurisdictionEntityOutput(entityId, signerId, entityTxs));
};
