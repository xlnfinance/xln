// RED-TEST SUITE for a precisely-characterized syntax-rules matcher bug.
//
// Chibi's EXPECTED_FAILURES already flags the macro engine as a vague "pre-L1
// gap" ("let-syntax + nested syntax-rules don't bind cleanly"). This file pins
// the ROOT CAUSE: the pattern matcher drops the FIRST code element after the
// macro keyword (an off-by-one — it double-counts the keyword position). Symptoms:
//   - fixed-arity patterns that BIND named vars don't match (length misaligns);
//   - arity discrimination picks the rule for N-1 args (count-to-2 a b → 1, not 2);
//   - ellipsis patterns lose element 0 ((m 1 2 3) with (a ...) → (2 3)).
// It masks itself in recursion-shaped macros (chibi `my-or` returns the same
// answer either way), which is why the suite stays green via exclusions.
//
// FIXED 2026-06-11 (`is_syntax(fn) ? code : rest` at evaluator.ts macro dispatch):
// the first block (fixed-arity + arity-discrimination + ellipsis) now passes and
// is plain `it`. The vector-pattern block below stays `it.fails` — those are the
// SEPARATE expander defect (boxing-track S9: needs a SchemeVector unwrap in the
// matcher/expander, not just the off-by-one). docs/plan-2026-06-10-boxing-track.md.
import { describe, expect, it } from "vitest";
import { freshEnv } from "../_fresh-env.js";
import { AVector } from "../../values/primitives/AVector.js";
import { execStateOverFrame as execState } from "../../eval/generator-exec.js";

const env = await freshEnv();

// COMPLEX tier (execState): callers below assert box discipline directly
// (`toBeInstanceOf(AVector)`, `.__vector__`) and stringify the BOXED Scheme
// print form (e.g. list "(9 8)") — a boxed-state read, not the SIMPLE tier's
// plain-JS exit.
async function run(form: string): Promise<unknown> {
  const { values: r } = await execState(form, { env });
  return r[0];
}

describe("syntax-rules matcher off-by-one (PRE-EXISTING pre-L1 gap — drops first code element)", () => {
  it("fixed 1-arg pattern binds+uses its var: ((_ a) a) on (m 9) → 9", async () => {
    const out = await run(`(let-syntax ((m (syntax-rules () ((_ a) a)))) (m 9))`);
    expect(String(out)).toBe("9");
  });

  it("fixed 2-arg pattern: ((_ a b) (list a b)) on (m 9 8) → (9 8)", async () => {
    const out = await run(`(let-syntax ((m (syntax-rules () ((_ a b) (list a b))))) (m 9 8))`);
    expect(String(out)).toBe("(9 8)");
  });

  it("arity discrimination: count-to-2 on (c2 a b) → 2 (currently picks the 1-arg rule → 1)", async () => {
    const out = await run(`(let-syntax ((c2 (syntax-rules () ((_) 0) ((_ _) 1) ((_ _ _) 2)))) (c2 a b))`);
    expect(String(out)).toBe("2");
  });

  it("ellipsis keeps element 0: ((_ a ...) (list a ...)) on (m 1 2 3) → (1 2 3)", async () => {
    const out = await run(`(let-syntax ((m (syntax-rules () ((_ a ...) (list a ...))))) (m 1 2 3))`);
    expect(String(out)).toBe("(1 2 3)");
  });

  it("head + ellipsis keeps the head: ((_ h a ...) (list h a ...)) on (m 1 2 3) → (1 2 3)", async () => {
    const out = await run(`(let-syntax ((m (syntax-rules () ((_ h a ...) (list h a ...))))) (m 1 2 3))`);
    expect(String(out)).toBe("(1 2 3)");
  });
});

describe("syntax-rules VECTOR patterns (boxing S9 — needs the matcher fix AND a SchemeVector unwrap)", () => {
  it.fails("fixed vector pattern: ((_ #(a b)) (+ a b)) on (m #(7 8)) → 15", async () => {
    const out = await run(`(let-syntax ((m (syntax-rules () ((_ #(a b)) (+ a b))))) (m #(7 8)))`);
    expect(String(out)).toBe("15");
  });

  it.fails("vector pattern with ellipsis: ((_ #(a ...)) (+ a ...)) on (m #(1 2 3 4)) → 10", async () => {
    const out = await run(`(let-syntax ((m (syntax-rules () ((_ #(a ...)) (+ a ...))))) (m #(1 2 3 4)))`);
    expect(String(out)).toBe("10");
  });

  it.fails("vector template emits a vector: ((_ a b) #(a b)) on (m 5 6) → #(5 6)", async () => {
    const out = await run(`(let-syntax ((m (syntax-rules () ((_ a b) #(a b))))) (m 5 6))`);
    expect(out).toBeInstanceOf(AVector);
    expect((out as AVector).__vector__.map(String)).toEqual(["5", "6"]);
  });
});
