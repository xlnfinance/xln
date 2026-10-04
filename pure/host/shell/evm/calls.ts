// The Depository as the node sees it: the calldata of the four reads and the one write the Host makes, the topics of
// the events it looks for, and numbers out of the node's hex words. The bytes of a batch are the chain layer's; this
// only wraps them in the contract's function signature.
import { A, encode } from "../../../kernel/encoding/abi.ts";
import { bytesToHex, concat, keccak256, utf8 } from "../../../kernel/encoding/bytes.ts";
import { err, flatMap, map, ok, type Result } from "../../../kernel/core/result.ts";
import type { Tagged } from "../../../kernel/core/tagged.ts";
import type { ProcessBatchCall } from "../../../j/batch/sealed.ts";
import { topicOf } from "../../../j/log.ts";

/** What the node said, or what the caller built, is not what the contract's ABI says it should be. */
export type ReplyFault = Tagged<"bad_reply", { why: string }>;

export const bad = (why: string): ReplyFault => ({ _tag: "bad_reply", why });

const HEX_WORD = 64;

/** The first four bytes of the hash of a function signature. */
const selector = (signature: string): Uint8Array => keccak256(utf8(signature)).slice(0, 4);

export const HANKO_PROCESSED = topicOf("HankoBatchProcessed(bytes32,bytes32,uint256)");
export const BATCH_FAILED = topicOf("BatchFailed(bytes32,uint256,bytes4)");
export const DISPUTE_SKIPPED = topicOf("DisputeOpSkipped(bytes32,bytes32,uint8,uint8,uint256)");

/**
 * The Depository's own errors by selector (`E0` to `E12`, Types.sol and Depository.sol), so a revert is named as the
 * contract names it. One this table does not know is named by its four bytes: it is never taken for a known one.
 */
const ERROR_NAMES: ReadonlyMap<string, string> =
  new Map(Array.from({ length: 13 }, (_, n): [string, string] => [bytesToHex(selector(`E${n}()`)), `E${n}`]));

export const errorNamed = (selected: string): string =>
  ERROR_NAMES.get(selected.toLowerCase()) ?? selected.toLowerCase();

export const withArguments = (signature: string, values: Parameters<typeof encode>[0]): Result<string, ReplyFault> => {
  const encoded = encode(values);
  return encoded.ok ? ok(bytesToHex(concat([selector(signature), encoded.value]))) : err(bad(encoded.error._tag));
};

export const entityNoncesCall = (entity: string): Result<string, ReplyFault> =>
  withArguments("entityNonces(bytes32)", [A.b32(entity)]);

export const reservesCall = (entity: string, token: bigint): Result<string, ReplyFault> =>
  withArguments("_reserves(bytes32,uint256)", [A.b32(entity), A.u256(token)]);

export const debtOutstandingCall = (entity: string, token: bigint): Result<string, ReplyFault> =>
  withArguments("debtOutstanding(bytes32,uint256)", [A.b32(entity), A.u256(token)]);

export const processBatchData = (call: ProcessBatchCall): Result<string, ReplyFault> =>
  withArguments("processBatch(bytes32,bytes,bytes,uint256)", [
    A.b32(call.entityId), A.bytes(call.encodedBatch), A.bytes(call.hankoData), A.u256(call.nonce),
  ]);

/** A topic that holds a number: 32 bytes, big endian. */
export const topicNumber = (n: bigint): string => `0x${n.toString(16).padStart(HEX_WORD, "0")}`;

/** `0x` and whole 32-byte words of hex, as the node returns the result of a call. */
export const wordsOf = (hex: unknown): Result<readonly bigint[], ReplyFault> => {
  if (typeof hex !== "string" || !/^0x(?:[0-9a-fA-F]{64})*$/.test(hex)) return err(bad("not whole words of hex"));
  const words = (hex.length - 2) / HEX_WORD;
  const word = (i: number): bigint => BigInt(`0x${hex.slice(2 + i * HEX_WORD, 2 + (i + 1) * HEX_WORD)}`);
  return ok(Array.from({ length: words }, (_, i) => word(i)));
};

export const oneWord = (hex: unknown): Result<bigint, ReplyFault> =>
  flatMap(wordsOf(hex), (words) =>
    (words.length === 1 ? ok(words[0] ?? 0n) : err(bad(`${words.length} words, not 1`))));

/** The three limbs of a Uint768 (high, middle, low) as one number. */
export const wide = (hex: unknown): Result<bigint, ReplyFault> =>
  flatMap(wordsOf(hex), (words) => {
    const [high, middle, low] = words;
    return words.length === 3 && high !== undefined && middle !== undefined && low !== undefined
      ? ok((high << 512n) | (middle << 256n) | low)
      : err(bad(`${words.length} words, not 3`));
  });

/** A quantity as the node writes it: `0x` and hex digits, no leading zeros. */
export const quantity = (value: unknown): Result<bigint, ReplyFault> =>
  (typeof value === "string" && /^0x[0-9a-fA-F]+$/.test(value) ? ok(BigInt(value)) : err(bad("not a quantity")));

export const hexQuantity = (n: bigint): string => `0x${n.toString(16)}`;

/** The four bytes at the start of a data word: a `bytes4` is left aligned. */
export const fourBytes = (hex: unknown): Result<string, ReplyFault> =>
  map(
    typeof hex === "string" && /^0x[0-9a-fA-F]{64}$/.test(hex) ? ok(hex.slice(0, 10)) : err(bad("not one word")),
    (selected) => selected.toLowerCase(),
  );
