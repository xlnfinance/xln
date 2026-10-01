// The amounts the contracts read: a sign and a magnitude for one movement, two words for a running total.
import { A, arrayOf, type Abi } from "../kernel/encoding/abi.ts";

/** Types.sol `SignedAmount{bool negative; uint256 magnitude}`: zero is never negative. */
export const signedAmountAbi = (n: bigint): Abi => A.tuple([A.bool(n < 0n), A.u256(n < 0n ? -n : n)]);

/** Types.sol `Int512{int256 high; uint256 low}`: a value outside int512 fails the int256 word. */
export const int512Abi = (n: bigint): Abi => A.tuple([A.i256(n >> 256n), A.u256(n & ((1n << 256n) - 1n))]);

/** Types.sol `SettlementDiff`: what a cooperative update changes for one token, each change signed. */
export type SettlementDiff = Readonly<{
  tokenId: bigint; leftDiff: bigint; rightDiff: bigint; collateralDiff: bigint; ondeltaDiff: bigint;
}>;

const settlementDiffAbi = (d: SettlementDiff): Abi => A.tuple([
  A.u256(d.tokenId), signedAmountAbi(d.leftDiff), signedAmountAbi(d.rightDiff),
  signedAmountAbi(d.collateralDiff), signedAmountAbi(d.ondeltaDiff),
]);

export const settlementDiffsAbi = (diffs: readonly SettlementDiff[]): Abi => arrayOf(diffs, settlementDiffAbi);
