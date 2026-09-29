// syntax-rules through the PUBLIC `exec` — the assembled (cut) base.
//
// syntax-rules-special-forms.test.ts runs over a glass env (`inferenceEnv.child`), where the
// lexical chain and the capability base are one `__parent__` walk. The public `exec` runs a
// fresh LexicalScope over an ASSEMBLED base, so kernel keywords (`if`/`let`/`lambda`/`define`)
// live only in the capability chain. Hygiene's rename copies each template identifier's value
// onto its gensym via `Resolver.lookupSettled`; reading only the lexical env left every kernel
// keyword's gensym unbound (`Unbound variable Symbol(#:lambda)`). These pin the public path.
import { describe, expect, it } from "vitest";
import { exec } from "../../index.js";

const last = (rs: readonly unknown[]) => rs[rs.length - 1];

describe("syntax-rules over the public exec (assembled base)", () => {
  it("expands to `if`", async () => {
    const src = `(define-syntax my-if (syntax-rules () ((_ c a b) (if c a b)))) (my-if #t 1 2)`;
    expect(last(await exec(src))).toBe(1);
  });

  it("expands to `let`, hygienically", async () => {
    const src = `
      (define-syntax shadowing (syntax-rules () ((_ body) (let ((tmp 999)) body))))
      (define tmp 7)
      (shadowing tmp)`;
    expect(last(await exec(src))).toBe(7);
  });

  it("expands to `lambda`", async () => {
    const src = `(define-syntax fn (syntax-rules () ((_ x body) (lambda (x) body)))) ((fn y (* y 2)) 3)`;
    expect(last(await exec(src))).toBe(6);
  });

  // Known gap, shared with the glass path (see do-while-try-define-macro-hygiene.test.ts):
  // a `define` made inside an expansion does not escape to later top-level forms.
  it.fails("expands to a top-level `define` visible to later forms", async () => {
    const src = `
      (define-syntax defconst (syntax-rules () ((_ name v) (define (name) v))))
      (defconst answer 42)
      (answer)`;
    expect(last(await exec(src))).toBe(42);
  });

  it("builds a small rule vocabulary", async () => {
    const src = `
      (define-syntax rule
        (syntax-rules (when then)
          ((_ name (w side) (when guard) (then next))
           (dict :name name :when (lambda (w side) guard) :then (lambda (w side) next)))))
      (define bump (rule "bump" (w n) (when (> n 0)) (then (+ w n))))
      (list ((:when bump) 1 2) ((:then bump) 1 2))`;
    expect(last(await exec(src))).toEqual([true, 3]);
  });
});
