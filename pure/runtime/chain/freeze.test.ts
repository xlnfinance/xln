// R-DISPUTE-FREEZE: while a dispute is open the Account seals nothing. A payment asked in the window is refused back
// to whoever asked, with a notice, and never zeroed by the epoch move that follows; a frame the peer sealed before it
// heard of the dispute is refused as frozen, and its payment commits in the epoch that follows. Alice is the Left of
// the Account and Bob its Right; Bob extends credit to Alice, who pays him.
import { describe, expect, test } from "bun:test";
import { viewOf } from "../../account/fixtures.ts";
import { proofBodyHash } from "../../chain/proof/proof.ts";
import { OPENED_WITH } from "../../entity/fixtures.ts";
import type { EntityId, JAction, JEvent } from "../../entity/model.ts";
import {
  type Cluster, credit, deliver, entityOf, feed, hostOf, open, pay, rise, settle, start,
} from "../fixtures.ts";

const ALICE = entityOf(1);
const BOB = entityOf(2);

const opened = settle(feed(feed(start(viewOf(110n), viewOf(110n)), ALICE, open(BOB)), BOB, open(ALICE)));
const paid = settle(feed(settle(feed(opened, BOB, credit(ALICE, 100n))), ALICE, pay(BOB, 40n)));

/** Alice asks for the dispute from the head both hold; the chain's start is the nonce her Entity asked with. */
const asked = feed(paid, ALICE, { _tag: "dispute", peer: BOB });
const NONCE = (() => {
  const [first] = asked.chain.filter((a: JAction) => a._tag === "dispute_start");
  return first?._tag === "dispute_start" ? first.nonce : expect.unreachable("no start");
})();

const windowOf = (peer: EntityId): JEvent =>
  ({ _tag: "j_dispute", peer, epoch: 0n, by: "left", nonce: NONCE, timeout: 500n, ...OPENED_WITH });
/** Both Entities hear the chain's start: Alice's gives her record its window, Bob has a dispute against him. */
const heardBy = (c: Cluster, ...ids: readonly EntityId[]): Cluster =>
  ids.reduce((acc, id) => feed(acc, id, windowOf(id === ALICE ? BOB : ALICE)), c);

const refusals = (c: Cluster, id: EntityId) =>
  hostOf(c, id).wal.flatMap((row) => row.notices.map((n) => (n._tag === "command_refused" ? n.fault._tag : n._tag)));
const accountOf = (c: Cluster, id: EntityId) =>
  hostOf(c, id).entities.get(id)?.accounts.get(id === ALICE ? BOB : ALICE) ?? expect.unreachable("no Account");
const offdeltas = (c: Cluster) => [ALICE, BOB].map((id) => [...accountOf(c, id).state.ledgers.values()][0]?.offdelta);
const heads = (c: Cluster) => [ALICE, BOB].map((id) => accountOf(c, id).head);

/** The hash of the body the latest start opened with: the proof a timeout finalize pays by. */
const openingHash = (c: Cluster): string => {
  const [last] = c.chain.filter((a: JAction) => a._tag === "dispute_start").slice(-1);
  const body = last?._tag === "dispute_start" ? last.body : undefined;
  const hash = body === undefined ? undefined : proofBodyHash(body);
  return hash?.ok === true ? hash.value : expect.unreachable("no body hash");
};
const epochOf = (peer: EntityId, hash: string): JEvent =>
  ({ _tag: "j_epoch", peer, epoch: 1n, stored: 5n, finalBodyHash: hash });
const finalized = (c: Cluster): Cluster => {
  const hash = openingHash(c);
  return feed(
    feed(feed(feed(c, ALICE, epochOf(BOB, hash)), BOB, epochOf(ALICE, hash)),
      ALICE, { _tag: "j_dispute_over", peer: BOB }),
    BOB, { _tag: "j_dispute_over", peer: ALICE });
};

describe("runtime/chain R-DISPUTE-FREEZE a payment asked while the dispute is open is refused back, not zeroed", () => {
  const frozen = heardBy(asked, ALICE, BOB);

  test("R-DISPUTE-FREEZE both sides' payments are refused with a notice and no frame goes out", () => {
    const both = settle(feed(feed(frozen, ALICE, pay(BOB, 5n)), BOB, pay(ALICE, 3n)));
    expect(refusals(both, ALICE).filter((tag) => tag === "account_disputed")).toEqual(["account_disputed"]);
    expect(refusals(both, BOB).filter((tag) => tag === "account_disputed")).toEqual(["account_disputed"]);
    expect([accountOf(both, ALICE).pending, accountOf(both, BOB).pending]).toEqual([undefined, undefined]);
    expect(heads(both)).toEqual(heads(frozen));
    expect(offdeltas(both)).toEqual(offdeltas(frozen));
  });

  test("R-DISPUTE-FREEZE after the finalize the Account is as the chain left it, without the refused payment", () => {
    const refused = settle(feed(frozen, ALICE, pay(BOB, 5n)));
    const after = settle(finalized(refused));
    expect(offdeltas(after)).toEqual([0n, 0n]);
    expect(heads(after)).toEqual(heads(frozen));
    const again = settle(feed(after, ALICE, pay(BOB, 5n)));
    expect(offdeltas(again)).toEqual([-5n, -5n]);
    expect(refusals(again, ALICE).filter((tag) => tag === "account_disputed")).toEqual(["account_disputed"]);
  });

  test("R-DISPUTE-FREEZE a frame a peer sealed before it heard of the dispute is refused as frozen", () => {
    const bobStarted = feed(paid, BOB, { _tag: "dispute", peer: ALICE });
    const sealed = settle(feed(bobStarted, ALICE, pay(BOB, 5n)));
    expect(offdeltas(sealed)).toEqual(offdeltas(paid));
    expect(heads(sealed)).toEqual(heads(paid));
    expect([accountOf(sealed, ALICE).pending, accountOf(sealed, ALICE).mempool.length]).toEqual([undefined, 1]);
    expect(refusals(sealed, ALICE)).toEqual([]);
    const moved = finalized(sealed);
    const retried = settle(rise(settle(feed(moved, ALICE, { _tag: "resend_due", peer: BOB })), ALICE, 111n));
    expect(offdeltas(retried)).toEqual([-5n, -5n]);
    expect(heads(retried)[0]).toBe(heads(retried)[1]);
  });
});

describe("runtime/chain R-DISPUTE-FREEZE a frame sealed before the dispute is not resent or acked into a head", () => {
  /** Alice's payment is with Bob, who acks it; the ack is on the link when Alice asks for the dispute. */
  const inFlight = (() => {
    const ackOnLink = deliver(feed(paid, ALICE, pay(BOB, 5n)));
    expect(ackOnLink.inflight.map((m) => m.msg._tag)).toEqual(["ack"]);
    return feed(ackOnLink, ALICE, { _tag: "dispute", peer: BOB });
  })();
  const startNonce = (() => {
    const [first] = inFlight.chain.filter((a: JAction) => a._tag === "dispute_start").slice(-1);
    return first?._tag === "dispute_start" ? first.nonce : expect.unreachable("no start");
  })();

  test("R-DISPUTE-FREEZE an ack that arrives in the dispute commits nothing: the frame stays pending", () => {
    const head = accountOf(inFlight, ALICE).head;
    const acked = deliver(inFlight);
    expect(accountOf(acked, ALICE).pending).toBeDefined();
    expect(accountOf(acked, ALICE).head).toBe(head);
  });

  test("R-DISPUTE-FREEZE the timer does not send the pending frame again while the dispute is open", () => {
    const acked = deliver(inFlight);
    const timed = feed(acked, ALICE, { _tag: "resend_due", peer: BOB });
    expect(timed.inflight).toEqual([]);
  });

  test("R-DISPUTE-FREEZE when the dispute lapses the frame is sent again, Bob acks it again and it commits", () => {
    const lapsed = feed(deliver(inFlight), ALICE, { _tag: "j_start_lapsed", peer: BOB, nonce: startNonce });
    const done = settle(feed(lapsed, ALICE, { _tag: "resend_due", peer: BOB }));
    expect(accountOf(done, ALICE).pending).toBeUndefined();
    expect(heads(done)[0]).toBe(heads(done)[1]);
    expect(offdeltas(done)).toEqual([-45n, -45n]);
  });
});
