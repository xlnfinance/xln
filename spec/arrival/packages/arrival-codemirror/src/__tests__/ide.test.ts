// ide — the IDE extensions against the REAL arrival-lsp language service.
//
// The service is a devDep on purpose: at runtime the package only knows the
// structural `SchemeIdeBackend` seam; this suite (a) PINS that the real
// `SchemeLanguageService` stays assignable to the seam (the `backend` const
// below is a compile-time drift guard under `pnpm typecheck`), and (b) proves
// the mappers + completion source lift its answers into CodeMirror shapes —
// headless (EditorState/CompletionContext need no DOM).
//
// Per `.claude/rules/tests.md` this is a `__tests__/` verdict (boolean pass/fail).

import { CompletionContext } from "@codemirror/autocomplete";
import { EditorState } from "@codemirror/state";
import { createSchemeLanguageService } from "@inhuman.tools/arrival-lsp";
import { describe, expect, it } from "vitest";

import {
  classificationsToDecorations,
  schemeCompletionSource,
  toCmCompletions,
  toCmDiagnostics,
  type SchemeIdeBackend,
} from "../ide.js";

// THE drift guard: arrival-lsp's service must satisfy the seam as-is.
const backend: SchemeIdeBackend = createSchemeLanguageService();

describe("toCmDiagnostics — real diagnostics lift into @codemirror/lint shape", () => {
  it("(car 5) → an error squiggle exactly on the `5`", async () => {
    const scheme = `(define z (car 5))`;
    const diags = toCmDiagnostics(await backend.getSemanticDiagnostics(scheme), scheme.length);
    expect(diags).toHaveLength(1);
    const d = diags[0]!;
    expect(scheme.slice(d.from, d.to)).toBe("5");
    expect(d.severity).toBe("error");
    expect(d.source).toBe("scheme-ts(2345)");
    expect(d.message).toContain("not assignable");
  });

  it("clamps a span that overruns the doc (mid-edit safety)", () => {
    const diags = toCmDiagnostics([{ start: 8, length: 100, severity: "warning", code: 1, messageText: "w" }], 10);
    expect(diags[0]).toMatchObject({ from: 8, to: 10, severity: "warning" });
  });

  it("maps suggestion/message severities into 'info'", () => {
    const diags = toCmDiagnostics(
      [
        { start: 0, length: 1, severity: "suggestion", code: 1, messageText: "s" },
        { start: 1, length: 1, severity: "message", code: 2, messageText: "m" },
      ],
      10,
    );
    expect(diags.map((d) => d.severity)).toEqual(["info", "info"]);
  });
});

describe("schemeCompletionSource — completions through the seam, headless", () => {
  const source = schemeCompletionSource(backend);

  const complete = async (doc: string, pos: number, explicit = false) =>
    source(new CompletionContext(EditorState.create({ doc }), pos, explicit));

  it("completes a partial symbol from its start (plumbing: anchor + options)", async () => {
    const scheme = `(define xs (list 1 2 3))\n(car x`;
    const result = await complete(scheme, scheme.length);
    expect(result).not.toBeNull();
    // `from` anchors at the start of the partial atom `x`, so typing filters it.
    expect(result!.from).toBe(scheme.lastIndexOf("x"));
    // WHAT surfaces at a given position is the service's contract (pinned in
    // arrival-lsp's own suite); here we pin that its answers flow through.
    expect(result!.options.length).toBeGreaterThan(0);
    expect(result!.options.every((o) => typeof o.label === "string" && o.label.length > 0)).toBe(true);
  });

  it("stays quiet at a non-symbol position unless explicitly invoked", async () => {
    const scheme = `(car xs) `;
    expect(await complete(scheme, scheme.length)).toBeNull();
  });
});

describe("semantic highlighting — classifications lift into mark decorations", () => {
  it("marks parameter/variable/function use-sites from the real backend", async () => {
    const scheme = `(define (greet name)\n  (string-append "hello, " name))\n(define g (greet "ada"))`;
    const spans = await backend.getSemanticClassifications!(scheme);
    const deco = classificationsToDecorations(spans, scheme.length);
    const marks: { text: string; cls: string }[] = [];
    const cursor = deco.iter();
    while (cursor.value !== null) {
      marks.push({ text: scheme.slice(cursor.from, cursor.to), cls: (cursor.value.spec as { class: string }).class });
      cursor.next();
    }
    expect(marks.some((m) => m.text === "name" && m.cls.includes("cm-scheme-sem-parameter"))).toBe(true);
    expect(marks.some((m) => m.text === "greet" && m.cls.includes("cm-scheme-sem-function"))).toBe(true);
  });

  it("clamps out-of-doc spans instead of throwing", () => {
    const deco = classificationsToDecorations([{ start: 5, length: 100, kind: "variable" }], 8);
    const cursor = deco.iter();
    expect(cursor.from).toBe(5);
    expect(cursor.to).toBe(8);
  });
});

describe("toCmCompletions — kind mapping", () => {
  it("maps ts ScriptElementKinds onto CodeMirror icon types (unknown → variable)", () => {
    const options = toCmCompletions([
      { name: "f", kind: "function", sortText: "1" },
      { name: "k", kind: "const", sortText: "1" },
      { name: "m", kind: "method", sortText: "1" },
      { name: "weird", kind: "no-such-kind", sortText: "1" },
    ]);
    expect(options.map((o) => o.type)).toEqual(["function", "constant", "method", "variable"]);
  });
});
