import { describe, expect, it } from "vitest";

import { alignSugarcoatScheme } from "../sugarcoat-align.js";
import { schemeToSugarcoat } from "../sugarcoat-render.js";

/** Translate the position of `needle`'s first char in `sugarcoat` to Scheme and
 *  read back what Scheme token sits there — the round-trip a hover query makes. */
function schemeTokenAt(sugarcoat: string, needle: string): string | null {
  const a = alignSugarcoatScheme(sugarcoat);
  if (a === null) return null;
  const pos = sugarcoat.indexOf(needle);
  if (pos === -1) throw new Error(`needle '${needle}' not in sugarcoat text`);
  const sPos = a.toScheme(pos);
  if (sPos === null) return null;
  const m = /^[\w\-!$%&*+./<=>?@^~]+/.exec(a.scheme.slice(sPos));
  return m ? m[0] : a.scheme[sPos];
}

describe("alignSugarcoatScheme", () => {
  it("derives the canonical Scheme from the sugarcoat buffer", () => {
    const sugarcoat = schemeToSugarcoat(`(define (double n) (* n 2))`);
    const a = alignSugarcoatScheme(sugarcoat);
    expect(a).not.toBeNull();
    expect(a!.scheme).toContain("(define (double n)");
    expect(a!.scheme).toContain("(* n 2)");
  });

  it("maps positions through exact atom pairs, offset-precise", () => {
    const sugarcoat = schemeToSugarcoat(`(define (double n) (* n 2))`);
    expect(schemeTokenAt(sugarcoat, "double")).toBe("double");
    // Mid-atom: position on 'u' of double still lands inside the Scheme atom.
    const a = alignSugarcoatScheme(sugarcoat)!;
    const pos = sugarcoat.indexOf("double") + 2;
    const sPos = a.toScheme(pos)!;
    expect(a.scheme.slice(sPos - 2, sPos + 4)).toBe("double");
  });

  it("maps atoms inside curly-infix back to the prefix form", () => {
    // {n - 1} in sugarcoat ↔ (- n 1) in Scheme: n and 1 are exact pairs.
    const sugarcoat = schemeToSugarcoat(`(define (dec n) (- n 1))`);
    expect(sugarcoat).toContain("{n - 1}");
    expect(schemeTokenAt(sugarcoat, "n -")).toBe("n");
  });

  it("declines positions on sugar (the infix glyph) instead of guessing", () => {
    const sugarcoat = schemeToSugarcoat(`(define (eq-check a b) (equal? a b))`);
    expect(sugarcoat).toContain("==");
    const a = alignSugarcoatScheme(sugarcoat)!;
    expect(a.toScheme(sugarcoat.indexOf("=="))).toBeNull();
  });

  it("lifts a Scheme span inside sugar to the enclosing paired node", () => {
    const sugarcoat = schemeToSugarcoat(`(define (eq-check a b) (equal? a b))`);
    const a = alignSugarcoatScheme(sugarcoat)!;
    // The Scheme `equal?` atom has no exact sugarcoat twin (rendered `==`) — a
    // diagnostic on it lifts to a containing span, still inside the sugarcoat text.
    const eqPos = a.scheme.indexOf("equal?");
    const span = a.toSugarcoat(eqPos, "equal?".length);
    expect(span).not.toBeNull();
    const lifted = sugarcoat.slice(span!.start, span!.start + span!.length);
    expect(lifted).toContain("==");
  });

  it("round-trips spans through elided let bindings", () => {
    const scheme = `(define (f xs) (let ((head (car xs)) (rest (cdr xs))) (cons head rest)))`;
    const sugarcoat = schemeToSugarcoat(scheme);
    expect(sugarcoat).not.toContain("(("); // bindings elided in the view
    const a = alignSugarcoatScheme(sugarcoat)!;
    const sPos = a.toScheme(sugarcoat.indexOf("head"))!;
    expect(a.scheme.slice(sPos, sPos + 4)).toBe("head");
    // And back: the Scheme `rest` binder maps to the sugarcoat `rest` line.
    const rPos = a.scheme.indexOf("rest");
    const span = a.toSugarcoat(rPos, 4)!;
    expect(sugarcoat.slice(span.start, span.start + span.length)).toBe("rest");
  });

  it("maps string literals (spans include the quotes on both sides)", () => {
    // `list` (not string-append) so the literal stays Scheme: a `string-append`
    // with a hole now surfaces as an `@{…}` at-expression (the "hello" loses its
    // quotes inside the at-body), which is a different surface than the quote-span
    // mapping this test exercises.
    const sugarcoat = schemeToSugarcoat(`(define greeting (list "hello" name))`);
    const a = alignSugarcoatScheme(sugarcoat)!;
    const qPos = sugarcoat.indexOf('"hello"');
    const sPos = a.toScheme(qPos + 1)!; // inside the string
    expect(a.scheme.slice(sPos - 1, sPos + 6)).toBe('"hello"');
  });

  it("returns null on a mid-edit unparseable buffer", () => {
    expect(alignSugarcoatScheme("define (f x\n  {x +")).toBeNull();
  });

  it("survives sugarcoat-only edits: alignment is over the buffer as typed", () => {
    // Hand-written sugarcoat (not a render output) still aligns — the Scheme is
    // derived from THIS buffer, not recovered from any stored original.
    const sugarcoat = "define (triple n)\n  {n * 3}";
    const a = alignSugarcoatScheme(sugarcoat)!;
    expect(a.scheme).toBe("(define (triple n) (* n 3))");
    const sPos = a.toScheme(sugarcoat.indexOf("triple"))!;
    expect(a.scheme.slice(sPos, sPos + 6)).toBe("triple");
  });
});
