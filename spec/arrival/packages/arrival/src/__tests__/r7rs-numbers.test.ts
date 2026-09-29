/**
 * R7RS numeric-tower conformance — bug ledger (RATIO representation).
 *
 * Why this file was inverted
 * ---------------------------
 * This file used to pin the bigint-rational representation (`AExact = (num:
 * bigint, denom: bigint)`, arbitrary precision). `docs/design-history/
 * arrival-one-number-rework.md` replaced that with
 * **RATIO**: `AExact = (num: number, denom: number)`, both JS `number`s,
 * `Number.isSafeInteger` at all times, gcd-normalized, `denom > 0`. The load
 * -bearing invariant (its §0.2-§0.3): exact arithmetic on safe operands is
 * exact — but the moment a result's numerator or denominator would leave
 * safe-integer range, the operation THROWS a teaching error instead of
 * silently widening to bigint or silently rounding to a float. This is the
 * opposite trade of the old implementation, which never overflowed (bigints
 * are arbitrary precision) but was lossy on cross-representation compares
 * once a component left `Number.isSafeInteger` range in the *coercion* path.
 *
 * Net effect on every row below:
 *  - Rational division/arithmetic within safe range now STAYS EXACT (this
 *    file used to describe these as future work; they're real now).
 *  - Anything that used to "work" by overflowing into a bigint (`(expt 2
 *    1000)`, huge integer literals/compares) now THROWS on construction —
 *    named, taught, by design (§0.3), not a regression.
 *  - The encode-edge exactness law (§2.2) fixes the "loose codec re-derives
 *    exactness from value shape" bug family: `(exact? (floor 2.5))`,
 *    `(exact? (quotient 7.0 2))`, `(exact? (gcd 4.0 6))`, `(exact? (abs
 *    -0.0))` are all `#f` now — the box's own exactness threads through,
 *    it's never re-guessed from the numeric value at the JS/scheme boundary.
 *
 * Style — same as before: each `it` names the pinned behavior, comment cites
 * the plan section/file:line the behavior is enforced at.
 */

import { describe, expect, it } from "vitest";
import { execOverFrame as exec } from "../eval/generator-exec.js";
import { freshEnv } from "./_fresh-env.js";

const env = await freshEnv();

const num = (r: unknown): number => {
  if (typeof r === "number") return r;
  if (typeof r === "bigint") return Number(r);
  return Number.NaN;
};

const truthy = (r: unknown): boolean => {
  if (typeof r === "boolean") return r;
  return Boolean(r);
};

async function evalScheme(src: string): Promise<unknown> {
  const [r] = await exec(src, { env });
  return r;
}

describe("r7rs numbers — RATIO exactness (safe-int rationals, plan §2.0/§2.1)", () => {
  it("(/ 1 3) stays exact (a rational, not a float) — RATIO's whole point", async () => {
    // plan §2.0: under RATIO, `/` on two exact safe-int operands with a
    // non-integral result constructs the rational silently (§0.3 "non-
    // integral exact / constructs the rational silently"). This used to be
    // the FLAT-variant's headline loss ("(/ 1 3)" → inexact); ratio keeps it.
    const r = await evalScheme("(exact? (/ 1 3))");
    expect(truthy(r)).toBe(true);
  });

  it("(+ 1/3 1/3 1/3) sums back to exact 1", async () => {
    // Three thirds, gcd-normalized at each step (numeric.ts's checked +
    // fold, per-step safe-int check, §2.1) — lands exactly on 1, not
    // 0.9999999999999998 the way float thirds would.
    const r = await evalScheme("(+ 1/3 1/3 1/3)");
    expect(num(r)).toBe(1);
    expect(truthy(await evalScheme("(exact? (+ 1/3 1/3 1/3))"))).toBe(true);
  });

  it("numerator/denominator of a non-trivial rational reduce via gcd", async () => {
    // (/ 6 4) gcd-normalizes to 3/2 at construction (AExact invariant, §2.1).
    const n = await evalScheme("(numerator (/ 6 4))");
    const d = await evalScheme("(denominator (/ 6 4))");
    expect(num(n)).toBe(3);
    expect(num(d)).toBe(2);
  });

  it("egress divides — the JS face of an exact rational is always a plain float", async () => {
    // plan §2.0: "toJS(1/3) = 0.333…" — projection∘borrow, same law as
    // nil-as-array. There is no rational face outside scheme space.
    const r = await evalScheme("(/ 1 3)");
    expect(typeof r).toBe("number");
    expect(r).toBeCloseTo(0.333333333333, 10);
  });
});

describe("r7rs numbers — component overflow THROWS (plan §0.3, crash-on-overflow ruling)", () => {
  it("(expt 2 1000) throws an exact-overflow error, never a silent float or bigint", async () => {
    // The old implementation's headline "fix" (bigint expt) is now the
    // wrong behavior under the ruling: exact results whose components
    // leave safe-integer range THROW (mint-numeric.ts's checkedMul/checked,
    // via numeric.ts's checkedPow — see the ExactOverflowError chain).
    // Never silently promotes to bigint (bigint is an opaque host type
    // now, not a scheme number, §2.3), never silently returns a lossy float.
    await expect(evalScheme("(expt 2 1000)")).rejects.toThrow(/exact overflow/i);
  });

  it("(* 94906266 94906266) throws on op-level component overflow (both operands individually safe)", async () => {
    // 94906266 is itself a safe integer; the PRODUCT (9007199326062756)
    // exceeds Number.MAX_SAFE_INTEGER — this is the "op-level" overflow
    // case (distinct from a literal that's already too big to parse,
    // below), caught by checkedMul inside the `*` fold.
    await expect(evalScheme("(* 94906266 94906266)")).rejects.toThrow(/exact overflow/i);
  });

  it("(+ 9007199254740992 1) throws — 2^53 itself is already outside Number.isSafeInteger", async () => {
    // Number.MAX_SAFE_INTEGER is 2^53 - 1; the literal 9007199254740992
    // (== 2^53) is rejected at PARSE time (reader/parsing.ts's
    // toSafeExactComponent/exactOverflowInLiteral), before the `+` even
    // runs. A ParseError, not an ExactOverflowError — still a thrown,
    // teaching error either way.
    await expect(evalScheme("(+ 9007199254740992 1)")).rejects.toThrow(/exceeds safe-integer/i);
  });

  it("a source literal beyond safe-integer range is a ParseError, not a silent bigint promotion", async () => {
    // Was: `999999999999999998` parsed as an arbitrary-precision bigint
    // exact. Now: the parser's safe-int gate (reader/parsing.ts) throws at
    // read time — the author is told to write it inexact instead.
    await expect(evalScheme("999999999999999998")).rejects.toThrow(/exceeds safe-integer range/i);
  });

  it("the old huge-integer '<' comparison bug is moot — both literals now ParseError before compare runs", async () => {
    // This row used to pin a bigint cross-multiplication compare fix
    // ("(< 999999999999999998 999999999999999999)" → #t). Under the
    // safe-int-only ruling neither literal can be constructed as exact at
    // all, so the whole expression throws at parse time — there is no
    // longer a comparison to get right or wrong for magnitudes this size.
    await expect(evalScheme("(< 999999999999999998 999999999999999999)")).rejects.toThrow(
      /exceeds safe-integer range/i,
    );
  });
});

describe("r7rs numbers — the encode-edge exactness law (plan §2.2)", () => {
  it("(exact? (floor 2.5)) is #f — floor of an inexact stays inexact", async () => {
    // Old bug: the loose codec's encode arm re-derived exactness from the
    // VALUE (isSafeInteger(2.0) → true → wrongly boxed AExact). Fixed by
    // routing floor/ceiling/truncate/round box-native off the coerced
    // ANumeric directly (scheme-zod.ts, numeric.ts) — exactness threads
    // from the operand's own box, never re-guessed from the result shape.
    const r = await evalScheme("(exact? (floor 2.5))");
    expect(truthy(r)).toBe(false);
  });

  it("(exact? (quotient 7.0 2)) is #f — one inexact operand contaminates the result", async () => {
    const r = await evalScheme("(exact? (quotient 7.0 2))");
    expect(truthy(r)).toBe(false);
  });

  it("(exact? (gcd 4.0 6)) is #f — same contagion law for gcd/lcm", async () => {
    const r = await evalScheme("(exact? (gcd 4.0 6))");
    expect(truthy(r)).toBe(false);
  });

  it("(exact? (abs -0.0)) is #f — abs of an inexact -0.0 stays inexact 0.0", async () => {
    const r = await evalScheme("(exact? (abs -0.0))");
    expect(truthy(r)).toBe(false);
  });
});

describe("r7rs numbers — passing invariants (regression guards, unchanged by the rework)", () => {
  it("expt of two exact small integers stays exact when the result fits a safe int", async () => {
    const r = await evalScheme("(exact? (expt 2 10))");
    expect(truthy(r)).toBe(true);
  });

  it("(expt 0 0) is 1 per R7RS § 6.2 special case", async () => {
    const r = await evalScheme("(expt 0 0)");
    expect(num(r)).toBe(1);
  });

  it("(eqv? +inf.0 +inf.0) is #t (R7RS § 6.2)", async () => {
    const r = await evalScheme("(eqv? +inf.0 +inf.0)");
    expect(truthy(r)).toBe(true);
  });

  it("inexact on a rational converts to float (R7RS § 6.2)", async () => {
    const r = await evalScheme("(inexact 1/2)");
    expect(num(r)).toBe(0.5);
  });

  it("(expt 2 -1) returns exact 1/2 (R7RS § 6.2: exact args + exact-representable result → exact)", async () => {
    // Still true under RATIO: 1/2 is trivially within safe-int components.
    const r = await evalScheme("(exact? (expt 2 -1))");
    expect(truthy(r)).toBe(true);
  });

  it("(exact 1e-10) does NOT throw and returns an exact rational (simplestInRange approximation, kept from pre-rework)", async () => {
    // `exact`/`inexact->exact` on a runtime float value use the
    // simplestInRange (continued-fraction) approximation, same
    // algorithm as before the rework, just ported bigint→number
    // (Sweep 1 report: "floatToRational... stays"). This is NOT the
    // literal IEEE-754 bit-exact fraction (which for most floats would
    // need a component > 2^53 and would have to throw) — it's the
    // "reasonably close" exact representation R7RS §6.2.6 permits.
    const r = await evalScheme("(exact 1e-10)");
    expect(truthy(r === undefined ? false : await evalScheme("(exact? (exact 1e-10))"))).toBe(true);
    expect(truthy(await evalScheme("(= (exact 1e-10) 1/10000000000)"))).toBe(true);
  });

  it('(number->string 5.0) preserves the inexact mark ("5." or "5.0", not "5")', async () => {
    const r = await evalScheme("(number->string 5.0)");
    const s = typeof r === "string" ? r : String((r as { valueOf: () => unknown }).valueOf());
    expect(["5.", "5.0"]).toContain(s);
  });

  it("exact->inexact is bound (R5RS alias, R7RS-compatible naming)", async () => {
    const r = await evalScheme("(exact->inexact 1/2)");
    expect(num(r)).toBe(0.5);
  });

  it("inexact->exact is bound and does NOT throw on a safe-range rational (0.5 → exact 1/2)", async () => {
    // NOTE for the reader/Gate: docs/design-history/arrival-one-
    // number-rework.md §2.1 has a line reading "`inexact->exact 0.5` →
    // error" in its resolved-decisions list. Verified against the
    // ACTUALLY LANDED implementation (Sweeps 1-4): `(inexact->exact
    // 0.5)` does not throw — 0.5's simplestInRange approximation is the
    // small, safe rational 1/2, well within the safe-int component
    // bound, and this matches R7RS §6.2.6 ("exact" must return AN exact
    // representation, not necessarily the literal IEEE-754 bit-fraction)
    // plus the pre-rework passing behavior this row already pinned. The
    // plan's "error" bullet reads as a leftover from an earlier (pre-
    // RATIO-ruling) draft where `exact` could only represent integers;
    // under RATIO it doesn't apply. Flagged in the sweep report rather
    // than silently reconciled — if this is wrong, the fix belongs in
    // `env/r7rs/numeric.ts`'s `exactFn`, not here.
    const r = await evalScheme("(inexact->exact 0.5)");
    expect(truthy(await evalScheme("(exact? (inexact->exact 0.5))"))).toBe(true);
    expect(num(r)).toBe(0.5);
  });

  it("(inexact->exact +inf.0) and (inexact->exact +nan.0) still throw — no exact representation exists", async () => {
    // §2.1: "`inexact->exact` of NaN/Inf keeps throwing" — unaffected by
    // the representation swap, there is no rational approximation of a
    // non-finite value.
    await expect(evalScheme("(inexact->exact +inf.0)")).rejects.toThrow();
    await expect(evalScheme("(inexact->exact +nan.0)")).rejects.toThrow();
  });

  it("(inexact->exact -0.0) is exact 0 (chibi pins this; -0 is unconstructible as exact)", async () => {
    // §0.6: exact -0 is unconstructible (the AExact constructor
    // normalizes `x === 0 ? 0 : x`). Converting inexact -0.0 lands on
    // plain exact 0, not a signed exact zero.
    const r = await evalScheme("(inexact->exact -0.0)");
    expect(num(r)).toBe(0);
    expect(truthy(await evalScheme("(exact? (inexact->exact -0.0))"))).toBe(true);
  });

  it("(quotient (/ 3 2) 1) throws — quotient requires integer arguments (R7RS), a non-integral rational doors", async () => {
    // Sweep 1: quotient retargeted from z.bigint onto z.schemeNumber +
    // toIntegerPair, door message "quotient: not an integer" (was the
    // generic "argument 0 type mismatch").
    await expect(evalScheme("(quotient (/ 3 2) 1)")).rejects.toThrow(/quotient: not an integer/);
  });

  it("(/ 1 0) still errors — exact division by exact zero is R7RS, not repealed by the ratio rework", async () => {
    await expect(evalScheme("(/ 1 0)")).rejects.toThrow(/division by zero/i);
  });

  it("(sort (list 1 1.0 2 2.0) >) is a stable sort across exact/inexact equal-valued pairs", async () => {
    // (= 1 1.0) is #t (cross-exactness numeric equality), but the two
    // boxes are NOT eqv?/equal? (§0.6) — a stable sort must preserve their
    // relative input order among equal-valued elements.
    const sorted = await evalScheme("(sort (list 1 1.0 2 2.0) >)");
    const values = Array.from(sorted as ArrayLike<unknown>).map(num);
    expect(values).toEqual([2, 2, 1, 1]);
    const exactness = await evalScheme("(map exact? (sort (list 1 1.0 2 2.0) >))");
    expect(Array.from(exactness as ArrayLike<unknown>).map(truthy)).toEqual([true, false, true, false]);
  });

  it('(string->number "10/2") reduces to exact 5 (integral rational, safe components)', async () => {
    const r = await evalScheme('(string->number "10/2")');
    expect(num(r)).toBe(5);
    expect(truthy(await evalScheme('(exact? (string->number "10/2"))'))).toBe(true);
  });
});

describe("r7rs numbers — cross-exactness identity (plan §0.6, unchanged by the rework)", () => {
  it("(= 1 1.0) is #t but (eqv? 1 1.0) and (equal? 1 1.0) are #f", async () => {
    // Post-rework the payloads collide (both are plain JS numbers) — only
    // the Setoid dispatch ordering (structural-equal.ts) staying BEFORE
    // the valueOf fast path keeps eqv?/equal? correctly box-sensitive.
    // This is the row that guards against that regression.
    expect(truthy(await evalScheme("(= 1 1.0)"))).toBe(true);
    expect(truthy(await evalScheme("(eqv? 1 1.0)"))).toBe(false);
    expect(truthy(await evalScheme("(equal? 1 1.0)"))).toBe(false);
  });

  it("(eqv? 0.0 -0.0) is #f — signed-zero distinction survives the rework (inexact payloads only)", async () => {
    expect(truthy(await evalScheme("(eqv? 0.0 -0.0)"))).toBe(false);
  });
});
