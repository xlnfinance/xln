// A clause through the Runtime: Alice locks 30 for Bob on a hashlock, and the clause ends one of three ways: Bob shows
// the secret (it pays), Bob gives it up (it lapses), or the deadline and its reserve pass (Alice takes it back). Both
// Hosts see the same chain here; refusal.test.ts is where they differ.
import { describe, expect, test } from "bun:test";
import { holdId } from "../account/model.ts";
import { holdOf, secretOf, viewOf } from "../account/fixtures.ts";
import { ledgerOf } from "../account/state.ts";
import type { Command, EntityId } from "../entity/model.ts";
import { type Cluster, credit, entityOf, feed, GOLD, hostOf, open, rise, settle, start } from "./fixtures.ts";

const ALICE = entityOf(1);
const BOB = entityOf(2);
const SLOT = holdId(1n);
const DEADLINE = 115n;

const resolving = (secret: Uint8Array): Command => ({ _tag: "resolve", peer: ALICE, token: GOLD, id: SLOT, secret });

const lock: Command = { _tag: "lock", peer: BOB, token: GOLD, hold: holdOf("left", 30n, 1n, DEADLINE) };

const opened = settle(feed(feed(start(viewOf(110n), viewOf(110n)), ALICE, open(BOB)), BOB, open(ALICE)));
const locked = settle(feed(settle(feed(opened, BOB, credit(ALICE, 100n))), ALICE, lock));

const ledgerAt = (c: Cluster, id: EntityId, peer: EntityId) =>
  ledgerOf(hostOf(c, id).entities.get(id)?.accounts.get(peer)?.state ?? expect.unreachable("no account"), GOLD);

const noticesOf = (c: Cluster, id: EntityId) => hostOf(c, id).wal.flatMap((row) => row.notices);

/** Both Ledgers are the same and they say what the clause did. */
const bothSay = (c: Cluster, offdelta: bigint) => {
  expect(ledgerAt(c, ALICE, BOB)).toEqual(ledgerAt(c, BOB, ALICE));
  expect(ledgerAt(c, ALICE, BOB)).toMatchObject({ offdelta, holds: [] });
};

describe("runtime/htlc a clause opens on both sides and ends by a secret, a cancel or its deadline", () => {
  test("the lock opens one hold on each side and moves no money", () => {
    expect(ledgerAt(locked, ALICE, BOB).holds.map((h) => h.id)).toEqual([SLOT]);
    expect(ledgerAt(locked, BOB, ALICE).holds.map((h) => h.id)).toEqual([SLOT]);
    expect(ledgerAt(locked, ALICE, BOB).offdelta).toBe(0n);
  });

  test("Bob shows the secret: the hold pays Bob and closes on both sides", () => {
    const resolved = settle(feed(locked, BOB, resolving(secretOf(1))));
    bothSay(resolved, -30n);
    expect([...noticesOf(resolved, ALICE), ...noticesOf(resolved, BOB)]).toEqual([]);
  });

  test("a wrong secret is refused to Bob at the door and leaves the hold open", () => {
    const tried = settle(feed(locked, BOB, resolving(secretOf(2))));
    expect(noticesOf(tried, BOB).map((n) => n._tag)).toEqual(["command_refused"]);
    expect(ledgerAt(tried, BOB, ALICE).holds.map((h) => h.id)).toEqual([SLOT]);
  });

  test("Bob cancels: the hold lapses on both sides and the allocation stays", () => {
    bothSay(settle(feed(locked, BOB, { _tag: "cancel", peer: ALICE, token: GOLD, id: SLOT })), 0n);
  });

  test("once both views pass deadline and reserve Alice expires the hold and the allocation stays", () => {
    const late = settle(rise(settle(rise(locked, ALICE, 118n)), BOB, 118n));
    bothSay(settle(feed(late, ALICE, { _tag: "expire", peer: BOB, token: GOLD, id: SLOT })), 0n);
  });

  test("before the reserve has passed Alice's expiry is refused at her door", () => {
    const early = settle(feed(locked, ALICE, { _tag: "expire", peer: BOB, token: GOLD, id: SLOT }));
    expect(noticesOf(early, ALICE).map((n) => n._tag)).toEqual(["command_refused"]);
    expect(ledgerAt(early, ALICE, BOB).holds.map((h) => h.id)).toEqual([SLOT]);
  });
});
