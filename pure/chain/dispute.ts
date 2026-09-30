// What the Depository stores and emits about a dispute, so an off-chain reader can recompute it (Account.sol).
//
// The stored dispute is one hash over packed fields; the starter's arguments are committed, never stored. The same
// functions let a watcher check that the record it read back is the dispute it expected.
import { A, encode, encodePacked, P, type AbiFault, type Packed } from "../kernel/abi.ts";
import { hexToBytes, keccakHex } from "../kernel/bytes.ts";
import { all, flatMap, map, type Result } from "../kernel/result.ts";

/** A signed branch of the Account's history: who authored it, at which nonce, with which body. */
export type Branch = Readonly<{ nonce: bigint; proposerIsLeft: boolean; proofBodyHash: string }>;

/** What a starter commits to for the one newer branch it arms at start: H(nonce, proposerIsLeft, proofBodyHash). */
export const counterProofCommitment = (b: Branch): Result<string, AbiFault> =>
  map(encode([A.u256(b.nonce), A.bool(b.proposerIsLeft), A.b32(b.proofBodyHash)]), keccakHex);

/** Starter arguments are committed with the side that started and the start time, so a blob cannot be replayed. */
export type StarterArguments = Readonly<{ args: string; startedByLeft: boolean; startTimestamp: bigint }>;

export const argumentsCommitment = (a: StarterArguments): Result<string, AbiFault> =>
  map(encode([A.bytes(a.args), A.bool(a.startedByLeft), A.u256(a.startTimestamp)]), keccakHex);

/** The fields of an active dispute, as the Account stores them after a start (Account.encodeDisputeHash). */
export type DisputeRecord = Readonly<{
  nonce: bigint;
  startedByLeft: boolean;
  initialProposerIsLeft: boolean;
  timeout: bigint;
  leftResponseSeconds: bigint;
  rightResponseSeconds: bigint;
  proofBodyHash: string;
  startTimestamp: bigint;
  starterInitialArguments: string;
  starterCounterArguments: string;
  starterCounterProofCommitment: string;
}>;

const ZERO_WORD = `0x${"00".repeat(32)}`;
const UNSET_FLAG: Packed = { _tag: "bool", value: false };

/** The stored dispute hash. The trailing fields are the counter-dispute slots, still empty at start. */
export const disputeRecordHash = (r: DisputeRecord): Result<string, AbiFault> => {
  const commitments = all({
    initial: argumentsCommitment({ args: r.starterInitialArguments, ...r }),
    counter: argumentsCommitment({ args: r.starterCounterArguments, ...r }),
  });
  return flatMap(commitments, ({ initial, counter }) => map(encodePacked([
    P.u256(r.nonce), P.bool(r.startedByLeft), P.bool(r.initialProposerIsLeft), P.u256(r.timeout),
    P.u32(r.leftResponseSeconds), P.u32(r.rightResponseSeconds), P.b32(r.proofBodyHash), P.u256(r.startTimestamp),
    P.b32(initial), P.b32(counter), P.b32(r.starterCounterProofCommitment),
    P.u256(0n), P.b32(ZERO_WORD), UNSET_FLAG,
  ]), keccakHex));
};

/** What a finalization reveals: the evidence `DisputeFinalized.finalizationEvidenceHash` commits to. */
export type FinalizationEvidence = Readonly<{
  initialProofBodyHash: string;
  finalNonce: bigint;
  proposerIsLeft: boolean;
  startedByLeft: boolean;
  starterArguments: string;
  otherArguments: string;
  sig: string;
}>;

const hashOfHex = (hex: string): Result<string, AbiFault> => map(hexToBytes(hex), keccakHex);

export const finalizationEvidenceHash = (e: FinalizationEvidence): Result<string, AbiFault> => {
  const hashes = all({
    starter: hashOfHex(e.starterArguments), other: hashOfHex(e.otherArguments), sig: hashOfHex(e.sig),
  });
  return flatMap(hashes, ({ starter, other, sig }) => map(encode([
    A.b32(e.initialProofBodyHash), A.u256(e.finalNonce), A.bool(e.proposerIsLeft), A.bool(e.startedByLeft),
    A.b32(starter), A.b32(other), A.b32(sig),
  ]), keccakHex));
};
