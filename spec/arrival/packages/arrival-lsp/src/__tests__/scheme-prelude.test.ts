// scheme-prelude — the scheme STDLIB preamble (`BUILTIN_PREAMBLE`) threaded
// into the lens as an implicit always-present dependency.
//
// The bug this fixes: scheme-prelude helpers (`field`, `values-of`, `take`, …)
// are NOT rosettas and have NO hand-written `.d.ts` leaf — they are scheme
// source the runtime always loads ahead of the user's program. Before this seam
// the lens never saw that source, so every such name read as an unresolved
// "Cannot find name" suggestion. The fix emits the preamble SOURCE into the same
// virtual module ahead of the require closure — derived, never restated.
//
// Per `.claude/rules/tests.md` this is a `__tests__/` verdict (boolean pass/fail).

import { describe, expect, it } from "vitest";

import { createSchemeLanguageService } from "../language-service.js";

// A minimal stand-in for arrival's BUILTIN_PREAMBLE: a scheme-defined helper
// (no native impl, no leaf) that the runtime always preloads.
const PRELUDE = `(define (field container key) (@ container key))\n(define (count-if pred xs) (length (filter pred xs)))`;

const ls = createSchemeLanguageService({
  compilerOptions: { noImplicitAny: false },
  schemePrelude: PRELUDE,
});

describe("scheme stdlib preamble in scope", () => {
  it("a preamble-defined helper resolves — no unknown-name suggestion", () => {
    const scheme = `(define obj (list 1 2))\n(define x (field obj 0))`;
    const diags = ls.getSemanticDiagnostics(scheme);
    const unresolved = diags.filter((d) => (d.code === 2304 || d.code === 2552) && d.messageText.includes("field"));
    expect(unresolved).toHaveLength(0);
  });

  it("a second preamble helper resolves too", () => {
    const scheme = `(define n (count-if odd? (list 1 2 3)))`;
    const diags = ls.getSemanticDiagnostics(scheme);
    const unresolved = diags.filter((d) => (d.code === 2304 || d.code === 2552) && d.messageText.includes("count-if"));
    expect(unresolved).toHaveLength(0);
  });

  it("without the preamble option the same name is unresolved (control)", () => {
    const bare = createSchemeLanguageService({ compilerOptions: { noImplicitAny: false } });
    const scheme = `(define x (field obj "k"))`;
    const diags = bare.getSemanticDiagnostics(scheme);
    const unresolved = diags.filter((d) => (d.code === 2304 || d.code === 2552) && d.messageText.includes("field"));
    expect(unresolved.length).toBeGreaterThan(0);
  });
});
