/**
 * Nested accessor coherence at the language-service layer.
 * Binder demand harvest in type-emit must green the triage-shaped buffer under strict.
 */
import { describe, expect, it } from "vitest";

import { createSchemeLanguageService } from "../language-service.js";

const TRIAGE = `
(define (triage-of-persona-in-node pid node)
  (let loop ((ts (:triaged node)))
    (cond ((null? ts) #f)
          ((equal? (:id (:persona (car ts))) pid) (car ts))
          (else (loop (cdr ts))))))
`;

describe("nested accessor coherence — LSP", () => {
  it("triage buffer: no Object is of type unknown under strict", () => {
    const ls = createSchemeLanguageService({
      compilerOptions: { noImplicitAny: false, strict: true },
    });
    const program = ls.getTypelevelProgram(TRIAGE);
    expect(program).toMatch(/ts:\s*List</);
    expect(program).toMatch(/node:\s*\{\s*triaged:\s*List</);
    const diags = ls.getSemanticDiagnostics(TRIAGE);
    const unknownObj = diags.filter((d) =>
      /Object is of type 'unknown'|is of type 'unknown'/.test(String(d.messageText ?? "")),
    );
    expect(unknownObj).toEqual([]);
  });
});
