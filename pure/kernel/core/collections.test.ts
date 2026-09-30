import { describe, expect, test } from "bun:test";
import { bump, firstBy, mapDelete, mapSet, mapSetAll } from "./collections.ts";

describe("kernel/collections", () => {
  test("operations return a new map and leave the old one alone", () => {
    const base: ReadonlyMap<string, number> = new Map([["a", 1]]);
    expect([...mapSet(base, "b", 2)]).toEqual([["a", 1], ["b", 2]]);
    expect([...mapDelete(base, "a")]).toEqual([]);
    expect([...base]).toEqual([["a", 1]]);
  });

  test("mapSetAll equals repeated mapSet: a later entry wins and an existing key keeps its place", () => {
    const base: ReadonlyMap<string, number> = new Map([["a", 1], ["b", 2]]);
    const entries = [["b", 20], ["c", 3], ["a", 10], ["c", 30]] as const;
    const folded = entries.reduce((m, [k, v]) => mapSet(m, k, v), base);
    expect([...mapSetAll(base, entries)]).toEqual([...folded]);
    expect([...mapSetAll(base, entries)]).toEqual([["a", 10], ["b", 20], ["c", 30]]);
  });

  test("bump adds, and a count that reaches zero leaves the map", () => {
    const counts: ReadonlyMap<string, bigint> = new Map([["a", 2n]]);
    expect(bump(counts, "a", 3n).get("a")).toBe(5n);
    expect(bump(counts, "a", -2n).has("a")).toBe(false);
    expect(bump(counts, "b", 1n).get("b")).toBe(1n);
  });

  test("firstBy keeps the first item per key, drops taken keys, keeps keyless items", () => {
    const items = [
      { id: "x", n: 1 }, { id: "y", n: 2 }, { id: "x", n: 3 }, { id: undefined, n: 4 }, { id: undefined, n: 5 },
    ];
    expect(firstBy(items, (i) => i.id).map((i) => i.n)).toEqual([1, 2, 4, 5]);
    expect(firstBy(items, (i) => i.id, ["y"]).map((i) => i.n)).toEqual([1, 4, 5]);
  });
});
