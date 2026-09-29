import { describe, expect, it } from "vitest";

import { parseSexprs, type Node } from "../parse.js";

const atom = (n: Node | undefined): string => {
  expect(n && "atom" in n).toBe(true);
  return (n as { atom: string }).atom;
};

const list = (n: Node | undefined): Node[] => {
  expect(n && "list" in n).toBe(true);
  return (n as { list: Node[] }).list;
};

describe("parseSexprs", () => {
  it("parses a paren list and stamps a span", () => {
    const [form] = parseSexprs("(map f xs)");
    expect(list(form).map(atom)).toEqual(["map", "f", "xs"]);
    expect(form?.span).toEqual([0, 10]);
  });

  it("stamps open: '[' on bracket lists", () => {
    const [form] = parseSexprs("[1 2]");
    expect(form && "list" in form && form.open).toBe("[");
    expect(list(form).map(atom)).toEqual(["1", "2"]);
  });

  it("stamps open: '{' on brace lists (not atom glue)", () => {
    const [form] = parseSexprs("{:a 1}");
    expect(form && "list" in form && form.open).toBe("{");
    expect(list(form).map(atom)).toEqual([":a", "1"]);
  });

  it("rewrites Racket #:limit to :limit", () => {
    const [form] = parseSexprs("(#:limit 3)");
    expect(list(form).map(atom)).toEqual([":limit", "3"]);
  });

  it("expands quote at parse time", () => {
    const [form] = parseSexprs("'x");
    expect(list(form).map(atom)).toEqual(["quote", "x"]);
  });

  it("attaches a same-line comment as trail and an own-line comment as lead", () => {
    const [form] = parseSexprs("; lead\nfoo ; trail");
    expect(atom(form)).toBe("foo");
    expect(form?.lead).toEqual(["; lead"]);
    expect(form?.trail).toEqual(["; trail"]);
  });
});
