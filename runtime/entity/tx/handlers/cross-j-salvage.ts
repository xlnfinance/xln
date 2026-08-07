import { isCrossJurisdictionPullExpired } from '../../../extensions/cross-j/index';
import {
  decodeHashLadderBinary,
  verifyHashLadderBinary,
} from '../../../protocol/htlc/hash-ladder';
import { queueHashLadderRevealRegistration } from '../j-events-htlc';
import { prepareEntityTxState } from '../../state-clone';
import { addMessage } from '../../frame-events';
import type { CrossJurisdictionSwapRoute } from '../../../types/cross-jurisdiction';
import type { RuntimeOverlayRecord } from '../../../types/account';
import type { EntityInput, EntityState } from '../../types';
import type { EntityRuntimeContext } from '../../runtime-context';
import type { EntityTx } from '../../../types/entity-tx';
import { normalizeEntityRef } from '../account-key';
import { deterministicEntityTimestamp } from '../../../orderbook/cross-j-orderbook';

type CrossJurisdictionSalvageTx = Extract<EntityTx, { type: 'crossJurisdictionSalvage' }>;

type CrossJurisdictionSalvageResult = {
  newState: EntityState;
  outputs: EntityInput[];
};

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
  env: EntityRuntimeContext,
  entityState: EntityState,
  entityTx: CrossJurisdictionSalvageTx,
  _storageChanges: RuntimeOverlayRecord[] = [],
  mutableFrameState = false,
): Promise<CrossJurisdictionSalvageResult> => {
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
  const route = newState.crossJurisdictionSwaps?.get(routeId);
  if (!route || normalizeEntityRef(route.target?.counterpartyEntityId) !== self) {
    addMessage(newState, `🌉 Cross-j reveal port ${routeId} skipped: route not owned here`);
    return { newState, outputs };
  }
  if (!route.targetPull) {
    // A route this entity owns without its target pull commitment is mirror
    // corruption; porting against it would register garbage. Stay loud.
    throw new Error(`CROSS_J_REVEAL_PORT_TARGET_PULL_MISSING:${routeId}:${newState.entityId}`);
  }
  const verifiedFillRatio = verifySalvageFillRatio(newState, route, routeId, binary, claimedFillRatio);
  if (verifiedFillRatio === null) return { newState, outputs };

  if (isCrossJurisdictionPullExpired(route, 'target', deterministicEntityTimestamp(newState, env))) {
    // A registration after the target deadline settles as 0 on-chain anyway;
    // spending gas on it is pointless. The barrier resolves the dispute at 0.
    addMessage(newState, `🌉 Cross-j reveal port ${routeId} skipped: target pull window closed`);
    return { newState, outputs };
  }

  const decoded = decodeHashLadderBinary(binary);
  const queued = queueHashLadderRevealRegistration(newState, route.targetPull, decoded, routeId);
  if (queued === 'queued') {
    const firstValidator = newState.config.validators?.[0];
    if (!firstValidator) throw new Error(`CROSS_J_REVEAL_PORT_SIGNER_MISSING:${routeId}`);
    outputs.push({
      entityId: newState.entityId,
      signerId: firstValidator,
      entityTxs: [{ type: 'j_broadcast', data: {} }],
    });
    addMessage(
      newState,
      `🌉 Cross-j reveal port ${routeId}: registering ratio ${verifiedFillRatio} on the target chain`,
    );
  }
  return { newState, outputs };
};
