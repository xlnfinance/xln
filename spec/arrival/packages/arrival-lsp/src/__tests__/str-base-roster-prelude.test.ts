import { BASE_ROSTER, collectPrelude, collectSymbolDefines } from "@inhuman.tools/arrival/lsp-internals";
import { describe, expect, it } from "vitest";

import { createSchemeLanguageService } from "../language-service.js";

describe("str from real BASE_ROSTER schemePrelude", () => {
  const schemePrelude = [collectPrelude(BASE_ROSTER), collectSymbolDefines(BASE_ROSTER)]
    .filter((s) => s !== "")
    .join("\n");

  it("prelude contains (define str …)", () => {
    expect(schemePrelude).toMatch(/\(define str\b/);
  });

  it("LS resolves (str …) with that prelude", () => {
    const ls = createSchemeLanguageService({
      compilerOptions: { noImplicitAny: false },
      schemePrelude,
    });
    const diags = ls.getSemanticDiagnostics(`(define x (str "a" 1 "b"))`);
    const bad = diags.filter((d) => (d.code === 2304 || d.code === 2552) && String(d.messageText).includes("str"));
    expect(bad.map((d) => d.messageText)).toEqual([]);
  });
});
