// R-DISPUTE-FREEZE: while a dispute is open the Account seals nothing. A payment asked in the window is refused back
// to whoever asked, with a notice, and never zeroed by the epoch move that follows; a frame the peer sealed before it
// heard of the dispute is refused as frozen, and its payment commits in the epoch that follows. Alice is the Left of
// the Account and Bob its Right; Bob extends credit to Alice, who pays him.
import { describe, expect, test } from "bun:test";
import { viewOf } from "../../account/fixtures.ts";
import { OPENED_WITH } from "../../entity/fixtures.ts";
import type { EntityId, JAction, JEvent } from "../../entity/model.ts";
import {
  type Cluster, credit, entityOf, feed, hostOf, open, pay, rise, settle, start,
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

const epochOf = (peer: EntityId): JEvent => ({ _tag: "j_epoch", peer, epoch: 1n, stored: 5n });
const finalized = (c: Cluster): Cluster => feed(
  feed(feed(feed(c, ALICE, epochOf(BOB)), BOB, epochOf(ALICE)), ALICE, { _tag: "j_dispute_over", peer: BOB }),
  BOB, { _tag: "j_dispute_over", peer: ALICE });

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
