// require-support — `(require "path")` resolution through the lens.
//
// The seam: `resolveModule(path) => source | null` keeps the lens filesystem-
// blind; the require closure is emitted AHEAD of the program in one virtual
// module (scheme's load-into-scope semantics). What this suite pins:
//   • required defines RESOLVE (no more unknown-name suggestion) and TYPE-FLOW
//     (a misuse of a required value bites in THIS buffer);
//   • completions surface required names; hover renders their types;
//   • goto-def crosses files ({file, span-in-that-file});
//   • problems INSIDE a required file roll up into ONE summary on the require
//     form — never mis-spanned squiggles in this buffer;
//   • scheme-legal redefinition (in-file and program-shadows-required) never
//     errors; cycles and unresolvable paths degrade softly.
//
// Per `.claude/rules/tests.md` this is a `__tests__/` verdict (boolean pass/fail).

import { describe, expect, it } from "vitest";

import { createSchemeLanguageService } from "../language-service.js";
import { scanRequires } from "../service-core.js";

const FILES: Record<string, string> = {
  "lib/util.scm": `(define greeting "hello")\n(define (shout s) (string-append s "!"))\n(define base-port 8080)\n(define ports (list 80 443))`,
  "lib/nested.scm": `(require "lib/util.scm")\n(define (greet-loud name) (shout (string-append greeting " " name)))`,
  // Real type errors (not car — car sugarcoats to [0] and no longer bites on scalars).
  "lib/broken.scm": `(define bad (+ 5 "x"))\n(define worse (* "a" 2))`,
  "lib/cycle-a.scm": `(require "lib/cycle-b.scm")\n(define from-a 1)`,
  "lib/cycle-b.scm": `(require "lib/cycle-a.scm")\n(define from-b 2)`,
};

const ls = createSchemeLanguageService({
  compilerOptions: { noImplicitAny: false },
  resolveModule: (path) => FILES[path] ?? null,
});

describe("scanRequires — the reader-true require scanner", () => {
  it("finds top-level requires with spans; ignores strings/comments/non-top", () => {
    const src = `; (require "commented.scm")\n(require "a.scm")\n(define s "(require \\"fake.scm\\")")\n(require "b.scm")`;
    const refs = scanRequires(src);
    expect(refs.map((r) => r.path)).toEqual(["a.scm", "b.scm"]);
    expect(src.slice(refs[0]!.span.start, refs[0]!.span.start + refs[0]!.span.length)).toBe(`(require "a.scm")`);
  });
});

describe("required defines in scope", () => {
  it("a required name resolves — no unknown-name suggestion, and types FLOW", () => {
    const scheme = `(require "lib/util.scm")\n(define loud (shout greeting))`;
    expect(ls.getSemanticDiagnostics(scheme)).toHaveLength(0);
  });

  it("misusing a required value bites IN THIS BUFFER with the right span", () => {
    // Required VALUE types flow; a string cannot go into a number slot.
    // (car sugarcoats to [0] — use + so the slot is a real declare-function param.)
    const scheme = `(require "lib/util.scm")\n(define bad (+ greeting 1))`;
    const diags = ls.getSemanticDiagnostics(scheme);
    expect(diags).toHaveLength(1);
    expect(scheme.slice(diags[0]!.start, diags[0]!.start + diags[0]!.length)).toBe("greeting");
    expect(diags[0]!.severity).toBe("error");
  });

  it("transitive requires resolve (nested file's own require chain)", () => {
    const scheme = `(require "lib/nested.scm")\n(define x (greet-loud "ada"))`;
    expect(ls.getSemanticDiagnostics(scheme)).toHaveLength(0);
  });

  it("hover on a required name renders its (literal-precise) type", () => {
    const scheme = `(require "lib/util.scm")\n(define loud (shout greeting))`;
    const info = ls.getQuickInfoAtPosition(scheme, scheme.lastIndexOf("greeting") + 1);
    expect(info?.displayText).toBe(`const greeting: "hello"`);
  });

  it("required names surface in completions", () => {
    const scheme = `(require "lib/util.scm")\n(sho`;
    const names = ls.getCompletionsAtPosition(scheme, scheme.length).map((e) => e.name);
    expect(names).toContain("shout");
    expect(names).toContain("greeting");
  });
});

describe("cross-file goto-def", () => {
  it("a required name's definition carries {file, span in THAT file}", () => {
    const scheme = `(require "lib/util.scm")\n(define loud (shout greeting))`;
    const defs = ls.getDefinitionAtPosition(scheme, scheme.lastIndexOf("greeting") + 1);
    const cross = defs.find((d) => d.file !== undefined);
    expect(cross?.file).toBe("lib/util.scm");
    const target = FILES["lib/util.scm"]!;
    const text = target.slice(cross!.span!.start, cross!.span!.start + cross!.span!.length);
    expect(text).toContain("greeting"); // the define form (or its token) in util.scm
  });

  it("an in-buffer definition stays file-less", () => {
    const scheme = `(require "lib/util.scm")\n(define mine 1)\n(define two mine)`;
    const defs = ls.getDefinitionAtPosition(scheme, scheme.lastIndexOf("mine") + 1);
    expect(defs.some((d) => d.span !== null && d.file === undefined)).toBe(true);
  });
});

describe("dep problems roll up; never mis-span", () => {
  it("a broken required file → ONE summary warning ON the require form", () => {
    const scheme = `(require "lib/broken.scm")\n(define ok 1)`;
    const diags = ls.getSemanticDiagnostics(scheme);
    expect(diags).toHaveLength(1);
    const d = diags[0]!;
    expect(d.severity).toBe("warning");
    expect(scheme.slice(d.start, d.start + d.length)).toBe(`(require "lib/broken.scm")`);
    expect(d.messageText).toContain("2 type errors");
  });

  it("calling a clean required helper does NOT invent dep type errors", () => {
    // Repro class: util alone is clean; consumer calls avg/string-concat → used to
    // roll up "required file has N type errors" from (a) apply(+ List) readonly
    // mismatch and (b) rest-param call-site infer writing `...items: "a"`.
    const FILES_LOCAL: Record<string, string> = {
      ...FILES,
      "lib/helpers.scm":
        `(define (avg xs) (if (null? xs) 0 (/ (apply + xs) (length xs))))\n` +
        `(define (string-concat sep . items) (apply string-append items))\n`,
    };
    const local = createSchemeLanguageService({
      compilerOptions: { noImplicitAny: false },
      resolveModule: (path) => FILES_LOCAL[path] ?? null,
    });
    const avgOnly = `(require "lib/helpers.scm")\n(define y (avg (list 1 2 3)))`;
    expect(local.getSemanticDiagnostics(avgOnly).filter((d) => d.code === 0)).toHaveLength(0);
    expect(local.getSemanticDiagnostics(avgOnly)).toHaveLength(0);

    const concatCall = `(require "lib/helpers.scm")\n(define y (string-concat "," "a" "b"))`;
    const concatDiags = local.getSemanticDiagnostics(concatCall);
    expect(concatDiags.filter((d) => d.messageText.includes("required file"))).toHaveLength(0);
  });
});

describe("scheme-legal shapes stay legal", () => {
  it("program redefining a required name is NOT an error (shadowing)", () => {
    const scheme = `(require "lib/util.scm")\n(define greeting "hi")\n(define x (shout greeting))`;
    expect(ls.getSemanticDiagnostics(scheme)).toHaveLength(0);
  });

  it("in-file redefinition is NOT an error", () => {
    const scheme = `(define x 1)\n(define x 2)`;
    expect(ls.getSemanticDiagnostics(scheme)).toHaveLength(0);
  });

  it("require cycles terminate and both sides resolve", () => {
    const scheme = `(require "lib/cycle-a.scm")\n(define s (+ from-a from-b))`;
    expect(ls.getSemanticDiagnostics(scheme)).toHaveLength(0);
  });

  it("an unresolvable path degrades softly (names stay suggestions)", () => {
    const scheme = `(require "lib/nope.scm")\n(define x (ghost-fn 1))`;
    const diags = ls.getSemanticDiagnostics(scheme);
    expect(diags).toHaveLength(1);
    expect(diags[0]!.severity).toBe("suggestion");
    expect(diags[0]!.messageText).toContain("'ghost-fn'");
    expect(diags[0]!.messageText).toContain("its `require`s");
  });
});

describe("the loop stays closed through requires", () => {
  it("Σ∩T verdicts cover REQUIRED candidates (the probe rides the closure)", () => {
    // (string-append •) wants a string: required `greeting` fits; required
    // `base-port` (a number) is proven out. (car sugarcoats to [0] — no typed
    // call slot — so the probe rides a declare-function leaf.)
    const scheme = `(require "lib/util.scm")\n(string-append `;
    const ctx = ls.getCompletionContext(scheme, scheme.length);
    expect(ctx.position).toBe("argument");
    const byName = new Map(ctx.entries.map((e) => [e.name, e]));
    expect(byName.get("greeting")?.fits).toBe(true);
    // A list is never a string-append argument (scalar string slot).
    expect(byName.get("ports")?.fits).toBe(false);
  });
});

describe("compose/pipe pipeline generics (I/O over A)", () => {
  it("(compose :state last :versions) alone is clean — no unknown-index cry", () => {
    const scheme = `(define state-of (compose :state last :versions))`;
    expect(ls.getSemanticDiagnostics(scheme)).toHaveLength(0);
    const info = ls.getQuickInfoAtPosition(scheme, scheme.indexOf("state-of") + 1);
    expect(info?.displayText).toMatch(/extends/);
    expect(info?.displayText).toMatch(/versions/);
  });

  it("a typed call site refines the return; a wrong call bites on the arg", () => {
    const good =
      `(define state-of (compose :state last :versions))\n` +
      `(define p (dict :versions (list (dict :state "a"))))\n` +
      `(define s (state-of p))`;
    expect(ls.getSemanticDiagnostics(good)).toHaveLength(0);

    const bad = `(define state-of (compose :state last :versions))\n` + `(define s (state-of 1))`;
    const diags = ls.getSemanticDiagnostics(bad);
    expect(diags).toHaveLength(1);
    expect(bad.slice(diags[0]!.start, diags[0]!.start + diags[0]!.length)).toBe("1");
    expect(diags[0]!.code).toBe(2345);
  });

  it("(pipe :versions last :state) matches compose (LTR vs RTL)", () => {
    const scheme = `(define f (pipe :versions last :state))`;
    expect(ls.getSemanticDiagnostics(scheme)).toHaveLength(0);
  });
});

describe("usage-based parameter inference (V's infer-from-consumers)", () => {
  it("the canonical example: (concat str1 str2) infers both params from string-append", () => {
    const prog = `(define (concat str1 str2) (string-append str1 "/" str2))\n`;
    const info = ls.getQuickInfoAtPosition(`${prog}(concat `, prog.length + 4);
    expect(info?.displayText).toBe("const concat: (str1: string, str2: string) => string");
    const bad = `${prog}(define x (concat 5 "b"))`;
    const diags = ls.getSemanticDiagnostics(bad);
    expect(diags).toHaveLength(1);
    expect(bad.slice(diags[0]!.start, diags[0]!.start + diags[0]!.length)).toBe("5");
  });

  it("numeric flows infer too: (double n) via (* n 2)", () => {
    const prog = `(define (double n) (* n 2))\n(define y (double "x"))`;
    const diags = ls.getSemanticDiagnostics(prog);
    expect(diags).toHaveLength(1);
    expect(prog.slice(diags[0]!.start, diags[0]!.start + diags[0]!.length)).toBe(`"x"`);
  });

  it("inference works through REQUIRES (a required fn's call-site bites)", () => {
    const scheme = `(require "lib/util.scm")\n(define x (shout 42))`;
    const diags = ls.getSemanticDiagnostics(scheme);
    expect(diags).toHaveLength(1);
    expect(scheme.slice(diags[0]!.start, diags[0]!.start + diags[0]!.length)).toBe("42");
  });

  it("conflicting use sites stay unannotated — never a wrong annotation", () => {
    // p flows into BOTH a number slot (* p 2) and a string slot (string-append … p):
    // contradictory evidence → conservative any, no false bite on either call.
    const prog = `(define (weird p) (string-append (number->string (* p 2)) p))\n(define a (weird 1))\n(define b (weird "x"))`;
    expect(ls.getSemanticDiagnostics(prog)).toHaveLength(0);
  });

  it("require-closure spans stay exact after annotation shifting", () => {
    // The annotation inserts text into DEP segments too — cross-file goto-def
    // must still lift onto the right atoms of the required file.
    const scheme = `(require "lib/util.scm")\n(define loud (shout greeting))`;
    const defs = ls.getDefinitionAtPosition(scheme, scheme.lastIndexOf("greeting") + 1);
    const cross = defs.find((d) => d.file !== undefined);
    expect(cross?.file).toBe("lib/util.scm");
    const target = FILES["lib/util.scm"]!;
    expect(target.slice(cross!.span!.start, cross!.span!.start + cross!.span!.length)).toContain("greeting");
  });
});
