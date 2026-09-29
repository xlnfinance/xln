import { describe, expect, it } from "vitest";

import { createSchemeLanguageService, schemeifyTsText } from "../index.js";

describe("schemeifyTsText", () => {
  it("rewrites encoded idents to scheme spelling", () => {
    expect(schemeifyTsText("function pair$qmark$(v: unknown): v is NonEmptyList<unknown>")).toBe(
      "function pair?(v: unknown): v is NonEmptyList<unknown>",
    );
    expect(schemeifyTsText("string$dash$append")).toBe("string-append");
    expect(schemeifyTsText("number$dash$$greater$string")).toBe("number->string");
    expect(schemeifyTsText("$plus$")).toBe("+");
    expect(schemeifyTsText("null$qmark$")).toBe("null?");
    expect(schemeifyTsText("chat$slash$completion")).toBe("chat/completion");
  });

  it("leaves plain TS vocabulary alone", () => {
    expect(schemeifyTsText("List<number>")).toBe("List<number>");
    expect(schemeifyTsText("function car(xs: List<T>): T")).toBe("function car(xs: List<T>): T");
    expect(schemeifyTsText("Argument of type 'number' is not assignable to parameter of type 'string'.")).toBe(
      "Argument of type 'number' is not assignable to parameter of type 'string'.",
    );
  });

  it("leaves malformed $ tokens alone (no throw)", () => {
    expect(schemeifyTsText("foo$notatoken$bar")).toBe("foo$notatoken$bar");
  });
});

describe("LSP surfaces scheme spellings", () => {
  const ls = createSchemeLanguageService({ compilerOptions: { noImplicitAny: false } });

  it("quickinfo shows pair? not pair$qmark$", () => {
    const info = ls.getQuickInfoAtPosition("(pair? xs)", 1);
    expect(info?.displayText).toContain("pair?");
    expect(info?.displayText).not.toContain("$qmark$");
  });

  it("quickinfo shows number->string not encoded", () => {
    const info = ls.getQuickInfoAtPosition("(number->string 1)", 1);
    expect(info?.displayText).toContain("number->string");
    expect(info?.displayText).not.toContain("$dash$");
  });

  it("quickinfo shows <= not $less$$eq$", () => {
    const info = ls.getQuickInfoAtPosition("(<= a b)", 1);
    expect(info?.displayText).toMatch(/function\s+<=/);
    expect(info?.displayText).not.toContain("$less$");
  });
});
