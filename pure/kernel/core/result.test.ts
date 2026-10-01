import { describe, expect, test } from "bun:test";
import {
  all, err, everyResult, flatMap, foldResult, map, mapAccum, mapAccumResult, mapErr, ok, traverse, unwrapOr,
} from "./result.ts";

describe("kernel/result", () => {
  test("map, flatMap and mapErr pass a refusal through untouched", () => {
    expect(map(ok(2), (n) => n + 1)).toEqual(ok(3));
    expect(map(err("no"), (n: number) => n + 1)).toEqual(err("no"));
    expect(flatMap(ok(2), (n) => (n > 1 ? err("big") : ok(n)))).toEqual(err("big"));
    expect(mapErr(err("no"), (e) => ({ why: e }))).toEqual(err({ why: "no" }));
    expect(unwrapOr(err("no"), (e) => e.length)).toBe(2);
  });

  test("a fold stops at the first refusal and asks no later item", () => {
    const folded = foldResult([1, 2, 3, 4], 0, (sum, x) => {
      if (x > 3) expect.unreachable(`asked item ${x} after the refusal`);
      return x === 3 ? err(`refused ${x}`) : ok(sum + x);
    });
    expect(folded).toEqual(err("refused 3"));
  });

  test("traverse keeps every output in order, or the first refusal", () => {
    expect(traverse([1, 2, 3], (x) => ok(x * 2))).toEqual(ok([2, 4, 6]));
    expect(traverse([1, 2, 3], (x) => (x >= 2 ? err(x) : ok(x)))).toEqual(err(2));
  });

  test("mapAccum threads the state and collects one output per item", () => {
    expect(mapAccum([1, 2, 3], 10, (s, x) => [s + x, s * x] as const)).toEqual([16, [10, 22, 39]]);
    expect(mapAccumResult([1, 2], 0, (s, x) => ok([s + x, x] as const))).toEqual(ok([3, [1, 2]]));
  });

  test("a fold over a large list is linear, not quadratic", () => {
    const n = 200_000;
    const started = performance.now();
    const folded = traverse(Array.from({ length: n }, (_, i) => i), (x) => ok(x));
    expect(folded.ok && folded.value.length).toBe(n);
    expect(performance.now() - started).toBeLessThan(2_000);
  });

  test("all names the values it collects and returns the first refusal in key order", () => {
    expect(all({ a: ok(1), b: ok("x") })).toEqual(ok({ a: 1, b: "x" }));
    expect(all({ a: ok(1), b: err("b"), c: err("c") })).toEqual(err("b"));
  });

  test("everyResult stops at the first false", () => {
    const result = everyResult([1, 2, 3], (x) => {
      if (x > 2) expect.unreachable(`asked item ${x} after the first false`);
      return ok(x < 2);
    });
    expect(result).toEqual(ok(false));
  });
});
