// What the J layer reads of the Depository's logs (R-WATCH-CLOSED, R-J1). The chain tells an Account five things, and
// each has one event: its epoch moved (`AccountEpochAdvanced`), a dispute was started, a counter was registered, a
// dispute was finalized, its collateral and ondelta stand at some amounts (`AccountSettled`). A sixth names no Account:
// a secret was revealed (`SecretRevealed`), which every Entity hears. Every other event the
// Depository can emit is named below as read by nobody. A log from the Depository that is on neither list is a fault,
// so an event the contract adds is a decision here and never a silent miss; log.test.ts holds both lists against the
// deployed ABI.
//
// A log is a list of topics and a data string. What this layer reads rides the indexed topics, but for the epoch and
// for `AccountSettled`, whose entities and amounts are all in the data.
import { err, map, ok, traverse, type Result } from "../kernel/core/result.ts";
import { none, some, type Option } from "../kernel/core/option.ts";
import type { Brand, Tagged } from "../kernel/core/tagged.ts";
import type { TokenId } from "../account/model.ts";
import type { ProofBody } from "../chain/proof/proof.ts";
import { keccakHex, utf8 } from "../kernel/encoding/bytes.ts";
import { startedSecrets } from "./calldata/decode.ts";

/** `0x` and 64 lowercase hex digits: an entity id, a topic or a block hash. Their text order is their numeric order. */
export type Bytes32 = Brand<string, "Bytes32">;

/** `0x` and 40 lowercase hex digits. */
export type Address = Brand<string, "Address">;

export type BadHex = Tagged<"bad_hex", { text: string; bytes: number }>;

export const bytes32 = (text: string): Result<Bytes32, BadHex> =>
  (/^0x[0-9a-f]{64}$/.test(text) ? ok(text as Bytes32) : err({ _tag: "bad_hex", text, bytes: 32 }));

export const address = (text: string): Result<Address, BadHex> =>
  (/^0x[0-9a-f]{40}$/.test(text) ? ok(text as Address) : err({ _tag: "bad_hex", text, bytes: 20 }));

/** Where a log sits on the chain: its block, that block's hash, and its index among the block's logs. */
export type Place = Readonly<{ block: bigint; blockHash: Bytes32; index: bigint }>;

/** A log as the node returns it, with its numbers parsed and its hex lowercased by the shell that fetched it. */
export type RawLog = Readonly<Place & { address: Address; topics: readonly Bytes32[]; data: string; tx: Bytes32 }>;

/** The two entities of a dispute event and the nonce it names: `sender` is the entity whose batch carried the op. */
type Dispute = Readonly<Place & { sender: Bytes32; counter: Bytes32; nonce: bigint }>;

/** The proof a dispute start or a counter named: who authored it and the hash of its body (the first two words). */
type Proof = Readonly<{ proposerIsLeft: boolean; bodyHash: Bytes32 }>;

/** What the chain holds for one token of an Account after an operation: its collateral and its ondelta. */
export type Holding = Readonly<{ token: TokenId; collateral: bigint; ondelta: bigint }>;

/**
 * What a finalize showed in its arguments, which no log carries: `unasked` until the Host has fetched the input of the
 * transaction (`withCalldata`), then the secrets of the op whose evidence hash is the logged one, or `unread` when no
 * op of the input has it (the transaction was some other call, such as a contract that wrapped `processBatch`).
 */
export type Shown = Tagged<"unasked"> | Tagged<"read", { secrets: readonly Bytes32[] }> | Tagged<"unread">;

export type ChainEvent =
  | Tagged<"epoch_advanced", Place & { left: Bytes32; right: Bytes32; epoch: bigint }>
  | Tagged<"account_settled", Place & { left: Bytes32; right: Bytes32; holdings: readonly Holding[] }>
  | Tagged<
    "dispute_started",
    Dispute & Proof & {
      timeout: bigint; secrets: readonly Bytes32[]; tx: Bytes32; body: ProofBody | undefined; unread: boolean;
    }
  >
  | Tagged<"dispute_countered", Dispute & Proof>
  | Tagged<"dispute_finalized", Dispute & { bodyHash: Bytes32; evidence: Bytes32; tx: Bytes32; shown: Shown }>
  | Tagged<"secret_revealed", Place & { hashlock: Bytes32; revealer: Bytes32 | undefined; secret: Bytes32 }>;

/** The two contracts whose logs the watcher reads: the Depository, and the DeltaTransformer that holds the secrets. */
export type Deployed = Readonly<{ depository: Address; transformer: Address }>;

export type LogFault =
  | Tagged<"foreign_log", Place & { address: Address }>
  | Tagged<"unknown_event", Place & { topic: string }>
  | Tagged<"bad_log", Place & { event: string }>;

type Topics = readonly Bytes32[];
type Three = readonly [Bytes32, Bytes32, Bytes32];
type Four = readonly [Bytes32, Bytes32, Bytes32, Bytes32];

const three = (topics: Topics): topics is Three => topics.length === 3;
const four = (topics: Topics): topics is Four => topics.length === 4;

const WORD_HEX = 64;

/** How many 32-byte words a data string holds, or none when it is not whole words of lowercase hex. */
const wordsIn = (data: string): Option<number> =>
  (/^0x(?:[0-9a-f]{64})*$/.test(data) ? some((data.length - 2) / WORD_HEX) : none);

const holdsWords = (data: string, fits: (words: number) => boolean): boolean => {
  const words = wordsIn(data);
  return words._tag === "some" && fits(words.value);
};

type Reader = (at: Place, topics: Topics, data: string, tx: Bytes32) => Option<ChainEvent>;

const epochRead: Reader = (at, topics, data) =>
  (three(topics) && holdsWords(data, (n) => n === 1)
    ? some({ _tag: "epoch_advanced", ...at, left: topics[1], right: topics[2], epoch: BigInt(data) })
    : none);

/**
 * AccountSettled's data is `abi.encode(AccountSettlement[])`, and the Depository settles one Account per event: an
 * array of one `(left, right, tokens, nonce)`, whose tokens are static rows of six words `(tokenId, leftReserve,
 * rightReserve, collateral, ondelta.high, ondelta.low)`. Only that layout is read, so the words that say where things
 * are (the offsets and the length of the array) are held to the values it has, and a count that the words do not
 * fill is a fault. The ondelta is the Int512 `high * 2^256 + low`, `high` signed.
 */
const SETTLED_FIXED: readonly (readonly [number, bigint])[] = [[0, 0x20n], [1, 1n], [2, 0x20n], [5, 0x80n]];
const SETTLED_LEFT = 3;
const SETTLED_RIGHT = 4;
const SETTLED_COUNT = 7;
const SETTLED_ROWS = 8;
const ROW_WORDS = 6;
const COLLATERAL_AT = 3;
const ONDELTA_HIGH_AT = 4;
const ONDELTA_LOW_AT = 5;
const WORD_BIT_COUNT = 256;
const WORD_BITS = BigInt(WORD_BIT_COUNT);
const HEX_PREFIX = 2;

const wordText = (data: string, at: number): string =>
  data.slice(HEX_PREFIX + at * WORD_HEX, HEX_PREFIX + (at + 1) * WORD_HEX);

const wordAt = (data: string, at: number): bigint => BigInt(`0x${wordText(data, at)}`);

/** A word of data that `wordsIn` has held to lowercase hex is a Bytes32. */
const idAt = (data: string, at: number): Bytes32 => `0x${wordText(data, at)}` as Bytes32;

const holdingAt = (data: string, row: number): Holding => ({
  token: wordAt(data, row) as TokenId,
  collateral: wordAt(data, row + COLLATERAL_AT),
  ondelta: (BigInt.asIntN(WORD_BIT_COUNT, wordAt(data, row + ONDELTA_HIGH_AT)) << WORD_BITS)
    + wordAt(data, row + ONDELTA_LOW_AT),
});

const settledShape = (data: string, words: number): boolean =>
  words >= SETTLED_ROWS && SETTLED_FIXED.every(([at, value]) => wordAt(data, at) === value)
  && BigInt(words - SETTLED_ROWS) === wordAt(data, SETTLED_COUNT) * BigInt(ROW_WORDS)
  && idAt(data, SETTLED_LEFT) < idAt(data, SETTLED_RIGHT);

const settledRead: Reader = (at, topics, data) => {
  const words = wordsIn(data);
  return topics.length === 1 && words._tag === "some" && settledShape(data, words.value)
    ? some({
      _tag: "account_settled", ...at, left: idAt(data, SETTLED_LEFT), right: idAt(data, SETTLED_RIGHT),
      holdings: Array.from({ length: Number(wordAt(data, SETTLED_COUNT)) }, (_, i) =>
        holdingAt(data, SETTLED_ROWS + i * ROW_WORDS)),
    })
    : none;
};

/** The dispute events carry `(sender, counterentity, nonce)` as topics 1 to 3. */
const disputeIn = (at: Place, topics: Four): Dispute =>
  ({ ...at, sender: topics[1], counter: topics[2], nonce: BigInt(topics[3]) });

/** DisputeStarted's data is 10 head slots (13 inputs, three indexed), two of them offsets, two `bytes`, each at least
 * its length word. The seventh slot is `disputeTimeout`: the second at which the dispute's window ends. */
const STARTED_WORDS = 12;
const TIMEOUT_AT = 6;
const TWO_WORDS = 2;

const proofIn = (data: string): Proof => ({ proposerIsLeft: wordAt(data, 0) !== 0n, bodyHash: idAt(data, 1) });

const startedRead: Reader = (at, topics, data, tx) =>
  (four(topics) && holdsWords(data, (n) => n >= STARTED_WORDS)
    ? some({
      _tag: "dispute_started", ...disputeIn(at, topics), ...proofIn(data), timeout: wordAt(data, TIMEOUT_AT),
      secrets: startedSecrets(data), tx, body: undefined, unread: false,
    })
    : none);

const counteredRead: Reader = (at, topics, data) =>
  (four(topics) && holdsWords(data, (n) => n === TWO_WORDS)
    ? some({ _tag: "dispute_countered", ...disputeIn(at, topics), ...proofIn(data) })
    : none);

const finalizedRead: Reader = (at, topics, data, tx) =>
  (four(topics) && holdsWords(data, (n) => n === TWO_WORDS)
    ? some({
      _tag: "dispute_finalized", ...disputeIn(at, topics), bodyHash: idAt(data, 0), evidence: idAt(data, 1), tx,
      shown: { _tag: "unasked" },
    })
    : none);

/** `SecretRevealed(hashlock, revealer, secret)`: the hashlock and the revealer are topics, the secret is the data. */
const revealedRead: Reader = (at, topics, data) =>
  (three(topics) && holdsWords(data, (n) => n === 1)
    ? some({ _tag: "secret_revealed", ...at, hashlock: topics[1], revealer: topics[2], secret: idAt(data, 0) })
    : none);

/**
 * The transformer's own `SecretRevealed(hashlock, secret)`, whose hashlock is a topic and whose secret is the data. Its
 * `revealSecret` is public and unauthenticated (DeltaTransformer.sol 422-437): anyone may call it, and the chain then
 * pays a clause from `hashToTimestamp` with no Depository log at all. A reveal made through the Depository emits this
 * too, next to the Depository's own.
 */
const transformerRevealedRead: Reader = (at, topics, data) =>
  (topics.length === 2 && holdsWords(data, (n) => n === 1)
    ? some({ _tag: "secret_revealed", ...at, hashlock: topics[1] as Bytes32, revealer: undefined, secret: idAt(data, 0) })
    : none);

type Entry = Readonly<{ signature: string; read: Reader }>;

const READ: readonly Entry[] = [
  { signature: "AccountEpochAdvanced(bytes32,bytes32,uint256)", read: epochRead },
  {
    signature: "AccountSettled((bytes32,bytes32,(uint256,uint256,uint256,uint256,(int256,uint256))[],uint256)[])",
    read: settledRead,
  },
  {
    signature:
      "DisputeStarted(bytes32,bytes32,uint256,bool,bytes32,bytes32,bytes,bytes,bytes32,uint256,uint256,uint32,uint32)",
    read: startedRead,
  },
  {
    signature: "CounterDisputeRegistered(bytes32,bytes32,uint256,bool,bytes32)",
    read: counteredRead,
  },
  {
    signature: "DisputeFinalized(bytes32,bytes32,uint256,bytes32,bytes32)",
    read: finalizedRead,
  },
  { signature: "SecretRevealed(bytes32,bytes32,bytes32)", read: revealedRead },
];

/**
 * The Depository's events the watcher does not read yet, each named so that the list is closed. It reads six: the four
 * that move an Account's epoch or dispute, `AccountSettled`, which says what it holds, and `SecretRevealed`, which is
 * how a hub learns a payee's reveal (R-DISPUTE-FREEZE). The rest are owed (R-WATCH-READS-ALL, Q R7): `DisputeOpSkipped`
 * and `BatchFailed` name an op that did not land, the Debt events change what an Account owes. Reserves, tokens and
 * the like are no Account's chain fact.
 */
export const IGNORED: readonly string[] = [
  "BatchFailed(bytes32,uint256,bytes4)",
  "CooperativeClose(bytes32,bytes32,uint256)",
  "DebtCreated(bytes32,bytes32,uint256,(uint256,uint256),uint256)",
  "DebtEnforced(bytes32,bytes32,uint256,uint256,(uint256,uint256),uint256)",
  "DebtForgiven(bytes32,bytes32,uint256,(uint256,uint256),uint256)",
  "DisputeOpSkipped(bytes32,bytes32,uint8,uint8,uint256)",
  "HankoBatchProcessed(bytes32,bytes32,uint256)",
  "HashLadderRevealRegistered(bytes32,bytes32,bytes32,uint16,bytes32,bytes32[4],bool,uint256)",
  "ReserveUpdated(bytes32,uint256,uint256)",
  "TokenRegistered(uint256,uint8,address,uint256)",
  "TransformerDeltaClamped(bytes32,uint256,address,uint256,(int256,uint256,uint256),(int256,uint256,uint256))",
  "WatchtowerCounterDisputeExecuted(address,bytes32,bytes32,uint256,uint256)",
];

export const READ_SIGNATURES: readonly string[] = READ.map((entry) => entry.signature);

/** The event's topic 0: keccak256 of its canonical signature. */
export const topicOf = (signature: string): string => keccakHex(utf8(signature));

const READERS: ReadonlyMap<string, Reader> = new Map(READ.map((entry) => [topicOf(entry.signature), entry.read]));
const SKIPPED: ReadonlySet<string> = new Set(IGNORED.map(topicOf));
const TRANSFORMER_REVEALED = topicOf("SecretRevealed(bytes32,bytes32)");

const placeOf = (log: RawLog): Place => ({ block: log.block, blockHash: log.blockHash, index: log.index });

const lowercaseBytes32 = (topics: readonly string[]): boolean => topics.every((t) => bytes32(t).ok);

/**
 * One log of the Depository as a chain event, or none when it is an event no Account reads. A log from another
 * address, one on neither list and one that is not the shape its signature says are faults: the node is asked for the
 * Depository's logs and the Depository's ABI is closed.
 */
export const decodeLog = (deployed: Deployed, log: RawLog): Result<Option<ChainEvent>, LogFault> => {
  const at = placeOf(log);
  const topic = log.topics[0] ?? "";
  if (log.address === deployed.transformer) return transformerLog(at, topic, log);
  const read = READERS.get(topic);
  if (log.address !== deployed.depository) return err({ _tag: "foreign_log", ...at, address: log.address });
  if (!lowercaseBytes32(log.topics)) return err({ _tag: "bad_log", ...at, event: topic });
  if (read !== undefined) {
    const event = read(at, log.topics, log.data, log.tx);
    return event._tag === "some" ? ok(event) : err({ _tag: "bad_log", ...at, event: topic });
  }
  return SKIPPED.has(topic) ? ok(none) : err({ _tag: "unknown_event", ...at, topic });
};

/** A log of the transformer: its one event is read, any other is a fault (the transformer's ABI is closed too). */
const transformerLog = (at: Place, topic: string, log: RawLog): Result<Option<ChainEvent>, LogFault> => {
  if (!lowercaseBytes32(log.topics)) return err({ _tag: "bad_log", ...at, event: topic });
  if (topic !== TRANSFORMER_REVEALED) return err({ _tag: "unknown_event", ...at, topic });
  const event = transformerRevealedRead(at, log.topics, log.data, log.tx);
  return event._tag === "some" ? ok(event) : err({ _tag: "bad_log", ...at, event: topic });
};

/** The events of a block range, in the order the logs came, for the logs that are events an Account reads. */
export const decodeLogs = (deployed: Deployed, logs: readonly RawLog[]): Result<readonly ChainEvent[], LogFault> =>
  map(
    traverse(logs, (log) => decodeLog(deployed, log)),
    (found) => found.flatMap((event) => (event._tag === "some" ? [event.value] : [])),
  );
