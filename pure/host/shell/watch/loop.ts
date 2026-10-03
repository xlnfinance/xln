// The J loop's one poll (R-WATCH-ORDER, R-WATCH-DEPTH, R-WATCH-TELL; plan D9): what the chain says beyond the cursor,
// at depth, as the J events of the Entity this node hosts and the height they end at. It reads blocks and logs through
// a port and hands them to the watcher core (j/watch.ts), which checks them: a block that does not follow the cursor, a
// log that does not belong to its block, a reading that contradicts a log. The cursor lives in the node's memory and is
// moved by the caller only after the delivery is in the WAL (R-HEIGHT-ORDER); a restart begins again at the Runtime's
// own view, which the WAL holds, and replays what it must (every J event is idempotent).
//
// A transaction of a dispute the node cannot read the bytes of (R-WATCH-STALL) holds back the events of its own Account
// from its first event on, and nothing else: the other Accounts and every revealed secret go on at once. The held
// events wait in the Host's `Carry`, the Entity is told which block they begin at (`j_behind`: the record a restart
// reads the cursor back from), and they are told when the transaction can be read, or when waiting no longer helps.
import type { JHeight } from "../../../account/clause/clock.ts";
import type { ChainFacts, EntityId, EntityInput } from "../../../entity/model.ts";
import { entityId } from "../../../entity/model.ts";
import { readOf, type Carried, type Read } from "../../../j/calldata/decode.ts";
import { peerOfEvent, readingKey, type AccountAt, type Addressed } from "../../../j/observe.ts";
import { hexToBytes } from "../../../kernel/encoding/bytes.ts";
import { bytes32, type Bytes32, type ChainEvent, type Deployed, type RawLog } from "../../../j/log.ts";
import {
  advance, calldataWanted, finalizedAt, prepare, readings, splitStalled, unreadTxs, watching, withCalldata,
  type Block, type Prepared, type Watch, type WatchFault, type Window,
} from "../../../j/watch.ts";
import { err, flatMap, map, ok, traverse, type Result } from "../../../kernel/core/result.ts";
import type { Tagged } from "../../../kernel/core/tagged.ts";
import type { PortFault } from "../submit/chain.ts";

/** What the node's call trace said of a transaction (R-WATCH-CALLDATA). */
export type Traced =
  | Tagged<"calls", { calls: readonly Carried[] }>
  | Tagged<"unreadable">
  | Tagged<"no_method">;

/** What the boot probe found: the node traces calls, it does not, or no recent transaction could tell. */
export type Probe = "traces" | "none" | "no_transaction";

/** What the loop asks of the chain: the head, a block by number, the Depository's logs in a range, an Account's row. */
export type WatchPort = Readonly<{
  head: () => Promise<Result<bigint, PortFault>>;
  block: (number: bigint) => Promise<Result<Block, PortFault>>;
  logs: (from: bigint, to: bigint) => Promise<Result<readonly RawLog[], PortFault>>;
  /** The Account's `ondeltaEpoch` and stored nonce at the end of the block with this hash. */
  accountAt: (block: Bytes32, left: Bytes32, right: Bytes32) => Promise<Result<AccountAt, PortFault>>;
  /**
   * The input of the transaction with this hash, where a finalize's arguments are (R-WATCH-CALLDATA), and whether the
   * transaction was to the Depository (`direct`) or to another contract (`wrapper`). Nothing (`undefined`) when the
   * node does not know the transaction.
   */
  input: (tx: Bytes32) => Promise<Result<Carried | undefined, PortFault>>;
  /**
   * The input of every call the transaction made to the Depository (each `direct`), from the node's call trace, when a
   * wrapper hid the call from the input. A node with no such method says so, and a trace the transaction makes
   * unreadable (too deep, not a tree) is `unreadable`: those are answers, not faults.
   */
  trace: (tx: Bytes32) => Promise<Result<Traced, PortFault>>;
  /** Whether the node answers `debug_traceTransaction` with the callTracer: asked once, as a node with value boots. */
  traced: () => Promise<Result<Probe, PortFault>>;
}>;

/** What the node watches: the Depository, how deep a block must be buried, and the Entity it hosts. */
export type WatchConfig = Readonly<{
  port: WatchPort; deployed: Deployed; depth: bigint; hosted: Bytes32;
  /**
   * The node may hold value. A wrapper that builds its call at run time leaves no selector in its input, so the secret
   * of a relayed finalize is learned only from the call trace: a node with value boots only on a provider that has one,
   * and stops if the provider says at run time that it has none.
   */
  value: boolean;
}>;

/** A peer id the chain named that is not an Entity id the node can use: a broken reading, not a retry. */
export type BadPeer = Tagged<"bad_peer", { text: string }>;

/** A secret the chain showed that is not 32 bytes of hex: the log was read as bytes32, so this is a broken reading. */
export type BadSecret = Tagged<"bad_secret", { text: string }>;

export type JFault = PortFault | WatchFault | BadPeer | BadSecret;

/**
 * The tries of a transaction the node could not give, before waiting on it no longer helps when no lock of the Entity
 * depends on it (R-WATCH-STALL). A try is counted once per head block, so this is a few blocks, not a few ticks.
 */
export const FEW_TRIES = 3;

/** The most blocks one poll reads: a node that was away reads on over several polls, not in one burst of requests. */
const CATCH_UP = 64n;

/** A transaction the node fails to give: its tries counted in head blocks, the head it last tried at, and why. */
export type Failing = Readonly<{ tries: number; head: bigint; fault: PortFault }>;

/**
 * What the Host holds of a transaction between polls, for as long as its events are held back: the reads of its bytes
 * (the scan is the costly part: once per transaction, whatever a hostile wrapper sends and however many polls a stall
 * takes), and whether its call trace was asked and answered.
 */
export type Known = Readonly<{ reads: readonly Read[]; traced: boolean }>;

/**
 * What the Host carries from poll to poll: the transactions the node fails to give, what it has read of the ones whose
 * events wait, and the events themselves, in the chain's order, as the chain logged them (not yet read with the bytes).
 */
export type Carry = Readonly<{
  failing: ReadonlyMap<Bytes32, Failing>; reads: ReadonlyMap<Bytes32, Known>; held: readonly ChainEvent[];
}>;

export const NO_CARRY: Carry = { failing: new Map(), reads: new Map(), held: [] };

/**
 * What the loop needs to know of the Entity to wait for it: for each peer the last view at which hearing a secret of
 * a dispute transaction of that Account still lets the Entity claim upstream (`lastHeard`, from its outstanding
 * forwards: a peer with none is not in the map), the peers it was told are behind, and the view it is at.
 */
export type Standing = Readonly<{
  lastHeard: ReadonlyMap<string, bigint>; behind: ReadonlySet<string>; view: bigint;
}>;

export const NO_STANDING: Standing = { lastHeard: new Map(), behind: new Set(), view: 0n };

/** A transaction a delivery waits on, and the Account it holds back. */
export type Stall = Readonly<{ tx: Bytes32; peer: Bytes32; fault: PortFault; tries: number }>;

/**
 * One delivery: the J events for the node's Entity, in the chain's order, and then the height they end at, with what
 * the Host carries on, the transactions it still waits on, and whether the provider said it has no call trace.
 */
export type Delivery = Readonly<{
  watch: Watch; events: readonly EntityInput[]; height: JHeight; carry: Carry; stalls: readonly Stall[];
  untraceable: boolean;
}>;

/** The cursor at the chain's own block `number`, final by the node's own choice (its view). */
export const beginAt = async (config: WatchConfig, number: bigint): Promise<Result<Watch, JFault>> => {
  const block = await config.port.block(number);
  return block.ok ? watching(config.deployed, config.depth, block.value) : block;
};

const blocksAfter = async (port: WatchPort, from: bigint, to: bigint): Promise<Result<readonly Block[], PortFault>> =>
  traverse(
    await Promise.all(Array.from({ length: Number(to - from) }, (_, i) => port.block(from + 1n + BigInt(i)))),
    (block) => block,
  );

/** What the node answered for a transaction: the bytes, no answer (it knows none), or that it has no trace method. */
type Asked = readonly Read[] | undefined | "no_method";

/**
 * What the node gave for each transaction asked, the faults it met, and the traces it said it has no method for: a tx
 * is in one of the first two, or in neither (the node gave no answer: it does not know the transaction).
 */
type Gathered = Readonly<{
  found: ReadonlyMap<Bytes32, readonly Read[]>; failed: ReadonlyMap<Bytes32, PortFault>; noMethod: ReadonlySet<Bytes32>;
}>;

const NOTHING: Gathered = { found: new Map(), failed: new Map(), noMethod: new Set() };

const unknown = (tx: Bytes32): PortFault =>
  ({ _tag: "port", call: "watch tx", reason: `the node does not know ${tx}` });

/**
 * The transactions the node did not know, as the faults they are: a backend that has not indexed a young one yet, or a
 * pruned node that will never give an old one, answer alike (null), and which it is cannot be told from the answer.
 */
const missingOf = (asked: readonly Bytes32[], got: Gathered): ReadonlyMap<Bytes32, PortFault> =>
  new Map(asked.filter((tx) => !got.found.has(tx) && !got.failed.has(tx)).map((tx) => [tx, unknown(tx)]));

const gather = async (
  txs: readonly Bytes32[], ask: (tx: Bytes32) => Promise<Result<Asked, PortFault>>,
): Promise<Gathered> => {
  const answers = await Promise.all(txs.map(async (tx) => [tx, await ask(tx)] as const));
  return {
    found: new Map(answers.flatMap(([tx, a]) =>
      (a.ok && a.value !== undefined && a.value !== "no_method" ? [[tx, a.value] as const] : []))),
    failed: new Map(answers.flatMap(([tx, a]) => (a.ok ? [] : [[tx, a.error] as const]))),
    noMethod: new Set(answers.flatMap(([tx, a]) => (a.ok && a.value === "no_method" ? [tx] : []))),
  };
};

/** The bytes of each transaction by hash: its input and the inputs of its calls to the Depository, in that order. */
const joined = (a: Gathered, b: Gathered): Gathered => ({
  found: new Map([...a.found, ...b.found].map(([tx]) =>
    [tx, [...(a.found.get(tx) ?? []), ...(b.found.get(tx) ?? [])]])),
  failed: new Map([...a.failed, ...b.failed]),
  noMethod: new Set([...a.noMethod, ...b.noMethod]),
});

const peerOf = (event: { peer: Bytes32 }): Result<EntityId, BadPeer> => {
  const peer = entityId(event.peer);
  return peer.ok ? peer : err({ _tag: "bad_peer", text: event.peer });
};

/** The Entity's input for what the watcher told: the peer's id for an Account's event, the bytes of a secret. */
const inputOf = (event: Addressed["event"]): Result<EntityInput, BadPeer | BadSecret> => {
  if (event._tag !== "j_secret") return map(peerOf(event), (peer) => ({ ...event, peer }) as EntityInput);
  const bytes = hexToBytes(event.secret);
  return bytes.ok ? ok({ _tag: "j_secret", secret: bytes.value, at: event.at }) : err({ _tag: "bad_secret", text: event.secret });
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
 * The block a restart begins reading again after: the one before the earliest block whose events the Entity was told
 * the Host holds back for any Account (`j_behind`), if that is before the view the WAL holds.
 */
export const resumeAt = (view: bigint, chain: ReadonlyMap<EntityId, ChainFacts>): bigint =>
  [...chain.values()].flatMap((facts) => (facts.behind === undefined ? [] : [facts.behind - 1n]))
    .reduce((least, block) => (block < least ? block : least), view);

/** What a poll reads of the chain, checked: the blocks past the cursor that are final, their logs and the batch. */
type Range = Readonly<{
  head: bigint; to: bigint; blocks: readonly Block[]; logs: readonly RawLog[]; prepared: Prepared;
}>;

const rangeAt = async (port: WatchPort, watch: Watch): Promise<Result<Range | undefined, JFault>> => {
  const head = await port.head();
  if (!head.ok) return head;
  const to = [finalizedAt(watch.depth, head.value), watch.applied.number + CATCH_UP].reduce((a, b) => (a < b ? a : b));
  if (to <= watch.applied.number) return ok(undefined);
  const blocks = await blocksAfter(port, watch.applied.number, to);
  if (!blocks.ok) return blocks;
  const logs = await port.logs(watch.applied.number + 1n, to);
  if (!logs.ok) return logs;
  const prepared = prepare(watch, { head: head.value, blocks: blocks.value, logs: logs.value });
  return map(prepared, (batch): Range =>
    ({ head: head.value, to, blocks: blocks.value, logs: logs.value, prepared: batch }));
};

/** The bytes the node gave for the transactions the delivery needs, and the traces it answered. */
type Calldata = Readonly<{ wanted: readonly Bytes32[]; gathered: Gathered; traced: ReadonlySet<Bytes32> }>;

const asRead = (traced: Traced): Asked => {
  if (traced._tag === "no_method") return "no_method";
  return traced._tag === "calls" ? traced.calls.map(readOf) : undefined;
};

/**
 * The bytes a finalize or a start left: the input of its transaction, and when a wrapper hid the call there, the call
 * trace. What the Host kept from an earlier poll is not asked for again, and a transaction it asked at this very head
 * is not asked again either: a try is one per head block (R-WATCH-STALL).
 */
const calldataOf = async (
  port: WatchPort, batch: Prepared, hosted: Bytes32, carry: Carry, head: bigint,
): Promise<Calldata> => {
  const wanted = calldataWanted(batch, [hosted]);
  const waiting = (tx: Bytes32): boolean => carry.failing.get(tx)?.head === head;
  const fresh = wanted.filter((tx) => !carry.reads.has(tx) && !waiting(tx));
  const asked = await gather(fresh, async (tx) =>
    map(await port.input(tx), (i) => (i === undefined ? undefined : [readOf(i)])));
  const inputs = joined(asked, { ...NOTHING, failed: missingOf(fresh, asked) });
  const before = new Map(wanted.flatMap((tx) => {
    const known = carry.reads.get(tx);
    return known === undefined ? [] : [[tx, known.reads] as const];
  }));
  const withInputs = new Map([...before, ...inputs.found]);
  const unseen = new Set(fresh.filter((tx) => !asked.found.has(tx)));
  const unread = unreadTxs(withCalldata(batch, withInputs), [hosted])
    .filter((tx) => !unseen.has(tx) && !waiting(tx) && carry.reads.get(tx)?.traced !== true);
  const traces = unread.length === 0
    ? NOTHING
    : await gather(unread, async (tx) => map(await port.trace(tx), asRead));
  const gathered = joined({ ...NOTHING, found: withInputs, failed: inputs.failed }, traces);
  return { wanted, gathered, traced: new Set(unread.filter((tx) => !traces.failed.has(tx))) };
};

/** The Account a transaction's events are about, as the peer of the hosted Entity. */
const peerOfTx = (batch: Prepared, hosted: Bytes32, tx: Bytes32): Bytes32 | undefined =>
  batch.events.flatMap((e) =>
    ((e._tag === "dispute_started" || e._tag === "dispute_finalized") && e.tx === tx
      ? [peerOfEvent(hosted, e) ?? hosted]
      : [])).at(0);

/**
 * The tries of each transaction the node fails: one more for a transaction asked at this head and failed, and the same
 * for one not asked at this head (it waits for the next block). A transaction that is given is forgotten.
 */
const failingNow = (calldata: Calldata, carry: Carry, head: bigint): ReadonlyMap<Bytes32, Failing> =>
  new Map([
    ...[...carry.failing].filter(([tx]) => calldata.wanted.includes(tx) && carry.failing.get(tx)?.head === head),
    ...[...calldata.gathered.failed].map(([tx, fault]): readonly [Bytes32, Failing] =>
      [tx, { tries: (carry.failing.get(tx)?.tries ?? 0) + 1, head, fault }]),
  ]);

/**
 * R-WATCH-STALL: whether waiting on a transaction no longer helps. When the Entity has locks it forwarded to the peer
 * of the transaction's Account that a secret in it would let it claim, waiting helps until the view a delivery reaches
 * is past the last at which the Entity could still act on one (`lastHeard`): a node that fails for any reason, a 503
 * or a timeout among them, is waited for until then. When no lock depends on it, a few blocks are all it gets.
 */
const givenUp = (
  stand: Standing, to: bigint, peer: Bytes32 | undefined, failing: Failing,
): boolean => {
  const last = peer === undefined ? undefined : stand.lastHeard.get(peer);
  return last === undefined ? failing.tries >= FEW_TRIES : to > last;
};

/** The Accounts the events held back are about, each with the first block of its held events. */
const heldFrom = (hosted: Bytes32, held: readonly ChainEvent[]): ReadonlyMap<Bytes32, bigint> =>
  new Map(held.flatMap((e) => {
    const peer = peerOfEvent(hosted, e);
    return peer === undefined ? [] : [[peer, held.filter((o) => peerOfEvent(hosted, o) === peer)
      .reduce((first, o) => (o.block < first ? o.block : first), e.block)] as const];
  }));

/** What the Entity is told about the Accounts held back: the ones that begin being held, and the ones that are not. */
const behindTold = (
  hosted: Bytes32, was: ReadonlySet<string>, held: readonly ChainEvent[], stand: Standing, height: bigint,
): Result<Readonly<{ begun: readonly EntityInput[]; over: readonly EntityInput[] }>, BadPeer> => {
  const now = heldFrom(hosted, held);
  const begun = traverse([...now].filter(([peer]) => !was.has(peer)), ([peer, from]) =>
    map(peerOf({ peer }), (id): EntityInput => ({ _tag: "j_behind", peer: id, from })));
  const over = traverse([...was].filter((peer) => !now.has(peer as Bytes32) && height >= stand.view), (peer) =>
    map(peerOf({ peer: peer as Bytes32 }), (id): EntityInput => ({ _tag: "j_behind_over", peer: id })));
  return flatMap(begun, (b) => map(over, (o) => ({ begun: b, over: o })));
};

/**
 * The next delivery, or nothing when no block past the cursor is final yet. `hosted` is the Entity the node hosts, and
 * `windows` the dispute windows it waits on: each is told to it, once a delivery's last block is past its end.
 * A fault of the port is the node's to retry; a fault of the core is a local invariant broken (a reorg deeper than the
 * depth) and ends the node. A transaction the node cannot give holds back its Account's events (R-WATCH-STALL), not
 * the poll.
 */
export const poll = async (
  port: WatchPort, watch: Watch, hosted: Bytes32, windows: readonly Window[] = [], carry: Carry = NO_CARRY,
  stand: Standing = NO_STANDING,
): Promise<Result<Delivery | undefined, JFault>> => {
  const ranged = await rangeAt(port, watch);
  if (!ranged.ok) return ranged;
  const range = ranged.value;
  if (range === undefined) return ok(undefined);
  const batch = { ...range.prepared, events: [...carry.held, ...range.prepared.events] };
  const calldata = await calldataOf(port, batch, hosted, carry, range.head);
  const failing = failingNow(calldata, carry, range.head);
  const stalled = new Map([...failing].filter(([tx, f]) =>
    !givenUp(stand, range.to, peerOfTx(batch, hosted, tx), f)));
  const split = splitStalled(batch.events, new Set(stalled.keys()));
  const found = calldata.gathered.found;
  const read = withCalldata({ ...batch, events: split.ready }, found);
  const states = await Promise.all(readings(read, [hosted]).map(async (r) =>
    map(await port.accountAt(r.blockHash, r.left, r.right), (at) => [readingKey(r), at] as const)));
  const accounts = traverse(states, (answer) => answer);
  if (!accounts.ok) return accounts;
  const step = advance(watch, read, [hosted], new Map(accounts.value), windows);
  if (!step.ok) return step;
  const told = behindTold(hosted, new Set([...stand.behind, ...heldFrom(hosted, carry.held).keys()]), split.held,
    stand, step.value.height);
  if (!told.ok) return told;
  const events = traverse(step.value.events, ({ event }) => inputOf(event));
  if (!events.ok) return events;
  const heldTxs = new Set(split.held.flatMap((e) => ("tx" in e ? [e.tx] : [])));
  const reads = new Map(calldata.wanted.flatMap((tx) => {
    const got = found.get(tx);
    const traced = carry.reads.get(tx)?.traced === true || calldata.traced.has(tx);
    return got === undefined || !(heldTxs.has(tx) || stalled.has(tx)) ? [] : [[tx, { reads: got, traced }] as const];
  }));
  return ok({
    watch: step.value.watch, events: [...told.value.begun, ...events.value, ...told.value.over],
    height: step.value.height, carry: { failing: stalled, reads, held: split.held },
    stalls: [...stalled].map(([tx, f]): Stall => ({ tx, peer: peerOfTx(batch, hosted, tx) ?? hosted, ...f })),
    untraceable: calldata.gathered.noMethod.size > 0,
  });
};
