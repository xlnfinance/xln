// syntax-symbol-define-migration.test.ts — W4-H2b pack-migration law rows for
// `scheme/r7rs/syntax` (docs/design-history/symbol-define-static-program-validation.md §4.2). Same narrow shape as r7rs/binding's H1 rows: this pack's
// ENTIRE former `prelude` was three `define-macro` forms (`define-syntax`,
// `let-syntax`, `letrec-syntax`) and nothing else — zero `symbol.define`
// value/procedure defines to migrate, so no Pass-2 contract-authoring rows and
// no "contract enforcement fires" row (N/A, asserted structurally below).
//
//   ROW 1 — structural: the pack declares no `prelude` field; all three forms
//     are `kind: "define-syntax"`, contract-free, `macroAttribute: "binder"`
//     (§3.4's ternary). Unlike r7rs/binding's let-values/let*-values (already
//     the doc's OWN worked binder example), this pack's binder classification
//     is a NEW finding this migration made: each form's FIRST argument
//     position (`name` for define-syntax, `vars` for let-syntax/letrec-syntax)
//     is a binding target, not expression space — see syntax.ts's header for
//     the full per-macro reasoning. None of the three qualify as
//     `"expression"` — a walk-as-ordinary-application would report the
//     binding-target argument unbound on every legal program (the exact
//     false-positive rev 2's boolean→ternary fix exists to close).
//   ROW 2 — bake / FV law: `.lower()` succeeds — no cross-capability `deps`
//     needed (each form aliases a NATIVE special form — define/let/letrec —
//     always in scope, never another capability's export), and
//     `symbol.defineSyntax` bodies carry no §2.1 FV check to trip.
//   ROW 3 — semantic equivalence: `define-syntax`/`let-syntax`/`letrec-syntax`
//     behave byte-for-byte as the pre-migration prelude did — top-scope
//     binding, local non-recursive binding (and its NON-leak past the local
//     scope), and local RECURSIVE binding (a letrec-syntax macro referencing
//     itself in its own expansion — the exact capability letrec's own scoping
//     math is relied on for, per syntax.ts's header — the R7RS point of
//     letrec-syntax vs let-syntax, chibi's own test09-hygiene.scm `myor`
//     worked example, reproduced here with `syntax-rules` since arrival's
//     `er-macro-transformer` support is out of this migration's scope).
//     KNOWN PRE-EXISTING GAP, unaffected by this migration (reproduces
//     byte-for-byte on the pre-migration `define-macro`-prelude form too —
//     verified by hand before writing this file, not asserted here to avoid
//     pinning an unrelated defect to this pack's law suite): MUTUAL recursion
//     between two `letrec-syntax`-bound `syntax-rules` transformers
//     (`my-even?`/`my-odd?` calling each other) overflows the host stack in
//     `eval/syntax-rules.ts`'s `walk` — a macro-expander limitation orthogonal
//     to prelude-vs-declaration, not a regression this migration introduces
//     or is scoped to fix.
//
//     ENV NOTE: this file assembles its own env per test via `freshEnv()`
//     rather than relying on the default (no-`env`) `exec`/`execState` surface's
//     shared `user_env` singleton. At the time this file was written, the
//     shared singleton's assembly threw `AssembleLinearizationError` (a C3
//     merge conflict) — verified NOT caused by this migration (reproduces
//     identically with the pre-migration `prelude`-based capability in place,
//     and identically on an UNRELATED pre-existing suite,
//     `syntax-rules-tail-proper.test.ts`) and traced to `base-packs.ts`
//     mid-reconciliation across concurrently in-flight sibling W4 packs
//     (srfi-8/128/189/43, overridable — each independently repositioning/
//     `deps`-declaring, per the wave's "verified together on the merged tree
//     by the last lander" protocol, H1's own commit message). `freshEnv()`
//     assembles the SAME `BASE_PACKS` set through the SAME `assembleEnv`
//     entry point, just onto a private `global_env.child()` layer instead of
//     the process-wide memoized singleton — behaviorally identical once the
//     singleton's transient conflict resolves, and robust to it either way.
//   ROW 4 — the validator's macro-firewall row still holds: the SAME programs
//     validate clean under `staticValidation: "on"` (no false "unbound" on the
//     `name`/`vars` binding-target positions), and a genuinely-unbound name
//     inside a bound form's body is the documented `binder` blind spot — it
//     surfaces only at runtime, not as a StaticValidationError.
import { describe, expect, it } from "vitest";
import syntaxPack from "../syntax.js";
import { execOverFrame as exec, execInFrame } from "../../../eval/generator-exec.js";
import { StaticValidationError } from "../../../static-validation/validate-program.js";
import { Macro } from "../../../eval/Macro.js";
import { freshEnv } from "../../../__tests__/_fresh-env.js";
import { buildVocabulary } from "../../vocabulary.js";
import type { ResolvingAmbient } from "../../AmbientRuntime.js";

const evalScheme = (env: unknown, src: unknown): unknown => execInFrame(src as string, env as ResolvingAmbient);
import type { AEntity, DefineSyntaxSymbolDef } from "../../../common/symbols/_bake.js";
import { harvestContracts } from "../../../__tests__/_symbols-harvest.js";

const symbols = harvestContracts(syntaxPack.spec.symbols);

function defineSyntaxDef(name: string): DefineSyntaxSymbolDef {
  const def = symbols[name];
  if (def === undefined) throw new Error(`syntax pack: no symbol named ${name}`);
  if (def.kind !== "define-syntax")
    throw new Error(`syntax pack: ${name} is not a define-syntax def (got ${def.kind})`);
  return def;
}

const FORMS = ["define-syntax", "let-syntax", "letrec-syntax"] as const;

// COMPLEX-tier-adjacent convenience: runs `src` against a FRESH capability env
// (see the ENV NOTE above) and returns the LAST top-level form's plain-JS
// value — `exec`'s SIMPLE-tier unwrap (RULINGS.md R1), matching
// binding-symbol-define-migration.test.ts's `run` helper's role, adapted for
// this file's multi-form snippets (define-then-call).
async function last(src: string, opts: { staticValidation?: "on" } = {}): Promise<unknown> {
  const env = await freshEnv();
  const results = await exec(src, { env, ...opts });
  return results[results.length - 1];
}

describe("ROW 1 — structural: prelude is gone, all three macros bake as contract-free define-syntax/binder", () => {
  it("the capability declares no prelude field", () => {
    expect(syntaxPack.spec.prelude).toBeUndefined();
  });

  it("define-syntax / let-syntax / letrec-syntax are kind: define-syntax, macroAttribute: binder", () => {
    for (const name of FORMS) {
      const def = defineSyntaxDef(name);
      expect(def.kind).toBe("define-syntax");
      expect(def.macroAttribute).toBe("binder");
    }
  });

  it("contract enforcement — N/A, asserted structurally: a define-syntax def carries no contract surface", () => {
    // §1.1: defineSyntax is contract-FREE by construction. There is no
    // `symbol.define` in this pack to run the "contract enforcement fires" row
    // against — this asserts the N/A rather than leaving it silently unchecked:
    // no def exposes `in`/`out`/`callable`/`validate` (the DefineSymbolDef-only
    // fields).
    for (const name of FORMS) {
      const def = defineSyntaxDef(name);
      expect("in" in def).toBe(false);
      expect("out" in def).toBe(false);
      expect("callable" in def).toBe(false);
      expect("validate" in def).toBe(false);
    }
  });
});

describe("ROW 2 — bake / FV law: the vocabulary builds, all three macros bind as Macro values with the stamped attribute", () => {
  it("a bare vocabulary build (no deps — each form aliases a native special form, not another capability's export) does not throw", async () => {
    await expect(buildVocabulary([syntaxPack], undefined, evalScheme)).resolves.not.toThrow();
  });

  it("bound values are Macro instances carrying macroAttribute: binder (the W3 read-back channel, §3.4)", async () => {
    const env = await freshEnv();
    for (const name of FORMS) {
      const bound = env.get(name);
      expect(bound).toBeInstanceOf(Macro);
      expect((bound as Macro).macroAttribute).toBe("binder");
    }
  });
});

describe("ROW 3 — semantic equivalence: unchanged runtime behavior vs. the pre-migration prelude", () => {
  it("define-syntax binds a transformer at TOP scope", async () => {
    expect(await last("(define-syntax sq (syntax-rules () ((_ x) (* x x)))) (sq 6)")).toBe(36);
  });

  it("let-syntax binds a transformer LOCALLY, non-recursively", async () => {
    expect(await last("(let-syntax ((sq (syntax-rules () ((_ x) (* x x))))) (sq 5))")).toBe(25);
  });

  it("let-syntax binding does not leak outside its scope", async () => {
    const env = await freshEnv();
    let caught: unknown;
    try {
      await exec("(begin (let-syntax ((sq (syntax-rules () ((_ x) (* x x))))) (sq 5)) (sq 7))", { env });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeDefined();
  });

  it("letrec-syntax allows a macro to reference ITSELF in its own expansion (recursive scoping, the whole point of letrec vs let)", async () => {
    const src = `
      (letrec-syntax ((my-or (syntax-rules ()
                                ((_) #f)
                                ((_ e) e)
                                ((_ e1 e2 ...) (let ((t e1)) (if t t (my-or e2 ...)))))))
        (my-or #f #f 3))`;
    expect(await last(src)).toBe(3);
  });
});

describe("ROW 4 — the validator's macro-firewall row still holds (binder positions never false-positive)", () => {
  it("define-syntax's `name` does not report unbound under staticValidation: on", async () => {
    expect(await last("(define-syntax sq (syntax-rules () ((_ x) (* x x)))) (sq 6)", { staticValidation: "on" })).toBe(
      36,
    );
  });

  it("let-syntax's `vars` claw names do not report unbound under staticValidation: on", async () => {
    expect(await last("(let-syntax ((sq (syntax-rules () ((_ x) (* x x))))) (sq 5))", { staticValidation: "on" })).toBe(
      25,
    );
  });

  it("letrec-syntax's `vars` claw names — including the SELF-reference — do not report unbound under staticValidation: on", async () => {
    const src = `
      (letrec-syntax ((my-or (syntax-rules ()
                                ((_) #f)
                                ((_ e) e)
                                ((_ e1 e2 ...) (let ((t e1)) (if t t (my-or e2 ...)))))))
        (my-or #f #f 3))`;
    expect(await last(src, { staticValidation: "on" })).toBe(3);
  });

  it("a GENUINELY unbound name inside a let-syntax-bound macro's template is the documented `binder` blind spot (§3.4 LIMIT) — NOT a StaticValidationError; it surfaces only at runtime, the backstop", async () => {
    const env = await freshEnv();
    let caught: unknown;
    try {
      await exec("(let-syntax ((m (syntax-rules () ((_ x) (totally-unbound-name-xyz x))))) (m 5))", {
        env,
        staticValidation: "on",
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeDefined();
    // Under-report, never lie (§3.4's own framing): the whole call is firewalled
    // as one unit under `binder` (no per-macro binding-position metadata yet), so
    // the template's OWN genuinely-unbound reference is invisible to the static
    // pass too — it is not a StaticValidationError, it is the ordinary runtime
    // unbound-variable throw (the LIMIT's "backstop").
    expect(caught).not.toBeInstanceOf(StaticValidationError);
  });
});
