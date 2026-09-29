/**
 * IDE contracts — full language-service surface (hard pins).
 *
 * Mirror of arrival-mercury's `type-lens-ide-contracts.test.ts`, exercised
 * through `createSchemeLanguageService` so service-core lift / severity policy
 * cannot silently diverge from the emit contracts.
 *
 * C1 car arg bite · C2 compose clean + call refine · C4 Layer T (Σ∩T).
 * Shape of emitted TS is free; these behavioral pins are not.
 *
 * Per `.claude/rules/tests.md` this is a `__tests__/` verdict.
 */
import { describe, expect, it } from "vitest";

import { createSchemeLanguageService } from "../language-service.js";
import { narrowByType, type Scanner, type ScannerState } from "../typed-scanner.js";

const ls = createSchemeLanguageService();

function errors(scheme: string) {
  return ls.getSemanticDiagnostics(scheme).filter((d) => d.severity === "error");
}

// ── C1 ───────────────────────────────────────────────────────────────────────

describe("C1 — (car 5) bites on the arg via the language service", () => {
  it("(define z (car 5)) → one error, span `5`, code 2345, assignability", () => {
    const scheme = `(define z (car 5))`;
    const diags = errors(scheme);
    expect(diags).toHaveLength(1);
    const d = diags[0]!;
    expect(scheme.slice(d.start, d.start + d.length)).toBe("5");
    expect(d.start).toBe(scheme.indexOf("5"));
    expect(d.code).toBe(2345);
    expect(d.messageText).toMatch(/not assignable/i);
    expect(d.messageText).not.toMatch(/can't be used to index/i);
  });

  it("clean (car xs) → 0 errors", () => {
    expect(errors(`(define xs (list 1 2 3))\n(define z (car xs))`)).toHaveLength(0);
  });
});

// ── C2 ───────────────────────────────────────────────────────────────────────

describe("C2 — compose/pipe through the language service", () => {
  it("compose define alone is clean", () => {
    expect(errors(`(define state-of (compose :state last :versions))`)).toHaveLength(0);
  });

  it("pipe define alone is clean", () => {
    expect(errors(`(define f (pipe :versions last :state))`)).toHaveLength(0);
  });

  it("well-typed pipeline call is clean", () => {
    const scheme =
      `(define state-of (compose :state last :versions))\n` +
      `(define p (dict :versions (list (dict :state "a"))))\n` +
      `(define s (state-of p))`;
    expect(errors(scheme)).toHaveLength(0);
  });

  it("wrong pipeline call bites on `1` with 2345", () => {
    const scheme = `(define state-of (compose :state last :versions))\n` + `(define s (state-of 1))`;
    const diags = errors(scheme);
    expect(diags).toHaveLength(1);
    expect(scheme.slice(diags[0]!.start, diags[0]!.start + diags[0]!.length)).toBe("1");
    expect(diags[0]!.code).toBe(2345);
  });
});

// ── C4 — Layer T (Σ∩T) ───────────────────────────────────────────────────────

describe("C4 — Layer T: list-arg slot keeps list producers, drops element producers", () => {
  const SIGMA = new Set(["car", "cdr", "filter", "list", "length", "not"]);

  function mockArgumentScanner(): Scanner {
    return {
      feasible: () => true,
      analyze: (): ScannerState => ({
        midToken: true,
        position: "argument",
        formKind: "application",
        closeable: false,
        validSymbols: () => SIGMA,
      }),
    };
  }

  it("at (car ⟨atom⟩ the arg wants List — car/length/not drop; list/cdr/filter stay", () => {
    const scanner = narrowByType(mockArgumentScanner(), ls);
    const valid = scanner.analyze("(car l").validSymbols()!;
    expect(valid.has("list")).toBe(true);
    expect(valid.has("cdr")).toBe(true);
    expect(valid.has("filter")).toBe(true);
    expect(valid.has("car")).toBe(false);
    expect(valid.has("length")).toBe(false);
    expect(valid.has("not")).toBe(false);
  });
});
