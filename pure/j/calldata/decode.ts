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
//
// The Depository authorizes a batch by its Hanko, not by who sends it (Depository.sol 340-348), so the call is not
// always the top of the transaction: a relay contract, a multicall or an `execute(target, data)` carries it inside its
// own arguments. Every place in an input that begins with the `processBatch` selector is read as a call, whatever
// wraps it; what a call must prove is the same wherever it was found (an evidence hash or a body hash the log names),
// so a stray match changes nothing.
import { proofBodyHash, type Allowance, type ProofBody, type TransformerClause } from "../../chain/proof/proof.ts";
import {
  abiBytes, abiFits, abiLengthRef, abiLengthWord, abiRoot, abiStaticBytes, abiStaticWord, abiTupleBytes,
  abiTupleElement, abiTupleRef, abiWord, type AbiLength, type AbiTuple,
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
const BATCH_STARTS = 5;
const START_BODY_HASH = 4;
const START_BODY = 5;
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

/**
 * Every `processBatch` call in an input, as the bytes from its selector on: the input itself when it is one, and each
 * one a wrapper carries in its arguments, at any offset (an ABI wrapper places it on a word, a packed one does not).
 */
const callsIn = (input: Uint8Array): readonly Uint8Array[] =>
  Array.from({ length: Math.max(0, input.length - PROCESS_BATCH.length + 1) }, (_, at) => input.subarray(at))
    .filter((from) => startsWith(from, PROCESS_BATCH));

const finalizesOf = (input: Uint8Array): readonly Finalize[] => {
  const call = input.subarray(PROCESS_BATCH.length);
  const batch = abiBytes(call, abiLengthRef(call, abiRoot(), WORD));
  const list = abiLengthRef(batch, abiTupleRef(batch, abiRoot(), 0), BATCH_FINALIZATIONS * WORD);
  const count = abiLengthWord(batch, list);
  return abiFits(batch, list, count, WORD)
    ? Array.from({ length: Number(count) }, (_, i) => finalizeOf(batch, abiTupleElement(batch, list, i)))
    : [];
};

/** The finalize ops of every `processBatch` call in an input, or none when it holds none. */
export const finalizesIn = (input: Uint8Array): readonly Finalize[] => callsIn(input).flatMap(finalizesOf);

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

/** `abi.encode`d words are 32 bytes; an `Int512 {int256 high; uint256 low}` is two of them, an `Allowance` three. */
const INT512 = 2 * WORD;
const ALLOWANCE = 3 * WORD;
const WORD_BITS = 256n;

type Listed = readonly [AbiLength, number] | undefined;

const listOf = (buf: Uint8Array, owner: AbiTuple, slot: number, stride: number): Listed => {
  const list = abiLengthRef(buf, owner, slot * WORD);
  const count = abiLengthWord(buf, list);
  return abiFits(buf, list, count, stride) ? [list, Number(count)] : undefined;
};

const allowancesIn = (buf: Uint8Array, clause: AbiTuple): readonly Allowance[] => {
  const found = listOf(buf, clause, 2, ALLOWANCE);
  if (found === undefined) return [];
  const [list, count] = found;
  const at = (i: number, k: number): bigint => abiStaticWord(buf, list, i * 3 + k);
  return Array.from({ length: count }, (_, i) =>
    ({ deltaIndex: at(i, 0), rightAllowance: at(i, 1), leftAllowance: at(i, 2) }));
};

const clauseIn = (buf: Uint8Array, clause: AbiTuple): TransformerClause => ({
  transformerAddress: bytesToHex(abiTupleBytes(buf, clause, 0).subarray(12)),
  encodedBatch: bytesToHex(abiBytes(buf, abiLengthRef(buf, clause, WORD))),
  allowances: allowancesIn(buf, clause),
});

/**
 * A `ProofBody` as `abi.encode` lays it out, read from its tuple. What the words say is believed only once the body is
 * hashed (`startedBody`): a body read from bytes that do not make it has another hash, and is no body of the dispute.
 */
const bodyIn = (buf: Uint8Array, body: AbiTuple): ProofBody => {
  const deltas = listOf(buf, body, 3, INT512);
  const tokens = listOf(buf, body, 4, WORD);
  const clauses = listOf(buf, body, 5, WORD);
  const [deltaList, deltaCount] = deltas ?? [undefined, 0];
  const [tokenList, tokenCount] = tokens ?? [undefined, 0];
  const [clauseList, clauseCount] = clauses ?? [undefined, 0];
  return {
    watchSeed: bytesToHex(abiTupleBytes(buf, body, 0)),
    leftResponseSeconds: abiWord(buf, body, WORD), rightResponseSeconds: abiWord(buf, body, 2 * WORD),
    offdeltas: deltaList === undefined ? [] : Array.from({ length: deltaCount }, (_, i) =>
      (BigInt.asIntN(Number(WORD_BITS), abiStaticWord(buf, deltaList, 2 * i)) << WORD_BITS)
      | abiStaticWord(buf, deltaList, 2 * i + 1)),
    tokenIds: tokenList === undefined
      ? []
      : Array.from({ length: tokenCount }, (_, i) => abiStaticWord(buf, tokenList, i)),
    transformers: clauseList === undefined ? [] : Array.from({ length: clauseCount }, (_, i) =>
      clauseIn(buf, abiTupleElement(buf, clauseList, i))),
  };
};

/**
 * The proof body a dispute start carried, from the input of its transaction: the body of the start op whose
 * `proofbodyHash` is the one the chain logged, and that hashes to it (the contract reveals the exact signed body at
 * start, Types.sol `InitialDisputeProof.initialProofbody`). `undefined` when the input holds no `processBatch` call or
 * no op of one names the hash with a body that makes it. The Entity may finalize with such a body without having held
 * the state, because the hash is what the chain compares.
 */
export const startedBody = (input: Uint8Array, bodyHash: Bytes32): ProofBody | undefined =>
  callsIn(input).flatMap((call) => startedBodyOf(call, bodyHash)).at(0);

const startedBodyOf = (input: Uint8Array, bodyHash: Bytes32): readonly ProofBody[] => {
  const call = input.subarray(PROCESS_BATCH.length);
  const batch = abiBytes(call, abiLengthRef(call, abiRoot(), WORD));
  const list = abiLengthRef(batch, abiTupleRef(batch, abiRoot(), 0), BATCH_STARTS * WORD);
  const count = abiLengthWord(batch, list);
  if (!abiFits(batch, list, count, WORD)) return [];
  const ops = Array.from({ length: Number(count) }, (_, i) => abiTupleElement(batch, list, i));
  const named = ops.filter((op) => bytesToHex(abiTupleBytes(batch, op, START_BODY_HASH * WORD)) === bodyHash);
  const bodies = named.map((op) => bodyIn(batch, abiTupleRef(batch, op, START_BODY * WORD)));
  return bodies.filter((body) => {
    const hash = proofBodyHash(body);
    return hash.ok && hash.value === bodyHash;
  });
};
