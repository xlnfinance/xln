// R-LEDGER-REBASE: when the chain moves an Account's epoch on, every offdelta is zero again on both sides (the new
// epoch counts from zero), a frame in flight is kept and rebased with the committed state, and a finalized dispute
// leaves no collateral and no ondelta. Alice is the Left of the Account and Bob its Right; Bob extends credit to Alice,
// who pays him, so the Account carries an offdelta the chain never saw.
import { describe, expect, test } from "bun:test";
import { tokenOf, viewOf } from "../../account/fixtures.ts";
import { OPENED_WITH } from "../../entity/fixtures.ts";
import { type EntityId, type JEvent } from "../../entity/model.ts";
import {
  type Cluster, credit, deliver, entityOf, feed, GOLD, hostOf, open, pay, restarted, rise, settle, start,
} from "../fixtures.ts";

const ALICE = entityOf(1);
const BOB = entityOf(2);

const opened = settle(feed(feed(start(viewOf(110n), viewOf(110n)), ALICE, open(BOB)), BOB, open(ALICE)));
const credited = settle(feed(opened, BOB, credit(ALICE, 100n)));
const paid = settle(feed(credited, ALICE, pay(BOB, 40n)));

const epochOf = (peer: EntityId, epoch: bigint): JEvent => ({ _tag: "j_epoch", peer, epoch, stored: 5n });
const moved = (c: Cluster, epoch: bigint): Cluster =>
  feed(feed(c, ALICE, epochOf(BOB, epoch)), BOB, epochOf(ALICE, epoch));
const finalized = (c: Cluster): Cluster => feed(
  feed(c, ALICE, { _tag: "j_dispute_over", peer: BOB }),
  BOB, { _tag: "j_dispute_over", peer: ALICE });

const replicaOf = (c: Cluster, id: EntityId) =>
  hostOf(c, id).entities.get(id)?.accounts.get(id === ALICE ? BOB : ALICE) ?? expect.unreachable("no Account");
const ledgerOf = (c: Cluster, id: EntityId) =>
  replicaOf(c, id).state.ledgers.get(GOLD) ?? expect.unreachable("no ledger");
const offdeltas = (c: Cluster) => [ledgerOf(c, ALICE).offdelta, ledgerOf(c, BOB).offdelta];
const proofKept = (c: Cluster, id: EntityId) => hostOf(c, id).entities.get(id)?.proofs.has(id === ALICE ? BOB : ALICE);
const noticesOf = (c: Cluster, id: EntityId) => hostOf(c, id).wal.flatMap((row) => row.notices);
const same = (c: Cluster): boolean => replicaOf(c, ALICE).head === replicaOf(c, BOB).head;
const resend = (c: Cluster, id: EntityId): Cluster =>
  feed(c, id, { _tag: "resend_due", peer: id === ALICE ? BOB : ALICE });

/** The frame sent again, refused as another epoch's, and its txs proposed again once the J view has moved. */
const retried = (c: Cluster, id: EntityId): Cluster => settle(rise(settle(resend(c, id)), id, 111n));

/** `id` sends one payment and the link loses it: the Account holds it pending and the peer never heard of it. */
const frameLost = (c: Cluster, id: EntityId, amount: bigint): Cluster =>
  ({ ...feed(c, id, pay(id === ALICE ? BOB : ALICE, amount)), inflight: [] });

/** The same, but the peer hears the frame and commits it, and its ack is the one the link loses. */
const ackLost = (c: Cluster, id: EntityId, amount: bigint): Cluster =>
  ({ ...deliver(feed(c, id, pay(id === ALICE ? BOB : ALICE, amount))), inflight: [] });

describe("runtime/chain R-LEDGER-REBASE an epoch advance zeroes the offdelta on both sides", () => {
  test("R-LEDGER-REBASE every offdelta is zero again, limits stay, and the proof of the old epoch is forgotten", () => {
    expect(offdeltas(paid)).toEqual([-40n, -40n]);
    expect([proofKept(paid, ALICE), proofKept(paid, BOB)]).toEqual([true, true]);
    const after = moved(paid, 1n);
    expect(offdeltas(after)).toEqual([0n, 0n]);
    expect(ledgerOf(after, ALICE).limit).toEqual(ledgerOf(paid, ALICE).limit);
    expect([proofKept(after, ALICE), proofKept(after, BOB)]).toEqual([false, false]);
    expect(noticesOf(after, ALICE).concat(noticesOf(after, BOB))).toEqual([]);
  });

  test("R-LEDGER-REBASE a repeat or an older report of the epoch changes nothing, a new payment stays", () => {
    const after = moved(paid, 1n);
    const again = settle(feed(after, ALICE, pay(BOB, 10n)));
    expect(offdeltas(again)).toEqual([-10n, -10n]);
    expect(same(again)).toBe(true);
    const repeated = moved(moved(again, 1n), 0n);
    expect(offdeltas(repeated)).toEqual([-10n, -10n]);
  });

  test("R-LEDGER-REBASE a Host that restarts after the move replays to the same rebased Account", () => {
    const after = moved(finalized(paid), 1n);
    const back = restarted(after, ALICE);
    expect(replicaOf(back, ALICE)).toEqual(replicaOf(after, ALICE));
    expect(proofKept(back, ALICE)).toBe(false);
    expect(offdeltas(back)).toEqual([0n, 0n]);
  });

  test("R-LEDGER-REBASE a frame the peer committed before the move commits on both, with one ledger", () => {
    const lost = ackLost(paid, ALICE, 5n);
    expect(replicaOf(lost, ALICE).pending).toBeDefined();
    expect(replicaOf(lost, BOB).height).toBe(replicaOf(lost, ALICE).height + 1);
    const after = settle(resend(moved(lost, 1n), ALICE));
    expect(replicaOf(after, ALICE).pending).toBeUndefined();
    expect(same(after)).toBe(true);
    expect(offdeltas(after)).toEqual([0n, 0n]);
    expect(noticesOf(after, ALICE).concat(noticesOf(after, BOB))).toEqual([]);
    expect([proofKept(after, ALICE), proofKept(after, BOB)]).toEqual([false, false]);
    const next = settle(feed(after, ALICE, pay(BOB, 7n)));
    expect([offdeltas(next), same(next)]).toEqual([[-7n, -7n], true]);
    expect([proofKept(next, ALICE), proofKept(next, BOB)]).toEqual([true, true]);
  });

  // Review A probe 159g: a settlement moves the epoch and leaves the stored nonce as it was, so the re-ack of the old
  // epoch's frame must be told apart by its epoch and not by a nonce the move did not change.
  test("R-LEDGER-REBASE the re-ack of an old epoch's frame leaves neither side a proof of that epoch", () => {
    const unchanged = (peer: EntityId): JEvent => ({ _tag: "j_epoch", peer, epoch: 1n, stored: 0n });
    const lost = ackLost(paid, ALICE, 5n);
    const after = settle(resend(feed(feed(lost, ALICE, unchanged(BOB)), BOB, unchanged(ALICE)), ALICE));
    expect([proofKept(after, ALICE), proofKept(after, BOB)]).toEqual([false, false]);
  });

  test("R-LEDGER-REBASE a frame the peer never heard is refused as another epoch's and sealed again", () => {
    const lost = frameLost(paid, ALICE, 5n);
    const after = retried(moved(lost, 1n), ALICE);
    expect(replicaOf(after, ALICE).pending).toBeUndefined();
    expect(same(after)).toBe(true);
    expect(offdeltas(after)).toEqual([-5n, -5n]);
    expect(replicaOf(after, ALICE).height).toBe(replicaOf(paid, ALICE).height + 1);
    expect(noticesOf(after, ALICE).concat(noticesOf(after, BOB))).toEqual([]);
  });

  test("R-LEDGER-REBASE a payment that fitted only before the move is refused back to the one who asked", () => {
    const lost = frameLost(paid, BOB, 30n);
    const after = retried(moved(lost, 1n), BOB);
    expect(replicaOf(after, BOB).pending).toBeUndefined();
    expect(same(after)).toBe(true);
    expect(offdeltas(after)).toEqual([0n, 0n]);
    expect(noticesOf(after, BOB).map((n) => n._tag)).toEqual(["tx_refused"]);
  });
});

describe("runtime/chain R-LEDGER-REBASE a finalized dispute leaves nothing held", () => {
  const held = (c: Cluster, id: EntityId) =>
    hostOf(c, id).entities.get(id)?.chain.get(id === ALICE ? BOB : ALICE)?.held;
  const chainHolds = (peer: EntityId, token = GOLD, amount = 100n): JEvent =>
    ({ _tag: "j_collateral", peer, token, collateral: amount, ondelta: amount });
  const withChain = feed(feed(paid, ALICE, chainHolds(BOB)), BOB, chainHolds(ALICE));

  test("R-LEDGER-REBASE after a finalize collateral, ondelta and offdelta are zero for every token", () => {
    expect([ledgerOf(withChain, ALICE).collateral, ledgerOf(withChain, ALICE).ondelta]).toEqual([100n, 100n]);
    const after = moved(finalized(withChain), 1n);
    [ALICE, BOB].forEach((id) => {
      const l = ledgerOf(after, id);
      expect([l.collateral, l.ondelta, l.offdelta]).toEqual([0n, 0n, 0n]);
      expect(held(after, id)?.get(GOLD)).toEqual({ collateral: 0n, ondelta: 0n });
    });
  });

  // The title is a register killer from before R-DISPUTE-WATCH, when a counter ended the dispute for its registrar.
  test("R-LEDGER-REBASE a dispute that is over by a counter keeps what the chain holds", () => {
    const registered = (peer: EntityId): JEvent =>
      ({ _tag: "j_countered", peer, nonce: 9n, proposerIsLeft: true, bodyHash: OPENED_WITH.bodyHash });
    const countered = feed(feed(withChain, ALICE, registered(BOB)), BOB, registered(ALICE));
    expect([ledgerOf(countered, ALICE).collateral, ledgerOf(countered, ALICE).ondelta]).toEqual([100n, 100n]);
  });

  test("R-LEDGER-REBASE a token with no ledger that the chain held something for is zeroed too", () => {
    const nine = tokenOf(9n);
    const dusty = feed(feed(withChain, ALICE, chainHolds(BOB, nine, 3n)), BOB, chainHolds(ALICE, nine, 3n));
    expect(held(dusty, ALICE)?.get(nine)).toEqual({ collateral: 3n, ondelta: 3n });
    expect(held(moved(finalized(dusty), 1n), ALICE)?.get(nine)).toEqual({ collateral: 0n, ondelta: 0n });
  });
});
