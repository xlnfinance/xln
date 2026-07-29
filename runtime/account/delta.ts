import type { Delta } from '../types';

type InitialCreditLimits = Readonly<{
  left?: bigint;
  right?: bigint;
}>;

/**
 * The only constructor for a new token row in Account state.
 *
 * Every financial field is explicit in the resulting object. Callers may
 * provide committed credit policy, but absence always means zero credit—not a
 * product default inferred from UI, token metadata, or ambient Runtime state.
 */
export const createDefaultDelta = (
  tokenId: number,
  credit: InitialCreditLimits = {},
): Delta => ({
  tokenId,
  collateral: 0n,
  ondelta: 0n,
  offdelta: 0n,
  leftCreditLimit: credit.left ?? 0n,
  rightCreditLimit: credit.right ?? 0n,
  leftAllowance: 0n,
  rightAllowance: 0n,
  leftHold: 0n,
  rightHold: 0n,
});
