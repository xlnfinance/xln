// srfi-235-symbol-define.test.ts — W4/H1 pack migration rows for `scheme/srfi-235`
// (docs/design-history/symbol-define-static-program-validation.md §1/§2.1/§4).
//
// THE LATENT BUG this migration fixes (design doc §2.1's "live catch", §4.1's census
// row): `complement`'s body called `compose` — a `scheme/polyglot` define — with NO
// declared `deps` edge; it only worked because `base-packs.ts` happened to assemble
// polyglot earlier in the same phase (assembly-order luck). The bake FV law
// (`define-bake.ts`) refuses an undeclared free reference, so the fix is a REAL `deps`
// edge. The SAME migration surfaced a further instance of the identical bug class —
// `not` (scheme/equality), `length`/`apply`/`append` (scheme/lists), `>=`
// (scheme/numeric) — every one a cross-capability reference the OLD text-blob prelude
// got away with via the two-phase bootstrap's runtime guarantee (env-roots.ts:
// NATIVE_PACKS → global_env, THEN BASE_PACKS → user_env), which the STATIC bake FV
// law does not (and should not) consult. `deps: [equality, numeric, lists, polyglot]`
// on the pack (srfi-235.ts) is the complete, empirically-verified fix.
//
// Five rows, matching the pack's migration checklist:
//
//   1. combinator behavior equivalence — complement/constantly/always/curry produce
//      the SAME results the pre-migration text-blob prelude did (§4.2's "semantic
//      equivalence, not byte-identity" gate).
//   2. the dep edge is REAL, not decorative: standalone `.apply()` (bypassing
//      `assembleEnv`'s C3 dep-walk) leaves the declared deps UNAPPLIED — calling a
//      combinator that reaches them then fails with the ordinary unbound-variable
//      teaching door, pinning that these names are genuine runtime dependencies. The
//      REAL orchestration path (`assembleEnv`, which every production caller uses)
//      DOES walk `deps`, and combinators work.
//   3. contract enforcement fires — a scheme-face type mismatch throws at the call
//      boundary, before the body ever runs.
//   4. the §2.1 bake FV law passes for this pack as migrated (with declared deps) —
//      and, mirrored, a LOCAL reproduction of the pre-fix shape (same bodies, NO
//      declared deps) throws `DefineLocalityError` — pinning that the bug this
//      migration fixes was real and is now caught, not merely worked around.
import { describe, expect, it } from "vitest";
import { EnvCapability } from "../../../common/capability.js";
import { exec, execOverFrame, execStateOverFrame, execInFrame } from "../../../eval/generator-exec.js";
import { freshEnv } from "../../../__tests__/_fresh-env.js";
import { buildVocabulary } from "../../vocabulary.js";
import { DefineLocalityError } from "../../../errors.js";
import srfi235 from "../srfi-235.js";
import type { ResolvingAmbient } from "../../AmbientRuntime.js";

// Mirrors `_fresh-env.ts`'s own injected evalScheme — `skipBootstrapWait` because
// these execs run against an env this suite is itself assembling/re-lowering onto,
// not the shared realm-cached bootstrap.
const evalScheme = (env: unknown, src: unknown): unknown => execInFrame(src as string, env as ResolvingAmbient);

describe("scheme/srfi-235 — combinator behavior equivalence (semantic-equivalence gate, §4.2)", () => {
  it("complement: negates a predicate's result", async () => {
    const env = await freshEnv();
    const [t] = await execOverFrame("((complement not) #t)", { env });
    const [f] = await execOverFrame("((complement not) #f)", { env });
    expect(t).toBe(true); // (not #t) = #f, negated = #t
    expect(f).toBe(false); // (not #f) = #t, negated = #f
  });

  it("constantly: ignores every argument, always returns the closed-over value", async () => {
    const env = await freshEnv();
    const [result] = await execOverFrame("((constantly 42) 1 2 3)", { env });
    expect(result).toBe(42);
  });

  it("always / never: SRFI-235 — ignore args, return #t / #f (not constantly)", async () => {
    const env = await freshEnv();
    const [t] = await execOverFrame("(always 7 8 9)", { env });
    const [f] = await execOverFrame("(never 7 8 9)", { env });
    expect(t).toBe(true);
    expect(f).toBe(false);
  });

  it("curry: accumulates args across calls until fn's min arity, then applies", async () => {
    const env = await freshEnv();
    await execOverFrame("(define (add3 a b c) (+ a b c))", { env });
    const [direct] = await execOverFrame("(curry add3 1 2 3)", { env }); // full arity in one call
    const [partial3] = await execOverFrame("(((curry add3 1) 2) 3)", { env }); // one arg per call
    const [partial2] = await execOverFrame("((curry add3 1 2) 3)", { env }); // two then one
    expect(direct).toBe(6);
    expect(partial3).toBe(6);
    expect(partial2).toBe(6);
  });

  it("curry: an intermediate partial application is a real callable value, reusable", async () => {
    const env = await freshEnv();
    await execOverFrame("(define (add2 a b) (+ a b))", { env });
    await execOverFrame("(define add-five (curry add2 5))", { env });
    const [a] = await execOverFrame("(add-five 1)", { env });
    const [b] = await execOverFrame("(add-five 100)", { env });
    expect(a).toBe(6);
    expect(b).toBe(105);
  });
});

// `buildVocabulary` always walks a capability's own declared `deps`. The bake-time
// FV law below proves the edges are declared, not runtime luck; here we pin that
// complement/curry resolve through srfi-235's declared deps.
describe("scheme/srfi-235 — the dep edge is real (§2.1's undeclared-dep bug, now a declared edge)", () => {
  it("srfi-235 ALONE (exec({capabilities})): complement/curry resolve through its declared deps", async () => {
    const [complementResult] = await exec("((complement not) #t)", { capabilities: [srfi235] });
    expect(complementResult).toBe(true);
    const [, curryResult] = await exec("(define (add1 a) (+ a 1)) ((curry add1) 41)", { capabilities: [srfi235] });
    expect(curryResult).toBe(42);
  });
});

describe("scheme/srfi-235 — contract ENFORCEMENT fires at the call boundary", () => {
  it("complement: a non-procedure argument is rejected before the body runs", async () => {
    const env = await freshEnv();
    await expect(execStateOverFrame('(complement "not-a-procedure")', { env })).rejects.toThrow();
  });

  it("curry: a non-procedure `fn` is rejected before the body runs", async () => {
    const env = await freshEnv();
    await expect(execStateOverFrame("(curry 5)", { env })).rejects.toThrow();
  });
});

describe("scheme/srfi-235 — the §2.1 bake FV law passes for this pack AS MIGRATED", () => {
  it("bakes cleanly with its declared deps — never DefineLocalityError", async () => {
    await expect(buildVocabulary([srfi235], undefined, evalScheme)).resolves.not.toThrow();
  });

  it("(regression pin) a LOCAL reproduction of the PRE-FIX shape — the same `compose`/`not` bodies with NO declared deps — throws DefineLocalityError: the bug this migration fixes was real", async () => {
    // Deliberately NO `deps` field — this is the exact shape srfi-235.ts had before
    // this migration (a bare `symbols` record with no dep declaration).
    const undeclaredCap = EnvCapability.define("test/srfi-235-pre-fix-repro", {
      symbols: (symbol, z) => ({
        "bad-complement":
          symbol.define`bad-complement: reproduces the pre-migration srfi-235 bug (no declared dep on compose/not)`(
            { input: [z.lambda], output: [z.lambda] },
            `(lambda (fn) (compose not fn))`,
          ),
      }),
    });
    await expect(buildVocabulary([undeclaredCap], undefined, evalScheme)).rejects.toThrow(DefineLocalityError);
  });
});
