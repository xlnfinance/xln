import { describe, expect, test } from "bun:test";
import { err, unwrapOr } from "../../kernel/core/result.ts";
import { clockParams } from "../clause/clock.ts";
import { holdOf, secretOf, viewOf } from "../fixtures.ts";
import { holdId, tokenId, type AccountFault } from "../model.ts";
import { ledgerOf } from "../state.ts";
import { type AccountTx, type Judge } from "../tx.ts";
import { accountRules, emptyReplica, provisionalFrameHash, GENESIS, type AccountReplica } from "./account.ts";
import { propose, queue, receive, resend, submit, type FrameHash, type Msg } from "./frame.ts";

const GOLD = tokenId(1n);
const judge: Judge = {
  clock: unwrapOr(clockParams(1n, 2n, 10n), () => expect.unreachable("params")),
  view: viewOf(100n),
};
const rules = accountRules(judge);

const credit = (limit: bigint): AccountTx => ({ _tag: "set_credit", token: GOLD, limit });
const pay = (amount: bigint): AccountTx => ({ _tag: "pay", token: GOLD, amount });

const left = emptyReplica("left");
const right = emptyReplica("right");

/** The replica after its txs are queued and proposed: the pending frame and the message it sends. */
const proposing = (r: AccountReplica, ...txs: readonly AccountTx[]) => propose(rules, txs.reduce(queue, r));

const frameOf = (m: Msg<AccountTx> | undefined) => (m?._tag === "frame" ? m.frame : expect.unreachable("not a frame"));
const only = (sent: readonly Msg<AccountTx>[]): Msg<AccountTx> => sent[0] ?? expect.unreachable("nothing sent");

/** Right extends 100 of credit to Left, and both replicas have committed it. */
const credited = (() => {
  const sent = proposing(right, credit(100n));
  const accepted = receive(rules, left, only(sent.sent));
  const committed = receive(rules, sent.replica, only(accepted.sent));
  return { left: accepted.replica, right: committed.replica };
})();

describe("account/frame the round", () => {
  test("a proposed frame commits on the peer, then on the proposer when the ack comes back", () => {
    const sent = proposing(credited.left, pay(30n));
    expect(frameOf(only(sent.sent)).parent).toBe(credited.left.head);
    expect(sent.replica.pending?.frame.txs).toEqual([pay(30n)]);
    const accepted = receive(rules, credited.right, only(sent.sent));
    expect(accepted.outcome).toEqual({ _tag: "accepted" });
    const done = receive(rules, sent.replica, only(accepted.sent));
    expect(done.outcome).toEqual({ _tag: "committed_own" });
    expect(done.replica.head).toBe(accepted.replica.head);
    expect(done.replica.state).toEqual(accepted.replica.state);
    expect(ledgerOf(done.replica.state, GOLD).offdelta).toBe(-30n);
    expect(done.replica.pending).toBeUndefined();
  });

  test("nothing is proposed from an empty mempool or while a frame is pending", () => {
    expect(propose(rules, left).sent).toEqual([]);
    const sent = proposing(credited.left, pay(1n));
    expect(propose(rules, queue(sent.replica, pay(2n))).sent).toEqual([]);
  });

  test("a frame is named by its parent and its txs: equal frames agree and any difference changes the name", () => {
    const f = { author: "left" as const, parent: GENESIS, txs: [pay(1n)] };
    expect(provisionalFrameHash({ ...f })).toBe(provisionalFrameHash(f));
    expect(provisionalFrameHash({ ...f, txs: [pay(2n)] })).not.toBe(provisionalFrameHash(f));
    expect(provisionalFrameHash({ ...f, txs: [pay(1n), pay(1n)] })).not.toBe(provisionalFrameHash(f));
    expect(provisionalFrameHash({ ...f, parent: provisionalFrameHash(f) })).not.toBe(provisionalFrameHash(f));
    expect(provisionalFrameHash({ ...f, author: "right" })).not.toBe(provisionalFrameHash(f));
    expect(provisionalFrameHash({ author: "left", parent: GENESIS, txs: [pay(-1n)] })).toMatch(/^0x[0-9a-f]{64}$/);
  });
});

describe("account/frame same-height collision", () => {
  const sentLeft = proposing(credited.left, pay(10n));
  const sentRight = proposing(credited.right, credit(500n));
  const leftHears = receive(rules, sentLeft.replica, only(sentRight.sent));
  const rightHears = receive(rules, sentRight.replica, only(sentLeft.sent));

  test("R-A1 Left ignores Right's frame and keeps its own", () => {
    expect(leftHears.outcome).toEqual({ _tag: "kept_own" });
    expect(leftHears.sent).toEqual([]);
    expect(leftHears.replica).toEqual(sentLeft.replica);
  });

  test("R-A1 Right rolls its frame back, commits Left's and acks it", () => {
    expect(rightHears.outcome).toEqual({ _tag: "accepted_over_own" });
    expect(rightHears.replica.pending).toBeUndefined();
    expect(rightHears.replica.mempool).toEqual([credit(500n)]);
    expect(rightHears.replica.head).toBe(provisionalFrameHash(frameOf(only(sentLeft.sent))));
    expect(rightHears.sent).toEqual([{ _tag: "ack", hash: rightHears.replica.head }]);
  });

  test("R-A1 Left commits on the ack, and Right proposes its txs again at the next height", () => {
    const leftDone = receive(rules, sentLeft.replica, only(rightHears.sent));
    expect(leftDone.replica.head).toBe(rightHears.replica.head);
    const again = propose(rules, rightHears.replica);
    expect(frameOf(only(again.sent)).parent).toBe(rightHears.replica.head);
    const accepted = receive(rules, leftDone.replica, only(again.sent));
    expect(accepted.outcome).toEqual({ _tag: "accepted" });
    expect(ledgerOf(accepted.replica.state, GOLD).limit.left).toBe(500n);
  });

  test("R-A1 the rolled-back txs go ahead of what Right queued later", () => {
    const later = queue(rightHears.replica, pay(1n));
    expect(later.mempool).toEqual([credit(500n), pay(1n)]);
    const rolled = receive(rules, queue(sentRight.replica, pay(7n)), only(sentLeft.sent));
    expect(rolled.replica.mempool).toEqual([credit(500n), pay(7n)]);
  });
});

describe("account/frame refusals are values, never a halt", () => {
  const sent = proposing(credited.left, pay(5n));
  const first = frameOf(only(sent.sent));
  const accepted = receive(rules, credited.right, only(sent.sent));

  test("R-REACK a repeat of the frame at my head is answered with the same ack, in any replica state", () => {
    const again = receive(rules, accepted.replica, only(sent.sent));
    expect(again.outcome).toEqual({ _tag: "re_acked" });
    expect(again.sent).toEqual(accepted.sent);
    expect(again.replica).toEqual(accepted.replica);
    const busy = proposing(accepted.replica, credit(5n));
    const whilePending = receive(rules, busy.replica, only(sent.sent));
    expect(whilePending.outcome).toEqual({ _tag: "re_acked" });
    expect(whilePending.sent).toEqual(accepted.sent);
    expect(whilePending.replica).toEqual(busy.replica);
  });

  test("R-PARENT a frame whose parent is not my head is refused and changes nothing", () => {
    const old = { ...first, parent: GENESIS, txs: [pay(9n)] };
    const stale = receive(rules, accepted.replica, { _tag: "frame", frame: old });
    expect(stale.outcome).toEqual({ _tag: "refused_not_next" });
    expect(stale.sent).toEqual([]);
    expect(stale.replica).toEqual(accepted.replica);
    const next = { ...first, parent: provisionalFrameHash(first) };
    const future = receive(rules, credited.right, { _tag: "frame", frame: next });
    expect(future.outcome).toEqual({ _tag: "refused_not_next" });
    expect(future.replica).toEqual(credited.right);
  });

  test("R-ONE-BODY after my frame is acked, a different frame on the same parent gets no ack", () => {
    const acked = receive(rules, sent.replica, only(accepted.sent));
    expect(acked.outcome).toEqual({ _tag: "committed_own" });
    const rival = { ...first, author: "right" as const, txs: [pay(6n)] };
    const heard = receive(rules, acked.replica, { _tag: "frame", frame: rival });
    expect(heard.outcome).toEqual({ _tag: "refused_not_next" });
    expect(heard.sent).toEqual([]);
  });

  test("a frame whose txs do not apply is refused with the fault, and nothing commits", () => {
    const bad = { ...first, txs: [pay(5n), pay(500n)] };
    const heard = receive(rules, credited.right, { _tag: "frame", frame: bad });
    expect(heard.outcome).toEqual({
      _tag: "refused_invalid", fault: { _tag: "insufficient_capacity", available: 95n, requested: 500n },
    });
    expect(heard.replica).toEqual(credited.right);
    expect(heard.sent).toEqual([]);
  });

  test("an ack of something I did not propose changes nothing", () => {
    const other = provisionalFrameHash({ ...first, txs: [pay(1n)] });
    const stray = receive(rules, sent.replica, { _tag: "ack", hash: other });
    expect(stray.outcome).toEqual({ _tag: "ack_ignored" });
    expect(stray.replica).toEqual(sent.replica);
    expect(receive(rules, credited.left, { _tag: "ack", hash: GENESIS }).outcome).toEqual({ _tag: "ack_ignored" });
  });

  test("a pending frame is sent again on a timeout, and only then", () => {
    expect(resend(sent.replica)).toEqual(sent.sent);
    expect(resend(credited.left)).toEqual([]);
  });
});

/** A deterministic pick in 0 .. n-1 for step `i` and slot `k`, so a failing run names its step. */
const pick = (i: number, k: number, n: number): number =>
  ((Math.imul(i + 1, 2654435761) ^ Math.imul(k + 7, 1597334677)) >>> 0) % n;

describe("account/frame a frame has an author", () => {
  const mine = proposing(emptyReplica("right"), credit(500n));
  const echo = only(mine.sent);

  test("R-AUTH a frame handed back to its own author is refused, not read as the peer's", () => {
    const heard = receive(rules, mine.replica, echo);
    expect(heard.outcome).toEqual({ _tag: "refused_own" });
    expect(heard.replica).toEqual(mine.replica);
    expect(heard.sent).toEqual([]);
    expect(receive(rules, emptyReplica("right"), echo).outcome).toEqual({ _tag: "refused_own" });
  });

  test("R-AUTH the same txs written by the other side are another frame and mean another thing", () => {
    const theirs = receive(rules, emptyReplica("left"), echo);
    expect(theirs.outcome).toEqual({ _tag: "accepted" });
    expect(ledgerOf(theirs.replica.state, GOLD).limit).toEqual({ left: 500n, right: 0n });
    const asLeft = { ...frameOf(echo), author: "left" as const };
    expect(provisionalFrameHash(asLeft)).not.toBe(theirs.replica.head);
    expect(receive(rules, emptyReplica("right"), { _tag: "frame", frame: asLeft }).replica.state).not
      .toEqual(theirs.replica.state);
  });

  test("R-AUTH R-REACK a frame with another author is not a repeat of the frame at my head", () => {
    const accepted = receive(rules, emptyReplica("left"), echo);
    const forged = receive(rules, accepted.replica, { _tag: "frame", frame: { ...frameOf(echo), author: "left" } });
    expect(forged.outcome).toEqual({ _tag: "refused_own" });
  });
});

describe("account/frame a peer cannot halt a replica", () => {
  const busy = proposing(credited.left, pay(5n)).replica;
  const targets: readonly AccountReplica[] = [credited.left, credited.right, busy, left, right];
  const parents: readonly FrameHash[] = [GENESIS, credited.left.head, busy.head, `0x${"ab".repeat(32)}` as FrameHash];
  const amounts: readonly bigint[] = [-1n, 0n, 1n, 5n, 99n, 100n, 101n, 2n ** 256n, -(2n ** 200n)];

  const randomMsg = (i: number): Msg<AccountTx> => {
    const txs: readonly AccountTx[] = Array.from({ length: pick(i, 1, 4) }, (_, j) =>
      pay(amounts[pick(i, 10 + j, amounts.length)] ?? 1n));
    const parent = parents[pick(i, 2, parents.length)] ?? GENESIS;
    const author = pick(i, 5, 2) === 0 ? "left" : "right";
    return pick(i, 3, 4) === 0 ? { _tag: "ack", hash: parent } : { _tag: "frame", frame: { author, parent, txs } };
  };

  test("R-X1 whatever a peer sends is answered with a replica, and a refusal changes nothing", () => {
    const outcomes = Array.from({ length: 3000 }, (_, i) => {
      const target = targets[pick(i, 4, targets.length)] ?? left;
      const heard = receive(rules, target, randomMsg(i));
      if (heard.outcome._tag.startsWith("refused") || heard.outcome._tag === "ack_ignored") {
        expect(heard.replica).toEqual(target);
        expect(heard.sent).toEqual([]);
      }
      return heard.outcome._tag;
    });
    const seen = new Set<string>(outcomes);
    ["accepted", "kept_own", "refused_invalid", "refused_not_next", "ack_ignored"].forEach((tag) =>
      expect(seen.has(tag)).toBe(true));
  });
});

describe("account/frame admission and notice", () => {
  const refused = (fault: AccountFault) => err(fault);

  test("R-ADMIT a tx is checked at the door against the committed state plus everything queued", () => {
    expect(submit(rules, credited.left, pay(101n))).toEqual(
      refused({ _tag: "insufficient_capacity", available: 100n, requested: 101n }));
    const queued = unwrapOr(submit(rules, credited.left, pay(60n)), () => expect.unreachable("admitted"));
    expect(queued.mempool).toEqual([pay(60n)]);
    expect(submit(rules, queued, pay(41n))).toEqual(
      refused({ _tag: "insufficient_capacity", available: 40n, requested: 41n }));
    expect(submit(rules, queued, pay(40n)).ok).toBe(true);
  });

  test("R-ADMIT a tx behind a pending frame is checked against the state that frame makes", () => {
    const sent = proposing(credited.left, pay(90n));
    expect(submit(rules, sent.replica, pay(11n)).ok).toBe(false);
    expect(submit(rules, sent.replica, pay(10n)).ok).toBe(true);
  });

  test("R-NOTICE a queued tx that stops applying is refused with its fault at propose, never dropped", () => {
    const two = [pay(70n), pay(70n)].reduce(queue, credited.left);
    const sent = propose(rules, two);
    expect(sent.replica.mempool).toEqual([]);
    expect(sent.replica.pending?.frame.txs).toEqual([pay(70n)]);
    expect(sent.replica.refused).toEqual([
      { tx: pay(70n), fault: { _tag: "insufficient_capacity", available: 30n, requested: 70n } },
    ]);
  });

  test("R-NOTICE a frame of only refused txs sends nothing and leaves no pending frame", () => {
    const sent = propose(rules, queue(credited.left, pay(500n)));
    expect(sent.sent).toEqual([]);
    expect(sent.replica.pending).toBeUndefined();
    expect(sent.replica.refused).toHaveLength(1);
  });

  test("R-NOTICE a rolled-back tx whose ground moved is refused at the next propose, with notice", () => {
    const lowering = credit(0n);
    const mine = proposing(credited.right, lowering).replica;
    const theirs = proposing(credited.left, pay(100n));
    const yielded = receive(rules, mine, only(theirs.sent));
    expect(yielded.replica.mempool).toEqual([lowering]);
    const again = propose(rules, yielded.replica);
    expect(again.sent).toEqual([]);
    expect(again.replica.pending).toBeUndefined();
    expect(again.replica.refused).toEqual([{ tx: lowering, fault: { _tag: "credit_below_usage" } }]);
  });
});

describe("account/frame clauses ride frames", () => {
  test("a lock and its resolve commit through frames, judged by each replica's own view", () => {
    const lock: AccountTx = { _tag: "lock", token: GOLD, hold: holdOf("left", 20n, 1n, 105n, 1) };
    const sent = proposing(credited.left, lock);
    const accepted = receive(rules, credited.right, only(sent.sent));
    expect(ledgerOf(accepted.replica.state, GOLD).holds).toHaveLength(1);
    const resolve: AccountTx = { _tag: "resolve", token: GOLD, id: holdId(1n), secret: secretOf(1) };
    const asked = proposing(accepted.replica, resolve);
    const late = accountRules({ ...judge, view: viewOf(106n) });
    expect(receive(late, receive(rules, sent.replica, only(accepted.sent)).replica, only(asked.sent)).outcome)
      .toEqual({ _tag: "refused_invalid", fault: { _tag: "past_deadline", deadline: 105n, view: 106n } });
    const timely = receive(rules, receive(rules, sent.replica, only(accepted.sent)).replica, only(asked.sent));
    expect(timely.outcome).toEqual({ _tag: "accepted" });
    expect(ledgerOf(timely.replica.state, GOLD).holds).toEqual([]);
  });
});
