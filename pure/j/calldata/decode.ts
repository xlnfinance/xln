// What the J layer reads of the bytes a transaction carried (R-WATCH-CALLDATA). Two events leave evidence in no log:
// `DisputeStarted` logs the starter's two argument blobs as bytes, and `DisputeFinalized` logs only a hash of what the
// finalize carried (`finalizationEvidenceHash`), the arguments themselves being in the input of the transaction. A
// secret shown in dispute arguments pays its clause on the chain (DeltaTransformer `applyPayment`) with no
// `SecretRevealed`, so a hub that forwarded the lock learns it here or not at all.
//
// The input is read as the contract reads it, with the ABI cursors, and nothing in it is believed until it is checked:
// a finalize op of the input is the one the log is about only if its evidence hash is the one the log carries.
// An argument blob is `abi.encode(bytes[])`, one `abi.encode(Arguments)` per clause of the proof body
// (DeltaTransformer.decodeTransformerArgumentListStrict, Account.sol `_decodeTransformerArgumentList`), and the
// encoding is pinned to the contract's own test encoder in decode.test.ts and to the deployed DeltaTransformer on the
// fork (testnet-e2e S10). Arguments the contract could not decode it treats as empty; here a secret is read wherever
// the words say one is, which can only hand a hub a preimage it would be handed anyway.
//
// The Depository authorizes a batch by its Hanko, not by who sends it (Depository.sol 340-348), so the call is not
// always the top of the transaction: a relay contract, a multicall or an `execute(target, data)` carries it inside its
// own arguments. A transaction to the Depository is that one call, read exactly by its ABI layout (bytes after the
// call's own components are ignored, so nothing appended can hide it). A transaction to another contract is scanned at
// every offset for a `processBatch` or tower selector, within a budget; what a call must prove is the same wherever it
// was found (an evidence hash or a body hash the log names), so a stray match changes nothing.
//
// A transaction is read once and in bounded work, whatever its bytes say: ABI offsets may alias one op or one list many
// times, so every count is held to what the contract itself accepts (DepositoryBounds, Account.sol limits), and an
// input past them is one the Depository would revert, never one to read (it is `undefined`, and told as unread).
import { proofBodyHash, type Allowance, type ProofBody, type TransformerClause } from "../../chain/proof/proof.ts";
import {
  abiBytes, abiBytesElement, abiFits, abiLengthRef, abiLengthWord, abiRoot, abiStaticBytes, abiStaticWord,
  abiTupleBytes, abiTupleElement, abiTupleRef, abiWord, type AbiLength, type AbiTuple,
} from "../../kernel/encoding/abi-read.ts";
import { bytesToHex, concat, hexToBytes, keccak256, keccakHex, utf8 } from "../../kernel/encoding/bytes.ts";
import type { Bytes32 } from "../log.ts";

const WORD = 32;

/** What the contract accepts, which a landed batch is within: DepositoryBounds, Account.sol 361-364. */
const MOST_FINALIZATIONS = 1;
const MOST_STARTS = 8;
const MOST_ARGUMENT_BYTES = 64 * 1024;
const MOST_CLAUSES = 32;
const MOST_TOKENS = 128;
const MOST_BODY_BYTES = 176 * 1024;
/**
 * The most bytes of an encoded batch, and of the call data of a tower's counter-dispute (Depository.sol 354, 475): more
 * is one the Depository reverts. What follows the ABI's own components in an input is no concern of the contract's, and
 * is never a reason not to read the call: a call padded with zeros is read as the contract reads it.
 */
const MOST_BATCH_BYTES = 256 * 1024;
/** The scan of a wrapper's input is bounded (its step budget, one step an offset): a longer input is not scanned. */
const MOST_SCAN_BYTES = 1024 * 1024;

/** `processBatch(bytes32,bytes,bytes,uint256)`: the call that carries a dispute op in a batch. */
const PROCESS_BATCH = keccak256(utf8("processBatch(bytes32,bytes,bytes,uint256)")).subarray(0, 4);

/**
 * `watchtowerCounterDispute(bytes32,FinalDisputeProof,uint256,uint256,bytes)` (Depository.sol 468-505): the other call
 * that finalizes. At and after the last-resort window it finalizes the dispute with the tower's `params`, whose
 * signature the contract blanks first, so its evidence hash is over an empty signature.
 */
const TOWER_COUNTER = keccak256(utf8(
  "watchtowerCounterDispute(bytes32,(bytes32,uint256,uint256,bool,bytes32,(bytes32,uint32,uint32,(int256,uint256)[],"
  + "uint256[],(address,bytes,(uint256,uint256,uint256)[])[]),bytes,bytes,bytes,bool,bool),uint256,uint256,bytes)",
)).subarray(0, 4);
const TOWER_PARAMS = 1;
const NO_SIGNATURE = new Uint8Array();

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

const unique = (secrets: readonly Bytes32[]): readonly Bytes32[] => [...new Set(secrets)];

/**
 * The secrets of an `Arguments {uint16[] fillRatios; bytes32[] secrets}` element, `abi.encode`d: one dynamic tuple
 * behind an offset word, its second member the secrets. An element that is not that has none.
 */
const secretsOfArguments = (element: Uint8Array): readonly Bytes32[] => {
  const tuple = abiTupleRef(element, abiRoot(), 0);
  const list = abiLengthRef(element, tuple, WORD);
  const count = abiLengthWord(element, list);
  return abiFits(element, list, count, WORD)
    ? Array.from({ length: Number(count) }, (_, i) => asBytes32(abiStaticBytes(element, list, i)))
    : [];
};

/**
 * The secrets of an argument blob: `abi.encode(bytes[])`, one `abi.encode(Arguments)` per clause. A blob that is not
 * that, or is longer than the contract accepts, has none; a list longer than the most clauses a body may have is read
 * to that many (what the contract applies are the first of them).
 */
export const secretsIn = (blob: Uint8Array): readonly Bytes32[] => {
  if (blob.length > MOST_ARGUMENT_BYTES) return [];
  const list = abiLengthRef(blob, abiRoot(), 0);
  const count = abiLengthWord(blob, list);
  if (!abiFits(blob, list, count, WORD)) return [];
  const read = Math.min(Number(count), MOST_CLAUSES);
  return unique(Array.from({ length: read }, (_, i) =>
    secretsOfArguments(abiBytes(blob, abiBytesElement(blob, list, i)))).flat());
};

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

/**
 * `finalizationEvidenceHash`: `abi.encode` of the initial body hash, the final nonce, both sides and three hashes, the
 * last of the signature the contract finalized with (`sig`).
 */
const finalizeOf = (batch: Uint8Array, op: AbiTuple, sig: Uint8Array): Finalize | undefined => {
  const starterArguments = bytesOf(batch, op, FINAL_STARTER_ARGUMENTS);
  const otherArguments = bytesOf(batch, op, FINAL_OTHER_ARGUMENTS);
  if (starterArguments.length > MOST_ARGUMENT_BYTES || otherArguments.length > MOST_ARGUMENT_BYTES) return undefined;
  const evidence = keccakHex(concat([
    word(batch, op, FINAL_INITIAL_BODY), word(batch, op, FINAL_NONCE), word(batch, op, FINAL_PROPOSER),
    word(batch, op, FINAL_STARTED_BY_LEFT), keccak256(starterArguments), keccak256(otherArguments),
    keccak256(sig),
  ]));
  return { evidence: evidence as Bytes32, starterArguments, otherArguments };
};

/**
 * How a call reached the Depository: the transaction was to it (`direct`: its input is the call, read exactly as the
 * contract reads it, whatever follows), or a contract carried the call in its own input (`wrapper`: found by a scan).
 */
export type Route = "direct" | "wrapper";

/** The input of a transaction, or of one call of its trace, and how the call it holds reached the Depository. */
export type Carried = Readonly<{ data: Uint8Array; route: Route }>;

/** The calls of the Depository the watcher reads: a batch (`processBatch`) and a tower's counter-dispute. */
type Call = Readonly<{ kind: "batch" | "tower"; args: Uint8Array; route: Route }>;

/**
 * The most distinct ops of a wrapper's input that are read: no honest wrapper carries more, and each op is bounded
 * work. An input with more is not read (told as unread, loudly), so a flood of look-alike calls can neither make the
 * node decode without end nor hide the op the log names behind them silently. A direct call has no scan, so no flood.
 */
const MOST_OPS = 64;
const SELECTOR_BYTES = 4;

const startsWith = (input: Uint8Array, prefix: Uint8Array): boolean => prefix.every((b, i) => input[i] === b);

const callAt = (input: Uint8Array, at: number, route: Route): readonly Call[] => {
  const from = input.subarray(at);
  const args = from.subarray(SELECTOR_BYTES);
  if (startsWith(from, PROCESS_BATCH)) return [{ kind: "batch", args, route }];
  return startsWith(from, TOWER_COUNTER) ? [{ kind: "tower", args, route }] : [];
};

/**
 * Every call in an input, as its arguments after the selector. A transaction to the Depository is the one call its
 * input is, read from its first byte: look-alike calls behind it are arguments of that call, never other calls. A
 * transaction to another contract is scanned at every offset for the calls a wrapper carries in its own arguments (an
 * ABI wrapper places one on a word, a packed one does not), within the scan's budget: a longer input has none.
 */
const callsIn = ({ data, route }: Carried): readonly Call[] => {
  if (route === "direct") return callAt(data, 0, route);
  return data.length > MOST_SCAN_BYTES
    ? []
    : Array.from({ length: Math.max(0, data.length - SELECTOR_BYTES + 1) }, (_, at) => callAt(data, at, route)).flat();
};

/** A finalize or a start op in an input, and where it lies: one op is read once however many offsets reach it. */
type Placed<T> = Readonly<{ place: string; read: () => T }>;

const placed = <T>(kind: string, buf: Uint8Array, at: number, read: () => T): Placed<T> =>
  ({ place: `${kind}:${buf.byteOffset + at}`, read });

/** The ops without repeats, none at all when there are more than the most that are read. */
const distinct = <T>(ops: readonly Placed<T>[]): readonly Placed<T>[] => {
  const once = ops.filter((op, i) => ops.findIndex((other) => other.place === op.place) === i);
  return once.length > MOST_OPS ? [] : once;
};

/** The one finalize a batch of `processBatch` may carry, none when its list is longer than the contract accepts. */
const batchFinalizes = (args: Uint8Array): readonly Placed<Finalize | undefined>[] => {
  const batch = abiBytes(args, abiLengthRef(args, abiRoot(), WORD));
  if (batch.length > MOST_BATCH_BYTES) return [];
  const list = abiLengthRef(batch, abiTupleRef(batch, abiRoot(), 0), BATCH_FINALIZATIONS * WORD);
  const count = abiLengthWord(batch, list);
  return count <= BigInt(MOST_FINALIZATIONS) && abiFits(batch, list, count, WORD)
    ? Array.from({ length: Number(count) }, (_, i) => {
      const op = abiTupleElement(batch, list, i);
      return placed("batch", batch, op, () => finalizeOf(batch, op, bytesOf(batch, op, FINAL_SIG)));
    })
    : [];
};

/** The finalize a tower's call carries: the contract blanks `params.sig` before it finalizes. */
const towerFinalizes = (args: Uint8Array, route: Route): readonly Placed<Finalize | undefined>[] => {
  if (route === "direct" && args.length + SELECTOR_BYTES > MOST_BATCH_BYTES) return [];
  const params = abiTupleRef(args, abiRoot(), TOWER_PARAMS * WORD);
  return [placed("tower", args, params, () => finalizeOf(args, params, NO_SIGNATURE))];
};

/**
 * The finalize ops of every call in an input, each read once, none for an input with no call, none for a list past what
 * the contract accepts (it would revert) and none for an input with more distinct ops than `MOST_OPS`: a transaction
 * that carried a `DisputeFinalized` some other way is told as unread.
 */
export const finalizesIn = (carried: Carried): readonly Finalize[] =>
  distinct(callsIn(carried).flatMap((call) =>
    (call.kind === "batch" ? batchFinalizes(call.args) : towerFinalizes(call.args, call.route))))
    .flatMap((op) => op.read() ?? []);

/**
 * The secrets a finalize showed, from the input of the transaction that carried it: the ops whose evidence hash is
 * the logged one, and none (`undefined`) when no op of the input is. Ops with one hash carry the same blobs.
 */
export const finalizedSecrets = (carried: Carried, evidence: Bytes32): readonly Bytes32[] | undefined => {
  const mine = finalizesIn(carried).filter((f) => f.evidence === evidence);
  return mine.length === 0
    ? undefined
    : unique(mine.flatMap((f) => [...secretsIn(f.starterArguments), ...secretsIn(f.otherArguments)]));
};

/** `abi.encode`d words are 32 bytes; an `Int512 {int256 high; uint256 low}` is two of them, an `Allowance` three. */
const INT512 = 2 * WORD;
const ALLOWANCE = 3 * WORD;
const WORD_BITS = 256n;

type Listed = readonly [AbiLength, number] | undefined;

/** A list of `stride`-byte items that fits the buffer and has at most `most` of them; none (`undefined`) otherwise. */
const listOf = (buf: Uint8Array, owner: AbiTuple, slot: number, stride: number, most: number): Listed => {
  const list = abiLengthRef(buf, owner, slot * WORD);
  const count = abiLengthWord(buf, list);
  return count <= BigInt(most) && abiFits(buf, list, count, stride) ? [list, Number(count)] : undefined;
};

const allowancesIn = (buf: Uint8Array, clause: AbiTuple): readonly Allowance[] | undefined => {
  const found = listOf(buf, clause, 2, ALLOWANCE, MOST_TOKENS);
  if (found === undefined) return undefined;
  const [list, count] = found;
  const at = (i: number, k: number): bigint => abiStaticWord(buf, list, i * 3 + k);
  return Array.from({ length: count }, (_, i) =>
    ({ deltaIndex: at(i, 0), rightAllowance: at(i, 1), leftAllowance: at(i, 2) }));
};

/** A clause whose allowances are within bounds. */
const clauseIn = (buf: Uint8Array, clause: AbiTuple): TransformerClause | undefined => {
  const allowances = allowancesIn(buf, clause);
  return allowances === undefined ? undefined : {
    transformerAddress: bytesToHex(abiTupleBytes(buf, clause, 0).subarray(12)),
    encodedBatch: bytesToHex(abiBytes(buf, abiLengthRef(buf, clause, WORD))), allowances,
  };
};

const batchBytesOf = (buf: Uint8Array, clause: AbiTuple): number =>
  abiBytes(buf, abiLengthRef(buf, clause, WORD)).length;

/**
 * A `ProofBody` as `abi.encode` lays it out, read from its tuple, or `undefined` when a list is past what the contract
 * accepts (tokens, clauses, allowances, the bytes of the clauses together). What the words say is believed only once
 * the body is hashed (`startedBody`): a body read from bytes that do not make it has another hash, and is no body
 * of the dispute.
 */
const bodyIn = (buf: Uint8Array, body: AbiTuple): ProofBody | undefined => {
  const deltas = listOf(buf, body, 3, INT512, MOST_TOKENS);
  const tokens = listOf(buf, body, 4, WORD, MOST_TOKENS);
  const clauses = listOf(buf, body, 5, WORD, MOST_CLAUSES);
  if (deltas === undefined || tokens === undefined || clauses === undefined) return undefined;
  const [deltaList, deltaCount] = deltas;
  const [tokenList, tokenCount] = tokens;
  const [clauseList, clauseCount] = clauses;
  const cursors = Array.from({ length: clauseCount }, (_, i) => abiTupleElement(buf, clauseList, i));
  if (cursors.reduce((sum, clause) => sum + batchBytesOf(buf, clause), 0) > MOST_BODY_BYTES) return undefined;
  const transformers = cursors.map((clause) => clauseIn(buf, clause));
  return transformers.some((clause) => clause === undefined) ? undefined : {
    watchSeed: bytesToHex(abiTupleBytes(buf, body, 0)),
    leftResponseSeconds: abiWord(buf, body, WORD), rightResponseSeconds: abiWord(buf, body, 2 * WORD),
    offdeltas: Array.from({ length: deltaCount }, (_, i) =>
      (BigInt.asIntN(Number(WORD_BITS), abiStaticWord(buf, deltaList, 2 * i)) << WORD_BITS)
      | abiStaticWord(buf, deltaList, 2 * i + 1)),
    tokenIds: Array.from({ length: tokenCount }, (_, i) => abiStaticWord(buf, tokenList, i)),
    transformers: transformers.flatMap((clause) => (clause === undefined ? [] : [clause])),
  };
};

/**
 * The proof body a dispute start carried, from the input of its transaction: the body of the start op whose
 * `proofbodyHash` is the one the chain logged, and that hashes to it (the contract reveals the exact signed body at
 * start, Types.sol `InitialDisputeProof.initialProofbody`). `undefined` when the input is not a `processBatch` call or
 * no op of it names the hash with a body that makes it. The Entity may finalize with such a body without having held
 * the state, because the hash is what the chain compares.
 */
export const startedBody = (carried: Carried, bodyHash: Bytes32): ProofBody | undefined => {
  const starts = distinct(callsIn(carried).flatMap((call) =>
    (call.kind === "batch" ? startsOf(call.args, bodyHash) : [])));
  return starts.flatMap((start) => start.read() ?? []).find((body) => {
    const hash = proofBodyHash(body);
    return hash.ok && hash.value === bodyHash;
  });
};

/** The start ops of a batch that name `bodyHash`, each to be read as a body when asked. */
const startsOf = (args: Uint8Array, bodyHash: Bytes32): readonly Placed<ProofBody | undefined>[] => {
  const batch = abiBytes(args, abiLengthRef(args, abiRoot(), WORD));
  if (batch.length > MOST_BATCH_BYTES) return [];
  const list = abiLengthRef(batch, abiTupleRef(batch, abiRoot(), 0), BATCH_STARTS * WORD);
  const count = abiLengthWord(batch, list);
  if (count > BigInt(MOST_STARTS) || !abiFits(batch, list, count, WORD)) return [];
  const ops = Array.from({ length: Number(count) }, (_, i) => abiTupleElement(batch, list, i));
  return ops.filter((op) => bytesToHex(abiTupleBytes(batch, op, START_BODY_HASH * WORD)) === bodyHash)
    .map((op) => placed("start", batch, op, () => bodyIn(batch, abiTupleRef(batch, op, START_BODY * WORD))));
};
