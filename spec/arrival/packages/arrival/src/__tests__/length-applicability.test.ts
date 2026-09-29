import { describe, expect, it } from "vitest";
import { execOverFrame as exec } from "../eval/generator-exec.js";
import { inferenceEnv } from "../env/inference-env.js";
import { is_false } from "../values/value-guards.js";

/**
 * length applicability — the last fl-interop op dissolved to per-term tagless-final dispatch.
 * The per-primitive count lives on each TERM as arrival/tagless-final/length (pair spine /
 * vector payload / string code-points / bytevector bytes / js-array / nil -> 0); this op is the
 * COMBINATOR that dispatches to it. Universal over any countable term; a non-countable
 * (number/boolean) is a totalic throw, NOT a silent 0 (the bug the old collectElements
 * lenient-[] fallback hid for strings — `(length "abc")` used to count 0).
 *
 * length stays SYNC / bare-scalar (a count is a value-layer read), consistent with
 * vector-length — so counts are compared with numeric `=` (which coerces the bare scalar), not
 * structural `equal?`. A strict R7RS-list-only probe (vector/string -> throw) is deferred — see
 * the binding note (it needs ctx, and the async ctx-builder broke bare-scalar forcing).
 */
const run = (code: string) => exec(code, { env: inferenceEnv.child("length-applicability") });
const truthy = async (code: string): Promise<boolean> => !is_false((await run(code))[0]);

describe("length — universal element count over any countable term", () => {
  it("counts pairs, vectors, strings, bytevectors, and the empty list", async () => {
    expect(await truthy("(= (length (list 1 2 3)) 3)")).toBe(true);
    expect(await truthy("(= (length (quote ())) 0)")).toBe(true);
    expect(await truthy("(= (length (vector 1 2 3 4)) 4)")).toBe(true);
    expect(await truthy('(= (length "abc") 3)')).toBe(true); // fixes the old silent 0
    expect(await truthy("(= (length (bytevector 1 2)) 2)")).toBe(true);
  });
  it("a non-countable (number / boolean) is a totalic throw, never a silent 0", async () => {
    await expect(run("(length 5)")).rejects.toThrow();
    await expect(run("(length #t)")).rejects.toThrow();
  });
});
