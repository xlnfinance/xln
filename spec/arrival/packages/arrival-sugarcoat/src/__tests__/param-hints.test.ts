/**
 * Parameter inlay hints over Scheme: a call to a `(define (f …)…)` gets a
 * hint before each positional arg naming its formal. Pins the resolver — the define
 * shapes it reads, the binding sites it skips, and the edges (builtins, arity,
 * kwargs, rest, parse error).
 */
import { describe, expect, it } from "vitest";
import { paramHints, paramHintsSugarcoat } from "../param-hints.js";
import { sugarcoatToScheme } from "../sugarcoat-read.js";
import { schemeToSugarcoat } from "../sugarcoat-render.js";

/** The char immediately at a hint's pos — should be the first char of its arg. */
const charAt = (src: string, pos: number): string => src[pos];

describe("paramHints", () => {
  it("hints each positional arg of a call to a function-define, in order, at the arg's start", () => {
    const src = `(define (evolve pool budget rng iter) (list pool budget rng iter))
(evolve (list seed) (- BUDGET 1) SEED-RNG 0)`;
    const hints = paramHints(src);
    expect(hints.map((h) => h.name)).toEqual(["pool", "budget", "rng", "iter"]);
    // Each pos lands on the start of the arg it labels.
    expect(src.startsWith("(list seed)", hints[0].pos)).toBe(true);
    expect(src.startsWith("(- BUDGET 1)", hints[1].pos)).toBe(true);
    expect(src.startsWith("SEED-RNG", hints[2].pos)).toBe(true);
    expect(charAt(src, hints[3].pos)).toBe("0");
  });

  it("reads the (define f (lambda …)) shape too", () => {
    const src = `(define greet (lambda (name greeting) greeting))\n(greet "ada" "hi")`;
    expect(paramHints(src).map((h) => h.name)).toEqual(["name", "greeting"]);
  });

  it("does NOT hint the define's own formals (binding site, not a call)", () => {
    expect(paramHints(`(define (f a b) (+ a b))`)).toEqual([]);
  });

  it("skips builtins — no define to read formals from", () => {
    expect(paramHints(`(define (f a) a)\n(list 1 2 3)`)).toEqual([]); // f uncalled; list not hinted
  });

  it("stops at arity — a 3rd arg to a 2-param fn gets no hint", () => {
    expect(paramHints(`(define (f a b) a)\n(f 1 2 3)`).map((h) => h.name)).toEqual(["a", "b"]);
  });

  it("skips a kwarg call (self-labeling)", () => {
    expect(paramHints(`(define (f a b) a)\n(f :a 1 :b 2)`)).toEqual([]);
  });

  it("hints nested calls independently", () => {
    const names = paramHints(`(define (f x) x)\n(define (g y) y)\n(f (g 1))`)
      .map((h) => h.name)
      .sort();
    expect(names).toEqual(["x", "y"]);
  });

  it("drops a dotted-rest tail from positional hints", () => {
    expect(paramHints(`(define (f a . rest) a)\n(f 1 2 3)`).map((h) => h.name)).toEqual(["a"]);
  });

  it("returns [] on a parse error (mid-edit)", () => {
    expect(paramHints(`(define (f a b`)).toEqual([]);
  });
});

describe("paramHints — built-in control forms", () => {
  it("labels `if` as cond/then/else, each at its branch start", () => {
    const src = `(if (> x 3) (a) (b))`;
    const hints = paramHints(src);
    expect(hints.map((h) => h.name)).toEqual(["cond", "then", "else"]);
    expect(src.startsWith("(> x 3)", hints[0].pos)).toBe(true);
    expect(src.startsWith("(a)", hints[1].pos)).toBe(true);
    expect(src.startsWith("(b)", hints[2].pos)).toBe(true);
  });

  it("`if` without an else → cond/then only", () => {
    expect(paramHints(`(if c (a))`).map((h) => h.name)).toEqual(["cond", "then"]);
  });

  it("labels `let*` as a `let:` per binding + `return:` on the body value", () => {
    const src = `(let* ((a 1) (b 2)) (+ a b))`;
    const hints = paramHints(src);
    expect(hints.map((h) => h.name)).toEqual(["let", "let", "return"]);
    expect(src.startsWith("(a 1)", hints[0].pos)).toBe(true);
    expect(src.startsWith("(b 2)", hints[1].pos)).toBe(true);
    expect(src.startsWith("(+ a b)", hints[2].pos)).toBe(true);
  });

  it("plain `let` too — single binding + return", () => {
    expect(paramHints(`(let ((a 1)) a)`).map((h) => h.name)).toEqual(["let", "return"]);
  });

  it("a NAMED let steps past the loop name to find the bindings", () => {
    const src = `(let loop ((a 1) (b 2)) (loop a b))`;
    const hints = paramHints(src);
    expect(hints.map((h) => h.name)).toEqual(["let", "let", "return"]);
    expect(src.startsWith("(a 1)", hints[0].pos)).toBe(true);
    expect(src.startsWith("(loop a b)", hints[2].pos)).toBe(true);
  });

  it("`return:` lands on the LAST body form when there are several", () => {
    const src = `(let ((a 1)) (side a) (final a))`;
    const hints = paramHints(src);
    expect(hints.map((h) => h.name)).toEqual(["let", "return"]);
    expect(src.startsWith("(final a)", hints[1].pos)).toBe(true);
  });

  it("nests: an `if` inside a `let` body gets both layers of labels", () => {
    const names = paramHints(`(let ((a 1)) (if a (b) (c)))`)
      .map((h) => h.name)
      .sort();
    expect(names).toEqual(["cond", "else", "let", "return", "then"]);
  });

  it("control-form labels need no defines (fire on their own)", () => {
    expect(paramHints(`(if c a b)`).map((h) => h.name)).toEqual(["cond", "then", "else"]);
  });
});

describe("paramHintsSugarcoat — the sugarcoat lens", () => {
  it("hints over RENDERED sugarcoat, at sugarcoat-text offsets pointing to each arg", () => {
    const scheme = `(define (evolve pool budget rng iter) (list pool budget rng iter))

(evolve (list seed) (- BUDGET (length paretoset)) SEED-RNG 0)`;
    const sugarcoat = schemeToSugarcoat(scheme); // what the sugarcoat editor buffer shows
    const hints = paramHintsSugarcoat(sugarcoat);
    expect(hints.map((h) => h.name)).toEqual(["pool", "budget", "rng", "iter"]);
    // Each pos is in-bounds, ascending, and lands on a non-whitespace char (an arg start).
    let prev = -1;
    for (const h of hints) {
      expect(h.pos).toBeGreaterThan(prev);
      expect(/\S/.test(sugarcoat[h.pos])).toBe(true);
      prev = h.pos;
    }
  });

  it("hand-written sugarcoat (indented body + curly arg) — names resolve", () => {
    const sugarcoat = `define (evolve pool budget rng iter)
  (list pool budget rng iter)

evolve (list seed) {BUDGET - (length paretoset)} SEED-RNG 0`;
    const hints = paramHintsSugarcoat(sugarcoat);
    expect(hints.map((h) => h.name)).toEqual(["pool", "budget", "rng", "iter"]);
    expect(sugarcoat.startsWith("(list seed)", hints[0].pos)).toBe(true);
    expect(sugarcoat.startsWith("{BUDGET", hints[1].pos)).toBe(true);
    expect(sugarcoat.startsWith("SEED-RNG", hints[2].pos)).toBe(true);
    expect(sugarcoat[hints[3].pos]).toBe("0");
  });

  it("returns [] on malformed sugarcoat", () => {
    expect(paramHintsSugarcoat(`define (f a b`)).toEqual([]);
  });

  it("is resilient: one unparseable form doesn't zero out the rest", () => {
    // Middle form has an unbalanced `{` the reader can't parse; the define + call
    // around it (different top-level forms) must still resolve cross-form.
    const sugarcoat = `define (f a b)\n  (+ a b)\n\n{ this is broken\n\n(f 1 2)`;
    expect(paramHintsSugarcoat(sugarcoat).map((h) => h.name)).toEqual(["a", "b"]);
  });

  it("resolves through modulo/quotient/remainder infix (the gepa LCG case)", () => {
    // `(modulo (* state 16807) n)` renders to `{{state * 16807} modulo n}`; read
    // must recognise `modulo` as infix or it throws "unbalanced {" → 0 hints.
    const scheme = `(define (rng-next state) (modulo (* state 16807) 2147483647))\n\n(define (step s) (rng-next s))`;
    const sugarcoat = schemeToSugarcoat(scheme);
    expect(() => sugarcoatToScheme(sugarcoat, scheme)).not.toThrow(); // round-trip is restored
    expect(paramHintsSugarcoat(sugarcoat).map((h) => h.name)).toEqual(["state"]); // (rng-next s) → [state]
  });

  it("if control hints render over sugarcoat", () => {
    const hints = paramHintsSugarcoat(schemeToSugarcoat(`(if (>= round 3) idea (loop idea round))`));
    expect(hints.map((h) => h.name)).toEqual(["cond", "then", "else"]);
  });

  it("let* control hints survive the sugarcoat I-EXPRESSION reshape (span-less synthesized bindings)", () => {
    // A multi-line let* renders as an I-expression whose `(a v)` binding-lists carry NO span
    // of their own — the hint must fall back to the binding's symbol start, not vanish.
    const scheme = `(let* ((a (spark "seed" :topic "a calmer morning routine")) (b (refine "sharpen" :idea (field a "idea")))) (digest a b))`;
    const sugarcoat = schemeToSugarcoat(scheme);
    const hints = paramHintsSugarcoat(sugarcoat);
    expect(hints.map((h) => h.name)).toEqual(["let", "let", "return"]);
    for (const h of hints) expect(/\S/.test(sugarcoat[h.pos])).toBe(true); // lands on a binding start, not whitespace
  });
});
