// `parseSexprs`'s handling of `#\<char>` character literals — a real crash found via a live
// MCP-Atlas run: a model wrote `(char=? #\" (car chars))` while hand-rolling a CSV parser,
// which fed straight into this parser and got an uncaught "unterminated string" invariant.
// Root cause: `#\` had no dedicated case — the payload character fell through to the
// generic atom scan, which stops at delimiters including `"`, so `#\"` split into the 2-char
// atom `#\` plus a bare `"` that `readString` then read as OPENING a new (often unterminated)
// string.

import { describe, expect, it } from "vitest";

import { parseSexprs } from "../parse.js";

function atomOf(src: string): string {
  const forms = parseSexprs(src);
  expect(forms).toHaveLength(1);
  const form = forms[0]!;
  expect("atom" in form).toBe(true);
  return (form as { atom: string }).atom;
}

describe("parseSexprs — #\\<char> character literals", () => {
  it('reads #\\" (the quote character) as one atom, not a broken string', () => {
    expect(atomOf('#\\"')).toBe('#\\"');
  });

  it('reads #\\" mid-expression without swallowing the rest of the program', () => {
    const forms = parseSexprs('(char=? #\\" (car chars))');
    expect(forms).toHaveLength(1);
    const [head, ...rest] = (forms[0] as { list: unknown[] }).list as { atom?: string }[];
    expect(head?.atom).toBe("char=?");
    expect(rest[0]?.atom).toBe('#\\"');
  });

  it("reproduces the exact real-world crash shape (CSV quote-toggle parser) without throwing", () => {
    const src = `
      (let loop ((chars (string->list line)) (current '()) (fields '()) (in-quotes? #f))
        (cond ((null? chars) (reverse (cons (list->string (reverse current)) fields)))
              ((and (char=? #\\" (car chars)) (not in-quotes?)) (loop (cdr chars) current fields #t))
              ((and (char=? #\\" (car chars)) in-quotes?) (loop (cdr chars) current fields #f))
              (else (loop (cdr chars) (cons (car chars) current) fields in-quotes?))))
    `;
    expect(() => parseSexprs(src)).not.toThrow();
  });

  it("reads #\\\\ (the backslash character) as one atom", () => {
    expect(atomOf("#\\\\")).toBe("#\\\\");
  });

  it("reads #\\( and #\\) (bracket payloads) as one atom each, not list-openers", () => {
    expect(atomOf("#\\(")).toBe("#\\(");
    expect(atomOf("#\\)")).toBe("#\\)");
  });

  it("reads #\\; (semicolon payload) as one atom, not a comment starting", () => {
    expect(atomOf("#\\;")).toBe("#\\;");
  });

  it("reads #\\, (comma payload) as one atom", () => {
    expect(atomOf("#\\,")).toBe("#\\,");
  });

  it("reads #\\space and #\\newline as one named-literal atom each", () => {
    expect(atomOf("#\\space")).toBe("#\\space");
    expect(atomOf("#\\newline")).toBe("#\\newline");
  });

  it("reads a bare single-letter literal (#\\a) without over-consuming a following symbol", () => {
    const forms = parseSexprs("(list #\\a foo)");
    const [, charNode, symNode] = (forms[0] as { list: { atom?: string }[] }).list;
    expect(charNode?.atom).toBe("#\\a");
    expect(symNode?.atom).toBe("foo");
  });

  it("reads #\\x41 (hex escape) as one atom", () => {
    expect(atomOf("#\\x41")).toBe("#\\x41");
  });

  it("still reads a normal string literal correctly (no regression)", () => {
    const forms = parseSexprs('"hello world"');
    expect(forms).toHaveLength(1);
    expect(forms[0]).toMatchObject({ atom: "hello world", str: true });
  });

  it("still reads a string containing an escaped quote correctly (no regression)", () => {
    const forms = parseSexprs('"a\\"b"');
    expect(forms).toHaveLength(1);
    expect((forms[0] as { atom: string }).atom).toBe('a\\"b');
  });
});
