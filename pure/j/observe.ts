// What a chain event means for the Entities a Runtime hosts (R-J1, R-WATCH-ORDER). An Entity learns of the chain
// only through J events about its Accounts, one Account per peer: the epoch moved (and what the chain stores for the
// Account now), a dispute was started in an epoch by a side, a dispute is over. Which of these an event is depends on
// who the hosted Entity is: the same log is `j_dispute` for the entity that was disputed and nothing for the one that
// started it.
//
// `AccountSettled` is what the chain holds for an Account after an operation (a deposit, a withdrawal, a settlement):
// one `j_collateral` per token it lists, the amounts as they stand, so an Entity that hears one twice is where it was.
//
// Two facts are not in the logs and are read from the chain at the end of the event's block: the Account's stored nonce
// after an epoch moves (a finalized dispute stores a nonce no log names) and its epoch (`DisputeStarted` does not carry
// one). The epoch at an event is the end-of-block epoch less the epoch advances of that Account later in the block, so
// two events of one block still see their own epoch; the nonce is the end-of-block one.
//
// `SecretRevealed` is the one event that is about no Account: a payee showed a secret in a batch of its own. Every
// hosted Entity hears it as `j_secret`, and an Entity that forwarded a lock under its hash passes the secret up
// (R-DISPUTE-FREEZE: the payee behind a dispute cannot resolve in a frame, so the chain is where the hub learns it).
import { err, map, ok, traverse, type Result } from "../kernel/core/result.ts";
import type { Of, Tagged } from "../kernel/core/tagged.ts";
import type { Side, TokenId } from "../account/model.ts";
import type { Bytes32, ChainEvent } from "./log.ts";

/**
 * The J events of the Entity cut's `JEvent`, less `j_op_lapsed`: whether a co-signed op can still land is the Entity's
 * to say from its own record of what it signed, and no log names an op. `j_window_over` is no log's either: it is made
 * by the watcher from a block's time (j/watch.ts).
 */
export type JEvent =
  | Tagged<"j_epoch", { peer: Bytes32; epoch: bigint; stored: bigint; finalBodyHash?: Bytes32 }>
  | Tagged<
    "j_dispute",
    {
      peer: Bytes32; epoch: bigint; by: Side; nonce: bigint; timeout: bigint; proposerIsLeft: boolean;
      bodyHash: Bytes32;
    }
  >
  | Tagged<"j_countered", { peer: Bytes32; nonce: bigint; proposerIsLeft: boolean; bodyHash: Bytes32 }>
  | Tagged<"j_window_over", { peer: Bytes32 }>
  | Tagged<"j_dispute_over", { peer: Bytes32; late?: boolean }>
  | Tagged<"j_collateral", { peer: Bytes32; token: TokenId; collateral: bigint; ondelta: bigint }>
  | Tagged<"j_finalize_unread", { peer: Bytes32; tx: Bytes32 }>
  | Tagged<"j_start_unread", { peer: Bytes32; tx: Bytes32 }>;

/** A secret the chain showed: no peer, every hosted Entity hears it. */
export type Revealed = Tagged<"j_secret", { secret: Bytes32; at: bigint }>;

/** A J event for one hosted Entity. */
export type Addressed = Readonly<{ to: Bytes32; event: JEvent | Revealed }>;

/** What the chain stores for an Account after a block: its `ondeltaEpoch` and its `nonce`. */
export type AccountAt = Readonly<{ epoch: bigint; nonce: bigint }>;

/**
 * Which Account at the end of which block the chain is asked about: the block by its hash, so the Host asks the node
 * for that block (EIP-1898 with requireCanonical) and a block that is not on the chain is a node error, not a reading.
 * The node must still hold the state of that block: the Host reads while the block is inside the recent-state window a
 * node keeps (R-WATCH-WINDOW), and a node that no longer has it is the Host's fault naming the block.
 */
export type Reading = Readonly<{ block: bigint; blockHash: Bytes32; left: Bytes32; right: Bytes32 }>;

export const readingKey = (r: Reading): string => `${r.block}:${r.blockHash}:${r.left}:${r.right}`;

/** The readings of a delivery, by `readingKey`. */
export type Accounts = ReadonlyMap<string, AccountAt>;

export type ObserveFault =
  | Tagged<"no_reading", { reading: Reading }>
  | Tagged<"reading_off", { reading: Reading; logged: bigint; read: bigint }>;

type Parties = readonly [Bytes32, Bytes32];

/** The events that are about one Account: every one but a revealed secret. */
type Bound = Exclude<ChainEvent, { _tag: "secret_revealed" }>;

/** The Account of an event as (left, right): the smaller entity id is Left, as the contract's account key has it. */
const partiesOf = (e: Bound): Parties => {
  const named = e._tag === "epoch_advanced" || e._tag === "account_settled";
  const [a, b] = named ? [e.left, e.right] : [e.sender, e.counter];
  return a < b ? [a, b] : [b, a];
};

const readingOf = (e: Bound): Reading => {
  const [left, right] = partiesOf(e);
  return { block: e.block, blockHash: e.blockHash, left, right };
};

const sameAccount = (a: Reading, b: Reading): boolean =>
  a.block === b.block && a.blockHash === b.blockHash && a.left === b.left && a.right === b.right;

/** An epoch advance of the same Account, in the same block, logged after `e`. */
const advancedAfter = (events: readonly ChainEvent[], e: Bound): number =>
  events.filter((o) => o._tag === "epoch_advanced" && sameAccount(readingOf(o), readingOf(e)) && o.index > e.index)
    .length;

const needsReading = (e: ChainEvent): boolean => e._tag === "epoch_advanced" || e._tag === "dispute_started";

export const hostsAny = (hosted: readonly Bytes32[], e: Bound): boolean => partiesOf(e).some((p) => hosted.includes(p));

const isBound = (e: ChainEvent): e is Bound => e._tag !== "secret_revealed";

/** The party of an event's Account that is not `self`, or nothing when `self` is no party or the event has none. */
export const peerOfEvent = (self: Bytes32, e: ChainEvent): Bytes32 | undefined => {
  if (!isBound(e)) return undefined;
  const parties = partiesOf(e);
  return parties.includes(self) ? peerOf(self, parties) : undefined;
};

/** The distinct readings the events of a delivery need for the hosted Entities, in event order. */
export const readingsOf = (events: readonly ChainEvent[], hosted: readonly Bytes32[]): readonly Reading[] => {
  const needed = events.filter(isBound).filter((e) => needsReading(e) && hostsAny(hosted, e)).map(readingOf);
  return needed.filter((r, i) => needed.findIndex((o) => sameAccount(o, r)) === i);
};

const peerOf = (self: Bytes32, [left, right]: Parties): Bytes32 => (self === left ? right : left);

/** The epoch the chain was at when `e` was logged: the end-of-block reading, less the advances logged after it. */
const epochAt = (events: readonly ChainEvent[], e: Bound, at: AccountAt): bigint =>
  at.epoch - BigInt(advancedAfter(events, e));

type Moved = Of<ChainEvent, "epoch_advanced">;
type Started = Of<ChainEvent, "dispute_started">;
type Finalized = Of<ChainEvent, "dispute_finalized">;

const startedBy = (e: Started): Side => (e.sender < e.counter ? "left" : "right");

/** The chain's epoch moved: the Account's epoch and what it stores now. The reading must agree with the log. */
type Told = Result<readonly JEvent[], ObserveFault>;

/**
 * The hash of the proof body a dispute finalize paid by, when this epoch advance is the one the finalize made: the
 * finalize of the same Account logged next in the block, with no other advance of the Account between (the contract
 * advances the epoch, then logs the finalize). A settlement or a C2R has none.
 */
const finalOf = (events: readonly ChainEvent[], e: Moved): Finalized | undefined => {
  const same = (o: Bound) => sameAccount(readingOf(o), readingOf(e)) && o.index > e.index;
  const marks = ["dispute_finalized", "epoch_advanced"];
  const later = events.filter(isBound).filter((o) => same(o) && marks.includes(o._tag));
  const next = later.toSorted((a, b) => (a.index < b.index ? -1 : 1))[0];
  return next?._tag === "dispute_finalized" ? next : undefined;
};

const finalBodyOf = (events: readonly ChainEvent[], e: Moved): Bytes32 | undefined => finalOf(events, e)?.bodyHash;

const epochMoved = (events: readonly ChainEvent[], e: Moved, peer: Bytes32, at: AccountAt | undefined): Told => {
  const reading = readingOf(e);
  if (at === undefined) return err({ _tag: "no_reading", reading });
  const read = epochAt(events, e, at);
  const finalBodyHash = finalBodyOf(events, e);
  const final = finalBodyHash === undefined ? {} : { finalBodyHash };
  return read === e.epoch
    ? ok([{ _tag: "j_epoch", peer, epoch: e.epoch, stored: at.nonce, ...final }])
    : err({ _tag: "reading_off", reading, logged: e.epoch, read });
};

/**
 * A dispute against the hosted Entity whose opening state the Host could not read (neither the input of the
 * transaction nor a call trace of it) is told as unread after it: without the body the Entity cannot answer it by
 * finalizing, so the owner is told (R-WATCH-CALLDATA). A start of the Entity's own needs no body.
 */
const disputeStarted = (
  events: readonly ChainEvent[], e: Started, self: Bytes32, peer: Bytes32, at: AccountAt | undefined,
): Told => {
  if (at === undefined) return err({ _tag: "no_reading", reading: readingOf(e) });
  const started: JEvent = {
    _tag: "j_dispute", peer, epoch: epochAt(events, e, at), by: startedBy(e), nonce: e.nonce, timeout: e.timeout,
    proposerIsLeft: e.proposerIsLeft, bodyHash: e.bodyHash, ...(e.body === undefined ? {} : { body: e.body }),
  };
  return ok(e.unread && e.sender !== self ? [started, { _tag: "j_start_unread", peer, tx: e.tx }] : [started]);
};

/**
 * The dispute is over; and a finalize whose arguments the Host could not read says so (R-WATCH-CALLDATA). A `late`
 * one was held back for its arguments, so the Entity has heard what came after it already (R-WATCH-STALL).
 */
const finalizedTold = (e: Finalized, peer: Bytes32, late: ReadonlySet<ChainEvent>): readonly JEvent[] => {
  const over: JEvent = late.has(e) ? { _tag: "j_dispute_over", peer, late: true } : { _tag: "j_dispute_over", peer };
  return e.shown._tag === "unread" ? [over, { _tag: "j_finalize_unread", peer, tx: e.tx }] : [over];
};

/** What one event is to one hosted Entity that is a party to it, or nothing. */
const eventFor = (
  { context: events, late }: Beyond, e: Bound, self: Bytes32, at: AccountAt | undefined,
): Told => {
  const peer = peerOf(self, partiesOf(e));
  switch (e._tag) {
    case "epoch_advanced": return epochMoved(events, e, peer, at);
    case "dispute_started": return disputeStarted(events, e, self, peer, at);
    case "dispute_countered":
      return ok([
        { _tag: "j_countered", peer, nonce: e.nonce, proposerIsLeft: e.proposerIsLeft, bodyHash: e.bodyHash },
      ]);
    case "dispute_finalized": return ok(finalizedTold(e, peer, late));
    case "account_settled": return ok(e.holdings.map((h): JEvent => ({ _tag: "j_collateral", peer, ...h })));
  }
};

type Hearer = Readonly<{ e: ChainEvent; to: Bytes32 }>;

const hearersOf = (e: ChainEvent, hosted: readonly Bytes32[]): readonly Hearer[] =>
  (isBound(e) ? partiesOf(e).filter((p) => hosted.includes(p)) : hosted).map((to) => ({ e, to }));

const shownBy = (f: Finalized | undefined): readonly Bytes32[] => (f?.shown._tag === "read" ? f.shown.secrets : []);

/**
 * The secrets an event shows in dispute arguments, which no `SecretRevealed` carries (R-WATCH-CALLDATA): a start's two
 * blobs, and a finalize's. A finalize's are told ahead of the epoch advance the finalize made when that advance is in
 * the delivery, and ahead of the finalize itself when it is not (a finalize held back for its arguments comes after
 * its advance): either way before its `j_dispute_over`, the dissolve of the holds, so a lock this Entity forwarded is
 * claimed upstream before it is failed (R-HOLD-DISSOLVE).
 */
const secretsAt = (told: readonly ChainEvent[], { context }: Beyond, e: ChainEvent): readonly Bytes32[] => {
  const made = (o: ChainEvent) => o._tag === "epoch_advanced" && finalOf(context, o) === e;
  switch (e._tag) {
    case "dispute_started": return e.secrets;
    case "epoch_advanced": return shownBy(finalOf(context, e));
    case "dispute_finalized": return told.some(made) ? [] : shownBy(e);
    default: return [];
  }
};

/**
 * What a delivery knows beyond its own events: `context`, every event of the blocks it reads, the ones held back
 * included (a reading is of the end of a block, so an epoch is told less the advances logged after it, held or not),
 * and the `late` events, the finalizes held back for their arguments and told after the events that came behind them.
 */
export type Beyond = Readonly<{ context: readonly ChainEvent[]; late: ReadonlySet<ChainEvent> }>;

/**
 * The J events of a delivery for the hosted Entities, in the chain's order: block, then log index, then Left before
 * Right when one log is about two hosted Entities. An Entity a log is not about hears nothing of it; a revealed secret
 * is about none, and every hosted Entity hears it, as it hears the secrets dispute arguments show.
 */
export const observe = (
  events: readonly ChainEvent[], hosted: readonly Bytes32[], accounts: Accounts, beyond: Partial<Beyond> = {},
): Result<readonly Addressed[], ObserveFault> => {
  const known: Beyond = { context: events, late: new Set(), ...beyond };
  const told = ({ e, to }: Hearer): Result<readonly Addressed[], ObserveFault> =>
    (isBound(e)
      ? map(eventFor(known, e, to, accounts.get(readingKey(readingOf(e)))),
        (found) => found.map((event): Addressed => ({ to, event })))
      : ok([{ to, event: { _tag: "j_secret", secret: e.secret, at: e.block } }]));
  const hear = (secret: Bytes32, at: bigint): readonly Addressed[] =>
    hosted.map((to): Addressed => ({ to, event: { _tag: "j_secret", secret, at } }));
  const shown = (e: ChainEvent): readonly Addressed[] =>
    secretsAt(events, known, e).flatMap((secret) => hear(secret, e.block));
  return map(
    traverse(events, (e) => map(traverse(hearersOf(e, hosted), told), (all) => [...shown(e), ...all.flat()])),
    (all) => all.flat(),
  );
};
