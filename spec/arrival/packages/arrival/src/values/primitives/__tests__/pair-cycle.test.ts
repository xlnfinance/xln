/**
 * Pair list→JS conversion: cycle safety + one-way array design.
 *
 * Design (acknowledged, 2026-07-08)
 * ---------------------------------
 * `["arrival/toJS"]` produces a JS ARRAY, always. There is NO idempotence /
 * round-trip promise: scheme list → js array → scheme vector. Consequences:
 *   • a proper list `(1 2 3)` → `[1, 2, 3]`
 *   • an improper (dotted) list `(1 . 2)` → `[1, 2]` — the tail folds in as
 *     the last element; the `{__dotted__, list, tail}` shape is retired
 *   • a cyclic list must LOUD-FAIL — JS arrays have no ref-marker notation.
 *     Cycle detection is the iterator's per-traversal WeakSet watchdog
 *     (APair[Symbol.iterator]); toJS is `[...this]` over it.
 *
 * Pair.toString is DIFFERENT: it has always handled cycles via the
 * `__cycles__` / `__ref__` metadata machinery, emitting `#0=` / `#0#` ref
 * markers. toJS must throw; toString must render.
 *
 * Also guards the iterator itself: element order/count (a duplicate-yield
 * regression shipped once), a list whose FIRST element is `'()` (the
 * empty-pair sentinel is `car === undefined && cdr is nil`, NOT `car is
 * nil` — a nil car is a legitimate element), and the empty-pair sentinel.
 */

// NOTE (2026-07-14): these cycles are tied through `__tieKnot`, the designed door, rather than by
// raw `p.cdr = p` assignment. `APair`'s car/cdr became prototype GETTERS (so `AJSArrayList`, the
// lazy spine view over a borrowed JS array, can override them) — and a getter-only property cannot
// be assigned, so the old raw writes now throw `TypeError: Cannot set property cdr`.
//
// That they threw is the useful part: these tests were the ONLY code in the tree still tying knots
// outside the door. `__tieKnot`'s doc has always said it is "the ONE mutation path through APair's
// readonly slots" — the tests just quietly weren't using it, and nothing could tell. The getters
// made the fence real.
import { describe, expect, it } from "vitest";
import { CONSTANT_CTX } from "../../../run/RunContext.js";
import { __tieKnot, APair } from "../APair.js";
import { nil } from "../ANil.js";
import { AExact } from "../AExact.js";

const num = (n: number) => new AExact(n);
const list = (...ns: number[]) => APair.fromArray(CONSTANT_CTX, ns.map(num), false) as APair<any, any>;

describe("APair[Symbol.iterator]", () => {
  it("yields every element exactly once, in order", () => {
    expect([...list(10, 30)].map((v) => (v as AExact).valueOf())).toEqual([10, 30]);
    expect([...list(1, 2, 3)].map((v) => (v as AExact).valueOf())).toEqual([1, 2, 3]);
  });

  it("yields a single-element list once", () => {
    expect([...list(7)].map((v) => (v as AExact).valueOf())).toEqual([7]);
  });

  it("a nil FIRST element is a legitimate element, not the sentinel", () => {
    // (() 1) — car is nil, cdr is a real spine. Must iterate both elements.
    const p = new APair(nil, list(1));
    const items = [...p];
    expect(items).toHaveLength(2);
    expect(items[0]).toBe(nil);
    expect((items[1] as AExact).valueOf()).toBe(1);
  });

  // [impl-pinning] pins the sentinel's exact internal shape (car undefined, cdr nil),
  // not merely its externally observable emptiness.
  it("the empty-pair sentinel (undefined car, nil cdr) iterates empty", () => {
    const p = new APair(undefined as never, nil);
    expect([...p]).toEqual([]);
  });

  it("an improper tail is yielded as the last element", () => {
    // (1 . 2)
    const p = new APair(num(1), num(2));
    expect([...p].map((v) => (v as AExact).valueOf())).toEqual([1, 2]);
  });

  it("throws on a cyclic spine", () => {
    const p = new APair(num(1), nil);
    __tieKnot(p, "cdr", p);
    expect(() => [...p]).toThrow(/cycle/i);
  });
});

describe("Pair.toJS — one-way array conversion", () => {
  it("throws on a self-cycle (cdr points at the head)", () => {
    const p = new APair(num(1), nil);
    __tieKnot(p, "cdr", p);
    expect(() => p["arrival/toJS"]()).toThrow(/cycle/i);
  });

  it("throws on a mutual cycle (two cells pointing at each other)", () => {
    const a = new APair(num(1), nil);
    const b = new APair(num(2), nil);
    __tieKnot(a, "cdr", b);
    __tieKnot(b, "cdr", a);
    expect(() => a["arrival/toJS"]()).toThrow(/cycle/i);
  });

  // [impl-pinning] pins that mark_cycles/have_cycles metadata does not exempt toJS
  // from the cycle throw — the metadata machinery is toString's alone.
  it("throws on a mark_cycles-annotated cycle too (metadata does not exempt)", () => {
    const p = new APair(num(1), nil);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    __tieKnot(p, "cdr", p);
    p.mark_cycles();
    expect(p.have_cycles()).toBe(true);
    expect(() => p["arrival/toJS"]()).toThrow(/cycle/i);
  });

  it("returns an array for a proper list", () => {
    expect(list(1, 2, 3)["arrival/toJS"]()).toEqual([1, 2, 3]);
  });

  it("folds a dotted (improper) tail into the array — no {__dotted__} shape", () => {
    // (1 . 2) → [1, 2]. One-way conversion: (1 2) and (1 . 2) convert equal.
    const p = new APair(num(1), num(2));
    expect(p["arrival/toJS"]()).toEqual([1, 2]);
  });

  it("converts a nested list element to a nested array", () => {
    const p = APair.fromArray(CONSTANT_CTX, [list(1, 2), num(3)], false) as APair<any, any>;
    expect(p["arrival/toJS"]()).toEqual([[1, 2], 3]);
  });

  it("single-element list converts", () => {
    const p = new APair(num(1), nil);
    expect(p["arrival/toJS"]()).toEqual([1]);
  });
});

describe("Pair.toString cycle handling (uses ref-marker notation — fundamentally different)", () => {
  // [impl-pinning] pins the #0=/#0# ref-marker notation itself, not just "doesn't throw".
  it("does NOT throw on a self-cycle (renders via #0= / #0# markers)", () => {
    const p = new APair(num(1), nil);
    __tieKnot(p, "cdr", p);
    p.mark_cycles();
    expect(() => p.toString()).not.toThrow();
    const rendered = p.toString();
    expect(rendered).toMatch(/#0[=#]/);
  });

  it("does NOT throw on a mutual cycle", () => {
    const a = new APair(num(1), nil);
    const b = new APair(num(2), nil);
    __tieKnot(a, "cdr", b);
    __tieKnot(b, "cdr", a);
    a.mark_cycles();
    expect(() => a.toString()).not.toThrow();
  });
});
