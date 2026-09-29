import { describe, expect, it } from "vitest";
import { readAst, evalJson, errorClass } from "./_harness.js";

describe("vector-bracket / […] vectors", () => {
  // POSITIVE — read: input parses to canonical AST
  it.each([
    { name: "y_vector_basic", input: "[a b]", ast: "[a b]" },
    { name: "y_vector_empty", input: "[]", ast: "[]" },
    { name: "y_vector_elements_are_forms", input: "[1 (+ 1 1) 3]", ast: "[1 (+ 1 1) 3]" },
    { name: "y_vector_nested_dict", input: "[{:a 1}]", ast: "[{:a 1}]" },
    { name: "y_vector_comma_separators", input: "[1, 2, 3]", ast: "[1 2 3]" },
    { name: "y_vector_trailing_comma", input: "[1, 2,]", ast: "[1 2]" },
    { name: "y_vector_separator_absorbs_one_comma", input: "[a ,b]", ast: "[a b]" },
    { name: "y_vector_second_comma_is_unquote", input: "[a ,,b]", ast: "[a (unquote b)]" },
    { name: "y_vector_leading_comma_is_unquote", input: "[,a]", ast: "[(unquote a)]" },
    { name: "y_vector_unquote_splicing_never_separator", input: "[1 ,@xs]", ast: "[1 (unquote-splicing xs)]" },
    { name: "y_quote_vector_stays_data", input: "'[a b]", ast: "(quote [a b])" },
    { name: "y_bracket_pair_reads_as_vector", input: "[a 1]", ast: "[a 1]" },
  ])("read · $name", async ({ input, ast }) => {
    expect(await readAst(input)).toBe(ast);
  });

  // POSITIVE — eval: input evaluates to value
  it.each([
    { name: "y_vector_elements_evaluate", input: "[1 (+ 1 1) 3]", value: [1, 2, 3] },
    { name: "y_vector_equals_vector_call", input: "(equal? [1 2] (vector 1 2))", value: true },
    { name: "y_vector_is_vector", input: "(vector? [1 2])", value: true },
    { name: "y_quote_vector_data", input: "(vector-ref '[a b] 0)", value: { $sym: "a" } },
    { name: "y_empty_vector", input: "[]", value: [] },
    { name: "y_quasiquote_vector_splicing", input: "(vector-ref `[1 ,@(list 2 3) 4] 2)", value: 3 },
    { name: "i_quasiquote_vector_comma_absorbed", input: "(vector-ref `[1 ,x] 1)", value: { $sym: "x" } },
    { name: "y_bracket_init_value_is_data_not_binding", input: "(let ((a [1 2 3])) (vector-length a))", value: 3 },
    { name: "y_bracket_in_body_is_data", input: "(let ((a 1)) (vector-length [a a a]))", value: 3 },
  ])("eval · $name", async ({ input, value }) => {
    expect(await evalJson(input)).toEqual(value);
  });

  // DOORS — one it.each per error code; each block lists only the edge cases
  // that trigger that specific door. `mode` dispatches read vs eval per row
  // since some codes have members of both.

  it.each([{ name: "n_vector_dot", input: "[a . b]", mode: "read" as const }])(
    "door E-LITERAL-DOT · $name",
    async ({ input, mode }) => {
      let err: unknown;
      try {
        mode === "read" ? await readAst(input) : await evalJson(input);
      } catch (e) {
        err = e;
      }
      expect(err, "expected E-LITERAL-DOT, but succeeded").toBeDefined();
      expect(errorClass(err)).toBe("E-LITERAL-DOT");
    },
  );

  it.each([{ name: "n_vector_unterminated", input: "[1 2", mode: "read" as const }])(
    "door E-UNTERMINATED · $name",
    async ({ input, mode }) => {
      let err: unknown;
      try {
        mode === "read" ? await readAst(input) : await evalJson(input);
      } catch (e) {
        err = e;
      }
      expect(err, "expected E-UNTERMINATED, but succeeded").toBeDefined();
      expect(errorClass(err)).toBe("E-UNTERMINATED");
    },
  );

  it.each([{ name: "n_stray_square_close", input: "]", mode: "read" as const }])(
    "door E-BRACKET-UNEXPECTED · $name",
    async ({ input, mode }) => {
      let err: unknown;
      try {
        mode === "read" ? await readAst(input) : await evalJson(input);
      } catch (e) {
        err = e;
      }
      expect(err, "expected E-BRACKET-UNEXPECTED, but succeeded").toBeDefined();
      expect(errorClass(err)).toBe("E-BRACKET-UNEXPECTED");
    },
  );

  it.each([
    { name: "n_bracket_mismatch_paren_closed_square", input: "(a]", mode: "read" as const },
    { name: "n_bracket_mismatch_square_closed_paren", input: "[a)", mode: "read" as const },
  ])("door E-BRACKET-MISMATCH · $name", async ({ input, mode }) => {
    let err: unknown;
    try {
      mode === "read" ? await readAst(input) : await evalJson(input);
    } catch (e) {
      err = e;
    }
    expect(err, "expected E-BRACKET-MISMATCH, but succeeded").toBeDefined();
    expect(errorClass(err)).toBe("E-BRACKET-MISMATCH");
  });
});
