import { describe, expect, test } from "bun:test";
import { err, unwrapOr } from "../../kernel/core/result.ts";
import { clockParams } from "../clause/clock.ts";
import { hashlockOf, heightOf, holdOf, secretOf, signing, tokenOf, viewOf } from "../fixtures.ts";
import { holdId, other, type AccountFault, type Hold } from "../model.ts";
import { ledgerOf } from "../state.ts";
import { type AccountTx, type Judge } from "../tx.ts";
import { accountRules, emptyReplica, frameName, GENESIS, type AccountReplica } from "./account.ts";
import {
  MAX_ATTEMPTS, propose, queue, receive, resend, STALE_ATTEMPT, submit, type FrameHash, type Msg,
} from "./frame.ts";

const GOLD = tokenOf(1n);
const judge: Judge = {
  clock: unwrapOr(clockParams(1n, 2n, 10n), () => expect.unreachable("params")),
  view: viewOf(100n),
};
const rules = accountRules(judge, signing);

const credit = (limit: bigint, token = GOLD): AccountTx => ({ _tag: "set_credit", token, limit });
const pay = (amount: bigint, token = GOLD): AccountTx => ({ _tag: "pay", token, amount });

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

/** The frame every name test starts from: Left's first frame on the genesis head, in the fixture's epoch. */
const FIRST = { author: "left" as const, parent: GENESIS, attempt: 0, slot: 2,
  epoch: signing.ondeltaEpoch, firstNonce: signing.firstNonce };

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

  test("R-LOCK-ROUTE a lock's route is in the frame's name: a different route, or none, is a different frame", () => {
    const lock = (route?: readonly string[]): AccountTx => ({
      _tag: "lock", token: GOLD, hold: holdOf("left", 5n, 1n, 105n, 1), ...(route === undefined ? {} : { route }),
    });
    const named = (route?: readonly string[]) => frameName({ ...FIRST, txs: [lock(route)] });
    expect(named(["0x01"])).toBe(named(["0x01"]));
    expect(named(["0x01"])).not.toBe(named(["0x02"]));
    expect(named(["0x01"])).not.toBe(named(["0x01", "0x02"]));
    expect(named(["0x01"])).not.toBe(named());
  });

  test("a frame is named by its parent and its txs: equal frames agree and any difference changes the name", () => {
    const f = { ...FIRST, txs: [pay(1n)] };
    expect(frameName({ ...f })).toBe(frameName(f));
    expect(frameName({ ...f, txs: [pay(2n)] })).not.toBe(frameName(f));
    expect(frameName({ ...f, txs: [pay(1n), pay(1n)] })).not.toBe(frameName(f));
    expect(frameName({ ...f, parent: frameName(f) })).not.toBe(frameName(f));
    expect(frameName({ ...f, author: "right" })).not.toBe(frameName(f));
    const odd = { ...FIRST, txs: [pay(-1n)] };
    expect(frameName(odd)).toMatch(/^0x[0-9a-f]{64}$/);
    expect(frameName({ ...f, attempt: 1 })).not.toBe(frameName(f));
    expect(frameName({ ...f, slot: 4 })).not.toBe(frameName(f));
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
    expect(leftHears.replica).toEqual({ ...sentLeft.replica, peerSigned: frameOf(only(sentRight.sent)).slot });
  });

  test("R-A1 Right rolls its frame back, commits Left's and acks it", () => {
    expect(rightHears.outcome).toEqual({ _tag: "accepted_over_own" });
    expect(rightHears.replica.pending).toBeUndefined();
    expect(rightHears.replica.mempool).toEqual([credit(500n)]);
    expect(rightHears.replica.head).toBe(sentLeft.replica.pending?.head ?? expect.unreachable("pending"));
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
    const next = { ...first, parent: frameName(first) };
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
    expect(heard.replica).toEqual({ ...credited.right, declined: heard.replica.declined, peerSigned: bad.slot });
    const fault = "insufficient_capacity";
    expect(heard.sent).toEqual([
      { _tag: "refusal", hash: frameName(bad), index: 1, fault, mark: 0, floor: credited.right.signed },
    ]);
  });

  test("an ack of something I did not propose changes nothing", () => {
    const other = frameName({ ...first, txs: [pay(1n)] });
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
    expect(frameName(asLeft)).not.toBe(theirs.replica.head);
    expect(receive(rules, emptyReplica("right"), { _tag: "frame", frame: asLeft }).replica.state).not
      .toEqual(theirs.replica.state);
  });

  test("R-AUTH R-REACK a frame with another author is not a repeat of the frame at my head", () => {
    const accepted = receive(rules, emptyReplica("left"), echo);
    const forged = receive(rules, accepted.replica, { _tag: "frame", frame: { ...frameOf(echo), author: "left" } });
    expect(forged.outcome).toEqual({ _tag: "refused_own" });
  });
});

describe("account/frame an empty frame", () => {
  test("R-NOTICE a frame with no txs is refused and moves nothing: the peer cannot spin the height", () => {
    const emptied = { ...FIRST, txs: [] };
    const empty: Msg<AccountTx> = { _tag: "frame", frame: emptied };
    const heard = receive(rules, emptyReplica("right"), empty);
    expect(heard.outcome).toEqual({ _tag: "refused_empty" });
    expect(heard.replica).toEqual(emptyReplica("right"));
    expect(heard.sent).toEqual([]);
  });
});

describe("account/frame a peer cannot halt a replica", () => {
  const busy = proposing(credited.left, pay(5n)).replica;
  const targets: readonly AccountReplica[] = [credited.left, credited.right, busy, left, right];
  const parents: readonly FrameHash[] = [GENESIS, credited.left.head, busy.head, `0x${"ab".repeat(32)}` as FrameHash];
  const amounts: readonly bigint[] = [-1n, 0n, 1n, 5n, 99n, 100n, 101n, 2n ** 256n, -(2n ** 200n)];

  const randomMsg = (i: number, target: AccountReplica): Msg<AccountTx> => {
    const txs: readonly AccountTx[] = Array.from({ length: pick(i, 1, 4) }, (_, j) =>
      pay(amounts[pick(i, 10 + j, amounts.length)] ?? 1n));
    const parent = parents[pick(i, 2, parents.length)] ?? GENESIS;
    const author = pick(i, 5, 6) === 0 ? target.side : other(target.side);
    const kind = pick(i, 3, 5);
    if (kind === 0) return { _tag: "ack", hash: parent };
    const fault = "not_expired";
    if (kind === 1) return { _tag: "refusal", hash: parent, index: pick(i, 6, 3), fault, mark: 0, floor: 0 };
    const slot = target.used + 1 + pick(i, 8, 3);
    const { ondeltaEpoch: epoch, firstNonce } = signing;
    return { _tag: "frame", frame: { author, parent, attempt: pick(i, 7, 3), slot, epoch, firstNonce, txs } };
  };

  test("R-X1 whatever a peer sends is answered with a replica, and a refusal changes nothing", () => {
    const outcomes = Array.from({ length: 3000 }, (_, i) => {
      const target = targets[pick(i, 4, targets.length)] ?? left;
      const heard = receive(rules, target, randomMsg(i, target));
      const answered = ["refused_invalid", "refused_slot", "refused_stale"];
      const silent = heard.outcome._tag.startsWith("refused") && !answered.includes(heard.outcome._tag);
      if (silent || heard.outcome._tag === "ack_ignored" || heard.outcome._tag === "refusal_ignored") {
        expect(heard.replica).toEqual(target);
        expect(heard.sent).toEqual([]);
      }
      if (heard.outcome._tag === "refused_slot") {
        expect(heard.replica).toEqual(target);
        expect(heard.sent.map((m) => m._tag).length).toBeLessThanOrEqual(1);
      }
      if (heard.outcome._tag === "refused_invalid") {
        expect({ ...heard.replica, declined: [], peerSigned: 0 }).toEqual({ ...target, declined: [], peerSigned: 0 });
        expect(heard.sent.map((m) => m._tag)).toEqual(["refusal"]);
      }
      return heard.outcome._tag;
    });
    const seen = new Set<string>(outcomes);
    const refusals =
      ["refused_invalid", "refused_not_next", "refused_own", "refused_empty", "refusal_ignored", "refused_slot"];
    ["accepted", "kept_own", "ack_ignored", ...refusals].forEach((tag) => expect(seen.has(tag)).toBe(true));
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
    const late = accountRules({ ...judge, view: viewOf(106n) }, signing);
    expect(receive(late, receive(rules, sent.replica, only(accepted.sent)).replica, only(asked.sent)).outcome)
      .toEqual({ _tag: "refused_invalid", fault: { _tag: "past_deadline", deadline: 105n, view: 106n } });
    const timely = receive(rules, receive(rules, sent.replica, only(accepted.sent)).replica, only(asked.sent));
    expect(timely.outcome).toEqual({ _tag: "accepted" });
    expect(ledgerOf(timely.replica.state, GOLD).holds).toEqual([]);
  });
});

describe("account/frame the name of a frame covers every field", () => {
  // Reviewer A of A3: each field of each tx is in the name; a frame whose txs differ must not share a name.
  const OIL = tokenOf(2n);
  const lock = (over: Partial<Hold> = {}, token = GOLD): AccountTx =>
    ({ _tag: "lock", token, hold: { ...holdOf("left", 5n, 1n, 105n, 1), ...over } });
  const resolve = (id: bigint, n: number, token = GOLD): AccountTx =>
    ({ _tag: "resolve", token, id: holdId(id), secret: secretOf(n) });
  const variants: readonly AccountTx[] = [
    pay(1n), pay(2n), pay(1n, OIL),
    credit(1n), credit(2n), credit(1n, OIL),
    lock(), lock({ payer: "right" }), lock({ amount: 6n }), lock({ id: holdId(2n) }),
    lock({ hashlock: hashlockOf(secretOf(2)) }), lock({ deadline: heightOf(106n) }), lock({}, OIL),
    resolve(1n, 1), resolve(2n, 1), resolve(1n, 2), resolve(1n, 1, OIL),
    { _tag: "cancel", token: GOLD, id: holdId(1n) }, { _tag: "cancel", token: GOLD, id: holdId(2n) },
    { _tag: "cancel", token: OIL, id: holdId(1n) },
    { _tag: "expire", token: GOLD, id: holdId(1n) }, { _tag: "expire", token: GOLD, id: holdId(2n) },
    { _tag: "expire", token: OIL, id: holdId(1n) },
  ];
  const name = (...txs: readonly AccountTx[]) =>
    frameName({ ...FIRST, txs });

  test("every single-tx frame has its own name", () => {
    expect(new Set(variants.map((tx) => name(tx))).size).toBe(variants.length);
  });

  test("the order of the txs is part of the name, and so is how many there are", () => {
    expect(name(pay(1n), credit(1n))).not.toBe(name(credit(1n), pay(1n)));
    expect(name(pay(1n))).not.toBe(name(pay(1n), pay(1n)));
    expect(name()).not.toBe(name(pay(1n)));
  });
});

describe("account/frame what the second review's mutants found", () => {
  test("a frame that does not apply, heard while my own frame is pending, leaves my frame pending", () => {
    const mine = proposing(credited.right, credit(500n));
    const bad = { ...frameOf(only(mine.sent)), author: "left" as const, slot: mine.replica.used + 2, txs: [pay(500n)] };
    const heard = receive(rules, mine.replica, { _tag: "frame", frame: bad });
    expect(heard.outcome._tag).toBe("refused_invalid");
    expect(heard.replica).toEqual({ ...mine.replica, declined: heard.replica.declined, peerSigned: bad.slot });
    expect(heard.replica.pending).toEqual(mine.replica.pending);
  });

  test("R-NOTICE several refused txs are noticed in the order they were queued", () => {
    const three = [pay(500n), pay(600n), pay(700n)].reduce(queue, credited.left);
    expect(propose(rules, three).replica.refused.map((x) => x.tx)).toEqual([pay(500n), pay(600n), pay(700n)]);
  });

  test("a frame name covers every field of every tx: changing any one of them changes the name", () => {
    const GOLD2 = tokenOf(2n);
    const lock = (token: typeof GOLD, hold: Hold): AccountTx => ({ _tag: "lock", token, hold });
    const resolve = (token: typeof GOLD, id: bigint, n: number): AccountTx =>
      ({ _tag: "resolve", token, id: holdId(id), secret: secretOf(n) });
    const cancel = (token: typeof GOLD, id: bigint): AccountTx => ({ _tag: "cancel", token, id: holdId(id) });
    const expire = (token: typeof GOLD, id: bigint): AccountTx => ({ _tag: "expire", token, id: holdId(id) });
    const base = holdOf("left", 5n, 1n, 105n, 1);
    const pairs: readonly (readonly [AccountTx, AccountTx])[] = [
      [pay(1n), { _tag: "pay", token: GOLD2, amount: 1n }],
      [credit(5n), { _tag: "set_credit", token: GOLD2, limit: 5n }],
      [credit(5n), credit(6n)],
      [credit(5n), pay(5n)],
      [lock(GOLD, base), lock(GOLD, holdOf("right", 5n, 1n, 105n, 1))],
      [lock(GOLD, base), lock(GOLD, holdOf("left", 6n, 1n, 105n, 1))],
      [lock(GOLD, base), lock(GOLD, holdOf("left", 5n, 2n, 105n, 1))],
      [lock(GOLD, base), lock(GOLD, holdOf("left", 5n, 1n, 106n, 1))],
      [lock(GOLD, base), lock(GOLD, holdOf("left", 5n, 1n, 105n, 2))],
      [lock(GOLD, base), lock(GOLD2, base)],
      [resolve(GOLD, 1n, 1), resolve(GOLD, 1n, 2)],
      [resolve(GOLD, 1n, 1), resolve(GOLD, 2n, 1)],
      [resolve(GOLD, 1n, 1), resolve(GOLD2, 1n, 1)],
      [cancel(GOLD, 1n), expire(GOLD, 1n)],
      [cancel(GOLD, 1n), cancel(GOLD, 2n)],
      [cancel(GOLD, 1n), cancel(GOLD2, 1n)],
      [expire(GOLD, 1n), expire(GOLD, 2n)],
      [expire(GOLD, 1n), expire(GOLD2, 1n)],
    ];
    const named = (tx: AccountTx) => frameName({ ...FIRST, txs: [tx] });
    pairs.forEach(([a, b]) => expect(named(a)).not.toBe(named(b)));
  });
});

describe("account/frame R-FRAME-REFUSAL a frame the peer cannot apply is taken back", () => {
  const rulesAt = (view: bigint) => accountRules({ ...judge, view: viewOf(view) }, signing);
  const lock: AccountTx = { _tag: "lock", token: GOLD, hold: holdOf("left", 5n, 1n, 101n, 1) };
  const resolve: AccountTx = { _tag: "resolve", token: GOLD, id: holdId(1n), secret: secretOf(1) };
  const expire: AccountTx = { _tag: "expire", token: GOLD, id: holdId(1n) };

  /** Left locked 5 for Right, deadline 101, and both committed it: Right is the payee. */
  const locked = (() => {
    const sent = propose(rulesAt(100n), queue(credited.left, lock));
    const accepted = receive(rulesAt(100n), credited.right, only(sent.sent));
    const done = receive(rulesAt(100n), sent.replica, only(accepted.sent));
    return { left: done.replica, right: accepted.replica };
  })();

  /** Right resolves at its view 101 (the deadline: live); Left is one block ahead at 102, past it, and refuses. */
  const resolving = propose(rulesAt(101n), queue(queue(locked.right, resolve), credit(7n)));
  const refusedByLeft = receive(rulesAt(102n), locked.left, only(resolving.sent));
  const name = frameName(frameOf(only(resolving.sent)));

  test("the answer to a frame that does not apply names the frame and the first tx at fault", () => {
    expect(refusedByLeft.outcome).toEqual({
      _tag: "refused_invalid", fault: { _tag: "past_deadline", deadline: 101n, view: 102n },
    });
    const floor = locked.left.signed;
    const fault = "past_deadline";
    expect(refusedByLeft.sent).toEqual([{ _tag: "refusal", hash: name, index: 0, fault, mark: 0, floor }]);
    expect(refusedByLeft.replica.head).toBe(locked.left.head);
    expect(refusedByLeft.replica.state).toEqual(locked.left.state);
  });

  test("the proposer takes the frame back, drops the named tx with notice and keeps the rest to propose again", () => {
    const heard = receive(rulesAt(101n), resolving.replica, only(refusedByLeft.sent));
    expect(heard.outcome).toEqual({ _tag: "rolled_back" });
    expect(heard.sent).toEqual([]);
    expect(heard.replica.pending).toBeUndefined();
    expect(heard.replica.mempool).toEqual([credit(7n)]);
    expect(heard.replica.refused).toEqual([{ tx: resolve, fault: { _tag: "peer_refused", fault: "past_deadline" } }]);
    const again = propose(rulesAt(101n), heard.replica);
    const accepted = receive(rulesAt(102n), refusedByLeft.replica, only(again.sent));
    expect(accepted.outcome).toEqual({ _tag: "accepted" });
    const done = receive(rulesAt(101n), again.replica, only(accepted.sent));
    expect(done.outcome).toEqual({ _tag: "committed_own" });
    expect(done.replica.head).toBe(accepted.replica.head);
  });

  test("a refused frame stays refused: when the receiver's view later lets it apply, it is still not committed", () => {
    const early = propose(rulesAt(104n), queue(locked.right, expire));
    const notYet = receive(rulesAt(103n), locked.left, only(early.sent));
    expect(notYet.outcome._tag).toBe("refused_invalid");
    expect(receive(rulesAt(104n), locked.left, only(early.sent)).outcome).toEqual({ _tag: "accepted" });
    const later = receive(rulesAt(104n), notYet.replica, only(early.sent));
    expect(later.outcome._tag).toBe("refused_invalid");
    expect(later.sent).toEqual(notYet.sent);
    expect(later.replica.head).toBe(locked.left.head);
    expect(later.replica.state).toEqual(locked.left.state);
  });

  test("a refusal for a frame already committed is ignored, and so is one for no pending frame", () => {
    const sent = propose(rulesAt(100n), queue(locked.left, credit(9n)));
    const accepted = receive(rulesAt(100n), locked.right, only(sent.sent));
    const done = receive(rulesAt(100n), sent.replica, only(accepted.sent));
    const hash = frameName(frameOf(only(sent.sent)));
    const late: Msg<AccountTx> = { _tag: "refusal", hash, index: 0, fault: "x", mark: 0, floor: 0 };
    const heard = receive(rulesAt(100n), done.replica, late);
    expect(heard.outcome).toEqual({ _tag: "refusal_ignored" });
    expect(heard.replica).toEqual(done.replica);
    expect(heard.sent).toEqual([]);
  });

  test("a refusal that names another frame, or a tx the pending frame does not have, is ignored", () => {
    const emptied = { ...frameOf(only(resolving.sent)), txs: [] };
    const strayName: Msg<AccountTx> =
      { _tag: "refusal", hash: frameName(emptied), index: 0, fault: "x", mark: 0, floor: 0 };
    const beyond: Msg<AccountTx> = { _tag: "refusal", hash: name, index: 2, fault: "x", mark: 0, floor: 0 };
    const negative: Msg<AccountTx> = { _tag: "refusal", hash: name, index: -1, fault: "x", mark: 0, floor: 0 };
    [strayName, beyond, negative].forEach((m) => {
      const heard = receive(rulesAt(101n), resolving.replica, m);
      expect(heard.outcome).toEqual({ _tag: "refusal_ignored" });
      expect(heard.replica).toEqual(resolving.replica);
    });
  });

  test("the frame's other txs go back ahead of what was queued behind it, in the order they were written", () => {
    const behind = queue(resolving.replica, credit(9n));
    const heard = receive(rulesAt(101n), behind, only(refusedByLeft.sent));
    expect(heard.replica.mempool).toEqual([credit(7n), credit(9n)]);
  });

  test("a replica that refused a frame answers its repeat with the refusal even while its own frame is out", () => {
    const own = propose(rulesAt(102n), queue(refusedByLeft.replica, credit(9n)));
    expect(own.replica.pending).toBeDefined();
    const again = receive(rulesAt(102n), own.replica, only(resolving.sent));
    expect(again.sent).toEqual(refusedByLeft.sent.map((m) => ({ ...m, floor: own.replica.signed })));
    expect(again.replica).toEqual(own.replica);
  });

  test("what a replica refused is forgotten when it commits its own frame too", () => {
    const mine = propose(rulesAt(100n), queue(refusedByLeft.replica, credit(9n)));
    const ackHash = mine.replica.pending?.head ?? expect.unreachable("nothing pending");
    const acked = receive(rulesAt(100n), mine.replica, { _tag: "ack", hash: ackHash });
    expect(acked.outcome).toEqual({ _tag: "committed_own" });
    expect(acked.replica.declined).toBeUndefined();
  });

  test("what a replica refused is forgotten when its head moves", () => {
    const back = receive(rulesAt(101n), resolving.replica, only(refusedByLeft.sent));
    const next = propose(rulesAt(101n), back.replica);
    const moved = receive(rulesAt(102n), refusedByLeft.replica, only(next.sent));
    expect(refusedByLeft.replica.declined?.attempt).toBe(0);
    expect(moved.outcome).toEqual({ _tag: "accepted" });
    expect(moved.replica.declined).toBeUndefined();
  });

  test("the attempt count starts again at 0 when the head moves, whichever way it moves", () => {
    const back = receive(rulesAt(101n), resolving.replica, only(refusedByLeft.sent));
    expect(back.replica.attempt).toBe(1);
    const leftOwn = propose(rulesAt(102n), queue(refusedByLeft.replica, credit(5n)));
    const yielded = receive(rulesAt(101n), back.replica, only(leftOwn.sent));
    expect(yielded.outcome).toEqual({ _tag: "accepted" });
    expect(yielded.replica.attempt).toBe(0);
  });

  /** Right's view is 104: the expiry of the hold (deadline 101, reserve 2) is due. Left's view is 103: it is not. */
  const early = propose(rulesAt(104n), queue(locked.right, expire));
  const notYet = receive(rulesAt(103n), locked.left, only(early.sent));
  const round = (both: Readonly<{ proposer: AccountReplica; receiver: AccountReplica }>) => {
    const sent = propose(rulesAt(104n), both.proposer);
    const refusal = receive(rulesAt(103n), both.receiver, only(sent.sent));
    return { proposer: receive(rulesAt(104n), sent.replica, only(refusal.sent)).replica, receiver: refusal.replica };
  };
  const rounds = (n: number) => Array.from({ length: n }, (_, i) => i)
    .reduce(round, { proposer: queue(locked.right, expire), receiver: locked.left });

  test("a refusal names the fault, and one that passes with the peer's view sends the txs back to be retried", () => {
    expect(only(notYet.sent)).toMatchObject({ _tag: "refusal", index: 0, fault: "not_expired" });
    const back = receive(rulesAt(104n), early.replica, only(notYet.sent));
    expect(back.outcome).toEqual({ _tag: "rolled_back" });
    expect(back.replica.refused).toEqual([]);
    expect(back.replica.mempool).toEqual([expire]);
    expect(back.replica.attempt).toBe(1);
  });

  test("the retry is a new frame at the next attempt: the peer judges it afresh, and commits it once it can", () => {
    const back = receive(rulesAt(104n), early.replica, only(notYet.sent));
    const retry = propose(rulesAt(104n), back.replica);
    expect(frameOf(only(retry.sent)).attempt).toBe(1);
    const accepted = receive(rulesAt(104n), notYet.replica, only(retry.sent));
    expect(accepted.outcome).toEqual({ _tag: "accepted" });
    const done = receive(rulesAt(104n), retry.replica, only(accepted.sent));
    expect(done.outcome).toEqual({ _tag: "committed_own" });
    expect([done.replica.attempt, done.replica.declined, accepted.replica.declined]).toEqual([0, undefined, undefined]);
    expect(done.replica.head).toBe(accepted.replica.head);
  });

  test("after MAX_ATTEMPTS refusals on one head the tx is dropped with notice instead of retried again", () => {
    const kept = rounds(MAX_ATTEMPTS).proposer;
    expect([kept.mempool, kept.refused, kept.attempt]).toEqual([[expire], [], MAX_ATTEMPTS]);
    const dropped = rounds(MAX_ATTEMPTS + 1).proposer;
    expect([dropped.mempool, dropped.refused]).toEqual([
      [], [{ tx: expire, fault: { _tag: "peer_refused", fault: "not_expired" } }],
    ]);
  });

  test("R-EVERY-REFUSAL-ANSWERED the frame after the budget is spent is judged, never left pending", () => {
    const companion = credit(5n);
    const spent = Array.from({ length: MAX_ATTEMPTS + 1 }, (_, i) => i)
      .reduce(round, { proposer: queue(queue(locked.right, companion), expire), receiver: locked.left });
    expect([spent.proposer.mempool, spent.proposer.attempt]).toEqual([[companion], MAX_ATTEMPTS + 1]);
    const next = propose(rulesAt(104n), spent.proposer);
    expect(frameOf(only(next.sent)).attempt).toBe(MAX_ATTEMPTS + 1);
    const heard = receive(rulesAt(103n), spent.receiver, only(next.sent));
    expect(heard.outcome).toEqual({ _tag: "accepted" });
    const done = receive(rulesAt(104n), next.replica, only(heard.sent));
    expect([done.outcome, done.replica.pending]).toEqual([{ _tag: "committed_own" }, undefined]);
  });

  test("R-EVERY-REFUSAL-ANSWERED a frame at the mark is refused again, one below it is told the mark", () => {
    const first = rounds(1);
    const retry = propose(rulesAt(104n), first.proposer);
    const refused = receive(rulesAt(103n), first.receiver, only(retry.sent));
    expect(refused.replica.declined?.attempt).toBe(1);
    expect(only(refused.sent)).toMatchObject({ fault: "not_expired", mark: 1 });
    const repeat = receive(rulesAt(104n), refused.replica, only(retry.sent));
    expect([repeat.outcome._tag, repeat.sent]).toEqual(["refused_invalid", refused.sent]);
    const stale = receive(rulesAt(104n), refused.replica, only(early.sent));
    expect(stale.outcome).toEqual({ _tag: "refused_stale" });
    const name = frameName(frameOf(only(early.sent)));
    expect(stale.sent).toEqual([
      { _tag: "refusal", hash: name, index: 0, fault: STALE_ATTEMPT, mark: 1, floor: refused.replica.signed },
    ]);
    expect(stale.replica).toEqual(refused.replica);
  });

  test("R-EVERY-REFUSAL-ANSWERED a proposer whose attempt count is behind is told the mark and commits next", () => {
    const ahead = rounds(3).receiver;
    expect(ahead.declined?.attempt).toBe(2);
    const forgot = propose(rulesAt(104n), queue(locked.right, expire));
    const told = receive(rulesAt(104n), ahead, only(forgot.sent));
    expect(told.outcome).toEqual({ _tag: "refused_stale" });
    const back = receive(rulesAt(104n), forgot.replica, only(told.sent));
    expect(back.outcome).toEqual({ _tag: "rolled_back" });
    expect([back.replica.mempool, back.replica.refused, back.replica.attempt]).toEqual([[expire], [], 3]);
    const again = propose(rulesAt(104n), back.replica);
    const accepted = receive(rulesAt(104n), ahead, only(again.sent));
    expect(accepted.outcome).toEqual({ _tag: "accepted" });
    const done = receive(rulesAt(104n), again.replica, only(accepted.sent));
    expect([done.outcome, done.replica.pending]).toEqual([{ _tag: "committed_own" }, undefined]);
  });

  test("R-EVERY-REFUSAL-ANSWERED a stale answer costs no tx, whatever the retry budget", () => {
    const spent = { ...queue(locked.right, expire), attempt: MAX_ATTEMPTS + 1 };
    const sent = propose(rulesAt(104n), spent);
    const name = frameName(frameOf(only(sent.sent)));
    const stale: Msg<AccountTx> = { _tag: "refusal", hash: name, index: 0, fault: STALE_ATTEMPT, mark: 12, floor: 0 };
    const told = receive(rulesAt(104n), sent.replica, stale);
    expect([told.replica.mempool, told.replica.refused, told.replica.attempt]).toEqual([[expire], [], 13]);
  });

  test("a refusal whose mark is not a count the proposer can use changes nothing", () => {
    const name = frameName(frameOf(only(early.sent)));
    [-1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER, Number.POSITIVE_INFINITY].forEach((mark) => {
      const refusal: Msg<AccountTx> = { _tag: "refusal", hash: name, index: 0, fault: "not_expired", mark, floor: 0 };
      const heard = receive(rulesAt(104n), early.replica, refusal);
      expect(heard.outcome).toEqual({ _tag: "refusal_ignored" });
      expect(heard.replica).toEqual(early.replica);
    });
  });

  test("an attempt that is not a whole number it can count is refused and remembered as nothing", () => {
    const bad = [-1, 1.5, Number.NaN, 2 ** 53, Number.POSITIVE_INFINITY];
    bad.forEach((attempt) => {
      const frame = { ...frameOf(only(early.sent)), attempt };
      const heard = receive(rulesAt(103n), locked.left, { _tag: "frame", frame });
      expect(heard.outcome).toEqual({ _tag: "refused_attempt" });
      expect([heard.sent, heard.replica]).toEqual([[], locked.left]);
    });
  });

  test("a refusal whose index is not a whole number, or whose fault is not named, changes nothing", () => {
    const name = frameName(frameOf(only(early.sent)));
    ["0", "length", 0.5, Number.NaN, -1, 1].forEach((index) => {
      const refusal: Msg<AccountTx> =
        { _tag: "refusal", hash: name, index: index as number, fault: "not_expired", mark: 0, floor: 0 };
      const heard = receive(rulesAt(104n), early.replica, refusal);
      expect(heard.outcome).toEqual({ _tag: "refusal_ignored" });
      expect(heard.replica).toEqual(early.replica);
    });
  });
});

describe("account/frame what Review B of PR 85 found in round 2", () => {
  const rulesAt = (view: bigint) => accountRules({ ...judge, view: viewOf(view) }, signing);
  const lock: AccountTx = { _tag: "lock", token: GOLD, hold: holdOf("left", 5n, 1n, 101n, 1) };
  const resolve: AccountTx = { _tag: "resolve", token: GOLD, id: holdId(1n), secret: secretOf(1) };
  const expire: AccountTx = { _tag: "expire", token: GOLD, id: holdId(1n) };
  const lockSent = propose(rulesAt(100n), queue(credited.left, lock));
  const lockedRight = receive(rulesAt(100n), credited.right, only(lockSent.sent));
  const locked = {
    left: receive(rulesAt(100n), lockSent.replica, only(lockedRight.sent)).replica, right: lockedRight.replica,
  };

  test("R-FRAME-REFUSAL a refusal for the same attempt repeats the first one: the same tx and the same fault", () => {
    const sent = propose(rulesAt(101n), queue(queue(locked.right, credit(7n)), resolve));
    const first = receive(rulesAt(102n), locked.left, only(sent.sent));
    const name = frameName(frameOf(only(sent.sent)));
    const floor = locked.left.signed;
    expect(first.sent).toEqual([{ _tag: "refusal", hash: name, index: 1, fault: "past_deadline", mark: 0, floor }]);
    const repeat = receive(rulesAt(100n), first.replica, only(sent.sent));
    expect(repeat.sent).toEqual(first.sent);
    expect(repeat.replica).toEqual(first.replica);
  });

  test("R-FRAME-REFUSAL a repeat of the frame at my head does not clear what I refused on top of it", () => {
    const refused = propose(rulesAt(104n), queue(locked.left, expire));
    const notYet = receive(rulesAt(103n), locked.right, only(refused.sent));
    expect(notYet.outcome._tag).toBe("refused_invalid");
    const reacked = receive(rulesAt(103n), notYet.replica, only(lockSent.sent));
    expect(reacked.outcome).toEqual({ _tag: "re_acked" });
    expect(reacked.replica.declined).toEqual(notYet.replica.declined);
    expect(receive(rulesAt(104n), reacked.replica, only(refused.sent)).outcome._tag).toBe("refused_invalid");
  });

  test("R-EVERY-REFUSAL-ANSWERED a different frame at the refused attempt gets the stale answer, not a refusal", () => {
    // Right restarted: its pending frame and its attempt count are gone, its queue is not. The new frame has one tx,
    // so the old refusal's index 1 would name nothing in it and the proposer would wait for ever; in a frame of two
    // or more it would drop an innocent tx for the old tx's fault.
    const bad = propose(rulesAt(101n), queue(queue(locked.right, credit(7n)), resolve));
    const refusedBad = receive(rulesAt(102n), locked.left, only(bad.sent));
    expect(only(refusedBad.sent)).toMatchObject({ index: 1, fault: "past_deadline", mark: 0 });
    const restarted = { ...bad.replica, pending: undefined, attempt: 0, mempool: [credit(9n)] };
    const again = propose(rulesAt(101n), restarted);
    const answer = receive(rulesAt(102n), refusedBad.replica, only(again.sent));
    const newName = frameName(frameOf(only(again.sent)));
    const floor = refusedBad.replica.signed;
    expect(answer.sent).toEqual([{ _tag: "refusal", hash: newName, index: 0, fault: STALE_ATTEMPT, mark: 0, floor }]);
    expect(answer.replica).toEqual({ ...refusedBad.replica, peerSigned: frameOf(only(again.sent)).slot });
    const rolled = receive(rulesAt(101n), again.replica, only(answer.sent));
    expect([rolled.outcome, rolled.replica.refused]).toEqual([{ _tag: "rolled_back" }, []]);
    const next = propose(rulesAt(101n), rolled.replica);
    expect(frameOf(only(next.sent)).attempt).toBe(1);
    expect(receive(rulesAt(102n), answer.replica, only(next.sent)).outcome).toEqual({ _tag: "accepted" });
  });

  test("R-EVERY-REFUSAL-ANSWERED the attempt count stays a safe integer however the peer's marks climb", () => {
    const sent = propose(rulesAt(104n), queue(locked.right, expire));
    const name = frameName(frameOf(only(sent.sent)));
    const told = (hash: FrameHash, mark: number): Msg<AccountTx> =>
      ({ _tag: "refusal", hash, index: 0, fault: STALE_ATTEMPT, mark, floor: 0 });
    const top = receive(rulesAt(104n), sent.replica, told(name, Number.MAX_SAFE_INTEGER - 1));
    expect([top.outcome, top.replica.attempt]).toEqual([{ _tag: "rolled_back" }, Number.MAX_SAFE_INTEGER]);
    // the attempt is a label, not a nonce: the frame goes out at it, at a slot of its own above the refused one
    const again = propose(rulesAt(104n), top.replica);
    const slot = sent.replica.signed + 2;
    expect(frameOf(only(again.sent))).toMatchObject({ attempt: Number.MAX_SAFE_INTEGER, slot });
    // one more refusal would take the count past a safe integer: it is not believed, and the frame stays pending
    const again2 = told(frameName(frameOf(only(again.sent))), Number.MAX_SAFE_INTEGER);
    const beyond = receive(rulesAt(104n), again.replica, again2);
    expect([beyond.outcome, beyond.replica]).toEqual([{ _tag: "refusal_ignored" }, again.replica]);
  });

  test("R-EVERY-REFUSAL-ANSWERED a proposer refused MAX_ATTEMPTS + 1 times is answered and ends quiet", () => {
    const refusedAgain = (pair: { left: AccountReplica; right: AccountReplica }) => {
      const sent = propose(rulesAt(104n), pair.right);
      const refusal = receive(rulesAt(103n), pair.left, only(sent.sent));
      return { left: refusal.replica, right: receive(rulesAt(104n), sent.replica, only(refusal.sent)).replica };
    };
    const start = { left: locked.left, right: queue(queue(locked.right, expire), credit(7n)) };
    const burned = Array.from({ length: MAX_ATTEMPTS + 1 }).reduce<typeof start>(refusedAgain, start);
    expect(burned.right.attempt).toBe(MAX_ATTEMPTS + 1);
    expect(burned.right.refused.map((x) => x.fault._tag)).toEqual(["peer_refused"]);
    // the peer's view has caught up: the frame at the next attempt is judged and committed, nothing waits on silence
    const next = propose(rulesAt(110n), burned.right);
    const heard = receive(rulesAt(110n), burned.left, only(next.sent));
    expect([heard.outcome, frameOf(only(next.sent)).attempt]).toEqual([{ _tag: "accepted" }, MAX_ATTEMPTS + 1]);
    const done = receive(rulesAt(110n), next.replica, only(heard.sent));
    expect(done.outcome).toEqual({ _tag: "committed_own" });
    expect([done.replica.pending, done.replica.mempool]).toEqual([undefined, []]);
    // and the head moved: Left's next frame commits on Right
    const leftFrame = propose(rulesAt(110n), queue(heard.replica, credit(9n)));
    const again = receive(rulesAt(110n), done.replica, only(leftFrame.sent));
    expect(again.outcome).toEqual({ _tag: "accepted" });
  });

  test("R-EVERY-REFUSAL-ANSWERED a Left proposer refused MAX_ATTEMPTS + 1 times does not block Right", () => {
    const refusedAgain = (pair: { left: AccountReplica; right: AccountReplica }) => {
      const sent = propose(rulesAt(104n), pair.left);
      const refusal = receive(rulesAt(103n), pair.right, only(sent.sent));
      return { right: refusal.replica, left: receive(rulesAt(104n), sent.replica, only(refusal.sent)).replica };
    };
    const start = { right: locked.right, left: queue(queue(locked.left, expire), credit(7n)) };
    const burned = Array.from({ length: MAX_ATTEMPTS + 1 }).reduce<typeof start>(refusedAgain, start);
    expect(burned.left.attempt).toBe(MAX_ATTEMPTS + 1);
    // the views have caught up; both propose at once, Left's frame (attempt 9) and Right's own valid frame
    const leftOut = propose(rulesAt(110n), burned.left);
    const rightOut = propose(rulesAt(110n), queue(burned.right, credit(200n)));
    const leftHears = receive(rulesAt(110n), leftOut.replica, only(rightOut.sent));
    const rightHears = receive(rulesAt(110n), rightOut.replica, only(leftOut.sent));
    expect([leftHears.outcome._tag, rightHears.outcome._tag]).toEqual(["kept_own", "accepted_over_own"]);
    const leftDone = receive(rulesAt(110n), leftHears.replica, only(rightHears.sent));
    expect(leftDone.outcome).toEqual({ _tag: "committed_own" });
    const rightFrame = propose(rulesAt(110n), rightHears.replica);
    const accepted = receive(rulesAt(110n), leftDone.replica, only(rightFrame.sent));
    const rightDone = receive(rulesAt(110n), rightFrame.replica, only(accepted.sent));
    const quiet = [accepted.replica, rightDone.replica].map((x) => [x.pending, x.mempool]);
    expect(quiet).toEqual([[undefined, []], [undefined, []]]);
    expect(accepted.replica.head).toBe(rightDone.replica.head);
  });
});

describe("account/frame R-DISPUTE-FREEZE a frame the chain paid by is not sent back with its txs", () => {
  const paidOf = (r: AccountReplica): AccountReplica =>
    ({ ...r, pending: { ...(r.pending ?? expect.unreachable("no pending frame")), owed: [] } });
  const sentLeft = proposing(credited.left, pay(10n));
  const sentRight = proposing(credited.right, credit(500n));
  const refusal = (r: AccountReplica): Msg<AccountTx> => ({
    _tag: "refusal", hash: frameName(r.pending?.frame ?? expect.unreachable("no pending frame")), index: 0,
    fault: STALE_ATTEMPT, mark: 0, floor: 0,
  });

  test("R-DISPUTE-FREEZE a refusal rolls a frame back with its txs, none of them when the chain paid by it", () => {
    const back = receive(rules, sentLeft.replica, refusal(sentLeft.replica));
    expect([back.replica.pending, back.replica.mempool]).toStrictEqual([undefined, [pay(10n)]]);
    const paid = paidOf(sentLeft.replica);
    const gone = receive(rules, paid, refusal(paid));
    expect([gone.outcome._tag, gone.replica.pending, gone.replica.mempool])
      .toStrictEqual(["rolled_back", undefined, []]);
  });

  test("R-DISPUTE-FREEZE a rollback of a part-paid frame gives back only the txs the chain did not pay", () => {
    const pending = sentLeft.replica.pending ?? expect.unreachable("no pending");
    const part = { ...sentLeft.replica, pending: { ...pending, owed: [pay(3n)] } };
    const back = receive(rules, part, refusal(part));
    expect([back.replica.pending, back.replica.mempool]).toStrictEqual([undefined, [pay(3n)]]);
  });

  test("R-DISPUTE-FREEZE the peer's frame committed over a paid pending frame takes none of its txs back", () => {
    const over = receive(rules, paidOf(sentRight.replica), only(sentLeft.sent));
    expect([over.outcome._tag, over.replica.pending, over.replica.mempool])
      .toStrictEqual(["accepted_over_own", undefined, []]);
  });
});
