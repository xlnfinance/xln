// What the Runtime does with the chain's facts about an Account, which its Host reports (R-IMPLICIT-NONCE-FROM-CHAIN,
// the node watching its own disputes, R-NO-DEPOSIT-BEFORE-COSIGN, R-WINDOWS-NEVER-SHORTEN). Alice is the Left of the
// Account and Bob its Right; Bob extends credit and each frame he proposes is one more co-signed proof of the epoch.
import { describe, expect, test } from "bun:test";
import { signing, tokenOf, viewOf } from "../account/fixtures.ts";
import { MAX_AMOUNT } from "../account/ledger.ts";
import { frameDigest } from "../account/proof/signing.ts";
import { accountKey } from "../chain/proof/deployment.ts";
import {
  emptyEntity, type ChainFacts, type Command, type CosignOp, type EntityId, type JAction, type JEvent,
} from "../entity/model.ts";
import { recover } from "./tick.ts";
import {
  type Cluster, credit, entityOf, feed, GOLD, hostOf, open, pay, restarted, rise, settle, start,
} from "./fixtures.ts";

const ALICE = entityOf(1);
const BOB = entityOf(2);

const epochOf = (peer: EntityId, epoch: bigint, stored: bigint): JEvent => ({ _tag: "j_epoch", peer, epoch, stored });
const disputeBy = (peer: EntityId, epoch: bigint, by: "left" | "right"): JEvent =>
  ({ _tag: "j_dispute", peer, epoch, by, nonce: 3n, timeout: 5n });
const over = (peer: EntityId): JEvent => ({ _tag: "j_dispute_over", peer, finalized: false });

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
    expect(counters(next)).toEqual([11n]);
  });

  test("R-IMPLICIT-NONCE-FROM-CHAIN a dispute is countered at the nonce the newest frame was signed at", () => {
    const leftFramed = settle(feed(epoch1, ALICE, credit(BOB, 100n)));
    const first = feed(leftFramed, ALICE, disputeBy(BOB, 1n, "right"));
    expect(counters(first)).toEqual([8n]);
    const rightFramed = framed(leftFramed, 110n);
    expect(counters(feed(rightFramed, ALICE, disputeBy(BOB, 1n, "right")))).toEqual([9n]);
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

  test("an event about an Account the Entity does not hold is told and its epoch is kept for one opened later", () => {
    const stranger = feed(opened, ALICE, epochOf(entityOf(3), 1n, 1n));
    expect(noticesOf(stranger, ALICE).map((n) => n._tag)).toEqual(["unknown_peer"]);
    const kept = hostOf(stranger, ALICE).entities.get(ALICE)?.chain;
    expect([kept?.size, kept?.get(entityOf(3))?.epoch]).toEqual([1, 1n]);
    expect(hostOf(stranger, ALICE).entities.get(ALICE)?.accounts.has(entityOf(3))).toBe(false);
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

  test("R-FUND a fund asks the chain at once: it names no peer and waits for no Account or frame", () => {
    const funded = feed(start(viewOf(110n), viewOf(110n)), ALICE, { _tag: "fund", token: GOLD, amount: 10n });
    expect(funded.chain).toEqual([{ _tag: "fund", token: GOLD, amount: 10n }]);
    expect(noticesOf(funded, ALICE)).toEqual([]);
  });

  test("R-FUND a fund of nothing, or of more than an Account can hold, is refused with notice and asks nothing", () => {
    const base = start(viewOf(110n), viewOf(110n));
    [0n, -1n, MAX_AMOUNT + 1n].forEach((amount) => {
      const refused = feed(base, ALICE, { _tag: "fund", token: GOLD, amount });
      expect(refused.chain).toEqual([]);
      const faults = noticesOf(refused, ALICE).flatMap((n) => (n._tag === "command_refused" ? [n.fault] : []));
      expect(faults).toEqual([{ _tag: "bad_fund", amount }]);
    });
    expect(feed(base, ALICE, { _tag: "fund", token: GOLD, amount: MAX_AMOUNT }).chain).toHaveLength(1);
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

// What a Host's Runtime does about collateral across the whole path: the payments of a real run, then a withdrawal
// (R-C2R-FOLD), then the silence while the signature waits for the chain (R-COSIGN-FREEZE), through a crash.
/** Bob extends credit to Alice, who has paid nothing: the Account's offdelta is zero on both Hosts. */
const creditedOnly = settle(feed(opened, BOB, credit(ALICE, 100n)));

/** Alice then pays Bob 10 of that credit, so that the offdelta is -10 on both Hosts. */
const afterPayment = settle(feed(creditedOnly, ALICE, pay(BOB, 10n)));

const withdraw = (amount: bigint): Command => ({ _tag: "withdraw", peer: BOB, token: GOLD, amount });

const tags = (c: Cluster) => c.chain.map((a) => a._tag);

const committed = (c: Cluster, id: EntityId) =>
  hostOf(c, id).entities.get(id)?.accounts.get(id === ALICE ? BOB : ALICE)?.head;

describe("runtime/chain R-C2R-FOLD a withdrawal after payments is a settlement that folds them", () => {
  test("R-C2R-FOLD with no payment made a withdrawal goes as a C2R", () => {
    expect(creditedOnly.chain).toEqual([]);
    expect(tags(feed(creditedOnly, ALICE, withdraw(30n)))).toEqual(["c2r"]);
  });

  test("R-C2R-FOLD with a payment made the withdrawal is a settlement carrying the payment's offdelta", () => {
    const sent = feed(afterPayment, ALICE, withdraw(30n));
    expect(sent.chain).toEqual([{
      _tag: "settle", peer: BOB, serial: 1n, token: GOLD, amount: 30n, folds: [{ token: GOLD, offdelta: -10n }],
    }]);
  });

  test("R-C2R-FOLD Bob, asked by Alice for a C2R after a payment, refuses it with notice and signs nothing", () => {
    const op: CosignOp = { _tag: "c2r", token: GOLD, amount: 30n };
    const asked = feed(afterPayment, BOB, { _tag: "cosign_ask", from: ALICE, op });
    expect(asked.chain).toEqual([]);
    const notices = hostOf(asked, BOB).wal.flatMap((row) => row.notices);
    expect(notices.map((n) => n._tag)).toEqual(["cosign_refused"]);
  });
});

describe("runtime/chain R-COSIGN-FREEZE after the signature nothing is proposed until the epoch moves", () => {
  const signed = feed(afterPayment, ALICE, withdraw(30n));
  const queued = feed(signed, ALICE, pay(BOB, 5n));

  test("R-COSIGN-FREEZE a payment made after the signature is not proposed: Bob hears nothing", () => {
    expect(queued.inflight).toEqual(signed.inflight);
    expect(hostOf(queued, ALICE).entities.get(ALICE)?.accounts.get(BOB)?.mempool).toHaveLength(1);
  });

  test("R-COSIGN-FREEZE once the chain has moved the epoch on, the payment goes out and both sides commit it", () => {
    const landed = settle(atEpoch(queued, 1n, 6n));
    expect(committed(landed, ALICE)).toBe(committed(landed, BOB));
    expect(committed(landed, ALICE)).not.toBe(committed(queued, ALICE));
  });

  test("R-COSIGN-FREEZE a frame Bob proposes while Alice's signature is out is refused, his retry then commits", () => {
    const raced = settle(feed(signed, BOB, credit(ALICE, 150n)));
    expect(committed(raced, BOB)).toBe(committed(signed, BOB));
    expect(hostOf(raced, BOB).entities.get(BOB)?.accounts.get(ALICE)?.mempool).toHaveLength(1);
    const landed = settle(rise(atEpoch(raced, 1n, 6n), BOB, 111n));
    expect(committed(landed, BOB)).toBe(committed(landed, ALICE));
    expect(committed(landed, BOB)).not.toBe(committed(raced, BOB));
  });

  test("R-COSIGN-FREEZE a Host that crashes after the signature comes back frozen and asks for it again", () => {
    const back = restarted(queued, ALICE);
    const account = hostOf(back, ALICE).entities.get(ALICE)?.accounts.get(BOB);
    expect(account?.pending).toBeUndefined();
    expect(account?.mempool).toHaveLength(1);
    expect(tags(back)).toEqual(["settle", "settle"]);
    expect(hostOf(back, ALICE).entities.get(ALICE)?.chain.get(BOB)?.frozen).toBe(true);
  });
});

// Review A of PR 100: a replay sees every field of a signature the Entity asked the chain for. A row whose C2R or
// settlement names another peer, serial, token, amount or fold does not replay: the Runtime halts on it (R-DURABLE).
describe("runtime/chain review A: a replay sees every field of a C2R and of a settlement", () => {
  const diverged = (height: bigint) => ({ ok: false as const, error: { _tag: "replay_diverged" as const, height } });

  /** Alice's WAL with the first action of its last row changed as the test says; what replaying it gives. */
  const replayed = (c: Cluster, change: Partial<JAction>) => {
    const alice = hostOf(c, ALICE);
    const last = alice.wal.at(-1) ?? expect.unreachable("no row");
    const action = last.chain[0] ?? expect.unreachable("no action in the last row");
    const row = { ...last, chain: [{ ...action, ...change } as JAction] };
    const result = recover(alice.setup, [emptyEntity(ALICE)], [...alice.wal.slice(0, -1), row]);
    return { height: last.height, result };
  };

  const asC2r = feed(creditedOnly, ALICE, withdraw(30n));
  const asSettle = feed(afterPayment, ALICE, withdraw(30n));

  test("control: the rows as they were made replay", () => {
    expect(replayed(asC2r, {}).result.ok).toBe(true);
    expect(replayed(asSettle, {}).result.ok).toBe(true);
  });

  test.each([
    ["peer", { peer: entityOf(3) }], ["serial", { serial: 2n }], ["token", { token: tokenOf(2n) }],
    ["amount", { amount: 31n }],
  ] as const)("R-DURABLE a WAL whose C2R names another %s does not replay", (_field, change) => {
    const { height, result } = replayed(asC2r, change);
    expect(result).toEqual(diverged(height));
  });

  test.each([
    ["peer", { peer: entityOf(3) }], ["serial", { serial: 2n }], ["token", { token: tokenOf(2n) }],
    ["amount", { amount: 31n }],
    ["fold's token", { folds: [{ token: tokenOf(2n), offdelta: -10n }] }],
    ["fold's offdelta", { folds: [{ token: GOLD, offdelta: -11n }] }],
    ["folds", { folds: [] }],
  ] as const)("R-DURABLE a WAL whose settlement names another %s does not replay", (_field, change) => {
    const { height, result } = replayed(asSettle, change);
    expect(result).toEqual(diverged(height));
  });
});

describe("runtime/chain R-FRAME-EPOCH a frame is judged only under its own epoch and first nonce", () => {
  const heardByAlice = feed(opened, ALICE, epochOf(BOB, 1n, 5n));
  const proposed = settle(feed(heardByAlice, ALICE, credit(BOB, 100n)));
  const due = (c: Cluster, id: EntityId, peer: EntityId): Cluster => feed(c, id, { _tag: "resend_due", peer });
  const replicaOf = (c: Cluster, id: EntityId) =>
    hostOf(c, id).entities.get(id)?.accounts.get(id === ALICE ? BOB : ALICE) ?? expect.unreachable("no Account");

  test("Bob, who has not seen the epoch move, refuses Alice's frame unjudged and keeps his head", () => {
    expect(replicaOf(proposed, BOB).head).toBe(replicaOf(opened, BOB).head);
    expect(replicaOf(proposed, BOB).height).toBe(0);
  });

  test("Alice parks the frame: it stays pending, its tx is neither dropped nor told to anyone", () => {
    expect(replicaOf(proposed, ALICE).pending).toBeDefined();
    expect(replicaOf(proposed, ALICE).mempool).toEqual([]);
    expect(replicaOf(proposed, ALICE).refused).toEqual([]);
    expect(noticesOf(proposed, ALICE)).toEqual([]);
  });

  test("a peer that lags for ninety J heights costs one signed proof: nothing is dropped, nothing is capped", () => {
    const lagged = Array.from({ length: 90 }, (_, i) => 111n + BigInt(i))
      .reduce((c, height) => settle(due(rise(c, ALICE, height), ALICE, BOB)), proposed);
    expect(replicaOf(lagged, ALICE).unsuperseded).toHaveLength(1);
    expect(replicaOf(lagged, ALICE).pending).toBeDefined();
    expect(noticesOf(lagged, ALICE)).toEqual([]);
    const landed = settle(due(feed(lagged, BOB, epochOf(ALICE, 1n, 5n)), ALICE, BOB));
    const [alice, bob] = [replicaOf(landed, ALICE), replicaOf(landed, BOB)];
    expect([alice.height, bob.height, alice.head === bob.head, alice.unsuperseded]).toEqual([1, 1, true, []]);
  });

  test("once Bob sees the epoch move too, the same frame sent again commits under the Account's own context", () => {
    const landed = settle(due(feed(proposed, BOB, epochOf(ALICE, 1n, 5n)), ALICE, BOB));
    const [alice, bob] = [replicaOf(landed, ALICE), replicaOf(landed, BOB)];
    expect([alice.height, bob.height, alice.head === bob.head]).toEqual([1, 1, true]);
    const key = accountKey(ALICE, BOB);
    if (!key.ok) return expect.unreachable("no account key");
    const context = { ...signing, accountKey: key.value, ondeltaEpoch: 1n, firstNonce: 7n };
    const digest = frameDigest(context, alice.used, "left", alice.state);
    expect(digest.ok && digest.value).toBe(alice.head);
  });

  test("the same epoch with another stored nonce: Bob refuses, Alice waits, no head splits", () => {
    const split = feed(feed(opened, ALICE, epochOf(BOB, 1n, 5n)), BOB, epochOf(ALICE, 1n, 6n));
    const sent = settle(due(settle(feed(split, ALICE, credit(BOB, 100n))), ALICE, BOB));
    expect([replicaOf(sent, BOB).height, replicaOf(sent, BOB).head]).toEqual([0, replicaOf(opened, BOB).head]);
    expect([replicaOf(sent, ALICE).height, replicaOf(sent, ALICE).pending === undefined]).toEqual([0, false]);
    expect([noticesOf(sent, ALICE), noticesOf(sent, BOB)]).toEqual([[], []]);
  });

  test("a frame of mine acked after my view moved on is committed but is no proof of the new epoch", () => {
    const learned = feed(feed(opened, BOB, credit(ALICE, 100n)), BOB, epochOf(ALICE, 1n, 5n));
    const done = settle(learned);
    expect([replicaOf(done, ALICE).height, replicaOf(done, BOB).height]).toEqual([1, 1]);
    expect(replicaOf(done, ALICE).head).toBe(replicaOf(done, BOB).head);
    expect(factsAt(done, BOB, ALICE)).toMatchObject({ epoch: 1n, stored: 5n, frames: 0n });
    expect(counterActions(feed(done, BOB, disputeBy(ALICE, 1n, "left")))).toEqual([]);
    const later = framed(feed(done, ALICE, epochOf(BOB, 1n, 5n)), 150n);
    expect(factsAt(later, BOB, ALICE)).toMatchObject({ epoch: 1n, stored: 5n, frames: 1n });
  });
});
