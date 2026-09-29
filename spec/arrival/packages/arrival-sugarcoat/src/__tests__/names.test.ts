import { describe, expect, it } from "vitest";

import { boundNameHints, tidyBoundNames } from "../names.js";
import { schemeToSugarcoat } from "../sugarcoat-render.js";

const tidy = (scheme: string): string => tidyBoundNames(scheme);
const sugarcoat = (scheme: string): string => schemeToSugarcoat(scheme).trim();

// §2 — the recovery ladder. A trailing-lambda's bound param is α-renamed to the most
// readable member of its α-class: `it` when every element use is keyed, a singular noun
// from the collection when the element fans out opaquely, else the original (unchanged).
describe("tidyBoundNames: the recovery ladder", () => {
  // rung 100 — all uses keyed (`(:family e)`) → the `it` pronoun.
  it("all-keyed element → it", () => {
    expect(tidy("(map (lambda (e) (:family e)) evidence)")).toBe("(map (lambda (it) (:family it)) evidence)");
  });
  it("all-keyed across accessors (cadr / @) → it", () => {
    expect(tidy("(filter (lambda (row) (equal? (cadr row) 0)) rows)")).toBe(
      "(filter (lambda (it) (equal? (cadr it) 0)) rows)",
    );
  });

  // rung 80 — the element escapes opaquely (bare, fan-out), HOF collection known → singular.
  it("fan-out with a known collection → singular noun", () => {
    expect(tidy("(map (lambda (x) (process x)) items)")).toBe("(map (lambda (item) (process item)) items)");
  });
  it("fan-out singular handles the -ies plural", () => {
    expect(tidy("(for-each (lambda (x) (render x)) families)")).toBe(
      "(for-each (lambda (family) (render family)) families)",
    );
  });

  // rung 40 — original survives. The earlier bug: the param read as free in its own body
  // and reserved itself, forcing a `k`→`k2` fallback. Original must pass through untouched.
  it("fan-out with no recognised collection keeps the original (call/cc)", () => {
    expect(tidy("(call/cc (lambda (k) (k 1)))")).toBe("(call/cc (lambda (k) (k 1)))");
  });
  it("fan-out under a non-HOF application keeps the original", () => {
    expect(tidy("(foo (lambda (x) (process x)) items)")).toBe("(foo (lambda (x) (process x)) items)");
  });

  // The plurality gate: rung 80 fires ONLY when the collection is demonstrably plural —
  // singularising actually changes the name. A collection whose name is already singular
  // (`history`) or not a count-noun (`matched`, `kept-v`) is no evidence of an element
  // noun, so renaming the element to the collection's own name would mis-name it → keep
  // the original. The singulariser is the plurality oracle.
  it("fan-out over a singular-named collection keeps the original (history)", () => {
    expect(tidy("(map (lambda (e) (make-hint e)) history)")).toBe("(map (lambda (e) (make-hint e)) history)");
  });
  it("fan-out over a past-participle collection keeps the original (matched)", () => {
    expect(tidy("(map (lambda (d) (desc-of d)) matched)")).toBe("(map (lambda (d) (desc-of d)) matched)");
  });
  it("irregular plural still singularises (people → person)", () => {
    expect(tidy("(map (lambda (x) (greet x)) people)")).toBe("(map (lambda (person) (greet person)) people)");
  });
});

// §3 — the gem: anaphora IS lexical scope. Nested eligible lambdas form a scope tree, and
// the resolver's "a descendant cannot reuse an ancestor's claimed name" produces anaphoric
// shadowing for free; sibling scopes are independent and each reuse `it`.
describe("tidyBoundNames: anaphora = lexical scope", () => {
  it("nested all-keyed: outer claims it, inner descends to its original", () => {
    expect(tidy("(map (lambda (e) (filter (lambda (f) (:ok f)) (:rows e))) groups)")).toBe(
      "(map (lambda (it) (filter (lambda (f) (:ok f)) (:rows it))) groups)",
    );
  });
  it("siblings independently reuse it", () => {
    expect(tidy("(begin (map (lambda (e) (:a e)) xs) (map (lambda (e) (:b e)) ys))")).toBe(
      "(begin (map (lambda (it) (:a it)) xs) (map (lambda (it) (:b it)) ys))",
    );
  });
});

// §1.1 — every output is α-equivalent: a rename must never capture a free variable nor
// shadow an inner reference. The reservation set is the body's free vars (minus the param).
describe("tidyBoundNames: capture avoidance", () => {
  it("does not rename a fan-out param onto a free `it` in its body", () => {
    // `it` is free in the body → recovering to `it` would capture it; falls to the singular.
    expect(tidy("(map (lambda (x) (cons (process x) it)) items)")).toBe(
      "(map (lambda (item) (cons (process item) it)) items)",
    );
  });
  it("does not rename onto a free var that collides with the singular", () => {
    // `item` is already free in the body → the rung-80 singular is blocked, original survives.
    expect(tidy("(map (lambda (x) (g x item)) items)")).toBe("(map (lambda (x) (g x item)) items)");
  });
});

// §C8 — the author already wrote `it`: a no-op (the assignment equals the original, so the
// param is left exactly as found and emits no hint).
describe("tidyBoundNames: author's own `it` is left alone", () => {
  it("an existing it binding is unchanged", () => {
    expect(tidy("(map (lambda (it) (:family it)) evidence)")).toBe("(map (lambda (it) (:family it)) evidence)");
  });
});

// The lens payoff (§4): after tidy, the renderer collapses a literal-`it` trailing lambda to
// the pronoun form `{ it … }` with no renderer change; a recovered singular stays an explicit
// `{(item) => …}` (α-equivalent, still round-trips). This is the whole point of mode A.
describe("tidyBoundNames → schemeToSugarcoat: the `it` collapse", () => {
  it("all-keyed collapses to the pronoun brace", () => {
    expect(sugarcoat(tidy("(map (lambda (e) (:family e)) evidence)"))).toBe("evidence.map{ it[:family] }");
  });
  it("a keyed filter chain collapses", () => {
    expect(sugarcoat(tidy('(length (filter (lambda (e) (equal? (:verdict e) "miss")) closure))'))).toBe(
      'closure.filter{ it[:verdict] == "miss" }.length',
    );
  });
  it("fan-out keeps an explicit recovered param", () => {
    expect(sugarcoat(tidy("(map (lambda (x) (process x)) items)"))).toBe("items.map{(item) => (process item)}");
  });
});

// Idempotence — a normalize pass: tidy(tidy(x)) ≡ tidy(x). A second pass finds the names
// already canonical and changes nothing (the canonical-sublanguage fixed point).
describe("tidyBoundNames: idempotence", () => {
  for (const src of [
    "(map (lambda (e) (:family e)) evidence)",
    "(map (lambda (x) (process x)) items)",
    "(map (lambda (e) (filter (lambda (f) (:ok f)) (:rows e))) groups)",
    "(call/cc (lambda (k) (k 1)))",
  ]) {
    it(src, () => {
      const once = tidy(src);
      expect(tidy(once)).toBe(once);
    });
  }
});

// Mode B — the glass overlay: source unchanged, a `{pos,name}` inlay per recovered param.
// Returns [] on a parse error (mid-edit buffer) rather than throwing.
describe("boundNameHints: the non-written overlay", () => {
  it("emits a hint at each recovered param's binding site", () => {
    const src = "(map (lambda (e) (:family e)) evidence)";
    const hints = boundNameHints(src);
    expect(hints).toEqual([{ pos: src.indexOf("e)"), name: "it" }]);
  });
  it("emits no hint when the name is unchanged (original survives)", () => {
    expect(boundNameHints("(call/cc (lambda (k) (k 1)))")).toEqual([]);
  });
  it("emits no hint for an author's existing `it`", () => {
    expect(boundNameHints("(map (lambda (it) (:family it)) evidence)")).toEqual([]);
  });
  it("returns [] on a parse error rather than throwing", () => {
    expect(boundNameHints("(map (lambda (e) (:family e")).toEqual([]);
  });
});
