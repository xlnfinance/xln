/**
 * Q8b — `OrdinalPath` composition ops (docs/PROVENANCE.md §5 C2/D1, round 3 m4). `ids.ts` already carried the `OrdinalPath` TYPE
 * (Q10); this file's rows are for the ops Q8b adds beside it: `appendOrdinal` (the
 * z-axis nesting primitive), `parentOrdinalPath`/`trailingOrdinal` (the m4 path-scoped
 * aggregation split), `compareOrdinalPaths` (deterministic total order), and
 * `ordinalPathKey` (the template-store reverse index's map key, exercised properly in
 * `template-store.test.ts`).
 */
import { describe, expect, it } from "vitest";
import {
  appendOrdinal,
  compareOrdinalPaths,
  ordinalPathKey,
  parentOrdinalPath,
  ROOT_ORDINAL_PATH,
  trailingOrdinal,
} from "../ids.js";

describe("appendOrdinal — the z-axis nesting primitive (§6 instance-ordinal space)", () => {
  it("appends one ordinal per nested fan/loop instance, deepest last", () => {
    const root = appendOrdinal(ROOT_ORDINAL_PATH, 3); // this graph's root ordinal
    const outer = appendOrdinal(root, 0); // outer fan's 0th element
    const inner = appendOrdinal(outer, 5); // nested fan's 5th element
    expect(inner).toEqual([3, 0, 5]);
  });

  it("never mutates its input — each append is a fresh path", () => {
    const root = appendOrdinal(ROOT_ORDINAL_PATH, 1);
    const a = appendOrdinal(root, 10);
    const b = appendOrdinal(root, 20);
    expect(root).toEqual([1]); // unchanged by either child append
    expect(a).toEqual([1, 10]);
    expect(b).toEqual([1, 20]);
  });
});

describe("parentOrdinalPath / trailingOrdinal — the §5 round-3 m4 aggregation split", () => {
  it("round-trips: appendOrdinal(parentOrdinalPath(p), trailingOrdinal(p)) === p", () => {
    const p = [7, 2, 9];
    const reconstructed = appendOrdinal(parentOrdinalPath(p), trailingOrdinal(p)!);
    expect(reconstructed).toEqual(p);
  });

  it('parentOrdinalPath of a root-only (length-1) path is empty — "runs never span parents"', () => {
    expect(parentOrdinalPath([4])).toEqual([]);
  });

  it("trailingOrdinal of the empty path is undefined (never a real node's path)", () => {
    expect(trailingOrdinal(ROOT_ORDINAL_PATH)).toBeUndefined();
  });
});

describe("compareOrdinalPaths — deterministic total order, parent sorts before child", () => {
  it("orders by shared-prefix ordinal, then by length (shorter/parent first)", () => {
    const paths = [[1, 5], [0], [1], [1, 0], [0, 9]];
    const sorted = [...paths].sort(compareOrdinalPaths);
    expect(sorted).toEqual([[0], [0, 9], [1], [1, 0], [1, 5]]);
  });

  it("is a proper comparator: compare(a,a) === 0", () => {
    expect(compareOrdinalPaths([2, 1], [2, 1])).toBe(0);
  });
});

describe("ordinalPathKey — stable Map/upsert key", () => {
  it("equal paths (by value) produce equal keys", () => {
    expect(ordinalPathKey([1, 2, 3])).toBe(ordinalPathKey([1, 2, 3]));
  });

  it("different paths produce different keys — including a nesting-depth difference", () => {
    expect(ordinalPathKey([1, 2])).not.toBe(ordinalPathKey([1, 2, 0]));
    expect(ordinalPathKey([1])).not.toBe(ordinalPathKey([2]));
  });
});
