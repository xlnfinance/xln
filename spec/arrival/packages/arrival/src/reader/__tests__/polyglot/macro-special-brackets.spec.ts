import { describe, expect, it } from "vitest";
import { readAst, evalJson, evalError, errorClass, errorHint } from "./_harness.js";

describe("macro-special-brackets / […] as special-form syntax", () => {
  describe("let / let* / named-let / letrec", () => {
    // POSITIVE — read: input parses to canonical AST
    it.each([
      {
        name: "y_bracket_whole_list_reads_as_vector",
        input: "(let [a 1 b 2] (+ a b))",
        ast: "(let [a 1 b 2] (+ a b))",
      },
      {
        name: "y_bracket_per_element_reads_as_list_of_vectors",
        input: "(let* ([a 1] [b 2]) b)",
        ast: "(let* ([a 1] [b 2]) b)",
      },
      {
        name: "y_quote_let_bracket_binding_is_plain_vector",
        input: "(quote (let [a 1] a))",
        ast: "(quote (let [a 1] a))",
      },
      {
        name: "y_quote_reader_macro_let_bracket",
        input: "'(let [a 1] a)",
        ast: "(quote (let [a 1] a))",
      },
      {
        name: "y_named_let_bracket_reads",
        input: "(let loop [i 0] (loop))",
        ast: "(let loop [i 0] (loop))",
      },
      {
        name: "y_mixed_paren_and_bracket_reads",
        input: "(let ([a 1] (b 2)) x)",
        ast: "(let ([a 1] (b 2)) x)",
      },
    ])("read · $name", async ({ input, ast }) => {
      expect(await readAst(input)).toBe(ast);
    });

    // POSITIVE — eval: input evaluates to value
    it.each([
      { name: "y_let_whole_list_bracket_binds", input: "(let [a 1 b 2] (+ a b))", value: 3 },
      { name: "y_letstar_per_element_bracket_sequential", input: "(let* ([a 1] [b (+ a 1)]) b)", value: 2 },
      {
        name: "y_named_let_per_element_bracket_recurses",
        input: "(let loop ([i 0] [acc 0]) (if (= i 5) acc (loop (+ i 1) (+ acc i))))",
        value: 10,
      },
      {
        name: "y_named_let_whole_list_bracket_clojure",
        input: "(let loop [i 0] (if (= i 3) i (loop (+ i 1))))",
        value: 3,
      },
      { name: "y_mixed_paren_bracket_bindings", input: "(let ([a 1] (b 2)) (+ a b))", value: 3 },
      { name: "y_bracket_binding_shadowing", input: "(let [a 1] (let [a 2] a))", value: 2 },
      {
        name: "y_bracket_binding_closure_value",
        input: "((let ([f (lambda (x) (* x 2))]) f) 21)",
        value: 42,
      },
      {
        name: "y_letrec_bracket_mutual_recursion",
        input:
          "(letrec ([ev? (lambda (n) (if (= n 0) #t (od? (- n 1))))] [od? (lambda (n) (if (= n 0) #f (ev? (- n 1))))]) (ev? 10))",
        value: true,
      },
      {
        name: "y_bracket_equals_paren_image",
        input: "(equal? (let ([a 1] [b 2]) (+ a b)) (let ((a 1) (b 2)) (+ a b)))",
        value: true,
      },
      {
        name: "y_quoted_bracket_let_binding_slot_is_datum",
        input: "(vector-ref (car (cdr (quote (let [a 1] a)))) 0)",
        value: { $sym: "a" },
      },
    ])("eval · $name", async ({ input, value }) => {
      expect(await evalJson(input)).toEqual(value);
    });

    // DOORS — individual it() per door: these are distinct teaching contracts, not a
    // homogeneous corpus. Bracket doors are eval-time (the reader accepts every balanced
    // bracket as data — it lacks the special-form frame to guess intent), so each asserts
    // BOTH faces: `code` (which door / routing) and `hint` (the corrected form it teaches —
    // a string when unambiguous, a list when ≥2 clear readings, absent when there's no
    // single shape to suggest).
    it("door E-LET-BRACKET-BINDINGS-LIST · odd whole-list arity teaches both fixes", async () => {
      const err = await evalError("(let [a 1 b] a)");
      expect(err, "expected E-LET-BRACKET-BINDINGS-LIST, but eval succeeded").toBeDefined();
      expect(errorClass(err)).toBe("E-LET-BRACKET-BINDINGS-LIST");
      expect(errorHint(err)).toEqual(["[a 1 b <value>]", "(a 1) (b <value>)"]);
    });

    it("door E-LET-BRACKET-BINDING · per-element wrong length teaches the paren pair", async () => {
      const err = await evalError("(let ([a 1 2]) a)");
      expect(err, "expected E-LET-BRACKET-BINDING, but eval succeeded").toBeDefined();
      expect(errorClass(err)).toBe("E-LET-BRACKET-BINDING");
      expect(errorHint(err)).toEqual("(a 1 2)");
    });

    // Destructuring is an unsupported FORM, not a typo — the door routes (code) with no hint,
    // since there's no single corrected shape to teach.
    it("door E-LET-BRACKET-BINDING · destructuring name slot routes without a hint", async () => {
      const err = await evalError("(let ([[a b] 1]) a)");
      expect(err, "expected E-LET-BRACKET-BINDING, but eval succeeded").toBeDefined();
      expect(errorClass(err)).toBe("E-LET-BRACKET-BINDING");
      expect(errorHint(err)).toBeUndefined();
    });
  });

  describe("do — bracket steps", () => {
    // POSITIVE — read: input parses to canonical AST
    it.each([
      {
        name: "y_do_bracket_step_reads",
        input: "(do ([i 0 (+ i 1)]) (= i 3) i)",
        ast: "(do ([i 0 (+ i 1)]) (= i 3) i)",
      },
    ])("read · $name", async ({ input, ast }) => {
      expect(await readAst(input)).toBe(ast);
    });

    // POSITIVE — eval: input evaluates to value
    it.each([
      {
        name: "y_do_per_element_bracket_steps",
        input: "(do ([i 0 (+ i 1)] [s 0 (+ s i)]) (= i 3) s)",
        value: 3,
      },
    ])("eval · $name", async ({ input, value }) => {
      expect(await evalJson(input)).toEqual(value);
    });

    // DOORS — `do` excludes the whole-list form (BG2a): its 3-element steps make pairwise
    // grouping ambiguous, so the door teaches the paren-pairs form instead.
    it("door E-LET-BRACKET-BINDINGS-LIST · do rejects whole-list, teaches paren pairs", async () => {
      const err = await evalError("(do [i 0 (+ i 1)] (= i 3) i)");
      expect(err, "expected E-LET-BRACKET-BINDINGS-LIST, but eval succeeded").toBeDefined();
      expect(errorClass(err)).toBe("E-LET-BRACKET-BINDINGS-LIST");
      expect(errorHint(err)).toEqual("((i 0) (+ i 1))");
    });
  });

  describe("cond / case / do clauses", () => {
    // POSITIVE — read: input parses to canonical AST
    it.each([
      {
        name: "y_cond_bracket_clause_reads_as_vector",
        input: '(cond [(> x 1) "a"] [else "b"])',
        ast: '(cond [(> x 1) "a"] [else "b"])',
      },
      {
        name: "y_case_bracket_clause_reads_as_vector_datum_list_stays_list",
        input: '(case k [(1 2) "low"] [else "hi"])',
        ast: '(case k [(1 2) "low"] [else "hi"])',
      },
      {
        name: "y_do_bracket_test_clause_reads_as_vector",
        input: "(do ((i 0 (+ i 1))) [(= i n) acc])",
        ast: "(do ((i 0 (+ i 1))) [(= i n) acc])",
      },
      {
        name: "y_quote_cond_bracket_clause_is_plain_vector",
        input: "(quote (cond [#t 1]))",
        ast: "(quote (cond [#t 1]))",
      },
    ])("read · $name", async ({ input, ast }) => {
      expect(await readAst(input)).toBe(ast);
    });

    // POSITIVE — eval: input evaluates to value
    it.each([
      {
        name: "y_cond_bracket_test_matches",
        input: '(cond [(> 2 1) "a"] [else "b"])',
        value: "a",
      },
      {
        name: "y_cond_bracket_else_matches",
        input: '(cond [#f "a"] [else "b"])',
        value: "b",
      },
      {
        name: "y_cond_bracket_arrow_clause",
        input: "(cond [(+ 1 2) => (lambda (x) (* x 10))])",
        value: 30,
      },
      {
        name: "y_case_bracket_datum_list_matches",
        input: '(case 1 [(1 2) "low"] [else "hi"])',
        value: "low",
      },
      {
        name: "y_case_bracket_else_matches",
        input: '(case 99 [(1 2) "low"] [else "hi"])',
        value: "hi",
      },
      {
        name: "y_case_bracket_arrow_clause",
        input: "(case 2 [(1 2) => (lambda (x) (* x 100))] [else 0])",
        value: 200,
      },
      {
        name: "y_do_bracket_test_clause",
        input: "(do ((i 0 (+ i 1))) [(= i 3) i])",
        value: 3,
      },
      {
        name: "y_do_bracket_binding_and_test_clause_compose",
        input: "(do ([i 0 (+ i 1)]) [(= i 3) i])",
        value: 3,
      },
      {
        name: "y_nested_cond_bracket_clause_with_bracket_let_binding",
        input: "(cond [#t (let [a 1] a)])",
        value: 1,
      },
      {
        name: "y_cond_bracket_equals_paren_image",
        input: '(equal? (cond [(> 2 1) "a"]) (cond ((> 2 1) "a")))',
        value: true,
      },
    ])("eval · $name", async ({ input, value }) => {
      expect(await evalJson(input)).toEqual(value);
    });

    // DOORS — the empty bracket clause `[]` shares code E-COND-BRACKET-CLAUSE across
    // cond/case/do. `case` genuinely has two clause shapes (datum-list clause vs `else`), so
    // its hint is a list; cond/do have the single `[test expr…]` shape.
    it("door E-COND-BRACKET-CLAUSE · cond empty clause teaches [test expr…]", async () => {
      const err = await evalError("(cond [])");
      expect(err, "expected E-COND-BRACKET-CLAUSE, but eval succeeded").toBeDefined();
      expect(errorClass(err)).toBe("E-COND-BRACKET-CLAUSE");
      expect(errorHint(err)).toEqual("[test expr…]");
    });

    it("door E-COND-BRACKET-CLAUSE · case empty clause teaches both clause shapes", async () => {
      const err = await evalError("(case 1 [])");
      expect(err, "expected E-COND-BRACKET-CLAUSE, but eval succeeded").toBeDefined();
      expect(errorClass(err)).toBe("E-COND-BRACKET-CLAUSE");
      expect(errorHint(err)).toEqual(["[(datum…) expr…]", "[else expr…]"]);
    });

    it("door E-COND-BRACKET-CLAUSE · do empty test clause teaches [test expr…]", async () => {
      const err = await evalError("(do ((i 0)) [])");
      expect(err, "expected E-COND-BRACKET-CLAUSE, but eval succeeded").toBeDefined();
      expect(errorClass(err)).toBe("E-COND-BRACKET-CLAUSE");
      expect(errorHint(err)).toEqual("[test expr…]");
    });

    it("door E-CASE-BRACKET-DATUM-LIST · vector datum-list head teaches the paren list", async () => {
      const err = await evalError('(case 1 [[1 2] "low"])');
      expect(err, "expected E-CASE-BRACKET-DATUM-LIST, but eval succeeded").toBeDefined();
      expect(errorClass(err)).toBe("E-CASE-BRACKET-DATUM-LIST");
      expect(errorHint(err)).toEqual("(1 2)");
    });
  });
});
