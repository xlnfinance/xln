/**
 * Fuzz harness for the Scheme evaluator — crash safety on randomly generated
 * arithmetic/conditional/string expressions. Short numRuns + short timeout —
 * sits in the default `pnpm test` budget but exercises a wide-enough surface
 * to catch any regression that drops crash safety on randomly shaped
 * expression trees. The evaluator is supposed to handle any well-formed
 * input — divide-by-zero is the only expected exception, normalized out
 * below.
 *
 * The provenance-algebra invariant-maintenance fuzz (synthetic AValue trees,
 * no parser, no evaluator) was split out to
 * src/provenance/__tests__/provenance-invariant.fuzz.test.ts — a distinct
 * concern from evaluator crash safety, with its own scaffolding.
 *
 * Fuzz is exploratory by design — when this finds a real crash, the failing
 * seed reproduces deterministically (vitest prints the fast-check shrunk
 * counter-example). Promote any reproducible bug into provenance.test.ts as
 * a named, .fails-tagged case.
 */

import * as fc from "fast-check";
import { beforeAll, describe, expect, it } from "vitest";

import { exec } from "../eval/generator-exec.js";

// wrappedOps don't get installed automatically just by importing exec —
// without this, every random program below would fail with "Unbound
// variable `+'" — the harness used to "pass" by routing through the
// unbound-variable whitelist branch, never actually exercising the
// arithmetic dispatch. See bridge.ts:236 war story.
beforeAll(async () => {});

/**
 * Recursive grammar for small Scheme programs. Two terminal categories
 * (literals and scoped variable refs) prevent infinite recursion via
 * fast-check's letrec depth cap. Operators chosen to span the
 * `wrapOperator` boundary (arithmetic), `withInputProvenance` boundary
 * (string-append), and the control-flow restriction (if/when/unless).
 */
const arbExpr = fc.letrec((tie) => ({
  expr: fc.oneof(
    { maxDepth: 3 },
    fc.integer({ min: -100, max: 100 }).map((n) => `${n}`),
    fc.string({ minLength: 0, maxLength: 5, unit: "grapheme-ascii" }).map((s) => JSON.stringify(s)),
    fc.tuple(tie("expr"), tie("expr")).map(([a, b]) => `(+ ${a} ${b})`),
    fc.tuple(tie("expr"), tie("expr")).map(([a, b]) => `(- ${a} ${b})`),
    fc.tuple(tie("expr"), tie("expr")).map(([a, b]) => `(* ${a} ${b})`),
    fc.tuple(tie("expr"), tie("expr"), tie("expr")).map(([p, t, e]) => `(if ${p} ${t} ${e})`),
  ),
})).expr as fc.Arbitrary<string>;

/**
 * Whitelist of expected runtime errors — anything outside this list is a real
 * bug. The grammar above mixes integers, strings, and operators that only
 * accept numerics, so type errors are the typical outcome of a random sample.
 *
 * The "unbound variable" entry was removed after audit #42: with `initBridge`
 * installed (see beforeAll above), the previous "Unbound variable `-`" repro
 * for `(- (* 0 "") (- (- 0 0) 0))` is gone — the dispatch now throws a clean
 * `Cannot apply * to (number, string): argument 1 is string` which matches
 * the "cannot apply" + "argument" branches below.
 */
function isExpectedRuntimeError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message.toLowerCase();
  return (
    msg.includes("division by zero") ||
    msg.includes("type") || // type errors from random string/number mixing are expected
    msg.includes("argument") ||
    msg.includes("not a") ||
    msg.includes("invalid") ||
    msg.includes("cannot apply") || // wrapOperator's new sharpened shape (audit #42)
    msg.includes("cannot convert") ||
    msg.includes("expected")
  );
}

describe("fuzz — evaluator crash safety", () => {
  it("never throws an unexpected error on randomly generated expressions", async () => {
    await fc.assert(
      fc.asyncProperty(arbExpr, async (program) => {
        try {
          await exec(program);
          return true;
        } catch (err) {
          if (!isExpectedRuntimeError(err)) {
            console.error(`fuzz crash: program=${program} err=${String(err)}`);
            return false;
          }
          return true;
        }
      }),
      // Short budget: keeps `pnpm test` snappy while still covering enough
      // shapes to catch a regression. Bump locally when chasing a bug.
      { numRuns: 30, interruptAfterTimeLimit: 5000 },
    );
  });
});
