// The J loop's one poll (R-WATCH-ORDER, R-WATCH-DEPTH, R-WATCH-TELL; plan D9): what the chain says beyond the cursor,
// at depth, as the J events of the Entity this node hosts and the height they end at. It reads blocks and logs through
// a port and hands them to the watcher core (j/watch.ts), which checks them: a block that does not follow the cursor, a
// log that does not belong to its block, a reading that contradicts a log. The cursor lives in the node's memory and is
// moved by the caller only after effects, pending payloads and height share a durable observation (R-HEIGHT-ORDER).
// A restart uses the WAL's view to exclude applied ordinary facts, and resumes only recorded unresolved payloads.
//
// A dispute finalize whose bytes the node cannot read (R-WATCH-STALL) holds back the events of its own Account from its
// first event on, and nothing else: the other Accounts and every revealed secret go on at once. A dispute start holds
// nothing back: the Entity is told it, with its window and its secrets (all in the log), at once, and its body when the
// bytes come (the start waits in the Carry's `reading` until then). The held events wait in the Host's `Carry`, the
// Entity is told which block the Host owes it from (`j_behind`: the record a restart reads the cursor back from), and
// they are told when the transaction can be read, or when waiting no longer helps.
import type { JHeight } from "../../../account/clause/clock.ts";
import type { ChainFacts, EntityId, EntityInput } from "../../../entity/model.ts";
import { entityId } from "../../../entity/model.ts";
import { readOf, type Carried, type Read } from "../../../j/calldata/decode.ts";
import {
  peerOfEvent, readingKey, rememberEpoch, type AccountAt, type Accounts, type Addressed,
} from "../../../j/observe.ts";
import type { ReadWait } from "../../../j/log.ts";
import { hexToBytes } from "../../../kernel/encoding/bytes.ts";
import { bytes32, type Bytes32, type ChainEvent, type Deployed, type RawLog } from "../../../j/log.ts";
import {
  advance, calldataWanted, finalizedAt, needsBytes, prepare, readings, splitStalled, unreadTxs, watching, withCalldata,
  type Block, type Prepared, type Watch, type WatchFault, type Window,
} from "../../../j/watch.ts";
import { mapSet } from "../../../kernel/core/collections.ts";
import { err, flatMap, map, ok, traverse, type Result } from "../../../kernel/core/result.ts";
import type { Tagged } from "../../../kernel/core/tagged.ts";
import type { PortFault } from "../submit/chain.ts";

/** What the node's call trace said of a transaction (R-WATCH-CALLDATA). */
export type Traced =
  | Tagged<"calls", { calls: readonly Carried[] }>
  | Tagged<"unreadable">
  | Tagged<"no_method">;

/** What the probe found: the node traces calls, it does not, or the block holds no transaction to tell by. */
export type Probe = "traces" | "none" | "no_transaction";

/** What the loop asks of the chain: the head, a block by number, the Depository's logs in a range, an Account's row. */
export type WatchPort = Readonly<{
  head: () => Promise<Result<bigint, PortFault>>;
  block: (number: bigint) => Promise<Result<Block, PortFault>>;
  logs: (from: bigint, to: bigint) => Promise<Result<readonly RawLog[], PortFault>>;
  /**
   * The Account's `ondeltaEpoch` and stored nonce at the end of the block with this hash, or `pruned` when the node no
   * longer serves the state of that block (its recent-state window has passed): an answer about this Account's past,
   * not a fault of the node's reads.
   */
  accountAt: (block: Bytes32, left: Bytes32, right: Bytes32) => Promise<Result<AccountAt | "pruned", PortFault>>;
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
  /**
   * Whether the node answers `debug_traceTransaction` with the callTracer, asked of the first transaction of block `at`
   * (the newest block, at each new head, while a node that may hold value has not been shown a trace this run).
   */
  traced: (at: bigint) => Promise<Result<Probe, PortFault>>;
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
 * events wait, and the events themselves, in the chain's order, as the chain logged them (not yet read with the bytes),
 * and the readings of the Accounts those events need, taken when the events were first seen (R-WATCH-WINDOW): a hold
 * longer than the node's recent-state window asks it about no old block.
 */
export type Carry = Readonly<{
  failing: ReadonlyMap<Bytes32, Failing>; reads: ReadonlyMap<Bytes32, Known>; held: readonly ChainEvent[];
  /** Dispute starts against the Entity, told already without their body, until the bytes come or the window ends. */
  reading: readonly ChainEvent[];
  readings: Accounts;
}>;

export const NO_CARRY: Carry = { failing: new Map(), reads: new Map(), held: [], reading: [], readings: new Map() };

/**
 * What the loop needs to know of the Entity to wait for it: for each peer the last view at which hearing a secret of
 * a dispute transaction of that Account still lets the Entity claim upstream (`lastHeard`, from its outstanding
 * forwards: a peer with none is not in the map), the peers it was told are behind, the peers whose past it can no
 * longer read (`lost`: their events are neither read nor told again), and the view it is at.
 */
export type Standing = Readonly<{
  lastHeard: ReadonlyMap<string, bigint>; behind: ReadonlySet<string>; lost: ReadonlySet<string>; view: bigint;
  pending?: ReadonlyMap<string, readonly ReadWait[]>;
}>;

export const NO_STANDING: Standing = { lastHeard: new Map(), behind: new Set(), lost: new Set(), view: 0n };

/** A transaction a delivery waits on, and the Account it holds back. */
export type Stall = Readonly<{ tx: Bytes32; peer: Bytes32; fault: PortFault; tries: number }>;

/**
 * One delivery: the J events for the node's Entity, in the chain's order, and then the height they end at, with what
 * the Host carries on, the transactions it still waits on, and whether the provider said it has no call trace.
 */
export type Delivery = Readonly<{
  watch: Watch; events: readonly EntityInput[]; height: JHeight; carry: Carry; stalls: readonly Stall[];
  untraceable: boolean;
  /** The second of the block at `height`, from its header; and how many final blocks the poll found undelivered. */
  seconds: bigint; unread: bigint;
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
  return bytes.ok
    ? ok({ _tag: "j_secret", secret: bytes.value, at: event.at })
    : err({ _tag: "bad_secret", text: event.secret });
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
 * the Host holds back for any Account (`j_behind`), if that is before the view the WAL holds. An Account lost is
 * not read again, so it holds nothing back.
 */
export const resumeAt = (view: bigint, chain: ReadonlyMap<EntityId, ChainFacts>): bigint =>
  [...chain.values()].flatMap((facts) => (facts.behind === undefined || facts.lost ? [] : [facts.behind - 1n]))
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
 * R-WATCH-STALL: whether waiting for the bytes of one event's transaction no longer helps, decided for the event's own
 * Account. A finalize's secrets let the Entity claim upstream only while it can still act on one: waiting helps until
 * the view a delivery reaches is past the last at which it could (`lastHeard`, the latest over the locks it forwarded
 * to the peer: a secret may pay any of them) and at least FEW_TRIES blocks have been tried, whatever the node answers;
 * when no lock depends on it, FEW_TRIES blocks are all it gets. A start's body is needed to answer the dispute while
 * its window runs, which is the chain's own second: it is given up once the delivery's last block is past its end.
 */
const givenUp = (stand: Standing, last: Block, hosted: Bytes32, e: ChainEvent, failing: Failing): boolean => {
  if (e._tag === "dispute_started") return last.timestamp >= e.timeout;
  const peer = peerOfEvent(hosted, e);
  const heard = peer === undefined ? undefined : stand.lastHeard.get(peer);
  return failing.tries >= FEW_TRIES && (heard === undefined || last.number >= heard);
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
 * What a poll's events come to once the node has answered for the transactions: `context` is every event the poll
 * sees, with the bytes the node gave read into it (a start still waiting for its bytes is as the log has it, body-less
 * and not unread), `ready` the ones told now (`late` those of them a poll held back before), the finalizes held back
 * and nothing else, the starts still reading, and the transactions that are still waited on, each with the peer of the
 * Account it waits for. A start already told while it was waiting is not told again until it is read or given up.
 */
type Plan = Readonly<{
  ready: Prepared; context: readonly ChainEvent[]; late: ReadonlySet<ChainEvent>;
  held: readonly ChainEvent[]; reading: readonly ChainEvent[];
  stalled: ReadonlyMap<Bytes32, Failing>; peers: ReadonlyMap<Bytes32, Bytes32>;
}>;

/** A later dissolve cannot discard locks whose secret an earlier finalize of the same Account still owes. */
const afterUnread = (
  events: readonly ChainEvent[], awaited: (e: ChainEvent) => boolean, hosted: Bytes32, e: ChainEvent,
): boolean => e._tag === "dispute_finalized" && events.some((prior) =>
  prior._tag === "dispute_finalized" && awaited(prior) && peerOfEvent(hosted, prior) === peerOfEvent(hosted, e)
  && (prior.block < e.block || (prior.block === e.block && prior.index < e.index)));

const planned = (
  batch: Prepared, carry: Carry, failing: ReadonlyMap<Bytes32, Failing>, found: ReadonlyMap<Bytes32, readonly Read[]>,
  stand: Standing, hosted: Bytes32,
): Plan => {
  const awaited = (e: ChainEvent): boolean => {
    const f = "tx" in e ? failing.get(e.tx) : undefined;
    return f !== undefined && needsBytes(e, [hosted]) && !givenUp(stand, batch.last, hosted, e, f);
  };
  const pending = (e: ChainEvent): boolean => e._tag === "dispute_started" && awaited(e);
  const withBytes = withCalldata(batch, found).events;
  const context = batch.events.map((e, i) => (pending(e) ? e : (withBytes[i] ?? e)));
  const stays = batch.events.map((e) => carry.reading.some((old) => eventKey(old) === eventKey(e)) && pending(e));
  const told = context.filter((_, i) => !stays[i]);
  const split = splitStalled(told, (e) => awaited(e) || afterUnread(batch.events, awaited, hosted, e));
  const waiting = batch.events.filter(awaited);
  return {
    ready: { ...batch, events: split.ready }, context, held: split.held, reading: context.filter(pending),
    late: new Set(batch.events.flatMap((e, i) =>
      (carry.held.some((old) => eventKey(old) === eventKey(e)) || (covered(stand) && e.block <= stand.view)
        ? [context[i] ?? e] : []))),
    stalled: new Map([...failing].filter(([tx]) => waiting.some((e) => "tx" in e && e.tx === tx))),
    peers: new Map(waiting.flatMap((e) => {
      const peer = peerOfEvent(hosted, e);
      return "tx" in e && peer !== undefined ? [[e.tx, peer] as const] : [];
    })),
  };
};

const byPlace = (a: ChainEvent, b: ChainEvent): number =>
  (a.block === b.block ? Number(a.index - b.index) : Number(a.block - b.block));

const eventKey = (e: ChainEvent): string => `${e.blockHash}:${e.index}:${e._tag}`;

/** Older WALs without payload identities keep the archive-read path until a delivery records them. */
const covered = (stand: Standing): boolean => stand.pending !== undefined
  && [...stand.behind].every((peer) => stand.lost.has(peer) || stand.pending?.has(peer));

const owedEvents = (events: readonly ChainEvent[], carry: Carry, stand: Standing): readonly ChainEvent[] => {
  const saved = [...(stand.pending?.values() ?? [])].flat();
  const fresh = covered(stand) ? events.filter((e) => e.block > stand.view) : events;
  return [...new Map([...carry.held, ...carry.reading, ...saved, ...fresh].map((e) => [eventKey(e), e])).values()]
    .toSorted(byPlace);
};

const isWait = (e: ChainEvent): e is ReadWait => e._tag === "dispute_started" || e._tag === "dispute_finalized";

const waitKey = (e: ReadWait): string => `${eventKey(e)}:${e._tag === "dispute_started" ? e.epoch : e.shown._tag}`;

/** Applied after payload effects and before releasing behind, in the same atomic delivery as its height. */
const waitInputs = (
  hosted: Bytes32, stand: Standing, events: readonly ChainEvent[], context: readonly ChainEvent[], accounts: Accounts,
): Result<readonly EntityInput[], BadPeer> => {
  if (stand.pending === undefined) return ok([]);
  const waits = events.map((e) => rememberEpoch(e, context, accounts)).filter(isWait);
  const peers = new Set([...stand.pending.keys(), ...waits.flatMap((e) => peerOfEvent(hosted, e) ?? [])]);
  const changed = [...peers].flatMap((peer) => {
    const pending = waits.filter((e) => peerOfEvent(hosted, e) === peer);
    const old = stand.pending?.get(peer) ?? [];
    return old.map(waitKey).join("|") === pending.map(waitKey).join("|") ? [] : [{ peer, pending }];
  });
  return traverse(changed, ({ peer, pending }) =>
    map(peerOf({ peer: peer as Bytes32 }), (id): EntityInput => ({ _tag: "j_read_waits", peer: id, pending })));
};

/** Whether the Host owes the Entity nothing of an event: it is about an Account whose past it can no longer read. */
const gone = (hosted: Bytes32, lost: ReadonlyMap<Bytes32, bigint>, e: ChainEvent): boolean => {
  const peer = peerOfEvent(hosted, e);
  const from = peer === undefined ? undefined : lost.get(peer);
  return from !== undefined && e.block >= from;
};

/** What the node's state says of the Accounts a poll's events need, and the Accounts whose state it no longer has. */
type Seen = Readonly<{ accounts: Accounts; lost: ReadonlyMap<Bytes32, bigint> }>;

/**
 * R-WATCH-WINDOW: each Account an event needs is read when the event is first seen, whether the event is told now or
 * held, and the readings travel with the held events (`Carry.readings`): nothing asks the node about an old block.
 * A reading the node answers as pruned loses its own Account, from the first block it was needed at (`lost`); a
 * fault of the node's reads is the poll's to try again.
 */
const seen = async (
  port: WatchPort, hosted: Bytes32, batch: Prepared, carried: Accounts,
): Promise<Result<Seen, PortFault>> => {
  const fresh = readings(batch, [hosted]).filter((r) => !carried.has(readingKey(r)));
  const answers = traverse(await Promise.all(fresh.map(async (r) =>
    map(await port.accountAt(r.blockHash, r.left, r.right), (at) => [r, at] as const))), (answer) => answer);
  if (!answers.ok) return answers;
  const read = answers.value.flatMap(([r, at]) => (at === "pruned" ? [] : [[readingKey(r), at] as const]));
  const lost = answers.value.flatMap(([r, at]) =>
    (at === "pruned" ? [[r.left === hosted ? r.right : r.left, r.block] as const] : []));
  const earliest = lost.reduce<ReadonlyMap<Bytes32, bigint>>((first, [peer, block]) => {
    const was = first.get(peer);
    return was !== undefined && was <= block ? first : mapSet(first, peer, block);
  }, new Map());
  return ok({ accounts: new Map([...carried, ...read]), lost: earliest });
};

/** The Entity is told of each Account lost, ahead of the rest of the delivery. */
const lostTold = (lost: ReadonlyMap<Bytes32, bigint>): Result<readonly EntityInput[], BadPeer> =>
  traverse([...lost], ([peer, from]) =>
    map(peerOf({ peer }), (id): EntityInput => ({ _tag: "j_account_lost", peer: id, from })));

/**
 * The next delivery, or nothing when no block past the cursor is final yet. `hosted` is the Entity the node hosts, and
 * `windows` the dispute windows it waits on: each is told to it, once a delivery's last block is past its end.
 * A fault of the port is the node's to retry; a fault of the core is a local invariant broken (a reorg deeper than the
 * depth) and ends the node. A transaction the node cannot give holds back its Account's events (R-WATCH-STALL), not
 * the poll; an Account the node can no longer read is lost, and no other is held for it.
 */
export const poll = async (
  port: WatchPort, watch: Watch, hosted: Bytes32, windows: readonly Window[] = [], carry: Carry = NO_CARRY,
  stand: Standing = NO_STANDING,
): Promise<Result<Delivery | undefined, JFault>> => {
  const ranged = await rangeAt(port, watch);
  if (!ranged.ok) return ranged;
  const range = ranged.value;
  if (range === undefined) return ok(undefined);
  const owed = owedEvents(range.prepared.events, carry, stand);
  const standing = new Map([...stand.lost].map((peer): readonly [Bytes32, bigint] => [peer as Bytes32, 0n]));
  const live = { ...range.prepared, events: owed.filter((e) => !gone(hosted, standing, e)) };
  const known = await seen(port, hosted, live, carry.readings);
  if (!known.ok) return known;
  const { accounts, lost } = known.value;
  const batch = { ...live, events: live.events.filter((e) => !gone(hosted, lost, e)) };
  const calldata = await calldataOf(port, batch, hosted, carry, range.head);
  const failing = failingNow(calldata, carry, range.head);
  const plan = planned(batch, carry, failing, calldata.gathered.found, stand, hosted);
  const remembered = waitInputs(hosted, stand, [...plan.held, ...plan.reading], plan.context, accounts);
  if (!remembered.ok) return remembered;
  const step = advance(watch, plan.ready, [hosted], accounts, windows, { context: plan.context, late: plan.late });
  if (!step.ok) return step;
  const behind = new Set([...stand.behind, ...heldFrom(hosted, [...carry.held, ...carry.reading]).keys()]);
  const told = behindTold(hosted, behind, [...plan.held, ...plan.reading], stand, step.value.height);
  if (!told.ok) return told;
  const gave = lostTold(lost);
  if (!gave.ok) return gave;
  const events = traverse(step.value.events, ({ event }) => inputOf(event));
  if (!events.ok) return events;
  const { stalled } = plan;
  const kept = new Set([...plan.held, ...plan.reading].flatMap((e) => ("tx" in e ? [e.tx] : [])));
  const found = calldata.gathered.found;
  const reads = new Map(calldata.wanted.flatMap((tx) => {
    const got = found.get(tx);
    const traced = carry.reads.get(tx)?.traced === true || calldata.traced.has(tx);
    return got === undefined || !(kept.has(tx) || stalled.has(tx)) ? [] : [[tx, { reads: got, traced }] as const];
  }));
  const carried = readings({ ...batch, events: [...plan.held, ...plan.reading] }, [hosted]).flatMap((r) => {
    const at = accounts.get(readingKey(r));
    return at === undefined ? [] : [[readingKey(r), at] as const];
  });
  return ok({
    watch: step.value.watch,
    events: [...gave.value, ...told.value.begun, ...events.value, ...remembered.value, ...told.value.over],
    height: step.value.height,
    seconds: step.value.watch.applied.timestamp,
    unread: finalizedAt(watch.depth, range.head) - watch.applied.number,
    carry: { failing: stalled, reads, held: plan.held, reading: plan.reading, readings: new Map(carried) },
    stalls: [...stalled].map(([tx, f]): Stall => ({ tx, peer: plan.peers.get(tx) ?? hosted, ...f })),
    untraceable: calldata.gathered.noMethod.size > 0,
  });
};
