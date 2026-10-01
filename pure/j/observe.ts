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
import { err, map, ok, traverse, type Result } from "../kernel/core/result.ts";
import type { Of, Tagged } from "../kernel/core/tagged.ts";
import type { Side, TokenId } from "../account/model.ts";
import type { Bytes32, ChainEvent } from "./log.ts";

/**
 * The J events of the Entity cut's `JEvent`, less `j_op_lapsed`: whether a co-signed op can still land is the Entity's
 * to say from its own record of what it signed, and no log names an op.
 */
export type JEvent =
  | Tagged<"j_epoch", { peer: Bytes32; epoch: bigint; stored: bigint }>
  | Tagged<"j_dispute", { peer: Bytes32; epoch: bigint; by: Side }>
  | Tagged<"j_dispute_over", { peer: Bytes32 }>
  | Tagged<"j_collateral", { peer: Bytes32; token: TokenId; collateral: bigint; ondelta: bigint }>;

/** A J event for one hosted Entity. */
export type Addressed = Readonly<{ to: Bytes32; event: JEvent }>;

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

/** The Account of an event as (left, right): the smaller entity id is Left, as the contract's account key has it. */
const partiesOf = (e: ChainEvent): Parties => {
  const named = e._tag === "epoch_advanced" || e._tag === "account_settled";
  const [a, b] = named ? [e.left, e.right] : [e.sender, e.counter];
  return a < b ? [a, b] : [b, a];
};

const readingOf = (e: ChainEvent): Reading => {
  const [left, right] = partiesOf(e);
  return { block: e.block, blockHash: e.blockHash, left, right };
};

const sameAccount = (a: Reading, b: Reading): boolean =>
  a.block === b.block && a.blockHash === b.blockHash && a.left === b.left && a.right === b.right;

/** An epoch advance of the same Account, in the same block, logged after `e`. */
const advancedAfter = (events: readonly ChainEvent[], e: ChainEvent): number =>
  events.filter((o) => o._tag === "epoch_advanced" && sameAccount(readingOf(o), readingOf(e)) && o.index > e.index)
    .length;

const needsReading = (e: ChainEvent): boolean => e._tag === "epoch_advanced" || e._tag === "dispute_started";

const hostsAny = (hosted: readonly Bytes32[], e: ChainEvent): boolean => partiesOf(e).some((p) => hosted.includes(p));

/** The distinct readings the events of a delivery need for the hosted Entities, in event order. */
export const readingsOf = (events: readonly ChainEvent[], hosted: readonly Bytes32[]): readonly Reading[] => {
  const needed = events.filter((e) => needsReading(e) && hostsAny(hosted, e)).map(readingOf);
  return needed.filter((r, i) => needed.findIndex((o) => sameAccount(o, r)) === i);
};

const peerOf = (self: Bytes32, [left, right]: Parties): Bytes32 => (self === left ? right : left);

/** The epoch the chain was at when `e` was logged: the end-of-block reading, less the advances logged after it. */
const epochAt = (events: readonly ChainEvent[], e: ChainEvent, at: AccountAt): bigint =>
  at.epoch - BigInt(advancedAfter(events, e));

type Moved = Of<ChainEvent, "epoch_advanced">;
type Started = Of<ChainEvent, "dispute_started">;

const startedBy = (e: Started): Side => (e.sender < e.counter ? "left" : "right");

/** The chain's epoch moved: the Account's epoch and what it stores now. The reading must agree with the log. */
type Told = Result<readonly JEvent[], ObserveFault>;

const epochMoved = (events: readonly ChainEvent[], e: Moved, peer: Bytes32, at: AccountAt | undefined): Told => {
  const reading = readingOf(e);
  if (at === undefined) return err({ _tag: "no_reading", reading });
  const read = epochAt(events, e, at);
  return read === e.epoch
    ? ok([{ _tag: "j_epoch", peer, epoch: e.epoch, stored: at.nonce }])
    : err({ _tag: "reading_off", reading, logged: e.epoch, read });
};

const disputeStarted = (events: readonly ChainEvent[], e: Started, peer: Bytes32, at: AccountAt | undefined): Told =>
  (at === undefined
    ? err({ _tag: "no_reading", reading: readingOf(e) })
    : ok([{ _tag: "j_dispute", peer, epoch: epochAt(events, e, at), by: startedBy(e) }]));

/** What one event is to one hosted Entity that is a party to it, or nothing. */
const eventFor = (
  events: readonly ChainEvent[], e: ChainEvent, self: Bytes32, at: AccountAt | undefined,
): Told => {
  const peer = peerOf(self, partiesOf(e));
  switch (e._tag) {
    case "epoch_advanced": return epochMoved(events, e, peer, at);
    case "dispute_started": return disputeStarted(events, e, peer, at);
    case "dispute_countered": return ok(e.sender === self ? [{ _tag: "j_dispute_over", peer }] : []);
    case "dispute_finalized": return ok([{ _tag: "j_dispute_over", peer }]);
    case "account_settled": return ok(e.holdings.map((h): JEvent => ({ _tag: "j_collateral", peer, ...h })));
  }
};

type Hearer = Readonly<{ e: ChainEvent; to: Bytes32 }>;

/**
 * The J events of a delivery for the hosted Entities, in the chain's order: block, then log index, then Left before
 * Right when one log is about two hosted Entities. An Entity a log is not about hears nothing of it.
 */
export const observe = (
  events: readonly ChainEvent[], hosted: readonly Bytes32[], accounts: Accounts,
): Result<readonly Addressed[], ObserveFault> => {
  const hearers = events.flatMap((e): readonly Hearer[] =>
    partiesOf(e).filter((p) => hosted.includes(p)).map((to) => ({ e, to })));
  const told = ({ e, to }: Hearer) =>
    map(eventFor(events, e, to, accounts.get(readingKey(readingOf(e)))),
      (found) => found.map((event): Addressed => ({ to, event })));
  return map(traverse(hearers, told), (all) => all.flat());
};
