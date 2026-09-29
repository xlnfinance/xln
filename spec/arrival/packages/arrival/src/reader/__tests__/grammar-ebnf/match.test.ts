import { describe, expect, it } from "vitest";

import { accepts, parseEbnf } from "./match.js";

describe("ebnf matcher metalanguage", () => {
  it("parses ordered choice first-wins", () => {
    const g = parseEbnf(`program = 'ab' | 'a' ;`);
    expect(accepts(g, "ab")).toBe(true);
    expect(accepts(g, "a")).toBe(true);
    expect(accepts(g, "b")).toBe(false);
  });

  it("concatenates with comma", () => {
    const g = parseEbnf(`program = 'a' , 'b' , 'c' ;`);
    expect(accepts(g, "abc")).toBe(true);
    expect(accepts(g, "ab")).toBe(false);
    expect(accepts(g, "a b c")).toBe(false);
  });

  it("optional and repeat", () => {
    const g = parseEbnf(`program = 'a' , [ 'b' ] , { 'c' } ;`);
    expect(accepts(g, "a")).toBe(true);
    expect(accepts(g, "ab")).toBe(true);
    expect(accepts(g, "ac")).toBe(true);
    expect(accepts(g, "abccc")).toBe(true);
    expect(accepts(g, "b")).toBe(false);
  });

  it("named rules and grouping", () => {
    const g = parseEbnf(`
      program = item , { item } ;
      item = '(' , program , ')' | 'x' ;
    `);
    expect(accepts(g, "x")).toBe(true);
    expect(accepts(g, "(x)")).toBe(true);
    expect(accepts(g, "(x(x))")).toBe(true);
    expect(accepts(g, "()")).toBe(false);
  });

  it("sticky regex specials consume from the index", () => {
    const g = parseEbnf(`program = ?/[0-9]+/? , 'x' ;`);
    expect(accepts(g, "12x")).toBe(true);
    expect(accepts(g, "x")).toBe(false);
    expect(accepts(g, "12")).toBe(false);
  });

  it("ISO comments are skipped", () => {
    const g = parseEbnf(`(* head *) program = 'a' (* mid *) , 'b' ; (* tail *)`);
    expect(accepts(g, "ab")).toBe(true);
  });

  it("rejects duplicate and missing rules", () => {
    expect(() => parseEbnf(`program = 'a' ; program = 'b' ;`)).toThrow(/duplicate/);
    expect(() => parseEbnf(`program = missing ;`)).toThrow(/undefined/);
    expect(() => parseEbnf(`foo = 'a' ;`)).toThrow(/start rule program/);
  });

  it("rejects empty-matching regex", () => {
    expect(() => parseEbnf(`program = ?/x*/? ;`)).toThrow(/empty/);
  });

  it("quoted terminals keep Scheme braces out of ISO meta", () => {
    const g = parseEbnf(`program = '{' , 'a' , '}' ;`);
    expect(accepts(g, "{a}")).toBe(true);
    expect(accepts(g, "a")).toBe(false);
  });
});
