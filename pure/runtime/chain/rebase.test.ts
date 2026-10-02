// R-LEDGER-REBASE: when the chain moves an Account's epoch on, every offdelta is zero again on both sides (the new
// epoch counts from zero), a frame in flight is kept and rebased with the committed state, and a finalized dispute
// leaves no collateral and no ondelta. Alice is the Left of the Account and Bob its Right; Bob extends credit to Alice,
// who pays him, so the Account carries an offdelta the chain never saw.
import { describe, expect, test } from "bun:test";
import { heightOf, holdOf, secretOf, tokenOf, viewOf } from "../../account/fixtures.ts";
import { holdId } from "../../account/model.ts";
import { proofBodyOf } from "../../account/proof/body.ts";
import { proofBodyHash } from "../../chain/proof/proof.ts";
import { anchor, OPENED_WITH } from "../../entity/fixtures.ts";
import { type Command, type EntityId, type JAction, type JEvent } from "../../entity/model.ts";
import type { ProofBody } from "../../chain/proof/proof.ts";
import {
  type Cluster, credit, deliver, entityOf, feed, GOLD, hostOf, open, pay, restarted, rise, settle, start,
} from "../fixtures.ts";

const ALICE = entityOf(1);
const BOB = entityOf(2);

const opened = settle(feed(feed(start(viewOf(110n), viewOf(110n)), ALICE, open(BOB)), BOB, open(ALICE)));
const credited = settle(feed(opened, BOB, credit(ALICE, 100n)));
const paid = settle(feed(credited, ALICE, pay(BOB, 40n)));

/** The hash of a proof body as the chain logs it in `DisputeFinalized`, or an unreadable body: a test is wrong then. */
const hashed = (body: ProofBody | undefined): string => {
  const hash = body === undefined ? undefined : proofBodyHash(body);
  return hash?.ok === true ? hash.value : expect.unreachable("no body hash");
};
/** The hash of the body of the state `id` would commit with its pending frame: a proof it signed, the peer's to use. */
const pendingHash = (c: Cluster, id: EntityId): string => {
  const state = replicaOf(c, id).pending?.after ?? expect.unreachable("no pending frame");
  const body = proofBodyOf(anchor.terms, state);
  return hashed(body.ok ? body.value : undefined);
};
const epochOf = (peer: EntityId, epoch: bigint, stored = 5n, finalBodyHash?: string): JEvent =>
  ({ _tag: "j_epoch", peer, epoch, stored, ...(finalBodyHash === undefined ? {} : { finalBodyHash }) });
/** The chain moves the epoch on and both nodes hear it; `finalBodyHash` is the proof a dispute finalize paid by. */
const moved = (c: Cluster, epoch: bigint, stored = 5n, finalBodyHash?: string): Cluster =>
  feed(feed(c, ALICE, epochOf(BOB, epoch, stored, finalBodyHash)), BOB, epochOf(ALICE, epoch, stored, finalBodyHash));
/** Alice asks for the dispute and the chain opens it: both Entities hear it, so an epoch move after it ends one. */
const disputed = (c: Cluster): Cluster => {
  const asked = feed(c, ALICE, { _tag: "dispute", peer: BOB });
  const opens = (peer: EntityId): JEvent => ({
    _tag: "j_dispute", peer, epoch: 0n, by: "left", nonce: startedAt(asked), timeout: 500n, proposerIsLeft: true,
    bodyHash: openingHash(asked),
  });
  return feed(feed(asked, ALICE, opens(BOB)), BOB, opens(ALICE));
};
/** `starter` asks for the dispute and the chain opens it; both Entities hear it. */
const disputedBy = (c: Cluster, starter: EntityId): Cluster => {
  const other = starter === ALICE ? BOB : ALICE;
  const asked = feed(c, starter, { _tag: "dispute", peer: other });
  const by = starter === ALICE ? "left" : "right";
  const opens = (peer: EntityId): JEvent => ({
    _tag: "j_dispute", peer, epoch: 0n, by, nonce: startedAt(asked), timeout: 500n,
    proposerIsLeft: starter === ALICE, bodyHash: openingHash(asked),
  });
  return feed(feed(asked, starter, opens(other)), other, opens(starter));
};
/** The last dispute start the chain was asked for. */
const startOf = (asked: Cluster) => {
  const [first] = asked.chain.filter((a: JAction) => a._tag === "dispute_start").slice(-1);
  return first?._tag === "dispute_start" ? first : expect.unreachable("no start");
};
/** The nonce of the proof the dispute start names: what the chain would keep when it finalizes with it. */
const startedAt = (asked: Cluster): bigint => startOf(asked).nonce;
/** The hash of the body the start opened with: what the chain logs when the dispute finalizes on it. */
const openingHash = (asked: Cluster): string => hashed(startOf(asked).body);
/**
 * The chain finalizes the dispute with the opening proof by timeout and the epoch moves on, both nodes hear it. A
 * unilateral timeout stores the opening nonce plus one (Depository.sol 965-976).
 */
const finalizedByStart = (c: Cluster): Cluster => moved(c, 1n, startedAt(c) + 1n, openingHash(c));
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
const rebasedTold = (c: Cluster, id: EntityId) =>
  noticesOf(c, id).flatMap((n) => (n._tag === "offdelta_rebased" ? [n] : []));
const pendingTold = (c: Cluster, id: EntityId) =>
  noticesOf(c, id).flatMap((n) => (n._tag === "pending_rebased" ? [n] : []));
const otherNotices = (c: Cluster) => [ALICE, BOB].flatMap((id) =>
  noticesOf(c, id).filter((n) => n._tag !== "offdelta_rebased" && n._tag !== "pending_rebased"));
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
    expect(otherNotices(after)).toEqual([]);
  });

  test("R-DISPUTE-FREEZE a finalize by a proof below the committed head tells that node both nonces", () => {
    const asked = disputed(ackLost(paid, ALICE, 5n));
    const after = finalizedByStart(asked);
    const stale = startedAt(asked);
    expect(rebasedTold(after, ALICE)).toEqual([]);
    expect(pendingTold(after, ALICE).map((n) => [n.peer, n.finalizedNonce, n.txs.map((t) => t._tag)]))
      .toEqual([[BOB, stale, ["pay"]]]);
    const [told, ...more] = rebasedTold(after, BOB);
    expect(more).toEqual([]);
    expect(told).toMatchObject({
      peer: ALICE, token: GOLD, epoch: 1n, offdelta: -45n, finalizedNonce: stale,
    });
    expect((told?.committedNonce ?? 0n) > stale).toBe(true);
    expect(offdeltas(after)).toEqual([0n, 0n]);
  });

  test("R-DISPUTE-FREEZE a finalize by the proof the node holds as its head tells nothing", () => {
    const after = finalizedByStart(disputed(paid));
    expect(offdeltas(paid)).toEqual([-40n, -40n]);
    expect([rebasedTold(after, ALICE), rebasedTold(after, BOB)]).toEqual([[], []]);
    expect(offdeltas(after)).toEqual([0n, 0n]);
  });

  test("R-DISPUTE-FREEZE a frame sealed before the start and acked after it is told to the committer", () => {
    const asked = disputed(deliver(feed(paid, ALICE, pay(BOB, 5n))));
    const acked = settle(asked);
    expect(replicaOf(acked, ALICE).pending).toBeDefined();
    const after = finalizedByStart(acked);
    expect(rebasedTold(after, ALICE)).toEqual([]);
    expect(pendingTold(after, ALICE).map((n) => n.txs.map((t) => t._tag))).toEqual([["pay"]]);
    expect(rebasedTold(after, BOB).map((n) => [n.token, n.offdelta, n.finalizedNonce === startedAt(acked)]))
      .toEqual([[GOLD, -45n, true]]);
    expect(pendingTold(after, BOB)).toEqual([]);
  });

  test("R-DISPUTE-FREEZE a Right-authored frame the Left committed is told (stored is start plus one)", () => {
    const given = settle(feed(paid, ALICE, credit(BOB, 100n)));
    const sealed = deliver(feed(given, BOB, pay(ALICE, 5n)));
    const asked = settle(disputedBy(sealed, BOB));
    const stale = startedAt(asked);
    const after = moved(asked, 1n, stale + 1n, openingHash(asked));
    expect(rebasedTold(after, ALICE).map((n) => [n.committedNonce, n.finalizedNonce])).toEqual([[stale + 1n, stale]]);
    expect(pendingTold(after, BOB).map((n) => n.txs.map((t) => t._tag))).toEqual([["pay"]]);
    expect(rebasedTold(after, BOB)).toEqual([]);
  });

  test("R-DISPUTE-FREEZE a pending lock is told like a pending payment", () => {
    const lock: Command = { _tag: "lock", peer: BOB, token: GOLD, hold: holdOf("left", 30n, 1n, 115n, 1) };
    const asked = disputed({ ...deliver(feed(paid, ALICE, lock)), inflight: [] });
    const after = finalizedByStart(asked);
    expect(pendingTold(after, ALICE).map((n) => n.txs.map((t) => t._tag))).toEqual([["lock"]]);
  });

  test("R-DISPUTE-FREEZE a finalize with a registered counter pays by the stored nonce itself", () => {
    const asked = disputed(ackLost(paid, ALICE, 5n));
    const [counter] = asked.chain.filter((a: JAction) => a._tag === "counter").slice(-1);
    if (counter?._tag !== "counter") return expect.unreachable("no counter");
    const registered = (peer: EntityId): JEvent => ({
      _tag: "j_countered", peer, nonce: counter.nonce, proposerIsLeft: counter.proposerIsLeft,
      bodyHash: hashed(counter.body),
    });
    const after = moved(
      feed(feed(asked, ALICE, registered(BOB)), BOB, registered(ALICE)), 1n, counter.nonce, hashed(counter.body),
    );
    expect([rebasedTold(after, ALICE), rebasedTold(after, BOB)]).toEqual([[], []]);
    // The frame alice still holds pending is the one the counter's proof holds: the chain paid it, and she is told so.
    expect(pendingTold(after, ALICE)).toMatchObject([{ fate: "paid_on_chain", finalizedNonce: counter.nonce }]);
    expect(pendingTold(after, BOB)).toStrictEqual([]);
  });

  test("R-DISPUTE-FREEZE an epoch a settlement or a withdrawal moves tells nothing, a repeat nothing more", () => {
    const after = moved(paid, 1n);
    expect([rebasedTold(after, ALICE), rebasedTold(after, BOB)]).toEqual([[], []]);
    expect([rebasedTold(moved(paid, 1n, 0n), ALICE), rebasedTold(moved(paid, 1n, 0n), BOB)]).toEqual([[], []]);
    expect([rebasedTold(moved(after, 1n), ALICE), rebasedTold(moved(opened, 1n), BOB)]).toEqual([[], []]);
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
    expect(otherNotices(after)).toEqual([]);
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
    expect(otherNotices(after)).toEqual([]);
  });

  test("R-LEDGER-REBASE a payment that fitted only before the move is refused back to the one who asked", () => {
    const lost = frameLost(paid, BOB, 30n);
    const after = retried(moved(lost, 1n), BOB);
    expect(replicaOf(after, BOB).pending).toBeUndefined();
    expect(same(after)).toBe(true);
    expect(offdeltas(after)).toEqual([0n, 0n]);
    expect(noticesOf(after, BOB).map((n) => n._tag).filter((t) => t !== "offdelta_rebased")).toEqual(["tx_refused"]);
  });
});

describe("runtime/chain R-DISPUTE-FREEZE the finalized nonce is that of the proof the chain logged by hash", () => {
  const asked = disputed(ackLost(paid, ALICE, 5n));
  const stale = startedAt(asked);
  const unknown = `0x${"ab".repeat(32)}`;

  test("R-DISPUTE-FREEZE a finalize with a proof the starter signed pays by that proof: told as paid", () => {
    // The peer finalizes at once with the newer proof Alice signed: the chain stores its nonce, no counter is logged.
    const signed = pendingHash(asked, ALICE);
    const after = moved(asked, 1n, stale + 1n, signed);
    expect([rebasedTold(after, ALICE), rebasedTold(after, BOB)]).toEqual([[], []]);
    expect(pendingTold(after, ALICE)).toMatchObject([{ peer: BOB, fate: "paid_on_chain", txs: [{ _tag: "pay" }] }]);
    expect(pendingTold(after, BOB)).toStrictEqual([]);
  });

  test("R-DISPUTE-FREEZE a finalize with the opening proof pays by the opening nonce, not the stored one", () => {
    const after = moved(asked, 1n, 99n, openingHash(asked));
    expect(pendingTold(after, ALICE).map((n) => n.finalizedNonce)).toEqual([stale]);
    expect(rebasedTold(after, BOB).map((n) => n.finalizedNonce)).toEqual([stale]);
  });

  test("R-DISPUTE-FREEZE a finalize with the registered counter pays by its nonce, a state held or not", () => {
    const counter = (peer: EntityId): JEvent =>
      ({ _tag: "j_countered", peer, nonce: stale + 5n, proposerIsLeft: false, bodyHash: unknown });
    const registered = feed(feed(asked, ALICE, counter(BOB)), BOB, counter(ALICE));
    const after = moved(registered, 1n, stale + 5n, unknown);
    expect([rebasedTold(after, ALICE), pendingTold(after, ALICE)]).toEqual([[], []]);
    const unnamed = pendingTold(moved(asked, 1n, stale + 5n, unknown), ALICE);
    expect(unnamed.map((n) => n.finalizedNonce)).toStrictEqual([undefined]);
  });

  test("R-DISPUTE-FREEZE a finalize with the registered counter names exactly the counter's nonce", () => {
    const counter = (peer: EntityId): JEvent =>
      ({ _tag: "j_countered", peer, nonce: stale + 1n, proposerIsLeft: false, bodyHash: unknown });
    const registered = feed(feed(asked, ALICE, counter(BOB)), BOB, counter(ALICE));
    const after = moved(registered, 1n, stale + 1n, unknown);
    expect(pendingTold(after, ALICE).map((n) => n.finalizedNonce)).toStrictEqual([stale + 1n]);
  });

  test("R-DISPUTE-FREEZE a registered counter that holds the node's own head names exactly that nonce", () => {
    const counter = (peer: EntityId): JEvent =>
      ({ _tag: "j_countered", peer, nonce: stale, proposerIsLeft: false, bodyHash: openingHash(asked) });
    const registered = feed(feed(asked, ALICE, counter(BOB)), BOB, counter(ALICE));
    const after = moved(registered, 1n, stale, openingHash(asked));
    expect(pendingTold(after, ALICE).map((n) => n.finalizedNonce)).toStrictEqual([stale]);
  });

  test("R-DISPUTE-FREEZE the hash the chain logged matches whatever case it is written in", () => {
    const upper = (hash: string): string => `0x${hash.slice(2).toUpperCase()}`;
    const named = moved(asked, 1n, stale + 1n, upper(openingHash(asked)));
    expect(pendingTold(named, ALICE).map((n) => n.finalizedNonce)).toStrictEqual([stale]);
    const counter = (peer: EntityId): JEvent =>
      ({ _tag: "j_countered", peer, nonce: stale + 1n, proposerIsLeft: false, bodyHash: upper(unknown) });
    const registered = feed(feed(asked, ALICE, counter(BOB)), BOB, counter(ALICE));
    const after = moved(registered, 1n, stale + 1n, unknown);
    expect(pendingTold(after, ALICE).map((n) => n.finalizedNonce)).toStrictEqual([stale + 1n]);
  });

  test("R-DISPUTE-FREEZE a finalize with a proof the node cannot name is told with the nonce unknown", () => {
    const after = moved(asked, 1n, stale + 1n, unknown);
    expect(pendingTold(after, ALICE).map((n) => n.finalizedNonce)).toStrictEqual([undefined]);
    expect(rebasedTold(after, BOB).map((n) => n.finalizedNonce)).toStrictEqual([undefined]);
  });

  test("R-DISPUTE-FREEZE a finalize that logged no body hash is told with the nonce unknown too", () => {
    const after = moved(asked, 1n, stale + 1n);
    expect(pendingTold(after, ALICE).map((n) => n.finalizedNonce)).toStrictEqual([undefined]);
  });

  test("R-DISPUTE-FREEZE the notice of a pending frame names its epoch, its nonce and that it is sent again", () => {
    const after = finalizedByStart(asked);
    expect(pendingTold(after, ALICE)).toMatchObject([{
      peer: BOB, epoch: 1n, finalizedNonce: stale, fate: "resent_in_new_epoch",
    }]);
    expect((pendingTold(after, ALICE)[0]?.nonce ?? 0n) > stale).toBe(true);
  });

  test("R-DISPUTE-FREEZE a pending frame the chain paid by is dropped, never sealed again: no double payment", () => {
    // Alice pays 5; Bob never commits the frame but holds her signature, and finalizes with it at once.
    const lost = disputed(frameLost(paid, ALICE, 5n));
    const after = retried(moved(lost, 1n, startedAt(lost) + 1n, pendingHash(lost, ALICE)), ALICE);
    expect(offdeltas(after)).toStrictEqual([0n, 0n]);
    expect([replicaOf(after, ALICE).pending, replicaOf(after, ALICE).mempool]).toStrictEqual([undefined, []]);
    expect(same(after)).toBe(true);
    expect(pendingTold(after, ALICE)).toMatchObject([{ fate: "paid_on_chain", txs: [{ _tag: "pay" }] }]);
    expect(noticesOf(after, ALICE).map((n) => n._tag)).toStrictEqual(["pending_rebased"]);
    const next = settle(feed(after, ALICE, pay(BOB, 7n)));
    expect([offdeltas(next), same(next)]).toStrictEqual([[-7n, -7n], true]);
  });

  test("R-DISPUTE-FREEZE the same holds whoever started the dispute: a payment the chain paid is paid once", () => {
    [ALICE, BOB].forEach((starter) => {
      const lost = disputedBy(frameLost(paid, ALICE, 5n), starter);
      const after = retried(moved(lost, 1n, startedAt(lost) + 1n, pendingHash(lost, ALICE)), ALICE);
      expect([starter, offdeltas(after), same(after)]).toStrictEqual([starter, [0n, 0n], true]);
      expect([starter, replicaOf(after, ALICE).mempool]).toStrictEqual([starter, []]);
      expect(pendingTold(after, ALICE).map((n) => n.fate)).toStrictEqual(["paid_on_chain"]);
    });
  });

  test("R-DISPUTE-FREEZE a frame the chain paid by and the peer committed commits on the re-ack, paid once", () => {
    const lost = disputed(ackLost(paid, ALICE, 5n));
    const after = settle(resend(moved(lost, 1n, startedAt(lost) + 1n, pendingHash(lost, ALICE)), ALICE));
    expect(replicaOf(after, ALICE).pending).toBeUndefined();
    expect([offdeltas(after), same(after)]).toStrictEqual([[0n, 0n], true]);
    expect(pendingTold(after, ALICE)).toMatchObject([{ fate: "paid_on_chain" }]);
  });

  test("R-DISPUTE-FREEZE a body several proofs share is named by the highest nonce among them", () => {
    // Alice raises Bob's credit (not in a proof body) and Bob commits it; the chain finalizes with the opening proof.
    const lost = disputed({ ...deliver(feed(paid, ALICE, credit(BOB, 50n))), inflight: [] });
    const after = finalizedByStart(lost);
    expect(rebasedTold(after, BOB)).toStrictEqual([]);
    expect(pendingTold(after, ALICE)).toStrictEqual([]);
  });

  test("R-DISPUTE-FREEZE a finalize on an Account with no co-signed frame tells nothing and moves the epoch", () => {
    const opens = (peer: EntityId): JEvent => ({
      _tag: "j_dispute", peer, epoch: 0n, by: "right", nonce: 1n, timeout: 500n, proposerIsLeft: false,
      bodyHash: `0x${"cd".repeat(32)}`,
    });
    const against = feed(feed(opened, ALICE, opens(BOB)), BOB, opens(ALICE));
    const after = moved(against, 1n, 2n, `0x${"ef".repeat(32)}`);
    expect([rebasedTold(after, ALICE), pendingTold(after, ALICE)]).toStrictEqual([[], []]);
    expect(same(after)).toBe(true);
  });
});

describe("runtime/chain R-DISPUTE-FREEZE only a frame that spends is told as voided", () => {
  const OIL = tokenOf(2n);
  const lock: Command = { _tag: "lock", peer: BOB, token: GOLD, hold: holdOf("left", 30n, 1n, 115n, 1) };
  const locked = settle(feed(paid, ALICE, lock));
  const lostFrom = (c: Cluster, id: EntityId, command: Command): Cluster => ({ ...feed(c, id, command), inflight: [] });
  const told = (c: Cluster, id: EntityId, command: Command) =>
    pendingTold(finalizedByStart(disputed(lostFrom(c, id, command))), id).map((n) => n.txs.map((t) => t._tag));

  test("R-DISPUTE-FREEZE a pending release of a hold is not a payment: nothing is told", () => {
    expect(told(locked, BOB, { _tag: "cancel", peer: ALICE, token: GOLD, id: holdId(1n) })).toEqual([]);
  });

  test("R-DISPUTE-FREEZE a pending resolve is not a payment either", () => {
    const resolve: Command = { _tag: "resolve", peer: ALICE, token: GOLD, id: holdId(1n), secret: secretOf(1) };
    expect(told(locked, BOB, resolve)).toEqual([]);
  });

  const swapping = settle(feed(locked, ALICE, { _tag: "set_credit", peer: BOB, token: OIL, limit: 100n }));
  const swap = { give: { token: GOLD, amount: 10n }, want: { token: OIL, amount: 10n }, deadline: heightOf(115n) };

  test("R-DISPUTE-FREEZE a pending offer is told like a payment", () => {
    const { want: give, give: want, deadline } = swap;
    const offer: Command = { _tag: "offer", peer: ALICE, id: holdId(5n), give, want, deadline };
    expect(told(swapping, BOB, offer)).toEqual([["offer"]]);
    // A quote is no clause until it is filled: the proof the chain paid by does not hold it, so it is sent again.
    const after = finalizedByStart(disputed(lostFrom(swapping, BOB, offer)));
    expect(pendingTold(after, BOB).map((n) => n.fate)).toStrictEqual(["resent_in_new_epoch"]);
  });

  test("R-DISPUTE-FREEZE a pending fill is told like a payment", () => {
    const offered = settle(feed(swapping, ALICE, { _tag: "offer", peer: BOB, id: holdId(5n), ...swap }));
    expect(told(offered, BOB, { _tag: "fill", peer: ALICE, id: holdId(5n), ratio: 65_535 })).toEqual([["fill"]]);
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
