import type { AccountState, AccountTx, PullCommitment } from '../../../types/account';
import type { CrossJurisdictionPullBinding, CrossJurisdictionSwapRoute } from '../../../types/cross-jurisdiction';
import { deriveDelta } from '../../utils';
import { FINANCIAL, LIMITS } from '../../../config/constants';
import {
  buildCrossJurisdictionPullBinding,
  cloneCrossJurisdictionPullBinding,
  getCrossJurisdictionCommittedProofRatio,
  hashCrossJurisdictionCloseBinary,
  projectCrossJurisdictionQuantizedClaim,
  withCanonicalCrossJurisdictionRouteHash,
} from '../../../extensions/cross-j/index';
import { getJurisdictionStackId } from '../../../jurisdiction/machine/jurisdiction-stack';
import { safeStringify } from '../../../protocol/serialization';
import {
  HASHLADDER_MAX_FILL_RATIO,
  verifyHashLadderBinary,
} from '../../../protocol/htlc/hash-ladder';
import { addHold, releaseHold } from '../hold-utils';
import { ensureDelta } from '../delta-utils';
import { isPullRevealExpired } from '../../pull-deadline';
import { deriveTransferOffdeltaChange } from '../../../protocol/delta-movement';

type PullLockTx = Extract<AccountTx, { type: 'cross_pull_lock' }>;
type CrossPullCloseTx = Extract<AccountTx, { type: 'cross_pull_close' }>;
type CrossPullProgressTx = Extract<AccountTx, { type: 'cross_pull_progress' }>;

const HEX_32_RE = /^0x[0-9a-fA-F]{64}$/;

const absBigInt = (value: bigint): bigint => value >= 0n ? value : -value;
const committedCrossJurisdictionRatio = (binding: CrossJurisdictionPullBinding): number =>
  getCrossJurisdictionCommittedProofRatio(binding);

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
  // CANON (owner, 2026-08-07): off-chain fill progress is INFORMATIONAL only -
  // the hub saying "matched X%" without secrets - and must never gate a close.
  // The settlement authority is the hash-ladder reveal, which
  // validateCrossPullCloseEvidence verifies against fullHash/partialRoot at
  // exactly proof.fillRatio. The hub's actual fill legally runs ahead of its
  // last progress message, so a close ABOVE the informed ratio is normal
  // (lagging delivery, or the hub matched more since). Only a close BELOW the
  // informed ratio is rejected: informed fill is monotonic and a rollback
  // would let the hub un-match what both sides were already told.
  // (The hub holding every secret can always choose the final ratio up to
  // 100% until reveal time - that is inherent to any matcher-holds-the-proof
  // design and is accepted, not a bug to guard against here.)
  const bindingRatio = committedCrossJurisdictionRatio(binding);
  if (proof.fillRatio < bindingRatio) {
    return `ratio ${proof.fillRatio} rolls back informed ${bindingRatio}`;
  }
  const bindingIsCurrent = proof.fillRatio === bindingRatio;
  const bindingSourceAmount = binding.filledSourceAmount ?? binding.sourceClaimed;
  const bindingTargetAmount = binding.filledTargetAmount ?? binding.targetClaimed;
  // The source Hub is the source-pull beneficiary, so its signed Account frame
  // must never choose the payer's debit. When informational progress is
  // current, exact rational economics from the binding are the canonical
  // amounts (price improvement rides only this path - it is a best-effort
  // gift from the hub, absent by design when info lags). When the close ratio
  // runs AHEAD of the informed binding, the stale binding amounts cannot bind
  // it; the amounts are then validated exactly as the chain would settle a
  // dispute at this ratio: proportional amount*ratio/65535.
  const chainProportional = (total: bigint): bigint =>
    proof.fillRatio >= HASHLADDER_MAX_FILL_RATIO
      ? total
      : (total * BigInt(proof.fillRatio)) / BigInt(HASHLADDER_MAX_FILL_RATIO);
  if (bindingIsCurrent) {
    const expectedSourceAmount = bindingSourceAmount ?? (
      binding.leg === 'source'
        ? projectCrossJurisdictionQuantizedClaim(absBigInt(pull.amount), {
            cumulativeFillRatio: bindingRatio,
            ...(binding.fillNumerator !== undefined ? { fillNumerator: binding.fillNumerator } : {}),
            ...(binding.fillDenominator !== undefined ? { fillDenominator: binding.fillDenominator } : {}),
            orderId: binding.orderId,
          }).exactClaim
        : undefined
    );
    if (expectedSourceAmount !== undefined && proof.cumulativeSourceAmount !== expectedSourceAmount) {
      return `source amount ${proof.cumulativeSourceAmount} != committed ${expectedSourceAmount}`;
    }
    if (bindingTargetAmount !== undefined && proof.cumulativeTargetAmount !== bindingTargetAmount) {
      return `target amount ${proof.cumulativeTargetAmount} != ${bindingTargetAmount}`;
    }
  } else {
    const expectedLegAmount = chainProportional(absBigInt(pull.amount));
    const proofLegAmount = binding.leg === 'source'
      ? proof.cumulativeSourceAmount
      : proof.cumulativeTargetAmount;
    if (proofLegAmount !== expectedLegAmount) {
      return `${binding.leg} amount ${proofLegAmount} != chain-proportional ${expectedLegAmount}`;
    }
  }
  if (binding.sourceCloseProof) {
    const sourceProof = binding.sourceCloseProof;
    if (
      sourceProof.orderId !== proof.orderId ||
      (sourceProof.routeHash || '').toLowerCase() !== (proof.routeHash || '').toLowerCase() ||
      sourceProof.sourcePullId !== proof.sourcePullId ||
      sourceProof.targetPullId !== proof.targetPullId ||
      sourceProof.fillRatio !== proof.fillRatio ||
      sourceProof.cumulativeSourceAmount !== proof.cumulativeSourceAmount ||
      sourceProof.cumulativeTargetAmount !== proof.cumulativeTargetAmount ||
      (sourceProof.binaryHash || '').toLowerCase() !== (proof.binaryHash || '').toLowerCase()
    ) {
      return `source close proof mismatch`;
    }
  }
  return null;
};

const validateCrossPullCloseEvidence = (
  pull: PullCommitment,
  binding: CrossJurisdictionPullBinding,
  tx: CrossPullCloseTx,
  currentTimestamp: number,
): Readonly<{ ok: true; ratio: number } | { ok: false; error: string }> => {
  const { binary, proof } = tx.data;
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
  const ratio = Math.max(
    0,
    Math.min(HASHLADDER_MAX_FILL_RATIO, Math.floor(Number(proof.fillRatio) || 0)),
  );
  if (decodedRatio !== ratio) {
    return { ok: false, error: `Cross-j close ratio mismatch: binary ${decodedRatio} != proof ${ratio}` };
  }
  if (ratio > 0 && isPullRevealExpired(pull.revealedUntilTimestamp, currentTimestamp)) {
    return { ok: false, error: 'Pull reveal deadline expired' };
  }
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
    route.priceImprovementSourceAmount !== undefined ||
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
      tx.data.revealedUntilTimestamp !== pull.revealedUntilTimestamp ||
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

export async function handlePullLock(
  account: AccountState,
  accountTx: PullLockTx,
  _byLeft: boolean,
  currentHeight: number,
  currentTimestamp: number,
): Promise<{ success: boolean; events: string[]; error?: string }> {
  const { pullId, tokenId, amount, revealedUntilTimestamp, fullHash, partialRoot, crossJurisdiction } = accountTx.data;
  const events: string[] = [];

  const crossJurisdictionRouteError = validateCrossJurisdictionPullRoute(account, accountTx);
  if (crossJurisdictionRouteError) return { success: false, error: crossJurisdictionRouteError, events };

  if (!pullId || pullId.includes(':')) {
    return { success: false, error: `Invalid pullId`, events };
  }
  account.pulls ??= new Map();
  if (account.pulls.has(pullId)) {
    return { success: false, error: `Pull ${pullId} already exists`, events };
  }
  if (account.pulls.size >= LIMITS.MAX_ACCOUNT_SWAP_OFFERS) {
    return { success: false, error: `Too many open pulls`, events };
  }
  if (!HEX_32_RE.test(fullHash) || !HEX_32_RE.test(partialRoot)) {
    return { success: false, error: `Invalid pull hashladder commitment`, events };
  }
  // INVARIANT: unique hashladder root per orderId. Runtime admission also
  // scans every Entity/Account/swap in the Runtime; this Account-local guard
  // catches same-frame sequential locks and anything that slipped past.
  // Same orderId may reuse its own ladder (source/target of one swap).
  const orderId = String(crossJurisdiction?.orderId || '').trim();
  const normalizedFullHash = fullHash.toLowerCase();
  const normalizedPartialRoot = partialRoot.toLowerCase();
  for (const existing of account.pulls.values()) {
    const existingOrderId = String(existing.crossJurisdiction?.orderId || '').trim();
    if (existingOrderId && orderId && existingOrderId === orderId) continue;
    if (
      existing.fullHash.toLowerCase() === normalizedFullHash ||
      existing.partialRoot.toLowerCase() === normalizedPartialRoot
    ) {
      return {
        success: false,
        error: `Pull hash material collides with live pull ${existing.pullId}`,
        events,
      };
    }
  }
  if (!Number.isInteger(tokenId) || tokenId < 0) {
    return { success: false, error: `Invalid pull tokenId`, events };
  }
  if (amount === 0n) {
    return { success: false, error: `Pull amount must be non-zero`, events };
  }
  const absAmount = absBigInt(amount);
  if (absAmount < FINANCIAL.MIN_PAYMENT_AMOUNT || absAmount > FINANCIAL.MAX_PAYMENT_AMOUNT) {
    return { success: false, error: `Pull amount out of bounds: ${absAmount}`, events };
  }
  // Pull deadlines are absolute wall-clock milliseconds. Cross-jurisdiction
  // legs cannot compare local block numbers across chains with different block times.
  if (!Number.isFinite(revealedUntilTimestamp) || revealedUntilTimestamp <= currentTimestamp) {
    return { success: false, error: `Invalid pull reveal deadline`, events };
  }

  const beneficiaryIsLeft = amount > 0n;
  const loserIsLeft = !beneficiaryIsLeft;
  // Either side may propose a pull. A proposal signed only by its proposer is
  // pending bilateral state: it cannot become enforceable or resolvable until
  // the counterparty validates the exact frame and returns its ACK/Hanko. This
  // is what lets a cross-j Hub propose the source pull while the User Runtime
  // atomically decides whether to ACK it beside the matching target pull.

  const delta = ensureDelta(account, tokenId);

  const loserCapacity = deriveDelta(delta, loserIsLeft).outCapacity;
  if (absAmount > loserCapacity) {
    return { success: false, error: `Insufficient pull capacity: need ${absAmount}, available ${loserCapacity}`, events };
  }

  const holdError = addHold(delta, loserIsLeft ? 'left' : 'right', absAmount);
  if (holdError) return { success: false, error: holdError, events };

  account.pulls.set(pullId, {
    pullId,
    tokenId,
    amount,
    claimedRatio: 0,
    claimedAmount: 0n,
    revealedUntilTimestamp,
    fullHash,
    partialRoot,
    crossJurisdiction: cloneCrossJurisdictionPullBinding(crossJurisdiction),
    createdHeight: currentHeight,
    createdTimestamp: currentTimestamp,
  });

  events.push(`🪝 Pull locked: ${pullId.slice(0, 8)}... amount ${amount} token${tokenId}`);
  return { success: true, events };
}

export async function handleCrossPullClose(
  account: AccountState,
  accountTx: CrossPullCloseTx,
  byLeft: boolean,
  currentTimestamp: number,
): Promise<{
  success: boolean;
  events: string[];
  error?: string;
}> {
  const { pullId, proof } = accountTx.data;
  const events: string[] = [];
  const pull = account.pulls?.get(pullId);
  if (!pull) {
    return {
      success: true,
      events: [`🪝 Cross-j pull close ignored: ${pullId.slice(0, 8)}... already closed`],
    };
  }
  const binding = pull.crossJurisdiction;
  if (!binding) return { success: false, error: `Cross-j close requires pull binding`, events };
  const evidence = validateCrossPullCloseEvidence(pull, binding, accountTx, currentTimestamp);
  if (!evidence.ok) return { success: false, error: evidence.error, events };
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
    return {
      success: false,
      error: `Only the ${binding.leg} Hub can close cross-j pull`,
      events,
    };
  }

  const delta = ensureDelta(account, pull.tokenId);

  const absAmount = absBigInt(pull.amount);
  const previousRatio = Math.max(0, Math.min(HASHLADDER_MAX_FILL_RATIO, Math.floor(Number(pull.claimedRatio ?? 0) || 0)));
  if (ratio < previousRatio) {
    return { success: false, error: `Cross-j close ratio regression: ${ratio} < ${previousRatio}`, events };
  }
  const previousClaimed = pull.claimedAmount ?? ((absAmount * BigInt(previousRatio)) / BigInt(HASHLADDER_MAX_FILL_RATIO));
  const cumulativeClaimed = binding.leg === 'source'
    ? proof.cumulativeSourceAmount
    : proof.cumulativeTargetAmount;
  if (cumulativeClaimed < previousClaimed) {
    return { success: false, error: `Cross-j close amount regression: ${cumulativeClaimed} < ${previousClaimed}`, events };
  }
  if (cumulativeClaimed > absAmount) {
    return { success: false, error: `Cross-j close amount overflow: ${cumulativeClaimed} > ${absAmount}`, events };
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
  if (holdError) return { success: false, error: holdError, events };
  if (applied > 0n) {
    delta.offdelta += deriveTransferOffdeltaChange(payerIsLeft, applied);
  }

  account.pulls?.delete(pullId);
  events.push(`🪝 Cross-j pull closed: ${pullId.slice(0, 8)}... ratio ${ratio}/${HASHLADDER_MAX_FILL_RATIO} claimed ${applied} released ${remainingHold}`);
  return {
    success: true,
    events,
  };
}

export async function handleCrossPullProgress(
  account: AccountState,
  accountTx: CrossPullProgressTx,
  byLeft: boolean,
): Promise<{ success: boolean; events: string[]; error?: string }> {
  const events: string[] = [];
  const { pullId, fill } = accountTx.data;
  const pull = account.pulls?.get(pullId);
  if (!pull) return { success: false, error: `Cross-j target pull ${pullId} not found`, events };
  const binding = pull.crossJurisdiction;
  if (binding.leg !== 'target') {
    return { success: false, error: `Cross-j progress requires target pull`, events };
  }
  if (
    fill.offerId !== binding.orderId ||
    !fill.routeHash ||
    fill.routeHash.toLowerCase() !== binding.routeHash.toLowerCase()
  ) {
    return { success: false, error: `Cross-j progress route mismatch`, events };
  }

  const beneficiaryIsLeft = pull.amount > 0n;
  if (byLeft === beneficiaryIsLeft) {
    return { success: false, error: `Only the target Hub can advance cross-j pull`, events };
  }
  const currentSeq = Math.max(0, Math.floor(Number(binding.fillSeq ?? 0) || 0));
  const nextSeq = Math.floor(Number(fill.fillSeq));
  const previousSeq = Math.floor(Number(fill.previousFillSeq));
  if (fill.ackKind !== 'fill' && fill.ackKind !== 'cancel') {
    return { success: false, error: `Cross-j progress kind invalid`, events };
  }
  const cancelling = fill.ackKind === 'cancel';
  if (cancelling && fill.cancelRemainder !== true) {
    return { success: false, error: `Cross-j cancel progress must clear remainder`, events };
  }
  if (
    previousSeq !== currentSeq ||
    (!cancelling && nextSeq !== currentSeq + 1) ||
    (cancelling && nextSeq !== currentSeq)
  ) {
    return { success: false, error: `Cross-j progress sequence mismatch`, events };
  }

  let nextRatio: number;
  try {
    nextRatio = getCrossJurisdictionCommittedProofRatio({
      orderId: fill.offerId,
      cumulativeFillRatio: fill.cumulativeFillRatio,
      fillNumerator: fill.fillNumerator,
      fillDenominator: fill.fillDenominator,
    });
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error), events };
  }
  const currentRatio = committedCrossJurisdictionRatio(binding);
  const priorSource = binding.filledSourceAmount ?? 0n;
  const priorTarget = binding.filledTargetAmount ?? 0n;
  const nextSource = fill.cumulativeSourceAmount;
  const nextTarget = fill.cumulativeTargetAmount;
  const sourceIncrement = fill.incrementalSourceAmount;
  const targetIncrement = fill.incrementalTargetAmount;
  if (
    nextSource === undefined || nextTarget === undefined ||
    sourceIncrement === undefined || targetIncrement === undefined ||
    nextSource < priorSource || nextTarget < priorTarget ||
    sourceIncrement !== nextSource - priorSource ||
    targetIncrement !== nextTarget - priorTarget ||
    nextTarget > absBigInt(pull.amount) ||
    (!cancelling && (nextRatio <= currentRatio || sourceIncrement <= 0n || targetIncrement <= 0n)) ||
    (cancelling && (nextRatio !== currentRatio || sourceIncrement !== 0n || targetIncrement !== 0n))
  ) {
    return { success: false, error: `Cross-j progress amounts mismatch`, events };
  }

  binding.fillSeq = nextSeq;
  binding.cumulativeFillRatio = nextRatio;
  if (fill.fillNumerator !== undefined) binding.fillNumerator = fill.fillNumerator;
  if (fill.fillDenominator !== undefined) binding.fillDenominator = fill.fillDenominator;
  binding.filledSourceAmount = nextSource;
  binding.filledTargetAmount = nextTarget;
  binding.status = cancelling || nextRatio >= HASHLADDER_MAX_FILL_RATIO
    ? 'clear_requested'
    : 'partially_filled';
  if (cancelling) binding.clearingPolicy = 'cancel_and_clear';
  events.push(`🌉 Cross-j target progress ${fill.offerId.slice(0, 8)} ${nextRatio}/${HASHLADDER_MAX_FILL_RATIO}`);
  return { success: true, events };
}
