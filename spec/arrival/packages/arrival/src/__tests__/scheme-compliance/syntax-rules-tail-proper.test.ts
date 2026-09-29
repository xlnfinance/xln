// syntax-rules is FORM-RETURNING and tail-proper.
//
// The transformer returns the transcribed FORM (+ its hygiene scope); the evaluator yields
// that form into the SAME flat trampoline in tail position (evaluator.ts is_syntax branch).
// It never evaluates inside a nested run() — so a syntax-rules macro in tail position uses
// O(1) stack/heap (no host-stack overflow, no composed onResolve), exactly like a special
// form. Completion at depth IS the proof: the pre-fix nested-genRun path overflowed here.
//
// Data-position gensyms (template identifiers under quote/quasiquote) are restored to their
// literal symbols by restore_data_gensyms ON THE FORM (once per expansion), so quote yields
// the literal symbol with no post-eval, O(depth)-composing fixup.
import { describe, expect, it } from "vitest";
import { toJS } from "../../membrane/rosetta.js";
import { execStateOverFrame, type ExecOptionsOverFrame } from "../../eval/generator-exec.js";
// In-package test: internal-module access (the barrel export retired — privatization V5).
import { inferenceEnv as sandboxedEnv } from "../../env/inference-env.js";
import type { SchemeValue } from "../../values/types.js";

// COMPLEX tier (execStateOverFrame, not exec): `repr` stringifies the BOXED result
// (Scheme print format, e.g. list "(alpha beta gamma)", bare symbol "pos") —
// a boxed-state read, not the SIMPLE tier's plain-JS exit (whose symbol/list
// unwrap shapes would make these assertions unreadable — RULINGS.md R1).
const exec = async (src: string, options: ExecOptionsOverFrame) =>
  (await execStateOverFrame(src, options)).values.slice();
const val = (rs: SchemeValue[]) => toJS(rs[rs.length - 1]);
const repr = (rs: unknown[]) => String(rs[rs.length - 1]);

describe("syntax-rules — form-returning + tail-proper", () => {
  // Timeout raised 20000ms (suite default) → 60000ms (G3 sunset triage, timing-flake
  // hardening): 50k deep tail-recursive macro expansion through the full trampoline can
  // occasionally exceed the default budget under heavy parallel-worker CPU contention. The
  // depth stays 50000 on purpose — "Completion at depth IS the proof" (this file's own header):
  // a shallower depth wouldn't reliably re-catch the pre-fix host-stack-overflow regression this
  // test exists to guard against, so widening the clock (not shrinking the depth) is the fix
  // that preserves the invariant.
  it("a macro in tail position recurses 50k deep WITHOUT host-stack overflow", async () => {
    const src = `
      (define-syntax my-if (syntax-rules () ((my-if t a b) (if t a b))))
      (define (loop n) (my-if (= n 0) 'done (loop (- n 1))))
      (loop 50000)`;
    expect(repr(await exec(src, { env: sandboxedEnv.child("tco1") }))).toBe("done");
  }, 60000);

  it("template quoted symbol is restored (no #:gensym leak)", async () => {
    const src = `
      (define-syntax classify
        (syntax-rules () ((classify n) (cond ((< n 0) 'neg) ((= n 0) 'zero) (else 'pos)))))
      (classify 5)`;
    expect(repr(await exec(src, { env: sandboxedEnv.child("tco2") }))).toBe("pos");
  });

  it("a quoted LIST of template identifiers is fully restored", async () => {
    const src = `
      (define-syntax tags (syntax-rules () ((tags) '(alpha beta gamma))))
      (tags)`;
    expect(repr(await exec(src, { env: sandboxedEnv.child("tco3") }))).toBe("(alpha beta gamma)");
  });

  it("hygiene still holds (template binding does not capture a user identifier)", async () => {
    const src = `
      (define-syntax sa (syntax-rules () ((sa a) (let ((tmp 1000)) (+ a tmp)))))
      (define tmp 7)
      (sa tmp)`;
    expect(val(await exec(src, { env: sandboxedEnv.child("tco4") }))).toBe(1007);
  });

  it("quasiquote in a template works (unquote hole stays code, literals restored)", async () => {
    const src = `
      (define-syntax pair-up (syntax-rules () ((pair-up x) \`(tag ,x))))
      (pair-up 42)`;
    expect(repr(await exec(src, { env: sandboxedEnv.child("tco5") }))).toBe("(tag 42)");
  });
});
