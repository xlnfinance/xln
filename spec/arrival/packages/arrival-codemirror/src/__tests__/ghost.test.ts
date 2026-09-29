// ghost — the inline Σ∩T preview's pure decision functions, against the real
// service where the verdicts matter.
//
// The view plumbing (debounce, widget, Tab) is exercised live in storybook;
// what the suite pins is the DECISION layer: where a ghost may appear
// (lineTailIsSafe) and what it shows (pickGhost tiers).
//
// Per `.claude/rules/tests.md` this is a `__tests__/` verdict (boolean pass/fail).

import { EditorState } from "@codemirror/state";
import { createSchemeLanguageService } from "@inhuman.tools/arrival-lsp";
import { describe, expect, it } from "vitest";

import { lineTailIsSafe, pickGhost } from "../ghost.js";

const ls = createSchemeLanguageService({ compilerOptions: { noImplicitAny: false } });

const at = (doc: string): { state: EditorState; pos: number } => {
  const pos = doc.indexOf("|");
  return { state: EditorState.create({ doc: doc.replace("|", "") }), pos };
};

describe("lineTailIsSafe — insertion-safety gate", () => {
  it("safe: end of line, before closers, closers+whitespace", () => {
    for (const doc of ["(car |", "(car names|)", "(let ((x 1))|))", "(f |)  ", "(f |) ]"]) {
      const { state, pos } = at(doc);
      expect(lineTailIsSafe(state, pos), doc).toBe(true);
    }
  });

  it("unsafe: anything substantive after the cursor on the line", () => {
    for (const doc of ["(car | names)", "(|car)", '(f |"x")', "(f |;c)"]) {
      const { state, pos } = at(doc);
      expect(lineTailIsSafe(state, pos), doc).toBe(false);
    }
  });

  it("the next LINE doesn't matter — safety is per-line", () => {
    const { state, pos } = at("(car |\n  more)");
    expect(lineTailIsSafe(state, pos)).toBe(true);
  });
});

describe("pickGhost — the tiers, on real verdicts", () => {
  const PROG = `(define (greet name) (string-append "hi " name))\n(define names (list "ada" "grace"))\n`;

  it("empty prefix at a narrowed argument slot → the best FITTING candidate (a local wins)", () => {
    const doc = `${PROG}(car `;
    const ctx = ls.getCompletionContext(doc, doc.length);
    const ghost = pickGhost(ctx.entries, "", ctx.position);
    expect(ghost).toBe("names"); // fitting + local beats fitting builtins
  });

  it("empty prefix anywhere else → no ghost (never guess)", () => {
    const doc = `${PROG}(`;
    const ctx = ls.getCompletionContext(doc, doc.length);
    expect(pickGhost(ctx.entries, "", ctx.position)).toBeNull();
  });

  it("typed prefix → best extension; proven-unfit candidates never ghost", () => {
    const doc = `${PROG}(car gr`;
    const ctx = ls.getCompletionContext(doc, doc.length);
    // `greet` (string-returning) is proven unfit at car's slot; `greetings`
    // doesn't exist here — nothing fits with this prefix → null, not a lie.
    expect(pickGhost(ctx.entries, "gr", ctx.position)).toBeNull();
  });

  it("typed prefix with a fitting extension ghosts it", () => {
    const doc = `${PROG}(car na`;
    const ctx = ls.getCompletionContext(doc, doc.length);
    expect(pickGhost(ctx.entries, "na", ctx.position)).toBe("names");
  });

  it("a prefix equal to the full symbol is no ghost", () => {
    const doc = `${PROG}(car names`;
    const ctx = ls.getCompletionContext(doc, doc.length);
    expect(pickGhost(ctx.entries, "names", ctx.position)).toBeNull();
  });
});
