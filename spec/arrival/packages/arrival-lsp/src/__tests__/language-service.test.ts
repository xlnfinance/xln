// language-service — the "Scheme LSP with the TS LSP API" proof.
//
// Verifies the four mirrored methods operate in SCHEME coordinates:
//   • getSemanticDiagnostics — a TS bite lifts onto the right Scheme span; clean → 0.
//   • getQuickInfoAtPosition — hover on a builtin / a let-bound var yields a type.
//   • getCompletionsAtPosition — an operator slot surfaces the builtin names.
// Plus a 5-line `@codemirror/lint` adapter SNIPPET proving the diagnostic shape is
// wireable (no codemirror dep — just the mapping a CodeMirror extension performs).
//
// Per `.claude/rules/tests.md` this is a `__tests__/` verdict (boolean pass/fail).

import { beforeEach, describe, expect, it } from "vitest";

import { assembleHostPrelude } from "../host-prelude.js";
import { createSchemeLanguageService } from "../language-service.js";

let ls: ReturnType<typeof createSchemeLanguageService>;
beforeEach(() => {
  ls = createSchemeLanguageService();
});

describe("getSemanticDiagnostics — bites in Scheme coordinates", () => {
  it("(car 5) → one diagnostic covering the `5` in the SCHEME source", () => {
    const scheme = `(define z (car 5))`;
    const diags = ls.getSemanticDiagnostics(scheme);
    expect(diags).toHaveLength(1);
    const d = diags[0]!;
    // The lifted span must cover the `5` in the SCHEME source (not the emitted TS).
    const fiveAt = scheme.indexOf("5");
    expect(d.start).toBe(fiveAt);
    expect(scheme.slice(d.start, d.start + d.length)).toBe("5");
    expect(d.severity).toBe("error");
    expect(d.code).toBe(2345);
    expect(d.messageText).toContain("not assignable");
    // line/col point at the `5`.
    expect(d.line).toBe(0);
    expect(d.character).toBe(fiveAt);
  });

  it("a clean program → 0 diagnostics", () => {
    const diags = ls.getSemanticDiagnostics(`(define xs (list 1 2 3))\n(car xs)`);
    expect(diags).toHaveLength(0);
  });

  // THE EMPTY BARREL: the compilation's globals are types-only (the lib bundle
  // strips every ambient JS value at generation). A JS global used as a scheme
  // symbol is unresolvable AT THE COMPILATION LEVEL — scheme has no JS
  // environment — and surfaces under the unknown-name policy below.
  it("the JS environment does not exist — (parseInt …) is unresolvable", () => {
    const diags = ls.getSemanticDiagnostics(`(define n (parseInt "3"))`);
    expect(diags.length).toBeGreaterThan(0);
    expect(diags.some((d) => d.messageText.includes("parseInt"))).toBe(true);
  });

  // UNKNOWN-NAME POLICY: until requires resolve across files, an unknown free
  // name is at least as likely an imported binding as a typo → a SUGGESTION
  // (soft mark), named by the SCHEME atom — never the cleanName'd TS twin
  // (`getenvNum`), and never an error-severity cry-wolf on correct code.
  it("unknown free names are scheme-named suggestions, not errors", () => {
    const scheme = `(define x (getenv-num "PORT"))`;
    const diags = ls.getSemanticDiagnostics(scheme);
    expect(diags).toHaveLength(1);
    expect(diags[0]!.severity).toBe("suggestion");
    expect(diags[0]!.messageText).toContain("'getenv-num'");
    expect(diags[0]!.messageText).not.toContain("getenvNum");
  });

  // `(require …)` is an environment directive — nothing to check in-buffer.
  // It used to emit a bare `require(...)` call → a bogus @types/node upsell.
  it("(require …) is a no-op, not an error", () => {
    expect(ls.getSemanticDiagnostics(`(require "lib/util.scm")\n(define x 1)`)).toHaveLength(0);
  });

  // `and`/`or` have leaves (logic.d.ts) — a predicate chain is clean, and the
  // old "Property 'and' does not exist on type 'ArrShape'" leak is gone.
  it("(and …)/(or …) predicate chains type-check clean", () => {
    const scheme = `(define xs (list 1 2 3))\n(define ok (and (not (null? xs)) (or (odd? (car xs)) (even? (car xs)))))`;
    expect(ls.getSemanticDiagnostics(scheme)).toHaveLength(0);
  });

  // The member roster is DERIVED from the merged ArrShape (leaves are the one
  // authored source): a leaf-only name like number->string lowers via __arr
  // and its signature bites — no hand-kept emitter list.
  it("a leaf-only builtin (number->string) is known to the emitter and bites", () => {
    expect(ls.getSemanticDiagnostics(`(define s (number->string 42))`)).toHaveLength(0);
    const bad = ls.getSemanticDiagnostics(`(define s (number->string "x"))`);
    expect(bad).toHaveLength(1);
    expect(bad[0]!.severity).toBe("error");
  });

  it("never surfaces a wrong-positioned (unliftable) diagnostic", () => {
    // Every returned diagnostic must have lifted to a real Scheme span inside the
    // source (the unmapped-prelude drop rule).
    const scheme = `(define z (car 5))`;
    for (const d of ls.getSemanticDiagnostics(scheme)) {
      expect(d.start).toBeGreaterThanOrEqual(0);
      expect(d.start + d.length).toBeLessThanOrEqual(scheme.length);
    }
  });
});

describe("getQuickInfoAtPosition — hover in Scheme coordinates", () => {
  it("cursor on an argument identifier yields its inferred type", () => {
    // `xs` flows through `(list 1 2 3)` → fixed-arity list overloads return a
    // TS tuple (PRE `list.d.ts`: apply-unification), not List<number>.
    // (Argument occurrences ARE token-mapped by `emitTypes`, so the cursor lands
    // precisely; the operator HEAD is not — see the known-gap test below.)
    const scheme = `(define xs (list 1 2 3))\n(car xs)`;
    const xsAt = scheme.lastIndexOf("xs") + 1;
    const info = ls.getQuickInfoAtPosition(scheme, xsAt);
    expect(info).not.toBeNull();
    expect(info!.displayText).toMatch(/\[number,\s*number,\s*number\]|List<number>/);
  });

  it("cursor on a let-bound var (body occurrence) yields its inferred type", () => {
    // The BODY occurrence of `n` is token-mapped; the binder occurrence inside
    // `((n 5))` is not (only the value `5` is) — an emitter-granularity limit.
    const scheme = `(let ((n 5)) (+ n n))`;
    const nBodyAt = scheme.indexOf("n n"); // first body occurrence
    const info = ls.getQuickInfoAtPosition(scheme, nBodyAt);
    expect(info).not.toBeNull();
    // `n` is a `const` bound to the literal `5`, so TS infers the literal type
    // `5` (a subtype of number) — the inferred type is surfaced precisely.
    expect(info!.displayText).toBe("const n: 5");
  });

  // Whole-form mapping: cursor on the operator head `car` in `(car xs)` still
  // projects into the call `car(xs)` (no per-token head span yet). Hover may
  // show the call's return type or the ambient function — either is better than
  // the old `__arr: ArrShape` prefix. Pin that we no longer surface ArrShape.
  it("operator-head hover does not surface retired ArrShape/__arr", () => {
    const scheme = `(define xs (list 1 2 3))\n(car xs)`;
    const carAt = scheme.lastIndexOf("car") + 1;
    const info = ls.getQuickInfoAtPosition(scheme, carAt);
    expect(info?.displayText ?? "").not.toMatch(/ArrShape|__arr/);
  });
});

describe("getCompletionsAtPosition — completions in Scheme coordinates", () => {
  it("returns a non-empty completion set in scope (locals + globals)", () => {
    // At the operator head the current (whole-form) mapping projects into the
    // `__arr` PREFIX, so TS completes the GLOBAL/in-scope set — which includes the
    // local binding `xs`. This proves the map→query→return plumbing is sound.
    const scheme = `(define xs (list 1 2 3))\n(car xs)`;
    const carAt = scheme.lastIndexOf("car") + 1;
    const names = new Set(ls.getCompletionsAtPosition(scheme, carAt).map((e) => e.name));
    expect(names.size).toBeGreaterThan(0);
    // The local binding surfaces (proves scope resolution works through the lens).
    expect(names.has("xs")).toBe(true);
  });

  // The builtin roster merges into EVERY answer (the `__arr[""]` element-access
  // probe — see builtinCompletions). This closed the old "builtin-member
  // completion needs an emitter head mapping" gap from the completion side; the
  // HOVER head gap above still awaits the emitter mapping.
  it("surfaces the builtin roster under real scheme names at any position", () => {
    const scheme = `(car xs)`;
    const carAt = scheme.indexOf("car") + 1;
    const names = new Set(ls.getCompletionsAtPosition(scheme, carAt).map((e) => e.name));
    for (const builtin of ["car", "map", "+", "odd?", "string-append", "max-by"]) {
      expect(names.has(builtin), builtin).toBe(true);
    }
  });

  // Answers are SCHEME vocabulary, not virtual-TS vocabulary: the JS global
  // scope and the lens's own infrastructure are emission substrate (a
  // materialization leak if surfaced) — subtracted via the empty-program
  // baseline. Program-local bindings survive the subtraction.
  it("never leaks the JS environment or lens infrastructure", () => {
    const scheme = `(define xs (list 1 2 3))\n(car xs)`;
    const names = new Set(ls.getCompletionsAtPosition(scheme, scheme.lastIndexOf("car") + 1).map((e) => e.name));
    expect(names.has("xs")).toBe(true); // the program's own binding survives
    for (const leak of ["console", "Array", "Math", "window", "__arr", "sexpr", "Dict", "typeof"]) {
      expect(names.has(leak), leak).toBe(false);
    }
  });

  // INCOMPLETE-PREFIX support: the sampler queries an UNBALANCED prefix mid-generation.
  // `emitTypes` parses complete programs only (parseSexprs throws on an unclosed paren →
  // the whole emit degrades to an empty module → no span at the cursor → empty completions).
  // The cursor-position queries balance the prefix first (closers append at the END, so the
  // cursor offset is unchanged), making them work mid-edit. Before this, all four returned [].
  it("returns completions on an UNBALANCED prefix (the sampler's mid-generation case)", () => {
    for (const prefix of ["(car ", "(filter (lambda (x) (> x ", "(list (ca", "(+ 1 "]) {
      const names = ls.getCompletionsAtPosition(prefix, prefix.length).map((e) => e.name);
      expect(names.length).toBeGreaterThan(0); // was [] (empty emit) before balancing
    }
  });

  it("diagnostics + quick-info don't crash on an unbalanced prefix", () => {
    // (diagnostics path is unbalanced-tolerant via emitTypes' empty-module fallback; the
    // cursor-position paths now balance — neither throws.)
    expect(() => ls.getSemanticDiagnostics("(car ")).not.toThrow();
    expect(() => ls.getQuickInfoAtPosition("(car x", 5)).not.toThrow();
  });

  // BACKPORTING: tsc's own completion list answers in EMITTED terms — `cleanName` (mercury's
  // types-emit.ts) collapses a non-identifier-safe scheme name to a camelCase TS identifier
  // (`config/audience` → `configAudience`) so the lowered program compiles. Left unmapped,
  // that emitted spelling would leak into the completion list and, if selected, insert a name
  // that doesn't exist in scheme. `computeEntries` maps each candidate back through
  // `programDeclaredNames` (populated at the mint site in emitTypes — the transform is
  // lossy/many-to-one, so there is no general inverse function, only a tracked mapping).
  it("backports a slash-bearing define/overridable name to its ORIGINAL scheme spelling, not the emitted camelCase", () => {
    const scheme = `(define/overridable config/audience "string" "people who build web apps")\nconfi`;
    const names = new Set(ls.getCompletionsAtPosition(scheme, scheme.length).map((e) => e.name));
    expect(names.has("config/audience")).toBe(true);
    expect(names.has("configAudience")).toBe(false); // the emitted spelling must NOT leak
  });

  it("backports a plain slash-bearing define the same way", () => {
    const scheme = `(define config/model "qwen3.5-9b")\nconfi`;
    const names = new Set(ls.getCompletionsAtPosition(scheme, scheme.length).map((e) => e.name));
    expect(names.has("config/model")).toBe(true);
    expect(names.has("configModel")).toBe(false);
  });

  it("an already-identifier-safe local is unaffected (fixed point — no spurious rename)", () => {
    const scheme = `(define plain 1)\npla`;
    const names = new Set(ls.getCompletionsAtPosition(scheme, scheme.length).map((e) => e.name));
    expect(names.has("plain")).toBe(true);
  });
});

describe("completion subtraction — exact, not name-greedy", () => {
  // Subtraction keys on `name kind` pairs, not name alone — a program local
  // that collides with a substrate (type-only) name must survive subtraction.
  it("a local shadowing a substrate type name (Array) still completes", () => {
    const scheme = `(define Array (list 1 2))\n(Arr`;
    const names = new Set(ls.getCompletionsAtPosition(scheme, scheme.length).map((e) => e.name));
    expect(names.has("Array")).toBe(true);
  });
});

describe("getCompletionContext — the loop closure (Σ∩T surfaced for humans)", () => {
  const PROG = `(define (greet name) (string-append "hi " name))\n(define names (list "ada" "grace"))\n`;

  it("argument slot: per-candidate verdicts = the sampler's mask, plus the param type", () => {
    const doc = `${PROG}(car `;
    const ctx = ls.getCompletionContext(doc, doc.length);
    expect(ctx.position).toBe("argument");
    expect(ctx.slot).toMatchObject({ argIndex: 0 });
    expect(ctx.slot!.paramType).toContain("List");
    const byName = new Map(ctx.entries.map((e) => [e.name, e]));
    // list producers fit; element/string producers are PROVEN unfit
    expect(byName.get("names")!.fits).toBe(true);
    expect(byName.get("filter")!.fits).toBe(true);
    expect(byName.get("greet")!.fits).toBe(false); // returns a string
    expect(byName.get("odd?")!.fits).toBe(false);
    // real narrowing: a clear majority of the roster is proven out at (car •
    expect(ctx.entries.filter((e) => e.fits === false).length).toBeGreaterThan(ctx.entries.length / 2);
  });

  it("signatures ride along: builtins always, locals from the emitted program", () => {
    const doc = `${PROG}(car `;
    const byName = new Map(ls.getCompletionContext(doc, doc.length).entries.map((e) => [e.name, e]));
    expect(byName.get("car")!.detail).toContain("List");
    expect(byName.get("car")!.callable).toBe(true);
    // Fixed-arity `(list a b)` → `[A, B]` under PRE (list.d.ts apply overloads).
    expect(byName.get("names")!.detail).toMatch(/^\[string,\s*string\]$|^List<string>$/);
    expect(byName.get("names")!.callable).toBe(false);
    expect(byName.get("greet")!.detail).toContain("=> string");
  });

  it("a slash-bearing local's type-preview survives the backport (regression: probeLocalSignatures needs the EMITTED name, not the backported scheme spelling, to probe `typeof <name>`)", () => {
    const doc = `(define config/audience (list "ada" "grace"))\n(car `;
    const byName = new Map(ls.getCompletionContext(doc, doc.length).entries.map((e) => [e.name, e]));
    expect(byName.get("config/audience")).toBeDefined();
    expect(byName.get("config/audience")!.detail).toMatch(/^\[string,\s*string\]$|^List<string>$/);
  });

  it('the backport survives on the VERY FIRST completion request of a fresh service (regression: jsGlobalBaseline\'s one-time loadSource("") probe used to clobber programDeclaredNames before it was ever read)', () => {
    const fresh = createSchemeLanguageService();
    const doc = `(define config/audience (list "ada" "grace"))\nconfi`;
    const names = fresh.getCompletionsAtPosition(doc, doc.length).map((e) => e.name);
    expect(names).toContain("config/audience");
    expect(names).not.toContain("configAudience");
  });

  it("operator position is recognized (Σ's head discrimination), no slot probing", () => {
    const doc = `${PROG}(`;
    const ctx = ls.getCompletionContext(doc, doc.length);
    expect(ctx.position).toBe("operator");
    expect(ctx.slot).toBeUndefined();
    expect(ctx.entries.every((e) => e.fits === undefined)).toBe(true);
  });

  it("a LOCAL callee's slot narrows through INFERRED params (usage-based inference)", () => {
    // greet's param used to be `any` (everything kept, the honest degrade);
    // usage-based inference now reads its body — name flows into
    // string-append's SStr slot — so the param is `string` and the slot
    // gets REAL verdicts. The limitation test flipped into the feature test.
    const doc = `${PROG}(greet `;
    const ctx = ls.getCompletionContext(doc, doc.length);
    expect(ctx.position).toBe("argument");
    expect(ctx.slot).toMatchObject({ callee: "greet", argIndex: 0, paramType: "string" });
    const byName = new Map(ctx.entries.map((e) => [e.name, e]));
    expect(byName.get("names")!.fits).toBe(false); // a List is proven out now
    expect(byName.get("string-append")!.fits).toBe(true); // a string-producer fits
  });
});

describe("getSemanticClassifications — the checker's knowledge, atom-faithful", () => {
  it("classifies use-sites: parameters, locals, functions — single atoms only", () => {
    const scheme = `(define (greet name)\n  (string-append "hello, " name))\n\n(define names (list "a"))\n(define g (greet (car names)))`;
    const spans = ls.getSemanticClassifications(scheme);
    const byText = new Map(spans.map((s) => [scheme.slice(s.start, s.start + s.length), s.kind]));
    expect(byText.get("name")).toBe("parameter"); // the body USE of the lambda param
    expect(byText.get("names")).toBe("variable"); // a local's use-site
    expect(byText.get("greet")).toBe("function"); // a local function at its call
    for (const s of spans) {
      const text = scheme.slice(s.start, s.start + s.length);
      // Every span is a single atom (the whole-form binder lifts are dropped)
      // and never the emission infrastructure.
      expect(text).toMatch(/^[\w\-!$%&*+./<=>?@^~:]+$/);
      expect(text.startsWith("__")).toBe(false);
    }
  });
});

describe("getTypeValidCandidates — Layer T, the type-narrowed mask", () => {
  // The candidate pool the sampler's Σ would offer at the cursor; T narrows it to the type-valid.
  const POOL = ["car", "cdr", "filter", "map", "list", "cons", "not", "length"];

  it("an argument slot keeps only candidates whose value/return type fits the parameter", () => {
    // (car ⟨cur⟩) wants a List → list-PRODUCERS survive; element/number/bool ones are dropped.
    const carArg = new Set(ls.getTypeValidCandidates("(car ", 5, POOL));
    expect(carArg.has("list")).toBe(true);
    expect(carArg.has("filter")).toBe(true); // filter returns a list
    expect(carArg.has("car")).toBe(false); // car returns an element, not a list
    expect(carArg.has("length")).toBe(false); // returns a number
    expect(carArg.has("not")).toBe(false); // returns a bool

    // (+ 1 ⟨cur⟩) wants a number → only the number-producer.
    const plusArg = new Set(ls.getTypeValidCandidates("(+ 1 ", 5, POOL));
    expect(plusArg.has("length")).toBe(true);
    expect(plusArg.has("list")).toBe(false);
    expect(plusArg.has("car")).toBe(false);

    // (filter ⟨cur⟩ …) arg0 wants a predicate (x)=>bool → only the predicate-shaped builtin.
    const predArg = new Set(ls.getTypeValidCandidates("(filter ", 8, POOL));
    expect(predArg.has("not")).toBe(true);
    expect(predArg.has("list")).toBe(false);
  });

  it("narrows a FULL-ROSTER pool without truncation loss (the typeToString cutoff bug)", () => {
    // Element-wise checker reads narrow the whole pool, tail included — reading the
    // probe as a single tuple via typeToString truncates past ~160 chars, which
    // would silently keep every candidate beyond the cutoff.
    const pool = ls.getCompletionsAtPosition("(car ", 5).map((e) => e.name);
    expect(pool.length).toBeGreaterThan(50); // the full roster reaches the probe
    const narrowed = new Set(ls.getTypeValidCandidates("(car ", 5, pool));
    expect(narrowed.size).toBeLessThan(pool.length / 2); // real narrowing happened
    expect(narrowed.has("list")).toBe(true); // a list-producer survives
    expect(narrowed.has("odd?")).toBe(false); // a bool-producer in the TAIL is dropped
    expect(narrowed.has("string-append")).toBe(false); // a string-producer is dropped
  });

  it("does NOT narrow at a non-argument position (operator slot / top) — Σ owns operators", () => {
    expect(new Set(ls.getTypeValidCandidates("(", 1, POOL)).size).toBe(POOL.length);
    expect(new Set(ls.getTypeValidCandidates("", 0, POOL)).size).toBe(POOL.length);
  });

  it("conservatively KEEPS an unresolved candidate (a local / un-declared tool) — never a false drop", () => {
    // `netscan` is not in the bare prelude's ArrShape ⇒ unresolved ⇒ kept at every slot.
    const valid = ls.getTypeValidCandidates("(+ 1 ", 5, ["netscan", "length", "list"]);
    expect(valid).toContain("netscan"); // unresolved → kept
    expect(valid).toContain("length"); // number-producer → kept
    expect(valid).not.toContain("list"); // proven non-number → dropped
  });

  it("empty candidate set + unbalanced prefix don't crash", () => {
    expect(ls.getTypeValidCandidates("(car ", 5, [])).toEqual([]);
    expect(() => ls.getTypeValidCandidates("(filter (lambda (x) (> x ", 25, POOL)).not.toThrow();
  });
});

// ── Layer T, the LITERAL case: a quoted string at a string-literal-union slot ──
// The shipping BFCL-typed path emits enum members as BOUND TYPED value-symbols
// (`celsius: T_unit`), which already narrow (`typeof celsius` resolves
// to the union). This block covers the OTHER shape: a raw quoted string `"thai"`
// at a literal-union param. Before the fix it degraded to `typeof
// __arr["\"thai\""]` = any ⇒ every literal survived (wrong-enum + non-member
// both kept). The fix interpolates a string-literal candidate AS the literal
// type (`["thai"] extends [Cuisine]`) at the SAME scanner offset — additively,
// without touching the callable/value path above.
describe("getTypeValidCandidates — Layer T, the string-literal narrowing", () => {
  // A realistic typed prelude: `book_table`'s cuisine is a string-literal union;
  // `note_table`/`count_table` are free-form (the never-wrong control slots).
  const host = assembleHostPrelude(
    [
      ["book_table", "(cuisine: T_book_cuisine): SStr"],
      ["plan_meals", "(diets: T_plan_diets[]): SStr"], // array-of-union slot
      ["note_table", "(note: string): SStr"], // free-form string
      ["count_table", "(n: number): SStr"], // free-form number
      // bound typed value-symbols (the production path — must keep narrowing)
      ["thai", ": T_book_cuisine"],
      ["italian", ": T_book_cuisine"],
      ["mexican", ": T_book_cuisine"],
    ],
    { preamble: `type T_book_cuisine = "thai" | "italian" | "mexican";\ntype T_plan_diets = "vegan" | "keto";` },
  );
  const lit = createSchemeLanguageService({ host });
  const at = (scheme: string, cands: string[]) =>
    new Set(lit.getTypeValidCandidates(scheme, "(book_table ".length, cands));

  it("a quoted-string enum slot keeps only string-literal MEMBERS (wrong-enum + non-member dropped)", () => {
    // POOL = valid members + a wrong-enum value + a total non-member.
    const v = at("(book_table )", ['"thai"', '"italian"', '"vegan"', '"nonsense"']);
    expect(v).toEqual(new Set(['"thai"', '"italian"'])); // "vegan" (wrong enum) + "nonsense" both rejected
  });

  it("a keyword-VALUE enum (bound typed value-symbols) narrows the same — production path unregressed", () => {
    const v = at("(book_table )", ["thai", "italian", "mexican"]);
    expect(v).toEqual(new Set(["thai", "italian", "mexican"])); // all three are members of T_book_cuisine
    // a wrong-domain bound symbol is dropped (already true pre-fix; guard it)
    const lits = at("(book_table )", ['"thai"', "thai"]); // literal + bound symbol of the SAME value
    expect(lits).toEqual(new Set(['"thai"', "thai"]));
  });

  it("a free-form `string` slot KEEPS an arbitrary literal (never-wrong restriction)", () => {
    const v = new Set(
      lit.getTypeValidCandidates("(note_table )", "(note_table ".length, ['"anything at all"', '"thai"']),
    );
    expect(v).toEqual(new Set(['"anything at all"', '"thai"'])); // string slot → any literal fits
  });

  it("a `number` slot KEEPS a number literal (never-wrong restriction)", () => {
    const v = new Set(lit.getTypeValidCandidates("(count_table )", "(count_table ".length, ["42", "7"]));
    expect(v).toEqual(new Set(["42", "7"])); // 42 is not string-shaped → conservative typeof path → kept
  });

  it("an unresolved enum slot keeps every literal (error-any __E → no wrong restriction)", () => {
    // `unknown_tool` has no declaration → __E is error-any → tri-state keeps all.
    const v = new Set(lit.getTypeValidCandidates("(unknown_tool )", "(unknown_tool ".length, ['"thai"', '"nonsense"']));
    expect(v).toEqual(new Set(['"thai"', '"nonsense"']));
  });
});

describe("getDefinitionAtPosition — go-to-def lifts back to Scheme", () => {
  it("a reference to a defined var resolves to its definition span in Scheme", () => {
    const scheme = `(define xs (list 1 2 3))\n(car xs)`;
    const useAt = scheme.lastIndexOf("xs") + 1;
    const defs = ls.getDefinitionAtPosition(scheme, useAt);
    expect(defs.length).toBeGreaterThan(0);
    // The definition lifts to a non-null Scheme span. (With current mappings the
    // binder token isn't individually mapped, so the def lifts to the enclosing
    // `(define xs …)` form — coarse but correct: it covers the binding site.)
    const withSpan = defs.find((d) => d.span !== null);
    expect(withSpan).toBeDefined();
    const defAt = scheme.indexOf("(define");
    expect(withSpan!.span!.start).toBe(defAt);
    // The span covers the `xs` binding occurrence.
    const bindAt = scheme.indexOf("xs");
    expect(withSpan!.span!.start).toBeLessThanOrEqual(bindAt);
    expect(withSpan!.span!.start + withSpan!.span!.length).toBeGreaterThan(bindAt);
  });
});

// ── CodeMirror-shape smoke ────────────────────────────────────────────────────
// PROOF the SchemeDiagnostic shape is wireable into `@codemirror/lint` — the
// adapter a CodeMirror extension writes is exactly this 5-line map (no codemirror
// dep added; this is the structural proof, not a live binding):
//
//   import { linter, type Diagnostic } from "@codemirror/lint";
//   const schemeLinter = linter((view): Diagnostic[] =>
//     ls.getSemanticDiagnostics(view.state.doc.toString()).map((d) => ({
//       from: d.start,
//       to: d.start + d.length,
//       severity: d.severity === "suggestion" ? "info" : d.severity, // CM: error|warning|info
//       message: d.messageText,
//     })));
//
describe("CodeMirror @codemirror/lint adapter shape", () => {
  it("a SchemeDiagnostic maps 1:1 onto a {from,to,severity,message} Diagnostic", () => {
    const diags = ls.getSemanticDiagnostics(`(define z (car 5))`);
    const cmDiagnostics = diags.map((d) => ({
      from: d.start,
      to: d.start + d.length,
      severity: d.severity === "suggestion" ? "info" : d.severity,
      message: d.messageText,
    }));
    expect(cmDiagnostics).toHaveLength(1);
    expect(cmDiagnostics[0]).toMatchObject({
      from: expect.any(Number),
      to: expect.any(Number),
      severity: "error",
      message: expect.stringContaining("not assignable"),
    });
    expect(cmDiagnostics[0]!.to).toBeGreaterThan(cmDiagnostics[0]!.from);
  });
});
