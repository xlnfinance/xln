// What the J layer reads of the Depository's logs (R-WATCH-CLOSED, R-J1). The chain tells an Account four things, and
// each has one event: its epoch moved (`AccountEpochAdvanced`), a dispute was started, a counter was registered, a
// dispute was finalized. Every other event the Depository can emit is named below as read by nobody. A log from the
// Depository that is on neither list is a fault, so an event the contract adds is a decision here and never a silent
// miss; log.test.ts holds both lists against the deployed ABI.
//
// A log is a list of topics and a data string. What this layer reads rides the indexed topics, but for the epoch.
import { err, map, ok, traverse, type Result } from "../kernel/core/result.ts";
import { none, some, type Option } from "../kernel/core/option.ts";
import type { Brand, Tagged } from "../kernel/core/tagged.ts";
import { keccakHex, utf8 } from "../kernel/encoding/bytes.ts";

/** `0x` and 64 lowercase hex digits: an entity id, a topic or a block hash. Their text order is their numeric order. */
export type Bytes32 = Brand<string, "Bytes32">;

/** `0x` and 40 lowercase hex digits. */
export type Address = Brand<string, "Address">;

export type BadHex = Tagged<"bad_hex", { text: string; bytes: number }>;

export const bytes32 = (text: string): Result<Bytes32, BadHex> =>
  (/^0x[0-9a-f]{64}$/.test(text) ? ok(text as Bytes32) : err({ _tag: "bad_hex", text, bytes: 32 }));

export const address = (text: string): Result<Address, BadHex> =>
  (/^0x[0-9a-f]{40}$/.test(text) ? ok(text as Address) : err({ _tag: "bad_hex", text, bytes: 20 }));

/** Where a log sits on the chain: its block and its index among the block's logs. */
export type Place = Readonly<{ block: bigint; index: bigint }>;

/** A log as the node returns it, with its numbers parsed and its hex lowercased by the shell that fetched it. */
export type RawLog = Readonly<Place & {
  address: Address; blockHash: Bytes32; topics: readonly Bytes32[]; data: string;
}>;

/** The two entities of a dispute event and the nonce it names: `sender` is the entity whose batch carried the op. */
type Dispute = Readonly<Place & { sender: Bytes32; counter: Bytes32; nonce: bigint }>;

export type ChainEvent =
  | Tagged<"epoch_advanced", Place & { left: Bytes32; right: Bytes32; epoch: bigint }>
  | Tagged<"dispute_started", Dispute>
  | Tagged<"dispute_countered", Dispute>
  | Tagged<"dispute_finalized", Dispute>;

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

type Reader = (at: Place, topics: Topics, data: string) => Option<ChainEvent>;

const epochRead: Reader = (at, topics, data) =>
  (three(topics) && holdsWords(data, (n) => n === 1)
    ? some({ _tag: "epoch_advanced", ...at, left: topics[1], right: topics[2], epoch: BigInt(data) })
    : none);

/** The dispute events carry `(sender, counterentity, nonce)` as topics 1 to 3. */
const disputeIn = (at: Place, topics: Four): Dispute =>
  ({ ...at, sender: topics[1], counter: topics[2], nonce: BigInt(topics[3]) });

/** DisputeStarted's data is 10 head slots (13 inputs, three indexed), two of them offsets, two `bytes`, each at least
 * its length word. */
const STARTED_WORDS = 12;
const TWO_WORDS = 2;

const startedRead: Reader = (at, topics, data) =>
  (four(topics) && holdsWords(data, (n) => n >= STARTED_WORDS)
    ? some({ _tag: "dispute_started", ...disputeIn(at, topics) })
    : none);

const counteredRead: Reader = (at, topics, data) =>
  (four(topics) && holdsWords(data, (n) => n === TWO_WORDS)
    ? some({ _tag: "dispute_countered", ...disputeIn(at, topics) })
    : none);

const finalizedRead: Reader = (at, topics, data) =>
  (four(topics) && holdsWords(data, (n) => n === TWO_WORDS)
    ? some({ _tag: "dispute_finalized", ...disputeIn(at, topics) })
    : none);

type Entry = Readonly<{ signature: string; read: Reader }>;

const READ: readonly Entry[] = [
  { signature: "AccountEpochAdvanced(bytes32,bytes32,uint256)", read: epochRead },
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
];

/** The Depository's other events: reserves, batches, debt, tokens, secrets and the rest are no Account's chain fact. */
export const IGNORED: readonly string[] = [
  "AccountSettled((bytes32,bytes32,(uint256,uint256,uint256,uint256,(int256,uint256))[],uint256)[])",
  "BatchFailed(bytes32,uint256,bytes4)",
  "CooperativeClose(bytes32,bytes32,uint256)",
  "DebtCreated(bytes32,bytes32,uint256,(uint256,uint256),uint256)",
  "DebtEnforced(bytes32,bytes32,uint256,uint256,(uint256,uint256),uint256)",
  "DebtForgiven(bytes32,bytes32,uint256,(uint256,uint256),uint256)",
  "DisputeOpSkipped(bytes32,bytes32,uint8,uint8,uint256)",
  "HankoBatchProcessed(bytes32,bytes32,uint256)",
  "HashLadderRevealRegistered(bytes32,bytes32,bytes32,uint16,bytes32,bytes32[4],bool,uint256)",
  "ReserveUpdated(bytes32,uint256,uint256)",
  "SecretRevealed(bytes32,bytes32,bytes32)",
  "TokenRegistered(uint256,uint8,address,uint256)",
  "TransformerDeltaClamped(bytes32,uint256,address,uint256,(int256,uint256,uint256),(int256,uint256,uint256))",
  "WatchtowerCounterDisputeExecuted(address,bytes32,bytes32,uint256,uint256)",
];

export const READ_SIGNATURES: readonly string[] = READ.map((entry) => entry.signature);

/** The event's topic 0: keccak256 of its canonical signature. */
export const topicOf = (signature: string): string => keccakHex(utf8(signature));

const READERS: ReadonlyMap<string, Reader> = new Map(READ.map((entry) => [topicOf(entry.signature), entry.read]));
const SKIPPED: ReadonlySet<string> = new Set(IGNORED.map(topicOf));

const placeOf = (log: RawLog): Place => ({ block: log.block, index: log.index });

/**
 * One log of the Depository as a chain event, or none when it is an event no Account reads. A log from another
 * address, one on neither list and one that is not the shape its signature says are faults: the node is asked for the
 * Depository's logs and the Depository's ABI is closed.
 */
export const decodeLog = (depository: Address, log: RawLog): Result<Option<ChainEvent>, LogFault> => {
  const at = placeOf(log);
  const topic = log.topics[0] ?? "";
  const read = READERS.get(topic);
  if (log.address !== depository) return err({ _tag: "foreign_log", ...at, address: log.address });
  if (read !== undefined) {
    const event = read(at, log.topics, log.data);
    return event._tag === "some" ? ok(event) : err({ _tag: "bad_log", ...at, event: topic });
  }
  return SKIPPED.has(topic) ? ok(none) : err({ _tag: "unknown_event", ...at, topic });
};

/** The events of a block range, in the order the logs came, for the logs that are events an Account reads. */
export const decodeLogs = (depository: Address, logs: readonly RawLog[]): Result<readonly ChainEvent[], LogFault> =>
  map(
    traverse(logs, (log) => decodeLog(depository, log)),
    (found) => found.flatMap((event) => (event._tag === "some" ? [event.value] : [])),
  );
