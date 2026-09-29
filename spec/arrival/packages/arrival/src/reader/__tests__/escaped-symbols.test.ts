import { CONSTANT_CTX } from "../../run/RunContext.js";
import type { ResolvingAmbient } from "../../env/AmbientRuntime.js";
/**
 * Test the `|...|` bar-quoted SYMBOL-GRAMMAR reader — empty `||`, escaped
 * `\|`, unicode inside bars, special chars, case-sensitivity, and the
 * `:24` keyword-vs-`|24|` reader disambiguation.
 *
 * Split from ../../__tests__/escaped-symbols.test.ts (reader-cluster half);
 * the define/resolve + `@` property-access + MCP UUID-resolution cases stayed
 * there (eval/membrane cluster). Cases moved verbatim, redundancy against
 * ../Parser-level `|...|` cases in parser.test.ts is acceptable (not deduped
 * here per the split's own instructions).
 */
import { describe, expect, it } from "vitest";
import { inferenceEnv } from "../../env/inference-env.js";
import { execOverFrame as exec } from "../../eval/generator-exec.js";
import { jsToScheme } from "../../membrane/rosetta.js";

// Helper to execute and get first result
async function execOne(expr: string, env: ResolvingAmbient = inferenceEnv.child("reader-escaped-one")): Promise<any> {
  const results = await exec(expr, { env });
  return results[0];
}

describe("Escaped Symbol Resolution", () => {
  describe("Basic escaped symbols", () => {
    it("should handle symbols with special characters", async () => {
      const result = await execOne(`
        (begin
          (define |foo-bar!@#| "special")
          |foo-bar!@#|)
      `);

      expect(result).toBe("special");
    });
  });

  describe("Keywords vs escaped symbols", () => {
    it("should distinguish :24 from |24|", async () => {
      const testObj = {
        "24": "numeric key value",
      };

      const env = inferenceEnv.child("reader-escaped-24", { "test-obj": jsToScheme(CONSTANT_CTX, testObj) });

      // :24 should be treated as keyword and converted to "24" by @ function
      const result1 = await execOne(`(@ test-obj :24)`, env);
      expect(result1).toBe("numeric key value");

      // :|24| should also work (keyword with escaped symbol)
      const result2 = await execOne(`(@ test-obj :|24|)`, env);
      expect(result2).toBe("numeric key value");
    });
  });

  describe("Edge cases and resolution", () => {
    it("should handle empty escaped symbol", async () => {
      // R7RS §7.1.1: `||` is the symbol whose name is the empty string.
      const result = await execOne(`
        (begin
          (define || "empty")
          ||)
      `);
      expect(result).toBe("empty");
    });

    it("should handle unicode in escaped symbols", async () => {
      const result = await execOne(`
        (begin
          (define |hello-世界| "unicode works")
          |hello-世界|)
      `);

      expect(result).toBe("unicode works");
    });

    it("should handle pipes inside escaped symbols", async () => {
      // R7RS §7.1.1: `\|` inside `|...|` is a literal `|` in the symbol's name.
      const result = await execOne(`
        (begin
          (define |foo\\|bar| "pipe inside")
          |foo\\|bar|)
      `);
      expect(result).toBe("pipe inside");
    });

    it("should preserve case sensitivity in escaped symbols", async () => {
      const result = await execOne(`
        (begin
          (define |MyVariable| "uppercase")
          (define |myvariable| "lowercase")
          (list |MyVariable| |myvariable|))
      `);

      expect(result).toEqual(["uppercase", "lowercase"]);
    });
  });
});
