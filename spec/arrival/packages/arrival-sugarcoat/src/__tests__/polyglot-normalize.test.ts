/**
 * Polyglot-superset inventory → sugarcoat normalize.
 *
 * Arrival's reader/eval accept named compile-erased supersets
 * (`packages/arrival/docs/grammar.md` §BINDINGS / §CLAUSES / §LITERALS).
 * `schemeToSugarcoat` must lower them to the R7RS paren image before layout so
 * **intent** is preserved even when the tolerant spelling is erased.
 *
 * Law: normalize(poly) → sugar → readSugarcoat ≡ paren image of poly.
 * Tolerant surface need not survive (whole-list `[a 1 b 2]` may become elided
 * `let` bindings); binding names/values and clause structure must.
 *
 * Spec pins for eval-time consumption live in arrival's
 * `src/reader/__tests__/polyglot/`; this file is the sugarcoat-lens face of the
 * same inventory.
 */

import { describe, expect, it } from "vitest";

import { schemeToSugarcoat, printScheme, parseSexprs, normalizePolyglot, nodeEq } from "../sugarcoat-render.js";
// Registers sugar reader for dual-path schemeToSugarcoat (at-expr / I-expr re-entry).
import { readSugarcoat } from "../sugarcoat-read.js";

const norm = (src: string): string =>
  normalizePolyglot(parseSexprs(src))
    .map((f) => printScheme(f))
    .join("\n");

const roundtrip = (src: string): string =>
  readSugarcoat(schemeToSugarcoat(src))
    .map((f) => printScheme(f))
    .join("\n");

const astEq = (a: string, b: string): boolean => {
  const fa = parseSexprs(a);
  const fb = parseSexprs(b);
  // After normalize, both sides are pure scheme (no open stamps needed).
  if (fa.length !== fb.length) return false;
  return fa.every((n, i) => nodeEq(n, fb[i]!));
};

// ═══════════════════════════════════════════════════════════════════════════
// §BINDINGS — BG2a whole-list (Clojure), BG2b per-element (Racket), BG2c mix
// ═══════════════════════════════════════════════════════════════════════════

describe("§BINDINGS BG2b per-element (Racket) → paren image", () => {
  it.each([
    {
      name: "let*",
      poly: "(let* ([a 1] [b 2]) (+ a b))",
      image: "(let* ((a 1) (b 2)) (+ a b))",
    },
    {
      name: "let",
      poly: "(let ([a 1]) a)",
      image: "(let ((a 1)) a)",
    },
    {
      name: "letrec",
      poly: "(letrec ([f (lambda () 1)]) (f))",
      image: "(letrec ((f (lambda () 1))) (f))",
    },
    {
      name: "letrec*",
      poly: "(letrec* ([a 1] [b (+ a 1)]) b)",
      image: "(letrec* ((a 1) (b (+ a 1))) b)",
    },
    {
      name: "named let",
      poly: "(let loop ([i 0]) i)",
      image: "(let loop ((i 0)) i)",
    },
    {
      name: "do steps",
      poly: "(do ([i 0 (+ i 1)]) (= i 3) i)",
      image: "(do ((i 0 (+ i 1))) (= i 3) i)",
    },
  ])("$name: normalize ≡ image and sugar round-trips to image", ({ poly, image }) => {
    expect(astEq(norm(poly), image)).toBe(true);
    expect(astEq(roundtrip(poly), image)).toBe(true);
    // Image itself is stable.
    expect(astEq(roundtrip(image), image)).toBe(true);
  });
});

describe("§BINDINGS BG2a whole-list (Clojure) → paren pairs", () => {
  it.each([
    {
      name: "let",
      poly: "(let [a 1 b 2] (+ a b))",
      image: "(let ((a 1) (b 2)) (+ a b))",
    },
    {
      name: "let*",
      poly: "(let* [a 1 b 2] (+ a b))",
      image: "(let* ((a 1) (b 2)) (+ a b))",
    },
    {
      name: "named let",
      poly: "(let loop [i 0] i)",
      image: "(let loop ((i 0)) i)",
    },
    {
      name: "letrec",
      poly: "(letrec [f 1] f)",
      image: "(letrec ((f 1)) f)",
    },
  ])("$name: whole-list pairs to image; sugar preserves intent", ({ poly, image }) => {
    expect(astEq(norm(poly), image)).toBe(true);
    expect(astEq(roundtrip(poly), image)).toBe(true);
  });

  it("elided sugar surface still carries both bindings", () => {
    const sugar = schemeToSugarcoat("(let [a 1 b 2] (+ a b))");
    // Tolerant brackets are gone; names a/b remain.
    expect(sugar).toMatch(/\ba\b/);
    expect(sugar).toMatch(/\bb\b/);
    expect(sugar).not.toMatch(/\[a 1 b 2\]/);
  });
});

describe("§BINDINGS BG2c mixed paren + bracket pairs", () => {
  it("mix normalizes to all-paren pairs", () => {
    const poly = "(let ([a 1] (b 2)) (+ a b))";
    const image = "(let ((a 1) (b 2)) (+ a b))";
    expect(astEq(norm(poly), image)).toBe(true);
    expect(astEq(roundtrip(poly), image)).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// §CLAUSES — BG9 cond / case / do test
// ═══════════════════════════════════════════════════════════════════════════

describe("§CLAUSES BG9 bracket clauses → paren clauses", () => {
  it.each([
    {
      name: "cond",
      poly: '(cond [(> x 1) "a"] [else "b"])',
      image: '(cond ((> x 1) "a") (else "b"))',
    },
    {
      name: "case (datum list stays a list)",
      poly: '(case k [(1 2) "low"] [else "hi"])',
      image: '(case k ((1 2) "low") (else "hi"))',
    },
    {
      name: "do test clause",
      poly: "(do ((i 0 (+ i 1))) [(= i 3) i])",
      image: "(do ((i 0 (+ i 1))) ((= i 3) i))",
    },
  ])("$name", ({ poly, image }) => {
    expect(astEq(norm(poly), image)).toBe(true);
    expect(astEq(roundtrip(poly), image)).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Free surfaces — sugarcoat list/dict (aligned with the view, not arrival vectors)
// ═══════════════════════════════════════════════════════════════════════════

describe("free [] / {} lower to list/dict heads (sugarcoat surface)", () => {
  it.each([
    { poly: "[1 2 3]", image: "(list 1 2 3)" },
    { poly: "[]", image: "(list)" },
    { poly: "{:a 1 :b 2}", image: "(dict :a 1 :b 2)" },
    { poly: "{}", image: "(dict)" },
    { poly: "[{:form 'notify}]", image: "(list (dict :form (quote notify)))" },
    { poly: "{a + b}", image: "(+ a b)" },
    { poly: "{flight_number: 1}", image: "(dict :flight_number 1)" },
  ])("$poly → $image", ({ poly, image }) => {
    expect(astEq(norm(poly), image)).toBe(true);
    expect(astEq(roundtrip(poly), image)).toBe(true);
  });

  it("scheme (list)/(dict) unchanged", () => {
    expect(astEq(norm("(list 1 2)"), "(list 1 2)")).toBe(true);
    expect(astEq(norm("(dict :a 1)"), "(dict :a 1)")).toBe(true);
  });

  it("(vector …) stays vector — free [] is NOT vector sugar here", () => {
    // Arrival free [1 2 3] is a vector at eval; the sugarcoat lens claims free []
    // as list. Scheme vector constructors are the honest vector spelling.
    expect(astEq(norm("(vector 1 2 3)"), "(vector 1 2 3)")).toBe(true);
    expect(schemeToSugarcoat("(vector 1 2 3)").trim()).toBe("(vector 1 2 3)");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Mode-override shape — the regression that shipped green before domain isolation
// ═══════════════════════════════════════════════════════════════════════════

describe("mode-override list-of-dict intent", () => {
  const scheme = '(list (dict :form (quote notify) :level (quote error) :message "hi"))';

  it("scheme → sugar → re-schemeToSugarcoat preserves AST", () => {
    const once = schemeToSugarcoat(scheme).trim();
    expect(once).toMatch(/^\[\{/);
    const twice = schemeToSugarcoat(once).trim();
    expect(twice).not.toMatch(/^\(\{:form/);
    expect(astEq(roundtrip(once), scheme)).toBe(true);
    expect(astEq(roundtrip(twice), scheme)).toBe(true);
  });

  it("sweet source [{…}] normalizes to list-of-dict, not bare call", () => {
    const sweet = "[{:form 'notify :level 'error :message \"hi\"}]";
    expect(astEq(norm(sweet), scheme)).toBe(true);
    expect(astEq(roundtrip(sweet), scheme)).toBe(true);
  });
});
