// The signed gas budget: the Depository's numbers, and a sizing that never asks for more than the chain's cap.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { MIN_GAS_BUDGET } from "../batch/sealed.ts";
import {
  MARGIN_PERCENT, POST_CALL_RESERVE, TRANSFORMER_DECODE_LIMIT, TRANSFORMER_POST_CALL_RESERVE, budgetFor, fitsCap,
  maxBudget, requirement,
} from "./gas.ts";

const depository = readFileSync(new URL("../../../contracts/contracts/Depository.sol", import.meta.url), "utf8");
const account = readFileSync(new URL("../../../contracts/contracts/Account.sol", import.meta.url), "utf8");

const solConstant = (source: string, name: string): bigint => {
  const text = new RegExp(`${name}\\s*=\\s*([0-9_]+)`).exec(source)?.[1] ?? "";
  return BigInt(text.replaceAll("_", ""));
};

describe("R-SIMULATE gas numbers are the deployed contract's", () => {
  test("the post-call reserve is BATCH_POST_CALL_RESERVE", () => {
    expect(POST_CALL_RESERVE).toBe(solConstant(depository, "BATCH_POST_CALL_RESERVE"));
  });
  test("the transformer reserve is what Account keeps for the staticcall and the argument decode", () => {
    expect(TRANSFORMER_POST_CALL_RESERVE).toBe(solConstant(account, "TRANSFORMER_POST_CALL_GAS_RESERVE"));
    expect(TRANSFORMER_DECODE_LIMIT).toBe(solConstant(account, "TRANSFORMER_ARGUMENT_DECODE_GAS_LIMIT"));
  });
  test("the requirement is the contract's `budget * 64 / 63 + reserve` on top of the prelude, rounded up", () => {
    expect(requirement(0n, 63n)).toBe(64n + POST_CALL_RESERVE);
    expect(requirement(0n, 64n)).toBe(66n + POST_CALL_RESERVE);
    expect(requirement(1_000n, MIN_GAS_BUDGET)).toBe(1_000n + 507_937n + POST_CALL_RESERVE);
  });
});

describe("R-SIMULATE the budget is the self-call's gas plus a margin, never below the minimum", () => {
  test("a small measurement signs the minimum", () => {
    expect(budgetFor(1n)).toBe(MIN_GAS_BUDGET);
    expect(budgetFor(100_000n)).toBe(MIN_GAS_BUDGET);
  });
  test("a large one is the measurement and the margin", () => {
    expect(budgetFor(3_000_000n)).toBe(3_000_000n + (3_000_000n * MARGIN_PERCENT) / 100n);
  });
  test("the margin is the decided ten percent", () => {
    expect(budgetFor(3_000_000n)).toBe(3_300_000n);
  });
  test("it never signs less than the gas the self-call needed", () => {
    expect([0n, 1n, 499_999n, 500_000n, 1_000_001n, 15_000_000n].every((gas) => budgetFor(gas) >= gas)).toBe(true);
  });
});

describe("R-SIMULATE never sign a batch whose transaction exceeds the chain's gas cap", () => {
  const cases = [[16_777_216n, 4_900_000n], [16_777_216n, 64_391n], [30_000_000n, 0n], [1_000_000n, 100_000n]] as const;
  test("the largest budget fits the cap and one more does not", () => {
    cases.forEach(([cap, prelude]) => {
      const largest = maxBudget(cap, prelude);
      expect([fitsCap(cap, prelude, largest), fitsCap(cap, prelude, largest + 1n)]).toEqual([true, false]);
    });
  });
  test("a cap that cannot carry the prelude and the reserve has no budget", () => {
    expect(maxBudget(100_000n, 100_000n)).toBe(0n);
    expect(maxBudget(100_000n, 90_000n)).toBe(0n);
  });
  test("the cap is inclusive: a transaction of exactly the cap fits", () => {
    expect(fitsCap(requirement(5n, 63_000n), 5n, 63_000n)).toBe(true);
    expect(fitsCap(requirement(5n, 63_000n) - 1n, 5n, 63_000n)).toBe(false);
  });
});
