// diagnose — the type-hint DIAGNOSE primitive. Proves the mechanics against a CONTROLLED
// typed prelude (real param/return types), separating "the primitive extracts codes +
// payloads + span-maps correctly" from "the manifold's z.value harvest feeds it types"
// (the latter is an upstream concern — see the manifold type-hints S2-spine design).
//
// Each fixture hand-declares the harvested signature it needs, so the extraction paths
// (expected/actual, propertyName/candidates, signatureText) are exercised with types the
// checker can actually narrow — which the manifold's runtime `z.value` erasure cannot supply.

import { describe, expect, it } from "vitest";

import { createDiagnoseLens } from "../diagnose.js";
import type { HarvestedPrelude } from "../prelude.js";

/** A controlled harvested prelude with REAL types (not the manifold's `unknown` erasure). */
const TYPED: HarvestedPrelude = {
  prelude: [
    "interface Cons<out T> { readonly x: T }",
    "type List<T> = Cons<T> | null;",
    "declare function list<T>(...xs: T[]): List<T>;",
    "declare const add2: (a: number, b: number) => number;",
    "declare const fx_search: (a: { query: string; max_results?: number }) => void;",
    "declare const config: { count: number };",
  ].join("\n"),
  members: ["add2", "fx_search", "list", "config"],
};

const lens = createDiagnoseLens(TYPED);

describe("createDiagnoseLens — diagnostic mechanics over a typed prelude", () => {
  it("2345 (positional mismatch): extracts expected + actual TS type strings", () => {
    const { diagnostics } = lens.diagnose('(add2 "x" 2)', [], { codes: [2345] });
    expect(diagnostics).toHaveLength(1);
    const d = diagnostics[0]!;
    expect(d.code).toBe(2345);
    expect(d.expected).toBe("number");
    expect(d.actual).toBe('"x"');
    expect(d.tsMessage).toContain("not assignable");
  });

  it("2554 (arity): extracts the callee's signature string", () => {
    const { diagnostics } = lens.diagnose("(add2 1)", [], { codes: [2554] });
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]!.code).toBe(2554);
    expect(diagnostics[0]!.signatureText).toBe("(a: number, b: number): number");
  });

  it("2561 (excess property): extracts propertyName + the closed candidate key set", () => {
    const { diagnostics } = lens.diagnose('(fx_search :query "x" :max_result 5)', [], { codes: [2561] });
    const d = diagnostics.find((x) => x.code === 2561);
    expect(d).toBeDefined();
    expect(d!.propertyName).toBe("max_result");
    expect(d!.candidateProperties).toContain("max_results");
  });

  it("2551 (typo'd property READ, bracket access — lower.ts's ONLY read shape): extracts a bare (unquoted) propertyName + candidates", () => {
    const { diagnostics } = lens.diagnose("(:coun config)", [], { codes: [2551] });
    const d = diagnostics.find((x) => x.code === 2551);
    expect(d).toBeDefined();
    expect(d!.propertyName).toBe("coun"); // bare — no surrounding quotes from the string-literal node
    expect(d!.candidateProperties).toContain("count");
    expect(d!.tsMessage).toContain("Did you mean");
  });

  it("whitelist gate: a non-whitelisted code is kept BARE (code + span + message, no payload)", () => {
    const { diagnostics } = lens.diagnose('(add2 "x" 2)', [], { codes: [9999] });
    expect(diagnostics).toHaveLength(1);
    const d = diagnostics[0]!;
    expect(d.code).toBe(2345);
    expect(d.expected).toBeUndefined();
    expect(d.actual).toBeUndefined();
    expect(d.tsMessage.length).toBeGreaterThan(0);
  });

  it("clean program: no diagnostics", () => {
    expect(lens.diagnose("(add2 1 2)", []).diagnostics).toEqual([]);
  });

  it("span-map: a current-program diagnostic's span is in scheme coordinates, ≥ programStartOffset", () => {
    const { unit, diagnostics } = lens.diagnose('(add2 "x" 2)', [], { codes: [2345] });
    expect(unit.programStartOffset).toBe(0);
    expect(unit.statementSpans).toEqual([[0, 12]]); // `(add2 "x" 2)` is 12 chars
    expect(diagnostics[0]!.span[0]).toBeGreaterThanOrEqual(unit.programStartOffset);
    expect(diagnostics[0]!.span).toEqual([0, 12]);
  });

  it("context recipe: contextDefines shift programStartOffset; context-region diagnostics drop", () => {
    // The context define is well-typed here; the program errors. programStartOffset = the joined
    // context scheme length (+1), and the program's span shifts past it.
    const context = ["(define ok 1)"];
    const { unit, diagnostics } = lens.diagnose('(add2 "x" 2)', context, { codes: [2345] });
    expect(unit.programStartOffset).toBe("(define ok 1)".length + 1);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]!.span[0]).toBeGreaterThanOrEqual(unit.programStartOffset);
    // The statement span is the raw form span shifted into unit space.
    expect(diagnostics[0]!.span).toEqual([unit.programStartOffset, unit.programStartOffset + 12]);
  });

  it("advisory: diagnose never throws on unparseable scheme — it returns an empty result", () => {
    expect(() => lens.diagnose("(add2 1", [])).not.toThrow();
    expect(lens.diagnose("(add2 1", []).diagnostics).toEqual([]);
  });
});
