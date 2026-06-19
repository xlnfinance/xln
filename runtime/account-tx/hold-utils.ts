import type { Delta } from '../types';

export type HoldSide = 'left' | 'right';

export function getHold(delta: Delta, side: HoldSide): bigint {
  return side === 'left' ? (delta.leftHold ?? 0n) : (delta.rightHold ?? 0n);
}

export function ensureHoldAdd(side: HoldSide, amount: bigint): string | undefined {
  if (amount < 0n) return `HOLD_ADD_NEGATIVE:${side} amount=${amount.toString()}`;
  return undefined;
}

export function addHold(delta: Delta, side: HoldSide, amount: bigint): string | undefined {
  const error = ensureHoldAdd(side, amount);
  if (error) return error;
  if (side === 'left') delta.leftHold = (delta.leftHold ?? 0n) + amount;
  else delta.rightHold = (delta.rightHold ?? 0n) + amount;
  return undefined;
}

export function ensureHoldRelease(
  delta: Delta,
  side: HoldSide,
  amount: bigint,
  formatUnderflow: (currentHold: bigint, releaseAmount: bigint) => string,
): string | undefined {
  if (amount < 0n) return `HOLD_RELEASE_NEGATIVE:${side} amount=${amount.toString()}`;
  const currentHold = getHold(delta, side);
  if (currentHold < amount) return formatUnderflow(currentHold, amount);
  return undefined;
}

export function releaseHold(
  delta: Delta,
  side: HoldSide,
  amount: bigint,
  formatUnderflow: (currentHold: bigint, releaseAmount: bigint) => string,
): string | undefined {
  const error = ensureHoldRelease(delta, side, amount, formatUnderflow);
  if (error) return error;
  const nextHold = getHold(delta, side) - amount;
  if (side === 'left') delta.leftHold = nextHold;
  else delta.rightHold = nextHold;
  return undefined;
}
