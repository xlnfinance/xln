// DEFINITION_KEYWORDS — the set the sugarcoat StreamLanguage tags t.definitionKeyword (syntax
// highlighting). define/overridable is a define-shaped binding form (bindingsAt in
// arrival-lsp's scheme-service.ts already treats it exactly like `define` for scope
// analysis), so it should highlight the same way, not read as a plain variableName call.
import { describe, expect, it } from "vitest";
import { DEFINITION_KEYWORDS } from "../scheme-sugarcoat.js";

describe("DEFINITION_KEYWORDS", () => {
  it("includes define/overridable alongside the other define-family forms", () => {
    expect(DEFINITION_KEYWORDS.has("define/overridable")).toBe(true);
  });

  it("still includes the existing define-family forms (no regression)", () => {
    for (const kw of [
      "define",
      "define-values",
      "define-syntax",
      "define-macro",
      "defmacro",
      "define-class",
      "define-record-type",
    ]) {
      expect(DEFINITION_KEYWORDS.has(kw)).toBe(true);
    }
  });
});
