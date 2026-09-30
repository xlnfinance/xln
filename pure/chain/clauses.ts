// The transformer's payload: the conditional movements a proof body carries (DeltaTransformer.sol `Batch`).
//
// A payment moves an amount while its hash-lock is open, a swap exchanges two amounts, a pull moves an amount by the
// ratio a hash ladder reveals. The payload is `abi.encode(Batch)`, which a proof body's clause carries as bytes.
import { A, arrayOf, encode, type Abi, type AbiFault } from "../kernel/abi.ts";
import { map, type Result } from "../kernel/result.ts";
import { bytesToHex } from "../kernel/bytes.ts";
import { signedAmountAbi } from "./money.ts";

export type Payment = Readonly<{ deltaIndex: bigint; amount: bigint; revealedUntilTimestamp: bigint; hash: string }>;
export type Swap = Readonly<{
  ownerIsLeft: boolean; addDeltaIndex: bigint; addAmount: bigint; subDeltaIndex: bigint; subAmount: bigint;
}>;
export type Pull = Readonly<{
  deltaIndex: bigint; amount: bigint; claimedRatio: bigint; fullHash: string; partialRoot: string; targetRole: boolean;
}>;
export type DeltaBatch = Readonly<{ payments: readonly Payment[]; swaps: readonly Swap[]; pulls: readonly Pull[] }>;

const paymentAbi = (p: Payment): Abi =>
  A.tuple([A.u256(p.deltaIndex), signedAmountAbi(p.amount), A.u256(p.revealedUntilTimestamp), A.b32(p.hash)]);

const swapAbi = (s: Swap): Abi => A.tuple([
  A.bool(s.ownerIsLeft), A.u256(s.addDeltaIndex), A.u256(s.addAmount), A.u256(s.subDeltaIndex), A.u256(s.subAmount),
]);

const pullAbi = (p: Pull): Abi => A.tuple([
  A.u256(p.deltaIndex), signedAmountAbi(p.amount), A.u16(p.claimedRatio),
  A.b32(p.fullHash), A.b32(p.partialRoot), A.bool(p.targetRole),
]);

const deltaBatchAbi = (b: DeltaBatch): Abi =>
  A.tuple([arrayOf(b.payments, paymentAbi), arrayOf(b.swaps, swapAbi), arrayOf(b.pulls, pullAbi)]);

/** `DeltaTransformer.encodeBatch(batch)`, as the hex a clause carries. */
export const encodeDeltaBatch = (b: DeltaBatch): Result<string, AbiFault> =>
  map(encode([deltaBatchAbi(b)]), bytesToHex);
