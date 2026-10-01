// The smallest whole path: two Runtimes, an Account opened on each, credit, one payment, over a link that delivers
// everything in order. Alice is the Left of the Account (the smaller id); Bob extends her 100 and she pays him 30.
import { describe, expect, test } from "bun:test";
import { ledgerOf } from "../account/state.ts";
import type { EntityId } from "../entity/model.ts";
import { type Cluster, credit, entityOf, feed, GOLD, hostOf, open, pay, settle, start } from "./fixtures.ts";

const ALICE = entityOf(1);
const BOB = entityOf(2);

const opened = settle(feed(feed(start(), ALICE, open(BOB)), BOB, open(ALICE)));
const credited = settle(feed(opened, BOB, credit(ALICE, 100n)));

const ledgerAt = (c: Cluster, id: EntityId, peer: EntityId) =>
  ledgerOf(hostOf(c, id).entities.get(id)?.accounts.get(peer)?.state ?? expect.unreachable("no account"), GOLD);

const noticesOf = (c: Cluster, id: EntityId) => hostOf(c, id).wal.flatMap((row) => row.notices);

describe("runtime/payment two entities open an Account and make one payment", () => {
  test("opening takes a frame on each Runtime and sends nothing", () => {
    expect(hostOf(opened, ALICE).wal.map((row) => row.height)).toEqual([1n]);
    expect(hostOf(opened, BOB).wal.map((row) => row.height)).toEqual([1n]);
    expect(opened.inflight).toEqual([]);
  });

  test("credit, a payment and the acks leave both Accounts on the same head with the same Ledger", () => {
    const paid = settle(feed(credited, ALICE, pay(BOB, 30n)));
    const alice = hostOf(paid, ALICE).entities.get(ALICE)?.accounts.get(BOB);
    const bob = hostOf(paid, BOB).entities.get(BOB)?.accounts.get(ALICE);
    expect(alice?.head).toBe(bob?.head);
    expect(alice?.pending).toBeUndefined();
    expect(bob?.pending).toBeUndefined();
    expect(alice?.state).toEqual(bob?.state);
    expect(ledgerAt(paid, ALICE, BOB)).toMatchObject({ offdelta: -30n, limit: { left: 100n, right: 0n } });
    expect([...noticesOf(paid, ALICE), ...noticesOf(paid, BOB)]).toEqual([]);
  });

  test("R-NOTICE a payment before any credit is refused to Alice with its fault, and Bob never hears of it", () => {
    const tried = settle(feed(opened, ALICE, pay(BOB, 30n)));
    expect(noticesOf(tried, ALICE).map((n) => n._tag)).toEqual(["command_refused"]);
    expect(tried.inflight).toEqual([]);
    expect(hostOf(tried, BOB).wal).toEqual(hostOf(opened, BOB).wal);
    expect(ledgerAt(tried, ALICE, BOB).offdelta).toBe(0n);
  });
});
