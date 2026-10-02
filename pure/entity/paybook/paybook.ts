// The paybook (R-HTLC-FORWARD): what an Entity does about an HTLC that passes through it, decided from its own
// committed Accounts and nothing else. A hub that holds a lock from `from` for a hashlock it has an entry for locks the
// same amount on `to` with a deadline one hop sooner; when `to` shows the secret, it shows it to `from`; when `to`
// gives the lock up, it gives `from`'s up. A payee resolves the lock of a payment it asked for. Every step is a tx of
// an Account's next frame, so it is signed, acked and refused like any other; this file only says which.
import { mapDelete, mapSet } from "../../kernel/core/collections.ts";
import { keccakHex } from "../../kernel/encoding/bytes.ts";
import { jHeight, type ClockParams, type JHeight, type JView } from "../../account/clause/clock.ts";
import { other, type Hold, type HoldId, type TokenId } from "../../account/model.ts";
import { openHolds } from "../../account/state.ts";
import type { AccountTx } from "../../account/tx.ts";
import type { Of } from "../../kernel/core/tagged.ts";
import { traverse } from "../../kernel/core/result.ts";
import {
  entityId, sideOf, type AccountCommand, type Entry, type EntityId, type EntityState, type Paybook,
} from "../model.ts";

/** A hop's deadline is earlier than the hop before it by what its payee needs to learn the secret and pass it on. */
export const hopOf = (clock: ClockParams): bigint => clock.reserve + clock.lag;

/** One step the paybook asks of an Account's door, and the entry that stands after it is admitted or refused. */
export type Intent = Readonly<{
  hashlock: string; command: AccountCommand; admitted: Entry | undefined; refused: Entry | undefined;
}>;

type Clause = Readonly<{ token: TokenId; hold: Hold }>;

/** The open clause of an Account that holds `hashlock`, with its token. */
const clauseIn = (state: EntityState, peer: EntityId, hashlock: string): Clause | undefined =>
  [...(state.accounts.get(peer)?.state.ledgers ?? [])].flatMap(([token, l]) =>
    l.holds.filter((hold) => hold.hashlock === hashlock).map((hold): Clause => ({ token, hold })))[0];

/** A lock `peer` made to me: its payer is the peer's side of our Account. */
const incoming = (state: EntityState, peer: EntityId, hashlock: string): Clause | undefined => {
  const clause = clauseIn(state, peer, hashlock);
  return clause?.hold.payer === other(sideOf(state.id, peer)) ? clause : undefined;
};

/** A slot of `peer`'s Account above every open hold's and every queued lock's, whatever the token. */
const freeSlot = (state: EntityState, peer: EntityId): HoldId => {
  const account = state.accounts.get(peer);
  const queued = [...(account?.pending?.frame.txs ?? []), ...(account?.mempool ?? [])];
  const taken = [
    ...(account === undefined ? [] : openHolds(account.state).map((h) => h.id)),
    ...queued.flatMap((tx: AccountTx) => (tx._tag === "lock" ? [tx.hold.id] : [])),
  ];
  return (taken.reduce((top, id) => (id > top ? id : top), 0n) + 1n) as HoldId;
};

const cancelUp = (from: EntityId, hashlock: string, c: Clause): Intent => ({
  hashlock, command: { _tag: "cancel", peer: from, token: c.token, id: c.hold.id },
  admitted: undefined, refused: undefined,
});

const resolveUp = (from: EntityId, hashlock: string, c: Clause, secret: Uint8Array): Intent =>
  ({
    hashlock, command: { _tag: "resolve", peer: from, token: c.token, id: c.hold.id, secret },
    admitted: undefined, refused: undefined,
  });

const nextDeadline = (clock: ClockParams, view: JView, hold: Hold): JHeight | undefined => {
  const sooner = jHeight(hold.deadline - hopOf(clock));
  return sooner.ok && sooner.value > view ? sooner.value : undefined;
};

/** A forward whose lock is in: the same amount and hashlock on the next hop, one hop sooner, or the lock given up. */
type Forward = Of<Entry, "forward">;
type Receive = Of<Entry, "receive">;

const forwardOf = (
  state: EntityState, clock: ClockParams, view: JView, hashlock: string, e: Forward,
): Intent | undefined => {
  const c = incoming(state, e.from, hashlock);
  if (c === undefined) return undefined;
  const deadline = nextDeadline(clock, view, c.hold);
  if (deadline === undefined || !state.accounts.has(e.to) || e.to === e.from) return cancelUp(e.from, hashlock, c);
  const id = freeSlot(state, e.to);
  const hold: Hold = { id, payer: sideOf(state.id, e.to), amount: c.hold.amount, hashlock, deadline };
  return {
    hashlock, command: e.route.length === 0
      ? { _tag: "lock", peer: e.to, token: c.token, hold }
      : { _tag: "lock", peer: e.to, token: c.token, hold, route: e.route },
    admitted: { _tag: "locked", from: e.from, to: e.to, token: c.token, id }, refused: { _tag: "fail", from: e.from },
  };
};

/** A payee's resolve of the lock it asked for, or its refusal if the lock is not for what was asked. */
const receiveOf = (state: EntityState, hashlock: string, e: Receive): Intent | undefined => {
  const c = incoming(state, e.from, hashlock);
  if (c === undefined) return undefined;
  return c.token === e.token && c.hold.amount >= e.amount ? resolveUp(e.from, hashlock, c, e.secret)
    : cancelUp(e.from, hashlock, c);
};

const intentOf = (state: EntityState, clock: ClockParams, view: JView, hashlock: string, e: Entry):
  Intent | undefined => {
  switch (e._tag) {
    case "forward":
      return forwardOf(state, clock, view, hashlock, e);
    case "receive":
      return receiveOf(state, hashlock, e);
    case "pass": {
      const c = incoming(state, e.from, hashlock);
      return c === undefined ? undefined : resolveUp(e.from, hashlock, c, e.secret);
    }
    case "fail": {
      const c = incoming(state, e.from, hashlock);
      return c === undefined ? undefined : cancelUp(e.from, hashlock, c);
    }
    case "locked":
      return undefined;
  }
};

/** The hashlocks the paybook has an entry for, in order. */
export const hashlocksOf = (state: EntityState): readonly string[] => [...state.paybook.keys()].toSorted();

/** What the paybook asks of the Accounts now for one hashlock, judged on the state as it stands. */
export const intentFor = (
  state: EntityState, clock: ClockParams, view: JView, hashlock: string,
): Intent | undefined => {
  const entry = state.paybook.get(hashlock);
  return entry === undefined ? undefined : intentOf(state, clock, view, hashlock, entry);
};

/** An entry in place of the one for `hashlock`, or none. */
export const withEntry = (book: Paybook, hashlock: string, entry: Entry | undefined): Paybook => {
  return entry === undefined ? mapDelete(book, hashlock) : mapSet(book, hashlock, entry);
};

/**
 * A lock that names a route is the entry for its hashlock, unless the Entity has one already: the first of the route
 * is the next hop. A route with an id that is not one is no route.
 */
const routedBy = (book: Paybook, peer: EntityId, tx: Extract<AccountTx, { _tag: "lock" }>): Paybook => {
  const ids = traverse(tx.route ?? [], entityId);
  const [to, ...route] = ids.ok ? ids.value : [];
  return to === undefined || book.has(tx.hold.hashlock)
    ? book : withEntry(book, tx.hold.hashlock, { _tag: "forward", from: peer, to, route });
};

/**
 * A secret shows itself by its hash: whoever it came from (a resolve in a frame the Entity refused, or a reveal on the
 * chain) and whichever Account it came by, it opens the lock the Entity forwarded under that hashlock, so the secret is
 * passed up to the one that locked to this Entity (R-DISPUTE-FREEZE: a payee behind a dispute cannot resolve in a frame).
 */
export const revealed = (book: Paybook, secret: Uint8Array): Paybook => {
  const hashlock = keccakHex(secret);
  const entry = book.get(hashlock);
  return entry?._tag === "locked" ? withEntry(book, hashlock, { _tag: "pass", from: entry.from, secret }) : book;
};

/** The secrets of the resolves in a frame the Entity did not take: each one is revealed all the same. */
export const revealedBy = (book: Paybook, txs: readonly AccountTx[]): Paybook =>
  txs.reduce((acc, tx) => (tx._tag === "resolve" ? revealed(acc, tx.secret) : acc), book);

/**
 * What a frame the Entity accepted from `peer` tells the paybook: a lock with a route is an entry, a resolve is the
 * secret to pass up, a cancel is a failure.
 */
export const learned = (book: Paybook, peer: EntityId, txs: readonly AccountTx[]): Paybook =>
  txs.reduce((acc, tx) => {
    if (tx._tag === "lock") return routedBy(acc, peer, tx);
    if (tx._tag === "resolve") {
      const entry = acc.get(keccakHex(tx.secret));
      return entry?._tag === "locked" && entry.to === peer ? revealed(acc, tx.secret) : acc;
    }
    if (tx._tag !== "cancel") return acc;
    const found = [...acc].find(([, e]) =>
      e._tag === "locked" && e.to === peer && e.token === tx.token && e.id === tx.id);
    return found === undefined || found[1]._tag !== "locked"
      ? acc : withEntry(acc, found[0], { _tag: "fail", from: found[1].from });
  }, book);
