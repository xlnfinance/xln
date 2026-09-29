import { describe, expect, it } from "vitest";

import { schemeToSugarcoat, printScheme, parseSexprs } from "../sugarcoat-render.js";
import { readSugarcoatExpr, readSugarcoat } from "../sugarcoat-read.js";

const render = (scheme: string, opts = {}): string => schemeToSugarcoat(scheme, opts).trim();
const read1 = (sugarcoat: string): string => printScheme(readSugarcoatExpr(sugarcoat));
const canon = (scheme: string): string => printScheme(parseSexprs(scheme)[0]);
const roundtrip = (scheme: string, opts = {}): string => printScheme(readSugarcoatExpr(render(scheme, opts)));
// Multi-line I-expression output (broken if/begin/cond) must round-trip through the
// whole-program reader (indentation grouping), not the single-expression reader.
const roundtripAll = (scheme: string, opts = {}): string =>
  readSugarcoat(render(scheme, opts))
    .map((f) => printScheme(f))
    .join("\n");

// ── 1. lone-unary → method dot, gated on `?`-predicates / `->`-conversions / allow ──
// The §5 gate flipped: a lone unary now surfaces as `x.f` when the head reads well
// postfix (a predicate, a conversion, or a curated well-known op). `not`/generic
// verbs stay prefix. Round-trip is the moat — the reader folds any `x.f` back.
describe("lone-unary → method dot (gated)", () => {
  const flips: Array<[string, string]> = [
    ["(list? x)", "x.list?"],
    ["(length x)", "x.length"],
    ["(null? xs)", "xs.null?"],
    ["(err? result)", "result.err?"],
    ["(number->string view)", "view.number->string"], // `->` conversion family
    ["(reverse xs)", "xs.reverse"], // curated allow
    ["(string-upcase s)", "s.string-upcase"],
  ];
  for (const [scheme, sugarcoat] of flips) it(`${scheme} → ${sugarcoat}`, () => expect(render(scheme)).toBe(sugarcoat));

  const stayPrefix: string[] = [
    "(not p)", // `not` reads worse postfix — kept prefix
    "(display x)", // generic verb, not in allow set
    "(foo x)", // unknown unary
    "(map car xs)", // `car` passed as a VALUE, not a receiver step
  ];
  for (const s of stayPrefix) it(`${s} stays prefix`, () => expect(render(s)).toBe(s));

  // V's exact example: ok? collapses to the method-chain reading
  it("ok? predicate body collapses (V's example)", () => {
    expect(render("(and (list? x) (= (length x) 2) (eq? (car x) 'ok))")).toBe(
      "{x.list? and x.length = 2 and x[0] eq? 'ok}",
    );
  });

  for (const [scheme] of flips) it(`round-trips ${scheme}`, () => expect(roundtrip(scheme)).toBe(canon(scheme)));
});

// ── 2. `if` always breaks: condition on the head line, arms on their own lines ──
describe("if breaks by density (trivial inlines, a nested arm verticalizes)", () => {
  // A TRIVIAL if — condition + arms are atoms or flat (all-atom) lists — reads best on one
  // line; the always-break was too blunt for these low-density forks.
  it("all-atom if inlines", () => expect(render("(if a b c)")).toBe("(if a b c)"));
  it("two-arm trivial if inlines", () => expect(render("(if a b)")).toBe("(if a b)"));
  it("flat-list arms are still trivial (inline)", () => {
    expect(render("(if (null? xs) 0 (fold-left f x y))")).toBe("(if xs.null? 0 (fold-left f x y))");
  });
  // The moment an arm nests a real sub-computation, the fork verticalizes again.
  it("a nested-compound arm verticalizes", () => {
    expect(render("(if (valid? x) (make-result (f x)) (err))")).toBe("if x.valid?\n  x.f.make-result\n  (err)");
  });
  for (const s of ["(if a b c)", "(if (null? xs) 0 (fold-left f x y))", "(if (valid? x) (make-result (f x)) (err))"])
    it(`round-trips ${s}`, () => expect(roundtripAll(s)).toBe(canon(s)));
});

// ── 3. `begin` always breaks: every step on its own line, none pulled onto head ──
describe("begin always breaks (steps each on a line, none on the head)", () => {
  it("steps break", () => expect(render("(begin a b c)")).toBe("begin\n  a\n  b\n  c"));
  it("no first-step pull onto the begin line", () => {
    expect(render("(begin (foo) (bar))")).toBe("begin\n  (foo)\n  (bar)");
  });
  for (const s of ["(begin a b c)", "(begin (foo) (bar))"])
    it(`round-trips ${s}`, () => expect(roundtripAll(s)).toBe(canon(s)));
});

// ── 4. cond `=>` clause → `=?>` (partial-arrow glyph): distinct from the lambda `=>`,
//       folds back to the R7RS `=>` receiver symbol, stays connected (never hanging) ──
describe("cond => clause renders as =?> and stays connected", () => {
  it("inline when it fits: `test =?> recv`", () => {
    expect(render("(cond ((foo x) => (bar)) (else (baz)))")).toBe("cond\n  (foo x) =?> (bar)\n  else\n    (baz)");
  });
  it("does NOT touch the lambda arrow (only the cond receiver form)", () => {
    const out = render("(cond ((f x) => (lambda (d) (g d))) (else (h)))");
    expect(out).toContain("(f x) =?> {(d) => (g d)}"); // cond arrow =?>, lambda arrow still =>
  });
  it("wide recv: `test =?>` trailing, recv on the next line (never a lone arrow)", () => {
    const out = render("(cond ((foo x) => (a-really-quite-long-receiver-call p q r s)) (else (baz)))", { width: 30 });
    expect(out).toContain("(foo x) =?>");
    expect(out).not.toMatch(/^\s*=\??>\s*$/m); // no line that is only an arrow
  });
  it("case receiver clause also renders =?> (same R7RS => receiver form)", () => {
    const s = "(case k ((1 2) => proc) (else (x)))";
    expect(render(s)).toContain("(1 2) =?> proc");
    expect(
      readSugarcoat(render(s))
        .map((f) => printScheme(f))
        .join(""),
    ).toBe(canon(s)); // folds back
  });
  it("reader folds =?> (and math skins ⇀ / ⇸) back to the => symbol", () => {
    for (const g of ["=?>", "⇀", "⇸"])
      expect(
        readSugarcoat(`cond\n  (foo x) ${g} (bar)\n  else\n    (baz)`)
          .map((f) => printScheme(f))
          .join(""),
      ).toBe(canon("(cond ((foo x) => (bar)) (else (baz)))"));
  });
  for (const s of ["(cond ((foo x) => (bar)) (else (baz)))"])
    it(`round-trips ${s}`, () =>
      expect(
        readSugarcoat(render(s))
          .map((f) => printScheme(f))
          .join("\n"),
      ).toBe(canon(s)));
});

// ── 5. `'()` → `nil` surface glyph (sound: reader folds nil back), shadow-guarded ──
describe("'() renders as nil (shadow-aware)", () => {
  it("bare empty-quote → nil", () => expect(render("'()")).toBe("nil"));
  it("empty-quote in position → nil", () => expect(render("(set! x '())")).toBe("(set! x nil)"));
  it("reader folds nil back to '()", () => expect(read1("nil")).toBe("(quote ())"));
  it("round-trips through the glyph", () => expect(roundtrip("(set! x '())")).toBe(canon("(set! x '())")));
  it("shadowed by (define nil <non-empty>) → stays '()", () => {
    const out = schemeToSugarcoat("(define nil 5)\n(set! x '())");
    expect(out).toContain("(set! x '())");
    expect(out).not.toContain("nil)");
  });
  it("explicit (define nil '()) still allows the glyph", () => {
    expect(schemeToSugarcoat("(define nil '())\n(set! x '())")).toContain("(set! x nil)");
  });
});

// ── 6. string-append → @{…} (default strTolerant modernize) ──
// Default projection: headless `@{…}` + drop redundant scalar→string coercions.
// One-way: reads back as `str`, not `string-append`. Strict mode keeps the old lens.
describe("string-append → @{…} (default: strip coercions, headless str)", () => {
  const matchstate =
    '(string-append "MATCHSTATE:" (number->string view) ":" (number->string (state-hand-id state)) ":" (state-betting-string state) ":" (matchstate-holes-string state view) (matchstate-board-string state))';
  it("renders as a single @{…} at-expression with coercions stripped", () => {
    // `@|view|` / `@|…|` guards when the next literal starts with `:` (interp-class).
    expect(render(matchstate)).toBe(
      "@{MATCHSTATE:@|view|:@(state-hand-id state):@(state-betting-string state):@(matchstate-holes-string state view)@(matchstate-board-string state)}",
    );
  });
  it("modernize is one-way: reads back as str, not string-append", () => {
    const back = readSugarcoat(render(matchstate)).map(printScheme).join("\n");
    expect(back).toContain("(str");
    expect(back).toContain("view");
    expect(back).not.toContain("number->string");
    expect(back).not.toContain("string-append");
  });
  // colon-separated, no spaces, one call hole (no coercion to strip)
  it("a separator template with a call hole surfaces as @{…}", () => {
    expect(render('(string-append "a:" (f x) ":b")')).toBe("@{a:@(f x):b}");
  });
  it("strict mode keeps @string-append head (coercions may surface as method dots)", () => {
    // strTolerant:false keeps the string-append head; unary conversions still
    // flip to method dots (`view.number->string`) via the general method gate.
    const out = render(matchstate, { strTolerant: false });
    expect(out.startsWith("@string-append{")).toBe(true);
    expect(out).toContain("number->string");
    expect(roundtrip(matchstate, { strTolerant: false })).toBe(canon(matchstate));
  });
});

// ── KWARGS LAW: known-kwargs never n-expr / never neoteric; unknown heads keep shape ──
describe("kwargs law (known head: no n-expr/neoteric; unknown: no pair lines)", () => {
  it("unknown head keeps scheme call shape (no k:v pair inventing)", () => {
    // fits or breaks — never colon-pair lines under a non-kwarg head
    expect(render("(foo :a 1 :b 2)")).toBe("(foo :a 1 :b 2)");
    expect(render("(foo :a 1 :b 2)", { width: 8 })).toContain(":a");
    expect(render("(foo :a 1 :b 2)", { width: 8 })).not.toMatch(/^\s*a:\s/m);
  });
  it("known kwarg head that is ALSO an infix op never becomes n-expr", () => {
    // Collision case: .prompt bound to `gt` (word-form comparison is INFIX).
    // Without the law, (gt :lo 1 :hi 9) would become {:lo > 1 > :hi > 9}.
    const src = `(define gt (require "bounds.prompt"))\n(gt :lo 1 :hi 9)`;
    const inline = schemeToSugarcoat(src);
    expect(inline).toContain("(gt :lo 1 :hi 9)"); // scheme kwargs call, not n-expr
    expect(inline).not.toMatch(/\{[^}]*\}/); // no curly n-expr
    expect(inline).not.toMatch(/\s>\s/); // no comparison glyph rewrite
    // When broken for width, pair lines — still not n-expr.
    const broken = schemeToSugarcoat(src, { width: 12 });
    expect(broken).toMatch(/lo:/);
    expect(broken).toMatch(/hi:/);
    expect(broken).not.toMatch(/\{/);
  });
  it("known kwarg head never goes neoteric", () => {
    const src = `(define react (require "x.prompt"))\n(react :persona p)`;
    const out = schemeToSugarcoat(src, { neoteric: true });
    expect(out).not.toMatch(/react\s*\(/);
    expect(out).toContain(":persona");
  });
  it("plain infix gt (not a kwarg head) still prefers n-expr", () => {
    expect(render("(gt a b)")).toBe("{a > b}");
  });
});

// ── 7b. word-form comparisons → glyphs + prefer n-expr (one-way to R7RS) ──
describe("lt/gt/lte/gte prefer n-expr with scheme glyphs", () => {
  it("renders word forms as curly comparison", () => {
    expect(render("(lt a b)")).toBe("{a < b}");
    expect(render("(gt a b)")).toBe("{a > b}");
    expect(render("(lte a b)")).toBe("{a <= b}");
    expect(render("(gte a b)")).toBe("{a >= b}");
  });
  it("n-ary word forms stay one curly", () => {
    expect(render("(lt a b c)")).toBe("{a < b < c}");
  });
  it("reads word-form infix to R7RS heads", () => {
    expect(read1("{a lt b}")).toBe("(< a b)");
    expect(read1("{a gt b}")).toBe("(> a b)");
    expect(read1("{a lte b}")).toBe("(<= a b)");
    expect(read1("{a gte b}")).toBe("(>= a b)");
  });
  it("one-way: word-form scheme rewrites to R7RS on round-trip", () => {
    expect(roundtrip("(lt a b)")).toBe(canon("(< a b)"));
    expect(roundtrip("(gt x y)")).toBe(canon("(> x y)"));
    expect(roundtrip("(lte p q)")).toBe(canon("(<= p q)"));
    expect(roundtrip("(gte p q)")).toBe(canon("(>= p q)"));
  });
  it("native R7RS comparisons still round-trip as themselves", () => {
    for (const s of ["(< a b)", "(> a b)", "(<= a b)", "(>= a b)"]) expect(roundtrip(s)).toBe(canon(s));
  });
});

// ── 7. logicals stay as scheme symbols (`and`/`or`), prefer flat n-expr ──
describe("and/or surface as themselves (no &&/|| rewrite)", () => {
  it("binary and/or render as word glyphs", () => {
    expect(render("(and a b)")).toBe("{a and b}");
    expect(render("(or a b)")).toBe("{a or b}");
  });
  it("n-ary flat form is the preferred n-expr", () => {
    expect(render("(and a b c)")).toBe("{a and b and c}");
    expect(render("(or a b c)")).toBe("{a or b or c}");
    expect(read1("{a and b and c}")).toBe("(and a b c)");
    expect(read1("{a or b or c}")).toBe("(or a b c)");
  });
  it("boolean mixing is LICENSELESS — and under or (and vice versa) keeps braces", () => {
    // Doctrine §5.2: never emit the ambiguous flat form `{a and b or c}`.
    expect(render("(or (and a b) c)")).toBe("{{a and b} or c}");
    expect(render("(or a (and b c) d)")).toBe("{a or {b and c} or d}");
    expect(render("(or (and a b) (and c d) e)")).toBe("{{a and b} or {c and d} or e}");
    expect(render("(and a (or b c))")).toBe("{a and {b or c}}");
    expect(render("(and (or a b) c)")).toBe("{{a or b} and c}");
  });
  it("harness-style mixed and/or auto-containerizes each and-group", () => {
    const scheme =
      '(or (and kv (kv-get kv "harness.approval.mode")) (and kernel (:default-approval-mode kernel)) "ask")';
    expect(render(scheme)).toBe(
      '{{kv and (kv-get kv "harness.approval.mode")} or {kernel and kernel[:default-approval-mode]} or "ask"}',
    );
    expect(roundtrip(scheme)).toBe(canon(scheme));
  });
  it("associative flatten: nested same-op and/or collapse (intent, not tree spelling)", () => {
    // Tradeoff: binary-tree nesting is lost; conjunction/disjunction intent remains.
    expect(render("(and (and a b) c)")).toBe("{a and b and c}");
    expect(render("(and a (and b c))")).toBe("{a and b and c}");
    expect(render("(or (or a b) (or c d))")).toBe("{a or b or c or d}");
    expect(roundtrip("(and (and a b) c)")).toBe(canon("(and a b c)"));
    expect(roundtrip("(and a (and b c))")).toBe(canon("(and a b c)"));
    // Different ops do NOT flatten into each other — and stay containerized.
    expect(render("(and (or a b) c)")).toBe("{{a or b} and c}");
    expect(roundtrip("(and (or a b) c)")).toBe(canon("(and (or a b) c)"));
  });
  it("reads braced mixed forms; doors bare mixed and/or", () => {
    expect(read1("{a and b}")).toBe("(and a b)");
    expect(read1("{a or b}")).toBe("(or a b)");
    expect(read1("{{a and b} or c}")).toBe("(or (and a b) c)");
    // Bare mix is a door (licenseless) — brace the groups.
    expect(() => read1("{a and b or c}")).toThrowError(/mixed 'and'\/'or'|licenseless|brace/i);
  });
  it("legacy &&/|| still fold on read (older views)", () => {
    expect(read1("{a && b}")).toBe("(and a b)");
    expect(read1("{a || b}")).toBe("(or a b)");
  });
  for (const s of ["(and a b c)", "(or (and p q) r)", "(and (list? x) (or (eq? a b) (<= c d)))"])
    it(`round-trips ${s}`, () => expect(roundtrip(s)).toBe(canon(s)));
});

// ── 8. math skin (opt-in Agda-style Unicode) — Family A infix + arrows, bidirectional ──
const math = { skin: "math" as const };
describe("math skin: infix glyph swaps + arrows (opt-in, bidirectional)", () => {
  const swaps: Array<[string, string]> = [
    ["(and a b)", "{a ∧ b}"],
    ["(or a b)", "{a ∨ b}"],
    ["(equal? a b)", "{a ≡ b}"],
    ["(eq? a b)", "{a ≈ b}"], // wavy — identity pair
    ["(eqv? a b)", "{a ≃ b}"],
    ["(<= a b)", "{a ≤ b}"],
    ["(>= a b)", "{a ≥ b}"],
    ["(= a b)", "{a = b}"], // numeric = stays =
  ];
  for (const [scheme, out] of swaps) it(`${scheme} → ${out}`, () => expect(render(scheme, math)).toBe(out));

  it("V's ok? body in the math skin", () => {
    expect(render("(and (list? x) (= (length x) 2) (eq? (car x) 'ok))", math)).toBe(
      "{x.list? ∧ x.length = 2 ∧ x[0] ≈ 'ok}",
    );
  });
  it("lambda arrow → ↦ (maps-to)", () => {
    expect(render("(map (lambda (x) (* x 2)) xs)", math)).toBe("xs.map{(x) ↦ x * 2}");
  });
  it("cond/case receiver → ⇀", () => {
    expect(render("(cond ((f x) => (g)) (else (h)))", math)).toContain("(f x) ⇀ (g)");
    expect(render("(case k ((1 2) => proc) (else (x)))", math)).toContain("(1 2) ⇀ proc");
  });

  // reader accepts the math vocabulary (bidirectional) and folds to canonical
  const reads: Array<[string, string]> = [
    ["{a ∧ b}", "(and a b)"],
    ["{a ∨ b}", "(or a b)"],
    ["{a ≡ b}", "(equal? a b)"],
    ["{a ≈ b}", "(eq? a b)"],
    ["{a ≃ b}", "(eqv? a b)"],
    ["{a ≤ b}", "(<= a b)"],
    ["{a ≥ b}", "(>= a b)"],
    ["xs.map{(x) ↦ x * 2}", "(map (lambda (x) (* x 2)) xs)"],
  ];
  for (const [sugar, scheme] of reads) it(`reads ${sugar} → ${scheme}`, () => expect(read1(sugar)).toBe(scheme));

  // full round-trip through the math skin
  for (const s of ["(and (list? x) (or (eq? a b) (<= c d)))", "(map (lambda (x) (* x 2)) xs)", "(equal? p q)"])
    it(`round-trips ${s} (math)`, () => expect(roundtrip(s, math)).toBe(canon(s)));
});

// ── Family B: negated-comparison collapse (math skin, bidirectional) ──
describe("math skin: (not (relop …)) ↔ ≠ / ≢ / ≉ / ≄", () => {
  const collapses: Array<[string, string]> = [
    ["(not (= a b))", "{a ≠ b}"],
    ["(not (equal? a b))", "{a ≢ b}"],
    ["(not (eq? a b))", "{a ≉ b}"],
    ["(not (eqv? a b))", "{a ≄ b}"],
  ];
  for (const [scheme, out] of collapses) {
    it(`${scheme} → ${out}`, () => expect(render(scheme, math)).toBe(out));
    it(`reads ${out} → ${scheme}`, () => expect(read1(out)).toBe(canon(scheme)));
    it(`round-trips ${scheme}`, () => expect(roundtrip(scheme, math)).toBe(canon(scheme)));
  }
  it("composes inside a larger infix", () => {
    expect(render("(and p (not (= a b)))", math)).toBe("{p ∧ a ≠ b}");
    expect(read1("{p ∧ a ≠ b}")).toBe(canon("(and p (not (= a b)))"));
  });
  it("a non-comparison (not …) does NOT collapse", () => {
    expect(render("(not (foo a b))", math)).toBe("(not (foo a b))");
    expect(render("(not p)", math)).toBe("(not p)"); // deferred: not → ¬
  });
  it("ascii skin leaves (not (= a b)) uncollapsed", () => {
    expect(render("(not (= a b))")).toBe("(not {a = b})");
  });
});

// ── binary cons → [a b] (list surface; one-way to list on save) ──
describe("binary cons prefers list surface [a b]", () => {
  it("(cons a b) → [a b] (ascii and math)", () => {
    expect(render("(cons a b)")).toBe("[a b]");
    expect(render("(cons a b)", math)).toBe("[a b]");
    expect(render("(cons car cdr)")).toBe("[car cdr]");
  });
  it("one-way: reads back as list, not cons", () => {
    expect(roundtrip("(cons a b)")).toBe(canon("(list a b)"));
  });
  it("nested cons containerizes as nested lists", () => {
    expect(render("(cons a (cons b xs))")).toBe("[a [b xs]]");
  });
  it("cons of a compound keeps the element sugared", () => {
    expect(render("(cons (+ x 1) xs)")).toBe("[{x + 1} xs]");
  });
  // Hand-typed math ∷ still reads as cons (legacy / explicit pair intent).
  it("math ∷ still folds to cons on read", () => {
    expect(read1("{a ∷ b}")).toBe("(cons a b)");
    expect(read1("{x + 1 ∷ xs}")).toBe(canon("(cons (+ x 1) xs)"));
  });
});

// ── math skin: member ∈ / compose ∘ as infix (opt-in, bidirectional) ──
describe("math skin: member ∈ / compose ∘ as infix", () => {
  const cases: Array<[string, string]> = [
    ["(member x xs)", "{x ∈ xs}"],
    ["(compose f g)", "{f ∘ g}"],
    ["(compose f g h)", "{f ∘ g ∘ h}"], // variadic
  ];
  for (const [scheme, out] of cases) {
    it(`${scheme} → ${out}`, () => expect(render(scheme, math)).toBe(out));
    it(`reads ${out} → ${scheme}`, () => expect(read1(out)).toBe(canon(scheme)));
    it(`round-trips ${scheme}`, () => expect(roundtrip(scheme, math)).toBe(canon(scheme)));
  }
  it("ascii skin keeps member/compose prefix", () => {
    expect(render("(member x xs)")).toBe("(member x xs)");
    expect(render("(compose f g)")).toBe("(compose f g)");
  });
});
