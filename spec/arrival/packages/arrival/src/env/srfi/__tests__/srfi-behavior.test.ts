// SRFI libraries added as base packs (2026-06-11): SRFI-1 (lists), SRFI-43
// (vectors, pure ops only — arrival is immutable), SRFI-189 (Maybe/Either),
// SRFI-128 (comparators, no hash). All are pure procedures (no macros → no
// matcher dependency). These assert the surface behaves; the drafting horde
// exec-verified each proc, this is the committed floor.
import { describe, expect, it } from "vitest";
import { execState } from "../../../eval/generator-exec.js";

// COMPLEX tier (execState): stringifies the BOXED result (Scheme print format,
// e.g. list "(2 4 6)") — a boxed-state read, not the SIMPLE tier's plain-JS exit.
async function run(src: string): Promise<string> {
  const { values: r } = await execState(src, {});
  const x = r[r.length - 1] as { toString(): string } | undefined;
  return String(x?.toString?.() ?? x);
}

describe("SRFI-1 — list library", () => {
  it.each([
    { name: "take-while", input: "(take-while even? '(2 4 6 1 8))", expected: "(2 4 6)" },
    { name: "drop-while", input: "(drop-while even? '(2 4 6 1 8))", expected: "(1 8)" },
    { name: "partition", input: "(partition even? '(1 2 3 4 5 6))", expected: "((2 4 6) (1 3 5))" },
    { name: "span", input: "(span even? '(2 4 1 3))", expected: "((2 4) (1 3))" },
    { name: "break", input: "(break odd? '(2 4 1 3))", expected: "((2 4) (1 3))" },
    { name: "last", input: "(last '(1 2 3))", expected: "3" },
    { name: "find-tail-hit", input: "(find-tail even? '(1 3 4 5))", expected: "(4 5)" },
    { name: "find-tail-miss", input: "(find-tail even? '(1 3 5))", expected: "#f" },
    { name: "fold-right", input: "(fold-right cons '() '(1 2 3))", expected: "(1 2 3)" },
    { name: "reduce-right", input: "(reduce-right + 0 '(1 2 3 4))", expected: "10" },
    { name: "concatenate", input: "(concatenate '((1 2) (3) (4 5)))", expected: "(1 2 3 4 5)" },
    { name: "list-tabulate", input: "(list-tabulate 4 (lambda (i) (* i i)))", expected: "(0 1 4 9)" },
    { name: "delete", input: "(delete 2 '(1 2 3 2 4))", expected: "(1 3 4)" },
    { name: "length+", input: "(length+ '(1 2 3 4))", expected: "4" },
  ])("$name", async ({ input, expected }) => {
    expect(await run(input)).toBe(expected);
  });
});

describe("SRFI-43 — vector library (pure)", () => {
  // Empty-provenance predicate verdicts box uniformly (`mintVerdict`), so these
  // SRFI predicates print "#t"/"#f" — a raw JS boolean would stringify "true"/"false".
  it.each([
    { name: "vector-fold", input: "(vector-fold + 0 #(1 2 3 4))", expected: "10" },
    { name: "vector-fold-right", input: "(vector-fold-right + 0 #(1 2 3 4))", expected: "10" },
    { name: "vector-count", input: "(vector-count even? #(1 2 3 4))", expected: "2" },
    { name: "vector-index", input: "(vector-index odd? #(2 4 5 6))", expected: "2" },
    { name: "vector-empty?", input: "(vector-empty? #())", expected: "#t" },
    { name: "vector-any", input: "(vector-any even? #(1 3 4))", expected: "#t" },
    { name: "vector-every-true", input: "(vector-every even? #(2 4 6))", expected: "#t" },
    // failure path returns the literal #f (success returns the boxed ABool pred result)
    { name: "vector-every-false", input: "(vector-every even? #(2 4 5))", expected: "#f" },
  ])("$name", async ({ input, expected }) => {
    expect(await run(input)).toBe(expected);
  });
});

describe("SRFI-189 — Maybe & Either", () => {
  it.each([
    {
      name: "maybe-bind-short-circuits-just",
      input: "(maybe-bind (just 5) (lambda (x) (just (* x x))))",
      expected: "(just 25)",
    },
    {
      name: "maybe-bind-short-circuits-nothing",
      input: "(maybe-bind (nothing) (lambda (x) (just x)))",
      expected: "(nothing)",
    },
    { name: "maybe-ref-default-just", input: "(maybe-ref/default (just 7) 0)", expected: "7" },
    { name: "maybe-ref-default-nothing", input: "(maybe-ref/default (nothing) 0)", expected: "0" },
    { name: "either-map-right", input: "(either-map (lambda (x) (+ x 1)) (right 4))", expected: "(right 5)" },
    {
      name: "either-bind-left-short-circuits",
      input: "(either-bind (left 'err) (lambda (x) (right x)))",
      expected: "(left err)",
    },
    // These SRFI preludes bottom out in the equality pack's predicates, which box now
    // (the Face split: eq?/equal?/not return the schemeTrue/schemeFalse flyweights).
    { name: "just?", input: "(just? (just 1))", expected: "#t" },
    { name: "maybe?", input: "(maybe? (nothing))", expected: "#t" },
    { name: "either?", input: "(either? (left 1))", expected: "#t" },
  ])("$name", async ({ input, expected }) => {
    expect(await run(input)).toBe(expected);
  });
});

describe("SRFI-8 receive + SRFI-2 and-let* (expression macros)", () => {
  // Single-sourced from env/srfi/srfi-8.ts + srfi-2.ts as `define-macro` forms
  // (unified off the old `define-syntax`/syntax-rules twins so one definition
  // serves both the full env and the sandbox). let-values / let*-values are
  // sibling define-macro forms. Definition macros (define-record-type /
  // define-values) stay BLOCKED on a separate gap: macro-introduced
  // (begin (define …)) doesn't splice into the enclosing scope.
  it("receive is a multi-return purity door", async () => {
    await expect(run("(receive 1 2)")).rejects.toThrow(
      /multiple-value returns are omitted|continuation arity|not available/,
    );
  });

  it.each([
    { name: "and-let*-binds-and-sums", input: "(and-let* ((x 5) (y (* x 2))) (+ x y))", expected: "15" },
    { name: "and-let*-short-circuits-on-#f", input: "(and-let* ((x #f)) x)", expected: "#f" },
    // guard clause (claw shape discriminated in the macro body)
    { name: "and-let*-guard-clause-true", input: "(and-let* ((x 3) ((> x 0))) (* x 10))", expected: "30" },
    { name: "and-let*-guard-clause-false", input: "(and-let* ((x 3) ((< x 0))) (* x 10))", expected: "#f" },
  ])("$name", async ({ input, expected }) => {
    expect(await run(input)).toBe(expected);
  });
});

describe("SRFI-128 — comparators (no hash)", () => {
  it.each([
    { name: "<?-ordering", input: "(<? (default-comparator) 1 2)", expected: "#t" },
    { name: ">?-chaining", input: "(>? (default-comparator) 3 2 1)", expected: "#t" },
    { name: "<=?-chaining", input: "(<=? (default-comparator) 1 1 2)", expected: "#t" },
    { name: "=?-strings", input: '(=? (default-comparator) "a" "a")', expected: "#t" },
    { name: "cross-type-total-order-number-before-string", input: '(<? (default-comparator) 1 "a")', expected: "#t" },
    { name: "comparator-hashable?-always-false", input: "(comparator-hashable? (default-comparator))", expected: "#f" },
  ])("$name", async ({ input, expected }) => {
    expect(await run(input)).toBe(expected);
  });
});
