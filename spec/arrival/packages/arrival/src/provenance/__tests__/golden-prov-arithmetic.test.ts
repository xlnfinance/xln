/**
 * GOLDEN CAPTURE (gate G2 oracle) — arithmetic + core-stdlib provenance.
 *
 * The `--ir-lineage` flag does NOT exist yet, so the CURRENT eager engine — flat
 * `ReadonlySet<number>` accumulated per-op via `withInputProvenance` — IS the
 * golden oracle. When the static lineage tree is wired behind the flag, gate G2
 * requires `provenance(static, flag-on) == provenance(eager, flag-off)` on these
 * same programs — flag-off must stay byte-identical to what is frozen here.
 *
 * Scope: pure ops over literals (mint nothing), pure ops over one source
 * (propagate), arithmetic merges of ≥2 sources (union), the string collapse
 * path, and the list element-vs-container projections (car/cdr/cons).
 * string-length drops are load-bearing for byte-equivalence. cdr's projected
 * sub-spine and append's rebuilt head carry the deep-collapsed union of their
 * elements (P10).
 */
import { describe, it, expect } from "vitest";
import { sStr, sNum, run, runRaw } from "../../__tests__/_lineage-test-helpers.js";
import { provOf } from "../lineage.js";
import { toJS } from "../../membrane/rosetta.js";

// Standard stamped fixtures, fresh per call (AValues are immutable, but a fresh
// object keeps each test independent and the intent readable at the call site).
const strs = () => ({ a: sStr("a", 100), b: sStr("b", 200), c: sStr("c", 300) });
const nums = () => ({ a: sNum(10, 100), b: sNum(20, 200), c: sNum(30, 300) });

// ─────────────────────────────────────────────────────────────────────────────
// (1) PURE OPS OVER LITERALS — mint nothing. Provenance is born only at Rosetta
//     crossings (§5); a pure op fed only self-evaluating data carries an empty set.
// ─────────────────────────────────────────────────────────────────────────────
describe("GOLDEN — pure ops over literals mint NOTHING (empty provenance)", () => {
  it("(+ 1 2) — addition of two literals", async () => {
    const v = await runRaw(`(+ 1 2)`);
    expect(v).toBeDefined();
    expect(toJS(v!)).toBe(3);
    expect(provOf(v)).toEqual([]);
  });

  it("(* 2 3) — multiplication of two literals", async () => {
    const v = await runRaw(`(* 2 3)`);
    expect(v).toBeDefined();
    expect(toJS(v!)).toBe(6);
    expect(provOf(v)).toEqual([]);
  });

  it("(- 10 (* 2 3)) — a nested all-literal arithmetic tree", async () => {
    const v = await runRaw(`(- 10 (* 2 3))`);
    expect(v).toBeDefined();
    expect(toJS(v!)).toBe(4);
    expect(provOf(v)).toEqual([]);
  });

  it("(< 1 2) — a literal comparison", async () => {
    const v = await runRaw(`(< 1 2)`);
    expect(v).toBeDefined();
    expect(toJS(v!)).toBe(true);
    expect(provOf(v)).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (2) PURE OPS OVER ONE SOURCE — propagate, never mint. A single provenance-bearing
//     operand passes its ids straight through (the lineage "pipe" node).
// ─────────────────────────────────────────────────────────────────────────────
describe("GOLDEN — pure ops over ONE source propagate it (pipe)", () => {
  it("(string-length a) — a cardinality observation propagates its one source", async () => {
    // length is a fact ABOUT the string, so it carries the string's source — the
    // same treatment list-length gets. (Was a documented eager DROP; DR2/B1 resolved
    // toward fullCone — the count is attributed to the string it measured.)
    expect(await run(`(string-length a)`, strs())).toMatchInlineSnapshot(`
      [
        100,
      ]
    `);
  });

  it("(* x x) — one source used twice, still just its id", async () => {
    expect(await run(`(* x x)`, { x: sNum(7, 200) })).toMatchInlineSnapshot(`
      [
        200,
      ]
    `);
  });

  it("(+ a 5) — source merged with a literal carries only the source", async () => {
    expect(await run(`(+ a 5)`, nums())).toMatchInlineSnapshot(`
      [
        100,
      ]
    `);
  });

  it("(abs a) — a unary pure op passes its source through", async () => {
    expect(await run(`(abs a)`, nums())).toMatchInlineSnapshot(`
      [
        100,
      ]
    `);
  });

  it("(< 0 (* x x)) — predicate over a single source mints nothing of its own", async () => {
    // The design's own pipe example: `<` and `*` add nothing; only x's id survives.
    expect(await run(`(< 0 (* x x))`, { x: sNum(7, 200) })).toMatchInlineSnapshot(`
      [
        200,
      ]
    `);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (3) ARITHMETIC MERGES OF ≥2 SOURCES — union. Two-or-more provenance-bearing
//     operands fan in (the lineage "merge" node); the result carries the union.
// ─────────────────────────────────────────────────────────────────────────────
describe("GOLDEN — arithmetic merges of ≥2 sources UNION their provenance (merge)", () => {
  it("(+ a b) — two sources fan in", async () => {
    expect(await run(`(+ a b)`, nums())).toMatchInlineSnapshot(`
      [
        100,
        200,
      ]
    `);
  });

  it("(- a b) — subtraction unions both (order/direction irrelevant to the cone)", async () => {
    expect(await run(`(- a b)`, nums())).toMatchInlineSnapshot(`
      [
        100,
        200,
      ]
    `);
  });

  it("(/ a b) — division unions both", async () => {
    expect(await run(`(/ a b)`, nums())).toMatchInlineSnapshot(`
      [
        100,
        200,
      ]
    `);
  });

  it("(< a b) — a comparison over two sources unions both", async () => {
    expect(await run(`(< a b)`, nums())).toMatchInlineSnapshot(`
      [
        100,
        200,
      ]
    `);
  });

  it("(max a b) — n-ary numeric merge unions both", async () => {
    expect(await run(`(max a b)`, nums())).toMatchInlineSnapshot(`
      [
        100,
        200,
      ]
    `);
  });

  it("(* a (+ 1 b)) — merge over a source and a one-source pipe", async () => {
    // The literal 1 contributes nothing, so (+ 1 b) is a pipe carrying just b;
    // the outer * then merges a with b. Mirrors the spike's (* val1 (+ 1 val2)).
    expect(await run(`(* a (+ 1 b))`, nums())).toMatchInlineSnapshot(`
      [
        100,
        200,
      ]
    `);
  });

  it("(+ a (* b c)) — three sources fan in across two levels", async () => {
    expect(await run(`(+ a (* b c))`, nums())).toMatchInlineSnapshot(`
      [
        100,
        200,
        300,
      ]
    `);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (4) STRING COLLAPSE PATH — string-append / join. Collapsing structured stamped
//     values into one flat string must deep-walk and hoist EVERY reachable point
//     (collapseProvenance); a gap is a SILENT hole. End-to-end golden here.
// ─────────────────────────────────────────────────────────────────────────────
describe("GOLDEN — string collapse path (string-append / join) hoists every point", () => {
  it("(string-append a b) — two stamped strings union", async () => {
    expect(await run(`(string-append a b)`, strs())).toMatchInlineSnapshot(`
      [
        100,
        200,
      ]
    `);
  });

  it('(join "," (list a b)) — join over a list of stamped strings', async () => {
    expect(await run(`(join "," (list a b))`, strs())).toMatchInlineSnapshot(`
      [
        100,
        200,
      ]
    `);
  });

  it('(string-append "x:" (join "," (list a b))) — nested collapse keeps every point', async () => {
    expect(await run(`(string-append "x:" (join "," (list a b)))`, strs())).toMatchInlineSnapshot(`
      [
        100,
        200,
      ]
    `);
  });

  it("(string-append a b c) — three-way collapse", async () => {
    expect(await run(`(string-append a b c)`, strs())).toMatchInlineSnapshot(`
      [
        100,
        200,
        300,
      ]
    `);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (5) LIST OPS — element-vs-container projection. car/cdr are element projections
//     (§5.3); cons unions both car+cdr onto the container; list builds a spine.
//     The asymmetry between cdr-of-cons (an element) and cdr-of-list (a sub-spine)
//     is the load-bearing detail the static path must reproduce.
// ─────────────────────────────────────────────────────────────────────────────
describe("GOLDEN — list element-vs-container provenance (car / cdr / cons)", () => {
  it("(cons a b) — the cons cell carries the UNION of both elements", async () => {
    expect(await run(`(cons a b)`, strs())).toMatchInlineSnapshot(`
      [
        100,
        200,
      ]
    `);
  });

  it("(car (cons a b)) — car projects the head element only", async () => {
    expect(await run(`(car (cons a b))`, strs())).toMatchInlineSnapshot(`
      [
        100,
      ]
    `);
  });

  it("(cdr (cons a b)) — cdr of a DOTTED pair projects the tail element only", async () => {
    expect(await run(`(cdr (cons a b))`, strs())).toMatchInlineSnapshot(`
      [
        200,
      ]
    `);
  });

  it("(car (list a b)) — car of a proper list projects the head element", async () => {
    expect(await run(`(car (list a b))`, strs())).toMatchInlineSnapshot(`
      [
        100,
      ]
    `);
  });

  it("(car (cdr (list a b c))) — cadr projects the second element", async () => {
    expect(await run(`(car (cdr (list a b c)))`, strs())).toMatchInlineSnapshot(`
      [
        200,
      ]
    `);
  });

  it("(cons a (list)) — head element onto an empty tail carries just the head", async () => {
    expect(await run(`(cons a (list))`, strs())).toMatchInlineSnapshot(`
      [
        100,
      ]
    `);
  });

  it("(cdr (list a b)) — FIXED (conservation repair): the tail sub-spine carries b's id, not empty", async () => {
    // The tail is the next cons cell (a Pair), not the element `b` — but that cons cell is now
    // stamped with the deep-collapsed union of what it still reaches (P10), matching the
    // element-vs-container convention cons/list already honor at the top level.
    expect(await run(`(cdr (list a b))`, strs())).toMatchInlineSnapshot(`
      [
        200,
      ]
    `);
  });

  it("(append (list a) (list b)) — FIXED (conservation repair): the rebuilt head unions both operands", async () => {
    // append reconstructs the result spine; the fresh head cell is now stamped with the
    // deep-collapsed union of both operands' elements (P10), matching cons' union-onto-
    // container convention instead of dropping to empty.
    expect(await run(`(append (list a) (list b))`, strs())).toMatchInlineSnapshot(`
      [
        100,
        200,
      ]
    `);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GATE TODOs (G2 equivalence) — the static-path assertion is `flag-on == eager
// golden`. The flag is unbuilt, so these are `it.todo`: they pin the INTENT that,
// once `--ir-lineage` lands, each program above re-run under the static tree must
// reproduce the SAME sorted provenance frozen by the snapshots in this file.
// Promote to live `expect(staticRun(...)).toEqual(eagerGolden)` when the flag exists.
//
// cdr-of-list-spine and append-rebuild used to be pinned here as "documented
// asymmetries" — REPAIRED (conservation repair, RULINGS.md R2) and moved up into
// the regular list-provenance describe above; no longer asymmetries.
// ─────────────────────────────────────────────────────────────────────────────
describe("GATE G2 (equivalence) — static lineage must match these eager goldens [TODO: flag unbuilt]", () => {
  it.todo("flag-on (+ a b) provenance === eager golden (merge union)");
  it.todo("flag-on (* x x) provenance === eager golden (one-source pipe)");
  it.todo("flag-on (string-append a b) provenance === eager golden (collapse path)");
  it.todo("flag-on (car (cons a b)) provenance === eager golden (element projection)");
  it.todo("flag-on (cdr (list a b)) provenance === eager golden (spine union, conservation-repaired)");
  it.todo("flag-on (append (list a) (list b)) provenance === eager golden (rebuild union, conservation-repaired)");
  it.todo("flag-OFF every program above is BYTE-IDENTICAL to the snapshots in this file");
});
