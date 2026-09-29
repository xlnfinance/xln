// srfi-26-symbol-define.test.ts — W4 pack migration rows for `scheme/srfi-26`
// (docs/design-history/symbol-define-static-program-validation.md §1/§2.1/§3.4/§4).
//
// `cut`/`cute` are the spec's own named hard case for the §2.1 bake FV law (rev 2's
// "second live catch, macro-flavored"): their expansions introduce the placeholder
// tokens `<>`/`<...>`, which a naive walk would treat as ordinary references. Four
// rows, matching the pack's migration checklist:
//
//   1. cut/cute expansion equivalence — semantic behavior identical to the pre-
//      migration `define-macro` prelude (§4.2's "semantic equivalence, not byte-
//      identity" gate), including cut's per-call re-evaluation vs cute's once-only
//      specialization-time evaluation (SRFI-26's whole reason to exist).
//   2. a contract-enforcement row — for THIS pack, the honest content is the
//      ABSENCE of enforcement: `symbol.defineSyntax` is contract-FREE by design
//      (§1.1 — a macro has no call-boundary contract), so the row pins that cut/cute
//      never grew an `in`/`out` vector migration would have wrongly bolted on if the
//      pack were decomposed with the WRONG factory (`symbol.define` instead of
//      `symbol.defineSyntax`).
//   3. the §2.1 bake FV law passes for this pack — lowering `scheme/srfi-26` alone,
//      with zero declared deps, never throws `DefineLocalityError`/
//      `DefineForwardReferenceError`/`ProvenanceRoleShapeError`. (Bake-time: a
//      `symbol.defineSyntax` body is never FV-walked at all — `<>`/`<...>`/`gensym`/
//      `car`/… inside cut/cute's OWN implementation are expansion-time names, a
//      different question from §1.1 — so this also stands as the regression pin
//      that fact stays true.)
//   4. the §3 static validator does not false-positive on `(cut list <> 2)` — the
//      declared `macroAttribute: "opaque"` firewalls the `<>` slot from ever being
//      walked as a free-variable reference (companion to the shared
//      `static-validation.law.test.ts` LAW 4 row, which pins the same fact for
//      `(cut cons <> 1)` against the DEFAULT assembled base).
import { describe, expect, it } from "vitest";
import type { AEntity } from "../../../common/symbols/_bake.js";
import { EnvCapability } from "../../../common/capability.js";
import { exec, execOverFrame, execInFrame } from "../../../eval/generator-exec.js";
import { applyCapability, freshEnv } from "../../../__tests__/_fresh-env.js";
import { buildVocabulary } from "../../vocabulary.js";
import { DefineForwardReferenceError, DefineLocalityError, ProvenanceRoleShapeError } from "../../../errors.js";
import srfi26 from "../srfi-26.js";
import type { ResolvingAmbient } from "../../AmbientRuntime.js";
import { harvestContracts } from "../../../__tests__/_symbols-harvest.js";

// Mirrors `_fresh-env.ts`'s own injected evalScheme — `skipBootstrapWait` because
// these execs run against an env this suite is itself assembling/re-lowering onto,
// not the shared realm-cached bootstrap.
const evalScheme = (env: unknown, src: unknown): unknown => execInFrame(src as string, env as ResolvingAmbient);

describe("scheme/srfi-26 — cut/cute expansion equivalence (semantic-equivalence gate, §4.2)", () => {
  it("cut: builds a positional-slot closure — `(cut cons <> 1)` applied to 0", async () => {
    const [result] = await exec("((cut cons <> 1) 0)");
    expect(result).toEqual([0, 1]); // (0 . 1) — toJS's pair→JS-tuple convention
  });

  it("cut: multiple slots stay in call order — `(cut list 1 <> 3)` applied to 2", async () => {
    const [result] = await exec("((cut list 1 <> 3) 2)");
    expect(result).toEqual([1, 2, 3]);
  });

  it("cut: `<...>` is a final rest slot — `(cut list <...>)` applied to 1 2 3", async () => {
    const [result] = await exec("((cut list <...>) 1 2 3)");
    expect(result).toEqual([1, 2, 3]);
  });

  it("cut: a positional slot AND a rest slot compose — `(cut list <> <...>)`", async () => {
    const [result] = await exec("((cut list <> <...>) 1 2 3)");
    expect(result).toEqual([1, 2, 3]);
  });

  it("cute: identical positional-slot RESULT to cut for the pure case", async () => {
    const [result] = await exec("((cute cons <> 1) 0)");
    expect(result).toEqual([0, 1]);
  });

  it("cut re-evaluates a non-slot subexpression on EVERY call; cute evaluates it ONCE at specialization", async () => {
    const env = await freshEnv();
    let calls = 0;
    const cap = EnvCapability.define("test/srfi-26-cute-once", {
      symbols: (symbol, z) => ({
        "bump!": symbol.rosetta`bump!: JS-side call counter`({ input: [], output: [z.number] }, () => ++calls),
      }),
    });
    await applyCapability(env, [cap]);

    // cut: (bump!) is NOT a slot — it stays in the lambda body, re-evaluating per call.
    calls = 0;
    await execOverFrame("(define cut-closure (cut list (bump!) <>))", { env });
    expect(calls).toBe(0); // building the closure does not itself call bump!
    await execOverFrame("(cut-closure 1)", { env });
    await execOverFrame("(cut-closure 2)", { env });
    expect(calls).toBe(2); // once PER CALL

    // cute: (bump!) is lifted into a `let` around the lambda — evaluates ONCE, at
    // specialization time (when the closure is built), never again per call. This
    // is SRFI-26's entire reason cute exists.
    calls = 0;
    await execOverFrame("(define cute-closure (cute list (bump!) <>))", { env });
    expect(calls).toBe(1); // specialization itself ran the expensive expr, once
    await execOverFrame("(cute-closure 1)", { env });
    await execOverFrame("(cute-closure 2)", { env });
    expect(calls).toBe(1); // still just once — never re-runs per call
  });
});

describe("scheme/srfi-26 — the contract-enforcement row: cut/cute are contract-FREE by design (§1.1)", () => {
  it("both baked defs are `define-syntax` kind — no `in`/`out` contract vector exists to enforce", () => {
    const symbols = harvestContracts(srfi26.spec.symbols);
    for (const name of ["cut", "cute"]) {
      const def = symbols[name];
      expect(def, `srfi-26 pack: no symbol named ${name}`).toBeDefined();
      expect(def.kind).toBe("define-syntax");
      expect(def).not.toHaveProperty("in");
      expect(def).not.toHaveProperty("out");
    }
  });

  it('both declare `macroAttribute: "opaque"` explicitly — the <>-slot reasoning, not the bare factory default', () => {
    const symbols = srfi26.spec.symbols as Record<string, AEntity & { macroAttribute?: string }>;
    expect(symbols.cut.macroAttribute).toBe("opaque");
    expect(symbols.cute.macroAttribute).toBe("opaque");
  });

  it("passing a non-symbol where `<>` could go is NOT a contract violation — it is an ordinary captured call arg (no z.decode boundary exists for a macro)", async () => {
    // `5`/`"x"` are plain non-slot subexpressions here (`<>` is matched by identity
    // against the literal symbol, never by a schema check) — cut just closes over
    // them as ordinary call-form elements. Nothing throws; there is no contract to
    // violate because macros carry none.
    const [result] = await exec('((cut list 5 "x") )');
    expect(result).toEqual([5, "x"]);
  });
});

describe("scheme/srfi-26 — the §2.1 bake FV law passes (baked standalone, zero declared deps)", () => {
  it("bakes cleanly with NO deps declared — never DefineLocalityError/DefineForwardReferenceError/ProvenanceRoleShapeError", async () => {
    await expect(buildVocabulary([srfi26], undefined, evalScheme)).resolves.not.toThrow();
  });

  it("(regression pin) none of the FV/forward-ref/role drift doors fire for this pack's real bake", async () => {
    try {
      await buildVocabulary([srfi26], undefined, evalScheme);
    } catch (error) {
      expect(error).not.toBeInstanceOf(DefineLocalityError);
      expect(error).not.toBeInstanceOf(DefineForwardReferenceError);
      expect(error).not.toBeInstanceOf(ProvenanceRoleShapeError);
      throw error; // any OTHER failure is a real regression — surface it
    }
  });
});

describe("scheme/srfi-26 — the §3 static validator does not false-positive on `(cut list <> 2)`", () => {
  it('validates clean and evaluates under `staticValidation: "on"` against the DEFAULT assembled base', async () => {
    const [result] = await exec("((cut list <> 2) 1)", { staticValidation: "on" });
    expect(result).toEqual([1, 2]);
  });

  it("the same holds for cute's `<>` slot", async () => {
    const [result] = await exec("((cute list <> 2) 1)", { staticValidation: "on" });
    expect(result).toEqual([1, 2]);
  });
});
