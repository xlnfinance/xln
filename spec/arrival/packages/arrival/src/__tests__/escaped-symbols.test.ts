import { CONSTANT_CTX } from "../run/RunContext.js";
import type { ResolvingAmbient } from "../env/AmbientRuntime.js";
/**
 * Test escaped symbols and edge cases in arrival
 *
 * arrival supports escaped symbols like |symbol with spaces| or |24|
 * These tests verify proper resolution and interop with JS
 *
 * The pure `|...|` bar-quoted SYMBOL-GRAMMAR reader cases (empty ||, escaped
 * \|, unicode inside bars, special chars, case-sensitivity, :24-vs-|24|
 * disambiguation) moved to ../reader/__tests__/escaped-symbols.test.ts. This
 * file keeps define/resolve, `@` property access, MCP UUID resolution
 * patterns, and evaluator/membrane symbol resolution.
 */
import { describe, expect, it } from "vitest";
import { inferenceEnv } from "../env/inference-env.js";
import { execOverFrame as exec } from "../eval/generator-exec.js";
import { jsToScheme } from "../membrane/rosetta.js";
import { EnvCapability } from "../common/capability.js";
import { applyCapability } from "./_fresh-env.js";

async function execOne(expr: string, env: ResolvingAmbient = inferenceEnv.child("escaped-one")): Promise<any> {
  const results = await exec(expr, { env });
  return results[0];
}

describe("Escaped Symbol Resolution", () => {
  describe("Basic escaped symbols", () => {
    it("should handle numeric symbols like |24|", async () => {
      const result = await execOne(`
        (begin
          (define |24| "twenty-four")
          |24|)
      `);

      expect(result).toBe("twenty-four");
    });

    it("should handle symbols with spaces", async () => {
      const result = await execOne(`
        (begin
          (define |my variable| 42)
          |my variable|)
      `);

      expect(result).toBe(42);
    });
  });

  describe("Escaped symbols with property access", () => {
    it("should access numeric object keys", async () => {
      const result = await execOne(
        `(@ test-obj :|24|)`,
        inferenceEnv.child("escaped-test", {
          // Box the host object through the membrane — `inherit` stores its record
          // values raw, so the binding must already be a Scheme value (it is read
          // back through `@`/keyword-access as an AJSObject).
          "test-obj": jsToScheme(CONSTANT_CTX, {
            "24": "value-24",
            "42": "value-42",
            normal: "normal-value",
          }),
        }),
      );
      expect(result).toBe("value-24");
    });
  });

  describe("Escaped symbols in function names", () => {
    it("should define and call functions with escaped names", async () => {
      // Test-local EnvCapability with `symbol.rosetta`. The bound verb's KEY is the
      // exact scheme-facing name — a space or leading digit is an ordinary JS property
      // string; the binder doesn't care that the reader only reaches it via `|escaped|`.
      const env = inferenceEnv.child("escaped-get-24");
      await applyCapability(env, [
        EnvCapability.define("test/get-24", {
          symbols: (symbol, z) => ({
            "get-24": symbol.rosetta`get-24: a zero-arg numeric source`({ input: [], output: [z.number] }, () => 24),
          }),
        }),
      ]);

      const result = await execOne(`(|get-24|)`, env);
      expect(result).toBe(24);
    });

    it("should define functions with space-containing names", async () => {
      const env = inferenceEnv.child("escaped-my-function");
      await applyCapability(env, [
        EnvCapability.define("test/my-function", {
          symbols: (symbol, z) => ({
            "my function": symbol.rosetta`my function: doubles its argument`(
              { input: [z.number], output: [z.number] },
              (x) => x * 2,
            ),
          }),
        }),
      ]);

      const result = await execOne(`(|my function| 21)`, env);
      expect(result).toBe(42);
    });
  });

  describe("Keywords vs escaped symbols", () => {
    it("should handle keywords with special characters", async () => {
      const testObj = {
        "foo-bar": "hyphenated",
        foo_bar: "underscored",
      };

      const env = inferenceEnv.child("escaped-kw", { "test-obj": jsToScheme(CONSTANT_CTX, testObj) });

      const result = await execOne(
        `
        (list
          (@ test-obj :foo-bar)
          (@ test-obj :foo_bar))
      `,
        env,
      );

      expect(result).toEqual(["hyphenated", "underscored"]);
    });
  });

  describe("MCP real-world patterns", () => {
    it("should handle component UUIDs as property keys", async () => {
      const component = {
        "794f1e9c-5726-4a0c-a8b6-c0ae5f31f4e4": {
          name: "Button",
          type: "component",
        },
      };

      const env = inferenceEnv.child("escaped-uuid", { components: jsToScheme(CONSTANT_CTX, component) });

      const result = await execOne(
        `
        (@ components :|794f1e9c-5726-4a0c-a8b6-c0ae5f31f4e4|)
      `,
        env,
      );

      expect(result).toMatchObject({ name: "Button" });
    });

    it("should chain property access with mixed key types", async () => {
      const data = {
        projects: [
          {
            id: "794f1e9c-5726-4a0c-a8b6-c0ae5f31f4e4",
            name: "My Project",
            "24": "numeric property value",
          },
        ],
      };

      const env = inferenceEnv.child("escaped-chain", { data: jsToScheme(CONSTANT_CTX, data) });

      const result = await execOne(
        `
        (begin
          (define project (car (@ data :projects)))
          (list
            (@ project :id)
            (@ project :name)
            (@ project :|24|)))
      `,
        env,
      );

      expect(result).toEqual(["794f1e9c-5726-4a0c-a8b6-c0ae5f31f4e4", "My Project", "numeric property value"]);
    });

    it("should filter objects by properties with escaped keys", async () => {
      const items = [
        { "item-id": "1", "24": "first" },
        { "item-id": "2", "24": "second" },
        { "item-id": "3", "24": "first" },
      ];

      // Convert to scheme list — scheme filter expects pair chains, not JS arrays
      const env = inferenceEnv.child("escaped-filter", { items: jsToScheme(CONSTANT_CTX, items) });

      // Use `string=?` for string comparison — `eq?` is reference identity (R7RS § 6.1)
      // and post-eq?/eqv?-split returns #f for two distinct heap string instances.
      const result = await execOne(
        `
        (filter
          (lambda (item) (string=? (@ item :|24|) "first"))
          items)
      `,
        env,
      );

      expect(result).toHaveLength(2);
      expect(result[0]["item-id"]).toBe("1");
      expect(result[1]["item-id"]).toBe("3");
    });
  });
});
