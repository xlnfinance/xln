// Reviewer A of #69: the headroom is the number the report states (8x), and a refused-only walk is judged by the same rule.
import { expect, test } from "bun:test";
import { GAS_HEADROOM, gasHeadroomLines } from "./sent-checks.ts";

test("the gas headroom is eight times, as the report says (the measured ratio is about 35, so a weaker bound hides a regression and a stronger one fails honest walks)", () => {
  expect(GAS_HEADROOM).toBe(8n);
  expect(gasHeadroomLines({ tag: "W", disputes: false, budget: 14_000_000n }, { peakGas: () => 1_750_000n })).toEqual([]);
  expect(gasHeadroomLines({ tag: "W", disputes: false, budget: 14_000_000n }, { peakGas: () => 1_750_001n })).toHaveLength(1);
});
