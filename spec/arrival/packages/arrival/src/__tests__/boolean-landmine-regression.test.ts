// Regression guards for the defused boolean landmines (commit 9dbf6f719) — and
// the complement async-fix that the first version of these tests surfaced.
//
// Each test passes a predicate that returns a *boxed* SchemeBool (`#t`/`#f`
// literals are schemeTrue/schemeFalse) into a HOF whose result-check was a raw
// truthiness test. A boxed SchemeBool(false) is a TRUTHY JS object, so a raw
// `x && …` / `!x` would keep/negate it wrong — these tests FAIL if a defuse is
// reverted to `=== false`/`!`. They are also the acceptance criteria for the
// later step (boxing all predicate/comparison returns to SchemeBool): when that
// lands, EVERY predicate produces these SchemeBools, and these stay green.
import { describe, expect, it } from "vitest";
import { execState } from "../eval/generator-exec.js";

// COMPLEX tier (execState, not exec): this file reads the BOXED result's own
// `.toString()` (Scheme print format, e.g. list "(2 3)", boolean "#t"/"#f") to
// verify box discipline through the HOF pipeline — a boxed-state concern
// (RULINGS.md R1), not the SIMPLE tier's plain-JS exit.
async function run(src: string): Promise<string> {
  const { values: r } = await execState(src, {});
  const x = r[r.length - 1] as { toString(): string } | undefined;
  return String(x?.toString?.() ?? x);
}

const SB = "(lambda (x) (if (> x 1) #t #f))"; // #t for >1, #f otherwise
const EVEN_SB = "(lambda (x) (if (even? x) #t #f))";

describe("boolean landmine — find/filter (stdlib, THE documented landmine)", () => {
  it.each([
    {
      name: "filter EXCLUDES elements whose SchemeBool predicate is #f",
      src: `(filter ${SB} '(1 2 3))`,
      expected: "(2 3)", // raw `&&` would keep 1
    },
    {
      name: "find returns the first match under a SchemeBool predicate",
      src: `(find ${EVEN_SB} '(1 2 3 4))`,
      expected: "2",
    },
    {
      // Was '()' — an arrival deviation, fixed 2026-07-13 (V: "definitely fix").
      name: "find returns #f when the SchemeBool predicate is #f for all (SRFI-1 not-found = #f)",
      src: "(find (lambda (x) #f) '(1 2 3))",
      expected: "#f",
    },
  ])("$name", async ({ src, expected }) => {
    expect(await run(src)).toBe(expected);
  });
});

describe("nil truthiness — R7RS: only #f is false; '() is a TRUTHY verdict everywhere", () => {
  // THE split this suite existed to prevent, finally pinned: filter/find/take-while
  // once treated a '()-returning predicate as false while some/every/if treated it
  // truthy — same predicate, opposite verdicts (the private `instanceof ANil` forks,
  // deleted 2026-07-13). These rows keep the HOF family in agreement forever.
  const NIL_PRED = "(lambda (x) '())"; // returns '() for every element — truthy per R7RS
  it.each([
    {
      name: "filter keeps every element under a '()-returning predicate",
      src: `(filter ${NIL_PRED} '(1 2 3))`,
      expected: "(1 2 3)",
    },
    {
      name: "find matches the FIRST element under a '()-returning predicate",
      src: `(find ${NIL_PRED} '(1 2 3))`,
      expected: "1",
    },
    {
      name: "some agrees (was already truthy — the reference behavior)",
      src: `(some ${NIL_PRED} '(1 2 3))`,
      expected: "#t",
    },
    {
      name: "take-while takes everything under a '()-returning predicate",
      src: `(take-while ${NIL_PRED} '(1 2 3))`,
      expected: "(1 2 3)",
    },
    {
      name: "drop-while drops everything under a '()-returning predicate",
      src: `(drop-while ${NIL_PRED} '(1 2 3))`,
      expected: "()",
    },
  ])("$name", async ({ src, expected }) => {
    expect(await run(src)).toBe(expected);
  });
});

describe("boolean landmine — complement (bridge): async + boxed-bool", () => {
  it.each([
    {
      // exercises BOTH: the scheme-lambda Promise (maybeThen) AND the boxed-bool
      // negation (is_false, not `!`). Plain `!fn(...)` returned (), this returns (1 3).
      name: "complement of a SchemeBool scheme-lambda predicate, through filter",
      src: `(filter (complement ${EVEN_SB}) '(1 2 3 4))`,
      expected: "(1 3)",
    },
    {
      name: "complement still works for a native predicate",
      src: "(filter (complement even?) '(1 2 3 4))",
      expected: "(1 3)",
    },
    {
      name: "complement applied directly to a SchemeBool predicate is truthy when the inner is #f",
      src: `(if ((complement ${EVEN_SB}) 1) 'odd 'even)`,
      expected: "odd",
    },
  ])("$name", async ({ src, expected }) => {
    expect(await run(src)).toBe(expected);
  });
});

describe("boolean landmine — not / is_false honor SchemeBool", () => {
  // `not`/`if` must honor boxed SchemeBool via is_false.
  it.each([
    { name: "not of a SchemeBool #f result: (even? 1)→#f, not #f → #t", src: `(not (${EVEN_SB} 1))`, expected: "#t" },
    { name: "not of a SchemeBool #t result", src: `(not (${EVEN_SB} 2))`, expected: "#f" },
    { name: "if/cond treat a SchemeBool(false) as falsy", src: `(if (${EVEN_SB} 1) 'yes 'no)`, expected: "no" },
  ])("$name", async ({ src, expected }) => {
    expect(await run(src)).toBe(expected);
  });
});

describe("boolean landmine — member/assoc (bridge): guard the cmp defuse", () => {
  // Default cmp is equal? (raw bool today, SchemeBool post-flip). These pin the
  // baseline so a reverted defuse surfaces once equal? boxes.
  it("member finds by equal?", async () => {
    expect(await run("(member 2 '(1 2 3))")).toBe("(2 3)");
  });
  it("assoc finds the pair by key", async () => {
    expect(await run("(assoc 'b '((a . 1) (b . 2)))")).toBe("(b . 2)");
  });
});
