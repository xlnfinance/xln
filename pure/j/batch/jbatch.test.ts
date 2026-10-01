// The Entity's draft and its one batch in flight: queue, seal, and the nonce rules (F1, R-FINAL-NONCE, R-NONCE).
import { describe, expect, test } from "bun:test";
import { deployment } from "../../chain/proof/deployment.ts";
import { unwrapOr } from "../../kernel/core/result.ts";
import {
  advancesCommandNonce, drop, openJBatch, queue, seal, type JBatch, type QueueOutcome, type SealContext,
} from "./jbatch.ts";
import type { JOp } from "../op/ops.ts";
import { budgetFor } from "../gas/gas.ts";
import {
  GAS, ME, LEFT_PEER, RIGHT_PEER, bigStart, counter, drive, fundSpread, pick, deposit, finalize, fund, holdings, idOf,
  reserveToReserve, reveal, settle, start, withdraw,
} from "../fixtures.ts";

const chain = unwrapOr(deployment(31337n, `0x${"0b".repeat(20)}`), (e) => expect.unreachable(JSON.stringify(e)));
const ctx = (reserve = 100n): SealContext =>
  ({ deployment: chain, treasury: holdings([1n, reserve, 0n]), gas: GAS, answers: [] });

const queued = (j: JBatch, ...ops: readonly JOp[]): JBatch =>
  ops.reduce((acc, op) => {
    const outcome = queue(acc, op);
    return outcome._tag === "refused" ? expect.unreachable(JSON.stringify(outcome.fault)) : outcome.jbatch;
  }, j);

const tags = (ops: readonly JOp[]): readonly string[] => ops.map((op) => op._tag);

const sealedOf = (j: JBatch, c = ctx()) => {
  const outcome = drive(j, c);
  return outcome._tag === "sealed" ? outcome : expect.unreachable(outcome._tag);
};

describe("R-SAME-FRAME-SETTLE-PENDING (nonce half): a request on its way is skipped and the nonce advances", () => {
  const empty = openJBatch(ME, 0n);

  test("a settlement queued twice is queued once and skipped once, and both advance the command nonce", () => {
    const first = queue(empty, settle(LEFT_PEER, -2n));
    const again = first._tag === "queued" ? queue(first.jbatch, settle(LEFT_PEER, -2n)) : expect.unreachable("first");
    expect(first._tag).toBe("queued");
    expect(again).toMatchObject({ _tag: "skipped", reason: "already_submitted" });
    expect(again._tag === "skipped" && again.jbatch.draft.length).toBe(1);
    expect([first, again].map(advancesCommandNonce)).toEqual([true, true]);
  });
  test("a settlement already in the batch that was sent is skipped too, not queued again and not refused", () => {
    const sent = sealedOf(queued(empty, settle(LEFT_PEER, -2n))).jbatch;
    const again = queue(sent, settle(LEFT_PEER, -2n));
    expect(again).toMatchObject({ _tag: "skipped", reason: "already_submitted" });
    expect(advancesCommandNonce(again)).toBe(true);
    expect(again._tag === "skipped" && again.jbatch.draft).toEqual([]);
  });
  test("a settlement at another Account nonce, or with another Account, is another request", () => {
    const j = queued(empty, settle(LEFT_PEER, -2n, 1n));
    expect(queue(j, settle(LEFT_PEER, -2n, 2n))._tag).toBe("queued");
    expect(queue(j, settle(RIGHT_PEER, -2n, 1n))._tag).toBe("queued");
  });
  test("two deposits of the same amount are two requests: a money movement is never merged", () => {
    const j = queued(empty, deposit(5n));
    expect(queue(j, deposit(5n))._tag).toBe("queued");
    expect(queue(queued(empty, reserveToReserve(1n)), reserveToReserve(1n))._tag).toBe("queued");
  });
  test("idempotent dispute steps and withdrawals are named by what they act on", () => {
    const j = queued(empty, start(LEFT_PEER, 1n), withdraw(LEFT_PEER, 3n, 1n), finalize(LEFT_PEER, 1n));
    expect(queue(j, start(LEFT_PEER, 1n))._tag).toBe("skipped");
    expect(queue(j, withdraw(LEFT_PEER, 3n, 1n))._tag).toBe("skipped");
    expect(queue(j, finalize(LEFT_PEER, 1n))._tag).toBe("skipped");
    expect(queue(j, start(LEFT_PEER, 2n))._tag).toBe("queued");
  });
  test("only a refusal leaves the command nonce where it was", () => {
    const refused: QueueOutcome = { _tag: "refused", fault: { _tag: "too_many_ops", total: 51, max: 50 } };
    expect(advancesCommandNonce(refused)).toBe(false);
  });
});

describe("R-J3 a full draft refuses with a notice and keeps what it had", () => {
  const many = <T>(n: number, make: (i: number) => T): readonly T[] => Array.from({ length: n }, (_, i) => make(i));

  test("the 51st op is refused with the total a batch may carry and the draft is unchanged", () => {
    const full = queued(openJBatch(ME, 0n), ...many(50, (i) => reserveToReserve(BigInt(i + 1))));
    const outcome = queue(full, reserveToReserve(99n));
    expect(outcome).toEqual({ _tag: "refused", fault: { _tag: "too_many_ops", total: 51, max: 50 } });
    expect(full.draft.length).toBe(50);
  });
  test("the ninth dispute start is refused: starts travel together and a batch carries eight", () => {
    const full = queued(openJBatch(ME, 0n), ...many(8, (i) => start(LEFT_PEER, BigInt(i + 1))));
    const fault = { _tag: "too_many_of_kind" as const, kind: "dispute_start" as const, count: 9, max: 8 };
    expect(queue(full, start(LEFT_PEER, 9n))).toEqual({ _tag: "refused", fault });
  });
  test("the limits are per batch: two finalizes are two batches and both may wait in the draft", () => {
    expect(queue(queued(openJBatch(ME, 0n), finalize(LEFT_PEER, 1n)), finalize(RIGHT_PEER, 1n))._tag).toBe("queued");
  });
  test("33 settlements are refused for one Account, and allowed for 33 Accounts (a batch each)", () => {
    const one = queued(openJBatch(ME, 0n), ...many(32, (i) => settle(LEFT_PEER, -1n, BigInt(i + 1))));
    expect(queue(one, settle(LEFT_PEER, -1n, 33n))._tag).toBe("refused");
    const peers = queued(openJBatch(ME, 0n), ...many(32, (i) => settle(idOf(100 + i), -1n)));
    expect(queue(peers, settle(idOf(200), -1n))._tag).toBe("queued");
  });
});

describe("seal: one batch at a time, from the first group that is funded", () => {
  test("an empty draft has nothing to send", () => {
    expect(seal(openJBatch(ME, 0n), ctx())).toEqual({ _tag: "nothing_to_send" });
  });
  test("the sealed batch is the first group, the rest stay in the draft in their order", () => {
    const j = queued(openJBatch(ME, 0n), reserveToReserve(1n), deposit(5n), start(LEFT_PEER, 1n));
    const sealed = sealedOf(j);
    expect(sealed.batch.ops.map((op) => op._tag)).toEqual(["dispute_start"]);
    expect(sealed.jbatch.draft.map((op) => op._tag)).toEqual(["reserve_to_reserve", "deposit"]);
    expect(sealed.jbatch.phase).toEqual({ _tag: "inflight", sent: sealed.batch });
  });
  test("while a batch is in flight nothing else is sealed", () => {
    const sealed = sealedOf(queued(openJBatch(ME, 0n), deposit(5n), deposit(6n)));
    expect(seal(sealed.jbatch, ctx())).toEqual({ _tag: "in_flight", sent: sealed.batch });
  });
  test("a payment the reserve does not cover is not sealed, and a funded one behind it is (R-FUNDED)", () => {
    const j = queued(openJBatch(ME, 0n), reserveToReserve(60n), reserveToReserve(30n), reserveToReserve(10n));
    const sealed = sealedOf(j, ctx(70n));
    expect(sealed.batch.ops).toEqual(pick(j.draft, 0, 2));
    expect(sealed.jbatch.draft).toEqual(pick(j.draft, 1));
  });
  test("a draft with only unfunded payments seals nothing and takes no nonce", () => {
    const j = queued(openJBatch(ME, 3n), reserveToReserve(60n));
    expect(seal(j, ctx(10n))).toEqual({ _tag: "nothing_to_send" });
    expect(j.signedMax).toBe(3n);
  });
  test("a co-signed group goes with its own Account only (R-COSIGN)", () => {
    const j = queued(openJBatch(ME, 0n), settle(LEFT_PEER, -1n), settle(RIGHT_PEER, -1n), fund(LEFT_PEER, 1n));
    const sealed = sealedOf(j);
    expect(sealed.batch.ops.map((op) => op._tag)).toEqual(["settle", "reserve_to_collateral"]);
    expect(sealed.jbatch.draft.length).toBe(1);
  });
});

describe("R-FINAL-NONCE and R-NONCE: a batch is signed at a nonce above every nonce this Entity ever signed", () => {
  test("the first batch is the chain's nonce plus one", () => {
    expect(sealedOf(queued(openJBatch(ME, 6n), deposit(1n))).batch.nonce).toBe(7n);
  });
  test("a signed nonce the chain has not reached is not signed twice: the next batch is above it", () => {
    const abandoned: JBatch = { ...queued(openJBatch(ME, 3n), deposit(1n)), signedMax: 7n };
    const sealed = sealedOf(abandoned);
    expect(sealed.batch.nonce).toBe(8n);
    expect(sealed.jbatch.signedMax).toBe(8n);
  });
  test("the nonce a sealed batch takes is the new highest, whatever the chain says", () => {
    const sealed = sealedOf(queued(openJBatch(ME, 0n), deposit(1n)));
    expect(sealed.jbatch.signedMax).toBe(sealed.batch.nonce);
  });
});

describe("J6 reaches the wire: the sealed batch of a deposit is that deposit alone", () => {
  test("two deposits and a payment: the first seal carries one deposit", () => {
    const sealed = sealedOf(queued(openJBatch(ME, 0n), deposit(1n), deposit(2n), reserveToReserve(1n)));
    expect(sealed.batch.ops.map((op) => op._tag)).toEqual(["deposit"]);
  });
  test("a finalize goes first and alone, before the starts and counters (the J page's pick-ops)", () => {
    const first = sealedOf(queued(openJBatch(ME, 0n), start(RIGHT_PEER, 1n), finalize(LEFT_PEER)));
    expect(first.batch.ops.map((op) => op._tag)).toEqual(["dispute_finalize"]);
    expect(first.jbatch.draft.map((op) => op._tag)).toEqual(["dispute_start"]);
  });
});

describe("R-SAME-FRAME-SETTLE-PENDING a name is a duplicate only when the op is the same op", () => {
  const empty = openJBatch(ME, 0n);

  test("a settlement at the same Account nonce with other diffs is refused as conflicting, not skipped", () => {
    const j = queued(empty, settle(LEFT_PEER, -2n, 4n));
    const outcome = queue(j, settle(LEFT_PEER, -9n, 4n));
    expect(outcome._tag).toBe("refused");
    expect(outcome._tag === "refused" && outcome.fault._tag).toBe("conflicting_request");
    expect(advancesCommandNonce(outcome)).toBe(false);
  });
  test("a conflicting request leaves the draft as it was", () => {
    const j = queued(empty, settle(LEFT_PEER, -2n, 4n));
    expect(j.draft.length).toBe(1);
    expect(queue(j, settle(LEFT_PEER, -9n, 4n))).toMatchObject({ _tag: "refused" });
  });
  test("a reveal of one secret for another transformer is another request", () => {
    const first = reveal(1);
    const other: JOp = first._tag === "reveal_secret"
      ? { ...first, reveal: { ...first.reveal, transformer: `0x${"33".repeat(20)}` } } : first;
    expect(queue(queued(empty, first), other)._tag).toBe("queued");
  });
  test("the same settlement built twice is a skip: equal bytes are the same request", () => {
    expect(queue(queued(empty, settle(LEFT_PEER, -2n, 4n)), settle(LEFT_PEER, -2n, 4n))._tag).toBe("skipped");
  });
});

describe("R-SAME-FRAME-SETTLE-PENDING and R-A1 a dispute step is named by who authored it and which kind it is", () => {
  const empty = openJBatch(ME, 0n);
  const startBy = (patch: object): JOp => {
    const op = start(LEFT_PEER, 3n);
    return op._tag === "dispute_start" ? { ...op, start: { ...op.start, ...patch } } : op;
  };
  const counterBy = (patch: object): JOp => {
    const op = counter(LEFT_PEER, 3n);
    return op._tag === "dispute_counter" ? { ...op, counter: { ...op.counter, ...patch } } : op;
  };
  const finalBy = (patch: object): JOp => {
    const op = finalize(LEFT_PEER, 3n);
    return op._tag === "dispute_finalize" ? { ...op, finalization: { ...op.finalization, ...patch } } : op;
  };
  const after = (first: JOp, second: JOp): string => queue(queued(empty, first), second)._tag;
  const otherHash = `0x${"ab".repeat(32)}`;

  test("a start authored by Right, then one authored by Left at the same nonce, are two requests", () => {
    expect(after(startBy({ proposerIsLeft: false }), startBy({ proposerIsLeft: true }))).toBe("queued");
  });
  test("a start with another proof body hash is another request", () => {
    expect(after(startBy({}), startBy({ proofbodyHash: otherHash }))).toBe("queued");
  });
  test("a counter authored by Right, then one by Left at the same nonce, are two requests", () => {
    expect(after(counterBy({ proposerIsLeft: false }), counterBy({ proposerIsLeft: true }))).toBe("queued");
  });
  test("a counter on another initial proof body is another request", () => {
    expect(after(counterBy({}), counterBy({ initialProofbodyHash: otherHash }))).toBe("queued");
  });
  test("a unilateral finalize, then a cooperative one at the same nonces, are two requests", () => {
    expect(after(finalBy({}), finalBy({ cooperative: true }))).toBe("queued");
  });
  test("a finalize authored by Right, then one by Left, are two requests", () => {
    expect(after(finalBy({ proposerIsLeft: false }), finalBy({ proposerIsLeft: true }))).toBe("queued");
  });
  test("a finalize of a dispute started by the other side is another request", () => {
    expect(after(finalBy({ startedByLeft: false }), finalBy({ startedByLeft: true }))).toBe("queued");
  });
  test("a finalize on another initial proof body is another request", () => {
    expect(after(finalBy({}), finalBy({ initialProofbodyHash: otherHash }))).toBe("queued");
  });
  test("the same step twice is still one request", () => {
    expect(after(counterBy({}), counterBy({}))).toBe("skipped");
    expect(after(finalBy({}), finalBy({}))).toBe("skipped");
    expect(after(startBy({}), startBy({}))).toBe("skipped");
  });
});

describe("a queued op is sent once: the draft keeps every op it was not sealed with", () => {
  test("one deposit object queued twice: sealing one leaves the other in the draft", () => {
    const d = deposit(5n);
    const sealed = sealedOf(queued(openJBatch(ME, 0n), d, d));
    expect(sealed.batch.ops.length).toBe(1);
    expect(sealed.jbatch.draft.length).toBe(1);
  });
  test("one payment object queued twice, the reserve covers one: the second waits in the draft", () => {
    const p = reserveToReserve(60n);
    const sealed = sealedOf(queued(openJBatch(ME, 0n), p, p), ctx(100n));
    expect(sealed.batch.ops.length).toBe(1);
    expect(sealed.jbatch.draft.length).toBe(1);
  });
});

describe("R-J3 a group too large for one batch is refused when it is queued, so the draft can always be sealed", () => {
  const empty = openJBatch(ME, 0n);

  test("the second 140 KiB start is refused with the size, and the first stays", () => {
    const first = queued(empty, bigStart(LEFT_PEER, 1n, 140));
    const outcome = queue(first, bigStart(RIGHT_PEER, 1n, 140));
    expect(outcome._tag === "refused" && outcome.fault._tag).toBe("group_too_large");
    expect(first.draft.length).toBe(1);
  });
  test("what is behind such a refusal still seals: a reveal and a finalize go out", () => {
    const j = queued(empty, bigStart(LEFT_PEER, 1n, 140), reveal(1), finalize(LEFT_PEER, 1n));
    expect(sealedOf(j).batch.ops.map((op) => op._tag)).toEqual(["dispute_finalize"]);
  });
  test("an op that alone is too large never enters the draft", () => {
    expect(queue(empty, bigStart(LEFT_PEER, 1n, 300))._tag).toBe("refused");
  });
  test("an op the Depository could not decode is refused, not queued to wedge the draft", () => {
    const op = deposit(1n);
    const bad: JOp = op._tag === "deposit" ? { ...op, leg: { ...op.leg, contractAddress: "0x12" } } : op;
    const outcome = queue(empty, bad);
    expect(outcome._tag === "refused" && outcome.fault._tag).toBe("unencodable");
  });
  test("a refusal is not a nonce for the command", () => {
    const outcome = queue(queued(empty, bigStart(LEFT_PEER, 1n, 140)), bigStart(RIGHT_PEER, 1n, 140));
    expect(advancesCommandNonce(outcome)).toBe(false);
  });
});

const ones = (n: number): readonly bigint[] => Array.from({ length: n }, () => 1n);

describe("R-J3 a draft that could be sealed once can still be sealed after a send regroups it", () => {
  const pairsOf = (ops: readonly JOp[]): number =>
    ops.reduce((sum, op) => sum + (op._tag === "reserve_to_collateral" ? op.funding.pairs.length : 0), 0);

  test("fundings that rode with a settlement fall into the soft group: what is sent is cut to 250 pairs", () => {
    const toX = [fund(LEFT_PEER, ...ones(64)), fund(LEFT_PEER, ...ones(64))];
    const spread = [fundSpread(64, 200), fundSpread(64, 300), fundSpread(64, 400), fund(LEFT_PEER, ...ones(64))];
    const draft = queued(openJBatch(ME, 0n), settle(LEFT_PEER, 0n, 1n), ...toX, ...spread);
    const first = sealedOf(draft, ctx(0n));
    expect(tags(first.batch.ops)).toEqual(["settle"]);
    const idle = { ...first.jbatch, phase: { _tag: "idle" } } as const;
    const second = sealedOf(idle, ctx(10_000n));
    expect(pairsOf(second.batch.ops)).toBeLessThanOrEqual(250);
    expect(second.batch.ops.length).toBeGreaterThan(0);
  });
  test("what was cut waits in the draft and goes in the next batch: nothing is lost and nothing wedges", () => {
    const draft = queued(openJBatch(ME, 0n), settle(LEFT_PEER, 0n, 1n), fund(LEFT_PEER, ...ones(64)),
      fund(LEFT_PEER, ...ones(64)), fundSpread(64, 200), fundSpread(64, 300), fundSpread(64, 400));
    const first = sealedOf(draft, ctx(0n));
    const second = sealedOf({ ...first.jbatch, phase: { _tag: "idle" } }, ctx(10_000n));
    const third = sealedOf({ ...second.jbatch, phase: { _tag: "idle" } }, ctx(10_000n));
    const sent = [...first.batch.ops, ...second.batch.ops, ...third.batch.ops];
    expect(sent.length).toBe(6);
    expect(third.jbatch.draft).toEqual([]);
  });
});

describe("R-J3 payments waiting for funding never refuse a dispute step", () => {
  test("50 payments the reserve cannot cover, then a dispute start: queued, and it is what seals", () => {
    const unfunded = Array.from({ length: 50 }, (_, i) => reserveToReserve(1_000_000n + BigInt(i)));
    const waiting = queued(openJBatch(ME, 0n), ...unfunded);
    expect(queue(waiting, reserveToReserve(1n))._tag).toBe("refused");
    const withStart = queued(waiting, start(LEFT_PEER, 1n));
    expect(tags(sealedOf(withStart, ctx(1n)).batch.ops)).toEqual(["dispute_start"]);
  });
  test("a draft of 50 hard ops is full for hard ops and not for payments", () => {
    const hard = queued(openJBatch(ME, 0n), ...Array.from({ length: 50 }, (_, i) => deposit(BigInt(i + 1))));
    expect(queue(hard, deposit(99n))._tag).toBe("refused");
    expect(queue(hard, reserveToReserve(1n))._tag).toBe("queued");
  });
});

describe("R-SIMULATE reaches seal: nothing is signed before the Host has simulated the batch", () => {
  const j = queued(openJBatch(ME, 0n), reserveToReserve(1n));

  test("the first outcome is a request to simulate, and it signs nothing and takes no nonce", () => {
    const outcome = seal(j, ctx());
    expect(outcome._tag).toBe("simulate");
    expect(j.signedMax).toBe(0n);
  });
  test("the batch that is signed is the one that was simulated", () => {
    const final = sealedOf(j);
    const answered = drive(j, ctx(), (c) => ({ _tag: "ok", applyGas: 600_000n + BigInt(c.ops.length) }));
    expect(final.batch.digest).not.toBe("");
    expect(answered._tag === "sealed" && answered.batch.gasBudget).toBe(budgetFor(600_001n));
  });
  test("a batch that would revert is held, and the group behind it is tried instead", () => {
    const both = queued(openJBatch(ME, 0n), finalize(LEFT_PEER, 1n), reserveToReserve(1n));
    const gated = drive(both, ctx(), (c) => c.ops.some((op) => op._tag === "dispute_finalize")
      ? { _tag: "reverts", reason: "0x00000002" } : { _tag: "ok", applyGas: 600_000n });
    expect(gated._tag === "sealed" && gated.batch.ops.map((op) => op._tag)).toEqual(["reserve_to_reserve"]);
    expect(gated._tag === "sealed" && gated.jbatch.draft.map((op) => op._tag)).toEqual(["dispute_finalize"]);
  });
  test("when every group would revert nothing is signed and the reasons are given", () => {
    const outcome = drive(j, ctx(), () => ({ _tag: "reverts", reason: "0x00000003" }));
    expect(outcome).toEqual({ _tag: "held", why: [{ _tag: "would_revert", reason: "0x00000003" }] });
  });
  test("a payment batch too heavy for the cap is signed in the part that fits, the rest waits", () => {
    const many = queued(openJBatch(ME, 0n), ...Array.from({ length: 4 }, (_, i) => reserveToReserve(BigInt(i + 1))));
    const heavy = drive(many, ctx(), (c) => ({ _tag: "ok", applyGas: 5_000_000n * BigInt(c.ops.length) }));
    expect(heavy._tag === "sealed" && heavy.batch.ops.length).toBe(2);
    expect(heavy._tag === "sealed" && heavy.jbatch.draft.length).toBe(2);
  });
});

describe("drop: an Account withdraws a request that is still in the draft", () => {
  test("a request waiting in the draft is removed, the others stay", () => {
    const j = queued(openJBatch(ME, 0n), settle(LEFT_PEER, -2n, 4n), reserveToReserve(1n));
    const out = drop(j, settle(LEFT_PEER, -2n, 4n));
    expect(out._tag).toBe("dropped");
    if (out._tag === "dropped") expect(out.jbatch.draft.map((op) => op._tag)).toEqual(["reserve_to_reserve"]);
  });
  test("a request already signed into a batch cannot be recalled: the batch is named", () => {
    const sealed = drive(queued(openJBatch(ME, 0n), settle(LEFT_PEER, -2n, 4n)), ctx());
    if (sealed._tag !== "sealed") return expect.unreachable(sealed._tag);
    const out = drop(sealed.jbatch, settle(LEFT_PEER, -2n, 4n));
    expect(out).toEqual({ _tag: "on_its_way", sent: sealed.batch });
  });
  test("a request nobody queued is unknown, and an op without a name is never matched", () => {
    const j = queued(openJBatch(ME, 0n), deposit(5n));
    expect(drop(j, settle(LEFT_PEER, -2n, 4n))._tag).toBe("unknown");
    expect(drop(j, deposit(5n))._tag).toBe("unknown");
  });
});
