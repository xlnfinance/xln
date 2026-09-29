// lower — the scheme → TS lowering. Two proofs:
//   (a) UNIT: the emitted TS string for each lowering rule (application/operator/carrier
//       lists/vector/dict/keyword/lambda/atoms/multi-form).
//   (b) INTEGRATION: harvest a prelude from real tool defs, lower a scheme call against it,
//       and prove a VALID call type-checks clean while a WRONG one (a vector where a list
//       is expected; a string where a number is) BITES. Reuses the in-memory `compileErrors`
//       tsc pattern from prelude.test.ts.
import * as ts from "typescript";
import { describe, expect, it } from "vitest";

import * as z from "../../common/scheme-zod/index.js";
import { symbol } from "../../symbol/index.js";
import { lower } from "../lower.js";
import { assembleHarvestedPrelude } from "../prelude.js";
import { theVoid } from "../../values/primitives/AVoid.js";

/** Type-check `source` as one in-memory file; return the diagnostic messages (empty = clean). */
function compileErrors(source: string): string[] {
  const fileName = "/_virtual.ts";
  const options: ts.CompilerOptions = {
    strict: true,
    target: ts.ScriptTarget.ES2022,
    lib: ["lib.es2022.d.ts"],
    noEmit: true,
    skipLibCheck: true,
  };
  const host = ts.createCompilerHost(options);
  const getSourceFile = host.getSourceFile.bind(host);
  host.getSourceFile = (name, lang, onError, shouldCreate) =>
    name === fileName
      ? ts.createSourceFile(name, source, lang, true)
      : getSourceFile(name, lang, onError, shouldCreate);
  const fileExists = host.fileExists.bind(host);
  host.fileExists = (name) => name === fileName || fileExists(name);
  const readFile = host.readFile.bind(host);
  host.readFile = (name) => (name === fileName ? source : readFile(name));
  const program = ts.createProgram([fileName], options, host);
  return ts.getPreEmitDiagnostics(program).map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n"));
}

const ts1 = (src: string) => lower(src).ts;

/** The bare carrier vocabulary (carriers.ts, including the `s` namespace) as ambient TS —
 *  no harvested tool entries, just the `assembleHarvestedPrelude([]).prelude`'s carrier text. */
const carrierVocabularyText = assembleHarvestedPrelude([]).prelude;

describe("lower — scheme → TS emitter", () => {
  // One row per lowering rule — the emitted TS string for a given scheme source, covering
  // application/operator-escaping/kwargs/car-cdr/list-cons/vector/dict/lambda/atoms/multi-form.
  it.each([
    { name: "application: head + scheme arg order", input: "(foo a b)", expected: "foo(a, b)" },
    { name: "non-identifier head: + operator escapes to _.$plus$", input: "(+ a b)", expected: "_.$plus$(a, b)" },
    {
      name: "non-identifier head: string-append escapes to _.string$dash$append",
      input: "(string-append a b)",
      expected: "_.string$dash$append(a, b)",
    },
    {
      name: "kwargs: a single :keyword value run flips to an object literal",
      input: '(create_user :name "Ada")',
      expected: 'create_user({ name: "Ada" })',
    },
    {
      name: "kwargs: multiple :keyword value pairs flip to an object literal",
      input: '(create_user :name "Ada" :mode "fast")',
      expected: 'create_user({ name: "Ada", mode: "fast" })',
    },
    {
      name: "kwargs: leading positional args stay positional, trailing keywords fold to object",
      input: "(f x :a 1)",
      expected: "f(x, { a: 1 })",
    },
    {
      name: "kwargs: a bare keyword with no value lowers to { key: undefined }",
      input: "(create_user :name)",
      expected: "create_user({ name: undefined })",
    },
    { name: "car is a functional carrier global, not a field read", input: "(car x)", expected: "car(x)" },
    { name: "cdr is a functional carrier global, not a field read", input: "(cdr x)", expected: "cdr(x)" },
    { name: "list lowers to the carrier constructor", input: "(list a b)", expected: "list(a, b)" },
    { name: "cons lowers to the carrier constructor", input: "(cons a b)", expected: "cons(a, b)" },
    { name: "a quoted list lowers to the list carrier constructor", input: "'(a b c)", expected: "list(a, b, c)" },
    { name: "an empty quoted list lowers to list()", input: "'()", expected: "list()" },
    { name: "a vector literal lowers to a native TS array", input: "#(a b c)", expected: "[a, b, c]" },
    {
      name: "a vector literal nested in a call lowers to a native TS array arg",
      input: "(foo #(1 2 3))",
      expected: "foo([1, 2, 3])",
    },
    {
      name: "(dict ...) lowers to an object literal",
      input: '(dict :name "a" :age 30)',
      expected: '{ name: "a", age: 30 }',
    },
    { name: "a keyword-headed read lowers to a bracket field access", input: "(:key obj)", expected: 'obj["key"]' },
    {
      name: "a lambda lowers to a TS arrow function",
      input: "(lambda (x y) (+ x y))",
      expected: "((x, y) => _.$plus$(x, y))",
    },
    { name: "a string atom lowers to its TS string literal", input: '"hi"', expected: '"hi"' },
    { name: "a number atom lowers unchanged", input: "42", expected: "42" },
    { name: "a negative number atom lowers unchanged", input: "-5", expected: "-5" },
    { name: "#t lowers to true", input: "#t", expected: "true" },
    { name: "#f lowers to false", input: "#f", expected: "false" },
    {
      name: "multiple top-level forms become `;\\n`-separated statements",
      input: "(foo 1) (bar 2)",
      expected: "foo(1);\nbar(2)",
    },
  ])("$name", ({ input, expected }) => {
    expect(ts1(input)).toBe(expected);
  });
});

describe("lower — quoted data recurses (the false-positive killer)", () => {
  // One row per quoting shape — proves quoted data recurses at every level and is never
  // mistaken for an application.
  it.each([
    {
      name: "a quoted NESTED list recurses as quoted data, never an application",
      input: '\'(("a" 1))',
      expected: 'list(list("a", 1))',
    },
    { name: "a flat quoted list is unchanged", input: "'(1 2 3)", expected: "list(1, 2, 3)" },
    { name: "a dotted quoted pair lowers to cons", input: "'((k . v))", expected: "list(cons(k, v))" },
    { name: "deep nesting recurses at every level", input: "'((1 (2 3)) 4)", expected: "list(list(1, list(2, 3)), 4)" },
    {
      name: "a multi-element dotted list folds right through the proper elements",
      input: "'(a b . c)",
      expected: "cons(a, cons(b, c))",
    },
  ])("$name", ({ input, expected }) => {
    expect(ts1(input)).toBe(expected);
  });
});

describe("lower — quasiquote degrades to quoted data, unquote stays live", () => {
  // One row per quasiquote/unquote shape.
  it.each([
    {
      name: "a quasiquoted list with no unquote lowers exactly like a quote",
      input: "`(a b c)",
      expected: "list(a, b, c)",
    },
    {
      name: "an (unquote e) node inside emits the LIVE expression, not further-quoted data",
      input: "`(a ,b c)",
      expected: "list(a, b, c)",
    },
    { name: "unquote-splicing also emits the live expression", input: "`(a ,@b c)", expected: "list(a, b, c)" },
    {
      name: "a nested quasiquoted list still recurses as quoted data",
      input: "`((a ,b) c)",
      expected: "list(list(a, b), c)",
    },
    {
      name: "a stray unquote outside a quasiquote stays inert (degrades to the live inner expr)",
      input: ",b",
      expected: "b",
    },
  ])("$name", ({ input, expected }) => {
    expect(ts1(input)).toBe(expected);
  });
});

describe("lower — top-level define lowers to a const statement", () => {
  // One row per define shape.
  it.each([
    { name: "(define x e) → const x = e", input: "(define x 5)", expected: "const x = 5" },
    {
      name: "(define (f a b) body) → const f = (a: any, b: any) => body",
      input: "(define (add2 a b) (+ a b))",
      expected: "const add2 = (a: any, b: any) => _.$plus$(a, b)",
    },
    {
      name: "a multi-form function body folds to a comma sequence, mirroring emitLambda",
      input: "(define (f x) (foo x) (bar x))",
      expected: "const f = (x: any) => (foo(x), bar(x))",
    },
    { name: "a zero-arg function define", input: "(define (f) 1)", expected: "const f = () => 1" },
    { name: "(define x) with no value lowers to undefined", input: "(define x)", expected: "const x = undefined" },
    {
      name: "multiple top-level defines are separate const statements",
      input: "(define x 1) (define y 2)",
      expected: "const x = 1;\nconst y = 2",
    },
    {
      name: "a NESTED define (inside a lambda body) keeps the prior application-call lowering",
      input: "(lambda () (define x 1) x)",
      expected: "(() => (define(x, 1), x))",
    },
  ])("$name", ({ input, expected }) => {
    expect(ts1(input)).toBe(expected);
  });

  it("integration: a defined helper's arity mismatch actually type-checks against real params", () => {
    const errors = compileErrors(`${lower("(define (add2 a b) a) (add2 1)").ts}\n`);
    expect(errors.length).toBeGreaterThan(0);
  });
});

describe("lower — s.* combinators (TS reserved-word forms)", () => {
  // One row per combinator shape.
  it.each([
    { name: "if → s.if(c, a, b)", input: "(if #t 1 2)", expected: "s.if(true, 1, 2)" },
    { name: "if → s.if(c, a) (no else)", input: "(if #t 1)", expected: "s.if(true, 1)" },
    {
      name: "let → s.let(v1, v2, (a, b) => body)",
      input: "(let ((a 1) (b 2)) (+ a b))",
      expected: "s.let(1, 2, (a, b) => _.$plus$(a, b))",
    },
    {
      name: "named let → s.namedLet(v, (loop, i) => body)",
      input: "(let loop ((i 0)) (loop i))",
      expected: "s.namedLet(0, (loop, i) => loop(i))",
    },
    {
      name: "let* → nested s.let calls (sequential scoping)",
      input: "(let* ((a 1) (b a)) b)",
      expected: "s.let(1, (a) => s.let(a, (b) => b))",
    },
    {
      name: "letrec → the same flat emission as let (advisory fidelity)",
      input: "(letrec ((a 1)) a)",
      expected: "s.let(1, (a) => a)",
    },
    {
      name: "letrec* → the same flat emission as let (advisory fidelity)",
      input: "(letrec* ((a 1)) a)",
      expected: "s.let(1, (a) => a)",
    },
    {
      name: "cond → s.cond([test, e], …, [true, d]) — else becomes true",
      input: "(cond (#t 1) (else 2))",
      expected: "s.cond([true, 1], [true, 2])",
    },
    { name: "do → parse-safety only", input: "(do 1 2)", expected: "s.do(1, 2)" },
    {
      name: "case → parse-safety only (shape is incidental)",
      input: "(case x (1 2))",
      expected: "s.case(x, _.$1$(2))",
    },
    {
      name: "a reserved word in ARGUMENT position routes through `_`: for",
      input: "(f for)",
      expected: "f(_.for)",
    },
    {
      name: "a reserved word in ARGUMENT position routes through `_`: class/new/return",
      input: "(f class new return)",
      expected: "f(_.class, _.new, _.return)",
    },
  ])("$name", ({ input, expected }) => {
    expect(ts1(input)).toBe(expected);
  });

  it("integration: (if ...) type-checks and narrows through the carrier `s` namespace", () => {
    const errors = compileErrors(`${carrierVocabularyText}\n${lower("(if #t 1 2)").ts}\n`);
    expect(errors).toEqual([]);
    const narrowed: string = "const _x: number = s.if(true, 1, 2);";
    expect(compileErrors(`${carrierVocabularyText}\n${narrowed}\n`)).toEqual([]);
  });

  it("integration: (let ((a 1)) a) type-checks and infers the bound type", () => {
    const errors = compileErrors(`${carrierVocabularyText}\nconst _x: number = ${lower("(let ((a 1)) a)").ts};\n`);
    expect(errors).toEqual([]);
  });

  it("integration: (cond (#t 1) (else 2)) type-checks", () => {
    const errors = compileErrors(
      `${carrierVocabularyText}\nconst _x: number = ${lower("(cond (#t 1) (else 2))").ts};\n`,
    );
    expect(errors).toEqual([]);
  });
});

describe("lower — integration: lowered call ∩ harvested prelude", () => {
  // get-route takes a proper list (z.list() → List<unknown>) + a string; set-timer takes a
  // number. `z.pair` is cons(value, value) — a dotted-pair codec, not a proper list.
  // `z.union([z.pair, z.nil])` is not "a proper list." z.list() is the actual
  // proper-list constructor (prints List<unknown> via the named-generic pre-check).
  const getRoute = symbol.rosetta`get-route: route between stops`(
    { input: [z.list(), z.string], output: [z.string] },
    () => "",
  );
  const setTimer = symbol.native`set-timer: start a timer`(
    { input: [z.number], output: [z.undefinedResult] },
    // `symbol.native` runs in SCHEME space — z.undefinedResult decodes to `AVoid`, so the
    // impl returns the boxed `theVoid` singleton, never a raw JS `undefined` (matches every
    // production z.undefinedResult native, e.g. env/r7rs/strings.ts's string-for-each).
    () => theVoid,
  );
  const entries = [
    ["get_route", getRoute],
    ["set_timer", setTimer],
  ] as const;

  const compileLowered = (scheme: string): string[] => {
    const { prelude } = assembleHarvestedPrelude(entries);
    return compileErrors(`${prelude}\n${lower(scheme).ts}\n`);
  };

  // One row per call — a VALID call type-checks clean; a mismatched arg (vector where a list
  // is expected, string where a number is) BITES.
  it.each([
    {
      name: "a VALID lowered call type-checks clean against the harvest",
      input: '(set_timer 600)\n(get_route \'("A" "B") "fast")',
      valid: true,
    },
    { name: "a vector where a list is expected BITES", input: '(get_route #(1 2 3) "fast")', valid: false },
    { name: "a string where a number is expected BITES", input: '(set_timer "ten")', valid: false },
  ])("$name", ({ input, valid }) => {
    const errors = compileLowered(input);
    if (valid) {
      expect(errors).toEqual([]);
    } else {
      expect(errors.length).toBeGreaterThan(0);
    }
  });
});

describe("lower — per-statement span-map (additive)", () => {
  it("preserves `{ ts }` verbatim", () => {
    expect(lower("(set_timer 600)").ts).toBe("set_timer(600)");
  });

  it("single statement: one entry, tsRange slices the whole output, schemeSpan covers the form", () => {
    const { ts, statements } = lower("(set_timer 600)");
    expect(statements).toHaveLength(1);
    expect(ts.slice(statements[0]!.tsRange[0], statements[0]!.tsRange[1])).toBe(ts);
    expect(statements[0]!.schemeSpan).toEqual([0, 15]);
  });

  it("multi statement: each tsRange slices its lowered fragment; each schemeSpan slices its source form", () => {
    const scheme = "(set_timer 1) (set_timer 2)";
    const { ts, statements } = lower(scheme);
    expect(statements).toHaveLength(2);
    expect(ts.slice(statements[0]!.tsRange[0], statements[0]!.tsRange[1])).toBe("set_timer(1)");
    expect(ts.slice(statements[1]!.tsRange[0], statements[1]!.tsRange[1])).toBe("set_timer(2)");
    for (const s of statements) {
      expect(scheme.slice(s.schemeSpan[0], s.schemeSpan[1]).trim()).toMatch(/^\(set_timer \d\)$/);
    }
  });

  it("fuses `#(…)` into one statement covering the `#` mark + the list", () => {
    const { statements } = lower("#(1 2 3)");
    expect(statements).toHaveLength(1);
    expect(statements[0]!.schemeSpan).toEqual([0, 8]);
  });
});
