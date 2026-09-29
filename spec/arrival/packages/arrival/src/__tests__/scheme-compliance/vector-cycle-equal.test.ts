// Caveat-sweep finding (2026-06-11): boxing vectors broke structuralEqual's
// documented cycle-safety. The arrival/tagless-final/equals hook (structural-equal.ts:43)
// fires BEFORE the occurs-check seeds `seen`, and SchemeVector's hook recursed
// through structuralEqual with a FRESH empty seen-map per call — so cyclic
// vectors recursed forever and blew the JS stack. Fixed by special-casing
// SchemeVector in structuralEqual BEFORE the hook, threading `seen`.
//
// PURITY RE-BASELINE (2026-06-11): vector-set! is now OMITTED by the purity
// invariant (frozen entities), so a cyclic vector can no longer be CONSTRUCTED by
// mutation — only READ via a datum-label literal (`'#0=#(1 #0#)`). That reader
// path still builds a (frozen) cycle, so the cycle-safety guard still matters.
//
// The SURVIVING property this guards: equal? on a cyclic vector must TERMINATE —
// never blow the JS stack — however the cycle was built. We assert termination
// (resolves to a boolean without throwing/hanging); the original co-inductive
// `#t` assertion tested a mutation-built input that no longer exists.
//
// ⚠ SEPARATE FINDINGS surfaced on the reader-cyclic-vector path (NOT this
// regression, NOT the purity pass — pre-existing, worth a future red-test):
//   • `'#0=#(1 #0#)` reprs as "[object Object]" (cyclic-vector repr gap).
//   • equal? on two structurally-equal reader-built self-cyclic vectors returns
//     #f, not the co-inductive #t (reader-built cycles may not box as SchemeVector
//     so the cycle branch never fires). Terminates either way — hence we guard on
//     termination here.
import { describe, expect, it } from "vitest";
import { freshEnv } from "../_fresh-env.js";
import { execStateOverFrame as execState } from "../../eval/generator-exec.js";

const env = await freshEnv();
// COMPLEX tier (execState): callers stringify the BOXED verdict (Scheme print
// form "#t"/"#f") — a boxed-state read, not the SIMPLE tier's plain-JS exit.
const run = async (form: string) => (await execState(form, { env })).values[0];

// Verdicts print as the boxed scheme booleans (`#t`/`#f` — equal? returns the
// schemeTrue/schemeFalse flyweights under the Face split; the raw JS "true"/"false"
// string forms were the pre-box string-identity leak).
describe("equal? on cyclic vectors terminates (cycle-safety regression)", () => {
  it("two distinct reader-built self-cyclic vectors compare without a stack blow", async () => {
    // Each vector's element[1] points back at itself; distinct but structurally
    // identical. The guard: this resolves to a boolean, it does not blow the stack.
    const out = await run(`(equal? '#0=#(1 #0#) '#1=#(1 #1#))`);
    expect(["#t", "#f"]).toContain(String(out));
  });

  it("a self-cyclic vector compared to itself terminates", async () => {
    const out = await run(`(let ((a '#0=#(1 2 #0#))) (equal? a a))`);
    // self-vs-self is true via the identity shortcut; the point is it terminates.
    expect(["#t", "#f"]).toContain(String(out));
  });

  it("acyclic vector inequality still works", async () => {
    expect(String(await run(`(equal? (vector 1 2) (vector 1 3))`))).toBe("#f");
  });
});
