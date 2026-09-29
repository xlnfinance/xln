// srfi-43-symbol-define.test.ts — W4/H2 pack migration rows for `scheme/srfi-43`
// (docs/design-history/symbol-define-static-program-validation.md §1/§2.1/§4).
//
// THE SAME LUCK CLASS srfi-235 (W4/H1) found, for NATIVE_PACKS this time (srfi-43.ts's
// header): every body below calls `vector-length`/`vector-ref` (scheme/vectors), `=`/
// `+`/`-`/`<`/`>`/`quotient` (scheme/numeric), and `not` (scheme/equality) — none
// declared pre-migration. It worked only via the two-phase bootstrap's runtime
// guarantee (NATIVE_PACKS → global_env before BASE_PACKS → user_env), which the STATIC
// bake FV law does not consult. `deps: [equality, numeric, vectors]` on the pack is the
// fix, converting the luck into a declared, checked edge.
//
// Four rows, matching the pack's migration checklist:
//
//   1. behavior equivalence — all eight ops produce the SAME results the pre-migration
//      text-blob prelude did (§4.2's "semantic equivalence, not byte-identity" gate),
//      including `vector-binary-search` (untested by either pre-existing srfi suite)
//      and the empty-vector / all-#f edge cases.
//   2. the dep edge is REAL, not decorative: standalone `.apply()` (bypassing
//      `assembleEnv`'s C3 dep-walk) leaves the declared deps UNAPPLIED — a call
//      reaching them fails with the ordinary unbound-variable teaching door; the REAL
//      orchestration path (`assembleEnv`, every production caller) walks `deps`, and
//      every op works.
//   3. contract enforcement fires — a scheme-face type mismatch (non-procedure where a
//      `pred`/`kons`/`cmp` slot is declared, non-vector where a `vec` slot is declared)
//      throws at the call boundary, before the body ever runs.
//   4. the §2.1 bake FV law passes for this pack as migrated (with declared deps) — and,
//      mirrored, a LOCAL reproduction of the pre-fix shape (the same `vector-length`
//      free reference, NO declared deps) throws `DefineLocalityError`, pinning that the
//      bug this migration fixes was real and is now caught, not merely worked around.
import { describe, expect, it } from "vitest";
import { EnvCapability } from "../../../common/capability.js";
import { exec, execOverFrame, execStateOverFrame, execInFrame } from "../../../eval/generator-exec.js";
import { freshEnv } from "../../../__tests__/_fresh-env.js";
import { buildVocabulary } from "../../vocabulary.js";
import { DefineLocalityError } from "../../../errors.js";
import srfi43 from "../srfi-43.js";
import type { ResolvingAmbient } from "../../AmbientRuntime.js";

// Mirrors `_fresh-env.ts`'s own injected evalScheme — `skipBootstrapWait` because
// these execs run against an env this suite is itself assembling/re-lowering onto,
// not the shared realm-cached bootstrap.
const evalScheme = (env: unknown, src: unknown): unknown => execInFrame(src as string, env as ResolvingAmbient);

// COMPLEX tier (execState): stringifies the BOXED result (Scheme print format) — needed
// for vector-fold['s]/vector-fold-right's list-shaped accumulator, where execOverFrame()'s
// SIMPLE-tier `toJS` unwrap egresses an R9 lazy proxy rather than a plain comparable
// value (mirrors src/__tests__/srfi.test.ts's own `run` helper).
async function printed(env: ResolvingAmbient, src: string): Promise<string> {
  const { values: r } = await execStateOverFrame(src, { env });
  const x = r[r.length - 1] as { toString(): string } | undefined;
  return String(x?.toString?.() ?? x);
}

describe("scheme/srfi-43 — behavior equivalence (semantic-equivalence gate, §4.2)", () => {
  it("vector-fold / vector-fold-right", async () => {
    const env = await freshEnv();
    // kons is (acc elt) → acc' — SRFI-43's own arg order (accumulator first). Prepending
    // (cons elt acc) makes the direction difference between fold (left, index 0..n-1) and
    // fold-right (right, index n-1..0) observable in the printed list.
    const kons = "(lambda (acc elt) (cons elt acc))";
    expect(await printed(env, `(vector-fold ${kons} '() #(1 2 3))`)).toBe("(3 2 1)");
    expect(await printed(env, `(vector-fold-right ${kons} '() #(1 2 3))`)).toBe("(1 2 3)");
  });

  it("vector-count / vector-index / vector-empty?", async () => {
    const env = await freshEnv();
    const [count] = await execOverFrame("(vector-count even? #(1 2 3 4 5))", { env });
    const [index] = await execOverFrame("(vector-index odd? #(2 4 5 6))", { env });
    const [noMatch] = await execOverFrame("(vector-index odd? #(2 4 6))", { env });
    const [emptyT] = await execOverFrame("(vector-empty? #())", { env });
    const [emptyF] = await execOverFrame("(vector-empty? #(1))", { env });
    expect(count).toBe(2);
    expect(index).toBe(2);
    expect(noMatch).toBe(false);
    expect(emptyT).toBe(true);
    expect(emptyF).toBe(false);
  });

  it("vector-any / vector-every, including the empty-vector and all-#f edges", async () => {
    const env = await freshEnv();
    const [anyTrue] = await execOverFrame("(vector-any even? #(1 3 4))", { env });
    const [anyFalse] = await execOverFrame("(vector-any even? #(1 3 5))", { env });
    const [everyTrue] = await execOverFrame("(vector-every even? #(2 4 6))", { env });
    const [everyFalse] = await execOverFrame("(vector-every even? #(2 4 5))", { env });
    const [everyEmpty] = await execOverFrame("(vector-every even? #())", { env });
    expect(anyTrue).toBe(true);
    expect(anyFalse).toBe(false);
    expect(everyTrue).toBe(true);
    expect(everyFalse).toBe(false);
    expect(everyEmpty).toBe(true); // R8-mint empty-vacuous-truth, matches R7RS `every`
  });

  it("vector-binary-search — untested by either pre-existing srfi suite pre-migration", async () => {
    const env = await freshEnv();
    const sorted = "#(1 3 5 7 9 11)";
    const cmp = "(lambda (elt v) (- elt v))";
    const [hit] = await execOverFrame(`(vector-binary-search ${sorted} 7 ${cmp})`, { env });
    const [miss] = await execOverFrame(`(vector-binary-search ${sorted} 8 ${cmp})`, { env });
    const [first] = await execOverFrame(`(vector-binary-search ${sorted} 1 ${cmp})`, { env });
    const [last] = await execOverFrame(`(vector-binary-search ${sorted} 11 ${cmp})`, { env });
    expect(hit).toBe(3);
    expect(miss).toBe(false);
    expect(first).toBe(0);
    expect(last).toBe(5);
  });
});

// `buildVocabulary` always walks a capability's own declared `deps`. srfi-43's
// declared deps (`equality`/`numeric`/`vectors`) resolve its ops via the
// sanctioned path; the bake-time FV law below is the row that proves the edge
// is declared rather than runtime-lucky.
describe("scheme/srfi-43 — the dep edge is real (§2.1's undeclared-dep bug class, now a declared edge)", () => {
  it("srfi-43 ALONE (exec({capabilities})): every op resolves through its declared deps", async () => {
    const [count] = await exec("(vector-count even? #(1 2 3 4))", { capabilities: [srfi43] });
    expect(count).toBe(2);
  });
});

describe("scheme/srfi-43 — contract ENFORCEMENT fires at the call boundary", () => {
  it("vector-count: a non-procedure pred is rejected before the body runs", async () => {
    const env = await freshEnv();
    await expect(execStateOverFrame('(vector-count "not-a-procedure" #(1 2 3))', { env })).rejects.toThrow();
  });

  it("vector-fold: a non-vector vec is rejected before the body runs", async () => {
    const env = await freshEnv();
    await expect(execStateOverFrame('(vector-fold cons (list) "not-a-vector")', { env })).rejects.toThrow();
  });

  it("vector-binary-search: a non-procedure cmp is rejected before the body runs", async () => {
    const env = await freshEnv();
    await expect(execStateOverFrame('(vector-binary-search #(1 2 3) 2 "not-a-procedure")', { env })).rejects.toThrow();
  });
});

describe("scheme/srfi-43 — the §2.1 bake FV law passes for this pack AS MIGRATED", () => {
  it("bakes cleanly with its declared deps — never DefineLocalityError", async () => {
    await expect(buildVocabulary([srfi43], undefined, evalScheme)).resolves.not.toThrow();
  });

  it("(regression pin) a LOCAL reproduction of the PRE-FIX shape — the same `vector-length`/`vector-ref` free references with NO declared deps — throws DefineLocalityError: the bug this migration fixes was real", async () => {
    // Deliberately NO `deps` field — this is the exact shape srfi-43.ts had before this
    // migration (a bare `symbols` record with no dep declaration).
    const undeclaredCap = EnvCapability.define("test/srfi-43-pre-fix-repro", {
      symbols: (symbol, z) => ({
        "bad-vector-empty?":
          symbol.define`bad-vector-empty?: reproduces the pre-migration srfi-43 bug (no declared dep on vector-length/scheme/numeric's =)`(
            { input: [z.vector(z.schemeValue)], output: [z.boolean] },
            `(lambda (vec) (= (vector-length vec) 0))`,
          ),
      }),
    });
    await expect(buildVocabulary([undeclaredCap], undefined, evalScheme)).rejects.toThrow(DefineLocalityError);
  });
});
