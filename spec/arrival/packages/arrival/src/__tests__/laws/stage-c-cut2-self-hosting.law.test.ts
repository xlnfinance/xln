/**
 * LAW — Stage C, Cut 2 (docs archaeology: stage-c-corpse-deletion.md, "THE LINCHPIN"): the
 * vocabulary path becomes SELF-HOSTING. THE CORNERSTONE: ambient and global/lexical scope are
 * separate SPECIES — ambient = "exists before program start, static, not attributed to any run"
 * (the frozen `Vocabulary` map); global/top-level scope = an ordinary LEXICAL scope with no
 * parent. Concretely, this cut:
 *
 *   • folds `BASE_ROSTER` (env/base-roster.ts — NATIVE_PACKS + BASE_PACKS) into EVERY vocabulary
 *     tuple (`execStateViaVocabulary`'s `effectiveCapabilities`), so base stdlib symbols are
 *     ordinary members of the tuple's own C3 closure, never resolved by parenting on `user_env`;
 *   • reroutes a bare `exec(code)` (no capabilities, no env, no retired ambient opt-in) onto this SAME
 *     self-hosted path — the degenerate `BASE_ROSTER`-only tuple;
 *   • memoizes the sealed chain ONCE per `Vocabulary` object (`sealedVocabularyChain`,
 *     generator-exec.ts) instead of re-binding it every run;
 *   • gives every run a FRESH, per-call lexical root by default (`LexicalScope.fresh()`) — no
 *     cross-call define leakage the way the pre-Cut-2 realm-cached `defaultLexicalRoot()` had.
 *
 * Four laws:
 *
 *  LAW 1 (bare exec rides vocabulary): a plain `execState(code)` — no options at all — has
 *    `runCtx.vocabulary` defined and resolving a base symbol (`map`); an unbound reference still
 *    teaches (the ordinary unbound-variable door, typo suggestions included).
 *
 *  LAW 2 (isolation + sanctioned continuity): two SEPARATE bare execs never share top-level
 *    defines; passing the SAME `scope` across two calls restores continuity (define in run A,
 *    read in run B, same `scope`).
 *
 *  LAW 3 (shared-chain purity): after a run defines a name, the run's OWN `RunContext.vocabulary`
 *    handle — the SAME frozen map every run sharing this tuple resolves through — never gains
 *    that name; a fresh, unrelated bare exec (a different call, no scope reuse) does not see it
 *    either. Defines land only in the run's OWN lexical scope, never in the shared ambient.
 *
 *  LAW 4 (self-hosted stdlib, no `user_env` parenting): a `{ capabilities: [cap] }` run resolves
 *    BOTH its own capability's symbol AND base stdlib (`map`) through the ONE vocabulary chain;
 *    an honest observable that this is NOT a `user_env`-parented walk — a uniquely-named value
 *    bound directly onto the REAL `user_env` (the in-package storage write, same convention
 *    `resolution-chain.law.test.ts` uses) is invisible to a vocabulary-path run, proving the
 *    chain never falls through to it.
 */
import { describe, expect, it } from "vitest";

import { EnvCapability } from "../../common/capability.js";
import { exec, execState } from "../../eval/generator-exec.js";
import { LexicalScope } from "../../eval/LexicalScope.js";
import { toJS } from "../../membrane/rosetta.js";

describe("LAW 1 — bare exec rides the self-hosted vocabulary path", () => {
  it("execState(code) with no options has runCtx.vocabulary defined and resolves a base symbol", async () => {
    const state = await execState("(map (lambda (x) (+ x 1)) (list 1 2 3))");
    expect(state.runCtx.vocabulary).toBeDefined();
    expect(state.runCtx.vocabulary?.has("map")).toBe(true);
    const [result] = state.values.map((v) => toJS(v, {}));
    expect(result).toEqual([2, 3, 4]);
  });

  it("an unbound reference still teaches (typo suggestion intact)", async () => {
    await expect(exec("(mapp 1 2 3)")).rejects.toThrow(/mapp/);
  });
});

describe("LAW 2 — isolation + sanctioned continuity", () => {
  it("two separate bare execs do NOT share top-level defines", async () => {
    await exec("(define cut2-isolation-witness 111)");
    await expect(exec("cut2-isolation-witness")).rejects.toThrow(/unbound/i);
  });

  it("continuity via an explicit shared `scope` still works", async () => {
    const scope = LexicalScope.fresh();
    await exec("(define cut2-continuity-witness 5)", { scope });
    const [doubled] = await exec("(* cut2-continuity-witness 2)", { scope });
    expect(doubled).toBe(10);
  });
});

describe("LAW 3 — shared-chain purity: run writes never touch the shared vocabulary", () => {
  it("a run's own define never lands in its RunContext.vocabulary (the shared map)", async () => {
    const state = await execState("(define cut2-purity-witness 1)");
    expect(state.runCtx.vocabulary?.has("cut2-purity-witness")).toBe(false);
  });

  it("a fresh, unrelated bare exec never sees a prior run's define (the tuple-level proof)", async () => {
    await exec("(define cut2-purity-cross-run-witness 42)");
    const second = await execState("(+ 1 1)");
    expect(second.runCtx.vocabulary?.has("cut2-purity-cross-run-witness")).toBe(false);
    await expect(exec("cut2-purity-cross-run-witness")).rejects.toThrow(/unbound/i);
  });
});

describe("LAW 4 — self-hosted stdlib: one chain, no user_env parenting", () => {
  it("a { capabilities } run resolves BOTH its own capability's symbol and base stdlib through one chain", async () => {
    const cap = EnvCapability.define("law/cut2-self-hosting", {
      symbols: (symbol, z) => ({
        "cut2/double": symbol.rosetta`cut2/double: doubles a number`(
          { input: [z.number], output: [z.number] },
          (n: number) => n * 2,
        ),
      }),
    });
    const [own, stdlib] = await exec("(cut2/double 21) (map (lambda (x) x) (list 1))", { capabilities: [cap] });
    expect(own).toBe(42);
    expect(stdlib).toEqual([1]);
  });

  // STAGE C CUT 3b: the "a value bound directly onto the real `user_env` is invisible" row is
  // DROPPED — `user_env` (the realm singleton the cornerstone names as the hermetic violation) is
  // retired entirely, not merely unwalked. There is no longer a live frame to bind a leak
  // witness onto at all, so the invariant this row probed is now true by construction (no
  // parenting chain exists to leak through), not something a running program can still observe.
});
