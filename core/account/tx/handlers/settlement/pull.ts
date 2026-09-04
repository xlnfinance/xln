import type { AccountState, AccountTx, PullCommitment } from '../../../../types/account';
import type { AccountDraftState } from '../../../state/account-state-draft';
import type { CrossJurisdictionPullBinding, CrossJurisdictionSwapRoute } from '../../../../types/cross-jurisdiction';
import { deriveDelta } from '../../../utils';
import { FINANCIAL, LIMITS, TOKENS } from '../../../../config/constants';
import {
  buildCrossJurisdictionPullBinding,
  cloneCrossJurisdictionPullBinding,
  hashCrossJurisdictionCloseBinary,
  withCanonicalCrossJurisdictionRouteHash,
} from '../../../../extensions/cross-j/index';
import { getJurisdictionStackId } from '../../../../jurisdiction/machine/jurisdiction-stack';
import { safeStringify } from '../../../../protocol/serialization';
import {
  HASHLADDER_MAX_FILL_RATIO,
  verifyHashLadderBinary,
} from '../../../../protocol/htlc/hash-ladder';
import { addHold, releaseHold } from '../../hold-utils';
import { commitDeltaDraft, createDeltaDraft } from '../../delta-utils';
import { deriveTransferOffdeltaChange } from '../../../../protocol/transform/delta-movement';
import { createDefaultDelta } from '../../../state/delta';
import type { ApplyAccountTxResult } from '../../apply-types';
import { accountTxApplied, accountTxSwapCancelled, accountTxValidationRejected } from '../../apply-result';

type PullLockTx = Extract<AccountTx, { type: 'cross_pull_lock' }>;
type CrossPullCloseTx = Extract<AccountTx, { type: 'cross_pull_close' }>;

const HEX_32_RE = /^0x[0-9a-fA-F]{64}$/;

const absBigInt = (value: bigint): bigint => value >= 0n ? value : -value;
const crossProofMatchesBinding = (
  binding: CrossJurisdictionPullBinding,
  proof: CrossPullCloseTx['data']['proof'],
  pull: PullCommitment,
): string | null => {
  const pullId = pull.pullId;
  if (proof.orderId !== binding.orderId) return `order ${proof.orderId} != ${binding.orderId}`;
  if ((proof.routeHash || '').toLowerCase() !== (binding.routeHash || '').toLowerCase()) {
    return `routeHash ${proof.routeHash} != ${binding.routeHash}`;
  }
  const expectedPullId = binding.leg === 'source' ? proof.sourcePullId : proof.targetPullId;
  if (expectedPullId !== pullId) return `${binding.leg} pull ${expectedPullId} != ${pullId}`;
  // CANON (owner, 2026-08-07): off-chain fill progress is INFORMATIONAL only
  // and never reaches this binding. The settlement authority is the hash-ladder
  // reveal, which validateCrossPullCloseEvidence verifies against
  // fullHash/partialRoot at exactly proof.fillRatio; the close amounts are
  // validated exactly as the chain settles a dispute at this ratio:
  // proportional amount*ratio/65535 on this leg. (The hub holding every secret
  // can always choose the final ratio up to 100% until reveal time - inherent
  // to any matcher-holds-the-proof design and accepted.)
  const chainProportional = (total: bigint): bigint =>
    proof.fillRatio >= HASHLADDER_MAX_FILL_RATIO
      ? total
      : (total * BigInt(proof.fillRatio)) / BigInt(HASHLADDER_MAX_FILL_RATIO);
  const expectedLegAmount = chainProportional(absBigInt(pull.amount));
  const proofLegAmount = binding.leg === 'source'
    ? proof.cumulativeSourceAmount
    : proof.cumulativeTargetAmount;
  if (proofLegAmount !== expectedLegAmount) {
    return `${binding.leg} amount ${proofLegAmount} != chain-proportional ${expectedLegAmount}`;
  }
  return null;
};

const validateCrossPullCloseEvidence = (
  pull: PullCommitment,
  binding: CrossJurisdictionPullBinding,
  tx: CrossPullCloseTx,
): Readonly<{ ok: true; ratio: number } | { ok: false; error: string }> => {
  const { binary, proof } = tx.data;
  if (!Number.isSafeInteger(proof.fillRatio) || proof.fillRatio < 0 || proof.fillRatio > HASHLADDER_MAX_FILL_RATIO) {
    return { ok: false, error: `Cross-j close proof ratio out of uint16 range: ${proof.fillRatio}` };
  }
  const proofError = crossProofMatchesBinding(binding, proof, pull);
  if (proofError) return { ok: false, error: `Cross-j close proof mismatch: ${proofError}` };
  const binaryHash = hashCrossJurisdictionCloseBinary(binary);
  if (binaryHash.toLowerCase() !== proof.binaryHash.toLowerCase()) {
    return { ok: false, error: 'Cross-j close binary hash mismatch' };
  }
  let decodedRatio: number;
  try {
    decodedRatio = verifyHashLadderBinary({
      fullHash: pull.fullHash,
      partialRoot: pull.partialRoot,
    }, binary).fillRatio;
  } catch (error) {
    return {
      ok: false,
      error: `Invalid cross-j close binary: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  const ratio = proof.fillRatio;
  if (decodedRatio !== ratio) {
    return { ok: false, error: `Cross-j close ratio mismatch: binary ${decodedRatio} != proof ${ratio}` };
  }
  // Settlement clocks are dispute-relative unix seconds on L1. Source and
  // Target each use their beneficiary-side window from their own dispute S.
  // No sealed route/pull reveal deadline gates cooperative close.
  return { ok: true, ratio };
};

const validateCrossJurisdictionPullRoute = (account: AccountState, tx: PullLockTx): string | null => {
  const binding = tx.data.crossJurisdiction;
  const supplied = tx.data.crossJurisdictionRoute;
  if (!binding || !supplied) return 'Cross-j pull requires both route and binding';
  let route: CrossJurisdictionSwapRoute;
  try {
    route = withCanonicalCrossJurisdictionRouteHash(supplied);
  } catch (error) {
    return `Cross-j pull route invalid: ${error instanceof Error ? error.message : String(error)}`;
  }
  if (safeStringify(route) !== safeStringify(supplied)) return 'Cross-j pull route is not canonical';
  if (
    route.status !== 'resting' ||
    binding.status !== 'resting' ||
    route.sourceCloseProof !== undefined ||
    route.targetCloseProof !== undefined ||
    route.fillSeq !== undefined ||
    route.cumulativeFillRatio !== undefined ||
    route.fillNumerator !== undefined ||
    route.fillDenominator !== undefined ||
    route.filledSourceAmount !== undefined ||
    route.filledTargetAmount !== undefined ||
    route.pendingClearRequestedAt !== undefined ||
    route.claimedRatio !== undefined ||
    route.sourceClaimed !== undefined ||
    route.targetClaimed !== undefined ||
    route.settledAt !== undefined
  ) {
    return 'Cross-j pull opening must be a zero-progress resting route';
  }
  if (safeStringify(binding) !== safeStringify(buildCrossJurisdictionPullBinding(route, binding.leg))) {
    return 'Cross-j pull binding does not match route';
  }
  const leg = binding.leg === 'source' ? route.source : route.target;
  const pull = binding.leg === 'source' ? route.sourcePull : route.targetPull;
  if (!pull || tx.data.pullId !== pull.pullId || tx.data.tokenId !== pull.tokenId || tx.data.amount !== pull.signedAmount ||
      tx.data.fullHash.toLowerCase() !== pull.fullHash.toLowerCase() ||
      tx.data.partialRoot.toLowerCase() !== pull.partialRoot.toLowerCase()) return 'Cross-j pull terms do not match route';
  const endpoints = new Set([account.leftEntity.toLowerCase(), account.rightEntity.toLowerCase()]);
  if (!endpoints.has(leg.entityId.toLowerCase()) || !endpoints.has(leg.counterpartyEntityId.toLowerCase())) {
    return 'Cross-j pull Account endpoints do not match route leg';
  }
  return getJurisdictionStackId(account.domain) === leg.jurisdiction.toLowerCase()
    ? null
    : 'Cross-j pull jurisdiction does not match Account domain';
};

const getNewPullSlotError = (
  account: AccountState,
  pullId: string,
  crossJurisdiction: PullLockTx['data']['crossJurisdiction'],
): string | null => {
  if (!pullId || pullId.includes(':')) return 'Invalid pullId';
  if (account.pulls?.has(pullId)) return `Pull ${pullId} already exists`;
  if ((account.pulls?.size ?? 0) >= LIMITS.MAX_ACCOUNT_SWAP_OFFERS) return 'Too many open pulls';
  if (!crossJurisdiction) return null;
  let liveCrossJurisdictionPulls = 0;
  for (const existing of account.pulls?.values() ?? []) {
    if (existing.crossJurisdiction) liveCrossJurisdictionPulls += 1;
  }
  return liveCrossJurisdictionPulls >= LIMITS.MAX_ACCOUNT_CROSS_J_SWAP_OFFERS
    ? `Too many open cross-j pulls: max ${LIMITS.MAX_ACCOUNT_CROSS_J_SWAP_OFFERS}`
    : null;
};

const validatePullHashMaterial = (
  account: AccountState,
  fullHash: string,
  partialRoot: string,
  orderId: string,
): string | null => {
  if (!HEX_32_RE.test(fullHash) || !HEX_32_RE.test(partialRoot)) {
    return 'Invalid pull hashladder commitment';
  }
  const normalizedFullHash = fullHash.toLowerCase();
  const normalizedPartialRoot = partialRoot.toLowerCase();
  for (const existing of account.pulls?.values() ?? []) {
    const existingOrderId = String(existing.crossJurisdiction?.orderId || '').trim();
    if (existingOrderId && orderId && existingOrderId === orderId) continue;
    if (
      existing.fullHash.toLowerCase() === normalizedFullHash
      || existing.partialRoot.toLowerCase() === normalizedPartialRoot
    ) return `Pull hash material collides with live pull ${existing.pullId}`;
  }
  return null;
};

/** Exact non-mutating admission shared by Entity preflight and Account apply. */
export const getPullLockAdmissionError = (
  account: AccountState,
  accountTx: PullLockTx,
): string | null => {
  const { pullId, tokenId, amount, fullHash, partialRoot, crossJurisdiction } = accountTx.data;
  const routeError = validateCrossJurisdictionPullRoute(account, accountTx);
  if (routeError) return routeError;
  const slotError = getNewPullSlotError(account, pullId, crossJurisdiction);
  if (slotError) return slotError;
  const orderId = String(crossJurisdiction?.orderId || '').trim();
  const hashError = validatePullHashMaterial(account, fullHash, partialRoot, orderId);
  if (hashError) return hashError;
  if (!Number.isSafeInteger(tokenId) || tokenId < 0 || tokenId > TOKENS.MAX_TOKEN_ID) {
    return 'Invalid pull tokenId';
  }
  if (amount === 0n) return 'Pull amount must be non-zero';
  const absAmount = absBigInt(amount);
  if (absAmount < FINANCIAL.MIN_PAYMENT_AMOUNT || absAmount > FINANCIAL.MAX_PAYMENT_AMOUNT) {
    return `Pull amount out of bounds: ${absAmount}`;
  }
  const delta = account.deltas.get(tokenId) ?? createDefaultDelta(tokenId);
  const loserCapacity = deriveDelta(delta, amount < 0n).outCapacity;
  return absAmount > loserCapacity
    ? `Insufficient pull capacity: need ${absAmount}, available ${loserCapacity}`
    : null;
};

export async function handlePullLock(
  account: AccountDraftState,
  accountTx: PullLockTx,
  _byLeft: boolean,
  currentHeight: number,
  currentTimestamp: number,
): Promise<ApplyAccountTxResult> {
  const { pullId, tokenId, amount, fullHash, partialRoot, crossJurisdiction } = accountTx.data;
  const events: string[] = [];

  const admissionError = getPullLockAdmissionError(account, accountTx);
  if (admissionError) return accountTxValidationRejected(admissionError, events);
  const absAmount = absBigInt(amount);

  const beneficiaryIsLeft = amount > 0n;
  const loserIsLeft = !beneficiaryIsLeft;
  // Either side may propose a pull. A proposal signed only by its proposer is
  // pending bilateral state: it cannot become enforceable or resolvable until
  // the counterparty validates the exact frame and returns its ACK/Hanko. This
  // is what lets a cross-j Hub propose the source pull while the User Runtime
  // atomically decides whether to ACK it beside the matching target pull.

  const delta = createDeltaDraft(account, tokenId);

  const holdError = addHold(delta, loserIsLeft ? 'left' : 'right', absAmount);
  if (holdError) return accountTxValidationRejected(holdError, events);

  // No sealed pull reveal deadline. Settlement clock is dispute-relative
  // seconds on L1; cooperative close is event-driven (hashladder reveal).
  commitDeltaDraft(account, delta);
  account.pulls.put(pullId, {
    pullId,
    tokenId,
    amount,
    claimedRatio: 0,
    claimedAmount: 0n,
    fullHash,
    partialRoot,
    crossJurisdiction: cloneCrossJurisdictionPullBinding(crossJurisdiction),
    createdHeight: currentHeight,
    createdTimestamp: currentTimestamp,
  });

  events.push(`🪝 Pull locked: ${pullId.slice(0, 8)}... amount ${amount} token${tokenId}`);
  return accountTxApplied(events);
}

export async function handleCrossPullClose(
  account: AccountDraftState,
  accountTx: CrossPullCloseTx,
  byLeft: boolean,
  _currentTimestamp: number,
): Promise<ApplyAccountTxResult> {
  const { pullId, proof } = accountTx.data;
  const events: string[] = [];
  const pull = account.pulls?.get(pullId);
  if (!pull) {
    return accountTxApplied([`🪝 Cross-j pull close ignored: ${pullId.slice(0, 8)}... already closed`]);
  }
  const binding = pull.crossJurisdiction;
  if (!binding) return accountTxValidationRejected(`Cross-j close requires pull binding`, events);
  const evidence = validateCrossPullCloseEvidence(pull, binding, accountTx);
  if (!evidence.ok) return accountTxValidationRejected(evidence.error, events);
  const ratio = evidence.ratio;

  const beneficiaryIsLeft = pull.amount > 0n;
  // Cross-j close economics are authored by the Hub Runtime as one exact
  // source+target cohort. The source Hub is the source-pull beneficiary; the
  // target Hub is the target-pull payer. Letting the target User (beneficiary)
  // propose its own close would let it choose cumulative settlement amounts
  // that the target pull commitment alone does not bind.
  const authorizedHubIsLeft = binding.leg === 'source'
    ? beneficiaryIsLeft
    : !beneficiaryIsLeft;
  if (byLeft !== authorizedHubIsLeft) {
    return accountTxValidationRejected(
      `Only the ${binding.leg} Hub can close cross-j pull`,
      events,
    );
  }

  const delta = createDeltaDraft(account, pull.tokenId);

  const absAmount = absBigInt(pull.amount);
  const previousRatio = Math.max(0, Math.min(HASHLADDER_MAX_FILL_RATIO, Math.floor(Number(pull.claimedRatio ?? 0) || 0)));
  if (ratio < previousRatio) {
    return accountTxValidationRejected(`Cross-j close ratio regression: ${ratio} < ${previousRatio}`, events);
  }
  const previousClaimed = pull.claimedAmount ?? ((absAmount * BigInt(previousRatio)) / BigInt(HASHLADDER_MAX_FILL_RATIO));
  const cumulativeClaimed = binding.leg === 'source'
    ? proof.cumulativeSourceAmount
    : proof.cumulativeTargetAmount;
  if (cumulativeClaimed < previousClaimed) {
    return accountTxValidationRejected(`Cross-j close amount regression: ${cumulativeClaimed} < ${previousClaimed}`, events);
  }
  if (cumulativeClaimed > absAmount) {
    return accountTxValidationRejected(`Cross-j close amount overflow: ${cumulativeClaimed} > ${absAmount}`, events);
  }
  const applied = cumulativeClaimed - previousClaimed;
  const remainingHold = absAmount > cumulativeClaimed ? absAmount - cumulativeClaimed : 0n;
  const payerIsLeft = !beneficiaryIsLeft;
  const debitHold = applied + remainingHold;
  const holdError = releaseHold(
    delta,
    payerIsLeft ? 'left' : 'right',
    debitHold,
    () => `Pull ${payerIsLeft ? 'left' : 'right'} hold underflow`,
  );
  if (holdError) return accountTxValidationRejected(holdError, events);
  if (applied > 0n) {
    delta.offdelta += deriveTransferOffdeltaChange(payerIsLeft, applied);
  }

  commitDeltaDraft(account, delta);
  account.pulls.del(pullId);
  events.push(`🪝 Cross-j pull closed: ${pullId.slice(0, 8)}... ratio ${ratio}/${HASHLADDER_MAX_FILL_RATIO} claimed ${applied} released ${remainingHold}`);
  // The source offer is bound to this pull; the close is the only Account tx
  // that retires it (fill progress never touches the Account offer).
  const offer = binding.leg === 'source' ? account.swapOffers?.get(binding.orderId) : undefined;
  if (offer?.crossJurisdiction) {
    account.swapOffers.del(binding.orderId);
    events.push(`🌉 Cross-j offer ${binding.orderId.slice(0, 8)} closed with pull`);
    return accountTxSwapCancelled(events, {
      offerId: binding.orderId,
      accountId: offer.makerIsLeft ? account.leftEntity : account.rightEntity,
    });
  }
  return accountTxApplied(events);
}
