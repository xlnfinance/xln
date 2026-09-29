import { describe, expect, it } from "vitest";
import { assembleHostPrelude } from "../host-prelude.js";
import { createSchemeLanguageService } from "../language-service.js";

/** Polyglot str body — same shape as polyglot-clojure. */
const STR_PRELUDE = `(define str (lambda args (apply string-append (map (lambda (x) (if (string? x) x (repr x))) args))))`;

describe("str rest domain — any values, not List<string>-only", () => {
  it(String.raw`(str "\n" (map …)) is legal when body is polymorphic (no List<string> overfit)`, () => {
    const scheme =
      `(define cls (list (list 1 2)))\n` +
      `(define clsBlock\n` +
      `  (str "\\n"\n` +
      `    (map (lambda (entry) (str "name" " → " "bucket")) cls)))\n` +
      `clsBlock\n`;
    const ls = createSchemeLanguageService({
      compilerOptions: { noImplicitAny: false, strict: true },
      schemePrelude: STR_PRELUDE,
      host: assembleHostPrelude([
        ["repr", "(x: unknown): string"],
        // Ambient honest type (same as polyglot contract type:) — scheme body
        // still defines str; rest inference must not over-tighten to List<string>.
        ["str", "(...args: unknown[]): string"],
      ]),
    });
    const program = ls.getTypelevelProgram(scheme);
    // Must not pin rest to List<string> (that rejects a List arg).
    expect(program).not.toMatch(/\(\.\.\.args:\s*List<string>/);
    const diags = ls.getSemanticDiagnostics(scheme);
    const listClash = diags.filter((d) =>
      /List<string>|not assignable to parameter of type/.test(String(d.messageText ?? "")),
    );
    expect(listClash).toEqual([]);
  });
});
