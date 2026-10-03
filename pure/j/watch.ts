// The watcher's core: J events reach the Runtime once, in the chain's order, and only at depth (R-WATCH-ORDER,
// R-WATCH-DEPTH; plan D9, Q-X-10). The Host fetches blocks and logs and calls this; nothing here reads a clock or a
// node.
//
// A Watch is a cursor: the last block whose events were delivered and its hash. The blocks past it are final once the
// head is `depth` above them, and only final blocks are delivered. The height a delivery ends at is the Runtime's
// `finalizedJHeight` of the clock rule (R-HTLC-CLOCK, R-CLOCK): the later of it and the context's is the view a party
// acts on, so the view never runs ahead of an event it has not been told, and it never falls back.
//
// The Host keeps the cursor and moves it only once the Runtime has the delivery in its WAL. A crash between the two
// replays the same delivery from the old cursor, and every J event is idempotent (an older or repeated report changes
// nothing), so a replay is a repeat, never a loss. A block whose parent is not the cursor's block is a reorg deeper
// than `depth`: a broken local invariant (D9), and the one fault here that is a halt, not a retry.
import { err, flatMap, foldResult, map, ok, type Result } from "../kernel/core/result.ts";
import type { Tagged } from "../kernel/core/tagged.ts";
import { jHeight, type HeightFault, type JHeight } from "../account/clause/clock.ts";
import { finalizedSecrets, startedBody, type Read } from "./calldata/decode.ts";
import {
  decodeLogs, type Address, type Bytes32, type ChainEvent, type Deployed, type LogFault, type RawLog,
} from "./log.ts";
import {
  accountOf, beginsAt, hostsAny, observe, readingsOf, type Accounts, type Addressed, type JEvent, type ObserveFault,
  type Reading,
} from "./observe.ts";

/** A block as the node tells it: `timestamp` is the chain's own second for it, the clock a dispute's window runs on. */
export type Block = Readonly<{ number: bigint; hash: Bytes32; parent: Bytes32; timestamp: bigint }>;

/** What the Host knows: where it has delivered up to, how deep a block must be buried, and the contract it watches. */
export type Watch = Readonly<{ deployed: Deployed; depth: bigint; applied: Block }>;

export type WatchFault =
  | Tagged<"bad_depth", { depth: bigint }>
  | Tagged<"gap", { expected: bigint; found: bigint }>
  | Tagged<"deep_reorg", { at: bigint; applied: Bytes32; chain: Bytes32 }>
  | Tagged<"broken_chain", { at: bigint }>
  | Tagged<"beyond_depth", { block: bigint; finalized: bigint }>
  | Tagged<"log_without_block", { block: bigint; index: bigint }>
  | Tagged<"log_out_of_order", { block: bigint; index: bigint }>
  | LogFault
  | ObserveFault
  | HeightFault;

/** Start at a block already final: the deployment block's parent, or the cursor the Host last stored. */
export const watching = (deployed: Deployed, depth: bigint, from: Block): Result<Watch, WatchFault> =>
  (depth < 0n ? err({ _tag: "bad_depth", depth }) : ok({ deployed, depth, applied: from }));

/** The highest block whose events may be delivered when the chain's head is `head`. */
export const finalizedAt = (depth: bigint, head: bigint): bigint => (head > depth ? head - depth : 0n);

/** What the Host fetched: the head it saw, the blocks after the cursor, and the Depository's logs in them. */
export type Batch = Readonly<{ head: bigint; blocks: readonly Block[]; logs: readonly RawLog[] }>;

/** A batch that is a chain from the cursor, at depth, with its logs decoded; `last` is the new cursor. */
export type Prepared = Readonly<{ last: Block; events: readonly ChainEvent[] }>;

/** The blocks run on from the cursor, each on its parent. The last one is the new cursor, or the cursor if none. */
const linked = (w: Watch, blocks: readonly Block[]): Result<Block, WatchFault> =>
  foldResult(blocks, w.applied, (prev, block, i): Result<Block, WatchFault> => {
    switch (true) {
      case block.number !== prev.number + 1n:
        return err({ _tag: "gap", expected: prev.number + 1n, found: block.number });
      case block.parent === prev.hash: return ok(block);
      case i === 0: return err({ _tag: "deep_reorg", at: block.number, applied: prev.hash, chain: block.parent });
      default: return err({ _tag: "broken_chain", at: block.number });
    }
  });

/** Only a block `depth` below the head is delivered; a batch with no blocks asks for nothing. */
const buried = (w: Watch, batch: Batch, last: Block): Result<Block, WatchFault> => {
  const finalized = finalizedAt(w.depth, batch.head);
  const early = batch.blocks.length > 0 && last.number > finalized;
  return early ? err({ _tag: "beyond_depth", block: last.number, finalized }) : ok(last);
};

type Seen = Readonly<{ block: bigint; index: bigint }>;

const NOTHING_SEEN: Seen = { block: -1n, index: -1n };

const after = (log: Seen, seen: Seen): boolean =>
  log.block > seen.block || (log.block === seen.block && log.index > seen.index);

/** Every log sits in a block of the batch, with that block's hash, and the logs run in strictly rising order. */
const belonging = (blocks: readonly Block[], logs: readonly RawLog[]): Result<Seen, WatchFault> =>
  foldResult(logs, NOTHING_SEEN, (seen, log): Result<Seen, WatchFault> => {
    const at = { block: log.block, index: log.index };
    switch (true) {
      case !blocks.some((b) => b.number === log.block && b.hash === log.blockHash):
        return err({ _tag: "log_without_block", ...at });
      case !after(at, seen): return err({ _tag: "log_out_of_order", ...at });
      default: return ok(at);
    }
  });

/**
 * Check what the Host fetched and read the Depository's logs in it. A fault is the Host's to retry or, for
 * `deep_reorg`, the Runtime's to halt on; the cursor has not moved.
 */
export const prepare = (w: Watch, batch: Batch): Result<Prepared, WatchFault> =>
  flatMap(linked(w, batch.blocks), (tip) =>
    flatMap(buried(w, batch, tip), (last) =>
      flatMap(belonging(batch.blocks, batch.logs), () =>
        map(decodeLogs(w.deployed, batch.logs), (events) => ({ last, events })))));

/**
 * The transactions whose input the Host must read: the ones that carried a dispute start (its body) or a dispute
 * finalize (its arguments) of an Account a hosted Entity is a party to, R-WATCH-CALLDATA. A stranger's dispute is not
 * read: the node asks the chain for nothing a stranger can make it ask for.
 */
export const calldataWanted = (p: Prepared, hosted: readonly Bytes32[]): readonly Bytes32[] =>
  [...new Set(p.events.flatMap((e) =>
    ((e._tag === "dispute_finalized" || e._tag === "dispute_started") && hostsAny(hosted, e) ? [e.tx] : [])))];

/**
 * The prepared batch with the arguments of its finalizes read from the bytes that carried them, by transaction hash:
 * the input of the transaction and, where the Host asked the node for a call trace, the input of each call it made to
 * the Depository. A finalize is `read` when a `processBatch` call among those bytes, wherever a wrapper put it, has an
 * op that carries the evidence hash the log did, and `unread` when none does or the Host has no bytes for it.
 */
export const withCalldata = (p: Prepared, inputs: ReadonlyMap<Bytes32, readonly Read[]>): Prepared => ({
  ...p,
  events: p.events.map((e): ChainEvent => {
    if (e._tag === "dispute_started") {
      const body = (inputs.get(e.tx) ?? []).flatMap((input) => startedBody(input, e.bodyHash) ?? []).at(0);
      return { ...e, body, unread: body === undefined };
    }
    if (e._tag !== "dispute_finalized") return e;
    const read = (inputs.get(e.tx) ?? []).map((input) => finalizedSecrets(input, e.evidence))
      .filter((r) => r !== undefined);
    return { ...e, shown: read.length > 0 ? { _tag: "read", secrets: [...new Set(read.flat())] } : { _tag: "unread" } };
  }),
});

/**
 * The transactions of a hosted Account's disputes whose calldata the Host could not read what the log is about from: a
 * finalize no bytes it holds carry, and a start whose body none does. The Host asks the node for a call trace of
 * these, once.
 */
export const unreadTxs = (p: Prepared, hosted: readonly Bytes32[]): readonly Bytes32[] => {
  const unread = (e: ChainEvent): boolean =>
    ((e._tag === "dispute_finalized" && e.shown._tag === "unread")
      || (e._tag === "dispute_started" && e.body === undefined)) && hostsAny(hosted, e);
  return [...new Set(p.events.filter(unread).flatMap((e) => ("tx" in e ? [e.tx] : [])))];
};

/** The events of a batch that are told now, and the ones held back, both in the chain's order. */
export type Split = Readonly<{ ready: readonly ChainEvent[]; held: readonly ChainEvent[] }>;

type Position = Readonly<{ block: bigint; index: bigint }>;

const earlier = (a: Position, b: Position): boolean => a.block < b.block || (a.block === b.block && a.index < b.index);

/**
 * R-WATCH-STALL: what a transaction the Host cannot read yet holds back: the events of its own Accounts, from its first
 * event of them on (the chain's order within an Account is kept: a later event of it never reaches the Entity ahead of
 * an earlier one), and nothing of any other Account, nor a revealed secret, which is about none. The epoch advance a
 * finalize made counts as the finalize's own (`beginsAt`), so the secrets it showed come before the dissolve of the
 * holds that advance causes.
 */
export const splitStalled = (events: readonly ChainEvent[], stalled: ReadonlySet<Bytes32>): Split => {
  const begun = events.flatMap((e): readonly (readonly [string, Position])[] => {
    const account = accountOf(e);
    const reads = e._tag === "dispute_started" || e._tag === "dispute_finalized";
    return account !== undefined && reads && stalled.has(e.tx) ? [[account, beginsAt(events, e)]] : [];
  });
  const held = (e: ChainEvent): boolean => {
    const account = accountOf(e);
    return begun.some(([key, at]) => key === account && !earlier(e, at));
  };
  return { ready: events.filter((e) => !held(e)), held: events.filter(held) };
};

/** The Accounts the chain must be asked about, at the end of which block, before `advance` can run. */
export const readings = (p: Prepared, hosted: readonly Bytes32[]): readonly Reading[] => readingsOf(p.events, hosted);

/** A dispute window a hosted Entity waits on: its dispute with `peer` ends at the chain's second `timeout`. */
export type Window = Readonly<{ to: Bytes32; peer: Bytes32; timeout: bigint }>;

/** The windows of the disputes a delivery's own events say the hosted Entity started: the Host cannot know them yet. */
const opening = (events: readonly Addressed[]): readonly Window[] =>
  events.flatMap(({ to, event }): readonly Window[] =>
    (event._tag === "j_dispute" && event.by === (to < event.peer ? "left" : "right")
      ? [{ to, peer: event.peer, timeout: event.timeout }]
      : []));

/**
 * The windows the chain's clock has passed by the delivery's last block, each told to its Entity once per delivery
 * (R-DISPUTE-FINALIZE). A block's second is the chain's own, so a window is over for the Entity only when a final
 * block says so: nothing here reads the Host's clock. The windows are those the Host brings and those the delivery's
 * own events open, so a dispute whose start and window end are in one delivery is not left for the next block.
 */
const passed = (
  at: bigint, hosted: readonly Bytes32[], windows: readonly Window[], events: readonly Addressed[],
): readonly Addressed[] =>
  [...windows, ...opening(events)].filter((x) => hosted.includes(x.to) && at >= x.timeout)
    .map((x): Addressed => ({ to: x.to, event: { _tag: "j_window_over", peer: x.peer } satisfies JEvent }));

/** The J events of one delivery for the hosted Entities, the height they end at, and the cursor to store. */
export type Step = Readonly<{ watch: Watch; height: JHeight; events: readonly Addressed[] }>;

/**
 * Deliver a prepared batch: the J events of its logs for the hosted Entities, in the chain's order, then the windows
 * the batch's last block has passed, and the height they end at. The new cursor is the batch's last block; an empty
 * batch is the cursor itself and announces its height again.
 */
export const advance = (
  w: Watch, p: Prepared, hosted: readonly Bytes32[], accounts: Accounts, windows: readonly Window[] = [],
): Result<Step, WatchFault> =>
  flatMap(observe(p.events, hosted, accounts), (events) =>
    map(jHeight(p.last.number), (height) => ({
      watch: { ...w, applied: p.last }, height,
      events: [...events, ...passed(p.last.timestamp, hosted, windows, events)],
    })));
