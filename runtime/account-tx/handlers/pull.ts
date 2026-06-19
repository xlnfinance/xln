import type { AccountMachine, AccountTx, CrossJurisdictionPullBinding, CrossJurisdictionSwapRoute } from '../../types';
import { deriveDelta } from '../../account-utils';
import { FINANCIAL, LIMITS } from '../../constants';
import {
  buildCommittedCrossJurisdictionPullBinding,
  cloneCrossJurisdictionPullBinding,
  hashCrossJurisdictionCloseBinary,
} from '../../cross-jurisdiction';
import {
  HASHLADDER_MAX_FILL_RATIO,
  verifyHashLadderBinary,
} from '../../hashladder';
import { addHold, releaseHold } from '../hold-utils';
import { ensureDelta } from '../delta-utils';

type PullLockTx = Extract<AccountTx, { type: 'pull_lock' }>;
type PullResolveTx = Extract<AccountTx, { type: 'pull_resolve' }>;
type PullCancelTx = Extract<AccountTx, { type: 'pull_cancel' }>;
type CrossPullCloseTx = Extract<AccountTx, { type: 'cross_pull_close' }>;

const HEX_32_RE = /^0x[0-9a-fA-F]{64}$/;

const absBigInt = (value: bigint): bigint => value >= 0n ? value : -value;
const isPullRevealExpired = (deadline: number, currentTimestamp: number): boolean =>
  Number.isFinite(deadline) && deadline > 0 && currentTimestamp >= deadline;
const isCrossJurisdictionPullCancelWithinClear = (route: CrossJurisdictionSwapRoute): boolean => (
  route.status === 'clearing' ||
  route.status === 'source_claimed' ||
  route.status === 'target_claimed' ||
  route.status === 'settled' ||
  route.clearingPolicy === 'cancel_and_clear' ||
  route.clearingPolicy === 'full_fill'
);
const findCrossJurisdictionRouteForPull = (
  accountMachine: AccountMachine,
  pullId: string,
): { route: CrossJurisdictionSwapRoute; leg: 'source' | 'target' } | undefined => {
  for (const offer of accountMachine.swapOffers?.values() ?? []) {
    const route = offer.crossJurisdiction;
    if (!route) continue;
    if (route.sourcePull?.pullId === pullId) return { route, leg: 'source' };
    if (route.targetPull?.pullId === pullId) return { route, leg: 'target' };
  }
  return undefined;
};

const committedCrossJurisdictionRatio = (binding: CrossJurisdictionPullBinding): number =>
  Math.max(
    0,
    Math.min(
      HASHLADDER_MAX_FILL_RATIO,
      Math.floor(Number(binding.cumulativeFillRatio ?? binding.claimedRatio ?? 0) || 0),
    ),
  );

const findCrossJurisdictionPullBinding = (
  accountMachine: AccountMachine,
  pullId: string,
): CrossJurisdictionPullBinding | undefined => {
  // Pull close/resolve validates the pull transformer, so the pull-local
  // binding is canonical. The account offer mirror can lag by one entity frame
  // while fill acks and clear requests are merged in the same runtime tick.
  const pullBinding = accountMachine.pulls?.get(pullId)?.crossJurisdiction;
  if (pullBinding) return pullBinding;
  const routeMatch = findCrossJurisdictionRouteForPull(accountMachine, pullId);
  if (routeMatch) return buildCommittedCrossJurisdictionPullBinding(routeMatch.route, routeMatch.leg);
  return undefined;
};

const crossProofMatchesBinding = (
  binding: CrossJurisdictionPullBinding,
  proof: CrossPullCloseTx['data']['proof'],
  pullId: string,
): string | null => {
  if (proof.orderId !== binding.orderId) return `order ${proof.orderId} != ${binding.orderId}`;
  if ((proof.routeHash || '').toLowerCase() !== (binding.routeHash || '').toLowerCase()) {
    return `routeHash ${proof.routeHash} != ${binding.routeHash}`;
  }
  const expectedPullId = binding.leg === 'source' ? proof.sourcePullId : proof.targetPullId;
  if (expectedPullId !== pullId) return `${binding.leg} pull ${expectedPullId} != ${pullId}`;
  const bindingRatio = committedCrossJurisdictionRatio(binding);
  if (bindingRatio > 0 && proof.fillRatio !== bindingRatio) {
    return `ratio ${proof.fillRatio} != committed ${bindingRatio}`;
  }
  const bindingSourceAmount = binding.filledSourceAmount ?? binding.sourceClaimed;
  const bindingTargetAmount = binding.filledTargetAmount ?? binding.targetClaimed;
  if (bindingSourceAmount !== undefined && proof.cumulativeSourceAmount !== bindingSourceAmount) {
    return `source amount ${proof.cumulativeSourceAmount} != ${bindingSourceAmount}`;
  }
  if (bindingTargetAmount !== undefined && proof.cumulativeTargetAmount !== bindingTargetAmount) {
    return `target amount ${proof.cumulativeTargetAmount} != ${bindingTargetAmount}`;
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

const validateCrossJurisdictionPullResolve = (
  binding: CrossJurisdictionPullBinding | undefined,
  ratio: number,
  binary: string,
): string | null => {
  if (!binding || ratio <= 0) return null;
  const status = binding.status || 'intent';
  const committedRatio = committedCrossJurisdictionRatio(binding);
  if (binding.leg === 'source') {
    if (!binding.targetReceipt) return `CROSS_J_SOURCE_PULL_RESOLVE_TARGET_RECEIPT_MISSING:${binding.orderId}`;
    if (status !== 'clear_requested' && status !== 'clearing') {
      return `CROSS_J_SOURCE_PULL_RESOLVE_BEFORE_CLEAR:${binding.orderId}:status=${status}`;
    }
    if (committedRatio <= 0) return `CROSS_J_SOURCE_PULL_RESOLVE_BEFORE_CLEAR:${binding.orderId}:committed=0`;
    if (ratio > committedRatio) {
      return `CROSS_J_SOURCE_PULL_RESOLVE_OVER_COMMITTED:${binding.orderId}:ratio=${ratio}:committed=${committedRatio}`;
    }
  } else {
    const sourceProof = binding.sourceCloseProof;
    if (!sourceProof) {
      return `CROSS_J_TARGET_PULL_RESOLVE_BEFORE_SOURCE_CLAIM:${binding.orderId}:sourceProof=missing:status=${status}`;
    }
    if (sourceProof.fillRatio !== ratio) {
      return `CROSS_J_TARGET_PULL_RESOLVE_SOURCE_PROOF_RATIO_MISMATCH:${binding.orderId}:ratio=${ratio}:proof=${sourceProof.fillRatio}`;
    }
    const binaryHash = hashCrossJurisdictionCloseBinary(binary);
    if ((binaryHash || '').toLowerCase() !== (sourceProof.binaryHash || '').toLowerCase()) {
      return `CROSS_J_TARGET_PULL_RESOLVE_SOURCE_PROOF_BINARY_MISMATCH:${binding.orderId}`;
    }
    if (committedRatio > 0 && ratio > committedRatio) {
      return `CROSS_J_TARGET_PULL_RESOLVE_OVER_COMMITTED:${binding.orderId}:ratio=${ratio}:committed=${committedRatio}`;
    }
  }
  return null;
};

export async function handlePullLock(
  accountMachine: AccountMachine,
  accountTx: PullLockTx,
  byLeft: boolean,
  currentHeight: number,
  currentTimestamp: number,
): Promise<{ success: boolean; events: string[]; error?: string }> {
  const { pullId, tokenId, amount, revealedUntilTimestamp, fullHash, partialRoot, crossJurisdiction } = accountTx.data;
  const events: string[] = [];

  if (!pullId || pullId.includes(':')) {
    return { success: false, error: `Invalid pullId`, events };
  }
  accountMachine.pulls ??= new Map();
  if (accountMachine.pulls.has(pullId)) {
    return { success: false, error: `Pull ${pullId} already exists`, events };
  }
  if (accountMachine.pulls.size >= LIMITS.MAX_ACCOUNT_SWAP_OFFERS) {
    return { success: false, error: `Too many open pulls`, events };
  }
  if (!HEX_32_RE.test(fullHash) || !HEX_32_RE.test(partialRoot)) {
    return { success: false, error: `Invalid pull hashladder commitment`, events };
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
  if (byLeft !== loserIsLeft) {
    return { success: false, error: `Only the paying side can create a pull lock`, events };
  }

  const delta = ensureDelta(accountMachine, tokenId);

  const loserCapacity = deriveDelta(delta, loserIsLeft).outCapacity;
  if (absAmount > loserCapacity) {
    return { success: false, error: `Insufficient pull capacity: need ${absAmount}, available ${loserCapacity}`, events };
  }

  const holdError = addHold(delta, loserIsLeft ? 'left' : 'right', absAmount);
  if (holdError) return { success: false, error: holdError, events };

  accountMachine.pulls.set(pullId, {
    pullId,
    tokenId,
    amount,
    claimedRatio: 0,
    claimedAmount: 0n,
    revealedUntilTimestamp,
    fullHash,
    partialRoot,
    ...(crossJurisdiction ? { crossJurisdiction: cloneCrossJurisdictionPullBinding(crossJurisdiction) } : {}),
    createdHeight: currentHeight,
    createdTimestamp: currentTimestamp,
  });

  events.push(`🪝 Pull locked: ${pullId.slice(0, 8)}... amount ${amount} token${tokenId}`);
  return { success: true, events };
}

export async function handlePullResolve(
  accountMachine: AccountMachine,
  accountTx: PullResolveTx,
  byLeft: boolean,
  currentTimestamp: number,
): Promise<{ success: boolean; events: string[]; error?: string; pullResolved?: { pullId: string; fillRatio: number } }> {
  const { pullId, binary } = accountTx.data;
  const events: string[] = [];
  const pull = accountMachine.pulls?.get(pullId);
  if (!pull) {
    return { success: false, error: `Pull ${pullId} not found`, events };
  }

  let decoded: { fillRatio: number };
  try {
    decoded = verifyHashLadderBinary(
      { fullHash: pull.fullHash, partialRoot: pull.partialRoot },
      binary,
    );
  } catch (error) {
    return { success: false, error: `Invalid pull binary: ${error instanceof Error ? error.message : String(error)}`, events };
  }
  const beneficiaryIsLeft = pull.amount > 0n;
  if (byLeft !== beneficiaryIsLeft) {
    return { success: false, error: `Only the pull beneficiary can resolve`, events };
  }
  const ratio = Math.max(0, Math.min(HASHLADDER_MAX_FILL_RATIO, Math.floor(Number(decoded.fillRatio) || 0)));
  const previousRatio = Math.max(0, Math.min(HASHLADDER_MAX_FILL_RATIO, Math.floor(Number(pull.claimedRatio ?? 0) || 0)));
  if (ratio <= previousRatio) {
    events.push(`🪝 Pull resolve ignored: ${pullId.slice(0, 8)}... fill ${ratio}/65535 already claimed ${previousRatio}/65535`);
    return { success: true, events, pullResolved: { pullId, fillRatio: previousRatio } };
  }
  if (ratio > 0 && isPullRevealExpired(pull.revealedUntilTimestamp, currentTimestamp)) {
    return { success: false, error: `Pull reveal deadline expired`, events };
  }
  const crossResolveError = validateCrossJurisdictionPullResolve(
    findCrossJurisdictionPullBinding(accountMachine, pullId),
    ratio,
    binary,
  );
  if (crossResolveError) return { success: false, error: crossResolveError, events };

  const delta = ensureDelta(accountMachine, pull.tokenId);

  const absAmount = absBigInt(pull.amount);
  const previousClaimed = pull.claimedAmount ?? ((absAmount * BigInt(previousRatio)) / BigInt(HASHLADDER_MAX_FILL_RATIO));
  const cumulativeClaimed = (absAmount * BigInt(ratio)) / BigInt(HASHLADDER_MAX_FILL_RATIO);
  const applied = cumulativeClaimed - previousClaimed;
  if (applied <= 0n) {
    pull.claimedRatio = ratio;
    pull.claimedAmount = previousClaimed;
    events.push(`🪝 Pull resolve ignored: ${pullId.slice(0, 8)}... no incremental claim`);
    return { success: true, events, pullResolved: { pullId, fillRatio: ratio } };
  }
  const loserIsLeft = !beneficiaryIsLeft;
  const holdError = releaseHold(
    delta,
    loserIsLeft ? 'left' : 'right',
    applied,
    () => `Pull ${loserIsLeft ? 'left' : 'right'} hold underflow`,
  );
  if (holdError) return { success: false, error: holdError, events };

  if (applied > 0n) {
    if (pull.amount > 0n) delta.offdelta += applied;
    else delta.offdelta -= applied;
  }
  if (ratio >= HASHLADDER_MAX_FILL_RATIO) {
    accountMachine.pulls?.delete(pullId);
  } else {
    pull.claimedRatio = ratio;
    pull.claimedAmount = cumulativeClaimed;
  }
  events.push(`🪝 Pull resolved: ${pullId.slice(0, 8)}... fill ${ratio}/65535 amount ${applied}`);
  return { success: true, events, pullResolved: { pullId, fillRatio: ratio } };
}

export async function handleCrossPullClose(
  accountMachine: AccountMachine,
  accountTx: CrossPullCloseTx,
  byLeft: boolean,
  currentTimestamp: number,
): Promise<{
  success: boolean;
  events: string[];
  error?: string;
  pullResolved?: { pullId: string; fillRatio: number };
  pullCancelled?: { pullId: string; status: 'cancelled' | 'already-closed' };
}> {
  const { pullId, binary, proof } = accountTx.data;
  const events: string[] = [];
  const pull = accountMachine.pulls?.get(pullId);
  if (!pull) {
    return {
      success: true,
      events: [`🪝 Cross-j pull close ignored: ${pullId.slice(0, 8)}... already closed`],
      pullCancelled: { pullId, status: 'already-closed' },
    };
  }
  const binding = findCrossJurisdictionPullBinding(accountMachine, pullId);
  if (!binding) return { success: false, error: `Cross-j close requires pull binding`, events };
  const proofError = crossProofMatchesBinding(binding, proof, pullId);
  if (proofError) return { success: false, error: `Cross-j close proof mismatch: ${proofError}`, events };
  const binaryHash = hashCrossJurisdictionCloseBinary(binary);
  if ((binaryHash || '').toLowerCase() !== (proof.binaryHash || '').toLowerCase()) {
    return { success: false, error: `Cross-j close binary hash mismatch`, events };
  }

  let decoded: { fillRatio: number };
  try {
    decoded = verifyHashLadderBinary({ fullHash: pull.fullHash, partialRoot: pull.partialRoot }, binary);
  } catch (error) {
    return { success: false, error: `Invalid cross-j close binary: ${error instanceof Error ? error.message : String(error)}`, events };
  }
  const ratio = Math.max(0, Math.min(HASHLADDER_MAX_FILL_RATIO, Math.floor(Number(proof.fillRatio) || 0)));
  if (decoded.fillRatio !== ratio) {
    return { success: false, error: `Cross-j close ratio mismatch: binary ${decoded.fillRatio} != proof ${ratio}`, events };
  }
  if (ratio > 0 && isPullRevealExpired(pull.revealedUntilTimestamp, currentTimestamp)) {
    return { success: false, error: `Pull reveal deadline expired`, events };
  }

  const beneficiaryIsLeft = pull.amount > 0n;
  if (byLeft !== beneficiaryIsLeft) {
    return { success: false, error: `Only the pull beneficiary can close cross-j pull`, events };
  }

  const delta = ensureDelta(accountMachine, pull.tokenId);

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
    if (pull.amount > 0n) delta.offdelta += applied;
    else delta.offdelta -= applied;
  }

  accountMachine.pulls?.delete(pullId);
  events.push(`🪝 Cross-j pull closed: ${pullId.slice(0, 8)}... ratio ${ratio}/65535 claimed ${applied} released ${remainingHold}`);
  return {
    success: true,
    events,
    pullResolved: { pullId, fillRatio: ratio },
    pullCancelled: { pullId, status: 'cancelled' },
  };
}

export async function handlePullCancel(
  accountMachine: AccountMachine,
  accountTx: PullCancelTx,
  byLeft: boolean,
  currentTimestamp: number,
): Promise<{ success: boolean; events: string[]; error?: string; pullCancelled?: { pullId: string; status: 'cancelled' | 'already-closed' } }> {
  const { pullId, reason } = accountTx.data;
  const events: string[] = [];
  const pull = accountMachine.pulls?.get(pullId);
  if (!pull) {
    return {
      success: true,
      events: [`🪝 Pull cancel ignored: ${pullId.slice(0, 8)}... already closed`],
      pullCancelled: { pullId, status: 'already-closed' },
    };
  }

  const beneficiaryIsLeft = pull.amount > 0n;
  const payerIsLeft = !beneficiaryIsLeft;
  const beneficiaryRelease = byLeft === beneficiaryIsLeft;
  const expiredPayerCancel = byLeft === payerIsLeft && isPullRevealExpired(pull.revealedUntilTimestamp, currentTimestamp);
  if (!beneficiaryRelease && !expiredPayerCancel) {
    return { success: false, error: `Only beneficiary can release an active pull, payer can cancel only after expiry`, events };
  }
  const crossRoute = findCrossJurisdictionRouteForPull(accountMachine, pullId);
  if (crossRoute && !isCrossJurisdictionPullCancelWithinClear(crossRoute.route)) {
    return {
      success: false,
      error: `Cross-j ${crossRoute.leg} pull ${pullId.slice(0, 8)} cancel blocked: route ${crossRoute.route.orderId} must clear through requestCrossJurisdictionClear`,
      events,
    };
  }

  const delta = ensureDelta(accountMachine, pull.tokenId);

  const absAmount = absBigInt(pull.amount);
  const claimedAmount = pull.claimedAmount ?? ((absAmount * BigInt(pull.claimedRatio ?? 0)) / BigInt(HASHLADDER_MAX_FILL_RATIO));
  const remainingHold = absAmount > claimedAmount ? absAmount - claimedAmount : 0n;
  const holdError = releaseHold(
    delta,
    payerIsLeft ? 'left' : 'right',
    remainingHold,
    () => `Pull ${payerIsLeft ? 'left' : 'right'} hold underflow`,
  );
  if (holdError) return { success: false, error: holdError, events };

  accountMachine.pulls?.delete(pullId);
  events.push(`🪝 Pull cancelled: ${pullId.slice(0, 8)}... released ${remainingHold}${reason ? ` (${reason})` : ''}`);
  return { success: true, events, pullCancelled: { pullId, status: 'cancelled' } };
}
