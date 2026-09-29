// do / while / try / define-macro — the four SPECIAL_FORMS entries that were still
// missing a `symbol.keyword` binding after the let*/letrec/letrec*/and/or hygiene fix
// (core.ts). Same mechanism as that fix and as control-forms-keywords.test.ts /
// kernel-keyword-dispatch.test.ts: syntax-rules.ts's `rename()` hygiene-renames a free
// template identifier to a gensym, copying the identifier's ENV VALUE onto the gensym
// IF ONE EXISTS. A name-only special form (no `symbol.keyword` binding) has no env
// value to copy, so the renamed head resolves to nothing and `evaluatePair`'s
// string-keyed `SPECIAL_FORMS[symbol_name(first)]` fallback misses too (a gensym's
// `symbol_name` reads its JS-Symbol description, e.g. "#:do", never "do") — the exact
// "Unbound variable `Symbol(#:do)`" shape the let* fix cured for the other five forms.
//
// Each case here is a `define-syntax`/`syntax-rules` macro whose TEMPLATE expands to a
// literal `(do …)` / `(while …)` / `(try …)` / `(define-macro …)` form — the form head
// is a macro-introduced identifier (not user-supplied via a pattern variable), so it is
// exactly the hygiene-renamed path the fix targets.
import { describe, expect, it } from "vitest";
import { execOverFrame as exec } from "../../eval/generator-exec.js";
// In-package test: internal-module access (the barrel export retired — privatization V5).
import { inferenceEnv as sandboxedEnv } from "../../env/inference-env.js";

// `exec` already unwraps via `toJS`.
const val = (rs: readonly unknown[]) => rs[rs.length - 1];

describe("do/while/try/define-macro — hygiene-renamed heads resolve via symbol.keyword", () => {
  it("user syntax-rules macro expanding to `do` resolves the keyword", async () => {
    const src = `
      (define-syntax sum-to
        (syntax-rules ()
          ((sum-to n) (do ((i 0 (+ i 1)) (acc 0 (+ acc i))) ((= i n) acc)))))
      (sum-to 5)`;
    expect(val(await exec(src, { env: sandboxedEnv.child("dw1") }))).toBe(10);
  });

  it("user syntax-rules macro expanding to `while` resolves the keyword", async () => {
    const src = `
      (define-syntax loop-if
        (syntax-rules ()
          ((loop-if test) (while test 'never-runs))))
      (loop-if #f)`;
    // The test is false on entry, so the body never runs — this only proves the
    // hygiene-renamed `while` head dispatches (no "Unbound variable" throw), not
    // any particular loop behavior. `while` returns unspecified (void).
    await expect(exec(src, { env: sandboxedEnv.child("dw2") })).resolves.not.toThrow();
  });

  it("user syntax-rules macro expanding to `try`/`catch` resolves the keyword", async () => {
    const src = `
      (define-syntax safely
        (syntax-rules ()
          ((safely body) (try body (catch (e) 'caught)))))
      (safely (raise 'boom))`;
    // exec already unwraps a symbol result to an apostrophe-prefixed string
    // (ASymbol's documented opaque-exit marker — see control-forms-keywords.test.ts's
    // `repr` helper for the same convention).
    expect(String(val(await exec(src, { env: sandboxedEnv.child("dw3") })))).toBe("caught");
  });

  it("user syntax-rules macro expanding to `define-macro` resolves the keyword", async () => {
    // Definition + use inside the SAME expanded `begin` — sidesteps an orthogonal,
    // pre-existing limitation where a top-level `define` (already keyworded, unrelated
    // to this fix) made from inside a syntax-rules expansion doesn't escape to later,
    // separately-evaluated top-level forms. That escape gap reproduces identically for
    // plain `define` and is out of scope for this hygiene fix.
    const src = `
      (define-syntax use-doubler
        (syntax-rules ()
          ((use-doubler x) (begin (define-macro (dbl y) (list '+ y y)) (dbl x)))))
      (use-doubler 21)`;
    expect(val(await exec(src, { env: sandboxedEnv.child("dw4") }))).toBe(42);
  });
});
