// What the J layer reads of the bytes a transaction carried (R-WATCH-CALLDATA). Two events leave evidence in no log:
// `DisputeStarted` logs the starter's two argument blobs as bytes, and `DisputeFinalized` logs only a hash of what the
// finalize carried (`finalizationEvidenceHash`), the arguments themselves being in the input of the transaction. A
// secret shown in dispute arguments pays its clause on the chain (DeltaTransformer `applyPayment`) with no
// `SecretRevealed`, so a hub that forwarded the lock learns it here or not at all.
//
// The input is read as the contract reads it, with the ABI cursors, and nothing in it is believed until it is checked:
// a finalize op of the input is the one the log is about only if its evidence hash is the one the log carries.
// Arguments the contract could not decode it treats as empty; here a secret is read wherever the words say one is,
// which can only hand a hub a preimage it would be handed anyway.
import {
  abiBytes, abiFits, abiLengthRef, abiLengthWord, abiRoot, abiStaticBytes, abiTupleBytes, abiTupleElement,
  abiTupleRef, type AbiTuple,
} from "../../kernel/encoding/abi-read.ts";
import { bytesToHex, concat, hexToBytes, keccak256, keccakHex, utf8 } from "../../kernel/encoding/bytes.ts";
import type { Bytes32 } from "../log.ts";

const WORD = 32;

/** `processBatch(bytes32,bytes,bytes,uint256)`: the one call that carries a dispute op. */
const PROCESS_BATCH = keccak256(utf8("processBatch(bytes32,bytes,bytes,uint256)")).subarray(0, 4);

/** The slots of the types in Types.sol, counted in words from the head of the tuple. */
const BATCH_FINALIZATIONS = 7;
const FINAL_INITIAL_BODY = 4;
const FINAL_NONCE = 2;
const FINAL_PROPOSER = 3;
const FINAL_STARTER_ARGUMENTS = 6;
const FINAL_OTHER_ARGUMENTS = 7;
const FINAL_SIG = 8;
const FINAL_STARTED_BY_LEFT = 9;
const STARTED_INITIAL_ARGUMENTS = 3;
const STARTED_COUNTER_ARGUMENTS = 4;

const asBytes32 = (bytes: Uint8Array): Bytes32 => bytesToHex(bytes) as Bytes32;

/**
 * The secrets of an `Arguments {uint16[] fillRatios; bytes32[] secrets}` blob, `abi.encode`d: one dynamic tuple behind
 * an offset word, its second member the secrets. A blob that is not that has none.
 */
export const secretsIn = (blob: Uint8Array): readonly Bytes32[] => {
  const tuple = abiTupleRef(blob, abiRoot(), 0);
  const list = abiLengthRef(blob, tuple, WORD);
  const count = abiLengthWord(blob, list);
  return abiFits(blob, list, count, WORD)
    ? Array.from({ length: Number(count) }, (_, i) => asBytes32(abiStaticBytes(blob, list, i)))
    : [];
};

const unique = (secrets: readonly Bytes32[]): readonly Bytes32[] => [...new Set(secrets)];

/** The secrets in the two blobs `DisputeStarted` logs: the starter's initial arguments and its counter arguments. */
export const startedSecrets = (data: string): readonly Bytes32[] => {
  const bytes = hexToBytes(data);
  if (!bytes.ok) return [];
  const blob = (slot: number): Uint8Array => abiBytes(bytes.value, abiLengthRef(bytes.value, abiRoot(), slot * WORD));
  return unique([...secretsIn(blob(STARTED_INITIAL_ARGUMENTS)), ...secretsIn(blob(STARTED_COUNTER_ARGUMENTS))]);
};

/** A finalize op of a batch: the hash the chain logged for it, and the two argument blobs it carried. */
export type Finalize = Readonly<{ evidence: Bytes32; starterArguments: Uint8Array; otherArguments: Uint8Array }>;

const word = (batch: Uint8Array, op: AbiTuple, slot: number): Uint8Array => abiTupleBytes(batch, op, slot * WORD);

const bytesOf = (batch: Uint8Array, op: AbiTuple, slot: number): Uint8Array =>
  abiBytes(batch, abiLengthRef(batch, op, slot * WORD));

/** `finalizationEvidenceHash`: `abi.encode` of the initial body hash, the final nonce, both sides and three hashes. */
const finalizeOf = (batch: Uint8Array, op: AbiTuple): Finalize => {
  const starterArguments = bytesOf(batch, op, FINAL_STARTER_ARGUMENTS);
  const otherArguments = bytesOf(batch, op, FINAL_OTHER_ARGUMENTS);
  const evidence = keccakHex(concat([
    word(batch, op, FINAL_INITIAL_BODY), word(batch, op, FINAL_NONCE), word(batch, op, FINAL_PROPOSER),
    word(batch, op, FINAL_STARTED_BY_LEFT), keccak256(starterArguments), keccak256(otherArguments),
    keccak256(bytesOf(batch, op, FINAL_SIG)),
  ]));
  return { evidence: evidence as Bytes32, starterArguments, otherArguments };
};

const startsWith = (input: Uint8Array, prefix: Uint8Array): boolean => prefix.every((b, i) => input[i] === b);

/** The finalize ops of a `processBatch` call's input, or none when the input is some other call. */
export const finalizesIn = (input: Uint8Array): readonly Finalize[] => {
  if (!startsWith(input, PROCESS_BATCH)) return [];
  const call = input.subarray(PROCESS_BATCH.length);
  const batch = abiBytes(call, abiLengthRef(call, abiRoot(), WORD));
  const list = abiLengthRef(batch, abiTupleRef(batch, abiRoot(), 0), BATCH_FINALIZATIONS * WORD);
  const count = abiLengthWord(batch, list);
  return abiFits(batch, list, count, WORD)
    ? Array.from({ length: Number(count) }, (_, i) => finalizeOf(batch, abiTupleElement(batch, list, i)))
    : [];
};

/**
 * The secrets a finalize showed, from the input of the transaction that carried it: the ops whose evidence hash is
 * the logged one, and none (`undefined`) when no op of the input is. Ops with one hash carry the same blobs.
 */
export const finalizedSecrets = (input: Uint8Array, evidence: Bytes32): readonly Bytes32[] | undefined => {
  const mine = finalizesIn(input).filter((f) => f.evidence === evidence);
  return mine.length === 0
    ? undefined
    : unique(mine.flatMap((f) => [...secretsIn(f.starterArguments), ...secretsIn(f.otherArguments)]));
};
