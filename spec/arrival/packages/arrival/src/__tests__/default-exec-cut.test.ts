/**
 * Ejection P3 3b.3 step 5 — the FLIP witnesses for the DEFAULT (no-env) exec path.
 *
 * Stage C Cut 2 (docs/plans/stage-c-corpse-deletion.md, "THE LINCHPIN") supersedes this file's
 * ORIGINAL premise: a bare `exec(code)` no longer resolves through `new Resolver(lexicalRoot,
 * Capabilities.assembled(user_env))` (the realm-parented ambient) — it rides the SELF-HOSTED
 * vocabulary path (`execStateViaVocabulary`, `eval/generator-exec.ts`), the degenerate tuple
 * `buildVocabulary(BASE_ROSTER)` (`env/base-roster.ts`). THE CORNERSTONE (ledger): ambient and
 * global/lexical scope are separate SPECIES — a mutable realm frame playing double duty (defines
 * ACCUMULATING across unrelated bare-exec calls, purely because they happened to share one
 * process-wide singleton) was the hermetic violation this cut retires, not a feature worth preserving.
 *
 * Two properties this file now pins instead:
 *   1. ISOLATION — two SEPARATE bare `exec` calls do NOT share top-level defines (each gets its
 *      own fresh, null-rooted scope, `LexicalScope.fresh()`) — the direct behavioral flip from
 *      this file's original "cross-exec persistence" pin (verified failing against the pre-Cut-2
 *      build as this cut's own probe: `(define x 1)` in one bare exec WAS visible to a second,
 *      unrelated bare exec).
 *   2. CONTINUITY — a caller wanting REPL-style accumulation across calls passes `scope`
 *      explicitly (`ExecOptions.scope`, `LexicalScope.for(env)`/`LexicalScope.fresh()`) — the
 *      sanctioned channel, unaffected by the isolation change.
 *   3. THE CUT (still true, unchanged): user defines never land on `user_env` — builtins still
 *      resolve through the self-hosted vocabulary's own chain, not a lexical write.
 *
 * STAGE C CUT 3b: the public glass option (`ExecOptions.env`) this file's original header
 * referenced is gone entirely — every caller, custom-env or not, is now on this same
 * self-hosted vocabulary path.
 */
import { describe, expect, it } from "vitest";

import { exec, execState } from "../eval/generator-exec.js";
import { LexicalScope } from "../eval/LexicalScope.js";
import { toJS } from "../membrane/rosetta.js";

describe("default exec — Stage C Cut 2 isolation", () => {
  it("two SEPARATE bare exec calls do NOT share top-level defines (no cross-exec leakage)", async () => {
    await exec("(define cut-isolation-witness 41)");
    await expect(exec("cut-isolation-witness")).rejects.toThrow(/unbound/i);
  });

  it("continuity via an explicit `scope` still works (the sanctioned REPL channel)", async () => {
    const scope = LexicalScope.fresh();
    await exec("(define cut-continuity-witness 41)", { scope });
    const [v] = await exec("(+ cut-continuity-witness 1)", { scope });
    expect(v).toBe(42);
  });

  it("continuity via a reused `runCtx` alone (no `scope`) does NOT share top-level defines — only", async () => {
    // `runCtx` reuse threads capability RESOURCES (a database handle, a require cache — see
    // `ExecOptions.runCtx`'s own doc); it is not a lexical-continuity channel. Only `scope`
    // is. Documented here so the distinction is a pinned fact, not tribal knowledge.
    const first = await execState("(define cut-runctx-only-witness 41)");
    await expect(exec("cut-runctx-only-witness", { runCtx: first.runCtx })).rejects.toThrow(/unbound/i);
  });

  it("default-path defines land in a fresh per-call scope; builtins still resolve through the self-hosted vocabulary chain", async () => {
    await exec("(define cut-leak-witness 7)");
    // The define landed in a fresh, null-rooted per-call scope — invisible to a later,
    // unrelated bare exec (the realm-singleton `user_env` this test used to probe against is
    // gone entirely, Stage C Cut 3b — there is no shared capability-base frame left to check).
    await expect(exec("cut-leak-witness")).rejects.toThrow(/unbound/i);
    // …yet a builtin still resolves — through the self-hosted vocabulary chain, not any
    // lexical write.
    const [sum] = (await execState("(+ 1 2)")).values;
    expect(toJS(sum, {})).toBe(3);
  });
});
