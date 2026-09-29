// completion-vocabulary — the editor's completion list speaks SCHEME.
//
// Against the REAL language service: builtins under their scheme names, the
// special forms (plugin-owned — syntax never reaches the type lens), program
// locals — and NONE of the virtual-TS substrate (JS globals, lens infra).
//
// Per `.claude/rules/tests.md` this is a `__tests__/` verdict (boolean pass/fail).

import { CompletionContext, type CompletionResult } from "@codemirror/autocomplete";
import { EditorState } from "@codemirror/state";
import { createSchemeLanguageService } from "@inhuman.tools/arrival-lsp";
import { describe, expect, it } from "vitest";

import { schemeCompletionSource } from "../ide.js";

const source = schemeCompletionSource(createSchemeLanguageService());

const labelsAt = async (doc: string, pos: number): Promise<Set<string>> => {
  const result = await source(new CompletionContext(EditorState.create({ doc }), pos, false));
  return new Set((result?.options ?? []).map((o) => o.label));
};

describe("completion vocabulary — scheme, not the JS substrate", () => {
  it("offers builtins (real scheme names), special forms, and locals", async () => {
    const doc = `(define total 3)\n(de`;
    const labels = await labelsAt(doc, doc.length);
    for (const expected of ["define", "lambda", "cond", "car", "string-append", "odd?", "total"]) {
      expect(labels.has(expected), expected).toBe(true);
    }
  });

  it("leaks neither JS globals nor lens infrastructure", async () => {
    const doc = `(define total 3)\n(de`;
    const labels = await labelsAt(doc, doc.length);
    for (const leak of ["console", "Array", "Math", "__arr", "sexpr", "typeof", "Dict"]) {
      expect(labels.has(leak), leak).toBe(false);
    }
  });
});

const resultAt = async (doc: string, pos: number, explicit = true): Promise<CompletionResult | null> =>
  (await source(new CompletionContext(EditorState.create({ doc }), pos, explicit))) as CompletionResult | null;

describe("the Σ∩T-ranked pipeline (rich backend)", () => {
  const PROG = `(define (greet name) (string-append "hi " name))\n(define names (list "ada" "grace"))\n`;

  it("argument slot: fitting candidates carry the top section + positive boost; proven-unfit demote", async () => {
    const doc = `${PROG}(car na`;
    const result = await resultAt(doc, doc.length);
    const byLabel = new Map(result!.options.map((o) => [o.label, o]));
    const names = byLabel.get("names")!;
    const greet = byLabel.get("greet")!;
    expect((names.section as { name: string }).name).toBe("fits this slot");
    expect(names.boost).toBe(80); // type-valid LOCAL — the top tier
    expect(greet.boost).toBe(-40); // proven-unfit: demoted, NOT hidden
    expect(byLabel.get("filter")!.boost).toBe(60); // type-valid builtin
  });

  it("signatures ride INLINE as detail; the info panel only carries the unfit note", async () => {
    const doc = `${PROG}(car na`;
    const result = await resultAt(doc, doc.length);
    const names = result!.options.find((o) => o.label === "names")!;
    // Fixed-arity `(list a b)` → `[A, B]` under PRE (list.d.ts apply overloads).
    expect(names.detail).toMatch(/^\[string,\s*string\]$|^List<string>$/);
    // The signature is already inline — a signature-only side panel would be a
    // duplicate tooltip. Fitting entries carry NO info…
    expect(names.info).toBeUndefined();
    // …demoted entries keep it for the "doesn't fit this slot" note.
    const greet = result!.options.find((o) => o.label === "greet")!;
    expect(typeof greet.info).toBe("function");
    expect(result!.commitCharacters).toEqual([" ", ")"]);
  });

  it("right after `(` the special forms are SNIPPETS (template apply), elsewhere bare", async () => {
    const headResult = await resultAt(`${PROG}(de`, `${PROG}(de`.length);
    const headDefine = headResult!.options.find((o) => o.label === "define")!;
    expect(typeof headDefine.apply).toBe("function"); // snippetCompletion → function apply
    const topResult = await resultAt(`${PROG}de`, `${PROG}de`.length);
    const topDefine = topResult!.options.find((o) => o.label === "define")!;
    expect(topDefine.apply).toBeUndefined(); // bare keyword inserts its label
  });

  it("empty prefix is the GHOST's moment — the unprompted popup stays quiet", async () => {
    // (the inline ghost serves the narrowed-slot preview; see ghost.test.ts)
    expect(await resultAt(`${PROG}(car `, `${PROG}(car `.length, false)).toBeNull();
    expect(await resultAt(`${PROG}`, PROG.length, false)).toBeNull();
  });

  it("explicit invocation at an empty prefix still brings the full sectioned list", async () => {
    const doc = `${PROG}(car `;
    const result = await resultAt(doc, doc.length, true);
    expect(result).not.toBeNull();
    const names = result!.options.find((o) => o.label === "names")!;
    expect((names.section as { name: string }).name).toBe("fits this slot");
  });
});
