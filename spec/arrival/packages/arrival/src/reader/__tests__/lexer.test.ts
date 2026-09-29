// Direct unit tests for the Lexer FSM (the reader's true leaf).
//
// Until now the lexer was only exercised transitively through end-to-end
// `exec`/`parse` tests, so a refactor of the reader had no fast safety net.
// These tests drive `new Lexer` directly — they're the floor the
// `@arrival/reader` extraction (DAG P3) and the keystone's Parser surgery need.
//
// The lexer is a self-contained incremental FSM with zero dependency on the
// evaluator, so these run without any environment/stdlib bootstrap.
import { describe, expect, it } from "vitest";
import { eof } from "../../values/primitives/EOF.js";
import { Lexer } from "../Lexer.js";

/** Collect every meaningful token (string form) from an input. */
function lex(input: string): string[] {
  const lexer = new Lexer(input);
  const out: string[] = [];
  while (true) {
    const token = lexer.peek();
    if (token === eof) break;
    out.push(token as string);
    lexer.skip();
  }
  return out;
}

describe("Lexer — atoms & numbers", () => {
  it.each([
    { name: "bare symbol", input: "foo", tokens: ["foo"] },
    { name: "integer", input: "42", tokens: ["42"] },
    { name: "decimal", input: "3.14", tokens: ["3.14"] },
    { name: "negative integer", input: "-7", tokens: ["-7"] },
    { name: "whitespace-separated atoms", input: "a b c", tokens: ["a", "b", "c"] },
    { name: "booleans", input: "#t #f", tokens: ["#t", "#f"] },
    { name: "boolean long spellings", input: "#true #false", tokens: ["#true", "#false"] },
    { name: "boolean long spelling in a list", input: "(#true)", tokens: ["(", "#true", ")"] },
    { name: "char literal", input: "#\\a", tokens: ["#\\a"] },
    { name: "apostrophe char", input: "#\\'", tokens: ["#\\'"] },
    { name: "double-quote char", input: '#\\"', tokens: ['#\\"'] },
  ])("tokenizes $name", ({ input, tokens }) => {
    expect(lex(input)).toEqual(tokens);
  });
});

describe("Lexer — character payloads that are also delimiters", () => {
  it.each([
    {
      name: "apostrophe in a list (must not become a quote)",
      input: "(char=? x #\\')",
      tokens: ["(", "char=?", "x", "#\\'", ")"],
    },
    {
      name: "double-quote in a list (must not open a string)",
      input: '(char=? x #\\")',
      tokens: ["(", "char=?", "x", '#\\"', ")"],
    },
    { name: "comma char", input: "#\\,", tokens: ["#\\,"] },
    { name: "open-paren char", input: "#\\(", tokens: ["#\\("] },
  ])("tokenizes $name", ({ input, tokens }) => {
    expect(lex(input)).toEqual(tokens);
  });
});

describe("Lexer — structure", () => {
  it.each([
    { name: "parens as distinct tokens", input: "(+ 1 2)", tokens: ["(", "+", "1", "2", ")"] },
    { name: "nested lists", input: "(a (b c) d)", tokens: ["(", "a", "(", "b", "c", ")", "d", ")"] },
    { name: "brackets", input: "[a b]", tokens: ["[", "a", "b", "]"] },
    { name: "the dotted-pair dot", input: "(a . b)", tokens: ["(", "a", ".", "b", ")"] },
    { name: "vector opener", input: "#(1 2)", tokens: ["#(", "1", "2", ")"] },
    { name: "bytevector opener", input: "#u8(1 2)", tokens: ["#u8(", "1", "2", ")"] },
    {
      name: "attachment tag is one token; payload is the next",
      input: '#attachment "att-1 (image/png, 10B)"',
      tokens: ["#attachment", '"att-1 (image/png, 10B)"'],
    },
  ])("tokenizes $name", ({ input, tokens }) => {
    expect(lex(input)).toEqual(tokens);
  });
});

describe("Lexer — strings & quote sugar", () => {
  it.each([
    { name: "string literal as one token", input: '"hello world"', tokens: ['"hello world"'] },
    { name: "escapes inside a string kept as one token", input: '"a\\"b"', tokens: ['"a\\"b"'] },
    { name: "quote prefix", input: "'x", tokens: ["'", "x"] },
    { name: "quasiquote prefix", input: "`x", tokens: ["`", "x"] },
    { name: "unquote prefix", input: ",x", tokens: [",", "x"] },
    { name: "unquote-splicing prefix", input: ",@x", tokens: [",@", "x"] },
  ])("tokenizes $name", ({ input, tokens }) => {
    expect(lex(input)).toEqual(tokens);
  });
});

describe("Lexer — edge cases", () => {
  it.each([
    { name: "empty input", input: "", tokens: [] },
    { name: "whitespace-only input", input: "   \n\t ", tokens: [] },
  ])("returns nothing for $name", ({ input, tokens }) => {
    expect(lex(input)).toEqual(tokens);
  });

  it("peek without skip is idempotent", () => {
    const lexer = new Lexer("(a b)");
    expect(lexer.peek()).toBe(lexer.peek());
  });

  it("eof is returned past the end", () => {
    const lexer = new Lexer("x");
    lexer.peek(); // skip() advances the last-peeked token, so peek first
    lexer.skip();
    expect(lexer.peek()).toBe(eof);
  });
});
