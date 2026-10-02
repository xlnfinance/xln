// R-HOLD-DISSOLVE: a finalized dispute settled every clause of the proof it used, so the Account is left with no hold,
// no quote and no offer, and nothing reserved, on both sides and in a frame still in flight; a dispute that a counter
// ended settled nothing, and the clause stays. Alice is the Left of the Account and locks 30 for Bob until height 115.
import { describe, expect, test } from "bun:test";
import { holdOf, viewOf } from "../../account/fixtures.ts";
import { holdId } from "../../account/model.ts";
import { type Command, type Entry, type EntityId } from "../../entity/model.ts";
import {
  type Cluster, credit, deliver, entityOf, feed, GOLD, hostOf, open, restarted, settle, start,
} from "../fixtures.ts";

const ALICE = entityOf(1);
const BOB = entityOf(2);

const lock: Command = { _tag: "lock", peer: BOB, token: GOLD, hold: holdOf("left", 30n, 1n, 115n, 1) };

const opened = settle(feed(feed(start(viewOf(110n), viewOf(110n)), ALICE, open(BOB)), BOB, open(ALICE)));
const credited = settle(feed(opened, BOB, credit(ALICE, 100n)));
const locked = settle(feed(credited, ALICE, lock));

type Ending = Readonly<{ finalized: boolean }>;
const FINALIZED: Ending = { finalized: true };
const COUNTERED: Ending = { finalized: false };

const over = (c: Cluster, how: Ending): Cluster => feed(
  feed(c, ALICE, { _tag: "j_dispute_over", peer: BOB, ...how }),
  BOB, { _tag: "j_dispute_over", peer: ALICE, ...how });

const replicaOf = (c: Cluster, id: EntityId) =>
  hostOf(c, id).entities.get(id)?.accounts.get(id === ALICE ? BOB : ALICE) ?? expect.unreachable("no Account");
const ledgerOf = (c: Cluster, id: EntityId) =>
  replicaOf(c, id).state.ledgers.get(GOLD) ?? expect.unreachable("no ledger");
const holdsOf = (c: Cluster) => [ledgerOf(c, ALICE).holds.length, ledgerOf(c, BOB).holds.length];
const same = (c: Cluster): boolean => replicaOf(c, ALICE).head === replicaOf(c, BOB).head;
const noticesOf = (c: Cluster, id: EntityId) => hostOf(c, id).wal.flatMap((row) => row.notices);

describe("runtime/chain R-HOLD-DISSOLVE a finalize ends the Account's open clauses", () => {
  test("R-HOLD-DISSOLVE a finalized dispute leaves no hold on either side, and the head is the same", () => {
    expect(holdsOf(locked)).toEqual([1, 1]);
    const after = over(locked, FINALIZED);
    expect(holdsOf(after)).toEqual([0, 0]);
    expect([ledgerOf(after, ALICE).reserved, same(after)]).toEqual([{ left: 0n, right: 0n }, true]);
    expect(noticesOf(after, ALICE).concat(noticesOf(after, BOB))).toEqual([]);
  });

  test("R-HOLD-DISSOLVE a dispute that a counter ended settled nothing: the hold stays", () => {
    expect(holdsOf(over(locked, COUNTERED))).toEqual([1, 1]);
  });

  test("R-HOLD-DISSOLVE a lock whose ack the link lost is dissolved in the frame in flight too", () => {
    const lost = { ...deliver(feed(credited, ALICE, lock)), inflight: [] };
    expect(replicaOf(lost, ALICE).pending).toBeDefined();
    expect(ledgerOf(lost, BOB).holds.length).toBe(1);
    const after = over(lost, FINALIZED);
    expect(replicaOf(after, ALICE).pending?.after.ledgers.get(GOLD)?.holds).toEqual([]);
    expect(ledgerOf(after, BOB).holds).toEqual([]);
    const resent = settle(feed(after, ALICE, { _tag: "resend_due", peer: BOB }));
    expect(replicaOf(resent, ALICE).pending).toBeUndefined();
    expect(holdsOf(resent)).toEqual([0, 0]);
    expect(same(resent)).toBe(true);
  });

  test("R-HOLD-DISSOLVE a lock forwarded to the peer is given up: the entry fails back toward its source", () => {
    const entry: Entry = { _tag: "locked", from: entityOf(3), to: BOB, token: GOLD, id: holdId(1n) };
    const host = hostOf(locked, ALICE);
    const mine = host.entities.get(ALICE) ?? expect.unreachable("no Entity");
    const hosts = new Map([...locked.hosts, [ALICE, {
      ...host, entities: new Map([...host.entities, [ALICE, { ...mine, paybook: new Map([["0xaa", entry]]) }]]),
    }]]);
    const after = over({ ...locked, hosts }, FINALIZED);
    expect(hostOf(after, ALICE).entities.get(ALICE)?.paybook.get("0xaa")).toEqual({ _tag: "fail", from: entityOf(3) });
  });

  test("R-HOLD-DISSOLVE a Host that restarts after the finalize replays to the same Account", () => {
    const after = over(locked, FINALIZED);
    expect(replicaOf(restarted(after, ALICE), ALICE)).toEqual(replicaOf(after, ALICE));
  });

  test("R-HOLD-DISSOLVE the hold's id is free again: a new lock under it is judged as on an empty Account", () => {
    const again = settle(feed(over(locked, FINALIZED), ALICE, { ...lock, hold: holdOf("left", 20n, 1n, 120n, 2) }));
    expect(noticesOf(again, ALICE)).toEqual([]);
    expect(holdsOf(again)).toEqual([1, 1]);
    expect(ledgerOf(again, ALICE).holds[0]?.id).toBe(holdId(1n));
  });
});
