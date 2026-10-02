// R-DISPUTE-WATCH: a node that holds a newer co-signed proof than the one a dispute against it opened with counters
// it, finalizes with its counter once the chain registered it, and never offers a proof the chain would rank below the
// dispute's. The Entities here sign for real, so the counter carries the signature the peer gave over its head.
import { describe, expect, test } from "bun:test";
import { proofBodyHash } from "../../chain/proof/proof.ts";
import { credit, open, OPENED_WITH, pay } from "../fixtures.ts";
import { emptyEntity, type EntityState, type JAction, type JEvent } from "../model.ts";
import { ALICE, BOB, must, run, signed } from "./keys.ts";

const alice0 = run(emptyEntity(ALICE.id), open(BOB.id)).state;
const bob0 = run(emptyEntity(BOB.id), open(ALICE.id)).state;

/** Bob extends Alice 60 of credit; Alice acks and Bob hears it: each holds the frame and the peer's signature. */
const committed = (() => {
  const proposed = run(bob0, credit(ALICE.id, 60n));
  const frame = proposed.outputs[0] ?? expect.unreachable("no frame");
  const heard = run(alice0, signed(BOB, frame));
  const ack = heard.outputs[0] ?? expect.unreachable("no ack");
  return { alice: heard.state, bob: run(proposed.state, signed(ALICE, ack)).state };
})();

/**
 * Alice pays Bob in a second frame and Bob co-signs it, but his ack never reaches her: Bob holds Alice's signature over
 * the newer head, which moved the ledger, and Alice only Bob's over the first.
 */
const ackLost = (() => {
  const proposed = run(committed.alice, pay(BOB.id, 10n));
  const frame = proposed.outputs[0] ?? expect.unreachable("no second frame");
  const message = signed(ALICE, frame);
  return { alice: proposed.state, bob: run(committed.bob, message).state, sig: message.sig };
})();

const startOf = (state: EntityState) => {
  const [first] = run(state, { _tag: "dispute", peer: BOB.id }).chain;
  return first?._tag === "dispute_start" ? first : expect.unreachable("no start");
};

/** What Bob hears of a dispute Alice's start opened, with its window ending at 500. */
const openedBy = (start: ReturnType<typeof startOf>): JEvent => ({
  _tag: "j_dispute", peer: ALICE.id, epoch: 0n, by: "left", nonce: start.nonce, timeout: 500n,
  proposerIsLeft: start.proposerIsLeft, bodyHash: must(proofBodyHash(start.body)),
});

const countersOf = (chain: readonly JAction[]) => chain.filter((a) => a._tag === "counter");
const finalsOf = (chain: readonly JAction[]) => chain.filter((a) => a._tag === "dispute_finalize");

describe("entity/signing R-DISPUTE-WATCH a dispute from an older proof is answered with the newest one held", () => {
  const start = startOf(ackLost.alice);
  const heard = run(ackLost.bob, openedBy(start));

  test("the counter names the dispute, the newer nonce and body, and Alice's signature over the newer head", () => {
    const [counter, ...more] = countersOf(heard.chain);
    if (counter?._tag !== "counter" || more.length > 0) return expect.unreachable("not one counter");
    expect(counter.nonce).toBeGreaterThan(start.nonce);
    expect(counter.initial).toEqual({ nonce: start.nonce, bodyHash: must(proofBodyHash(start.body)) });
    expect(counter.sig).toBe(ackLost.sig ?? expect.unreachable("no signature"));
    expect(counter.proposerIsLeft).toBe(true);
    expect(counter.body).not.toEqual(start.body);
  });

  test("it is restated at every frame until the chain registers it, and then no more", () => {
    const again = run(heard.state, openedBy(start));
    expect(countersOf(again.chain)).toEqual(countersOf(heard.chain));
    const [counter] = countersOf(heard.chain);
    if (counter?._tag !== "counter") return expect.unreachable("no counter");
    const registered = run(heard.state, {
      _tag: "j_countered", peer: ALICE.id, nonce: counter.nonce, proposerIsLeft: counter.proposerIsLeft,
      bodyHash: must(proofBodyHash(counter.body)),
    });
    expect(countersOf(registered.chain)).toEqual([]);
  });

  test("it finalizes with its counter once the chain registered it and the window is over, and not before", () => {
    const [counter] = countersOf(heard.chain);
    if (counter?._tag !== "counter") return expect.unreachable("no counter");
    const registered = run(heard.state, {
      _tag: "j_countered", peer: ALICE.id, nonce: counter.nonce, proposerIsLeft: counter.proposerIsLeft,
      bodyHash: must(proofBodyHash(counter.body)),
    });
    expect(finalsOf(registered.chain)).toEqual([]);
    const repeated = run(registered.state, openedBy(start));
    const over = run(repeated.state, { _tag: "j_window_over", peer: ALICE.id });
    expect(finalsOf(over.chain)).toEqual([{
      _tag: "dispute_finalize", peer: ALICE.id, nonce: counter.nonce, proposerIsLeft: counter.proposerIsLeft,
      body: counter.body, startedByLeft: true, initial: counter.initial,
    }]);
    const unregistered = run(heard.state, { _tag: "j_window_over", peer: ALICE.id });
    expect(finalsOf(unregistered.chain)).toEqual([]);
    const done = run(over.state, { _tag: "j_dispute_over", peer: ALICE.id });
    expect(finalsOf(done.chain)).toEqual([]);
  });

  test("a counter of another nonce or author is not the node's: it still waits", () => {
    const [counter] = countersOf(heard.chain);
    if (counter?._tag !== "counter") return expect.unreachable("no counter");
    const other = run(heard.state, {
      _tag: "j_countered", peer: ALICE.id, nonce: counter.nonce + 1n, proposerIsLeft: counter.proposerIsLeft,
      bodyHash: must(proofBodyHash(counter.body)),
    });
    const rival = run(other.state, {
      _tag: "j_countered", peer: ALICE.id, nonce: counter.nonce, proposerIsLeft: !counter.proposerIsLeft,
      bodyHash: must(proofBodyHash(counter.body)),
    });
    const over = run(rival.state, { _tag: "j_window_over", peer: ALICE.id });
    expect(finalsOf(over.chain)).toEqual([]);
    expect(countersOf(over.chain)).toEqual(countersOf(heard.chain));
  });

  test("a dispute of another epoch is not answered, and an epoch that moves on forgets the answer", () => {
    const elsewhere = run(ackLost.bob, { ...openedBy(start), epoch: 1n } as JEvent);
    expect(countersOf(elsewhere.chain)).toEqual([]);
    const moved = run(heard.state, { _tag: "j_epoch", peer: ALICE.id, epoch: 1n, stored: 9n });
    expect(countersOf(moved.chain)).toEqual([]);
  });
});

describe("entity/signing R-DISPUTE-WATCH a dispute from the newest proof held is not answered", () => {
  test("both sides hold the same newest head: no counter", () => {
    const heard = run(committed.bob, openedBy(startOf(committed.alice)));
    expect(countersOf(heard.chain)).toEqual([]);
  });

  test("at the same nonce only a Left-authored proof answers a Right-authored one, as the chain ranks them", () => {
    const start = startOf(ackLost.alice);
    const counter = countersOf(run(ackLost.bob, openedBy(start)).chain)[0];
    if (counter?._tag !== "counter") return expect.unreachable("no counter");
    const same = { ...openedBy(start), nonce: counter.nonce };
    const byRight = { ...same, proposerIsLeft: false } as JEvent;
    const byLeft = { ...same, proposerIsLeft: true } as JEvent;
    expect(counter.proposerIsLeft).toBe(true);
    expect(countersOf(run(ackLost.bob, byRight).chain)).toHaveLength(1);
    expect(countersOf(run(ackLost.bob, byLeft).chain)).toEqual([]);
  });

  test("a dispute that opened with a proof above the one held is not answered", () => {
    const start = startOf(ackLost.alice);
    const higher = run(committed.bob, { ...openedBy(start), nonce: start.nonce + 5n } as JEvent);
    expect(countersOf(higher.chain)).toEqual([]);
  });

  test("the starter that is countered does not finalize with its opening proof", () => {
    const start = startOf(ackLost.alice);
    const asked = run(ackLost.alice, { _tag: "dispute", peer: BOB.id });
    const windowed = run(asked.state, { ...openedBy(start), peer: BOB.id, by: "left" } as JEvent);
    const countered = run(windowed.state, {
      _tag: "j_countered", peer: BOB.id, nonce: start.nonce + 2n, proposerIsLeft: true, bodyHash: OPENED_WITH.bodyHash,
    });
    const over = run(countered.state, { _tag: "j_window_over", peer: BOB.id });
    expect(finalsOf(over.chain)).toEqual([]);
    const uncountered = run(windowed.state, { _tag: "j_window_over", peer: BOB.id });
    expect(finalsOf(uncountered.chain)).toHaveLength(1);
  });
});

describe("entity/signing R-DISPUTE-WATCH the starter finalizes with the counter when the counterer does not", () => {
  const start = startOf(ackLost.alice);
  const counter = countersOf(run(ackLost.bob, openedBy(start)).chain)[0];
  if (counter?._tag !== "counter") throw new Error("no counter");
  const opened = (() => {
    const asked = run(ackLost.alice, { _tag: "dispute", peer: BOB.id });
    return run(asked.state, { ...openedBy(start), peer: BOB.id, by: "left" } as JEvent);
  })();
  const registered = (bodyHash: string): JEvent => ({
    _tag: "j_countered", peer: BOB.id, nonce: counter.nonce, proposerIsLeft: counter.proposerIsLeft, bodyHash,
  });
  const counterHash = must(proofBodyHash(counter.body));

  test("R-DISPUTE-WATCH once the window is over the starter finalizes with the registered counter it can rebuild", () => {
    const countered = run(opened.state, registered(counterHash));
    expect(finalsOf(countered.chain)).toEqual([]);
    const over = run(countered.state, { _tag: "j_window_over", peer: BOB.id });
    const [final, ...more] = finalsOf(over.chain);
    if (final?._tag !== "dispute_finalize" || more.length > 0) return expect.unreachable("not one finalize");
    expect([final.nonce, final.proposerIsLeft, final.startedByLeft]).toEqual([counter.nonce, true, true]);
    expect(final.body).toEqual(counter.body);
    expect(final.initial).toEqual({ nonce: start.nonce, bodyHash: must(proofBodyHash(start.body)) });
  });

  test("R-DISPUTE-WATCH the starter asks again at each frame, and stops once the dispute is over", () => {
    const over = run(run(opened.state, registered(counterHash)).state, { _tag: "j_window_over", peer: BOB.id });
    expect(finalsOf(run(over.state, { _tag: "resend_due", peer: BOB.id }).chain)).toHaveLength(1);
    const done = run(over.state, { _tag: "j_dispute_over", peer: BOB.id });
    expect(finalsOf(run(done.state, { _tag: "resend_due", peer: BOB.id }).chain)).toEqual([]);
  });

  test("R-DISPUTE-WATCH a registered counter whose body the starter cannot rebuild is not finalized with a guess", () => {
    const countered = run(opened.state, registered(OPENED_WITH.bodyHash));
    const over = run(countered.state, { _tag: "j_window_over", peer: BOB.id });
    expect(finalsOf(over.chain)).toEqual([]);
  });
});

describe("entity/signing R-DISPUTE-WATCH what the counter is made of, and what stops it", () => {
  const start = startOf(ackLost.alice);

  test("a proof signed over an older head than the Account's is not offered: its signature would not verify", () => {
    const stale = { ...ackLost.bob, proofs: committed.bob.proofs };
    expect(countersOf(run(ackLost.bob, openedBy(start)).chain)).toHaveLength(1);
    expect(countersOf(run(stale, openedBy(start)).chain)).toEqual([]);
  });

  test("a node with a dispute open against it does not start one of its own: the chain would skip it", () => {
    const against = run(ackLost.alice, { ...openedBy(start), peer: BOB.id, by: "right" } as JEvent);
    const asked = run(against.state, { _tag: "dispute", peer: BOB.id });
    expect(asked.chain.filter((a) => a._tag === "dispute_start")).toEqual([]);
    expect(asked.notices.map((n) => n._tag === "command_refused" && n.fault._tag)).toEqual(["dispute_pending"]);
  });

  test("R-DISPUTE-LAPSED a counter the Host dropped, because the chain would revert it, is not asked for again", () => {
    const heard = run(ackLost.bob, openedBy(start));
    const [counter] = countersOf(heard.chain);
    if (counter?._tag !== "counter") return expect.unreachable("no counter");
    const lapsed: JEvent = { _tag: "j_counter_lapsed", peer: ALICE.id, nonce: counter.nonce };
    const dropped = run(heard.state, lapsed);
    expect(countersOf(dropped.chain)).toEqual([]);
    expect(countersOf(run(dropped.state, openedBy(start)).chain)).toEqual([]);
  });

  test("R-DISPUTE-LAPSED a lapse of another nonce changes nothing, and a registered counter still finalizes", () => {
    const heard = run(ackLost.bob, openedBy(start));
    const [counter] = countersOf(heard.chain);
    if (counter?._tag !== "counter") return expect.unreachable("no counter");
    const other = run(heard.state, { _tag: "j_counter_lapsed", peer: ALICE.id, nonce: counter.nonce + 1n });
    expect(countersOf(other.chain)).toEqual(countersOf(heard.chain));
    const registered = run(heard.state, {
      _tag: "j_countered", peer: ALICE.id, nonce: counter.nonce, proposerIsLeft: counter.proposerIsLeft,
      bodyHash: must(proofBodyHash(counter.body)),
    });
    const late = run(registered.state, { _tag: "j_counter_lapsed", peer: ALICE.id, nonce: counter.nonce });
    const over = run(late.state, { _tag: "j_window_over", peer: ALICE.id });
    expect(finalsOf(over.chain)).toHaveLength(1);
  });
});
