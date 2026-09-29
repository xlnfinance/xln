// Bracket bindings for the let-family (eval/evaluator.ts) — models trained on Racket
// write `(let* ([a 1] [b 2]) …)` (each binding PAIR bracketed, R2b); models trained on
// Clojure write `(let [a 1 b 2] …)` (the whole bindings LIST bracketed, R2a). Arrival's
// reader never erases bracket kind — `[…]` mints an `AVector` with `evalElements ===
// true`; `(…)` mints an `APair`; `#(…)` mints an `AVector` with `evalElements ===
// false`. Detection is `evalElements === true` at a binding-position node — no
// reader/lexer change (R1).
//
// This is the R8 rewrite: the bracket-let DOOR (`5259a9398a`) fired for EVERY bracket
// binding regardless of shape. The consumption commit supersedes that for WELL-FORMED
// shapes (they now evaluate byte-identically to the parenthesized image, R3) — those
// cases flip from door-assertions to equivalence-assertions below. MALFORMED shapes
// (odd whole-list count, wrong per-element arity, non-symbol/destructuring name slot,
// whole-list on `do`) keep dooring — those keep door-assertions, with updated texts.
//
// Spec: the bracket-binding section header in src/eval/evaluator.ts (normalizeBindings).
// Requirements: the bracket-bindings requirements doc (R1–R8).
// Executable spec: src/reader/__tests__/polyglot/macro-special-brackets.spec.ts —
// this file is the narrative/behavioral companion, not a duplicate.
import { describe, expect, it } from "vitest";
import { exec } from "../../../eval/generator-exec.js";

const doorError = async (src: string): Promise<Error & { cause?: unknown }> => {
  try {
    await exec(src);
  } catch (e) {
    return e as Error & { cause?: unknown };
  }
  throw new Error(`expected a bracket-binding door for: ${src}`);
};

const doorMessage = async (src: string): Promise<string> => (await doorError(src)).message;

/** The door's semantic code lives on `.cause.code` — `exec`/`run()` wrap every thrown
 *  error into `new ArrivalError(error.message, frames, error)`, so `.message` on the
 *  caught ArrivalError is the door text verbatim (no "EvalError:"/code prefix) and the
 *  original EvalError (carrying `.code`) survives as `.cause`. */
const doorCode = async (src: string): Promise<unknown> => {
  const error = await doorError(src);
  return (error.cause as { code?: unknown } | undefined)?.code;
};

/** Evaluates both the bracket-binding SOURCE and its hand-written parenthesized
 *  IMAGE, asserting the results are equal — the R3 equivalence law, exercised
 *  directly rather than merely asserted in prose. */
const assertEquivalent = async (bracketSrc: string, parenSrc: string): Promise<unknown> => {
  const [bracketResult] = await exec(bracketSrc);
  const [parenResult] = await exec(parenSrc);
  const bracketValue = bracketResult?.valueOf();
  const parenValue = parenResult?.valueOf();
  expect(bracketValue).toEqual(parenValue);
  return bracketValue;
};

describe("bracket bindings — R2b per-element (Racket) consumption", () => {
  it.each([
    {
      name: "let*: per-element bracket bindings consume, equal to the paren image",
      bracketSrc: "(let* ([a 1] [b 2]) (+ a b))",
      parenSrc: "(let* ((a 1) (b 2)) (+ a b))",
      expected: 3,
    },
    {
      name: "let: per-element bracket binding consumes",
      bracketSrc: "(let ([a 1]) a)",
      parenSrc: "(let ((a 1)) a)",
      expected: 1,
    },
    {
      name: "letrec: per-element bracket binding consumes (mutual recursion)",
      bracketSrc: "(letrec ([f (lambda () 1)]) (f))",
      parenSrc: "(letrec ((f (lambda () 1))) (f))",
      expected: 1,
    },
    {
      name: "letrec*: per-element bracket binding consumes (same impl as letrec)",
      bracketSrc: "(letrec* ([a 1] [b (+ a 1)]) b)",
      parenSrc: "(letrec* ((a 1) (b (+ a 1))) b)",
      expected: 2,
    },
    {
      name: "do: per-element bracket bindings (with step) consume",
      bracketSrc: "(do ([i 0 (+ i 1)]) (= i 3) i)",
      parenSrc: "(do ((i 0 (+ i 1))) (= i 3) i)",
      expected: 3,
    },
    {
      name: "named let (Racket per-element): consumes instead of silently binding zero params",
      bracketSrc: "(let loop ([i 0]) i)",
      parenSrc: "(let loop ((i 0)) i)",
      expected: 0,
    },
  ])("$name", async ({ bracketSrc, parenSrc, expected }) => {
    const value = await assertEquivalent(bracketSrc, parenSrc);
    expect(value).toBe(expected);
  });

  it("consumes a nested application inside the bracketed binding verbatim", async () => {
    const value = await assertEquivalent(
      "(let* ([lat1-r (exact->inexact (/ (* 1 3.14159) 180))]) lat1-r)",
      "(let* ((lat1-r (exact->inexact (/ (* 1 3.14159) 180)))) lat1-r)",
    );
    expect(value).toBeCloseTo(3.14159 / 180);
  });
});

describe("bracket bindings — R2a whole-list (Clojure) consumption", () => {
  it.each([
    {
      name: "let: whole-list bracket bindings consume, equal to the paren image",
      bracketSrc: "(let [a 1 b 2] (+ a b))",
      parenSrc: "(let ((a 1) (b 2)) (+ a b))",
      expected: 3,
    },
    {
      name: "named let (Clojure whole-list): consumes",
      bracketSrc: "(let loop [i 0] i)",
      parenSrc: "(let loop ((i 0)) i)",
      expected: 0,
    },
    {
      name: "named let (Clojure whole-list): recurses correctly",
      bracketSrc: "(let loop [i 0] (if (= i 3) i (loop (+ i 1))))",
      parenSrc: "(let loop ((i 0)) (if (= i 3) i (loop (+ i 1))))",
      expected: 3,
    },
    {
      name: "let*: whole-list bracket bindings consume",
      bracketSrc: "(let* [a 1 b 2] (+ a b))",
      parenSrc: "(let* ((a 1) (b 2)) (+ a b))",
      expected: 3,
    },
    {
      name: "letrec: whole-list bracket bindings consume",
      bracketSrc: "(letrec [f 1] f)",
      parenSrc: "(letrec ((f 1)) f)",
      expected: 1,
    },
  ])("$name", async ({ bracketSrc, parenSrc, expected }) => {
    const value = await assertEquivalent(bracketSrc, parenSrc);
    expect(value).toBe(expected);
  });
});

describe("bracket bindings — R2c mixing (paren pairs and bracket vectors together)", () => {
  it("mixing is legal and each element is judged independently", async () => {
    const value = await assertEquivalent("(let ([a 1] (b 2)) (+ a b))", "(let ((a 1) (b 2)) (+ a b))");
    expect(value).toBe(3);
  });
});

describe("bracket bindings — R3 equivalence (direct pin, not merely per-case)", () => {
  it("the bracket-binding form is `equal?` to its paren image from WITHIN scheme itself", async () => {
    const [result] = await exec("(equal? (let ([a 1] [b 2]) (+ a b)) (let ((a 1) (b 2)) (+ a b)))");
    expect(result?.valueOf()).toBe(true);
  });

  it("shadowing behaves identically under bracket bindings", async () => {
    const value = await assertEquivalent("(let [a 1] (let [a 2] a))", "(let ((a 1)) (let ((a 2)) a))");
    expect(value).toBe(2);
  });

  it("a bracket binding closes over a lambda exactly like the paren form", async () => {
    const [bracketResult] = await exec("((let ([f (lambda (x) (* x 2))]) f) 21)");
    const [parenResult] = await exec("((let ((f (lambda (x) (* x 2)))) f) 21)");
    expect(bracketResult?.valueOf()).toBe(42);
    expect(bracketResult?.valueOf()).toBe(parenResult?.valueOf());
  });
});

// These pin the exact property that separates the REAL evaluator from a value-
// atomicity heuristic — the shape of the bug that hit arrival-manifold's STATIC
// statement-facts scanner (1bdafe5a8f, "the allFlat whole-list/pairs
// discriminator is now shape-based, not atomicity-based"). normalizeBindings
// discriminates the two surfaces STRUCTURALLY (the bindings slot being a vector
// vs a list), and groups a whole-list STRICTLY PAIRWISE BY POSITION: even
// positions are names, odd positions are values taken verbatim whatever their
// shape. A value being a COMPOUND expression (a call, a lambda) at an odd
// position must NOT change the grouping. Every whole-list test above binds only
// ATOMIC values (1, 2, 0); this block closes that gap so a future "optimization"
// that re-introduced an `every(isAtom)`/allFlat discriminator into
// normalizeBindings would fail HERE instead of silently mis-binding real
// mainstream `(let [x 1 y (+ x 1)] …)` programs at runtime.
describe("bracket bindings — R2a whole-list grouped by POSITION, never by value atomicity", () => {
  it.each([
    {
      name: "let*: a whole-list value computed from a PRIOR binding (compound at an odd position)",
      bracketSrc: "(let* [x 1 y (+ x 1)] y)",
      parenSrc: "(let* ((x 1) (y (+ x 1))) y)",
      expected: 2,
    },
    {
      name: "let: a LAMBDA value at an odd whole-list position is a value, not a grouping boundary",
      bracketSrc: "(let [f (lambda (n) (* n n)) x 5] (f x))",
      parenSrc: "(let ((f (lambda (n) (* n n))) (x 5)) (f x))",
      expected: 25,
    },
  ])("$name", async ({ bracketSrc, parenSrc, expected }) => {
    const value = await assertEquivalent(bracketSrc, parenSrc);
    expect(value).toBe(expected);
  });

  it.each([
    {
      name: "let: EVERY whole-list value compound, equal? to the literal result",
      src: "(equal? (let [a (+ 1 2) b (* 3 4)] (list a b)) (list 3 12))",
    },
    {
      name: "let*: interleaved atomic/compound values — the exact allFlat-unsound shape",
      src: "(equal? (let* [a 1 b (+ a 1) c 3 d (* c 2)] (list a b c d)) (list 1 2 3 6))",
    },
    {
      // If position-grouping ever drifted into let* semantics, `b` would read the
      // sibling a=1 (=> 1); a parallel let reads the outer a=10.
      name: "let: whole-list keeps PARALLEL semantics — a value sees the OUTER binding, not its sibling",
      src: "(equal? (let [a 10] (let [a 1 b a] (list a b))) (list 1 10))",
    },
  ])("$name", async ({ src }) => {
    const [result] = await exec(src);
    expect(result?.valueOf()).toBe(true);
  });
});

// A binding NAME may itself be a scope keyword (`let`, `let*`, `lambda`, …).
// The rewrite treats binding slots as DATA — an even-position (whole-list) or
// first-element (per-element) symbol is a plain name, never re-dispatched as a
// form head — so these mainstream-idiom-adjacent shapes bind and read back
// identically to their paren image. (Uncovered by the spec corpus and the cases
// above.) NB: this is about a binding's NAME/reference position; CALLING a local
// var named after a special form in HEAD position is a separate, surface-
// INDEPENDENT dispatch property — identical for paren and bracket forms — and is
// deliberately not asserted here.
describe("bracket bindings — a binding NAME may be a scope keyword (slots are data, not re-parsed)", () => {
  it.each([
    {
      name: "per-element binding named `let` binds and reads back",
      bracketSrc: "(let ([let 5]) let)",
      parenSrc: "(let ((let 5)) let)",
      expected: 5,
    },
    {
      name: "whole-list binding named `let`",
      bracketSrc: "(let [let 5] let)",
      parenSrc: "(let ((let 5)) let)",
      expected: 5,
    },
    {
      name: "whole-list with TWO keyword-named bindings, both read as plain names",
      bracketSrc: "(let [let 5 let* 6] (+ let let*))",
      parenSrc: "(let ((let 5) (let* 6)) (+ let let*))",
      expected: 11,
    },
    {
      name: "let*: a keyword-named binding is usable in a later compound value",
      bracketSrc: "(let* [let 5 x (+ let 1)] x)",
      parenSrc: "(let* ((let 5) (x (+ let 1))) x)",
      expected: 6,
    },
  ])("$name", async ({ bracketSrc, parenSrc, expected }) => {
    const value = await assertEquivalent(bracketSrc, parenSrc);
    expect(value).toBe(expected);
  });
});

describe("bracket bindings — R4 doors: whole-list malformations (E-LET-BRACKET-BINDINGS-LIST)", () => {
  it.each([
    {
      name: "odd element count in a whole-list vector doors",
      src: "(let [a 1 b] a)",
      patterns: [/odd number of elements/, /\[a 1 b\]/],
    },
    {
      name: "odd element count doors the same way for let*",
      src: "(let* [a 1 b 2 c] a)",
      patterns: [] as RegExp[],
    },
    {
      name: "do does not accept the whole-list form (R2a exclusion) — doors, points at per-element",
      src: "(do [i 0 (+ i 1)] (= i 3) i)",
      // R2a's whole-list rewrite is inherently pairwise (i.e. it groups two elements
      // at a time) — for the odd 3-element `[i 0 (+ i 1)]` shape, the door's
      // corrected-form echo pairs the first two and leaves the third dangling: this
      // is exactly what teaches the model to use the per-element form instead.
      patterns: [/^do bindings must be a parenthesized list of pairs/, /\(\(i 0\) \(\+ i 1\)\)/],
    },
  ])("$name", async ({ src, patterns }) => {
    if (patterns.length > 0) {
      const message = await doorMessage(src);
      for (const pattern of patterns) expect(message).toMatch(pattern);
    }
    expect(await doorCode(src)).toBe("E-LET-BRACKET-BINDINGS-LIST");
  });
});

describe("bracket bindings — R4 doors: per-element malformations (E-LET-BRACKET-BINDING)", () => {
  it.each([
    {
      name: "wrong per-element vector length (3 where 2 expected) doors",
      src: "(let ([a 1 2]) a)",
      patterns: [/has 3 elements/, /\[name value\]/],
    },
    {
      name: "wrong per-element vector length for do (4 where 2-3 expected) doors",
      src: "(do ([i 0 1 2]) (= i 3) i)",
      patterns: [/has 4 elements/, /2–3/],
    },
    {
      name: "a destructuring name slot (vector where a symbol is expected) doors with the pinned text",
      src: "(let ([[a b] 1]) a)",
      patterns: [/destructuring is not supported — bind the whole value to one name, then read parts with accessors/],
    },
    {
      name: "a destructuring name slot in whole-list form also doors with the pinned text",
      src: "(let [[a b] 1] a)",
      patterns: [/destructuring is not supported — bind the whole value to one name, then read parts with accessors/],
    },
    {
      name: "a non-symbol, non-vector name slot doors generically",
      src: "(let ([1 2]) 1)",
      patterns: [/binding name must be a symbol/],
    },
  ])("$name", async ({ src, patterns }) => {
    const message = await doorMessage(src);
    for (const pattern of patterns) expect(message).toMatch(pattern);
    expect(await doorCode(src)).toBe("E-LET-BRACKET-BINDING");
  });
});

describe("bracket bindings — R5 negatives (never consumed outside the six forms' bindings slots)", () => {
  it.each([
    {
      name: "a bracketed binding INIT value is legal data, not a binding",
      src: "(let ((a [1 2 3])) (vector-length a))",
    },
    {
      name: "a #(...) constant binding init is legal data too",
      src: "(let ((a #(1 2 3))) (vector-length a))",
    },
  ])("$name", async ({ src }) => {
    const [result] = await exec(src);
    expect(result?.valueOf()).toBe(3);
  });

  it("a bracket literal in the BODY (not a binding position) is legal", async () => {
    const [result] = await exec("(let ((a 1)) [a])");
    expect((result as unknown as { length: number }).length).toBe(1);
  });

  it("a quoted let form is data, never evaluated or consumed — the binding slot is a plain vector datum", async () => {
    const [result] = await exec("'(let* ([a 1] [b 2]) (+ a b))");
    expect(result).toBeDefined();
  });

  it("a quoted let form's binding slot vector holds the raw symbol, unconsumed", async () => {
    const [result] = await exec("(vector-ref (car (cdr (quote (let [a 1] a)))) 0)");
    expect((result as unknown as { __name__?: string }).__name__ ?? String(result)).toContain("a");
  });

  it("a #(...) constant sitting in binding position is NEVER consumed — unchanged generic invariant fires", async () => {
    const message = await doorMessage("(let #(a 1) a)");
    expect(message).not.toMatch(/E-LET-BRACKET/);
  });
});

describe("bracket bindings — passthrough (unrelated malformed bindings, unchanged)", () => {
  it.each([
    {
      name: "a bare symbol binding still hits the generic invariant, not a bracket door",
      src: "(let ((a 1) b) a)",
      pattern: /let: invalid binding/,
    },
    {
      // `(define x 1)` misused as `do`'s bindings clause (Racket-`begin` habit) is an
      // APair whose first element is the bare symbol `define` — not an AVector, so it
      // falls straight through to the unchanged `is_pair(binding)` invariant.
      name: "do-as-begin misuse still hits the generic invariant, not a bracket door",
      src: "(do (define x 1) (test-ok) x)",
      pattern: /do: invalid binding/,
    },
  ])("$name", async ({ src, pattern }) => {
    const message = await doorMessage(src);
    expect(message).toMatch(pattern);
    expect(message).not.toMatch(/E-LET-BRACKET/);
  });

  it("nested lets: each form's own well-formed bracket bindings consume independently", async () => {
    // Both the outer AND inner bindings are now well-formed (per-element, length 2) —
    // this used to door on the OUTER form before consumption landed; now it evaluates.
    const value = await assertEquivalent(
      "(let ([a 1]) (let* ([b 2]) (+ a b)))",
      "(let ((a 1)) (let* ((b 2)) (+ a b)))",
    );
    expect(value).toBe(3);
  });
});
