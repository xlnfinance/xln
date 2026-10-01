// The Entity's draft and its one batch in flight: queue, seal, and the nonce rules (F1, R-FINAL-NONCE, R-NONCE).
import { describe, expect, test } from "bun:test";
import { deployment } from "../../chain/proof/deployment.ts";
import { unwrapOr } from "../../kernel/core/result.ts";
import {
  advancesCommandNonce, openJBatch, queue, seal, type JBatch, type QueueOutcome, type SealContext,
} from "./jbatch.ts";
import type { JOp } from "../op/ops.ts";
import { MIN_GAS_BUDGET } from "./sealed.ts";
import {
  ME, LEFT_PEER, RIGHT_PEER, pick, deposit, finalize, fund, holdings, idOf, reserveToReserve, settle, start, withdraw,
} from "../fixtures.ts";

const chain = unwrapOr(deployment(31337n, `0x${"0b".repeat(20)}`), (e) => expect.unreachable(JSON.stringify(e)));
const ctx = (reserve = 100n): SealContext =>
  ({ deployment: chain, treasury: holdings([1n, reserve, 0n]), gasBudget: MIN_GAS_BUDGET });

const queued = (j: JBatch, ...ops: readonly JOp[]): JBatch =>
  ops.reduce((acc, op) => {
    const outcome = queue(acc, op);
    return outcome._tag === "refused" ? expect.unreachable(JSON.stringify(outcome.fault)) : outcome.jbatch;
  }, j);

const sealedOf = (j: JBatch, c = ctx()) => {
  const outcome = seal(j, c);
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
  test("the 33rd settlement is refused with the fault and the draft is unchanged", () => {
    const full = queued(openJBatch(ME, 0n), ...Array.from({ length: 32 }, (_, i) => settle(idOf(100 + i), -1n)));
    const outcome = queue(full, settle(idOf(200), -1n));
    const fault = { _tag: "too_many_of_kind" as const, kind: "settle" as const, count: 33, max: 32 };
    expect(outcome).toEqual({ _tag: "refused", fault });
    expect(full.draft.length).toBe(32);
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
  test("a finalize waits behind urgent reveals, starts and counters and then goes alone", () => {
    const first = sealedOf(queued(openJBatch(ME, 0n), finalize(LEFT_PEER), start(RIGHT_PEER, 1n)));
    expect(first.batch.ops.map((op) => op._tag)).toEqual(["dispute_start"]);
  });
});
