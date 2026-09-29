// One-Number Rework (RATIO, crash-on-overflow).
//
// Pins docs/design-history/arrival-one-number-rework.md §0 (invariants) and
// §2 (design) at the SCHEME surface. Every row named in the doc's §3 behavior-row list
// becomes one assertion here.
//
// Harness: `run()` uses execState (COMPLEX tier) plus the boxed result's OWN
// `.toString()` — deliberately NOT `exec()`'s plain-JS exit. `exec()` goes through
// `toJS`, and `toJS(1/3)` is the divided float for either an exact rational or a
// genuinely inexact division — the JS face collapses the distinction this file
// exists to pin. Printing the BOX itself ("1/3" vs "0.333…") keeps exactness
// visible. The one exception is the `toJS`-face row, which pins the membrane's
// divide-on-egress behavior and uses `exec()` on purpose.
import { describe, expect, it } from "vitest";
import { exec, execState } from "../eval/generator-exec.js";
import { ParseError } from "../errors.js";

async function run(src: string): Promise<string> {
  const { values: r } = await execState(src, {});
  const x = r[r.length - 1] as { toString(): string } | undefined;
  return String(x?.toString?.() ?? x);
}

describe("ratio construction — AExact is a genuine (num, denom) rational", () => {
  it.each([
    {
      name: "(/ 1 3) constructs an exact rational, printed 1/3 (not coerced to inexact)",
      input: "(/ 1 3)",
      expected: "1/3",
    },
    {
      name: "(exact? (/ 1 3)) is #t — non-integral exact division stays exact",
      input: "(exact? (/ 1 3))",
      expected: "#t",
    },
    {
      name: "(+ 1/3 1/3 1/3) sums to exact 1 (cross-multiply add, not float accumulation)",
      input: "(+ 1/3 1/3 1/3)",
      expected: "1",
    },
    { name: "(numerator (/ 6 4)) is 3 (reduced form 3/2)", input: "(numerator (/ 6 4))", expected: "3" },
    { name: "(denominator (/ 6 4)) is 2 (reduced form 3/2)", input: "(denominator (/ 6 4))", expected: "2" },
  ])("$name", async ({ input, expected }) => {
    expect(await run(input)).toBe(expected);
  });

  // Egress DIVIDES (§2.0: "toJS(1/3) = 0.333…", the projection∘borrow law — same as
  // nil-as-array): the ONE row that deliberately uses `exec()` (the plain-JS membrane
  // exit) instead of `run()`, because it tests THAT collapse rather than resisting it.
  it("exec()'s JS face of (/ 1 3) is the divided float, not a rational object", async () => {
    const [r] = await exec("(/ 1 3)");
    expect(r).toBeCloseTo(1 / 3, 15);
  });
});

describe("overflow-throws — exact results whose components leave safe-integer range THROW", () => {
  // Both operands are individually safe — 9007199254740991 IS Number.MAX_SAFE_INTEGER,
  // itself a safe integer — deliberately NOT the plan's own literal example
  // `(+ 9007199254740992 1)`, whose first operand (2^53) already exceeds
  // Number.MAX_SAFE_INTEGER on its own and would conflate this row with the separate
  // "over-safe source LITERAL" row below. Safe operands + unsafe RESULT isolates the
  // arithmetic-overflow guarantee from the parser's literal gate.
  it.each([
    {
      // Safe operands + unsafe result isolate op overflow from the parser's literal gate.
      name: "(+ 9007199254740991 1) rejects — exact addition overflowing 2^53 THROWS, never silently widens",
      input: "(+ 9007199254740991 1)",
    },
    {
      // RED until the atom lands (same reason: unbounded bigint today). 94906266 is
      // safe on its own (~9.5e7); its square (9007199326062756) exceeds
      // Number.MAX_SAFE_INTEGER (9007199254740991) — confirmed by direct computation.
      name: "(* 94906266 94906266) rejects — exact multiplication overflowing 2^53 THROWS",
      input: "(* 94906266 94906266)",
    },
    {
      // RED until the atom lands. The doc's own example (§3): a 3-arg `*` fold must
      // catch the overflow at whichever step first leaves safe range, not just at the
      // final accumulated result.
      name: "(* 94906266 94906266 94906266) rejects — per-step overflow check in a variadic fold",
      input: "(* 94906266 94906266 94906266)",
    },
  ])("$name", async ({ input }) => {
    await expect(run(input)).rejects.toThrow(/exact overflow/i);
  });

  it("an over-safe source LITERAL (2^53+1) is a ParseError, not a silently-huge exact", async () => {
    // RED until the atom lands: today's reader has no magnitude ceiling
    // (reader/parsing.ts's parseBigInt has no isSafeInteger gate), so this parses fine
    // into an unbounded exact bigint and evaluates without complaint.
    await expect(run("9007199254740993")).rejects.toBeInstanceOf(ParseError);
  });
});

describe("encode-edge exactness law — codec encode must not re-derive exactness from value shape", () => {
  // All four rows RED until the atom lands: `looseNumber`/`looseAnyNumber`/`z.bigint`'s
  // `encode` currently keys off `Number.isSafeInteger(result)` alone — an
  // integer-valued RESULT mints AExact regardless of whether either OPERAND was
  // inexact (common/scheme-zod.ts's encode arms). The fix (plan §2.2) threads
  // `wantExact` from the coerced operands' boxes instead of re-deriving it.
  it.each([
    { name: "(exact? (floor 2.5)) is #f — floor of an inexact stays inexact", input: "(exact? (floor 2.5))" },
    {
      name: "(exact? (quotient 7.0 2)) is #f — quotient with an inexact operand stays inexact",
      input: "(exact? (quotient 7.0 2))",
    },
    { name: "(exact? (gcd 4.0 6)) is #f — gcd with an inexact operand stays inexact", input: "(exact? (gcd 4.0 6))" },
    { name: "(exact? (abs -0.0)) is #f — abs of an inexact stays inexact", input: "(exact? (abs -0.0))" },
  ])("$name", async ({ input }) => {
    expect(await run(input)).toBe("#f");
  });
});

describe("box identity — exact and inexact are different boxes at equal numeric value", () => {
  it.each([
    { name: "(= 1 1.0) is #t — numeric equality crosses the exactness boundary", input: "(= 1 1.0)", expected: "#t" },
    {
      name: "(eqv? 1 1.0) is #f — eqv? is representation-typed, exact never eqv? inexact",
      input: "(eqv? 1 1.0)",
      expected: "#f",
    },
    {
      name: "(equal? 1 1.0) is #f — structural equality honors the same exactness boundary",
      input: "(equal? 1 1.0)",
      expected: "#f",
    },
    {
      name: "(eqv? 0.0 -0.0) is #f — inexact zero keeps its sign under eqv? (Object.is)",
      input: "(eqv? 0.0 -0.0)",
      expected: "#f",
    },
    {
      name: "(eqv? +nan.0 +nan.0) is #t — NaN is eqv?-reflexive (Object.is, not ===)",
      input: "(eqv? +nan.0 +nan.0)",
      expected: "#t",
    },
    {
      // A forward-looking regression guard, not a currently-fragile behavior: bigint
      // has no -0 today, so this is an "accidental" green. Post-rework, AExact's `num`
      // field is a raw JS `number`, which CAN hold -0 unless the constructor normalizes
      // it away (plan §0.6: `x === 0 ? 0 : x`) — this row is the one that goes RED if
      // that normalization is ever forgotten during the port.
      name: 'exact -0 is unconstructible — (* -1 0) prints bare "0", never "-0"',
      input: "(* -1 0)",
      expected: "0",
    },
  ])("$name", async ({ input, expected }) => {
    expect(await run(input)).toBe(expected);
  });
});

describe("division — exact zero divisor errors; integer-only ops require denom = 1", () => {
  it.each([
    {
      name: "(/ 1 0) rejects — exact division by exact zero errors (R7RS), not ∞",
      input: "(/ 1 0)",
      matcher: /division by zero/i,
    },
    {
      // RED until the atom lands: today's message is "quotient: argument 0 type
      // mismatch" (z.bigint's CodecFidelityError swallowed into a generic mismatch by
      // numeric.ts's decodeArg) — it never mentions "integer". Target: quotient routes
      // through the same `toInteger` helper remainder/modulo/floor-quotient already use,
      // whose door message IS "quotient: not an integer".
      name: "(quotient (/ 3 2) 1) rejects — quotient doors on a non-integer (denom ≠ 1) operand",
      input: "(quotient (/ 3 2) 1)",
      matcher: /integer/i,
    },
  ])("$name", async ({ input, matcher }) => {
    await expect(run(input)).rejects.toThrow(matcher);
  });

  it("(/ 4 2) reduces to exact 2", async () => {
    expect(await run("(/ 4 2)")).toBe("2");
  });
});

describe("parsing — string->number / reader agree on exactness", () => {
  it.each([
    {
      // RED until the atom lands: parse_float's exponent arm (reader/parsing.ts:178,
      // `is_int(value) && Number.isSafeInteger(value) && /e\+?\d/i.test(...)`) currently
      // mints AExact whenever the float happens to round-trip to a safe integer —
      // printed bare "100", not "100.0".
      name: '(string->number "1e2") is inexact 100.0 — exponent notation never mints exact',
      input: '(string->number "1e2")',
      expected: "100.0",
    },
    { name: '(string->number "10/2") reduces to exact 5', input: '(string->number "10/2")', expected: "5" },
    {
      name: '(string->number "1/3") parses as the exact rational 1/3',
      input: '(string->number "1/3")',
      expected: "1/3",
    },
  ])("$name", async ({ input, expected }) => {
    expect(await run(input)).toBe(expected);
  });
});

describe("transcendental silence — inexact-by-spec-class, no warning, no error", () => {
  it("(exact? (sqrt 2)) is #f — sqrt of a non-perfect-square mints inexact silently", async () => {
    expect(await run("(exact? (sqrt 2))")).toBe("#f");
  });
});

describe("sort stability — mixed exact/inexact of equal value sorts without crashing", () => {
  it("(sort '(1 1.0 2 2.0) >) is a well-defined, stable descending order", async () => {
    // `sort` is receiver-FIRST in this codebase (env/srfi/srfi-95.ts: "(sort seq
    // less?)"), unlike the SRFI-95 paper convention — the sequence is arg 0, the
    // comparator arg 1. `>` as the `less?` comparator means "a precedes b iff a>b" —
    // a descending sort. `deriveSortCompare` (op-helpers.ts) feeds the verdict to
    // `Array.prototype.sort`, spec-guaranteed stable since ES2019, so the two
    // equal-valued exact/inexact pairs keep their ORIGINAL relative order: 2 before
    // 2.0, 1 before 1.0.
    expect(await run("(sort '(1 1.0 2 2.0) >)")).toBe("(2 2.0 1 1.0)");
  });
});
