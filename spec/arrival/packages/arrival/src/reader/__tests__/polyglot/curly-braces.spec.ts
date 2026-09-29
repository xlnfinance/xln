// Focused, hand-written grammar suite for `{…}` dict literals — inline it.each
// tables, originally extracted from the retired spec/corpus JSONL records of
// the same names. See _harness.ts for the shared read/eval/error-class
// helpers, and this directory's README for the AST canonicalization + error
// taxonomy conventions these tables follow.
import { describe, expect, it } from "vitest";
import { errorClass, evalJson, readAst } from "./_harness.js";

describe("curly-braces / {…} dict literals", () => {
  // POSITIVE — read: input parses to canonical AST
  it.each([
    { name: "y_vector_nested_dict", input: "[{:a 1}]", ast: "[{:a 1}]" },
    { name: "y_dict_keyword_keys", input: "{:a 1 :b 2}", ast: "{:a 1 :b 2}" },
    { name: "y_dict_empty", input: "{}", ast: "{}" },
    { name: "y_dict_comma_separated", input: "{:a 1, :b 2}", ast: "{:a 1 :b 2}" },
    { name: "y_dict_trailing_comma", input: "{:a 1,}", ast: "{:a 1}" },
    { name: "y_dict_string_key", input: '{"a" 1}', ast: '{"a" 1}' },
    { name: "y_dict_mixed_keys", input: '{:a 1 "b" 2}', ast: '{:a 1 "b" 2}' },
    { name: "y_dict_odd_boundary_comma_is_unquote", input: "{:a ,x}", ast: "{:a (unquote x)}" },
    { name: "y_dict_unquote_key_after_separator", input: "{:a 1,,k v}", ast: "{:a 1 (unquote k) v}" },
    {
      name: "y_dict_canonical_mixed_comma_roles",
      input: "{:a ,quoted,,anotherQuoted ,quotedValue}",
      ast: "{:a (unquote quoted) (unquote anotherQuoted) (unquote quotedValue)}",
    },
    { name: "y_quote_dict_stays_data", input: "'{:a (f x)}", ast: "(quote {:a (f x)})" },
    { name: "y_dict_value_vector_nested", input: "{:a [1 2]}", ast: "{:a [1 2]}" },
    { name: "y_dict_suffix_key_flip", input: '{flight_number: "X"}', ast: '{:flight_number "X"}' },
    { name: "y_dict_suffix_mixed_with_prefix", input: "{:a 1 b: 2}", ast: "{:a 1 :b 2}" },
    {
      name: "y_dict_suffix_nested_in_vector_airline",
      input: '[{flight_number: "HAT136", date: "2024-05-20"}]',
      ast: '[{:flight_number "HAT136" :date "2024-05-20"}]',
    },
    { name: "y_quote_dict_suffix_key_flips_too", input: "'{a: 1}", ast: "(quote {:a 1})" },
    { name: "y_dict_string_key_json_colon", input: '{"a": 1}', ast: '{"a" 1}' },
    { name: "i_dict_glued_string_colon_reads_keyword_value", input: '{"a":1}', ast: '{"a" :1}' },
  ])("read · $name", async ({ input, ast }) => {
    expect(await readAst(input)).toBe(ast);
  });

  // POSITIVE — eval: input evaluates to value
  it.each([
    { name: "y_dict_values_evaluate", input: "(:a {:a (+ 1 2)})", value: 3 },
    { name: "y_nested_call_element_model_shape", input: "(:a (vector-ref [{:a (+ 20 22)}] 0))", value: 42 },
    { name: "y_quote_dict_value_is_raw_form", input: "(car (:a '{:a (f x)}))", value: { $sym: "f" } },
    { name: "y_string_key_reads_like_keyword", input: '(:x {"x" 5})', value: 5 },
    { name: "y_comma_separated_pairs", input: "(:b {:a 1, :b 2})", value: 2 },
    { name: "y_empty_dict_missing_key_nil", input: "(:missing {})", value: null },
    { name: "y_dict_whole_value", input: "{:a 1 :b (+ 1 1)}", value: { a: 1, b: 2 } },
    { name: "y_quasiquote_dict_template_unquote_value", input: "(:a `{:a ,(+ 1 2)})", value: 3 },
    { name: "y_quasiquote_dict_template_unquote_key", input: '(:k `{:a 1, "k" 2})', value: 2 },
    {
      name: "y_dict_suffix_key_evals",
      input: '(:flight_number {flight_number: "HAT136"})',
      value: "HAT136",
    },
    { name: "y_dict_suffix_mixed_evals", input: "(:b {:a 1 b: (+ 1 1)})", value: 2 },
    {
      name: "y_dict_suffix_airline_shape_evals",
      input: '(:date (vector-ref [{flight_number: "HAT136", date: "2024-05-20"}] 0))',
      value: "2024-05-20",
    },
    { name: "y_dict_string_key_json_colon_evals", input: '(:a {"a": 1})', value: 1 },
  ])("eval · $input", async ({ input, value }) => {
    expect(await evalJson(input)).toEqual(value);
  });

  // DOORS — one it.each per error code; each block lists only the edge cases
  // that trigger that specific door. `mode` dispatches read vs eval per row
  // since some codes have members of both.

  it.each([
    { name: "n_dict_odd_arity", input: "{:a}", mode: "read" },
    { name: "n_dict_odd_arity_missing_value", input: "{:a 1 :b}", mode: "read" },
  ])("door E-DICT-ODD-ARITY · $name", async ({ input, mode }) => {
    let err: unknown;
    try {
      mode === "read" ? await readAst(input) : await evalJson(input);
    } catch (e) {
      err = e;
    }
    expect(err, "expected E-DICT-ODD-ARITY, but succeeded").toBeDefined();
    expect(errorClass(err)).toBe("E-DICT-ODD-ARITY");
  });

  it.each([
    { name: "n_dict_bad_key_number", input: "{1 2}", mode: "read" },
    { name: "n_dict_bad_key_bare_symbol", input: "{a 1}", mode: "read" },
    { name: "n_dict_suffix_double_colon_bad_key", input: "{a:: 1}", mode: "read" },
    { name: "i_dict_glued_colon_key_teaching_door", input: "{a:1}", mode: "read" },
    { name: "n_quasiquote_bad_key_post_substitution", input: "`{,(list 1 2) 3}", mode: "eval" },
  ])("door E-DICT-BAD-KEY · $name", async ({ input, mode }) => {
    let err: unknown;
    try {
      mode === "read" ? await readAst(input) : await evalJson(input);
    } catch (e) {
      err = e;
    }
    expect(err, "expected E-DICT-BAD-KEY, but succeeded").toBeDefined();
    expect(errorClass(err)).toBe("E-DICT-BAD-KEY");
  });

  it.each([
    { name: "n_dict_dup_key", input: "{:a 1 :a 2}", mode: "read" },
    { name: "n_dict_dup_key_mixed_styles", input: '{:a 1 "a" 2}', mode: "read" },
    { name: "n_dict_dup_key_prefix_and_suffix", input: "{:a 1 a: 2}", mode: "read" },
    {
      name: "n_quasiquote_dup_key_post_substitution",
      input: '`{:a 1, "a" 2}',
      mode: "eval",
    },
  ])("door E-DICT-DUP-KEY · $name", async ({ input, mode }) => {
    let err: unknown;
    try {
      mode === "read" ? await readAst(input) : await evalJson(input);
    } catch (e) {
      err = e;
    }
    expect(err, "expected E-DICT-DUP-KEY, but succeeded").toBeDefined();
    expect(errorClass(err)).toBe("E-DICT-DUP-KEY");
  });

  it.each([{ name: "n_dict_trailing_unquote_missing_datum", input: "{:a ,}", mode: "read" }])(
    "door E-EXPECTING-DATUM · $name",
    async ({ input, mode }) => {
      let err: unknown;
      try {
        mode === "read" ? await readAst(input) : await evalJson(input);
      } catch (e) {
        err = e;
      }
      expect(err, "expected E-EXPECTING-DATUM, but succeeded").toBeDefined();
      expect(errorClass(err)).toBe("E-EXPECTING-DATUM");
    },
  );

  it.each([{ name: "n_dict_dot", input: "{:a . 1}", mode: "read" }])(
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

  it.each([{ name: "n_dict_unterminated", input: "{:a 1", mode: "read" }])(
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

  it.each([{ name: "n_stray_curly_close", input: "}", mode: "read" }])(
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

  it.each([{ name: "i_unquote_key_outside_quasiquote_errors", input: "{:a 1, k 2}", mode: "eval" }])(
    "door any-error · $name",
    async ({ input, mode }) => {
      let err: unknown;
      try {
        mode === "read" ? await readAst(input) : await evalJson(input);
      } catch (e) {
        err = e;
      }
      expect(err, "expected any error, but succeeded").toBeDefined();
    },
  );
});
