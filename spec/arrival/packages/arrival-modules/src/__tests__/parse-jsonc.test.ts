// parse-jsonc — the tsconfig/VS Code JSONC dialect for `.json` requires.
import { describe, expect, it } from "vitest";

import { parseJsonc } from "../parse-jsonc.js";

describe("parseJsonc", () => {
  it("parses strict JSON unchanged", () => {
    expect(parseJsonc(`{"a":1,"b":[true,null]}`)).toEqual({ a: 1, b: [true, null] });
  });

  it("strips // line comments and /* block comments */", () => {
    const text = `{
      // line comment
      "name": "Ada", /* inline */ "age": 36,
    }`;
    expect(parseJsonc(text)).toEqual({ name: "Ada", age: 36 });
  });

  it("does not treat // or /* inside strings as comments", () => {
    expect(parseJsonc(`{"url":"https://x.com","glob":"a/*b*/c"}`)).toEqual({
      url: "https://x.com",
      glob: "a/*b*/c",
    });
  });

  it("accepts trailing commas in objects and arrays", () => {
    expect(parseJsonc(`{"a":1, "b":[2,3,],}`)).toEqual({ a: 1, b: [2, 3] });
  });

  it("honors escaped quotes inside strings", () => {
    expect(parseJsonc(String.raw`{"q":"say \"hi\" // not a comment"}`)).toEqual({
      q: 'say "hi" // not a comment',
    });
  });

  it("throws on still-malformed documents", () => {
    expect(() => parseJsonc(`{ not json`)).toThrow();
  });
});
