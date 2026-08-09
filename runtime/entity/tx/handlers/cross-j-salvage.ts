import {
  decodeHashLadderBinary,
  verifyHashLadderBinary,
} from '../../../protocol/htlc/hash-ladder';
import {
  queueHashLadderRevealRegistration,
  stashPendingRegistryReveal,
} from '../j-events-htlc';
import { prepareEntityTxState } from '../../state-clone';
import { addMessage } from '../../frame-events';
import type { RuntimeOverlayRecord } from '../../../types/account';
import type { EntityInput, EntityState } from '../../types';
import type { EntityRuntimeContext } from '../../runtime-context';
import type { EntityTx } from '../../../types/entity-tx';
import { normalizeEntityRef } from '../account-key';
import { isCrossJurisdictionTerminalStatus } from '../../../extensions/cross-j';
import type { CrossJurisdictionSwapRoute } from '../../../types/cross-jurisdiction';
import { isBatchEmpty } from '../../../jurisdiction/machine/batch';

type CrossJurisdictionSalvageTx = Extract<EntityTx, { type: 'crossJurisdictionSalvage' }>;

type CrossJurisdictionSalvageResult = {
  newState: EntityState;
  outputs: EntityInput[];
};

const queueSalvageJBatchBroadcast = (
  state: EntityState,
  outputs: EntityInput[],
  routeId: string,
): void => {
  const firstValidator = state.config.validators?.[0];
  if (!firstValidator) throw new Error(`CROSS_J_REVEAL_PORT_SIGNER_MISSING:${routeId}`);
  outputs.push({
    entityId: state.entityId,
    signerId: firstValidator,
    entityTxs: [{ type: 'j_broadcast', data: {} }],
  });
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
  _env: EntityRuntimeContext,
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
  if (isCrossJurisdictionTerminalStatus(route.status)) {
    // Reliable delivery may outlive the route it was created for. Finality is
    // authoritative: never resurrect pending registry work which could later
    // bind against an unrelated dispute on the same Account.
    return { newState, outputs };
  }
  const verifiedFillRatio = verifySalvageFillRatio(newState, route, routeId, binary, claimedFillRatio);
  if (verifiedFillRatio === null) return { newState, outputs };

  // No active-dispute gate exists here. This is independent Sprites-like
  // evidence; the later signed Pull alone decides whether the stored timestamp
  // falls inside its dispute window.

  const decoded = decodeHashLadderBinary(binary);
  const targetAccount = newState.accounts.get(normalizeEntityRef(route.target.entityId));
  if (!targetAccount?.activeDispute) {
    // Public registry evidence is independent of disputes on-chain, but a
    // Target Pull accepts it only inside the target beneficiary's signed
    // window. Publishing before S wastes gas and can settle as zero. Buffer
    // the verified witness until a local draft or observed dispute installs
    // the exact clock; the start path then co-bundles it when possible.
    stashPendingRegistryReveal(newState, route.target.entityId, route.targetPull, decoded, true);
    addMessage(
      newState,
      `⏳ Cross-j reveal port ${routeId}: waiting for the target dispute clock`,
    );
    return { newState, outputs };
  }
  const queued = queueHashLadderRevealRegistration(
    newState,
    route.target.entityId,
    route.targetPull,
    decoded,
    true,
  );
  if (queued === 'queued') {
    if (!newState.jBatchState?.sentBatch) {
      queueSalvageJBatchBroadcast(newState, outputs, routeId);
    }
    // A registration queued behind an immutable sentBatch is already durable:
    // queueHashLadderRevealRegistration latches autoBroadcastDraft, and the
    // exact Hanko ACK emits the one replacement continuation. Emitting here as
    // well would race that ACK and fail-stop on `sentBatch pending`.
    addMessage(
      newState,
      newState.jBatchState?.sentBatch
        ? `⏳ Cross-j reveal port ${routeId}: queued behind the pending jBatch`
        : `🌉 Cross-j reveal port ${routeId}: registering ratio ${verifiedFillRatio} on the target chain`,
    );
  } else if (queued === 'deferred-batch-pending') {
    // Only capacity can defer a verified witness here. The pending record stays
    // intact until a later bounded flush can place it in a contract-valid batch.
    // With no immutable sentBatch, this continuation must drain the full draft;
    // its exact ACK then flushes the pending witness and owns the successor.
    if (
      !newState.jBatchState?.sentBatch
      && newState.jBatchState
      && !isBatchEmpty(newState.jBatchState.batch)
    ) {
      queueSalvageJBatchBroadcast(newState, outputs, routeId);
    }
    addMessage(
      newState,
      `⏳ Cross-j reveal port ${routeId}: deferred until the pending jBatch is acknowledged`,
    );
  }
  return { newState, outputs };
};
