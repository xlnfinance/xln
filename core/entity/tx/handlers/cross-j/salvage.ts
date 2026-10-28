import { haltRuntimeFailure } from "../../../../protocol/errors/failure-taxonomy";

import {
  decodeHashLadderBinary,
  verifyHashLadderBinary,
} from '../../../../protocol/htlc/hash-ladder';
import { hashTargetReveal } from '../../../../protocol/htlc/target-reveal';
import { parseJurisdictionStackIdentity } from '../../../../jurisdiction/machine/jurisdiction-stack';
import { getJurisdictionConfigName } from '../../../../jurisdiction/machine/jurisdiction-runtime';
import type { EntityTxReducerResult } from '../../apply';
import type { HashLadderRegistration } from '../../../../jurisdiction/machine/batch';
import { getEntityCollectionValueForWrite } from '../../../state/persistent-collection-map';
import { getEntityLeaderState } from '../../../consensus/leader';
import { prepareEntityTxState } from '../../../state-clone';
import { addMessage } from '../../../frame-events';
import type { EntityInput, EntityState } from '../../../types';
import type { EntityTx } from '../../../../types/entity-tx';
import { normalizeEntityRef } from '../../account-key';
import { isCrossJurisdictionTerminalStatus } from '../../../../extensions/cross-j';
import type { CrossJurisdictionSwapRoute } from '../../../../types/cross-jurisdiction';

type CrossJurisdictionSalvageTx = Extract<EntityTx, { type: 'crossJurisdictionSalvage' }>;

/**
 * Verify the ported reveal against the route's target-leg ladder commitment.
 *
 * The hash-ladder reveal is the single settlement authority for BOTH
 * jurisdictions. Off-chain fill progress is informational only (the hub saying
 * "matched X%" without secrets), so it may lag the actual fill and must never
 * veto a cryptographically verified reveal. The source chain verified this
 * material at registration time; this check is the local integrity assertion,
 * not a second authority.
 */
const verifySalvageFillRatio = (
  state: EntityState,
  route: CrossJurisdictionSwapRoute,
  routeId: string,
  binary: string,
  claimedFillRatio: number,
): number | null => {
  if (binary === '0x') {
    addMessage(state, `🌉 Cross-j reveal port ignored for ${routeId}: empty result`);
    return null;
  }
  let verifiedFillRatio: number;
  try {
    verifiedFillRatio = verifyHashLadderBinary({
      fullHash: route.targetPull!.fullHash,
      partialRoot: route.targetPull!.partialRoot,
    }, binary).fillRatio;
  } catch (error) {
    addMessage(state, `❌ Cross-j reveal port ${routeId} invalid pull binary: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
  if (verifiedFillRatio <= 0) {
    addMessage(state, `🌉 Cross-j reveal port ignored for ${routeId}: zero fill`);
    return null;
  }
  if (verifiedFillRatio !== claimedFillRatio) {
    addMessage(state, `❌ Cross-j reveal port ${routeId} fill mismatch: claimed ${claimedFillRatio}, verified ${verifiedFillRatio}`);
    return null;
  }
  return verifiedFillRatio;
};


/**
 * Target-side reveal port. The source-chain registration event is the only
 * recovery trigger: the hub cannot claim the source leg on-chain without
 * publishing portable proof, and this handler re-registers that exact material
 * on the target chain under this entity's own key. There is deliberately no
 * dispute-argument injection and no source-mirror commit anywhere in this path.
 */
export const handleCrossJurisdictionSalvageEntityTx = async (
  entityState: EntityState,
  entityTx: CrossJurisdictionSalvageTx,
  mutableFrameState = false,
): Promise<EntityTxReducerResult> => {
  const { routeId, binary, fillRatio } = entityTx.data;
  const newState = prepareEntityTxState(entityState, mutableFrameState);
  const outputs: EntityInput[] = [];
  const claimedFillRatio = Math.floor(Number(fillRatio) || 0);
  if (!binary || claimedFillRatio <= 0) {
    addMessage(newState, `🌉 Cross-j reveal port ignored for ${routeId}: invalid result`);
    return { newState, outputs };
  }

  // This handler serves exactly one role: the target user of the named route.
  const self = normalizeEntityRef(newState.entityId);
  const routes = newState.crossJurisdictionSwaps;
  const route = routes?.get(routeId);
  if (!routes || !route || normalizeEntityRef(route.target?.counterpartyEntityId) !== self) {
    addMessage(newState, `🌉 Cross-j reveal port ${routeId} skipped: route not owned here`);
    return { newState, outputs };
  }
  if (!route.targetPull) {
    // A route this entity owns without its target pull commitment is mirror
    // corruption; porting against it would register garbage. Stay loud.
    throw haltRuntimeFailure("CROSS_J_REVEAL_PORT_TARGET_PULL_MISSING", `CROSS_J_REVEAL_PORT_TARGET_PULL_MISSING:${routeId}:${newState.entityId}`);
  }
  if (isCrossJurisdictionTerminalStatus(route.status)) {
    // Reliable delivery may outlive the route it was created for. Finality is
    // authoritative: never resurrect pending registry work which could later
    // bind against an unrelated dispute on the same Account.
    return { newState, outputs };
  }
  const verifiedFillRatio = verifySalvageFillRatio(newState, route, routeId, binary, claimedFillRatio);
  if (verifiedFillRatio === null) return { newState, outputs };

  // A pending batch ACK may arrive after D_target. The beneficiary certifies
  // this immutable witness directly; the Runtime WAL outbox owns its retries.
  const existing = route.pendingTargetRegistryReveal?.fillRatio ?? route.targetRegistryFillRatio;
  if (existing !== undefined && existing > 0) {
    if (existing !== verifiedFillRatio) throw new Error('J_HASH_LADDER_REGISTRATION_CONFLICT');
    return { newState, outputs };
  }
  const decoded = decodeHashLadderBinary(binary);
  const zero = `0x${'00'.repeat(32)}`;
  const registration: HashLadderRegistration = {
    counterpartyEntity: route.target.entityId.toLowerCase(), targetRole: true,
    fullHash: route.targetPull.fullHash, partialRoot: route.targetPull.partialRoot,
    witness: { fillRatio: verifiedFillRatio, fullSecret: decoded.fullSecret ?? zero,
      reveals: decoded.reveals ?? [zero, zero, zero, zero] },
  };
  const domain = parseJurisdictionStackIdentity(route.target.jurisdiction);
  const jurisdictionName = getJurisdictionConfigName(newState.config.jurisdiction);
  const signerId = getEntityLeaderState(newState).activeValidatorId;
  if (!domain || !jurisdictionName || !signerId) throw new Error('CROSS_J_REVEAL_PORT_DOMAIN_MISSING');
  const revealHash = hashTargetReveal(domain.chainId, domain.depositoryAddress, self, registration);
  const writableRoute = getEntityCollectionValueForWrite(routes, routeId);
  if (!writableRoute) throw new Error('CROSS_J_REVEAL_PORT_ROUTE_MISSING');
  writableRoute.pendingTargetRegistryReveal = registration.witness;
  return { newState, outputs,
    jOutputs: [{ jurisdictionName, jTxs: [{ type: 'hashLadderReveal', entityId: self,
      data: { registration, revealHash, signerId }, timestamp: newState.timestamp }] }],
    hashesToSign: [{ hash: revealHash, type: 'hashLadderReveal', context: `targetReveal:${routeId}` }],
  };
};
