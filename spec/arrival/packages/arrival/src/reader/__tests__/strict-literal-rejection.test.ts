import { describe, expect, it } from "vitest";
import { exec, execState } from "../../eval/generator-exec.js";
import { theVoid } from "../../values/primitives/AVoid.js";
import { is_nil } from "../../values/value-guards.js";
import { ANil } from "../../values/primitives/ANil.js";

/**
 * Strict mode is the R7RS portability CONTROL — NOT the default. The `#void`/`#null`
 * reader literals are loose-mode tolerances: a program that writes them is not portable
 * to a stock Scheme (R7RS has no readable void/null literal). Strict parse REJECTS them;
 * the loose default resolves them (to the void singleton / nil). Crucially the VALUES
 * still exist in both modes — only the non-standard readable LITERAL is gated, so this
 * is the divergence signal a user runs strict to find.
 *
 * Mirrors the loose/strict template in projection-nil-tolerance / comparison-divergence.
 * Design history: the graal-membrane dissolution proposal (private monorepo docs).
 */
describe("strict rejects the #void/#null reader literals (portability control)", () => {
  for (const lit of ["#void", "#null"]) {
    it(`strict: \`${lit}' is rejected at parse time as non-portable`, async () => {
      await expect(exec(lit, { strict: true })).rejects.toThrow(/portable|strict/i);
    });
  }

  it("loose (default): #void resolves to the void singleton", async () => {
    // execState (COMPLEX tier): asserts box IDENTITY (RULINGS.md R1) — `exec`'s
    // plain-JS exit would unwrap AVoid to `undefined`, losing the singleton check.
    const [result] = (await execState("#void")).values;
    expect(result).toBe(theVoid);
  });

  it("loose (default): #null resolves to nil", async () => {
    const [result] = (await execState("#null")).values;
    expect(result).toBeInstanceOf(ANil);
  });
});
