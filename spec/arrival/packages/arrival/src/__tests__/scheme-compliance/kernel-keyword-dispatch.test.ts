// Kernel keywords — special-form-ness travels with the VALUE, not the head's spelling.
//
// The slice that introduced `symbol.keyword` + value-first dispatch: `lambda` / `define`
// / `let` resolve to Keyword markers, so the evaluator dispatches the kernel handler off
// the resolved marker — which makes the form ALIASABLE. `(define => lambda)` is the
// headline case (impossible under name-matched-before-lookup special forms).
//
// NOTE: head-position lexical shadowing of a keyword (`(let ((lambda 5)) (lambda))` →
// a call, not the form) is NOT yet covered — the transitional name-match fallback still
// catches a non-keyword head by name. That win lands when the fallback is removed (the
// macro-cut pass, once every special form is a keyword marker).
import { describe, expect, it } from "vitest";
import { toJS } from "../../membrane/rosetta.js";
import { execStateOverFrame as execState } from "../../eval/generator-exec.js";
// In-package test: internal-module access (the barrel export retired — privatization V5).
import { inferenceEnv as sandboxedEnv } from "../../env/inference-env.js";

describe("kernel keywords — value-carried special-form dispatch", () => {
  it("(define => lambda) — the alias IS lambda (aliasing falls out of value-carried dispatch)", async () => {
    const env = sandboxedEnv.child("kw-alias-lambda");
    // execState (COMPLEX tier): toJS wants BOXED values — `exec` already unwraps.
    const { values: results } = await execState(
      `
      (define => lambda)
      ((=> (x) (* x x)) 6)
      `,
      { env },
    );
    expect(toJS(results[results.length - 1], {})).toBe(36);
  });

  it("define and let are first-class keyword values too — bind one, use the binding as a head", async () => {
    const env = sandboxedEnv.child("kw-alias-let");
    // execState (COMPLEX tier): toJS wants BOXED values — `exec` already unwraps.
    const { values: results } = await execState(
      `
      (define my-let let)
      (my-let ((a 10) (b 20)) (+ a b))
      `,
      { env },
    );
    expect(toJS(results[results.length - 1], {})).toBe(30);
  });

  it("unaliased lambda / define / let still dispatch as their kernel handlers", async () => {
    const env = sandboxedEnv.child("kw-plain");
    // execState (COMPLEX tier): toJS wants BOXED values — `exec` already unwraps.
    const { values: results } = await execState(
      `
      (define sq (lambda (x) (* x x)))
      (let ((n (sq 7))) n)
      `,
      { env },
    );
    expect(toJS(results[results.length - 1], {})).toBe(49);
  });
});
