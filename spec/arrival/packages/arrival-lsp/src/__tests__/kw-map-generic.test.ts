import { describe, expect, it } from "vitest";
import { createSchemeLanguageService } from "../language-service.js";

describe("keyword-as-fn under map — HOF-safe generic", () => {
  it("(map :score xs) — no unknown-x, no unknown↛{score} clash", () => {
    const scheme = `(define xs (list (dict :score 1) (dict :score 2)))\n` + `(map :score xs)`;
    const ls = createSchemeLanguageService({ compilerOptions: { noImplicitAny: false, strict: true } });
    const program = ls.getTypelevelProgram(scheme);
    expect(program).toMatch(/A extends \{ score: infer S \}/);
    expect(program).not.toMatch(/A extends \{ score: any \}/);
    const diags = ls.getSemanticDiagnostics(scheme);
    const bad = diags.filter((d) =>
      /is of type 'unknown'|not assignable to parameter of type '\(a: unknown\)'|Type 'unknown' is not assignable to type '\{ score/.test(
        String(d.messageText ?? ""),
      ),
    );
    expect(bad).toEqual([]);
  });

  it("(map :score unknown-list) accepts (a: unknown) => … HOF slot", () => {
    // Element type unknown — constrained A extends {score} would fail contravariance.
    const scheme = `(define xs (list 1 2))\n(map :score xs)`;
    const ls = createSchemeLanguageService({ compilerOptions: { noImplicitAny: false, strict: true } });
    const diags = ls.getSemanticDiagnostics(scheme);
    const contravariant = diags.filter((d) =>
      /not assignable to parameter of type '\(a: unknown\)'|Type 'unknown' is not assignable to type '\{ score/.test(
        String(d.messageText ?? ""),
      ),
    );
    expect(contravariant).toEqual([]);
  });
});
