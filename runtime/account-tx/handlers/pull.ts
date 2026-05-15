import type { AccountMachine, AccountTx } from '../../types';
import { deriveDelta } from '../../account-utils';
import { createDefaultDelta } from '../../validation-utils';
import { FINANCIAL, LIMITS } from '../../constants';
import {
  HASHLADDER_MAX_FILL_RATIO,
  verifyHashLadderBinary,
} from '../../hashladder';

type PullLockTx = Extract<AccountTx, { type: 'pull_lock' }>;
type PullResolveTx = Extract<AccountTx, { type: 'pull_resolve' }>;

const HEX_32_RE = /^0x[0-9a-fA-F]{64}$/;

const absBigInt = (value: bigint): bigint => value >= 0n ? value : -value;

export async function handlePullLock(
  accountMachine: AccountMachine,
  accountTx: PullLockTx,
  byLeft: boolean,
  currentHeight: number,
  currentTimestamp: number,
): Promise<{ success: boolean; events: string[]; error?: string }> {
  const { pullId, tokenId, amount, revealedUntilBlock, fullHash, partialRoot } = accountTx.data;
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
  // currentHeight is the account frame's jurisdiction height, not the bilateral
  // account-frame number. On-chain DeltaTransformer enforces the same value
  // against block.number during dispute finalization.
  if (!Number.isFinite(revealedUntilBlock) || revealedUntilBlock <= currentHeight) {
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
    revealedUntilBlock,
    fullHash,
    partialRoot,
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
  currentHeight: number,
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
  const ratio = Math.max(0, Math.min(HASHLADDER_MAX_FILL_RATIO, Math.floor(Number(decoded.fillRatio) || 0)));
  const beneficiaryIsLeft = pull.amount > 0n;
  if (byLeft !== beneficiaryIsLeft) {
    return { success: false, error: `Only the pull beneficiary can resolve`, events };
  }
  if (ratio > 0 && currentHeight > pull.revealedUntilBlock) {
    return { success: false, error: `Pull reveal deadline expired`, events };
  }

  let delta = accountMachine.deltas.get(pull.tokenId);
  if (!delta) {
    delta = createDefaultDelta(pull.tokenId);
    accountMachine.deltas.set(pull.tokenId, delta);
  }
  delta.leftHold ??= 0n;
  delta.rightHold ??= 0n;

  const absAmount = absBigInt(pull.amount);
  const applied = (absAmount * BigInt(ratio)) / BigInt(HASHLADDER_MAX_FILL_RATIO);
  const loserIsLeft = !beneficiaryIsLeft;
  if (loserIsLeft) {
    if ((delta.leftHold || 0n) < absAmount) return { success: false, error: `Pull left hold underflow`, events };
    delta.leftHold -= absAmount;
  } else {
    if ((delta.rightHold || 0n) < absAmount) return { success: false, error: `Pull right hold underflow`, events };
    delta.rightHold -= absAmount;
  }

  if (applied > 0n) {
    if (pull.amount > 0n) delta.offdelta += applied;
    else delta.offdelta -= applied;
  }
  accountMachine.pulls?.delete(pullId);
  events.push(`🪝 Pull resolved: ${pullId.slice(0, 8)}... fill ${ratio}/65535 amount ${applied}`);
  return { success: true, events, pullResolved: { pullId, fillRatio: ratio } };
}
