import { haltRuntimeFailure } from "../../../protocol/errors/failure-taxonomy";

import type { CrossJurisdictionSwapRoute } from '../../../types/cross-jurisdiction';
import type { EntityInput } from '../../types';
import type { EntityTx } from '../../../types/entity-tx';
import { crossJurisdictionRouteSigner } from '../../../extensions/cross-j/boundary';
import { buildCrossJurisdictionFillNoticeTx } from '../../../extensions/cross-j/fill-notice';
import type { CrossJurisdictionFillInstruction } from '../../../extensions/cross-j/orderbook';

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

/** Hub-internal fill progress from the canonical book owner to the source Hub. */
export const buildCrossJurisdictionFillNoticeOutput = (
  instruction: CrossJurisdictionFillInstruction,
): EntityInput => {
  const route = instruction.route;
  const sourceHub = normalizeEntityRef(route.source.counterpartyEntityId);
  const signerId = normalizeEntityRef(route.sourceHubSignerId || '');
  if (!sourceHub || !signerId) {
    throw haltRuntimeFailure("CROSS_J_FILL_NOTICE_SOURCE_HUB_MISSING", `CROSS_J_FILL_NOTICE_SOURCE_HUB_MISSING:${instruction.offerId}`);
  }
  return buildCrossJurisdictionEntityOutput(
    sourceHub,
    signerId,
    [buildCrossJurisdictionFillNoticeTx(instruction)],
  );
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
