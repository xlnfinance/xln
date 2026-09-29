// R9 — bracket CLAUSE positions (addendum to the bracket-bindings requirements doc,
// committed `2cf8e47eac`). The CLAUSE positions of `cond`, `case`, and `do`'s test-result
// clause additionally accept an evalElements vector, elementwise ≡ the
// parenthesized clause — `(cond [(> x 1) "a"] [else "b"])`,
// `(case k [(1 2) "low"] [else "hi"])`, `(do (…) [(= i n) acc] …)`.
//
// `cond`/`case`/`do` are evaluator SPECIAL FORMS (src/eval/evaluator.ts's
// evalCond/evalCase/evalDo), not syntax-rules prelude macros — consumption
// lands right there via `normalizeClause`, the CLAUSE-position sibling of the
// R2/R3 let-family `normalizeBindings`. Same normalize-once-before-the-walk
// shape, so R9's equivalence to the paren image is structural.
//
// Purely a Racket surface (Clojure's `cond` is flat, no clause grouping) — no
// dialect conflict, no door needed for the non-intersection claim itself.
//
// Executable spec: `src/reader/__tests__/polyglot/macro-special-brackets.spec.ts` —
// this file is the narrative/behavioral companion, not a duplicate.
import { describe, expect, it } from "vitest";
import { exec } from "../../../eval/generator-exec.js";

const doorError = async (src: string): Promise<Error & { cause?: unknown }> => {
  try {
    await exec(src);
  } catch (e) {
    return e as Error & { cause?: unknown };
  }
  throw new Error(`expected a bracket-clause door for: ${src}`);
};

const doorMessage = async (src: string): Promise<string> => (await doorError(src)).message;

/** The door's semantic code lives on `.cause.code` — see the identical helper
 *  in `let-bracket-binding-door.test.ts` for the `exec`/`ArrivalError` wrapping
 *  this relies on. */
const doorCode = async (src: string): Promise<unknown> => {
  const error = await doorError(src);
  return (error.cause as { code?: unknown } | undefined)?.code;
};

/** Evaluates both the bracket-clause SOURCE and its hand-written parenthesized
 *  IMAGE, asserting the results are equal — R9's equivalence law, exercised
 *  directly rather than merely asserted in prose. */
const assertEquivalent = async (bracketSrc: string, parenSrc: string): Promise<unknown> => {
  const [bracketResult] = await exec(bracketSrc);
  const [parenResult] = await exec(parenSrc);
  const bracketValue = bracketResult?.valueOf();
  const parenValue = parenResult?.valueOf();
  expect(bracketValue).toEqual(parenValue);
  return bracketValue;
};

describe("bracket clauses — cond (R9)", () => {
  it.each([
    {
      name: "bracket test clause consumes, equal to the paren image",
      bracketSrc: '(cond [(> 2 1) "a"] [else "b"])',
      parenSrc: '(cond ((> 2 1) "a") (else "b"))',
      expected: "a",
    },
    {
      name: "bracket else clause consumes",
      bracketSrc: '(cond [#f "a"] [else "b"])',
      parenSrc: '(cond (#f "a") (else "b"))',
      expected: "b",
    },
    {
      name: "bracket => clause consumes",
      bracketSrc: "(cond [(+ 1 2) => (lambda (x) (* x 10))])",
      parenSrc: "(cond ((+ 1 2) => (lambda (x) (* x 10))))",
      expected: 30,
    },
    {
      name: "falls through to a later bracket clause when earlier tests are false",
      bracketSrc: "(cond [#f 1] [#f 2] [#t 3])",
      parenSrc: "(cond (#f 1) (#f 2) (#t 3))",
      expected: 3,
    },
    {
      name: "mixing bracket and paren clauses in one cond",
      bracketSrc: "(cond [#f 1] (#t 2))",
      parenSrc: "(cond (#f 1) (#t 2))",
      expected: 2,
    },
    {
      name: "nested: a bracket clause's body containing bracket let bindings (R9 + R2 compose)",
      bracketSrc: "(cond [#t (let [a 1] a)])",
      parenSrc: "(cond (#t (let ((a 1)) a)))",
      expected: 1,
    },
  ])("$name", async ({ bracketSrc, parenSrc, expected }) => {
    const value = await assertEquivalent(bracketSrc, parenSrc);
    expect(value).toBe(expected);
  });

  it("no clause matches — returns void, same as the paren form", async () => {
    const [bracketResult] = await exec("(cond [#f 1])");
    const [parenResult] = await exec("(cond (#f 1))");
    expect(bracketResult).toEqual(parenResult);
  });
});

describe("bracket clauses — case (R9)", () => {
  it.each([
    {
      name: "bracket clause with a parenthesized datum-list head consumes, equal to the paren image",
      bracketSrc: '(case 1 [(1 2) "low"] [else "hi"])',
      parenSrc: '(case 1 ((1 2) "low") (else "hi"))',
      expected: "low",
    },
    {
      name: "bracket else clause consumes",
      bracketSrc: '(case 99 [(1 2) "low"] [else "hi"])',
      parenSrc: '(case 99 ((1 2) "low") (else "hi"))',
      expected: "hi",
    },
    {
      name: "bracket => clause consumes",
      bracketSrc: "(case 2 [(1 2) => (lambda (x) (* x 100))] [else 0])",
      parenSrc: "(case 2 ((1 2) => (lambda (x) (* x 100))) (else 0))",
      expected: 200,
    },
    {
      name: "the datum-list head stays a LIST — R9's own invariant — and matches correctly",
      bracketSrc: '(case (quote b) [(a b c) "letter"] [else "other"])',
      parenSrc: '(case (quote b) ((a b c) "letter") (else "other"))',
      expected: "letter",
    },
  ])("$name", async ({ bracketSrc, parenSrc, expected }) => {
    const value = await assertEquivalent(bracketSrc, parenSrc);
    expect(value).toBe(expected);
  });

  it("no datum matches, no else — returns void, same as the paren form", async () => {
    const [bracketResult] = await exec('(case 99 [(1 2) "low"])');
    const [parenResult] = await exec('(case 99 ((1 2) "low"))');
    expect(bracketResult).toEqual(parenResult);
  });
});

describe("bracket clauses — do's test clause (R9)", () => {
  it.each([
    {
      name: "bracket test clause consumes, equal to the paren image",
      bracketSrc: "(do ((i 0 (+ i 1))) [(= i 3) i])",
      parenSrc: "(do ((i 0 (+ i 1))) ((= i 3) i))",
      expected: 3,
    },
    {
      name: "bracket test clause with multiple result expressions consumes",
      bracketSrc: "(do ((i 0 (+ i 1)) (acc 0 (+ acc i))) [(= i 3) i acc])",
      parenSrc: "(do ((i 0 (+ i 1)) (acc 0 (+ acc i))) ((= i 3) i acc))",
      expected: 3,
    },
    {
      name: "do's binding brackets (R2) and its test-clause bracket (R9) compose",
      bracketSrc: "(do ([i 0 (+ i 1)]) [(= i 3) i])",
      parenSrc: "(do ((i 0 (+ i 1))) ((= i 3) i))",
      expected: 3,
    },
  ])("$name", async ({ bracketSrc, parenSrc, expected }) => {
    const value = await assertEquivalent(bracketSrc, parenSrc);
    expect(value).toBe(expected);
  });
});

describe("bracket clauses — R9 doors: E-COND-BRACKET-CLAUSE (empty clause)", () => {
  it.each([
    {
      name: "cond: empty bracket clause doors",
      src: "(cond [])",
      pattern: /^cond clause \[\] is empty/,
    },
    {
      name: "case: empty bracket clause doors",
      src: "(case 1 [])",
      pattern: /^case clause \[\] is empty/,
    },
    {
      name: "do: empty bracket test clause doors",
      src: "(do ((i 0)) [])",
      pattern: /^do clause \[\] is empty/,
    },
  ])("$name", async ({ src, pattern }) => {
    const message = await doorMessage(src);
    expect(message).toMatch(pattern);
    expect(await doorCode(src)).toBe("E-COND-BRACKET-CLAUSE");
  });
});

describe("bracket clauses — R9 doors: E-CASE-BRACKET-DATUM-LIST (vector datum head)", () => {
  it("case: a bracket-vector datum-list head doors with its own text", async () => {
    const message = await doorMessage('(case 1 [[1 2] "low"])');
    expect(message).toMatch(/datum list \[1 2\] is a vector/);
    expect(message).toMatch(/\(1 2\)/);
    expect(await doorCode('(case 1 [[1 2] "low"])')).toBe("E-CASE-BRACKET-DATUM-LIST");
  });

  it("a #(...) constant-vector datum head (evalElements=false) is NOT R9's door — generic invariant fires, unchanged", async () => {
    const message = await doorMessage('(case 1 (#(1 2) "low"))');
    expect(message).toMatch(/case: expected list of datums/);
    expect(message).not.toMatch(/E-CASE-BRACKET-DATUM-LIST/);
  });
});

describe("bracket clauses — R5 negatives (still hold: `[…]` as a VALUE stays a vector)", () => {
  it.each([
    {
      name: "a bracket vector used as a cond TEST EXPRESSION (not a clause wrapper) stays a vector value",
      src: "(cond ([1 2 3] => vector-length))",
    },
    {
      name: "a bracket vector in a clause's BODY position is legal data, not consumed as a clause",
      src: "(cond [#t (vector-length [1 2 3])])",
    },
  ])("$name", async ({ src }) => {
    const [result] = await exec(src);
    expect(result?.valueOf()).toBe(3);
  });

  it("a quoted cond form's bracket clause is inert data — a plain vector datum, unconsumed", async () => {
    const [result] = await exec("(quote (cond [#t 1]))");
    expect(result).toBeDefined();
  });

  it("a #(...) constant clause sitting in cond's clause position is NEVER consumed — unchanged generic invariant fires", async () => {
    const message = await doorMessage("(cond #(#t 1))");
    expect(message).not.toMatch(/E-COND-BRACKET/);
  });
});

describe("bracket clauses — passthrough (unrelated malformed clauses, unchanged)", () => {
  it.each([
    {
      name: "a bare symbol clause still hits the generic invariant, not a bracket door",
      src: "(cond (#f 1) else)",
      pattern: /cond: invalid clause/,
    },
    {
      name: "case with a bare (non-pair, non-else) clause still hits the generic invariant",
      src: "(case 1 else)",
      pattern: /case: invalid clause/,
    },
  ])("$name", async ({ src, pattern }) => {
    const message = await doorMessage(src);
    expect(message).toMatch(pattern);
    expect(message).not.toMatch(/E-COND-BRACKET/);
  });
});
