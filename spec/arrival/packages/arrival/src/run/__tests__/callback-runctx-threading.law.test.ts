/**
 * LAW W0 — for-each/member/assoc callbacks observe the run's REAL RunContext
 * (the CONSTANT_CTX audit §2.1, the audit's "fires today" bug; §4 Wave 0).
 *
 * Before this wave, `env/r7rs/lists.ts`'s `for-each` (via `mapImpl`), `member`, and
 * `assoc` invoked their user-supplied callback through `call_function(fn, args, {})` —
 * the empty options object let `runCtx` come through as `undefined`, and
 * `call_function` used to paper over that with `runCtx ?? CONSTANT_CTX`
 * (eval/call-function.ts). Every callback therefore ran under CONSTANT_CTX
 * (`strict: false`, no abort signal, invisible to cache/effects) —
 * regardless of what the enclosing run actually configured. `call_function`'s `runCtx`
 * is now a REQUIRED option, and `for-each`/`member`/`assoc` are `function(this: CallCtx,
 * …)` (not arrows) threading `this.runCtx` through explicitly.
 *
 * `<` (env/r7rs/numeric.ts's `looseCompare`) reads `this.runCtx.strict` DIRECTLY — a
 * real native procedure, not a Scheme lambda (a lambda's body still evaluates against
 * its own DEFINITION-time ctx; call-time runCtx threading into a lambda body is a
 * separate, not-yet-closed gap — see evaluator.ts's `evalLambda` comment). Passing `<`
 * AS THE CALLBACK to for-each/member/assoc turns "does the callback see the run's real
 * ctx" into a directly observable behavioral signal: under `strict: true`, `<` throws on
 * non-number operands; in loose (default) mode, two STRINGS resolve via the universal
 * ordering without throwing (mirrors comparison-divergence.test.ts's own loose/strict
 * split for `(< "a" "b")`). If the callback still ran under CONSTANT_CTX
 * (`strict: false` baked in, no matter what the run asked for), a strict-mode run would
 * never observe the throw — exactly the silent drop this wave closes.
 */
import { describe, expect, it } from "vitest";
import { exec } from "../../eval/generator-exec.js";

const CASES: readonly [name: string, code: string][] = [
  ["member", `(member "b" (list "a") <)`],
  ["assoc", `(assoc "b" (list (cons "a" 1)) <)`],
  ["for-each", `(for-each < (list "b") (list "a"))`],
];

describe("W0 callback ctx threading — for-each/member/assoc thread the run's real strict flag into their callback", () => {
  it.each(CASES)(
    "%s: strict:true propagates into the compare/fn callback (throws on non-number operands)",
    async (_name, code) => {
      await expect(exec(code, { strict: true })).rejects.toThrow(/strict mode is R7RS-numeric/);
    },
  );

  it.each(CASES)(
    "%s: loose (default) mode does not throw — the same two comparable strings resolve",
    async (_name, code) => {
      await expect(exec(code)).resolves.toBeDefined();
    },
  );
});
