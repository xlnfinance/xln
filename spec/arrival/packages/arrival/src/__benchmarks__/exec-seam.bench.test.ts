/**
 * exec-seam.bench.test.ts measures the cost of the PUBLIC EXEC SEAM over the ONE
 * remaining exec path (`eval/generator-exec.ts`'s `execState`/`exec` — the router
 * collapse retired the second, glass/ambient path this file used to also measure:
 * `Capabilities.assembled(user_env)` and the `user_env`/`global_env` realm singletons
 * (`env/env-roots.ts`) are gone outright — there is no "compiled default vs live glass"
 * distinction left to benchmark, only one vocabulary-backed path, so this file no
 * longer has a "cut path" half. REDESIGNED (not a speedup race, still): the vocabulary
 * + sealed resolution chain (`buildVocabulary`/`sealedVocabularyChain`) is memoized by
 * capability-set + config IDENTITY (`env/vocabulary.ts`'s own trie), so it's already
 * amortized after the first call regardless of continuity — the two cost centers that
 * genuinely still vary per call are (a) the string→AST parse and (b) a fresh
 * `RunContext` + its prelude pass (`assembleRun` re-preludes unless a passed `runCtx`'s
 * tuple already matches). This file isolates exactly those two, for the SAME expression
 * `(+ 1 2 3 4 5)`, each layer removing one more of them:
 *
 *   1. `exec(source)`           — full seam: string parse + a fresh RunContext/scope
 *                                 every call (vocabulary/chain memo-hit after the first).
 *   2. `execState(ast)`         — pre-parsed AST (parse cost removed), still a fresh
 *                                 RunContext/scope every call.
 *   3. `execState(ast, {scope, runCtx})` — pre-parsed AST AND a `scope`+`runCtx` pair
 *                                 reused across every call (continuity — `assembleRun`'s
 *                                 tuple match skips the prelude re-run too): the bare
 *                                 per-form eval walk, nothing re-assembled.
 *
 * (1) minus (2) is the parse cost; (2) minus (3) is the fresh-RunContext-and-prelude
 * cost; (1) minus (3) is the total per-call seam overhead once the vocabulary itself is
 * warm. No "speedup" is claimed anywhere — these are three honest measurements of one
 * pipeline's remaining variable costs, not a race between implementations.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { exec, execState, parse } from "../eval/generator-exec.js";
import { LexicalScope } from "../eval/LexicalScope.js";
import type { RunContext } from "../run/RunContext.js";
import type { SchemeValue } from "../values/types.js";

const SOURCE = "(+ 1 2 3 4 5)";
const ITERATIONS = 2000;

function report(label: string, iterations: number, elapsedMs: number): void {
  console.log(
    `${label}: ${iterations} calls in ${elapsedMs.toFixed(2)}ms ` +
      `(${((iterations / elapsedMs) * 1000).toFixed(0)} ops/sec, ${(elapsedMs / iterations).toFixed(4)}ms/call)`,
  );
}

describe("exec seam overhead — one evaluator, parse + continuity are the two remaining cost layers", () => {
  let ast: SchemeValue;
  let warmScope: LexicalScope;
  let warmRunCtx: RunContext;

  beforeAll(async () => {
    const parsed = await parse(SOURCE);
    ast = parsed[0];
    // Warm the run ONCE outside every measured loop below — mints the `scope`/`runCtx`
    // pair layer 3 reuses, and JIT-warms the shared vocabulary/chain memo every layer
    // benefits from (the memo is process-global, not per-layer).
    warmScope = LexicalScope.fresh("exec-seam-bench-warm");
    const warm = await execState(ast, { scope: warmScope });
    warmRunCtx = warm.runCtx;
  });

  it("layer 1 — exec(source): full seam, string parse + fresh RunContext/scope, every call", async () => {
    const start = performance.now();
    for (let i = 0; i < ITERATIONS; i++) {
      const [result] = await exec(SOURCE);
      expect(result).toBe(15);
    }
    report("exec(source)", ITERATIONS, performance.now() - start);
  });

  it("layer 2 — execState(pre-parsed ast): fresh RunContext/scope only, parse removed", async () => {
    const start = performance.now();
    for (let i = 0; i < ITERATIONS; i++) {
      const { values } = await execState(ast);
      expect((values[0] as { valueOf(): unknown }).valueOf()).toBe(15);
    }
    report("execState(ast)", ITERATIONS, performance.now() - start);
  });

  it("layer 3 — execState(ast, {scope, runCtx}): continuity — bare per-form eval, nothing re-assembled", async () => {
    const start = performance.now();
    for (let i = 0; i < ITERATIONS; i++) {
      const { values } = await execState(ast, { scope: warmScope, runCtx: warmRunCtx });
      expect((values[0] as { valueOf(): unknown }).valueOf()).toBe(15);
    }
    report("execState(ast, {scope, runCtx})", ITERATIONS, performance.now() - start);
  });

  it("deeply nested expression, layer 1 vs layer 3 (same shape as the old file's nested-expr case)", async () => {
    let code = "(+ 1 0)";
    for (let i = 0; i < 100; i++) code = `(+ 1 ${code})`;
    const nestedAst = (await parse(code))[0];

    const fullSeamStart = performance.now();
    for (let i = 0; i < 100; i++) {
      const [result] = await exec(code);
      expect(result).toBe(101);
    }
    report("exec(source) — 100-level nesting", 100, performance.now() - fullSeamStart);

    const bareStart = performance.now();
    for (let i = 0; i < 100; i++) {
      const { values } = await execState(nestedAst, { scope: warmScope, runCtx: warmRunCtx });
      expect((values[0] as { valueOf(): unknown }).valueOf()).toBe(101);
    }
    report("execState(ast, {scope, runCtx}) — 100-level nesting", 100, performance.now() - bareStart);
  });
});
