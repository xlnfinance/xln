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
  advance, calldataWanted, finalizedAt, prepare, readings, unreadTxs, watching, withCalldata, type Block, type Watch,
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
  /**
   * The input of the transaction with this hash, where a finalize's arguments are (R-WATCH-CALLDATA). Nothing
   * (`undefined`) when the node does not know the transaction.
   */
  input: (tx: Bytes32) => Promise<Result<Uint8Array | undefined, PortFault>>;
  /**
   * The input of every call the transaction made to the Depository, from the node's call trace, when a wrapper hid the
   * call from the input. Nothing (`undefined`) when the node has no call trace: that is an answer, not a fault.
   */
  trace: (tx: Bytes32) => Promise<Result<readonly Uint8Array[] | undefined, PortFault>>;
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

/**
 * What the node gave for each transaction asked, and the faults it met: a tx is in one of the two, or in neither (the
 * node gave no answer: it does not know the transaction, or has no call trace).
 */
type Gathered = Readonly<{
  found: ReadonlyMap<Bytes32, readonly Uint8Array[]>; failed: ReadonlyMap<Bytes32, PortFault>;
}>;

const NOTHING: Gathered = { found: new Map(), failed: new Map() };

/**
 * A block this far behind the head is one a node that still does not know a transaction of has dropped it (it was
 * pruned): waiting would never read it, so it is told unread and the delivery goes on. A younger one may be a backend
 * that has not indexed it yet, so it stalls like any fault.
 */
const PRUNED_AFTER = 256n;

const unknown = (tx: Bytes32): PortFault =>
  ({ _tag: "port", call: "watch tx", reason: `the node does not know ${tx}` });

/** The transactions the node did not know and that are too young to be given up on, as the faults they are. */
const youngMissing = (
  asked: readonly Bytes32[], got: Gathered, logs: readonly RawLog[], head: bigint,
): ReadonlyMap<Bytes32, PortFault> =>
  new Map(asked.filter((tx) => !got.found.has(tx) && !got.failed.has(tx)).filter((tx) =>
    logs.some((log) => log.tx === tx && head - log.block < PRUNED_AFTER)).map((tx) => [tx, unknown(tx)]));

const gather = async (
  txs: readonly Bytes32[], ask: (tx: Bytes32) => Promise<Result<readonly Uint8Array[] | undefined, PortFault>>,
): Promise<Gathered> => {
  const answers = await Promise.all(txs.map(async (tx) => [tx, await ask(tx)] as const));
  return {
    found: new Map(answers.flatMap(([tx, a]) => (a.ok && a.value !== undefined ? [[tx, a.value] as const] : []))),
    failed: new Map(answers.flatMap(([tx, a]) => (a.ok ? [] : [[tx, a.error] as const]))),
  };
};

/** The bytes of each transaction by hash: its input and the inputs of its calls to the Depository, in that order. */
const joined = (a: Gathered, b: Gathered): Gathered => ({
  found: new Map([...a.found, ...b.found].map(([tx]) =>
    [tx, [...(a.found.get(tx) ?? []), ...(b.found.get(tx) ?? [])]])),
  failed: new Map([...a.failed, ...b.failed]),
});

/** The earliest block that holds a log of a transaction the Host could not read, and why: what lies before is told. */
type Stall = Readonly<{ block: bigint; fault: PortFault }>;

const firstStall = (logs: readonly RawLog[], failed: ReadonlyMap<Bytes32, PortFault>): Stall | undefined =>
  logs.flatMap((log): readonly Stall[] => {
    const fault = failed.get(log.tx);
    return fault === undefined ? [] : [{ block: log.block, fault }];
  }).toSorted((x, y) => (x.block < y.block ? -1 : 1)).at(0);

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
  // The bytes a finalize or a start left: the input of its transaction, and when a wrapper hid the call there, the
  // call trace. A tx the node cannot give stalls the delivery at its block, not the poll: what lies before is told.
  const wanted = calldataWanted(prepared.value, [hosted]);
  const asked = await gather(wanted, async (tx) =>
    map(await port.input(tx), (i) => (i === undefined ? undefined : [i])));
  const inputs = joined(asked, { found: new Map(), failed: youngMissing(wanted, asked, logs.value, head.value) });
  const known = new Set(wanted.filter((tx) => !asked.found.has(tx)));
  const unread = unreadTxs(withCalldata(prepared.value, inputs.found), [hosted]).filter((tx) => !known.has(tx));
  const traces = unread.length === 0 ? NOTHING : await gather(unread, port.trace);
  const gathered = joined(inputs, traces);
  const stall = firstStall(logs.value, gathered.failed);
  const upTo = stall === undefined ? to : stall.block - 1n;
  if (stall !== undefined && upTo <= watch.applied.number) return err(stall.fault);
  const cut = stall === undefined
    ? prepared
    : prepare(watch, {
      head: head.value, blocks: blocks.value.filter((b) => b.number <= upTo),
      logs: logs.value.filter((log) => log.block <= upTo),
    });
  if (!cut.ok) return cut;
  const read = withCalldata(cut.value, gathered.found);
  const states = await Promise.all(readings(read, [hosted]).map(async (r) =>
    map(await port.accountAt(r.blockHash, r.left, r.right), (at) => [readingKey(r), at] as const)));
  const accounts = traverse(states, (answer) => answer);
  if (!accounts.ok) return accounts;
  const step = advance(watch, read, [hosted], new Map(accounts.value), windows);
  return flatMap(step, (done) => map(
    traverse(done.events, ({ event }) => inputOf(event)),
    (events): Delivery => ({ watch: done.watch, events, height: done.height }),
  ));
};
