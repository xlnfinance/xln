import { describe, expect, it } from "vitest";
import { execOverFrame as exec } from "../eval/generator-exec.js";
import { inferenceEnv } from "../env/inference-env.js";
import { is_false } from "../values/value-guards.js";

/**
 * Comparison divergence ledger — the explicit, visible record of where the comparison ops'
 * LOOSE mode (the default; the friendly superset) departs from STRICT mode (R7RS-faithful;
 * the negative-test probe, per V's F1: "strict isn't for users — it's how WE see where we
 * diverge from spec"). Every row under "STRICT diverges" is one documented departure: loose
 * answers, strict throws.
 *
 * The per-primitive ordering itself is NOT here — it lives on the terms as the tagless-final
 * `arrival/tagless-final/lte` (numbers numeric, strings lexicographic, chars by code point,
 * symbols by name). These ops are the COMBINATOR over that algebra; the conventions made
 * explicit here are: F2 nil-as-bottom, universal-via-lte, cross-type-throws (NOT JS coercion),
 * `=` stays numeric (structural equality is `equal?`), and the F1 strict/loose split.
 *
 * Strict is wired ExecOptions.strict -> EvalContext.strict -> the threaded runCtx.strict the
 * ops read (same path as car/cdr nil-tolerance). The green suite proved nothing relied on the
 * old unconditional nil->#f; THIS pins the new behavior (per feedback-live-verify-is-the-gate).
 */

const run = (code: string, strict: boolean) => exec(code, { env: inferenceEnv.child("cmp-divergence"), strict });
const truthy = async (code: string, strict: boolean): Promise<boolean> => !is_false((await run(code, strict))[0]);

describe("numeric core — identical in both modes (no divergence)", () => {
  it.each([false, true])("strict=%s: numeric < / = / <= compute by value", async (strict) => {
    expect(await truthy("(< 2 10)", strict)).toBe(true); // NOT JS lexicographic "2" > "10"
    expect(await truthy("(< 10 2)", strict)).toBe(false);
    expect(await truthy("(= 1 1.0)", strict)).toBe(true); // exact/inexact tower
    expect(await truthy("(<= 3 3)", strict)).toBe(true);
    expect(await truthy("(> 5 4 3 2 1)", strict)).toBe(true);
    expect(await truthy("(< 1 2 2 3)", strict)).toBe(false);
  });
});

describe("LOOSE: universal ordering (the friendly superset over R7RS-typed comparison)", () => {
  it("orders strings / chars / symbols via their own lte — no string<? needed", async () => {
    expect(await truthy('(< "apple" "banana")', false)).toBe(true);
    expect(await truthy('(>= "z" "a")', false)).toBe(true);
    expect(await truthy("(< #\\a #\\b)", false)).toBe(true);
    expect(await truthy("(< 'apple 'banana)", false)).toBe(true);
  });
});

describe("LOOSE: nil-as-bottom (F2) — nil is the floor of the order", () => {
  it("orderings treat nil as less than every non-nil value", async () => {
    expect(await truthy("(< (quote ()) 5)", false)).toBe(true);
    expect(await truthy("(< 5 (quote ()))", false)).toBe(false);
    expect(await truthy('(< (quote ()) "a")', false)).toBe(true);
    expect(await truthy("(<= (quote ()) (quote ()))", false)).toBe(true);
    expect(await truthy("(< (quote ()) (quote ()))", false)).toBe(false);
  });
  it("= is nil-punning: nil = nil is #t, nil = anything-else is #f", async () => {
    expect(await truthy("(= (quote ()) (quote ()))", false)).toBe(true);
    expect(await truthy("(= (quote ()) 5)", false)).toBe(false);
    expect(await truthy("(= 5 (quote ()))", false)).toBe(false);
  });
});

describe("LOOSE: cross-type throws (V: crashes on incompatible types, NOT the JS '' > [] coercion)", () => {
  it.each(['(< "a" 5)', '(< 5 "a")', "(> #\\a 5)", "(<= 'sym 3)"])("%s throws", async (expr) => {
    await expect(run(expr, false)).rejects.toThrow();
  });
});

describe("= stays NUMERIC (structural equality is equal?) — both modes reject non-numbers", () => {
  it.each([false, true])('strict=%s: (= "a" "a") throws (use equal?/string=?)', async (strict) => {
    await expect(run('(= "a" "a")', strict)).rejects.toThrow();
  });
});

describe("STRICT = R7RS divergence probe — loose answers, strict throws", () => {
  // Each expression: loose gives a verdict (above); strict rejects it as non-R7RS-numeric.
  const DIVERGENT = [
    '(< "a" "b")',
    "(< #\\a #\\b)",
    "(< 'apple 'banana)",
    "(< (quote ()) 5)",
    "(= (quote ()) (quote ()))",
    "(<= (quote ()) (quote ()))",
  ];
  it.each(DIVERGENT)("strict rejects %s (R7RS-numeric only)", async (expr) => {
    await expect(run(expr, true)).rejects.toThrow();
  });
  it("the SAME expressions resolve in loose (this is the divergence)", async () => {
    expect(await truthy('(< "a" "b")', false)).toBe(true);
    expect(await truthy("(< (quote ()) 5)", false)).toBe(true);
    expect(await truthy("(= (quote ()) (quote ()))", false)).toBe(true);
  });
});

describe("sort shares the nil-as-bottom order (F2 lives in one place)", () => {
  it("a mixed list sorts nil to the front, then ascending", async () => {
    expect(await truthy("(equal? (sort (quote (3 () 1))) (quote (() 1 3)))", false)).toBe(true);
  });
});
