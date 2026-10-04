// R-HOLD-DISSOLVE: a finalized dispute settled every clause of the proof it used, so the Account is left with no hold,
// no quote and no offer, and nothing reserved, on both sides and in a frame still in flight; a counter the chain
// registered settled nothing, and the clause stays until the finalize. Alice is the Left of the Account and locks 30
// for Bob until height 115.
import { describe, expect, test } from "bun:test";
import { heightOf, holdOf, secretOf, tokenOf, viewOf } from "../../account/fixtures.ts";
import { holdId } from "../../account/model.ts";
import { OPENED_WITH } from "../../entity/fixtures.ts";
import { type Command, type Entry, type EntityId, type JAction, type JEvent } from "../../entity/model.ts";
import {
  type Cluster, credit, deliver, entityOf, feed, GOLD, hostOf, open, restarted, settle, start,
} from "../fixtures.ts";

const ALICE = entityOf(1);
const BOB = entityOf(2);

const lock: Command = { _tag: "lock", peer: BOB, token: GOLD, hold: holdOf("left", 30n, 1n, 115n, 1) };

const opened = settle(feed(feed(start(viewOf(110n), viewOf(110n)), ALICE, open(BOB)), BOB, open(ALICE)));
const credited = settle(feed(opened, BOB, credit(ALICE, 100n)));
const locked = settle(feed(credited, ALICE, lock));

const over = (c: Cluster): Cluster => feed(
  feed(c, ALICE, { _tag: "j_dispute_over", peer: BOB }),
  BOB, { _tag: "j_dispute_over", peer: ALICE });

const OPENED_BY = { proposerIsLeft: true, bodyHash: `0x${"01".repeat(32)}` } as const;
const countered = (c: Cluster): Cluster => feed(
  feed(c, ALICE, { _tag: "j_countered", peer: BOB, nonce: 9n, ...OPENED_BY }),
  BOB, { _tag: "j_countered", peer: ALICE, nonce: 9n, ...OPENED_BY });

const OIL = tokenOf(2n);

/** Alice offers 30 gold for 30 oil; Bob's first fill takes half: the offer is accepted and half of it stays open. */
const swapping = (() => {
  const funded = settle(feed(credited, ALICE, { _tag: "set_credit", peer: BOB, token: OIL, limit: 100n }));
  const offered = settle(feed(funded, ALICE, {
    _tag: "offer", peer: BOB, id: holdId(5n), give: { token: GOLD, amount: 30n }, want: { token: OIL, amount: 30n },
    deadline: heightOf(115n),
  }));
  return settle(feed(offered, BOB, { _tag: "fill", peer: ALICE, id: holdId(5n), ratio: 5_000 }));
})();

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
    const after = over(locked);
    expect(holdsOf(after)).toEqual([0, 0]);
    expect([ledgerOf(after, ALICE).reserved, same(after)]).toEqual([{ left: 0n, right: 0n }, true]);
    expect(noticesOf(after, ALICE).concat(noticesOf(after, BOB))).toEqual([]);
  });

  test("R-HOLD-DISSOLVE an offer a fill has accepted is dissolved with the rest: both sides end with none", () => {
    const openOffers = (c: Cluster) => [ALICE, BOB].map((id) => replicaOf(c, id).state.offers.length);
    expect(openOffers(swapping)).toEqual([1, 1]);
    const after = over(swapping);
    expect(openOffers(after)).toEqual([0, 0]);
    expect([ledgerOf(after, ALICE).reserved, same(after)]).toEqual([{ left: 0n, right: 0n }, true]);
  });

  test("R-HOLD-DISSOLVE a dispute that a counter ended settled nothing: the hold stays", () => {
    expect(holdsOf(countered(locked))).toEqual([1, 1]);
  });

  test("R-HOLD-DISSOLVE a lock whose ack the link lost is dissolved in the frame in flight too", () => {
    const lost = { ...deliver(feed(credited, ALICE, lock)), inflight: [] };
    expect(replicaOf(lost, ALICE).pending).toBeDefined();
    expect(ledgerOf(lost, BOB).holds.length).toBe(1);
    const after = over(lost);
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
    const after = over({ ...locked, hosts });
    expect(hostOf(after, ALICE).entities.get(ALICE)?.paybook.get("0xaa")).toEqual({ _tag: "fail", from: entityOf(3) });
  });

  test("R-HOLD-DISSOLVE a Host that restarts after the finalize replays to the same Account", () => {
    const after = over(locked);
    expect(replicaOf(restarted(after, ALICE), ALICE)).toEqual(replicaOf(after, ALICE));
  });

  test("R-HOLD-DISSOLVE the hold's id is free again: a new lock under it is judged as on an empty Account", () => {
    const again = settle(feed(over(locked), ALICE, { ...lock, hold: holdOf("left", 20n, 1n, 120n, 2) }));
    expect(noticesOf(again, ALICE)).toEqual([]);
    expect(holdsOf(again)).toEqual([1, 1]);
    expect(ledgerOf(again, ALICE).holds[0]?.id).toBe(holdId(1n));
  });
});

describe("runtime/chain R-HOLD-DISSOLVE a release queued in the dispute is not applied again after it", () => {
  const asked = feed(locked, ALICE, { _tag: "dispute", peer: BOB });
  const NONCE = (() => {
    const [first] = asked.chain.filter((a: JAction) => a._tag === "dispute_start");
    return first?._tag === "dispute_start" ? first.nonce : expect.unreachable("no start");
  })();
  const windowOf = (peer: EntityId): JEvent =>
    ({ _tag: "j_dispute", peer, epoch: 0n, by: "left", nonce: NONCE, timeout: 500n, ...OPENED_WITH });
  const frozen = feed(feed(asked, ALICE, windowOf(BOB)), BOB, windowOf(ALICE));
  const resolving: Command = { _tag: "resolve", peer: ALICE, token: GOLD, id: holdId(1n), secret: secretOf(1) };

  /** The finalize paid Bob's clause: its hash was shown on the chain before the deadline. Both Entities hear it. */
  /** The chain logged the opening proof. This node can name that hash, so the release is proposed and refused. */
  const finalized = (c: Cluster): Cluster => [[ALICE, BOB], [BOB, ALICE]].reduce((acc, [id, peer]) =>
    feed(acc, id!, {
      _tag: "j_epoch", peer: peer!, epoch: 1n, stored: 9n, finalBodyHash: OPENED_WITH.bodyHash,
    }, { _tag: "j_dispute_over", peer: peer! }),
  c);

  test("R-HOLD-DISSOLVE Bob's queued resolve is dropped with a notice and the epoch's ledgers stay at zero", () => {
    const queued = settle(feed(frozen, BOB, resolving));
    expect(replicaOf(queued, BOB).mempool.length).toBe(1);
    const after = settle(finalized(queued));
    expect(holdsOf(after)).toEqual([0, 0]);
    expect([ledgerOf(after, ALICE).offdelta, ledgerOf(after, BOB).offdelta]).toEqual([0n, 0n]);
    expect(replicaOf(after, BOB).mempool).toEqual([]);
    expect(noticesOf(after, BOB).map((n) => n._tag)).toContain("tx_refused");
    expect(same(after)).toBe(true);
  });
});
