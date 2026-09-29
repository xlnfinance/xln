import { describe, expect, it } from "vitest";
import { createSchemeLanguageService } from "../language-service.js";

describe("bare formals — arbitrary length, type from consumers", () => {
  it("(str a b c d) is not Expected 0 arguments", () => {
    const schemePrelude = `(define str (lambda args (apply string-append (map (lambda (x) (if (string? x) x (number->string x))) args))))`;
    const ls = createSchemeLanguageService({
      compilerOptions: { noImplicitAny: false },
      schemePrelude,
    });
    const scheme = `(define s (str "a" 1 "b" "c"))\ns`;
    const program = ls.getTypelevelProgram(scheme);
    // Rest formals: (...args) or (...args: List<…>) from consumer common denom.
    expect(program).toMatch(/\(\.\.\.args(?::[^)]*)?\)\s*=>/);
    expect(program).not.toMatch(/const str = \(\)\s*=>/);
    expect(program).toContain('str("a", 1, "b", "c")');
    const diags = ls.getSemanticDiagnostics(scheme);
    const arity = diags.filter((d) => /Expected 0 arguments|Expected \d+ arguments/.test(String(d.messageText ?? "")));
    expect(arity).toEqual([]);
  });

  it("rest element type is call-site common denom when body only yields List<any>", () => {
    // Body uses `args` only as map's list (trivial List<any>); call sites are all strings.
    const scheme = `(define join (lambda args (apply string-append args)))\n` + `(define a (join "x" "y" "z"))\n` + `a`;
    const ls = createSchemeLanguageService({ compilerOptions: { noImplicitAny: false } });
    const program = ls.getTypelevelProgram(scheme);
    expect(program).toMatch(/\(\.\.\.args(?::[^)]*)?\)\s*=>/);
    // Prefer List<string> (or bare rest) over inventing zero-arity.
    expect(program).not.toMatch(/const join = \(\)\s*=>/);
    const diags = ls.getSemanticDiagnostics(scheme);
    const arity = diags.filter((d) => /Expected 0 arguments/.test(String(d.messageText ?? "")));
    expect(arity).toEqual([]);
  });
});
