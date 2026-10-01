// Each check over what the shim sent (sent-checks.ts) passes an honest walk and goes red on the planted state it exists to catch.
import { describe, expect, test } from "bun:test";
import type { StartSent } from "../fork-shim.ts";
import { GAS_HEADROOM, gasHeadroomLines, startEpochLines } from "./sent-checks.ts";

const BUDGET = 14_000_000n;
const scope = { tag: "WALK", disputes: true, budget: BUDGET };
const start = (declared: bigint, current: bigint): StartSent => ({ entityId: "0xa", counterentity: "0xb", declared, current });
const sentOf = (starts: readonly StartSent[], landed = 5) => ({ landed: () => landed, starts: () => starts });

describe("C1: a dispute start carries the epoch its Account holds", () => {
  test("a start at the moved epoch it declared is clean", () => {
    expect(startEpochLines(scope, sentOf([start(2n, 2n)]))).toEqual([]);
  });
  test("C1: a start that declares another epoch than the chain held is red (the always-zero and wrong-pair shim mutants)", () => {
    expect(startEpochLines(scope, sentOf([start(0n, 2n)]))).toHaveLength(1);
  });
  test("C1: a disputes walk whose every start was at epoch zero never checked the epoch, and is red", () => {
    expect(startEpochLines(scope, sentOf([start(0n, 0n)]))).toHaveLength(1);
    expect(startEpochLines(scope, sentOf([]))).toHaveLength(1);
  });
  test("a walk of another area, or one that sent nothing, owes no moved-epoch start", () => {
    expect(startEpochLines({ ...scope, disputes: false }, sentOf([start(0n, 0n)]))).toEqual([]);
    expect(startEpochLines(scope, sentOf([], 0))).toEqual([]);
  });
});

describe("the signed gas budget is a ceiling above every batch", () => {
  test("a budget far above the heaviest batch is clean", () => {
    expect(gasHeadroomLines(scope, { peakGas: () => 400_000n })).toEqual([]);
  });
  test("a budget within the headroom of the heaviest batch is red (the 500,000 shim mutant)", () => {
    expect(gasHeadroomLines({ ...scope, budget: 500_000n }, { peakGas: () => 400_000n })).toHaveLength(1);
  });
  test("the edge: exactly the headroom passes, one gas less room fails", () => {
    expect(gasHeadroomLines({ ...scope, budget: 100n * GAS_HEADROOM }, { peakGas: () => 100n })).toEqual([]);
    expect(gasHeadroomLines({ ...scope, budget: 100n * GAS_HEADROOM - 1n }, { peakGas: () => 100n })).toHaveLength(1);
  });
});
