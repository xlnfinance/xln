import type { AccountMachine, AccountTx, CrossJurisdictionPullBinding, CrossJurisdictionSwapRoute } from '../../types';
import { deriveDelta } from '../../account-utils';
import { createDefaultDelta } from '../../validation-utils';
import { FINANCIAL, LIMITS } from '../../constants';
import { buildCrossJurisdictionPullBinding, cloneCrossJurisdictionPullBinding } from '../../cross-jurisdiction';
import {
  HASHLADDER_MAX_FILL_RATIO,
  verifyHashLadderBinary,
} from '../../hashladder';

type PullLockTx = Extract<AccountTx, { type: 'pull_lock' }>;
type PullResolveTx = Extract<AccountTx, { type: 'pull_resolve' }>;
type PullCancelTx = Extract<AccountTx, { type: 'pull_cancel' }>;

const HEX_32_RE = /^0x[0-9a-fA-F]{64}$/;

const absBigInt = (value: bigint): bigint => value >= 0n ? value : -value;
const isPullRevealExpired = (deadline: number, currentTimestamp: number): boolean =>
  Number.isFinite(deadline) && deadline > 0 && currentTimestamp >= deadline;
const hasCommittedCrossJurisdictionFill = (route: CrossJurisdictionSwapRoute): boolean => (
  Math.max(Number(route.cumulativeFillRatio ?? 0), Number(route.claimedRatio ?? 0)) > 0 ||
  (route.filledSourceAmount ?? 0n) > 0n ||
  (route.filledTargetAmount ?? 0n) > 0n ||
  (route.sourceClaimed ?? 0n) > 0n ||
  (route.targetClaimed ?? 0n) > 0n
);
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
  const routeMatch = findCrossJurisdictionRouteForPull(accountMachine, pullId);
  if (routeMatch) return buildCrossJurisdictionPullBinding(routeMatch.route, routeMatch.leg);
  return accountMachine.pulls?.get(pullId)?.crossJurisdiction;
};

const validateCrossJurisdictionPullResolve = (
  binding: CrossJurisdictionPullBinding | undefined,
  ratio: number,
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
    const targetStatusAllowed =
      status === 'target_prepared' ||
      status === 'target_locked' ||
      status === 'resting' ||
      status === 'clearing' ||
      status === 'source_claimed';
    if (!targetStatusAllowed) {
      return `CROSS_J_TARGET_PULL_RESOLVE_BEFORE_SOURCE_CLAIM:${binding.orderId}:status=${status}`;
    }
    // Target resolve pays the target beneficiary. It may arrive at the hub-side
    // account before that entity has mirrored source-claim metadata; the binary
    // itself is still verified against the committed target pull hash. Source
    // pull resolves remain strict above because those move user source funds.
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

  let delta = accountMachine.deltas.get(tokenId);
  if (!delta) {
    delta = createDefaultDelta(tokenId);
    accountMachine.deltas.set(tokenId, delta);
  }
  delta.leftHold ??= 0n;
  delta.rightHold ??= 0n;

  const loserCapacity = deriveDelta(delta, loserIsLeft).outCapacity;
  if (absAmount > loserCapacity) {
    return { success: false, error: `Insufficient pull capacity: need ${absAmount}, available ${loserCapacity}`, events };
  }

  if (loserIsLeft) delta.leftHold += absAmount;
  else delta.rightHold += absAmount;

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
  );
  if (crossResolveError) return { success: false, error: crossResolveError, events };

  let delta = accountMachine.deltas.get(pull.tokenId);
  if (!delta) {
    delta = createDefaultDelta(pull.tokenId);
    accountMachine.deltas.set(pull.tokenId, delta);
  }
  delta.leftHold ??= 0n;
  delta.rightHold ??= 0n;

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
  if (loserIsLeft) {
    if ((delta.leftHold || 0n) < applied) return { success: false, error: `Pull left hold underflow`, events };
    delta.leftHold -= applied;
  } else {
    if ((delta.rightHold || 0n) < applied) return { success: false, error: `Pull right hold underflow`, events };
    delta.rightHold -= applied;
  }

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
  if (
    crossRoute &&
    hasCommittedCrossJurisdictionFill(crossRoute.route) &&
    !isCrossJurisdictionPullCancelWithinClear(crossRoute.route)
  ) {
    return {
      success: false,
      error: `Cross-j ${crossRoute.leg} pull ${pullId.slice(0, 8)} cancel blocked: route ${crossRoute.route.orderId} must clear through requestCrossJurisdictionClear`,
      events,
    };
  }

  let delta = accountMachine.deltas.get(pull.tokenId);
  if (!delta) {
    delta = createDefaultDelta(pull.tokenId);
    accountMachine.deltas.set(pull.tokenId, delta);
  }
  delta.leftHold ??= 0n;
  delta.rightHold ??= 0n;

  const absAmount = absBigInt(pull.amount);
  const claimedAmount = pull.claimedAmount ?? ((absAmount * BigInt(pull.claimedRatio ?? 0)) / BigInt(HASHLADDER_MAX_FILL_RATIO));
  const remainingHold = absAmount > claimedAmount ? absAmount - claimedAmount : 0n;
  if (remainingHold > 0n) {
    if (payerIsLeft) {
      if ((delta.leftHold || 0n) < remainingHold) return { success: false, error: `Pull left hold underflow`, events };
      delta.leftHold -= remainingHold;
    } else {
      if ((delta.rightHold || 0n) < remainingHold) return { success: false, error: `Pull right hold underflow`, events };
      delta.rightHold -= remainingHold;
    }
  }

  accountMachine.pulls?.delete(pullId);
  events.push(`🪝 Pull cancelled: ${pullId.slice(0, 8)}... released ${remainingHold}${reason ? ` (${reason})` : ''}`);
  return { success: true, events, pullCancelled: { pullId, status: 'cancelled' } };
}
