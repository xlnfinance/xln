// R-J3: the draft never holds more than one batch may carry, and the numbers are the deployed contract's.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { KIND_LIMIT, MAX_ENCODED_BYTES, PAIRS_PER_FUNDING, PAIRS_TOTAL, TOTAL_LIMIT, withinLimits } from "./limits.ts";
import type { JOp, OpKind } from "./ops.ts";
import { MAX_NONCE, MIN_GAS_BUDGET } from "../batch/sealed.ts";
import {
  counter, deposit, finalize, fund, idOf, reserveToReserve, reveal, settle, start, withdraw,
} from "../fixtures.ts";

const solidity = (file: string): string =>
  readFileSync(new URL(`../../../contracts/contracts/${file}`, import.meta.url), "utf8");

const constantOf = (source: string, name: string): bigint => {
  const text = new RegExp(`${name}\\s*=\\s*([0-9_]+)`).exec(source)?.[1];
  return text === undefined ? expect.unreachable(`no constant ${name}`) : BigInt(text.replaceAll("_", ""));
};

const many = <T>(n: number, make: (i: number) => T): readonly T[] => Array.from({ length: n }, (_, i) => make(i));

describe("R-J3 the limits are the ones DepositoryBounds and the Depository carry", () => {
  const bounds = solidity("DepositoryBounds.sol");
  const named = {
    reserve_to_reserve: "MAX_BATCH_RESERVE_TO_RESERVE", reserve_to_collateral: "MAX_BATCH_RESERVE_TO_COLLATERAL",
    collateral_to_reserve: "MAX_BATCH_COLLATERAL_TO_RESERVE", settle: "MAX_BATCH_SETTLEMENTS",
    dispute_start: "MAX_BATCH_DISPUTE_STARTS", dispute_counter: "MAX_BATCH_COUNTER_DISPUTES",
    dispute_finalize: "MAX_BATCH_DISPUTE_FINALIZATIONS", deposit: "MAX_BATCH_EXTERNAL_TO_RESERVE",
    reserve_to_external: "MAX_BATCH_RESERVE_TO_EXTERNAL", reveal_secret: "MAX_BATCH_SECRET_REVEALS",
  } as const;

  (Object.entries(named) as [keyof typeof named, string][]).forEach(([kind, constant]) => {
    test(`${kind} is ${constant}`, () => expect(BigInt(KIND_LIMIT[kind])).toBe(constantOf(bounds, constant)));
  });
  test("the totals, pairs, minimum budget, nonce and size", () => {
    expect(BigInt(TOTAL_LIMIT)).toBe(constantOf(bounds, "MAX_BATCH_TOTAL_OPS"));
    expect(BigInt(PAIRS_PER_FUNDING)).toBe(constantOf(bounds, "MAX_RESERVE_TO_COLLATERAL_PAIRS"));
    expect(BigInt(PAIRS_TOTAL)).toBe(constantOf(bounds, "MAX_BATCH_RESERVE_TO_COLLATERAL_PAIRS_TOTAL"));
    expect(MIN_GAS_BUDGET).toBe(constantOf(bounds, "MIN_BATCH_GAS_BUDGET"));
    expect(MAX_NONCE).toBe(constantOf(solidity("Types.sol"), "JS_SAFE_NONCE_MAX"));
    expect(MAX_ENCODED_BYTES).toBe(256 * 1024);
    expect(solidity("Depository.sol")).toContain("MAX_ENCODED_BATCH_BYTES = 256 * 1024");
  });
  test("a kind the table forgets would not be checked: every kind of an op has a limit", () => {
    expect(Object.keys(KIND_LIMIT).toSorted()).toEqual(Object.keys(named).toSorted());
  });
});

describe("R-J3 a full draft is a refusal, never a throw", () => {
  test("fifty ops fit and the fifty-first is refused for the total", () => {
    const fifty = [...many(32, (i) => settle(idOf(100 + i), 1n)), ...many(18, (i) => withdraw(idOf(200 + i), 1n))];
    expect(withinLimits(fifty).ok).toBe(true);
    expect(withinLimits([...fifty, withdraw(idOf(250), 1n)]))
      .toEqual({ ok: false, error: { _tag: "too_many_ops", total: 51, max: 50 } });
  });
  test("each kind is held to its own limit while the total still fits", () => {
    const over = (ops: readonly JOp[], kind: OpKind, count: number, max: number) =>
      expect(withinLimits(ops)).toEqual({ ok: false, error: { _tag: "too_many_of_kind", kind, count, max } });
    over(many(33, (i) => settle(idOf(100 + i), 1n)), "settle", 33, 32);
    over(many(9, (i) => start(idOf(100 + i))), "dispute_start", 9, 8);
    over(many(9, (i) => counter(idOf(100 + i))), "dispute_counter", 9, 8);
    over(many(2, (i) => finalize(idOf(100 + i))), "dispute_finalize", 2, 1);
    over(many(33, (i) => reveal(i + 1)), "reveal_secret", 33, 32);
  });
  test("the limit itself is allowed: 32 settlements, 8 starts, 1 finalize, 32 reveals", () => {
    expect(withinLimits(many(32, (i) => settle(idOf(100 + i), 1n))).ok).toBe(true);
    expect(withinLimits(many(8, (i) => start(idOf(100 + i)))).ok).toBe(true);
    expect(withinLimits([finalize(idOf(100))]).ok).toBe(true);
    expect(withinLimits(many(32, (i) => reveal(i + 1))).ok).toBe(true);
  });
  test("a funding of 65 pairs is refused, 64 pass", () => {
    expect(withinLimits([fund(idOf(2), ...many(64, () => 1n))]).ok).toBe(true);
    expect(withinLimits([fund(idOf(2), ...many(65, () => 1n))]))
      .toEqual({ ok: false, error: { _tag: "too_many_pairs", pairs: 65, max: 64 } });
  });
  test("250 pairs over all fundings pass, 251 are refused", () => {
    const fundings = (last: number) => [fund(idOf(2), ...many(64, () => 1n)), fund(idOf(3), ...many(64, () => 1n)),
      fund(idOf(4), ...many(64, () => 1n)), fund(idOf(5), ...many(last, () => 1n))];
    expect(withinLimits(fundings(58)).ok).toBe(true);
    expect(withinLimits(fundings(59)))
      .toEqual({ ok: false, error: { _tag: "too_many_pairs", pairs: 251, max: 250 } });
  });
  test("a kind whose own limit is above the total is held by the total", () => {
    expect(withinLimits(many(50, () => deposit(1n))).ok).toBe(true);
    expect(withinLimits(many(51, () => reserveToReserve(1n))))
      .toEqual({ ok: false, error: { _tag: "too_many_ops", total: 51, max: 50 } });
  });
});
