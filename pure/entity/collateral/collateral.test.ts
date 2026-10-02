// What the chain holds for an Account reaches its ledgers (R-J-COLLATERAL) and never changes which tokens it has
// (R-J-COLLATERAL-NO-LEDGER): two Entities that exchange every message they send, one hearing the chain first.
import { describe, expect, test } from "bun:test";
import { tokenOf, viewOf } from "../../account/fixtures.ts";
import { ledgerOf } from "../../account/state.ts";
import { anchor, entityOf, GOLD, judge, open } from "../fixtures.ts";
import { entityFrame } from "../frame.ts";
import {
  emptyEntity, type Command, type EntityId, type EntityInput, type EntityState, type JEvent, type Notice, type Outbound,
} from "../model.ts";

const ALICE = entityOf(1);
const BOB = entityOf(2);
const OIL = tokenOf(2n);

type Who = "alice" | "bob";
type Pair = Readonly<{ alice: EntityState; bob: EntityState }>;

const PEER: Readonly<Record<Who, EntityId>> = { alice: BOB, bob: ALICE };
const OTHER: Readonly<Record<Who, Who>> = { alice: "bob", bob: "alice" };

const runAt = (state: EntityState, inputs: readonly EntityInput[]) =>
  entityFrame({ ...judge, view: viewOf(100n) }, anchor, state, inputs);

const heard = (outs: readonly Outbound[]): readonly EntityInput[] =>
  outs.map((o): EntityInput => ({ _tag: "peer_message", from: o.from, msg: o.msg }));

/** What one side sends, delivered to the other, and what that sends back, until nothing is on its way. */
const drain = (p: Pair, outs: readonly Outbound[], from: Who): Pair => {
  if (outs.length === 0) return p;
  const to = OTHER[from];
  const framed = runAt(p[to], heard(outs));
  return drain({ ...p, [to]: framed.state }, framed.outputs, to);
};

const say = (p: Pair, who: Who, ...inputs: readonly EntityInput[]): Pair => {
  const framed = runAt(p[who], inputs);
  return drain({ ...p, [who]: framed.state }, framed.outputs, who);
};

const held = (peer: EntityId, token = GOLD, collateral = 100n, ondelta = 100n): JEvent =>
  ({ _tag: "j_collateral", peer, token, collateral, ondelta });

const credit = (peer: EntityId, limit: bigint, token = GOLD): Command => ({ _tag: "set_credit", peer, token, limit });
const pay = (peer: EntityId, amount: bigint): Command => ({ _tag: "pay", peer, token: GOLD, amount });

/** Alice and Bob with an Account that has a GOLD ledger on both sides: each has set a credit. */
const base = (): Pair => {
  const start: Pair = { alice: emptyEntity(ALICE), bob: emptyEntity(BOB) };
  const opened = say(say(start, "alice", open(BOB)), "bob", open(ALICE));
  return say(say(opened, "alice", credit(BOB, 100n)), "bob", credit(ALICE, 100n));
};

const account = (p: Pair, who: Who) => p[who].accounts.get(PEER[who]);
const ledgers = (p: Pair, who: Who) => [...(account(p, who)?.state.ledgers.keys() ?? [])];
const heads = (p: Pair) => [account(p, "alice")?.head, account(p, "bob")?.head];
const pending = (p: Pair) => [account(p, "alice")?.pending !== undefined, account(p, "bob")?.pending !== undefined];
const ledgerOfToken = (p: Pair, who: Who, token = GOLD) => {
  const a = account(p, who);
  return a === undefined ? undefined : ledgerOf(a.state, token);
};

describe("entity/frame what the chain holds for an Account's tokens (R-J-COLLATERAL)", () => {
  test("R-J-COLLATERAL the chain's collateral and ondelta are set as they stand; a repeat changes nothing", () => {
    const first = say(base(), "alice", held(BOB));
    expect(ledgerOfToken(first, "alice")).toMatchObject({ collateral: 100n, ondelta: 100n, offdelta: 0n });
    expect(say(first, "alice", held(BOB)).alice).toEqual(first.alice);
    const lower = say(first, "alice", held(BOB, GOLD, 90n, -5n));
    expect(ledgerOfToken(lower, "alice")).toMatchObject({ collateral: 90n, ondelta: -5n });
  });

  test("R-J-COLLATERAL the credit and holds of the ledger stay as they were", () => {
    const settled = say(base(), "alice", held(BOB));
    expect(ledgerOfToken(settled, "alice")).toMatchObject({ limit: { left: 100n, right: 100n }, offdelta: 0n });
    expect(ledgerOfToken(settled, "alice")?.holds).toEqual([]);
  });

  test("R-J-COLLATERAL an Account the Entity does not hold is told and ignored", () => {
    // ignored as far as Accounts go: none is made and no ledger; what the chain holds is kept in the facts, below
    const framed = runAt(base().alice, [held(entityOf(3))]);
    expect(framed.notices).toEqual([{ _tag: "unknown_peer", from: entityOf(3) }]);
    expect(framed.state.accounts).toEqual(base().alice.accounts);
  });

  test("R-J-COLLATERAL what the chain holds for a peer with no Account yet is kept for one opened later", () => {
    const framed = runAt(base().alice, [held(entityOf(3))]);
    expect(framed.state.chain.get(entityOf(3))?.held.get(GOLD)).toEqual({ collateral: 100n, ondelta: 100n });
  });

  test("R-FRAME-EPOCH an Account opened after the chain moved the epoch on signs under it and the two commit", () => {
    const moved = (peer: EntityId): JEvent => ({ _tag: "j_epoch", peer, epoch: 1n, stored: 10n });
    const start: Pair = { alice: emptyEntity(ALICE), bob: emptyEntity(BOB) };
    const alone = say(say(start, "alice", open(BOB)), "alice", moved(BOB));
    const late = say(say(alone, "bob", moved(ALICE)), "bob", open(ALICE));
    const sent = say(say(late, "alice", credit(BOB, 100n)), "bob", credit(ALICE, 50n));
    expect(heads(sent)[0]).toBe(heads(sent)[1]);
    expect(pending(sent)).toEqual([false, false]);
    expect([ledgerOfToken(sent, "alice")?.limit, ledgerOfToken(sent, "bob")?.limit]).toEqual([
      { left: 50n, right: 100n }, { left: 50n, right: 100n },
    ]);
    expect([sent.alice, sent.bob].map((e) => e.chain.get(e.id === ALICE ? BOB : ALICE)?.epoch)).toEqual([1n, 1n]);
  });

  test("R-J-COLLATERAL what the chain holds is what a payment may spend: Left pays from its deposit", () => {
    const funded = say(say(base(), "alice", held(BOB)), "bob", held(ALICE));
    const [none, some] = [say(base(), "alice", pay(BOB, 150n)), say(funded, "alice", pay(BOB, 150n))];
    expect(ledgerOfToken(none, "alice")).toMatchObject({ offdelta: 0n });
    expect(ledgerOfToken(some, "alice")).toMatchObject({ offdelta: -150n });
    expect(heads(some)[0]).toBe(heads(some)[1]);
  });

  test("R-J-COLLATERAL a command in the frame that hears the chain sees what it holds", () => {
    const funded = say(base(), "bob", held(ALICE));
    const together = runAt(funded.alice, [held(BOB), pay(BOB, 150n)]);
    expect(together.notices).toEqual([]);
    expect(together.state.accounts.get(BOB)?.pending?.frame.txs).toEqual([{ _tag: "pay", token: GOLD, amount: 150n }]);
  });

  test("R-J-COLLATERAL a frame in flight when the chain is heard commits with the chain's amounts", () => {
    const proposed = runAt(base().alice, [credit(BOB, 5n)]);
    const midway = runAt(proposed.state, [held(BOB)]);
    const after = midway.state.accounts.get(BOB)?.pending?.after;
    expect(after === undefined ? undefined : ledgerOf(after, GOLD).collateral).toBe(100n);
    const done = drain({ alice: midway.state, bob: base().bob }, proposed.outputs, "alice");
    expect(pending(done)).toEqual([false, false]);
    expect(ledgerOfToken(done, "alice"))
      .toMatchObject({ collateral: 100n, ondelta: 100n, limit: { left: 100n, right: 5n } });
  });
});

describe("entity/frame the token list is changed by a signed frame only (R-J-COLLATERAL-NO-LEDGER)", () => {
  test("R-J-COLLATERAL-NO-LEDGER a snapshot for a token without a ledger leaves the ledgers as they were", () => {
    const heardOil = say(base(), "alice", held(BOB, OIL, 5n, 0n));
    expect(ledgers(heardOil, "alice")).toEqual(ledgers(base(), "alice"));
    expect(account(heardOil, "alice")?.state).toEqual(account(base(), "alice")?.state);
    expect(heardOil.alice.chain.get(BOB)?.held.get(OIL)).toEqual({ collateral: 5n, ondelta: 0n });
  });

  test("R-J-COLLATERAL-NO-LEDGER a token heard by one side first does not split the heads", () => {
    const first = say(say(base(), "alice", held(BOB, OIL, 5n, 0n)), "alice", credit(BOB, 200n));
    expect(pending(first)).toEqual([false, false]);
    expect(heads(first)[0]).toBe(heads(first)[1]);
    const both = say(say(first, "bob", held(ALICE, OIL, 5n, 0n)), "alice", { _tag: "resend_due", peer: BOB });
    expect(pending(both)).toEqual([false, false]);
    expect(heads(both)[0]).toBe(heads(both)[1]);
  });

  test("R-J-COLLATERAL-NO-LEDGER the same when the side that has not heard proposes first", () => {
    const first = say(say(base(), "alice", held(BOB, OIL, 5n, 0n)), "bob", credit(ALICE, 200n));
    expect(pending(first)).toEqual([false, false]);
    expect(heads(first)[0]).toBe(heads(first)[1]);
  });

  test("R-J-COLLATERAL-NO-LEDGER a token heard while a frame is in flight does not enter the frame's state", () => {
    const proposed = runAt(base().alice, [credit(BOB, 300n)]);
    const midway = runAt(proposed.state, [held(BOB, OIL, 5n, 0n)]);
    const done = drain({ alice: midway.state, bob: base().bob }, proposed.outputs, "alice");
    expect(pending(done)).toEqual([false, false]);
    expect(heads(done)[0]).toBe(heads(done)[1]);
    expect(ledgers(done, "alice")).toEqual(ledgers(base(), "alice"));
  });

  test("R-J-COLLATERAL-NO-LEDGER a held token takes its amounts when a signed frame gives it a ledger", () => {
    const heardBoth = say(say(base(), "alice", held(BOB, OIL, 5n, 5n)), "bob", held(ALICE, OIL, 5n, 5n));
    const added = say(heardBoth, "alice", credit(BOB, 7n, OIL));
    expect(ledgers(added, "alice")).toEqual([GOLD, OIL]);
    expect(ledgerOfToken(added, "alice", OIL))
      .toMatchObject({ collateral: 5n, ondelta: 5n, limit: { left: 0n, right: 7n } });
    expect(ledgerOfToken(added, "bob", OIL)).toMatchObject({ collateral: 5n, ondelta: 5n });
  });

  const dust = (p: Pair, count: bigint): Pair =>
    Array.from({ length: Number(count) }, (_, i) => tokenOf(10n + BigInt(i))).reduce(
      (acc, token) => say(say(acc, "alice", held(BOB, token, 1n, 0n)), "bob", held(ALICE, token, 1n, 0n)), p);

  test("R-J-COLLATERAL-NO-LEDGER dust in many tokens does not make the Account unsignable", () => {
    const flooded = dust(base(), 130n);
    expect(ledgers(flooded, "alice")).toEqual(ledgers(base(), "alice"));
    const framed = runAt(flooded.alice, [credit(BOB, 400n)]);
    expect(framed.outputs.length).toBeGreaterThan(0);
    expect(framed.notices).toEqual([]);
  });

  test("R-J-COLLATERAL-NO-LEDGER the tokens kept for an Account are bounded; the one past the bound is told", () => {
    const flooded = dust(base(), 128n);
    expect(flooded.alice.chain.get(BOB)?.held.size).toBe(128);
    const over = runAt(flooded.alice, [held(BOB, tokenOf(9999n), 1n, 0n)]);
    const dropped: Notice = { _tag: "holding_dropped", peer: BOB, token: tokenOf(9999n) };
    expect(over.notices).toEqual([dropped]);
    expect(over.state.chain.get(BOB)?.held.size).toBe(128);
    expect(runAt(flooded.alice, [held(BOB, tokenOf(10n), 9n, 9n)]).notices).toEqual([]);
  });

  test("R-J-COLLATERAL-NO-LEDGER dust in 128 tokens does not crowd out a token the Account has a ledger for", () => {
    const flooded = dust(base(), 128n);
    expect(runAt(flooded.alice, [held(BOB, GOLD, 40n, 40n)]).notices).toEqual([]);
    const after = say(flooded, "alice", held(BOB, GOLD, 40n, 40n));
    expect(ledgerOfToken(after, "alice", GOLD)).toMatchObject({ collateral: 40n, ondelta: 40n });
    const both = dust(say(base(), "alice", held(BOB, GOLD, 40n, 40n)), 128n);
    expect(both.alice.chain.get(BOB)?.held.size).toBe(129);
  });
});
