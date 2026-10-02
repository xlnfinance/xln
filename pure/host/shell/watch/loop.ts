// The J loop's one poll (R-WATCH-ORDER, R-WATCH-DEPTH, R-WATCH-TELL; plan D9): what the chain says beyond the cursor,
// at depth, as the J events of the Entity this node hosts and the height they end at. It reads blocks and logs through
// a port and hands them to the watcher core (j/watch.ts), which checks them: a block that does not follow the cursor, a
// log that does not belong to its block, a reading that contradicts a log. The cursor lives in the node's memory and is
// moved by the caller only after the delivery is in the WAL (R-HEIGHT-ORDER); a restart begins again at the Runtime's
// own view, which the WAL holds, and replays what it must (every J event is idempotent).
import type { JHeight } from "../../../account/clause/clock.ts";
import type { ChainFacts, EntityId, EntityInput } from "../../../entity/model.ts";
import { entityId } from "../../../entity/model.ts";
import type { AccountAt, Addressed } from "../../../j/observe.ts";
import { hexToBytes } from "../../../kernel/encoding/bytes.ts";
import { readingKey } from "../../../j/observe.ts";
import { bytes32, type Address, type Bytes32, type RawLog } from "../../../j/log.ts";
import {
  advance, calldataWanted, finalizedAt, prepare, readings, watching, withCalldata, type Block, type Watch,
  type WatchFault, type Window,
} from "../../../j/watch.ts";
import { err, flatMap, map, ok, traverse, type Result } from "../../../kernel/core/result.ts";
import type { Tagged } from "../../../kernel/core/tagged.ts";
import type { PortFault } from "../submit/chain.ts";

/** What the loop asks of the chain: the head, a block by number, the Depository's logs in a range, an Account's row. */
export type WatchPort = Readonly<{
  head: () => Promise<Result<bigint, PortFault>>;
  block: (number: bigint) => Promise<Result<Block, PortFault>>;
  logs: (from: bigint, to: bigint) => Promise<Result<readonly RawLog[], PortFault>>;
  /** The Account's `ondeltaEpoch` and stored nonce at the end of the block with this hash. */
  accountAt: (block: Bytes32, left: Bytes32, right: Bytes32) => Promise<Result<AccountAt, PortFault>>;
  /** The input of the transaction with this hash, where a finalize's arguments are (R-WATCH-CALLDATA). */
  input: (tx: Bytes32) => Promise<Result<Uint8Array, PortFault>>;
}>;

/** What the node watches: the Depository, how deep a block must be buried, and the Entity it hosts. */
export type WatchConfig = Readonly<{ port: WatchPort; depository: Address; depth: bigint; hosted: Bytes32 }>;

/** A peer id the chain named that is not an Entity id the node can use: a broken reading, not a retry. */
export type BadPeer = Tagged<"bad_peer", { text: string }>;

/** A secret the chain showed that is not 32 bytes of hex: the log was read as bytes32, so this is a broken reading. */
export type BadSecret = Tagged<"bad_secret", { text: string }>;

export type JFault = PortFault | WatchFault | BadPeer | BadSecret;

/** The most blocks one poll reads: a node that was away reads on over several polls, not in one burst of requests. */
const CATCH_UP = 64n;

/** The cursor at the chain's own block `number`, final by the node's own choice (its view). */
export const beginAt = async (config: WatchConfig, number: bigint): Promise<Result<Watch, JFault>> => {
  const block = await config.port.block(number);
  return block.ok ? watching(config.depository, config.depth, block.value) : block;
};

const blocksAfter = async (port: WatchPort, from: bigint, to: bigint): Promise<Result<readonly Block[], PortFault>> =>
  traverse(
    await Promise.all(Array.from({ length: Number(to - from) }, (_, i) => port.block(from + 1n + BigInt(i)))),
    (block) => block,
  );

const inputAt = async (port: WatchPort, tx: Bytes32): Promise<Result<readonly [Bytes32, Uint8Array], PortFault>> =>
  map(await port.input(tx), (input) => [tx, input] as const);

/** The inputs of the transactions that carried a finalize, by hash: each asked once, a miss is the node's to retry. */
const inputsOf = async (
  port: WatchPort, txs: readonly Bytes32[],
): Promise<Result<ReadonlyMap<Bytes32, Uint8Array>, PortFault>> =>
  map(
    traverse(await Promise.all(txs.map((tx) => inputAt(port, tx))), (r) => r),
    (found) => new Map(found),
  );

/** One delivery: the J events for the node's Entity, in the chain's order, and then the height they end at. */
export type Delivery = Readonly<{ watch: Watch; events: readonly EntityInput[]; height: JHeight }>;

const peerOf = (event: { peer: Bytes32 }): Result<EntityId, BadPeer> => {
  const peer = entityId(event.peer);
  return peer.ok ? peer : err({ _tag: "bad_peer", text: event.peer });
};

/** The Entity's input for what the watcher told: the peer's id for an Account's event, the bytes of a secret. */
const inputOf = (event: Addressed["event"]): Result<EntityInput, BadPeer | BadSecret> => {
  if (event._tag !== "j_secret") return map(peerOf(event), (peer) => ({ ...event, peer }) as EntityInput);
  const bytes = hexToBytes(event.secret);
  return bytes.ok ? ok({ _tag: "j_secret", secret: bytes.value }) : err({ _tag: "bad_secret", text: event.secret });
};

/** The end of the window the Entity waits on, of a dispute it started or one it answers, while the window is open. */
const waitedOn = (facts: ChainFacts): bigint | undefined => {
  const { starting, against } = facts;
  if (starting?.window !== undefined && !starting.over) return starting.window;
  return against === undefined || against.over ? undefined : against.window;
};

const windowOf = (self: Bytes32, peer: EntityId, facts: ChainFacts): Result<readonly Window[], BadPeer> => {
  const timeout = waitedOn(facts);
  if (timeout === undefined) return ok([]);
  const named = bytes32(peer);
  return named.ok ? ok([{ to: self, peer: named.value, timeout }]) : err({ _tag: "bad_peer", text: peer });
};

/**
 * The dispute windows an Entity waits on: each dispute it started or answers that the chain gave an end to, until it is
 * told the window is over. They are read off the Entity's own chain facts (which the WAL rebuilds), so a restart
 * forgets none.
 */
export const windowsOf = (
  self: Bytes32, chain: ReadonlyMap<EntityId, ChainFacts>,
): Result<readonly Window[], BadPeer> =>
  map(traverse([...chain], ([peer, facts]) => windowOf(self, peer, facts)), (found) => found.flat());

/**
 * The next delivery, or nothing when no block past the cursor is final yet. `hosted` is the Entity the node hosts, and
 * `windows` the dispute windows it waits on: each is told to it, once a delivery's last block is past its end.
 * A fault of the port is the node's to retry; a fault of the core is a local invariant broken (a reorg deeper than the
 * depth) and ends the node.
 */
export const poll = async (
  port: WatchPort, watch: Watch, hosted: Bytes32, windows: readonly Window[] = [],
): Promise<Result<Delivery | undefined, JFault>> => {
  const head = await port.head();
  if (!head.ok) return head;
  const to = [finalizedAt(watch.depth, head.value), watch.applied.number + CATCH_UP].reduce((a, b) => (a < b ? a : b));
  if (to <= watch.applied.number) return ok(undefined);
  const blocks = await blocksAfter(port, watch.applied.number, to);
  if (!blocks.ok) return blocks;
  const logs = await port.logs(watch.applied.number + 1n, to);
  if (!logs.ok) return logs;
  const prepared = prepare(watch, { head: head.value, blocks: blocks.value, logs: logs.value });
  if (!prepared.ok) return prepared;
  const inputs = await inputsOf(port, calldataWanted(prepared.value));
  if (!inputs.ok) return inputs;
  const read = withCalldata(prepared.value, inputs.value);
  const asked = await Promise.all(readings(read, [hosted]).map(async (r) =>
    map(await port.accountAt(r.blockHash, r.left, r.right), (at) => [readingKey(r), at] as const)));
  const accounts = traverse(asked, (answer) => answer);
  if (!accounts.ok) return accounts;
  const step = advance(watch, read, [hosted], new Map(accounts.value), windows);
  return flatMap(step, (done) => map(
    traverse(done.events, ({ event }) => inputOf(event)),
    (events): Delivery => ({ watch: done.watch, events, height: done.height }),
  ));
};
