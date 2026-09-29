// Pins that comma/dot/quasiquote are ONLY special inside `[]`/`{}` — outside, they retain base-scheme meaning.
import { describe, expect, it } from "vitest";
import { readAst } from "./_harness.js";

describe("reader-baseline / specials outside […] {…} literals", () => {
  // POSITIVE — read: input parses to canonical AST
  it.each([
    {
      name: "y_unquote_outside_literal_untouched",
      input: "`(a ,b)",
      ast: "(quasiquote (a (unquote b)))",
    },
    { name: "y_dotted_pair_outside_literals_unaffected", input: "(a . b)", ast: "(a . b)" },
    { name: "i_comma_is_delimiter_outside_literals", input: "(f 1, 2)", ast: "(f 1 (unquote 2))" },
  ])("read · $name", async ({ input, ast }) => {
    expect(await readAst(input)).toBe(ast);
  });
});
