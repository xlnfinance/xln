// sugarcoat-ide — the sugarcoat-lens backend compositor against the REAL type lens.
// Three lenses end-to-end: sugarcoat ↔ Scheme (alignSugarcoatScheme) ↔ virtual TS ↔
// tsc. Diagnostics, hover, completion, and goto-def all answered for a SWEET
// buffer in SWEET coordinates.
//
// Per `.claude/rules/tests.md` this is a `__tests__/` verdict (boolean pass/fail).

import { schemeToSugarcoat } from "@inhuman.tools/arrival-sugarcoat";
import { createSchemeLanguageService } from "@inhuman.tools/arrival-lsp";
import { describe, expect, it } from "vitest";

import { sugarcoatIdeBackend } from "../sugarcoat-ide.js";

const backend = sugarcoatIdeBackend(createSchemeLanguageService());

describe("sugarcoatIdeBackend — diagnostics in sugarcoat coordinates", () => {
  it("(car 5) typed in sugarcoat → the squiggle lands on the sugarcoat `5`", async () => {
    const sugarcoat = schemeToSugarcoat(`(define z (car 5))`);
    const diags = await backend.getSemanticDiagnostics(sugarcoat);
    expect(diags).toHaveLength(1);
    const d = diags[0]!;
    expect(sugarcoat.slice(d.start, d.start + d.length)).toBe("5");
    expect(d.severity).toBe("error");
  });

  it("a misuse inside curly-infix maps back into the braces", async () => {
    // {n + "x"}: string into numeric + — the error span must land in the sugarcoat
    // text, on (or containing) the offending literal inside the curly.
    const sugarcoat = schemeToSugarcoat(`(define (f n) (+ n "x"))`);
    expect(sugarcoat).toContain('{n + "x"}');
    const diags = await backend.getSemanticDiagnostics(sugarcoat);
    expect(diags.length).toBeGreaterThan(0);
    const d = diags[0]!;
    expect(sugarcoat.slice(d.start, d.start + d.length)).toContain('"x"');
  });

  it("an error in an elided-let body maps through the dropped parens", async () => {
    // Body (+ n 1 …) is 3+ elements (not binding-shaped) so the bindings elide.
    const sugarcoat = schemeToSugarcoat(`(define (g s) (let ((n (string-length s))) (string-upcase n)))`);
    const diags = await backend.getSemanticDiagnostics(sugarcoat);
    expect(diags.length).toBeGreaterThan(0);
    expect(sugarcoat.slice(diags[0]!.start, diags[0]!.start + diags[0]!.length)).toBe("n");
  });

  it("a mid-edit unparseable sugarcoat buffer answers empty, never throws", async () => {
    expect(await backend.getSemanticDiagnostics("define (f x\n  {x +")).toEqual([]);
  });
});

describe("sugarcoatIdeBackend — hover in sugarcoat coordinates", () => {
  it("hovering an inferred-param function shows its signature", async () => {
    const sugarcoat = schemeToSugarcoat(`(define (shout msg) (string-upcase msg))\n\n(define loud (shout "hi"))`);
    const pos = sugarcoat.lastIndexOf("shout"); // the USE site, inside (shout "hi")
    const info = await backend.getQuickInfoAtPosition(sugarcoat, pos);
    expect(info).not.toBeNull();
    expect(info!.displayText).toContain("(msg: string) => string");
    // The hover span is in SWEET coordinates, over the hovered atom.
    expect(sugarcoat.slice(info!.span!.start, info!.span!.start + info!.span!.length)).toBe("shout");
  });

  it("hovering sugar (an infix glyph) declines instead of misanswering", async () => {
    const sugarcoat = schemeToSugarcoat(`(define (same a b) (equal? a b))`);
    expect(sugarcoat).toContain("==");
    expect(await backend.getQuickInfoAtPosition(sugarcoat, sugarcoat.indexOf("=="))).toBeNull();
  });
});

describe("sugarcoatIdeBackend — completion in sugarcoat coordinates", () => {
  it("a typed prefix completes (cursor at the end of a partial atom)", async () => {
    const sugarcoat = "define (f s)\n  string-app";
    const pos = sugarcoat.length;
    const entries = await backend.getCompletionsAtPosition(sugarcoat, pos);
    expect(entries.map((e) => e.name)).toContain("string-append");
  });

  it("the Σ∩T rich context flows through (argument slot in sugarcoat)", async () => {
    if (!backend.getCompletionContext) throw new Error("rich completion missing on seam");
    const sugarcoat = "define (f s)\n  string-upcase s";
    // Cursor right after `string-upcase ` — the argument slot. Position the
    // cursor ON the `s` argument's end to ride the exact-pair mapping.
    const pos = sugarcoat.length;
    const ctx = await backend.getCompletionContext(sugarcoat, pos);
    expect(ctx.position).toBe("argument");
    expect(ctx.slot?.callee).toBe("string-upcase");
  });

  it("the whitespace-after-callee anchor completes the empty argument slot", async () => {
    if (!backend.getCompletionContext) throw new Error("rich completion missing on seam");
    // `(string-upcase |)` — empty slot; the cursor sits on sugarcoat whitespace
    // with no Scheme twin, so the anchor injects the seam after the callee.
    const sugarcoat = "define (f s)\n  (string-upcase )";
    const ctx = await backend.getCompletionContext(sugarcoat, sugarcoat.length - 1);
    expect(ctx.position).toBe("argument");
    expect(ctx.slot?.callee).toBe("string-upcase");
  });
});

describe("sugarcoatIdeBackend — goto-definition in sugarcoat coordinates", () => {
  it("a local use site jumps to the sugarcoat position of its define", async () => {
    const sugarcoat = schemeToSugarcoat(`(define (helper x) (* x 2))\n\n(define result (helper 3))`);
    const usePos = sugarcoat.lastIndexOf("helper");
    const defs = await backend.getDefinitionAtPosition(sugarcoat, usePos);
    expect(defs.length).toBeGreaterThan(0);
    const d = defs[0]!;
    expect(d.span).not.toBeNull();
    // The backend's definition span covers the whole define FORM (Scheme-lens
    // parity); lifted to sugarcoat it's the form's sugarcoat extent — the jump target.
    const target = sugarcoat.slice(d.span!.start, d.span!.start + d.span!.length);
    expect(target).toContain("define (helper x)");
    expect(d.span!.start).toBeLessThan(sugarcoat.indexOf("result"));
  });
});

describe("sugarcoatIdeBackend — semantic classifications in sugarcoat coordinates", () => {
  it("classifies the parameter at its sugarcoat position, exact-length only", async () => {
    if (!backend.getSemanticClassifications) throw new Error("classifications missing on seam");
    const sugarcoat = schemeToSugarcoat(`(define (double n) (* n 2))`);
    const spans = await backend.getSemanticClassifications(sugarcoat);
    const params = spans.filter((s) => s.kind === "parameter");
    expect(params.length).toBeGreaterThan(0);
    for (const p of params) expect(sugarcoat.slice(p.start, p.start + p.length)).toBe("n");
  });
});
