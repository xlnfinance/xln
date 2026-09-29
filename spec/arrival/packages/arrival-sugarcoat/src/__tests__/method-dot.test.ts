import { describe, expect, it } from "vitest";
import { schemeToSugarcoat, printScheme } from "../sugarcoat-render.js";
import { readSugarcoatExpr, readSugarcoat } from "../sugarcoat-read.js";

const render = (scheme: string): string => schemeToSugarcoat(scheme).trim();
const read = (sugarcoat: string): string => printScheme(readSugarcoatExpr(sugarcoat));
const readAll = (sugarcoat: string): string =>
  readSugarcoat(sugarcoat)
    .map((f) => printScheme(f))
    .join("\n");

// §2/§3/§4.3 — the method dot reads as the receiver-last fold: every step seats the
// receiver in the LAST arg slot, unifying subscript `[…]` and method `.op`.
describe("read: method dot → receiver-last fold", () => {
  const cases: Array<[string, string]> = [
    // braced HOF — the thread-last pipe into a collection-last op. The lambda-brace
    // binds TIGHT to the op (`map{…}`), isomorphic to a tight arg-group `fold(knil)`.
    ["xs.map{ it * 2 }", "(map (lambda (it) (* it 2)) xs)"],
    ["xs.filter{ it == 0 }", "(filter (lambda (it) (equal? it 0)) xs)"],
    // explicit params (≥2 antecedents break the `it` pronoun → must name; §7.3)
    ["xs.map{(y) => y}", "(map (lambda (y) y) xs)"],
    ["xs.fold(knil){(acc x) => acc + x}", "(fold (lambda (acc x) (+ acc x)) knil xs)"],
    // bare unary dots — the visible unary pipe `x.f.g ↦ (g (f x))`
    ["x.f.g", "(g (f x))"],
    ["n.number->string.display", "(display (number->string n))"],
    // mixed: method then subscript, method body with subscript key
    ["closure.map{ it[:verdict][0] }", "(map (lambda (it) (car (:verdict it))) closure)"],
    ["xs.map{ it * 2 }[0]", "(car (map (lambda (it) (* it 2)) xs))"],
    // a LOOSE brace is a sibling curly operand, not the method's lambda — a bare
    // method next to an infix curly must not swallow it (the §7.3 round-trip guard).
    ["(begin n.number->string.display {n + 1})", "(begin (display (number->string n)) (+ n 1))"],
  ];
  for (const [sugarcoat, scheme] of cases) it(`${sugarcoat} → ${scheme}`, () => expect(read(sugarcoat)).toBe(scheme));
});

// §5 render gate — emit a chain iff ≥2 steps OR the single step is accessor / key /
// braced method. A lone bare unary canonicalizes to prefix (the §5 exceptionless cut).
describe("render: chain gate (≥2 steps OR a single accessor/key/braced)", () => {
  const cases: Array<[string, string]> = [
    ["(map (lambda (it) (* it 2)) xs)", "xs.map{ it * 2 }"],
    ["(filter (lambda (it) (equal? it 0)) xs)", "xs.filter{ it == 0 }"],
    ["(map (lambda (y) y) xs)", "xs.map{(y) => y}"],
    ["(map (lambda (it) (car (:verdict it))) closure)", "closure.map{ it[:verdict][0] }"],
    // ≥2 bare steps surface; a lone bare unary stays prefix
    ["(display (number->string n))", "n.number->string.display"],
    ["(not p)", "(not p)"], // lone bare unary → prefix, never p.not
    ["(g (f x))", "x.f.g"],
    // a bare op passed as a VALUE has no receiver step — never sugared
    ["(map car xs)", "(map car xs)"],
  ];
  for (const [scheme, sugarcoat] of cases) it(`${scheme} → ${sugarcoat}`, () => expect(render(scheme)).toBe(sugarcoat));
});

// The render gate's canonical sublanguage: render ∘ ⟦·⟧ = id on C (cyclic idempotence).
describe("cyclic idempotence: sugarcoat → scheme → sugarcoat", () => {
  for (const sugarcoat of [
    "xs.map{ it * 2 }",
    "xs.filter{ it == 0 }",
    "xs.map{(y) => y}",
    "closure.map{ it[:verdict][0] }",
    "x.f.g",
    "n.number->string.display",
  ]) {
    it(sugarcoat, () => expect(render(read(sugarcoat))).toBe(sugarcoat));
  }
});

// §3.4 — a child line whose first token is a method-DOT folds onto the parent line's
// value (same CST + §4.3 fold as the inline chain, just broken by indentation).
describe("newline method chains (⏎.op)", () => {
  it("folds dot-lines onto the parent value", () => {
    const sugarcoat = ["closure", "  .map{ it[:verdict] }", '  .filter{ it == "miss" }', "  .length"].join("\n");
    expect(readAll(sugarcoat)).toBe(
      '(length (filter (lambda (it) (equal? it "miss")) (map (lambda (it) (:verdict it)) closure)))',
    );
  });

  it("inline and newline chains share one CST", () => {
    const inline = read("closure.map{ it[:verdict] }.length");
    const broken = readAll(["closure", "  .map{ it[:verdict] }", "  .length"].join("\n"));
    expect(broken).toBe(inline);
  });

  it("a long method chain renders broken: base ⏎ one .op per line", () => {
    const out = schemeToSugarcoat(
      '(length (filter (lambda (item) (equal? (longish-field-name item) "audience-miss")) (map (lambda (item) (transform-the-record item)) the-closure-collection)))',
    );
    const lines = out.split("\n");
    expect(lines[0]).toBe("the-closure-collection");
    expect(lines.every((l, i) => i === 0 || l.trimStart().startsWith("."))).toBe(true);
  });

  it("a single long map/filter keeps method surface (not prefix map ⏎ lambda)", () => {
    // Over-width body used to fall through to scheme `map` ⏎ `lambda` ⏎ coll.
    const scheme = `(map (lambda (pov)
      (let ((entry (gepa-until-plateau initial personas hints (:system pov))))
        (dict :pov (:name pov) :entry entry)))
    (active-povs))`;
    const out = schemeToSugarcoat(scheme).trim();
    expect(out).toContain("(active-povs).map{(pov) =>");
    expect(out).not.toMatch(/^map\b/m);
    expect(out).not.toMatch(/^\s*lambda\b/m);
    // body may break multi-line scheme (I-expr can't live inside braces) but still
    // sugarcoats nested accessors
    expect(out).toContain("pov[:system]");
    expect(out).toContain("pov[:name]");
    // round-trip: method surface re-reads as map + lambda
    const roundtrip = readAll(out);
    expect(roundtrip).toMatch(/\(map\b/);
    expect(roundtrip).toMatch(/\(lambda\s+\(pov\)/);
    expect(roundtrip).toContain("(active-povs)");
  });
});

// §1 rewrite_L — a `\.` is a LITERAL dot in the symbol (unescaped on read, re-escaped
// on render); a `.` before a digit (`0.5`) or a double dot (`...`) never splits.
describe("dot-split edge cases", () => {
  it("escaped \\. is a literal-dot symbol, round-tripping", () => {
    expect(read("a\\.b")).toBe("a.b"); // one symbol "a.b", not (b a)
    expect(render("a.b")).toBe("a\\.b"); // re-escaped on the way back
  });
  it("decimals and ellipsis are never split", () => {
    expect(read("0.5")).toBe("0.5");
    expect(read("(x ...)")).toBe("(x ...)");
  });
});

// A trailing lambda passes its body through un-wrapped only for the arrow shape
// `(lambda (p…) …)` (param slot a LIST). A variadic `(lambda x)` body — a rest-symbol,
// never produced by the arrow form — is a datum to wrap in the `it` pronoun, not skip.
describe("trailing-lambda passthrough is arrow-shaped only", () => {
  it("explicit param-list lambda passes through (no double-wrap)", () => {
    expect(read("xs.map{(y) => y}")).toBe("(map (lambda (y) y) xs)");
  });
  it("a variadic (lambda x) body is wrapped in the pronoun, not mistaken for the arrow form", () => {
    expect(read("xs.map{ (lambda x) }")).toBe("(map (lambda (it) (lambda x)) xs)");
  });
});

// A binary/n-ary PREDICATE `(pred? arg… recv)` flips to the receiver-last method call
// `recv.pred?(arg…)`. Gated to `?`-heads: a subject-test reads well receiver-last, while a
// receiver-FIRST builtin (`vector-ref`, `list-ref`) is never a predicate, so it can't
// mis-seat. Round-trips through the reader's `.op(args)` receiver-last fold.
describe("render: predicate method-dot with args (receiver-last)", () => {
  const cases: Array<[string, string]> = [
    ["(valid-seat? (:game state) seat)", "seat.valid-seat?(state[:game])"],
    ["(valid-seat? game seat)", "seat.valid-seat?(game)"],
    ["(between? lo hi x)", "x.between?(lo hi)"], // n-ary predicate flips too
    ["(list? x)", "x.list?"], // unary unchanged (already flipped)
  ];
  for (const [scheme, sugar] of cases) it(`${scheme} → ${sugar}`, () => expect(render(scheme)).toBe(sugar));

  it("receiver-FIRST non-predicates stay prefix (no mis-seat)", () => {
    expect(render("(vector-ref v i)")).toBe("(vector-ref v i)");
    expect(render("(list-ref lst 3)")).toBe("(list-ref lst 3)");
  });

  it("equal?/eq? (NEVER_METHOD) never flip to a method dot", () => {
    expect(render("(eq? a b)")).not.toContain(".eq?");
    expect(render("(equal? a b)")).not.toContain(".equal?");
  });

  it("round-trips through the reader's receiver-last fold", () => {
    for (const s of ["(valid-seat? (:game state) seat)", "(between? lo hi x)"]) {
      expect(readAll(render(s))).toBe(s);
    }
  });
});

// Exclusion-from-exclusion: RELATIONAL predicates (suffix =? <? >? <=? >=?) are symmetric /
// ordering checks, not subject-tests — `#\2.char=?(x)` mis-reads an equality guard, so they
// stay prefix despite ending in `?`.
describe("render: relational predicates stay prefix (not method dots)", () => {
  for (const s of ["(char=? #\\2 x)", "(string=? a b)", "(char<? a b)", "(char<=? a b)", "(symbol=? a b)"]) {
    it(`${s} stays prefix`, () => expect(render(s)).toBe(s));
  }
});

// A define/define/overridable SIGNATURE is a binding target, not a call — it must never
// method-dot-flip, even for a predicate name. `define (hand-value? x)`, not the confusing
// `define x.hand-value?`. The body flips normally (its predicate calls ARE calls).
describe("render: define signatures are never method-dotted", () => {
  it("predicate function define keeps a literal signature", () => {
    expect(render("(define (hand-value? x) (dict? x))")).toBe("define (hand-value? x)\n  x.dict?");
  });
  it("n-ary predicate signature stays literal", () => {
    expect(render("(define (between? lo hi x) (list? x))").split("\n")[0]).toBe("define (between? lo hi x)");
  });
  it("round-trips", () => {
    expect(readAll(render("(define (hand-value? x) (dict? x))"))).toBe("(define (hand-value? x) (dict? x))");
  });
});

// `let` always breaks (cognitive density, not line length — a binding is a named
// intermediate the reader tracks). Its BINDINGS are binding targets, never method-dotted:
// `(let ((y (g x))) …)` keeps `((y (g x)))`, never `x.g.y`.
describe("render: let always breaks; bindings stay literal (never method-dotted)", () => {
  it("a short let still breaks to multiple lines", () => {
    expect(render("(define (short) (let ((x 1)) x))").includes("\n")).toBe(true);
  });
  it("a let binding keeps its value literal, never method-dots the binding pair", () => {
    const out = render("(define (f x) (let ((y (g x))) (h y)))");
    expect(out).toContain("(g x)");
    expect(out).not.toContain("x.g.y");
  });
  it("named let elides its bindings too (loop symbol on the head line)", () => {
    expect(render("(let loop ((i 0)) (loop i))")).toBe("let loop\n  i\n    0\n  (loop i)");
  });
  it("multi-binding named let elides + round-trips", () => {
    const s = "(let loop ((rel 0) (rest deck)) (step rel rest))";
    expect(render(s).split("\n")[0]).toBe("let loop");
    expect(readAll(render(s))).toBe(s);
  });
  it("round-trips", () => {
    for (const s of ["(define (f x) (let ((y (g x))) (h y)))", "(let loop ((i 0)) (loop i))"]) {
      expect(readAll(render(s))).toBe(s);
    }
  });
});

// Element-wise HOF with a NAMED function flips receiver-last: `(map run-one-test tests)` →
// `tests.map(run-one-test)`. Only known HOFs (collection reliably last); accessors passed as
// values stay prefix (they have their own `[0]` sugar, aren't named functions).
describe("render: named-function HOF → receiver-last method call", () => {
  const cases: Array<[string, string]> = [
    ["(map run-one-test tests)", "tests.map(run-one-test)"],
    ["(filter even? nums)", "nums.filter(even?)"],
    ["(for-each display xs)", "xs.for-each(display)"],
    ["(remove null? xs)", "xs.remove(null?)"],
  ];
  for (const [scheme, sugar] of cases) it(`${scheme} → ${sugar}`, () => expect(render(scheme)).toBe(sugar));

  it("accessor mapper stays prefix (car/cadr aren't named functions)", () => {
    expect(render("(map car xs)")).toBe("(map car xs)");
    expect(render("(map cadr xs)")).toBe("(map cadr xs)");
  });
  it("a non-HOF head never flips a named-arg call", () => {
    expect(render("(foo bar baz)")).toBe("(foo bar baz)");
  });
  it("round-trips", () => {
    for (const s of ["(map run-one-test tests)", "(filter even? nums)"]) expect(readAll(render(s))).toBe(s);
  });
});

// `not` is never a method-dot step — `(not (dict? x))` stays `(not x.dict?)`, never chains to
// the backwards-reading `x.dict?.not`. The negation MACRO (`(not (= a b))` → `{a ≠ b}`) is a
// separate check, unaffected.
describe("render: not stays prefix (never a .not step)", () => {
  it("wraps a flipped predicate in prefix not, not a trailing .not", () => {
    expect(render("(not (dict? x))")).toBe("(not x.dict?)");
    expect(render("(not (list? y))")).toBe("(not y.list?)");
  });
  it("plain (not x) stays prefix", () => {
    expect(render("(not done)")).toBe("(not done)");
  });
});

// A raw scalar literal (number/bool/char) is never a method-dot RECEIVER — `7.valid?` reads
// as nonsense. Such a chain stays prefix. A literal as an ARGUMENT is still fine (only the
// chain base is gated).
describe("render: literal scalars are never method-dot receivers", () => {
  it("number/bool/char receiver keeps the call prefix", () => {
    expect(render("(valid-card-set? cards 7)")).toBe("(valid-card-set? cards 7)");
    expect(render("(some? cards #t)")).toBe("(some? cards #t)");
    expect(render("(map f 7)")).toBe("(map f 7)");
  });
  it("a literal as an ARGUMENT still flips (only the base is gated)", () => {
    expect(render("(foo? #t x)")).toBe("x.foo?(#t)");
  });
  it("round-trips", () => {
    expect(readAll(render("(not (valid-card-set? cards 7))"))).toBe("(not (valid-card-set? cards 7))");
  });
});

// A let/let* with a SINGLE body expr elides the `(( ))` (the reader reserves the last child
// as body): each binding is `name` ⏎ `value`, no parens. With ≥2 body exprs, a binding-shaped
// first body expr would be swallowed, so the `(( ))` group is kept.
describe("render: let bindings — elided (single body) vs paren-kept (multi body)", () => {
  it("single-body let* elides to name ⏎ value (no parens)", () => {
    expect(render("(let* ((a (f x)) (b (g y))) (h b))")).toBe("let*\n  a\n    (f x)\n  b\n    (g y)\n  (h b)");
  });
  it("single-binding single-body let elides too", () => {
    expect(render("(let ((x (f y))) (h x))")).toBe("let\n  x\n    (f y)\n  (h x)");
  });
  it("≥2 body exprs keep the `(( ))` group (elision would swallow the first body expr)", () => {
    expect(render("(let ((a 1)) (b 2) (c 3))")).toBe("let ((a 1))\n  (b 2)\n  (c 3)");
  });
  it("round-trips both forms", () => {
    expect(readAll(render("(let* ((a (f x)) (b (g y))) (h b))"))).toBe("(let* ((a (f x)) (b (g y))) (h b))");
    expect(readAll(render("(let ((a 1)) (b 2) (c 3))"))).toBe("(let ((a 1)) (b 2) (c 3))");
  });
});
