import { describe, expect, test } from "bun:test";
import { err, unwrapOr } from "../../kernel/core/result.ts";
import { clockParams } from "../clause/clock.ts";
import { hashlockOf, heightOf, holdOf, secretOf, tokenOf, viewOf } from "../fixtures.ts";
import { holdId, other, type AccountFault, type Hold } from "../model.ts";
import { ledgerOf } from "../state.ts";
import { type AccountTx, type Judge } from "../tx.ts";
import { accountRules, emptyReplica, provisionalFrameHash, GENESIS, type AccountReplica } from "./account.ts";
import { MAX_ATTEMPTS, propose, queue, receive, resend, submit, type FrameHash, type Msg } from "./frame.ts";

const GOLD = tokenOf(1n);
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
    const f = { author: "left" as const, parent: GENESIS, attempt: 0, txs: [pay(1n)] };
    expect(provisionalFrameHash({ ...f })).toBe(provisionalFrameHash(f));
    expect(provisionalFrameHash({ ...f, txs: [pay(2n)] })).not.toBe(provisionalFrameHash(f));
    expect(provisionalFrameHash({ ...f, txs: [pay(1n), pay(1n)] })).not.toBe(provisionalFrameHash(f));
    expect(provisionalFrameHash({ ...f, parent: provisionalFrameHash(f) })).not.toBe(provisionalFrameHash(f));
    expect(provisionalFrameHash({ ...f, author: "right" })).not.toBe(provisionalFrameHash(f));
    const odd = { author: "left" as const, parent: GENESIS, attempt: 0, txs: [pay(-1n)] };
    expect(provisionalFrameHash(odd)).toMatch(/^0x[0-9a-f]{64}$/);
    expect(provisionalFrameHash({ ...f, attempt: 1 })).not.toBe(provisionalFrameHash(f));
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
    expect(heard.replica).toEqual({ ...credited.right, declined: heard.replica.declined });
    const fault = "insufficient_capacity";
    expect(heard.sent).toEqual([{ _tag: "refusal", hash: provisionalFrameHash(bad), index: 1, fault }]);
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

describe("account/frame an empty frame", () => {
  test("R-NOTICE a frame with no txs is refused and moves nothing: the peer cannot spin the height", () => {
    const empty: Msg<AccountTx> = { _tag: "frame", frame: { author: "left", parent: GENESIS, attempt: 0, txs: [] } };
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
    if (kind === 1) return { _tag: "refusal", hash: parent, index: pick(i, 6, 3), fault: "not_expired" };
    return { _tag: "frame", frame: { author, parent, attempt: pick(i, 7, 3), txs } };
  };

  test("R-X1 whatever a peer sends is answered with a replica, and a refusal changes nothing", () => {
    const outcomes = Array.from({ length: 3000 }, (_, i) => {
      const target = targets[pick(i, 4, targets.length)] ?? left;
      const heard = receive(rules, target, randomMsg(i, target));
      const silent = heard.outcome._tag.startsWith("refused") && heard.outcome._tag !== "refused_invalid";
      if (silent || heard.outcome._tag === "ack_ignored" || heard.outcome._tag === "refusal_ignored") {
        expect(heard.replica).toEqual(target);
        expect(heard.sent).toEqual([]);
      }
      if (heard.outcome._tag === "refused_invalid") {
        expect({ ...heard.replica, declined: [] }).toEqual({ ...target, declined: [] });
        expect(heard.sent.map((m) => m._tag)).toEqual(["refusal"]);
      }
      return heard.outcome._tag;
    });
    const seen = new Set<string>(outcomes);
    const refusals = ["refused_invalid", "refused_not_next", "refused_own", "refused_empty", "refusal_ignored"];
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
    const late = accountRules({ ...judge, view: viewOf(106n) });
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
    pay(1n), pay(2n), { ...pay(1n), token: OIL },
    credit(1n), credit(2n), { ...credit(1n), token: OIL },
    lock(), lock({ payer: "right" }), lock({ amount: 6n }), lock({ id: holdId(2n) }),
    lock({ hashlock: hashlockOf(secretOf(2)) }), lock({ deadline: heightOf(106n) }), lock({}, OIL),
    resolve(1n, 1), resolve(2n, 1), resolve(1n, 2), resolve(1n, 1, OIL),
    { _tag: "cancel", token: GOLD, id: holdId(1n) }, { _tag: "cancel", token: GOLD, id: holdId(2n) },
    { _tag: "cancel", token: OIL, id: holdId(1n) },
    { _tag: "expire", token: GOLD, id: holdId(1n) }, { _tag: "expire", token: GOLD, id: holdId(2n) },
    { _tag: "expire", token: OIL, id: holdId(1n) },
  ];
  const name = (...txs: readonly AccountTx[]) =>
    provisionalFrameHash({ author: "left", parent: GENESIS, attempt: 0, txs });

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
    const bad = { ...frameOf(only(mine.sent)), author: "left" as const, txs: [pay(500n)] };
    const heard = receive(rules, mine.replica, { _tag: "frame", frame: bad });
    expect(heard.outcome._tag).toBe("refused_invalid");
    expect(heard.replica).toEqual({ ...mine.replica, declined: heard.replica.declined });
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
    const named = (tx: AccountTx) => provisionalFrameHash({ author: "left", parent: GENESIS, attempt: 0, txs: [tx] });
    pairs.forEach(([a, b]) => expect(named(a)).not.toBe(named(b)));
  });
});

describe("account/frame R-FRAME-REFUSAL a frame the peer cannot apply is taken back", () => {
  const rulesAt = (view: bigint) => accountRules({ ...judge, view: viewOf(view) });
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
  const name = provisionalFrameHash(frameOf(only(resolving.sent)));

  test("the answer to a frame that does not apply names the frame and the first tx at fault", () => {
    expect(refusedByLeft.outcome).toEqual({
      _tag: "refused_invalid", fault: { _tag: "past_deadline", deadline: 101n, view: 102n },
    });
    expect(refusedByLeft.sent).toEqual([{ _tag: "refusal", hash: name, index: 0, fault: "past_deadline" }]);
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
    const hash = provisionalFrameHash(frameOf(only(sent.sent)));
    const late: Msg<AccountTx> = { _tag: "refusal", hash, index: 0, fault: "x" };
    const heard = receive(rulesAt(100n), done.replica, late);
    expect(heard.outcome).toEqual({ _tag: "refusal_ignored" });
    expect(heard.replica).toEqual(done.replica);
    expect(heard.sent).toEqual([]);
  });

  test("a refusal that names another frame, or a tx the pending frame does not have, is ignored", () => {
    const emptied = { ...frameOf(only(resolving.sent)), txs: [] };
    const strayName: Msg<AccountTx> = { _tag: "refusal", hash: provisionalFrameHash(emptied), index: 0, fault: "x" };
    const beyond: Msg<AccountTx> = { _tag: "refusal", hash: name, index: 2, fault: "x" };
    const negative: Msg<AccountTx> = { _tag: "refusal", hash: name, index: -1, fault: "x" };
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
    expect(again.sent).toEqual(refusedByLeft.sent);
    expect(again.replica).toEqual(own.replica);
  });

  test("what a replica refused is forgotten when it commits its own frame too", () => {
    const mine = propose(rulesAt(100n), queue(refusedByLeft.replica, credit(9n)));
    const ackHash = provisionalFrameHash(frameOf(only(mine.sent)));
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

  test("a frame at an attempt the receiver has refused is refused again, and one below it is dropped quietly", () => {
    const first = rounds(1);
    const retry = propose(rulesAt(104n), first.proposer);
    const refused = receive(rulesAt(103n), first.receiver, only(retry.sent));
    expect(refused.replica.declined?.attempt).toBe(1);
    const repeat = receive(rulesAt(104n), refused.replica, only(retry.sent));
    expect([repeat.outcome._tag, repeat.sent]).toEqual(["refused_invalid", refused.sent]);
    const stale = receive(rulesAt(104n), refused.replica, only(early.sent));
    expect(stale.outcome).toEqual({ _tag: "refused_stale" });
    expect([stale.sent, stale.replica]).toEqual([[], refused.replica]);
  });

  test("an attempt that is not a whole number from 0 to MAX_ATTEMPTS is refused and remembered as nothing", () => {
    const bad = [-1, 1.5, Number.NaN, MAX_ATTEMPTS + 1, Number.POSITIVE_INFINITY];
    bad.forEach((attempt) => {
      const frame = { ...frameOf(only(early.sent)), attempt };
      const heard = receive(rulesAt(103n), locked.left, { _tag: "frame", frame });
      expect(heard.outcome).toEqual({ _tag: "refused_attempt" });
      expect([heard.sent, heard.replica]).toEqual([[], locked.left]);
    });
  });

  test("a refusal whose index is not a whole number, or whose fault is not named, changes nothing", () => {
    const name = provisionalFrameHash(frameOf(only(early.sent)));
    ["0", "length", 0.5, Number.NaN, -1, 1].forEach((index) => {
      const refusal: Msg<AccountTx> = { _tag: "refusal", hash: name, index: index as number, fault: "not_expired" };
      const heard = receive(rulesAt(104n), early.replica, refusal);
      expect(heard.outcome).toEqual({ _tag: "refusal_ignored" });
      expect(heard.replica).toEqual(early.replica);
    });
  });
});
