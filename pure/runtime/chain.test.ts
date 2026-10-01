// What the Runtime does with the chain's facts about an Account, which its Host reports (R-IMPLICIT-NONCE-FROM-CHAIN,
// the node watching its own disputes, R-NO-DEPOSIT-BEFORE-COSIGN, R-WINDOWS-NEVER-SHORTEN). Alice is the Left of the
// Account and Bob its Right; Bob extends credit and each frame he proposes is one more co-signed proof of the epoch.
import { describe, expect, test } from "bun:test";
import { viewOf } from "../account/fixtures.ts";
import type { ChainFacts, Command, EntityId, JAction, JEvent } from "../entity/model.ts";
import {
  type Cluster, credit, entityOf, feed, GOLD, hostOf, open, restarted, rise, settle, start,
} from "./fixtures.ts";

const ALICE = entityOf(1);
const BOB = entityOf(2);

const epochOf = (peer: EntityId, epoch: bigint, stored: bigint): JEvent => ({ _tag: "j_epoch", peer, epoch, stored });
const disputeBy = (peer: EntityId, epoch: bigint, by: "left" | "right"): JEvent =>
  ({ _tag: "j_dispute", peer, epoch, by });
const over = (peer: EntityId): JEvent => ({ _tag: "j_dispute_over", peer });

const opened = settle(feed(feed(start(viewOf(110n), viewOf(110n)), ALICE, open(BOB)), BOB, open(ALICE)));

/** The chain stands at `epoch` with stored nonce `stored` for both Hosts. */
const atEpoch = (c: Cluster, epoch: bigint, stored: bigint): Cluster =>
  feed(feed(c, ALICE, epochOf(BOB, epoch, stored)), BOB, epochOf(ALICE, epoch, stored));

/** Bob proposes one more credit and both sides co-sign it. */
const framed = (c: Cluster, limit: bigint): Cluster => settle(feed(c, BOB, credit(ALICE, limit)));

const factsAt = (c: Cluster, id: EntityId, peer: EntityId): ChainFacts | undefined =>
  hostOf(c, id).entities.get(id)?.chain.get(peer);

const counters = (c: Cluster): readonly bigint[] =>
  c.chain.flatMap((a: JAction) => (a._tag === "counter" ? [a.nonce] : []));

const counterActions = (c: Cluster): readonly JAction[] => c.chain.filter((a: JAction) => a._tag === "counter");

const noticesOf = (c: Cluster, id: EntityId) => hostOf(c, id).wal.flatMap((row) => row.notices);

const headOf = (c: Cluster, id: EntityId, peer: EntityId) => hostOf(c, id).entities.get(id)?.accounts.get(peer)?.head;

describe("runtime/chain the first proof of an epoch is two above the nonce the chain stores", () => {
  const epoch1 = atEpoch(opened, 1n, 5n);

  test("R-IMPLICIT-NONCE-FROM-CHAIN a dispute the peer starts is countered at stored + 2, then + 3", () => {
    const first = feed(framed(epoch1, 100n), ALICE, disputeBy(BOB, 1n, "right"));
    expect(counters(first)).toEqual([7n]);
    const second = framed(first, 150n);
    expect(counters(second)).toEqual([7n, 8n]);
  });

  test("R-IMPLICIT-NONCE-FROM-CHAIN the nonce is read from the chain again after an epoch ends, not derived", () => {
    const three = framed(framed(framed(epoch1, 100n), 110n), 120n);
    expect(factsAt(three, ALICE, BOB)).toMatchObject({ epoch: 1n, stored: 5n, frames: 3n });
    const finalized = atEpoch(three, 2n, 6n);
    const next = feed(framed(finalized, 130n), ALICE, disputeBy(BOB, 2n, "right"));
    expect(counters(next)).toEqual([8n]);
  });

  test("R-IMPLICIT-NONCE-FROM-CHAIN a report of an epoch the Entity already knows changes nothing", () => {
    const again = atEpoch(framed(epoch1, 100n), 1n, 9n);
    expect(factsAt(again, ALICE, BOB)).toMatchObject({ epoch: 1n, stored: 5n, frames: 1n });
    const older = atEpoch(again, 0n, 0n);
    expect(factsAt(older, ALICE, BOB)).toMatchObject({ epoch: 1n, stored: 5n, frames: 1n });
  });

  test("an epoch the chain moved on to starts with no co-signed frame: there is nothing to counter with yet", () => {
    const fresh = atEpoch(framed(epoch1, 100n), 2n, 6n);
    expect(factsAt(fresh, ALICE, BOB)?.frames).toBe(0n);
    expect(counterActions(feed(fresh, ALICE, disputeBy(BOB, 2n, "right")))).toHaveLength(0);
  });

  test("a frame is co-signed once by each side, the proposer on the ack and the receiver on the frame", () => {
    const one = framed(epoch1, 100n);
    expect(factsAt(one, ALICE, BOB)?.frames).toBe(1n);
    expect(factsAt(one, BOB, ALICE)?.frames).toBe(1n);
  });

  test("two frames proposed at once end as one history: both sides count the same co-signed frames", () => {
    const both = settle(feed(feed(epoch1, ALICE, credit(BOB, 100n)), BOB, credit(ALICE, 100n)));
    const alices = factsAt(both, ALICE, BOB)?.frames;
    expect(alices).toBe(factsAt(both, BOB, ALICE)?.frames);
    expect(alices).toBe(2n);
  });
});

describe("runtime/chain the node answers a dispute started against it until the chain says it is over", () => {
  const epoch1 = framed(atEpoch(opened, 1n, 5n), 100n);
  const disputed = feed(epoch1, ALICE, disputeBy(BOB, 1n, "right"));

  test("R-DISPUTE-WATCH every frame of the Entity restates the counter while the dispute is open", () => {
    expect(counters(disputed)).toEqual([7n]);
    const higher = rise(disputed, ALICE, 111n);
    expect(counters(higher)).toEqual([7n, 7n]);
    expect(counters(rise(higher, ALICE, 112n))).toEqual([7n, 7n, 7n]);
  });

  test("R-DISPUTE-WATCH the dispute being over, or the epoch moving on, ends it", () => {
    expect(counters(rise(feed(disputed, ALICE, over(BOB)), ALICE, 111n))).toEqual([7n]);
    expect(counters(rise(atEpoch(disputed, 2n, 8n), ALICE, 111n))).toEqual([7n]);
  });

  test("R-DISPUTE-WATCH the dispute of an epoch that is over is not the next epoch's, even once it has a proof", () => {
    const next = framed(atEpoch(disputed, 2n, 8n), 130n);
    expect(factsAt(next, ALICE, BOB)).toMatchObject({ epoch: 2n, frames: 1n, disputed: false });
    expect(counters(rise(next, ALICE, 111n))).toEqual([7n]);
  });

  test("R-DISPUTE-WATCH the counter carries the head of the frame its proof was signed over", () => {
    const counter = counterActions(disputed)[0];
    expect(counter?._tag === "counter" ? counter.head : undefined).toBe(headOf(disputed, ALICE, BOB));
    expect(headOf(disputed, ALICE, BOB)).not.toBeUndefined();
  });

  test("R-DISPUTE-WATCH a dispute Alice started, or one of another epoch, is not the Entity's to counter", () => {
    expect(counterActions(feed(epoch1, ALICE, disputeBy(BOB, 1n, "left")))).toHaveLength(0);
    expect(counterActions(feed(epoch1, ALICE, disputeBy(BOB, 2n, "right")))).toHaveLength(0);
  });

  test("R-DISPUTE-WATCH a Host that restarts keeps the dispute and is asked to counter again", () => {
    const back = restarted(disputed, ALICE);
    expect(factsAt(back, ALICE, BOB)).toEqual(factsAt(disputed, ALICE, BOB));
    expect(counters(back)).toEqual([7n, 7n]);
  });

  test("an event about an Account the Entity does not hold is told and changes nothing", () => {
    const stranger = feed(opened, ALICE, epochOf(entityOf(3), 1n, 1n));
    expect(noticesOf(stranger, ALICE).map((n) => n._tag)).toEqual(["unknown_peer"]);
    expect(hostOf(stranger, ALICE).entities.get(ALICE)?.chain.size).toBe(0);
  });
});

const deposit = (amount: bigint): Command => ({ _tag: "deposit", peer: BOB, token: GOLD, amount });
const windows = (left: bigint, right: bigint): Command =>
  ({ _tag: "set_windows", peer: BOB, windows: { left, right } });

describe("runtime/chain no deposit before the first co-signed frame, and windows never shorten", () => {
  test("R-NO-DEPOSIT-BEFORE-COSIGN at epoch 0 a deposit is refused until a frame is co-signed", () => {
    const early = feed(opened, ALICE, deposit(10n));
    expect(noticesOf(early, ALICE).map((n) => n._tag)).toEqual(["command_refused"]);
    expect(early.chain).toEqual([]);
    const later = feed(framed(opened, 100n), ALICE, deposit(10n));
    expect(later.chain).toEqual([{ _tag: "deposit", peer: BOB, token: GOLD, amount: 10n }]);
  });

  test("R-NO-DEPOSIT-BEFORE-COSIGN from epoch 1 on, the implicit proof is there: a deposit goes at once", () => {
    const fresh = feed(atEpoch(opened, 1n, 3n), ALICE, deposit(10n));
    expect(fresh.chain.map((a) => a._tag)).toEqual(["deposit"]);
  });

  test("R-NO-DEPOSIT-BEFORE-COSIGN a deposit of nothing is refused, and so is one to an Account not held", () => {
    const none = feed(framed(opened, 100n), ALICE, deposit(0n));
    expect(none.chain).toEqual([]);
    const nobody = feed(opened, ALICE, { _tag: "deposit", peer: entityOf(3), token: GOLD, amount: 1n });
    expect(noticesOf(nobody, ALICE).map((n) => n._tag)).toEqual(["command_refused"]);
  });

  test("a chain command about an Account the Entity does not hold is refused for that, and keeps no facts", () => {
    const stranger = entityOf(3);
    const refused = feed(framed(opened, 100n), ALICE, { _tag: "deposit", peer: stranger, token: GOLD, amount: 1n });
    expect(refused.chain).toEqual([]);
    const faults = noticesOf(refused, ALICE).flatMap((n) => (n._tag === "command_refused" ? [n.fault._tag] : []));
    expect(faults).toEqual(["no_account"]);
    const set = feed(opened, ALICE, { _tag: "set_windows", peer: stranger, windows: { left: 60n, right: 60n } });
    expect(hostOf(set, ALICE).entities.get(ALICE)?.chain.size).toBe(0);
  });

  test("R-WINDOWS-NEVER-SHORTEN windows may lengthen in an epoch and not shorten once a proof carries them", () => {
    const first = framed(feed(opened, ALICE, windows(60n, 60n)), 100n);
    expect(factsAt(first, ALICE, BOB)?.windows).toEqual({ left: 60n, right: 60n });
    const longer = feed(first, ALICE, windows(300n, 60n));
    expect(factsAt(longer, ALICE, BOB)?.windows).toEqual({ left: 300n, right: 60n });
    const shorter = feed(longer, ALICE, windows(300n, 59n));
    expect(factsAt(shorter, ALICE, BOB)?.windows).toEqual({ left: 300n, right: 60n });
    expect(noticesOf(shorter, ALICE).map((n) => n._tag)).toEqual(["command_refused"]);
  });

  test("R-WINDOWS-NEVER-SHORTEN before a proof carries them, and in a new epoch, the policy may be set freely", () => {
    const early = feed(feed(opened, ALICE, windows(300n, 300n)), ALICE, windows(60n, 60n));
    expect(factsAt(early, ALICE, BOB)?.windows).toEqual({ left: 60n, right: 60n });
    const signed = framed(feed(opened, ALICE, windows(300n, 300n)), 100n);
    const renewed = feed(atEpoch(signed, 1n, 4n), ALICE, windows(60n, 60n));
    expect(factsAt(renewed, ALICE, BOB)?.windows).toEqual({ left: 60n, right: 60n });
  });

  test("R-WINDOWS-NEVER-SHORTEN a window of zero seconds, or beyond the proof's uint32, is refused", () => {
    expect(factsAt(feed(opened, ALICE, windows(0n, 60n)), ALICE, BOB)).toBeUndefined();
    expect(factsAt(feed(opened, ALICE, windows(60n, 2n ** 32n)), ALICE, BOB)).toBeUndefined();
  });
});
