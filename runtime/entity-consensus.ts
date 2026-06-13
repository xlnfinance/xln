/**
 * Entity consensus: validator replicas agree on entity frames, then route
 * committed account/J-layer side effects back into the runtime.
 */

import { applyEntityTx } from './entity-tx';
import type {
  AccountTx,
  ConsensusConfig,
  EntityInput,
  EntityReplica,
  EntityState,
  EntityTx,
  Env,
  HankoString,
  HashToSign,
  HashType,
  JInput,
} from './types';
import { DEBUG, HEAVY_LOGS, formatEntityDisplay, log } from './utils';
import { compareStableText, safeStringify } from './serialization-utils';
import { createStructuredLogger, logError, shortHash, shortId, shortOrder, shouldLogFullPayloads } from './logger';
import {
  addMessages,
  cloneEntityReplica,
  cloneEntityState,
  getAccountPerspective,
  emitScopedEvents,
  removeCommittedTxsFromMempool,
  resolveEntityProposerId,
  txFingerprint,
} from './state-helpers';
import { markStorageAccountDirty, markStorageEntityDirty, recordOrderbookPairUpdate } from './env-events';
import { LIMITS } from './constants';
import { signAccountFrame as signFrame, verifyAccountSignature as verifyFrame } from './account-crypto';
import {
  normalizeSwapOfferForOrderbook,
  processOrderbookSwaps,
  processOrderbookCancels,
  type SwapCancelEvent,
  type SwapCancelRequestEvent,
  type SwapOfferEvent,
} from './entity-tx/handlers/account';
import {
  markWorkingOrderbookOffer,
  swapKey,
  type NormalizedOrderbookOffer,
  type WorkingOrderbookOffer,
} from './swap-execution';
import { replaceOrderbookPair, type OrderbookExtState } from './orderbook';
import {
  executeCrontab,
  initCrontab,
  scheduleHook as scheduleCrontabHook,
  cancelHook as cancelCrontabHook,
} from './entity-crontab';
import {
  applyCommittedSwapCancelsToOrderbook,
  crossJurisdictionBookOwnerRef,
  deterministicEntityTimestamp,
  findAccountByCounterparty,
  findCrossJurisdictionBookAdmissionForAck,
  findEntityStateById,
  findSwapOfferOwnerState,
  getCrossJurisdictionBookAdmissionError,
  isCrossJurisdictionBookAdmissionPending,
  normalizeEntityRef,
} from './entity-consensus/cross-j-orderbook';
import { markCrossJurisdictionBookAdmissionResolving } from './cross-jurisdiction-orderbook';
import { createEntityFrameHash } from './entity-consensus-frame';
import {
  attachHankoWitnessToOutputs,
  buildEntityHashesToSign,
  isWitnessHashType,
  normalizeProposedFrameCollectedSigs,
  type HankoWitnessEntry,
} from './entity-consensus/hanko-witness';
import { cloneCrossJurisdictionAccountTxRoute } from './cross-jurisdiction';
import { buildCrossJurisdictionFillId, CROSS_J_PENDING_FILL_ACK_TTL_MS } from './cross-jurisdiction-fill-ack';
export { mergeEntityInputs } from './entity-input-merge';
export { createEntityFrameHash } from './entity-consensus-frame';
export { CROSS_J_PENDING_FILL_ACK_TTL_MS } from './cross-jurisdiction-fill-ack';
const entityLog = createStructuredLogger('entity');

function queueUniqueAccountMempoolTx(
  account: EntityState['accounts'] extends Map<string, infer T> ? T : never,
  tx: EntityState['accounts'] extends Map<string, infer T>
    ? T extends { mempool: Array<infer A> }
      ? A
      : never
    : never,
): boolean {
  const fp = txFingerprint(tx);
  for (const existing of account.mempool) {
    if (txFingerprint(existing) === fp) return false;
  }
  for (const pendingTx of account.pendingFrame?.accountTxs ?? []) {
    if (txFingerprint(pendingTx) === fp) return false;
  }
  account.mempool.push(tx);
  return true;
}

type EntityAccountMachine = EntityState['accounts'] extends Map<string, infer T> ? T : never;
type CrossSwapFillAckTx = Extract<AccountTx, { type: 'cross_swap_fill_ack' }>;
type CrossJurisdictionFillNoticeTx = Extract<EntityTx, { type: 'crossJurisdictionFillNotice' }>;

const hasQueuedOrderLifecycleTx = (account: EntityAccountMachine, offerId: string): boolean => {
  for (const tx of account.mempool ?? []) {
    if (
      (tx.type === 'swap_resolve' || tx.type === 'cross_swap_fill_ack' || tx.type === 'swap_cancel_request') &&
      tx.data.offerId === offerId
    ) {
      return true;
    }
  }
  for (const tx of account.pendingFrame?.accountTxs ?? []) {
    if (
      (tx.type === 'swap_resolve' || tx.type === 'cross_swap_fill_ack' || tx.type === 'swap_cancel_request') &&
      tx.data.offerId === offerId
    ) {
      return true;
    }
  }
  return false;
};

const fallbackFrameHashToSign = (hash: string, height: number): HashToSign[] => [{
  hash,
  type: 'entityFrame',
  context: `entity-frame:${height}`,
}];

const verifyHashPrecommitSignatures = (
  env: Env,
  signerId: string,
  hashesToSign: HashToSign[] | undefined,
  frameHash: string,
  frameHeight: number,
  sigs: string[],
  context: string,
): boolean => {
  const expectedHashes = hashesToSign?.length
    ? hashesToSign
    : fallbackFrameHashToSign(frameHash, frameHeight);
  if (sigs.length !== expectedHashes.length) {
    log.error(
      `❌ ${context}: signature count mismatch from ${signerId}: got ${sigs.length}, expected ${expectedHashes.length}`,
    );
    return false;
  }
  for (let i = 0; i < expectedHashes.length; i++) {
    const hashInfo = expectedHashes[i];
    const sig = sigs[i];
    if (!hashInfo || !sig) {
      log.error(`❌ ${context}: missing signature[${i}] from ${signerId}`);
      return false;
    }
    if (!verifyFrame(env, signerId, hashInfo.hash, sig)) {
      log.error(
        `❌ ${context}: invalid ${hashInfo.type} signature[${i}] from ${signerId} ` +
          `hash=${hashInfo.hash.slice(0, 30)}... context=${hashInfo.context}`,
      );
      return false;
    }
  }
  return true;
};

const buildCrossJurisdictionFillNoticeTx = (tx: CrossSwapFillAckTx, accountId: string): CrossJurisdictionFillNoticeTx => {
  const fillSeq = Math.floor(Number(tx.data.fillSeq ?? 0));
  const cumulativeFillRatio = Math.floor(Number(tx.data.cumulativeFillRatio ?? 0));
  if (fillSeq <= 0 || cumulativeFillRatio <= 0) {
    throw new Error(
      `CROSS_J_FILL_ACK_INVALID_NOTICE: account=${accountId} offer=${tx.data.offerId} ` +
        `fillSeq=${fillSeq} ratio=${cumulativeFillRatio}`,
    );
  }
  return {
    type: 'crossJurisdictionFillNotice',
    data: {
      orderId: tx.data.offerId,
      ...(tx.data.routeHash ? { routeHash: tx.data.routeHash } : {}),
      ...(tx.data.previousFillSeq !== undefined ? { previousFillSeq: Math.floor(Number(tx.data.previousFillSeq)) } : {}),
      fillSeq,
      incrementalSourceAmount: tx.data.incrementalSourceAmount ?? tx.data.executionSourceAmount ?? 0n,
      incrementalTargetAmount: tx.data.incrementalTargetAmount ?? tx.data.executionTargetAmount ?? 0n,
      cumulativeSourceAmount: tx.data.cumulativeSourceAmount ?? 0n,
      cumulativeTargetAmount: tx.data.cumulativeTargetAmount ?? 0n,
      cumulativeFillRatio,
      ...(tx.data.fillNumerator !== undefined ? { fillNumerator: tx.data.fillNumerator } : {}),
      ...(tx.data.fillDenominator !== undefined ? { fillDenominator: tx.data.fillDenominator } : {}),
      ...(tx.data.priceImprovementMode ? { priceImprovementMode: tx.data.priceImprovementMode } : {}),
      ...(tx.data.priceImprovementAmount !== undefined ? { priceImprovementAmount: tx.data.priceImprovementAmount } : {}),
      ...(tx.data.priceImprovementTokenId !== undefined ? { priceImprovementTokenId: tx.data.priceImprovementTokenId } : {}),
      ...(tx.data.cancelRemainder !== undefined ? { cancelRemainder: tx.data.cancelRemainder } : {}),
      ...(tx.data.priceTicks !== undefined ? { priceTicks: tx.data.priceTicks } : {}),
      pairId: String(tx.data.pairId || ''),
    },
  };
};

const buildCrossJurisdictionAdmissionFillNoticeOutput = (
  env: Env,
  currentEntityState: EntityState,
  accountId: string,
  tx: CrossSwapFillAckTx,
): EntityInput | null => {
  const admission = findCrossJurisdictionBookAdmissionForAck(
    currentEntityState,
    accountId,
    tx.data.offerId,
    tx.data.routeHash,
  );
  if (!admission) return null;
  if (admission.status === 'closed' || admission.status === 'resolving') return null;
  const sourceHubEntityId = normalizeEntityRef(admission.route.source.counterpartyEntityId);
  if (!sourceHubEntityId) {
    throw new Error(`CROSS_J_FILL_ACK_SOURCE_HUB_MISSING: account=${accountId} offer=${tx.data.offerId}`);
  }
  if (sourceHubEntityId === normalizeEntityRef(currentEntityState.entityId)) return null;
  const sourceHubState = findEntityStateById(env, sourceHubEntityId);
  const hintedSignerRaw = String(admission.route.sourceHubSignerId || '');
  const hintedSignerId = normalizeEntityRef(hintedSignerRaw);
  if (!sourceHubState && !hintedSignerId) {
    throw new Error(
      `CROSS_J_FILL_ACK_SOURCE_HUB_SIGNER_MISSING: account=${accountId} offer=${tx.data.offerId} ` +
      `sourceHub=${sourceHubEntityId}`,
    );
  }
  const sourceHubValidators = sourceHubState?.config?.validators ?? [];
  const normalizedSourceHubValidators = sourceHubValidators.map(normalizeEntityRef).filter(Boolean);
  if (
    sourceHubState &&
    hintedSignerId &&
    !normalizedSourceHubValidators.includes(hintedSignerId)
  ) {
    throw new Error(
      `CROSS_J_FILL_ACK_SOURCE_HUB_SIGNER_MISMATCH: account=${accountId} offer=${tx.data.offerId} ` +
      `sourceHub=${sourceHubState.entityId} hint=${hintedSignerRaw} ` +
      `validators=[${sourceHubValidators.join(',')}]`,
    );
  }
  const signerId = hintedSignerRaw ||
    sourceHubValidators[0] ||
    (sourceHubState ? resolveEntityProposerId(env, sourceHubState.entityId, 'cross-j fill notice source hub') : '');
  return {
    entityId: sourceHubState?.entityId || sourceHubEntityId,
    signerId,
    entityTxs: [buildCrossJurisdictionFillNoticeTx(tx, accountId)],
  };
};

const buildCrossJurisdictionFillNoticeOutput = (
  env: Env,
  currentEntityState: EntityState,
  accountId: string,
  tx: CrossSwapFillAckTx,
): EntityInput | null => {
  const admissionOutput = buildCrossJurisdictionAdmissionFillNoticeOutput(env, currentEntityState, accountId, tx);
  if (admissionOutput) return admissionOutput;

  const ownerState = findSwapOfferOwnerState(env, currentEntityState, accountId, tx.data.offerId);
  if (!ownerState) return null;
  const firstValidator = ownerState.config?.validators?.[0];
  if (!firstValidator) {
    throw new Error(
      `CROSS_J_FILL_ACK_OWNER_SIGNER_MISSING: account=${accountId} offer=${tx.data.offerId} ` +
        `owner=${ownerState.entityId}`,
    );
  }
  return {
    entityId: ownerState.entityId,
    signerId: firstValidator,
    entityTxs: [buildCrossJurisdictionFillNoticeTx(tx, accountId)],
  };
};

const pendingCrossJurisdictionFillAckKey = (accountId: string, tx: CrossSwapFillAckTx): string =>
  [
    normalizeEntityRef(accountId),
    tx.data.offerId,
    Math.floor(Number(tx.data.fillSeq ?? 0)),
    Math.floor(Number(tx.data.cumulativeFillRatio ?? 0)),
    tx.data.cumulativeSourceAmount?.toString() ?? '',
    tx.data.cumulativeTargetAmount?.toString() ?? '',
  ].join('|');

const ownsSourceHubRouteForFillAck = (
  currentEntityState: EntityState,
  tx: CrossSwapFillAckTx,
): boolean => {
  const route = currentEntityState.crossJurisdictionSwaps?.get(tx.data.offerId);
  if (!route) return false;
  return normalizeEntityRef(route.source.counterpartyEntityId) === normalizeEntityRef(currentEntityState.entityId);
};

const stashPendingCrossJurisdictionFillAck = (
  env: Env,
  currentEntityState: EntityState,
  accountId: string,
  tx: CrossSwapFillAckTx,
  reason: string,
): void => {
  currentEntityState.pendingCrossJurisdictionFillAcks ||= new Map();
  const key = pendingCrossJurisdictionFillAckKey(accountId, tx);
  if (currentEntityState.pendingCrossJurisdictionFillAcks.has(key)) return;
  currentEntityState.pendingCrossJurisdictionFillAcks.set(key, {
    accountId,
    tx: cloneCrossJurisdictionAccountTxRoute(tx) as CrossSwapFillAckTx,
    storedAt: currentEntityState.timestamp || env.timestamp,
    reason,
  });
  markStorageEntityDirty(env, currentEntityState.entityId);
  entityLog.info('crossj.fill_ack_deferred', {
    entity: shortId(currentEntityState.entityId, 8),
    account: shortId(accountId, 8),
    offer: shortOrder(tx.data.offerId, 8),
    reason,
  });
};

const drainPendingCrossJurisdictionFillAcks = (
  env: Env,
  currentEntityState: EntityState,
  proposableAccounts: Set<string>,
): number => {
  const pending = currentEntityState.pendingCrossJurisdictionFillAcks;
  if (!pending || pending.size === 0) return 0;
  const now = Number(currentEntityState.timestamp || env.timestamp || 0);
  let drained = 0;
  for (const [key, pendingAck] of Array.from(pending.entries()).sort(([a], [b]) => compareStableText(a, b))) {
    const ageMs = Math.max(0, now - Number(pendingAck.storedAt || 0));
    if (ageMs > CROSS_J_PENDING_FILL_ACK_TTL_MS) {
      const payload = {
        entityId: currentEntityState.entityId,
        accountId: pendingAck.accountId,
        offerId: pendingAck.tx.data.offerId,
        routeHash: pendingAck.tx.data.routeHash || '',
        fillSeq: pendingAck.tx.data.fillSeq,
        previousFillSeq: pendingAck.tx.data.previousFillSeq,
        fillId: buildCrossJurisdictionFillId({
          routeHash: pendingAck.tx.data.routeHash || '',
          offerId: pendingAck.tx.data.offerId,
          ...(pendingAck.tx.data.fillSeq !== undefined ? { fillSeq: pendingAck.tx.data.fillSeq } : {}),
          cumulativeFillRatio: pendingAck.tx.data.cumulativeFillRatio,
          ...(pendingAck.tx.data.cumulativeSourceAmount !== undefined
            ? { cumulativeSourceAmount: pendingAck.tx.data.cumulativeSourceAmount }
            : {}),
          ...(pendingAck.tx.data.cumulativeTargetAmount !== undefined
            ? { cumulativeTargetAmount: pendingAck.tx.data.cumulativeTargetAmount }
            : {}),
        }),
        ackKind: pendingAck.tx.data.ackKind || (pendingAck.tx.data.cancelRemainder ? 'cancel_or_fill' : 'fill'),
        cumulativeFillRatio: pendingAck.tx.data.cumulativeFillRatio,
        cumulativeSourceAmount: pendingAck.tx.data.cumulativeSourceAmount?.toString() ?? '',
        cumulativeTargetAmount: pendingAck.tx.data.cumulativeTargetAmount?.toString() ?? '',
        fillNumerator: pendingAck.tx.data.fillNumerator?.toString() ?? '',
        fillDenominator: pendingAck.tx.data.fillDenominator?.toString() ?? '',
        storedAt: pendingAck.storedAt,
        ageMs,
        ttlMs: CROSS_J_PENDING_FILL_ACK_TTL_MS,
        reason: pendingAck.reason ?? 'unknown',
        repairProtocol: {
          classification: 'unexpected_cross_j_fill_ack_without_local_source_offer',
          preserveEvidence: true,
          operatorAction: 'Inspect the source-hub route, account swapOffers, pending frames, and book-owner admission before replaying or voiding this order.',
          forbiddenAction: 'Do not delete this pending ack silently; it is evidence for a possible cross-j state divergence.',
        },
      };
      entityLog.error('crossj.fill_ack_expired_fatal', payload);
      throw new Error(`CROSS_J_FILL_ACK_EXPIRED_FATAL: ${safeStringify(payload)}`);
    }
    const account = currentEntityState.accounts.get(pendingAck.accountId);
    if (!account?.swapOffers?.has(pendingAck.tx.data.offerId)) continue;
    if (queueUniqueAccountMempoolTx(account, pendingAck.tx)) {
      proposableAccounts.add(pendingAck.accountId);
      markStorageAccountDirty(env, currentEntityState.entityId, pendingAck.accountId);
    }
    pending.delete(key);
    drained++;
    markStorageEntityDirty(env, currentEntityState.entityId);
    entityLog.info('crossj.fill_ack_drained', {
      entity: shortId(currentEntityState.entityId, 8),
      account: shortId(pendingAck.accountId, 8),
      offer: shortOrder(pendingAck.tx.data.offerId, 8),
      storedAt: pendingAck.storedAt,
    });
  }
  return drained;
};

const assertCommittedSwapOfferMatchesEvent = (
  state: EntityState,
  offer: NormalizedOrderbookOffer,
): EntityAccountMachine => {
  const account = findAccountByCounterparty(state, offer.accountId);
  const committedOffer = account?.swapOffers?.get(offer.offerId);
  if (!account || !committedOffer) {
    throw new Error(`ORDERBOOK_ORDER_NOT_COMMITTED: account=${offer.accountId} offer=${offer.offerId}`);
  }
  if (hasQueuedOrderLifecycleTx(account, offer.offerId)) {
    throw new Error(`ORDERBOOK_ORDER_NOT_READY: account=${offer.accountId} offer=${offer.offerId}`);
  }
  const committedPriceTicks = committedOffer.priceTicks ?? offer.priceTicks;
  if (
    committedOffer.giveTokenId !== offer.giveTokenId ||
    committedOffer.wantTokenId !== offer.wantTokenId ||
    (committedOffer.quantizedGive ?? committedOffer.giveAmount) !== (offer.quantizedGive ?? offer.giveAmount) ||
    (committedOffer.quantizedWant ?? committedOffer.wantAmount) !== (offer.quantizedWant ?? offer.wantAmount) ||
    committedPriceTicks !== offer.priceTicks ||
    committedOffer.makerIsLeft !== offer.makerIsLeft ||
    Boolean(committedOffer.crossJurisdiction) !== Boolean(offer.crossJurisdiction)
  ) {
    throw new Error(`ORDERBOOK_ORDER_COMMITTED_MISMATCH: account=${offer.accountId} offer=${offer.offerId}`);
  }
  return account;
};

const assertSameJurisdictionOrderHoldCommitted = (
  account: EntityAccountMachine,
  offer: NormalizedOrderbookOffer,
): void => {
  const committedOffer = account.swapOffers.get(offer.offerId);
  if (!committedOffer) {
    throw new Error(`ORDERBOOK_ORDER_NOT_COMMITTED: account=${offer.accountId} offer=${offer.offerId}`);
  }
  const delta = account.deltas?.get(committedOffer.giveTokenId);
  const requiredHold = committedOffer.quantizedGive ?? committedOffer.giveAmount;
  const committedHold = committedOffer.makerIsLeft ? (delta?.leftHold ?? 0n) : (delta?.rightHold ?? 0n);
  if (requiredHold <= 0n || committedHold < requiredHold) {
    throw new Error(
      `ORDERBOOK_ORDER_HOLD_NOT_COMMITTED: account=${offer.accountId} offer=${offer.offerId} ` +
        `required=${requiredHold.toString()} committed=${committedHold.toString()}`,
    );
  }
};

const admitOrderbookOfferForMatching = (
  env: Env,
  state: EntityState,
  offer: NormalizedOrderbookOffer,
): WorkingOrderbookOffer | null => {
  if (offer.crossJurisdiction) {
    const crossStatus = offer.crossJurisdiction.status;
    if (crossStatus !== 'resting' && crossStatus !== 'partially_filled') {
      throw new Error(`CROSS_J_ORDERBOOK_ROUTE_NOT_WORKING: offer=${offer.offerId} status=${crossStatus}`);
    }
    const account = findAccountByCounterparty(state, offer.accountId);
    if ((account?.status ?? 'active') !== 'active') return null;
    if (account?.swapOffers?.has(offer.offerId)) {
      assertCommittedSwapOfferMatchesEvent(state, offer);
    }
    // Cross-j orders are allowed into the shared matcher only after both
    // bilateral account frames committed their source/target pull_lock receipts.
    const admissionError = getCrossJurisdictionBookAdmissionError(
      state,
      offer.crossJurisdiction,
      deterministicEntityTimestamp(state, env),
    );
    if (admissionError) {
      if (isCrossJurisdictionBookAdmissionPending(admissionError)) {
        entityLog.debug('crossj.orderbook.admission_pending', {
          offer: shortOrder(offer.offerId, 8),
          reason: admissionError,
        });
        return null;
      }
      throw new Error(admissionError);
    }
  } else {
    const account = assertCommittedSwapOfferMatchesEvent(state, offer);
    if ((account.status ?? 'active') !== 'active') return null;
    assertSameJurisdictionOrderHoldCommitted(account, offer);
  }
  return markWorkingOrderbookOffer(offer);
};

/**
 * Get previous frame hash from entity state.
 * Genesis if height=0, otherwise hash from last committed frame.
 */
function getPrevFrameHash(state: EntityState): string {
  if (state.height === 0) return 'genesis';
  if (typeof state.prevFrameHash === 'string' && state.prevFrameHash.length > 0) {
    return state.prevFrameHash;
  }
  throw new Error(
    `ENTITY_FRAME_CHAIN_CORRUPTED: missing prevFrameHash at height=${state.height} entity=${state.entityId}`,
  );
}

// === SECURITY VALIDATION ===

/**
 * Validates entity input to prevent malicious or corrupted data
 */
const validateEntityInput = (input: EntityInput): boolean => {
  try {
    // Basic required fields
    if (!input.entityId || typeof input.entityId !== 'string') {
      log.error(`❌ Invalid entityId: ${input.entityId}`);
      return false;
    }
    // EntityTx validation
    if (input.entityTxs) {
      if (!Array.isArray(input.entityTxs)) {
        log.error(`❌ EntityTxs must be array, got: ${typeof input.entityTxs}`);
        return false;
      }
      if (input.entityTxs.length > 1000) {
        log.error(`❌ Too many transactions: ${input.entityTxs.length} > 1000`);
        return false;
      }
      for (const tx of input.entityTxs) {
        if (!tx.type || !tx.data) {
          log.error(`❌ Invalid transaction: ${safeStringify(tx)}`);
          return false;
        }
        // Type system ensures tx.type is always a string literal
      }
    }

    // HashPrecommits validation (multi-hash signatures)
    if (input.hashPrecommits) {
      if (!(input.hashPrecommits instanceof Map)) {
        log.error(`❌ HashPrecommits must be Map, got: ${typeof input.hashPrecommits}`);
        return false;
      }
      if (input.hashPrecommits.size > 100) {
        log.error(`❌ Too many hashPrecommits: ${input.hashPrecommits.size} > 100`);
        return false;
      }
      for (const [signerId, sigs] of input.hashPrecommits) {
        if (typeof signerId !== 'string' || !Array.isArray(sigs)) {
          log.error(`❌ Invalid hashPrecommit format: ${signerId} -> ${typeof sigs}`);
          return false;
        }
      }
    }

    // ProposedFrame validation
    if (input.proposedFrame) {
      const frame = input.proposedFrame;
      if (typeof frame.height !== 'number' || frame.height < 0) {
        log.error(`❌ Invalid frame height: ${frame.height}`);
        return false;
      }
      if (!Array.isArray(frame.txs)) {
        log.error(`❌ Frame txs must be array`);
        return false;
      }
      if (!frame.hash || typeof frame.hash !== 'string') {
        log.error(`❌ Invalid frame hash: ${frame.hash}`);
        return false;
      }
    }

    return true;
  } catch (error) {
    log.error(`❌ Input validation error: ${error}`);
    return false;
  }
};

/**
 * Validates entity replica to prevent corrupted state
 */
const validateEntityReplica = (replica: EntityReplica): boolean => {
  try {
    if (!replica.entityId || !replica.signerId) {
      log.error(`❌ Invalid replica IDs: ${replica.entityId}:${replica.signerId}`);
      return false;
    }
    if (replica.state.height < 0) {
      log.error(`❌ Invalid state height: ${replica.state.height}`);
      return false;
    }
    if (replica.mempool.length > LIMITS.MEMPOOL_SIZE) {
      log.error(`❌ Mempool overflow: ${replica.mempool.length} > ${LIMITS.MEMPOOL_SIZE}`);
      return false;
    }
    return true;
  } catch (error) {
    log.error(`❌ Replica validation error: ${error}`);
    return false;
  }
};

/**
 * Validates voting power to prevent overflow attacks
 */
const validateVotingPower = (power: bigint): boolean => {
  try {
    if (power < 0n) {
      log.error(`❌ Negative voting power: ${power}`);
      return false;
    }
    // Check for overflow (2^53 - 1 in bigint)
    if (power > BigInt(Number.MAX_SAFE_INTEGER)) {
      log.error(`❌ Voting power overflow: ${power} > ${Number.MAX_SAFE_INTEGER}`);
      return false;
    }
    return true;
  } catch (error) {
    log.error(`❌ Voting power validation error: ${error}`);
    return false;
  }
};

// === CORE ENTITY PROCESSING ===

/**
 * Main entity input processor - handles consensus, proposals, and state transitions
 */
export const applyEntityInput = async (
  env: Env,
  entityReplica: EntityReplica,
  entityInput: EntityInput,
): Promise<{ newState: EntityState; outputs: EntityInput[]; jOutputs: JInput[]; workingReplica: EntityReplica }> => {
  // IMMUTABILITY: Clone replica at function start (fintech-safe, hacker-proof)
  // Prevents state mutations from escaping function scope
  const workingReplica = cloneEntityReplica(entityReplica);
  normalizeProposedFrameCollectedSigs(entityInput.proposedFrame);

  const entityDisplay = formatEntityDisplay(entityInput.entityId);
  const timestamp = env.timestamp;
  const quietRuntimeLogs = env.quietRuntimeLogs === true;
  const currentProposalHash = workingReplica.proposal?.hash?.slice(0, 10) || 'none';
  const frameHash = entityInput.proposedFrame?.hash?.slice(0, 10) || 'none';

  if (!quietRuntimeLogs) {
    const hasInputActivity = Boolean(
      (entityInput.entityTxs?.length ?? 0) > 0 || entityInput.proposedFrame || entityInput.hashPrecommits?.size,
    );
    const logInputReceived = hasInputActivity ? entityLog.info : entityLog.debug;
    logInputReceived('input.received', {
      entity: entityDisplay,
      signer: shortId(workingReplica.signerId),
      ts: timestamp,
      txs: entityInput.entityTxs?.map(tx => tx.type) ?? [],
      mempool: workingReplica.mempool.length,
      proposer: workingReplica.isProposer,
      proposal: currentProposalHash,
      frame: frameHash,
      precommits: entityInput.hashPrecommits?.size || 0,
    });
  }
  if (entityInput.hashPrecommits?.size) {
    const precommitSigners = Array.from(entityInput.hashPrecommits.keys());
    if (HEAVY_LOGS) entityLog.debug('input.precommits', { signers: precommitSigners.map(shortId) });
  }

  // SECURITY: Validate all inputs
  if (!validateEntityInput(entityInput)) {
    const detail = `entityId=${entityInput.entityId} txs=${entityInput.entityTxs?.map(tx => tx.type).join(',') || 'none'}`;
    log.error(`❌ Invalid input for ${entityInput.entityId}: ${detail}`);
    return { newState: workingReplica.state, outputs: [], jOutputs: [], workingReplica };
  }
  if (!validateEntityReplica(workingReplica)) {
    log.error(`❌ Invalid replica state for ${workingReplica.entityId}:${workingReplica.signerId}`);
    return { newState: workingReplica.state, outputs: [], jOutputs: [], workingReplica };
  }

  const entityOutbox: EntityInput[] = [];
  const jOutbox: JInput[] = []; // J-layer outputs

  // Proposer advances entity timestamp from its own wall clock (source of truth).
  // This ensures crontab and hooks see current time, even when no frame is produced.
  // Validators will receive the proposer's timestamp in the frame when frames ARE created.
  if (!env.scenarioMode) {
    if (workingReplica.state.timestamp !== env.timestamp) {
      workingReplica.state.timestamp = env.timestamp;
      markStorageEntityDirty(env, workingReplica.state.entityId);
    }
  }

  // Initialize crontab on first use
  if (!workingReplica.state.crontabState) {
    workingReplica.state.crontabState = initCrontab();
    markStorageEntityDirty(env, workingReplica.state.entityId);
  }

  const hasManualBroadcast = Boolean(entityInput.entityTxs?.some(tx => tx.type === 'j_broadcast'));
  const crontabOutputs = await executeCrontab(env, workingReplica, workingReplica.state.crontabState, {
    manualBroadcastInInput: hasManualBroadcast,
  });
  if (crontabOutputs.length > 0) {
    entityLog.debug('crontab.outputs', { count: crontabOutputs.length });
    entityOutbox.push(...crontabOutputs);
  }

  // Add transactions to mempool (mutable for performance)
  if (entityInput.entityTxs?.length) {
    const voteTransactions = entityInput.entityTxs.filter(tx => tx.type === 'vote');
    if (voteTransactions.length > 0) {
      entityLog.debug('vote.mempool', { signer: shortId(workingReplica.signerId), count: voteTransactions.length });
      if (shouldLogFullPayloads()) entityLog.trace('vote.payload', { txs: voteTransactions });
    }

    if (shouldLogFullPayloads()) {
      for (const tx of entityInput.entityTxs) {
        entityLog.trace('tx.payload', { type: tx.type, data: tx.data });
      }
    }
    workingReplica.mempool.push(...entityInput.entityTxs);
    entityLog.debug('mempool.added', {
      added: entityInput.entityTxs.length,
      total: workingReplica.mempool.length,
    });
  }

  // Forward before handling commits so fresh validator txs cannot be cleared by a
  // commit notification in the same tick.
  if (!workingReplica.isProposer && workingReplica.mempool.length > 0) {
    const proposerId = workingReplica.state.config.validators[0];
    if (!proposerId) {
      logError('FRAME_CONSENSUS', `❌ No proposer found in validators: ${workingReplica.state.config.validators}`);
      return { newState: workingReplica.state, outputs: entityOutbox, jOutputs: jOutbox, workingReplica };
    }

    const txCount = workingReplica.mempool.length;
    entityOutbox.push({
      entityId: entityInput.entityId,
      signerId: proposerId,
      entityTxs: [...workingReplica.mempool],
    });

    entityLog.debug('mempool.forwarded_to_proposer', { txs: txCount, proposer: shortId(proposerId) });
  }

  // Commit notifications carry a proposedFrame with collected quorum signatures.
  const frameCollectedSigs = entityInput.proposedFrame?.collectedSigs;
  if (frameCollectedSigs?.size && entityInput.proposedFrame && !workingReplica.proposal) {
    const signers = Array.from(frameCollectedSigs.keys());
    const totalPower = calculateQuorumPower(workingReplica.state.config, signers);

    if (totalPower >= workingReplica.state.config.threshold) {
      if (workingReplica.lockedFrame) {
        if (workingReplica.lockedFrame.hash !== entityInput.proposedFrame.hash) {
          logError('FRAME_CONSENSUS', `❌ BYZANTINE: Commit frame doesn't match locked frame!`);
          logError('FRAME_CONSENSUS', `   Locked: ${workingReplica.lockedFrame.hash}`);
          logError('FRAME_CONSENSUS', `   Commit: ${entityInput.proposedFrame.hash}`);
          return { newState: workingReplica.state, outputs: entityOutbox, jOutputs: jOutbox, workingReplica };
        }
        entityLog.debug('commit.locked_frame_verified', { frame: shortHash(workingReplica.lockedFrame.hash) });
      }

      for (const [signerId, sigs] of frameCollectedSigs) {
        if (!verifyHashPrecommitSignatures(
          env,
          signerId,
          entityInput.proposedFrame.hashesToSign,
          entityInput.proposedFrame.hash,
          entityInput.proposedFrame.height,
          sigs,
          'COMMIT_REJECTED',
        )) {
          logError('FRAME_CONSENSUS', `❌ BYZANTINE: Invalid hash signature bundle from ${signerId}`);
          logError('FRAME_CONSENSUS', `   Frame hash: ${entityInput.proposedFrame.hash.slice(0, 30)}...`);
          return { newState: workingReplica.state, outputs: entityOutbox, jOutputs: jOutbox, workingReplica };
        }
      }
      entityLog.debug('commit.signatures_verified', {
        count: frameCollectedSigs.size,
        frame: shortHash(entityInput.proposedFrame.hash),
      });

      // Normally use the validator-computed state. If this replica missed the
      // proposal but is exactly one frame behind, replay the signed txs locally.
      // Never apply proposedFrame.newState directly: quorum signatures bind the
      // frame hash, not the mutable transport snapshot carrying the commit.
      let stateToApply = workingReplica.validatorComputedState;
      if (!stateToApply) {
        const proposedFrame = entityInput.proposedFrame;
        const expectedPrevHeight = proposedFrame.height - 1;
        if (workingReplica.state.height !== expectedPrevHeight) {
          entityLog.warn('commit.catch_up_state_wait', {
            height: workingReplica.state.height,
            expectedPrevHeight,
            commitHeight: proposedFrame.height,
            frame: shortHash(proposedFrame.hash),
          });
          return { newState: workingReplica.state, outputs: entityOutbox, jOutputs: jOutbox, workingReplica };
        }

        const { newState: replayedState } = await applyEntityFrame(
          env,
          workingReplica.state,
          proposedFrame.txs,
          proposedFrame.newState.timestamp,
        );
        const replayedCommitState = {
          ...replayedState,
          entityId: workingReplica.state.entityId,
          height: proposedFrame.height,
          timestamp: proposedFrame.newState.timestamp,
        };
        const replayedHash = await createEntityFrameHash(
          getPrevFrameHash(workingReplica.state),
          proposedFrame.height,
          proposedFrame.newState.timestamp,
          proposedFrame.txs,
          replayedCommitState,
        );
        if (replayedHash !== proposedFrame.hash) {
          logError('FRAME_CONSENSUS', `❌ COMMIT REJECTED: replayed catch-up state does not match signed frame hash!`);
          logError('FRAME_CONSENSUS', `   Expected: ${replayedHash.slice(0, 30)}...`);
          logError('FRAME_CONSENSUS', `   Received: ${proposedFrame.hash.slice(0, 30)}...`);
          return { newState: workingReplica.state, outputs: entityOutbox, jOutputs: jOutbox, workingReplica };
        }
        stateToApply = replayedCommitState;
        entityLog.warn('commit.catch_up_state_replayed', {
          height: proposedFrame.height,
          frame: shortHash(proposedFrame.hash),
        });
      }
      workingReplica.state = {
        ...stateToApply,
        entityId: workingReplica.state.entityId,
        height: entityInput.proposedFrame.height,
        prevFrameHash: entityInput.proposedFrame.hash,
      } as EntityState;
      markStorageEntityDirty(env, workingReplica.state.entityId);

      const committedTxs = entityInput.proposedFrame.txs;
      if (committedTxs.length > 0) {
        entityLog.debug('mempool.clear_committed', {
          committed: committedTxs.length,
          before: workingReplica.mempool.length,
        });
        workingReplica.mempool = removeCommittedTxsFromMempool(workingReplica.mempool, committedTxs);
        entityLog.debug('mempool.after_commit', { remaining: workingReplica.mempool.length });
      }

      delete workingReplica.lockedFrame;
      delete workingReplica.validatorComputedState;
      entityLog.debug('commit.applied', {
        height: workingReplica.state.height,
        frame: shortHash(entityInput.proposedFrame.hash),
      });

      return { newState: workingReplica.state, outputs: entityOutbox, jOutputs: jOutbox, workingReplica };
    }
  }

  // Proposed frames are precommitted only after this replica replays the txs and
  // recomputes the same state hash.
  if (
    entityInput.proposedFrame &&
    (!workingReplica.proposal || (workingReplica.state.config.mode === 'gossip-based' && workingReplica.isProposer))
  ) {
    const config = workingReplica.state.config;
    const proposedFrame = entityInput.proposedFrame;

    const expectedPrevHeight = proposedFrame.height - 1;
    const canVerify = workingReplica.state.height >= expectedPrevHeight;
    if (!canVerify) {
      entityLog.warn('proposal.catch_up_wait', {
        signer: shortId(workingReplica.signerId),
        height: workingReplica.state.height,
        expectedPrevHeight,
      });
    }

    if (canVerify) {
      const { newState: validatorComputedState } = await applyEntityFrame(
        env,
        workingReplica.state,
        proposedFrame.txs,
        proposedFrame.newState.timestamp,
      );
      const validatorNewState = {
        ...validatorComputedState,
        entityId: workingReplica.state.entityId,
        height: proposedFrame.height,
        timestamp: proposedFrame.newState.timestamp,
      };

      const prevFrameHash = getPrevFrameHash(workingReplica.state);
      const validatorComputedHash = await createEntityFrameHash(
        prevFrameHash,
        proposedFrame.height,
        proposedFrame.newState.timestamp,
        proposedFrame.txs,
        validatorNewState,
      );

      if (validatorComputedHash !== proposedFrame.hash) {
        logError('FRAME_CONSENSUS', `❌ HASH MISMATCH: Proposer sent invalid frame hash!`);
        logError('FRAME_CONSENSUS', `   Expected: ${validatorComputedHash.slice(0, 30)}...`);
        logError('FRAME_CONSENSUS', `   Received: ${proposedFrame.hash.slice(0, 30)}...`);
        logError('FRAME_CONSENSUS', `   This could indicate equivocation attack or state divergence bug.`);
        return { newState: workingReplica.state, outputs: entityOutbox, jOutputs: jOutbox, workingReplica };
      }

      entityLog.debug('proposal.hash_verified', { frame: shortHash(proposedFrame.hash) });

      const hashesToSign = proposedFrame.hashesToSign || [
        { hash: proposedFrame.hash, type: 'entityFrame' as const, context: '' },
      ];
      const allSignatures = await Promise.all(hashesToSign.map(h => signFrame(env, workingReplica.signerId, h.hash)));
      entityLog.debug('proposal.hashes_signed', { count: allSignatures.length });

      workingReplica.lockedFrame = proposedFrame;
      workingReplica.validatorComputedState = validatorNewState;

      if (config.mode === 'gossip-based') {
        config.validators.forEach(validatorId => {
          entityOutbox.push({
            entityId: entityInput.entityId,
            signerId: validatorId,
            hashPrecommits: new Map([[workingReplica.signerId, allSignatures]]),
          });
        });
      } else {
        const proposerId = config.validators[0];
        if (!proposerId) {
          logError('FRAME_CONSENSUS', `❌ No proposer found in validators: ${config.validators}`);
          return { newState: workingReplica.state, outputs: entityOutbox, jOutputs: jOutbox, workingReplica };
        }
        entityOutbox.push({
          entityId: entityInput.entityId,
          signerId: proposerId,
          hashPrecommits: new Map([[workingReplica.signerId, allSignatures]]),
        });
      }
      entityLog.debug('proposal.precommit_sent', {
        mode: config.mode,
        frame: frameHash,
        signatures: allSignatures.length,
      });
    } // end if (canVerify) — behind validators skip verification and wait for commit
  }

  // Handle hashPrecommits (multi-hash signatures from validators)
  const hasHashPrecommits = entityInput.hashPrecommits?.size && workingReplica.proposal;
  if (hasHashPrecommits && workingReplica.proposal) {
    const proposal = workingReplica.proposal;

    for (const [signerId, sigs] of entityInput.hashPrecommits!) {
      if (!verifyHashPrecommitSignatures(
        env,
        signerId,
        proposal.hashesToSign,
        proposal.hash,
        proposal.height,
        sigs,
        'PRECOMMIT_REJECTED',
      )) continue;
      if (!proposal.collectedSigs) {
        proposal.collectedSigs = new Map();
      }
      proposal.collectedSigs.set(signerId, sigs);
    }
    entityLog.debug('precommit.collected', {
      incoming: entityInput.hashPrecommits!.size,
      total: proposal.collectedSigs?.size || 0,
    });

    const signers = Array.from(proposal.collectedSigs?.keys() || []);
    const totalPower = calculateQuorumPower(workingReplica.state.config, signers);

    // SECURITY: Validate voting power
    if (!validateVotingPower(totalPower)) {
      log.error(`❌ Invalid voting power calculation: ${totalPower}`);
      return { newState: workingReplica.state, outputs: entityOutbox, jOutputs: jOutbox, workingReplica };
    }

    if (DEBUG) {
      const totalShares = Object.values(workingReplica.state.config.shares).reduce((sum, val) => sum + val, BigInt(0));
      const percentage = ((Number(totalPower) / Number(workingReplica.state.config.threshold)) * 100).toFixed(1);
      log.info(
        `    🔍 Threshold check: ${totalPower} / ${totalShares} [${percentage}% threshold${Number(totalPower) >= Number(workingReplica.state.config.threshold) ? '+' : ''}]`,
      );
    }

    if (totalPower >= workingReplica.state.config.threshold) {
      entityLog.debug('commit.threshold_reached', {
        signers: signers.length,
        hashes: proposal.hashesToSign?.length || 1,
      });

      const committedHankos: HankoString[] = [];
      if (proposal.hashesToSign && proposal.collectedSigs) {
        const { buildQuorumHanko } = await import('./hanko/signing');
        for (let i = 0; i < proposal.hashesToSign.length; i++) {
          const hashInfo = proposal.hashesToSign[i];
          if (!hashInfo) continue;
          const sigsForHash: Array<{ signerId: string; signature: string }> = [];
          for (const [signerId, sigs] of proposal.collectedSigs) {
            const sig = sigs[i];
            if (sig) {
              sigsForHash.push({ signerId, signature: sig });
            }
          }
          const hanko = await buildQuorumHanko(
            env,
            workingReplica.state.entityId,
            hashInfo.hash,
            sigsForHash,
            workingReplica.state.config,
          );
          committedHankos.push(hanko);
        }
        entityLog.debug('commit.hankos_built', {
          count: committedHankos.length,
          validators: proposal.collectedSigs.size,
        });
      }

      // Witnesses are not consensus state; they let outputs carry quorum proofs.
      if (!workingReplica.hankoWitness) {
        workingReplica.hankoWitness = new Map();
      }
      if (proposal.hashesToSign) {
        for (let i = 0; i < proposal.hashesToSign.length; i++) {
          const hashInfo = proposal.hashesToSign[i];
          const hanko = committedHankos[i];
          if (hashInfo && hanko && isWitnessHashType(hashInfo.type)) {
            workingReplica.hankoWitness.set(hashInfo.hash, {
              hanko,
              type: hashInfo.type,
              entityHeight: workingReplica.state.height + 1,
              createdAt: env.timestamp,
            });
          }
        }
      }

      // Stored outputs are emitted as-is; re-applying proposal txs here would
      // duplicate non-idempotent side effects such as account creation.
      const commitOutputs = proposal.outputs || [];
      const commitJOutputs = proposal.jOutputs || [];

      const attachedCount = attachHankoWitnessToOutputs(
        commitOutputs,
        commitJOutputs,
        workingReplica.hankoWitness,
        workingReplica.state.height + 1,
      );

      entityOutbox.push(...commitOutputs);
      jOutbox.push(...commitJOutputs);
      entityLog.info('commit.outputs', {
        outputs: commitOutputs.length,
        jOutputs: commitJOutputs.length,
        hankos: attachedCount,
      });

      workingReplica.state = {
        ...proposal.newState,
        entityId: workingReplica.state.entityId,
        height: proposal.height,
        prevFrameHash: proposal.hash,
      };
      markStorageEntityDirty(env, workingReplica.state.entityId);

      const committedFrame = proposal;
      committedFrame.hankos = committedHankos;

      // Clear only committed txs; keep any new txs merged into this tick
      const committedTxs = committedFrame.txs;
      if (committedTxs.length > 0) {
        workingReplica.mempool = removeCommittedTxsFromMempool(workingReplica.mempool, committedTxs);
      }
      delete workingReplica.proposal;
      delete workingReplica.lockedFrame;

      if (workingReplica.state.config.mode === 'proposer-based') {
        const committedProposalHash = committedFrame.hash.slice(0, 10);
        const precommitSigners = Array.from(committedFrame.collectedSigs?.keys() || []);
        entityLog.debug('commit.notify_validators', {
          frame: committedProposalHash,
          validators: workingReplica.state.config.validators.length - 1,
          precommitSigners: precommitSigners.map(shortId),
        });

        workingReplica.state.config.validators.forEach(validatorId => {
          if (validatorId !== workingReplica.signerId) {
            entityOutbox.push({
              entityId: entityInput.entityId,
              signerId: validatorId,
              proposedFrame: committedFrame, // Contains collectedSigs + hankos
            });
          }
        });
      } else {
        entityLog.debug('commit.gossip_mode_no_notifications', { frame: shortHash(committedFrame.hash) });
      }
    }
  }

  if (!quietRuntimeLogs) {
    entityLog.debug('consensus.check', {
      entity: shortId(workingReplica.entityId),
      signer: shortId(workingReplica.signerId),
      proposer: workingReplica.isProposer,
      mempool: workingReplica.mempool.length,
      hasProposal: Boolean(workingReplica.proposal),
      txs: workingReplica.mempool.map(tx => tx.type),
    });
  }

  const isSingleSigner = (() => {
    if (workingReplica.state.config.validators.length !== 1) return false;
    try {
      return BigInt(workingReplica.state.config.threshold ?? 0) === 1n;
    } catch {
      return false;
    }
  })();

  // Single-signer entities still produce a hash-linked frame; they only skip
  // the multi-validator precommit/commit round trip.
  if (workingReplica.isProposer && workingReplica.mempool.length > 0 && !workingReplica.proposal && isSingleSigner) {
    entityLog.debug('single_signer.execute', { txs: workingReplica.mempool.map(tx => tx.type) });
    const {
      newState: newEntityState,
      outputs: frameOutputs,
      jOutputs: frameJOutputs,
      collectedHashes,
    } = await applyEntityFrame(env, workingReplica.state, workingReplica.mempool, env.timestamp);
    const newHeight = workingReplica.state.height + 1;
    const newTimestamp = env.timestamp;

    const prevFrameHash = getPrevFrameHash(workingReplica.state);
    const singleSignerNewState = {
      ...newEntityState,
      entityId: workingReplica.state.entityId,
      height: newHeight,
      timestamp: newTimestamp,
    };
    const singleSignerFrameHash = await createEntityFrameHash(
      prevFrameHash,
      newHeight,
      newTimestamp,
      workingReplica.mempool,
      singleSignerNewState,
    );

    const hashesToSign = buildEntityHashesToSign(
      workingReplica.state.entityId,
      newHeight,
      singleSignerFrameHash,
      collectedHashes,
    );

    const { signEntityHashes } = await import('./hanko/signing');
    const hankos = await signEntityHashes(
      env,
      workingReplica.state.entityId,
      workingReplica.signerId,
      hashesToSign.map(hashInfo => hashInfo.hash),
    );

    if (!workingReplica.hankoWitness) {
      workingReplica.hankoWitness = new Map();
    }
    for (let i = 0; i < hashesToSign.length; i++) {
      const hashInfo = hashesToSign[i];
      const hanko = hankos[i];
      if (!hashInfo || !hanko) continue;
      if (!isWitnessHashType(hashInfo.type)) continue;
      workingReplica.hankoWitness.set(hashInfo.hash, {
        hanko,
        type: hashInfo.type,
        entityHeight: newHeight,
        createdAt: newTimestamp,
      });
    }
    const attachedHankos = attachHankoWitnessToOutputs(
      frameOutputs,
      frameJOutputs,
      workingReplica.hankoWitness as Map<string, HankoWitnessEntry>,
      newHeight,
    );
    if (attachedHankos > 0) entityLog.debug('single_signer.hankos_attached', { count: attachedHankos });

    workingReplica.state = {
      ...singleSignerNewState,
      prevFrameHash: singleSignerFrameHash, // Chain linkage
    };
    markStorageEntityDirty(env, workingReplica.state.entityId);

    entityOutbox.push(...frameOutputs);
    jOutbox.push(...frameJOutputs);

    workingReplica.mempool.length = 0;
    return { newState: workingReplica.state, outputs: entityOutbox, jOutputs: jOutbox, workingReplica };
  }

  if (!isSingleSigner && workingReplica.isProposer && workingReplica.mempool.length > 0 && !workingReplica.proposal) {
    entityLog.debug('proposal.auto_start', {
      mempool: workingReplica.mempool.length,
      txs: workingReplica.mempool.map(tx => tx.type),
    });
    const {
      newState: newEntityState,
      deterministicState: proposerDeterministicState,
      outputs: proposalOutputs,
      jOutputs: proposalJOutputs,
      collectedHashes,
    } = await applyEntityFrame(env, workingReplica.state, workingReplica.mempool, env.timestamp);

    // Outputs are stored on the proposal and emitted only after quorum hankos are
    // available. Re-applying at commit would duplicate side effects.

    const newTimestamp = env.timestamp;
    const newHeight = workingReplica.state.height + 1;

    // Build proposed new state (full state with account proposals — for commit)
    const proposedNewState = {
      ...newEntityState,
      entityId: workingReplica.state.entityId,
      height: newHeight,
      timestamp: newTimestamp,
    };

    // Build deterministic state for hashing (before account proposals — matches validator)
    const deterministicForHash = {
      ...proposerDeterministicState,
      entityId: workingReplica.state.entityId,
      height: newHeight,
      timestamp: newTimestamp,
    };

    const prevFrameHash = getPrevFrameHash(workingReplica.state);
    const frameHash = await createEntityFrameHash(
      prevFrameHash,
      newHeight,
      newTimestamp,
      workingReplica.mempool,
      deterministicForHash,
    );
    const hashesToSign = buildEntityHashesToSign(workingReplica.state.entityId, newHeight, frameHash, collectedHashes);

    const selfSigs = await Promise.all(hashesToSign.map(h => signFrame(env, workingReplica.signerId, h.hash)));

    workingReplica.proposal = {
      height: newHeight,
      txs: [...workingReplica.mempool],
      hash: frameHash,
      newState: proposedNewState,
      outputs: proposalOutputs,
      jOutputs: proposalJOutputs,
      hashesToSign,
      collectedSigs: new Map([[workingReplica.signerId, selfSigs]]),
    };

    entityLog.debug('proposal.created', {
      frame: shortHash(workingReplica.proposal.hash),
      txs: workingReplica.proposal.txs.length,
      hashes: hashesToSign.length,
    });

    workingReplica.state.config.validators.forEach(validatorId => {
      if (validatorId !== workingReplica.signerId) {
        entityOutbox.push({
          entityId: entityInput.entityId,
          signerId: validatorId,
          proposedFrame: workingReplica.proposal!,
        });
      }
    });
  }

  if (!quietRuntimeLogs) {
    entityLog.debug('outputs.generated', {
      entity: entityDisplay,
      signer: shortId(workingReplica.signerId),
      outputs: entityOutbox.length,
      proposal: shortHash(workingReplica.proposal?.hash || 'none'),
      mempool: workingReplica.mempool.length,
      locked: shortHash(workingReplica.lockedFrame?.hash || 'none'),
    });
  }

  entityOutbox.forEach((output, index) => {
    if (!HEAVY_LOGS) return;
    entityLog.trace('output.detail', {
      index,
      entity: shortId(output.entityId),
      signer: shortId(output.signerId ?? ''),
      txs: output.entityTxs?.length || 0,
      hashPrecommits: output.hashPrecommits?.size || 0,
      frame: shortHash(output.proposedFrame?.hash || 'none'),
      commit: Boolean(output.proposedFrame?.collectedSigs?.size),
    });
  });

  return { newState: workingReplica.state, outputs: entityOutbox, jOutputs: jOutbox, workingReplica };
};

export const applyEntityFrame = async (
  env: Env,
  entityState: EntityState,
  entityTxs: EntityTx[],
  // DETERMINISM: Validators pass proposedFrame.newState.timestamp to match proposer's lockIds/timelocks.
  // Proposers pass env.timestamp (their local time when creating the frame).
  frameTimestamp?: number,
): Promise<{
  newState: EntityState;
  // State snapshot BEFORE account proposals (deterministic across proposer + validators)
  // Proposer must hash from this state to match validator verification
  deterministicState: EntityState;
  outputs: EntityInput[];
  jOutputs: JInput[];
  // Hashes emitted during frame processing that need entity-quorum signing
  collectedHashes?: Array<{
    hash: string;
    type: HashType;
    context: string;
  }>;
}> => {
  entityLog.debug('frame.apply', { txs: entityTxs.map(tx => tx.type) });
  if (shouldLogFullPayloads()) {
    entityTxs.forEach((tx, index) => {
      entityLog.trace('frame.tx_payload', { index, type: tx.type, data: tx.data });
    });
  }

  // Work on a clone so failed frame construction cannot leak mutations.
  let currentEntityState = cloneEntityState(entityState);

  // Validators receive the proposer's frame timestamp; proposers use env.timestamp.
  // HTLC timelocks and lockIds must see this before handlers run.
  currentEntityState.timestamp = frameTimestamp ?? env.timestamp;
  const allOutputs: EntityInput[] = [];
  const allJOutputs: JInput[] = [];
  const collectedHashes: Array<{
    hash: string;
    type: HashType;
    context: string;
  }> = [];

  const proposableAccounts = new Set<string>();
  drainPendingCrossJurisdictionFillAcks(env, currentEntityState, proposableAccounts);

  const allSwapOffersCreated: SwapOfferEvent[] = [];
  const allSwapCancelRequests: SwapCancelRequestEvent[] = [];
  const allSwapOffersCancelled: SwapCancelEvent[] = [];

  // Preserve WAL transaction order exactly during live processing and replay.
  // Reordering batched txs can change bilateral account state transitions
  // (e.g., openAccount + accountInput ACK in same frame).
  for (const entityTx of entityTxs) {
    const {
      newState,
      outputs,
      jOutputs,
      hashesToSign,
      mempoolOps,
      dirtyAccounts,
      swapOffersCreated,
      swapCancelRequests,
      swapOffersCancelled,
      skippedError,
    } = await applyEntityTx(env, currentEntityState, entityTx);
    if (skippedError) {
      throw new Error(`ENTITY_FRAME_TX_FAILED: type=${String(entityTx.type)} error=${skippedError}`);
    }
    currentEntityState = newState;
    for (const accountId of dirtyAccounts || []) {
      markStorageAccountDirty(env, currentEntityState.entityId, accountId);
    }

    allOutputs.push(...outputs);
    if (jOutputs) allJOutputs.push(...jOutputs);
    if (hashesToSign && hashesToSign.length > 0) {
      collectedHashes.push(...hashesToSign);
    }

    // Entity handlers return mempoolOps; this orchestrator is the only place
    // that mutates account.mempool during entity-frame application.
    if (mempoolOps && mempoolOps.length > 0) {
      for (const { accountId, tx } of mempoolOps) {
        const account = currentEntityState.accounts.get(accountId);
        if (tx.type === 'cross_swap_fill_ack' && !account?.swapOffers?.has(tx.data.offerId)) {
          const routed = buildCrossJurisdictionFillNoticeOutput(env, currentEntityState, accountId, tx);
          if (!routed) {
            if (ownsSourceHubRouteForFillAck(currentEntityState, tx)) {
              stashPendingCrossJurisdictionFillAck(
                env,
                currentEntityState,
                accountId,
                tx,
                account ? 'source_offer_not_committed' : 'source_account_not_committed',
              );
              continue;
            }
            throw new Error(
              `CROSS_J_FILL_ACK_ACCOUNT_OFFER_MISSING: account=${accountId} offer=${tx.data.offerId} ` +
                `entity=${currentEntityState.entityId}`,
            );
          }
          allOutputs.push(routed);
          entityLog.info('crossj.sibling_fill_notice_routed', {
            owner: shortId(routed.entityId, 8),
            account: shortId(accountId, 8),
            offer: shortOrder(tx.data.offerId, 8),
          });
          continue;
        }
        if (account) {
          if (
            tx.type === 'swap_cancel_request' &&
            account.swapOffers?.get(tx.data.offerId)?.crossJurisdiction &&
            !currentEntityState.orderbookExt
          ) {
            throw new Error(
              `CROSS_J_ORDERBOOK_EXT_REQUIRED: cancel for ${String(tx.data.offerId).slice(-8)} cannot use fallback swap_resolve`,
            );
          }
          if (!queueUniqueAccountMempoolTx(account, tx)) {
            continue;
          }
          proposableAccounts.add(accountId);
          markStorageAccountDirty(env, currentEntityState.entityId, accountId);
          markStorageEntityDirty(env, currentEntityState.entityId);

          if (tx.type === 'htlc_lock' && tx.data?.timelock && tx.data?.lockId) {
            if (currentEntityState.crontabState) {
              scheduleCrontabHook(currentEntityState.crontabState, {
                id: `htlc-timeout:${tx.data.lockId}`,
                triggerAt: Number(tx.data.timelock),
                type: 'htlc_timeout',
                data: { accountId, lockId: tx.data.lockId },
              });
              markStorageEntityDirty(env, currentEntityState.entityId);
            }
          }

          if (tx.type === 'htlc_resolve' && tx.data?.lockId) {
            if (currentEntityState.crontabState) {
              cancelCrontabHook(currentEntityState.crontabState, `htlc-timeout:${tx.data.lockId}`);
              markStorageEntityDirty(env, currentEntityState.entityId);
            }
          }
        } else if (tx.type === 'cross_swap_fill_ack') {
          throw new Error(
            `CROSS_J_FILL_ACK_ACCOUNT_MISSING: account=${accountId} offer=${tx.data.offerId} entity=${currentEntityState.entityId}`,
          );
        } else {
          entityLog.warn('mempool_op.account_missing', { account: shortId(accountId, 8), tx: tx.type });
        }
      }
    }

    if (swapOffersCreated) {
      for (const offer of swapOffersCreated) {
        // Cross-j account-level swap_offer is only the source intent. The
        // shared book receives the order from admitCrossJurisdictionBookOrder
        // after both source and target pull locks have committed.
        if (offer.crossJurisdiction && entityTx.type !== 'admitCrossJurisdictionBookOrder') continue;
        allSwapOffersCreated.push(offer);
      }
    }
    if (swapCancelRequests) allSwapCancelRequests.push(...swapCancelRequests);
    if (swapOffersCancelled) allSwapOffersCancelled.push(...swapOffersCancelled);

    if (entityTx.type === 'accountInput' && entityTx.data) {
      const fromEntity = entityTx.data.fromEntityId;
      const accountMachine = currentEntityState.accounts.get(fromEntity);

      if (accountMachine) {
        const hasPendingTxs = accountMachine.mempool.length > 0;
        if (hasPendingTxs && !accountMachine.pendingFrame) {
          proposableAccounts.add(fromEntity);
        }
      }
    } else if (entityTx.type === 'directPayment' && entityTx.data) {
      for (const [counterpartyId, accountMachine] of currentEntityState.accounts) {
        if (accountMachine.mempool.length > 0 && !accountMachine.pendingFrame) {
          proposableAccounts.add(counterpartyId);
        }
      }
    } else if (entityTx.type === 'openAccount' && entityTx.data) {
      const targetEntity = entityTx.data.targetEntityId;
      const accountMachine = currentEntityState.accounts.get(targetEntity);
      if (accountMachine) {
        if (accountMachine.mempool.length > 0 && !accountMachine.pendingFrame) {
          proposableAccounts.add(targetEntity);
        }
      }
    } else if (entityTx.type === 'extendCredit' && entityTx.data) {
      const counterpartyId = entityTx.data.counterpartyEntityId;
      const accountMachine = currentEntityState.accounts.get(counterpartyId);
      if (accountMachine && accountMachine.mempool.length > 0) {
        proposableAccounts.add(counterpartyId);
      }
    }
    drainPendingCrossJurisdictionFillAcks(env, currentEntityState, proposableAccounts);
  }

  // === APPLY AGGREGATED PURE EVENTS ===

  // 1. MempoolOps now applied inline (see above in the loop) to fix simultaneous payment bug
  // This section removed - mempoolOps are applied immediately after each applyEntityTx

  // Committed account-level cancels must be reflected in the persisted book
  // before the next matching pass. Otherwise a restored book can still expose
  // an order that the account frame has already removed.
  if (allSwapOffersCancelled.length > 0) {
    applyCommittedSwapCancelsToOrderbook(env, currentEntityState, allSwapOffersCancelled);
  }

  const hasPersistedCrossJurisdictionBook = Boolean(
    currentEntityState.orderbookExt &&
    Array.from(currentEntityState.orderbookExt.books?.keys?.() || []).some(pairId =>
      String(pairId).startsWith('cross:'),
    ),
  );
  if ((allSwapOffersCreated.length > 0 || hasPersistedCrossJurisdictionBook) && currentEntityState.orderbookExt) {
    entityLog.debug('orderbook.matching', {
      offers: allSwapOffersCreated.length,
      hasPersistedCrossJurisdictionBook,
    });

    const enrichedOffers = allSwapOffersCreated.map(offer => {
      // The hub's account map is keyed by counterparty. The maker side can be
      // either left or right, so derive accountId from the side opposite hub.
      const hubId = currentEntityState.entityId;
      const hubEntity = normalizeEntityRef(hubId);
      const fromEntity = normalizeEntityRef(offer.fromEntity);
      const toEntity = normalizeEntityRef(offer.toEntity);
      const counterparty = fromEntity === hubEntity ? toEntity : fromEntity;
      return normalizeSwapOfferForOrderbook(offer, counterparty);
    });
    const seenOfferKeys = new Set<string>();
    const offersToMatch: WorkingOrderbookOffer[] = [];
    for (const offer of enrichedOffers) {
      const key = swapKey(offer.accountId, offer.offerId);
      if (seenOfferKeys.has(key)) continue;
      seenOfferKeys.add(key);
      if (
        offer.crossJurisdiction &&
        crossJurisdictionBookOwnerRef(offer.crossJurisdiction) !== normalizeEntityRef(currentEntityState.entityId)
      ) {
        entityLog.debug('crossj.orderbook.skip_non_owner', {
          offer: shortOrder(offer.offerId, 8),
          owner: shortId(crossJurisdictionBookOwnerRef(offer.crossJurisdiction), 8),
          current: shortId(currentEntityState.entityId, 8),
        });
        continue;
      }
      const admittedOffer = admitOrderbookOfferForMatching(env, currentEntityState, offer);
      if (admittedOffer) offersToMatch.push(admittedOffer);
    }
    entityLog.debug('orderbook.offers_enriched', {
      local: enrichedOffers.length,
      admitted: offersToMatch.length,
    });

    const matchResult = processOrderbookSwaps(currentEntityState, offersToMatch);

    // Orderbook matching returns pure mempoolOps/book updates. Applying the
    // returned account txs here is still orchestrator-owned mutation of the
    // cloned working state, not handler-side in-place state injection.
    for (const { accountId, tx } of matchResult.mempoolOps) {
      const account = currentEntityState.accounts.get(accountId);

      if (tx.type === 'swap_resolve') {
        const localOwnsOffer = Boolean(account?.swapOffers?.has(tx.data.offerId));
        const localOffer = account?.swapOffers?.get(tx.data.offerId);
        if (localOffer?.crossJurisdiction) {
          entityLog.warn('crossj.block_plain_swap_resolve', {
            offer: shortOrder(tx.data.offerId, 8),
            account: shortId(accountId, 8),
          });
          continue;
        }
        if (account && localOwnsOffer) {
          if (!queueUniqueAccountMempoolTx(account, tx)) {
            continue;
          }
          proposableAccounts.add(accountId);
          markStorageAccountDirty(env, currentEntityState.entityId, accountId);
          markStorageEntityDirty(env, currentEntityState.entityId);
          currentEntityState.pendingSwapFillRatios ||= new Map();
          const key = swapKey(accountId, tx.data.offerId);
          currentEntityState.pendingSwapFillRatios.set(key, tx.data.fillRatio);
          entityLog.debug('orderbook.account_tx_queued', { account: shortId(accountId, 8), tx: tx.type });
        } else {
          const ownerState = findSwapOfferOwnerState(env, currentEntityState, accountId, tx.data.offerId);
          const ownerAccount = findAccountByCounterparty(ownerState, accountId);
          const ownerOffer = ownerAccount?.swapOffers?.get(tx.data.offerId);
          if (ownerOffer?.crossJurisdiction) {
            entityLog.warn('crossj.block_routed_plain_swap_resolve', {
              offer: shortOrder(tx.data.offerId, 8),
              account: shortId(accountId, 8),
            });
            continue;
          }
          const firstValidator = ownerState?.config?.validators?.[0];
          if (!ownerState || !firstValidator) {
            entityLog.warn('orderbook.sibling_swap_unroutable', {
              offer: shortOrder(tx.data.offerId, 8),
              account: shortId(accountId, 8),
            });
            continue;
          }
          allOutputs.push({
            entityId: ownerState.entityId,
            signerId: firstValidator,
            entityTxs: [
              {
                type: 'resolveSwap',
                data: {
                  counterpartyEntityId: accountId,
                  ...tx.data,
                },
              },
            ],
          });
          entityLog.debug('orderbook.sibling_tx_routed', {
            owner: shortId(ownerState.entityId, 8),
            account: shortId(accountId, 8),
            tx: tx.type,
          });
        }
        continue;
      }

      if (tx.type === 'cross_swap_fill_ack') {
        const localOwnsOffer = Boolean(account?.swapOffers?.has(tx.data.offerId));
        if (account && localOwnsOffer) {
          if (!queueUniqueAccountMempoolTx(account, tx)) {
            continue;
          }
          proposableAccounts.add(accountId);
          markStorageAccountDirty(env, currentEntityState.entityId, accountId);
          markStorageEntityDirty(env, currentEntityState.entityId);
          entityLog.debug('crossj.local_fill_ack_queued', {
            account: shortId(accountId, 8),
            offer: shortOrder(tx.data.offerId, 8),
            ratio: tx.data.cumulativeFillRatio,
            cancel: tx.data.cancelRemainder,
          });
          entityLog.debug('orderbook.account_tx_queued', { account: shortId(accountId, 8), tx: tx.type });
          continue;
        }

        const routed = buildCrossJurisdictionFillNoticeOutput(env, currentEntityState, accountId, tx);
        if (!routed) {
          if (ownsSourceHubRouteForFillAck(currentEntityState, tx)) {
            stashPendingCrossJurisdictionFillAck(
              env,
              currentEntityState,
              accountId,
              tx,
              account ? 'source_offer_not_committed' : 'source_account_not_committed',
            );
            continue;
          }
          throw new Error(
            `CROSS_J_FILL_ACK_OWNER_MISSING: account=${accountId} offer=${tx.data.offerId} current=${currentEntityState.entityId}`,
          );
        }
        allOutputs.push(routed);
        entityLog.info('crossj.sibling_fill_notice_routed', {
          owner: shortId(routed.entityId, 8),
          account: shortId(accountId, 8),
          offer: shortOrder(tx.data.offerId, 8),
        });
        continue;
      }

      if (account) {
        if (!queueUniqueAccountMempoolTx(account, tx)) {
          continue;
        }
        proposableAccounts.add(accountId);
        markStorageAccountDirty(env, currentEntityState.entityId, accountId);
        markStorageEntityDirty(env, currentEntityState.entityId);
        entityLog.debug('orderbook.account_tx_queued', { account: shortId(accountId, 8), tx: tx.type });
      }
    }

    if (matchResult.debugProjectionRejects.length > 0) {
      const detail = matchResult.debugProjectionRejects
        .map(({ accountId, offerId, reason }) => `${accountId.slice(-8)}:${offerId.slice(-8)}:${reason}`)
        .join(', ');
      throw new Error(`ORDERBOOK_LIVE_PROJECTION_REJECT: ${detail}`);
    }

    if (matchResult.crossJurisdictionFills.length > 0) {
      entityLog.info('crossj.firm_fills_recorded', { count: matchResult.crossJurisdictionFills.length });
      for (const fill of matchResult.crossJurisdictionFills) {
        // Partial cross-j fills keep the original book row alive and matchable.
        // Only a terminal fill/cancel removes the row and moves admission into
        // resolving so the clear flow can claim/release the hash-ledger pulls.
        if (fill.cancelRemainder) {
          markCrossJurisdictionBookAdmissionResolving(
            currentEntityState,
            fill.route,
            deterministicEntityTimestamp(currentEntityState, env),
          );
        }
        if (
          fill.priceImprovementMode !== 'target_bonus' ||
          fill.priceImprovementAmount <= 0n ||
          fill.priceImprovementTokenId === null
        ) {
          continue;
        }
        const targetHubState = findEntityStateById(env, fill.route.target.entityId);
        const targetSigner = targetHubState?.config?.validators?.[0];
        if (!targetHubState || !targetSigner) {
          // target_bonus is owed value from the same firm fill, not an optional
          // notification. If the target hub route is unavailable, committing the
          // ACK/book progress would settle less than the matched economics.
          throw new Error(
            `CROSS_J_TARGET_BONUS_UNROUTABLE: offer=${shortOrder(fill.offerId, 8)} ` +
            `targetHub=${shortId(fill.route.target.entityId, 8)}`,
          );
        }
        allOutputs.push({
          entityId: targetHubState.entityId,
          signerId: targetSigner,
          entityTxs: [
            {
              type: 'directPayment',
              data: {
                targetEntityId: fill.route.target.counterpartyEntityId,
                tokenId: fill.priceImprovementTokenId,
                amount: fill.priceImprovementAmount,
                route: [fill.route.target.entityId, fill.route.target.counterpartyEntityId],
                description: `cross-j-target-bonus:${fill.offerId}`,
              },
            },
          ],
        });
      }
    }

    // Apply book updates
    const ext = currentEntityState.orderbookExt as OrderbookExtState;
    for (const { pairId, book } of matchResult.bookUpdates) {
      replaceOrderbookPair(ext, pairId, book);
      recordOrderbookPairUpdate(env, {
        entityId: currentEntityState.entityId,
        pairId,
        book,
      });
    }
  }

  // 3. Process swap cancel requests through hub orderbook
  if (allSwapCancelRequests.length > 0) {
    if (currentEntityState.orderbookExt) {
      // processOrderbookCancels imported at top level
      const cancelResult = processOrderbookCancels(currentEntityState, allSwapCancelRequests);

      for (const { accountId, tx } of cancelResult.mempoolOps) {
        const account = currentEntityState.accounts.get(accountId);
        if (!account) continue;
        if (!queueUniqueAccountMempoolTx(account, tx)) {
          continue;
        }
        proposableAccounts.add(accountId);
        markStorageAccountDirty(env, currentEntityState.entityId, accountId);
        markStorageEntityDirty(env, currentEntityState.entityId);
      }

      const ext = currentEntityState.orderbookExt as OrderbookExtState;
      for (const { pairId, book } of cancelResult.bookUpdates) {
        replaceOrderbookPair(ext, pairId, book);
        recordOrderbookPairUpdate(env, {
          entityId: currentEntityState.entityId,
          pairId,
          book,
        });
      }
    } else {
      // Fallback: counterparty resolves cancel directly when no orderbook extension is configured.
      for (const { accountId, offerId } of allSwapCancelRequests) {
        const account = currentEntityState.accounts.get(accountId);
        if (!account?.swapOffers?.has(offerId)) continue;
        const offer = account.swapOffers.get(offerId);
        if (offer?.crossJurisdiction) {
          throw new Error(
            `CROSS_J_ORDERBOOK_EXT_REQUIRED: cancel for ${offerId.slice(-8)} cannot use fallback swap_resolve`,
          );
        }
        // Fallback cancel resolution is synthesized by the orchestrator itself.
        // It must land in the same working-state mempool so the later account
        // proposal step sees it in this frame.
        if (
          !queueUniqueAccountMempoolTx(account, {
            type: 'swap_resolve',
            data: { offerId, fillRatio: 0, cancelRemainder: true },
          })
        ) {
          continue;
        }
        proposableAccounts.add(accountId);
      }
    }
  }

  // Hash before account proposals so proposer and validators commit to the same
  // deterministic entity state.
  drainPendingCrossJurisdictionFillAcks(env, currentEntityState, proposableAccounts);
  const deterministicState = cloneEntityState(currentEntityState);

  const { proposeAccountFrame } = await import('./account-consensus');

  const accountsToProposeFrames = Array.from(proposableAccounts)
    .filter(accountId => {
      const accountMachine = currentEntityState.accounts.get(accountId);
      if (!accountMachine) {
        return false;
      }
      if (accountMachine.mempool.length === 0) {
        return false;
      }
      if (accountMachine.pendingFrame) {
        return false;
      }
      return true;
    })
    .sort();

  if (accountsToProposeFrames.length > 0) {
    for (const accountKey of accountsToProposeFrames) {
      const accountMachine = currentEntityState.accounts.get(accountKey);
      const { counterparty: cpId } = accountMachine
        ? getAccountPerspective(accountMachine, currentEntityState.entityId)
        : { counterparty: 'unknown' };
      if (accountMachine) {
        const proposal = await proposeAccountFrame(env, accountMachine, false, currentEntityState.lastFinalizedJHeight);
        if (proposal.swapOffersCancelled && proposal.swapOffersCancelled.length > 0) {
          const normalizedCancels = proposal.swapOffersCancelled.map(({ offerId }) => ({
            accountId: accountKey,
            offerId,
          }));
          applyCommittedSwapCancelsToOrderbook(env, currentEntityState, normalizedCancels);
        }
        if (proposal.hashesToSign) {
          collectedHashes.push(...proposal.hashesToSign);
        }

        if (proposal.failedHtlcLocks && proposal.failedHtlcLocks.length > 0) {
          for (const { hashlock, reason } of proposal.failedHtlcLocks) {
            const route = currentEntityState.htlcRoutes.get(hashlock);
            if (route) {
              // Always clean local bookkeeping for failed proposals.
              if (route.outboundLockId) {
                currentEntityState.lockBook.delete(route.outboundLockId);
              }

              if (route.inboundEntity && route.inboundLockId) {
                const inboundAccount = currentEntityState.accounts.get(route.inboundEntity);
                if (inboundAccount) {
                  inboundAccount.mempool.push({
                    type: 'htlc_resolve',
                    data: {
                      lockId: route.inboundLockId,
                      outcome: 'error' as const,
                      reason: `forward_failed:${reason}`,
                    },
                  });
                  proposableAccounts.add(route.inboundEntity);
                }
              }

              currentEntityState.htlcRoutes.delete(hashlock);
            }
          }
        }

        if (proposal.success && proposal.accountInput) {
          const outputEntityInput: EntityInput = {
            entityId: proposal.accountInput.toEntityId,
            signerId: resolveEntityProposerId(
              env,
              proposal.accountInput.toEntityId,
              `account proposal output ${currentEntityState.entityId}->${proposal.accountInput.toEntityId}`,
            ),
            entityTxs: [
              {
                type: 'accountInput' as const,
                data: proposal.accountInput,
              },
            ],
          };
          allOutputs.push(outputEntityInput);

          // Add events to entity messages with size limiting
          addMessages(currentEntityState, proposal.events);
          emitScopedEvents(
            env,
            'account',
            `E/A/${currentEntityState.entityId.slice(-4)}:${cpId.slice(-4)}/propose`,
            proposal.events,
            {
              entityId: currentEntityState.entityId,
              counterpartyId: cpId,
              frameHeight: proposal.accountInput.height,
              accountKey,
            },
            currentEntityState.entityId,
          );
        }
      }
    }
  }

  return {
    newState: currentEntityState,
    deterministicState,
    outputs: allOutputs,
    jOutputs: allJOutputs,
    collectedHashes,
  };
};

// === HELPER FUNCTIONS ===

/**
 * Calculate quorum power based on validator shares
 */
export const calculateQuorumPower = (config: ConsensusConfig, signers: string[]): bigint => {
  return signers.reduce((total, signerId) => {
    const shares = config.shares[signerId];
    if (shares === undefined) {
      logError('FRAME_CONSENSUS', `⚠️ BYZANTINE: Unknown signer ${signerId} in quorum calculation — skipped`);
      return total;
    }
    return total + shares;
  }, 0n);
};

export const sortSignatures = (signatures: Map<string, string>, config: ConsensusConfig): Map<string, string> => {
  const sortedEntries = Array.from(signatures.entries()).sort(([a], [b]) => {
    const indexA = config.validators.indexOf(a);
    const indexB = config.validators.indexOf(b);
    return indexA - indexB;
  });
  return new Map(sortedEntries);
};

// === ENTITY UTILITIES (existing) ===

/**
 * Gets entity state summary for debugging
 */
export const getEntityStateSummary = (replica: EntityReplica): string => {
  const hasProposal = replica.proposal ? '✓' : '✗';
  return `mempool=${replica.mempool.length}, messages=${replica.state.messages.length}, proposal=${hasProposal}`;
};

/**
 * Checks if entity should auto-propose (simplified version)
 */
export const shouldAutoPropose = (replica: EntityReplica, _config: ConsensusConfig): boolean => {
  const hasMempool = replica.mempool.length > 0;
  const isProposer = replica.isProposer;
  const hasProposal = replica.proposal !== undefined;

  return hasMempool && isProposer && !hasProposal;
};
