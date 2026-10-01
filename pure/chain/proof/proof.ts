// The proof body: the state two parties sign and a dispute settles from.
//
// Its hash is what a dispute start, a counter-dispute and a finalization compare (Types.sol `ProofBody`).
import { A, arrayOf, encode, type Abi, type AbiFault } from "../../kernel/encoding/abi.ts";
import { keccakHex } from "../../kernel/encoding/bytes.ts";
import { map, type Result } from "../../kernel/core/result.ts";
import { int512Abi } from "../money.ts";

/** How much of a delta a clause may move in each direction, by the index of the delta in the body. */
export type Allowance = Readonly<{ deltaIndex: bigint; rightAllowance: bigint; leftAllowance: bigint }>;

/** A transformer's payload and what it may touch: the conditional part of the state (payments, swaps, pulls). */
export type TransformerClause = Readonly<{
  transformerAddress: string; encodedBatch: string; allowances: readonly Allowance[];
}>;

export type ProofBody = Readonly<{
  watchSeed: string;
  leftResponseSeconds: bigint;
  rightResponseSeconds: bigint;
  offdeltas: readonly bigint[];
  tokenIds: readonly bigint[];
  transformers: readonly TransformerClause[];
}>;

const allowanceAbi = (a: Allowance): Abi =>
  A.tuple([A.u256(a.deltaIndex), A.u256(a.rightAllowance), A.u256(a.leftAllowance)]);

const transformerClauseAbi = (c: TransformerClause): Abi =>
  A.tuple([A.address(c.transformerAddress), A.bytes(c.encodedBatch), arrayOf(c.allowances, allowanceAbi)]);

export const proofBodyAbi = (b: ProofBody): Abi => A.tuple([
  A.b32(b.watchSeed), A.u32(b.leftResponseSeconds), A.u32(b.rightResponseSeconds),
  arrayOf(b.offdeltas, int512Abi), arrayOf(b.tokenIds, A.u256), arrayOf(b.transformers, transformerClauseAbi),
]);

/** `abi.encode(ProofBody)`. */
export const proofBodyBytes = (b: ProofBody): Result<Uint8Array, AbiFault> => encode([proofBodyAbi(b)]);

/** `keccak256(abi.encode(ProofBody))`: the hash the Depository stores for a dispute's proof. */
export const proofBodyHash = (b: ProofBody): Result<string, AbiFault> => map(proofBodyBytes(b), keccakHex);
