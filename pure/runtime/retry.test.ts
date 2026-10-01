// A peer refuses a frame for a fault that can pass with its view of J (R-FRAME-REFUSAL): Alice's view of the chain is
// ahead of Bob's, so Bob refuses her lock for a deadline too far out. What the Runtime owes: Alice waits for her view
// to move before she tries again (retry pacing), a payer is released when the tx is dropped (R-REFUSED-RELEASES-PAYER),
// and a restart on either side loses nothing of the round: the WAL replays the attempt, the wait and what was declined.
import { describe, expect, test } from "bun:test";
import { holdOf, viewOf } from "../account/fixtures.ts";
import { provisionalFrameHash } from "../account/frame/account.ts";
import { type FrameHash, MAX_ATTEMPTS } from "../account/frame/frame.ts";
import { ledgerOf } from "../account/state.ts";
import { type Command, emptyEntity, type EntityId } from "../entity/model.ts";
import {
  type Cluster, credit, deliver, entityOf, feed, GOLD, heightAt, hostOf, inputFor, open, pay, restarted, rise, settle,
  setup, stamp, start, tick,
} from "./fixtures.ts";
import { messageId, startRuntime } from "./tick.ts";

const ALICE = entityOf(1);
const BOB = entityOf(2);

/** Alice sees the chain at 110, Bob at 100: 120 is within Alice's reach and beyond Bob's (100 + 10 + 2). */
const DEADLINE = 120n;

const lock = (amount: bigint): Command =>
  ({ _tag: "lock", peer: BOB, token: GOLD, hold: holdOf("left", amount, 1n, DEADLINE) });

const opened = settle(feed(feed(start(viewOf(110n), viewOf(100n)), ALICE, open(BOB)), BOB, open(ALICE)));
const credited = settle(feed(opened, BOB, credit(ALICE, 100n)));

/** Alice's lock reaches Bob and Bob's refusal reaches Alice: one refusal handled. */
const refused = settle(feed(credited, ALICE, lock(100n)));

const accountOf = (c: Cluster, id: EntityId, peer: EntityId) =>
  hostOf(c, id).entities.get(id)?.accounts.get(peer) ?? expect.unreachable("no account");

const waitingOf = (c: Cluster, id: EntityId) => hostOf(c, id).entities.get(id)?.waiting.get(id === ALICE ? BOB : ALICE);

/** Alice's view rises one height and the link settles; `times` rounds of it, Bob's view where it was. */
const climbing = (c: Cluster, view: bigint, times: number): Cluster =>
  (times === 0 ? c : climbing(settle(rise(c, ALICE, view + 1n)), view + 1n, times - 1));

const noticesOf = (c: Cluster, id: EntityId) => hostOf(c, id).wal.flatMap((row) => row.notices);

describe("runtime/refusal a refused frame is taken back, waited out and tried again", () => {
  test("R-FRAME-REFUSAL a retryable refusal takes Alice's frame back, queues her tx and raises her attempt", () => {
    const alice = accountOf(refused, ALICE, BOB);
    expect(alice.pending).toBeUndefined();
    expect(alice.mempool.map((tx) => tx._tag)).toEqual(["lock"]);
    expect(alice.attempt).toBe(1);
    expect(refused.inflight).toEqual([]);
    expect(noticesOf(refused, ALICE)).toEqual([]);
  });

  test("retry pacing: Alice waits at the view she was refused at, and proposes again only when it is higher", () => {
    expect(waitingOf(refused, ALICE)).toBe(viewOf(110n));
    const same = rise(refused, ALICE, 110n);
    expect(same.inflight).toEqual([]);
    const higher = rise(refused, ALICE, 111n);
    expect(higher.inflight.map((o) => messageId(o.msg).split(" ")[0])).toEqual(["frame"]);
    expect(waitingOf(higher, ALICE)).toBeUndefined();
  });

  test("the head moving ends the wait: Bob's own frame commits and Alice proposes her queued lock at once", () => {
    const heard = deliver(feed(refused, BOB, credit(ALICE, 150n)));
    expect(heard.inflight.map((o) => messageId(o.msg).split(" ")[0])).toEqual(["ack", "frame"]);
    expect(accountOf(heard, ALICE, BOB).attempt).toBe(0);
  });

  test("the view only rises: a lower height from the Host leaves Alice's view where it was", () => {
    expect(hostOf(rise(refused, ALICE, 90n), ALICE).view).toBe(viewOf(110n));
    expect(hostOf(rise(refused, ALICE, 115n), ALICE).view).toBe(viewOf(115n));
  });

  test("retry pacing: a retry that Bob refuses again waits at the new view with the attempt raised again", () => {
    const again = settle(rise(refused, ALICE, 111n));
    expect(accountOf(again, ALICE, BOB).attempt).toBe(2);
    expect(waitingOf(again, ALICE)).toBe(viewOf(111n));
    expect(accountOf(again, BOB, ALICE).declined?.attempt).toBe(1);
  });

  test("once Bob's view has caught up the retry commits on both sides and the wait and the attempt are gone", () => {
    const caught = settle(rise(refused, BOB, 111n));
    const done = settle(rise(caught, ALICE, 111n));
    const alice = accountOf(done, ALICE, BOB);
    const bob = accountOf(done, BOB, ALICE);
    expect(alice.head).toBe(bob.head);
    expect(alice.attempt).toBe(0);
    expect(bob.declined).toBeUndefined();
    expect(waitingOf(done, ALICE)).toBeUndefined();
    expect(ledgerOf(bob.state, GOLD).holds.map((h) => h.deadline)).toEqual([DEADLINE as never]);
    expect(ledgerOf(alice.state, GOLD).holds).toEqual(ledgerOf(bob.state, GOLD).holds);
  });
});

describe("runtime/refusal a frame whose attempt nobody can count is refused with notice", () => {
  test("R-NOTICE Bob's frame with an attempt of -1 is refused to Alice with the outcome, and changes nothing", () => {
    const sent = feed(refused, BOB, credit(ALICE, 50n));
    const [theirs] = sent.inflight;
    const msg = theirs?.msg ?? expect.unreachable("no frame");
    const bent = msg._tag === "frame" ? { ...msg, frame: { ...msg.frame, attempt: -1 } } : msg;
    const heard = feed({ ...sent, inflight: [] }, ALICE, { _tag: "peer_message", from: BOB, msg: bent });
    expect(noticesOf(heard, ALICE).map((n) => n._tag)).toEqual(["message_refused"]);
    expect(accountOf(heard, ALICE, BOB).head).toBe(accountOf(refused, ALICE, BOB).head);
  });
});

describe("runtime/refusal R-REFUSED-RELEASES-PAYER a dropped tx gives its payer the capacity back", () => {
  const dropped = climbing(refused, 110n, MAX_ATTEMPTS);

  test("R-REFUSED-RELEASES-PAYER a lock waiting to be retried holds Alice's capacity against a payment", () => {
    const tried = settle(feed(refused, ALICE, pay(BOB, 1n)));
    expect(noticesOf(tried, ALICE).map((n) => n._tag)).toEqual(["command_refused"]);
  });

  test("R-REFUSED-RELEASES-PAYER MAX_ATTEMPTS refusals drop the lock with a notice and leave nothing queued", () => {
    const alice = accountOf(dropped, ALICE, BOB);
    expect(alice.mempool).toEqual([]);
    expect(alice.pending).toBeUndefined();
    expect(noticesOf(dropped, ALICE).map((n) => n._tag)).toEqual(["tx_refused"]);
    expect(dropped.inflight).toEqual([]);
  });

  test("R-REFUSED-RELEASES-PAYER the capacity is Alice's again and a payment commits on both sides", () => {
    const paid = settle(feed(dropped, ALICE, pay(BOB, 100n)));
    expect(ledgerOf(accountOf(paid, BOB, ALICE).state, GOLD).offdelta).toBe(-100n);
    expect(accountOf(paid, ALICE, BOB).head).toBe(accountOf(paid, BOB, ALICE).head);
    expect(accountOf(paid, ALICE, BOB).attempt).toBe(0);
  });
});

describe("runtime/refusal a restart loses nothing of the refusal round", () => {
  test("Alice restarted after a refusal has the same attempt, the same wait and the same queued tx", () => {
    const back = settle(restarted(refused, ALICE));
    expect(hostOf(back, ALICE).entities).toEqual(hostOf(refused, ALICE).entities);
    expect(accountOf(back, ALICE, BOB).attempt).toBe(1);
    expect(waitingOf(back, ALICE)).toBe(viewOf(110n));
  });

  test("Alice restarted keeps waiting: the same view proposes nothing, a higher one proposes with her attempt", () => {
    const back = settle(restarted(refused, ALICE));
    expect(rise(back, ALICE, 110n).inflight).toEqual([]);
    expect(rise(back, ALICE, 111n).inflight.map((o) => messageId(o.msg).split(" ")[0])).toEqual(["frame"]);
  });

  test("Alice lost the refusal and what she re-sent: her resend timer brings it back and the round goes on", () => {
    const asked = feed(credited, ALICE, lock(100n));
    const [lockFrame] = asked.inflight;
    const msg = lockFrame?.msg ?? expect.unreachable("no frame");
    const answered = feed({ ...asked, inflight: [] }, BOB, { _tag: "peer_message", from: ALICE, msg });
    expect(answered.inflight.map((o) => messageId(o.msg).split(" ")[0])).toEqual(["refusal"]);
    const crashed = { ...restarted(answered, ALICE), inflight: [] };
    expect(accountOf(crashed, ALICE, BOB).pending).toBeDefined();
    const resent = settle(feed(crashed, ALICE, { _tag: "resend_due", peer: BOB }));
    expect(accountOf(resent, ALICE, BOB).attempt).toBe(1);
    expect(accountOf(resent, ALICE, BOB).pending).toBeUndefined();
    expect(accountOf(resent, ALICE, BOB).mempool.map((tx) => tx._tag)).toEqual(["lock"]);
  });

  test("Bob restarted after his view caught up still refuses the frame he refused, and says the same thing", () => {
    const asked = feed(credited, ALICE, lock(100n));
    const [lockFrame] = asked.inflight;
    const msg = lockFrame?.msg ?? expect.unreachable("no frame");
    const once = settle(asked);
    const caught = settle(rise(once, BOB, 111n));
    const back = settle(restarted(caught, BOB));
    expect(hostOf(back, BOB).entities).toEqual(hostOf(caught, BOB).entities);
    const again = feed({ ...back, inflight: [] }, BOB, { _tag: "peer_message", from: ALICE, msg });
    expect(again.inflight.map((o) => messageId(o.msg).split(" ")[0])).toEqual(["refusal"]);
  });
});

const CAROL = entityOf(3);

describe("runtime/tick review A: a new height is a frame of every Entity", () => {
  const lock: Command = { _tag: "lock", peer: BOB, token: GOLD, hold: holdOf("left", 100n, 1n, 120n) };
  const opened = settle(feed(feed(start(viewOf(110n), viewOf(100n)), ALICE, open(BOB)), BOB, open(ALICE)));
  const refused = settle(feed(settle(feed(opened, BOB, credit(ALICE, 100n))), ALICE, lock));

  test("R-NOTICE a tx that no longer applies when the view rises is refused with notice in that height's row", () => {
    const late = settle(rise(refused, ALICE, 125n));
    const row = hostOf(late, ALICE).wal.at(-1) ?? expect.unreachable("no row");
    expect(row.input._tag).toBe("j_height");
    const told = row.notices.map((n) =>
      (n._tag === "tx_refused" ? [n.peer, n.refused.tx._tag, n.refused.fault._tag] : [n._tag]));
    expect(told).toEqual([[BOB, "lock", "deadline_past"]]);
    expect(hostOf(late, ALICE).entities.get(ALICE)?.accounts.get(BOB)?.mempool).toEqual([]);
  });

  test("a Runtime that hosts two Entities gives both the frame of a new height, in id order", () => {
    const hosted = startRuntime({ ...setup, view: viewOf(110n) }, [emptyEntity(CAROL), emptyEntity(ALICE)]);
    const retryable = (owner: EntityId, hash: FrameHash) => inputFor(owner, 0n, {
      _tag: "peer_message", from: BOB, msg: { _tag: "refusal", hash, index: 0, fault: "deadline_too_far", mark: 0 },
    });
    const waiting = [ALICE, CAROL].reduce((rt, owner) => {
      const opened = tick(rt, inputFor(owner, 1n, open(BOB))).runtime;
      const asked = tick(opened, inputFor(owner, 2n, credit(BOB, 5n))).runtime;
      const pending = asked.entities.get(owner)?.accounts.get(BOB)?.pending ?? expect.unreachable("no pending");
      return tick(asked, retryable(owner, provisionalFrameHash(pending.frame))).runtime;
    }, hosted);
    expect([...waiting.entities.values()].map((e) => e.waiting.size)).toEqual([1, 1]);
    const risen = tick(waiting, heightAt(9n, 111n));
    expect(risen.leaving.map((o) => [o.from, o.to])).toEqual([[ALICE, BOB], [CAROL, BOB]]);
    expect([...risen.runtime.entities.values()].map((e) => e.waiting.size)).toEqual([0, 0]);
    expect(stamp(9n)).toBe(risen.runtime.stamp);
  });

  test("a height row stamps like any other row: a later input stamped earlier keeps the WAL in order", () => {
    const host = start(viewOf(110n), viewOf(110n)).hosts.get(ALICE) ?? expect.unreachable("no host");
    const risen = tick(host, heightAt(50n, 111n)).runtime;
    const rt = tick(risen, inputFor(ALICE, 40n, open(BOB))).runtime;
    expect(rt.wal.map((row) => row.stamp)).toEqual([50n, 50n].map(stamp));
  });
});
