/**
 * `EnvCapability`-authored rosetta verbs on real-world-shaped JS data (arrays of
 * records, nested dicts, chained calls) — membrane round-trips beyond the scalar
 * codec proofs in `capability-rosetta-symbol.test.ts`.
 *
 * Authoring form: `symbol.rosetta` + capability apply. Verbs bind as
 * `ARosettaProcedure` instances (never bare async functions), so CallCtx is always
 * constructed by the apply term — no Reflect.apply misuse vector to defend.
 *
 * Public `AmbientRuntime.defineRosetta` is gone (see env-privatization-pins).
 * Forbidden bare `{ fn }` authoring remains a separate open migration for external
 * packs (ledger GAPS: "forbidden bare-fn authoring form").
 */
import invariant from "tiny-invariant";
import { describe, expect, it } from "vitest";
import { CONSTANT_CTX } from "../../run/RunContext.js";
import { AValue } from "../../values/primitives/AValue.js";
import { AString } from "../../values/primitives/AString.js";
import { inferenceEnv } from "../../env/inference-env.js";
import type { ResolvingAmbient } from "../../env/AmbientRuntime.js";
import { jsToScheme, toJS } from "../rosetta.js";
import { execOverFrame } from "../../eval/generator-exec.js";
import { testCallCtx } from "../../run/CallCtx.js";
import { EnvCapability } from "../../common/capability.js";
import { applyCapability } from "../../__tests__/_fresh-env.js";
import { ARosettaProcedure } from "../../values/primitives/ARosettaProcedure.js";
import { withDynamicCallSite } from "../../eval/dynamic-call-site.js";
import { tf } from "../../values/tagless-final.js";
import type { SchemeValue } from "../../values/types.js";

let capSeq = 0;
async function withCap(caps: Parameters<typeof applyCapability>[1]): Promise<ResolvingAmbient> {
  const env = inferenceEnv.child(`rosetta-cap-${++capSeq}`);
  await applyCapability(env, caps);
  return env;
}

async function execOne(expr: string, env: ResolvingAmbient): Promise<any> {
  const results = await execOverFrame(expr, { env });
  return results[0];
}

/** A bound value narrows to a callable rosetta verb — the honest shape of what
 *  `EnvCapability`'s rosetta case binds (an `ARosettaProcedure` instance, never a bare
 *  function — see this file's header for why that closes off the old
 *  `Reflect.apply`-a-bad-receiver misuse vector entirely). */
function isRosettaVerb(value: unknown): value is ARosettaProcedure {
  return value instanceof ARosettaProcedure;
}

/** Invoke a bound rosetta verb the way a JS caller (not scheme source) does post-
 *  binder-cut: through its `arrival/tagless-final/apply` term, under the ambient
 *  dynamic call site (empty here — a direct/test call, no evaluator invocation) — same
 *  pattern `capability-rosetta-symbol.test.ts`'s own `invoke` helper uses. */
function invoke(verb: ARosettaProcedure, ...args: unknown[]): unknown {
  return withDynamicCallSite(undefined, () => verb[tf("apply")](args as SchemeValue[], testCallCtx()));
}

describe("Rosetta AmbientRuntime (capability-authored)", () => {
  describe("EnvCapability-bound rosetta verbs", () => {
    it("should extend environment with Rosetta functions", async () => {
      const env = await withCap([
        EnvCapability.define("test/double-all", {
          symbols: (symbol, z) => ({
            "double-all": symbol.rosetta`double-all: doubles every element of a numeric list`(
              { input: [z.list(z.number)], output: [z.list(z.number)] },
              (numbers) => numbers.map((x) => x * 2),
            ),
          }),
        }),
      ]);

      const result = await execOne(`(double-all (list 1 2 3 4 5))`, env);

      // exec already unwraps via toJS — do not re-cross the JS face.
      expect(Array.from(result as Iterable<unknown>)).toEqual([2, 4, 6, 8, 10]);
    });

    it("should handle multiple Rosetta functions", async () => {
      const env = await withCap([
        EnvCapability.define("test/multi-rosetta", {
          symbols: (symbol, z) => ({
            "sum-array": symbol.rosetta`sum-array: sums a numeric list`(
              { input: [z.list(z.number)], output: [z.number] },
              (numbers) => numbers.reduce((a, b) => a + b, 0),
            ),
            "filter-evens": symbol.rosetta`filter-evens: keeps the even elements of a numeric list`(
              { input: [z.list(z.number)], output: [z.list(z.number)] },
              (numbers) => numbers.filter((x) => x % 2 === 0),
            ),
          }),
        }),
      ]);

      const result = await execOne(`(sum-array (filter-evens (list 1 2 3 4 5 6 7 8)))`, env);

      // exec already unwraps via toJS — do not re-cross the JS face.
      expect(result).toBe(20);
    });

    it("should work with complex data structures", async () => {
      // Arbitrary-shaped JS data (records with a `.value` field) — both slots stay
      // `z.dynamic`. WORLD-FLIP REBASELINE (ruling 2026-08-13): the impl converts its
      // boxed INPUT itself (`toJS`) but returns RAW JS — boxing the return is the
      // membrane's job, and an AValue return now doors (`WorldFlipError`).
      const env = await withCap([
        EnvCapability.define("test/extract-values", {
          symbols: (symbol, z) => ({
            "extract-values": symbol.rosetta`extract-values: plucks .value off every element`(
              { input: [z.dynamic], output: [z.dynamic] },
              (rawObjects) => {
                invariant(rawObjects instanceof AValue, "z.dynamic slot is a boxed scheme value");
                const objects = toJS(rawObjects) as Array<{ value: unknown }>;
                return objects.map((obj) => obj.value) as never;
              },
            ),
          }),
        }),
      ]);

      // Create test data (inject via jsToScheme rather than constructing pairs by hand)
      const testData = [
        { name: "first", value: 10 },
        { name: "second", value: 20 },
        { name: "third", value: 30 },
      ];

      // Convert to scheme and call function
      const schemeData = jsToScheme(CONSTANT_CTX, testData, {});
      const verb = env.get("extract-values");
      invariant(isRosettaVerb(verb), "extract-values must resolve to a bound rosetta verb");
      const result = await invoke(verb, schemeData);

      invariant(result instanceof AValue, "invoke returns a boxed scheme value");
      const jsResult = toJS(result as SchemeValue);
      expect(jsResult).toEqual([10, 20, 30]);
    });
  });

  describe("Real-world Use Cases", () => {
    // INVARIANT: a rosetta verb receiving scheme-converted JS objects can filter on a nested
    // style property and results round-trip correctly
    it("should handle the MCP CSS filtering pattern", async () => {
      // This simulates the exact pattern we need for MCP
      const env = await withCap([
        EnvCapability.define("test/filter-by-css-property", {
          symbols: (symbol, z) => ({
            "filter-by-css-property":
              symbol.rosetta`filter-by-css-property: filters nodes whose style[property] === value`(
                { input: [z.dynamic, z.string, z.string], output: [z.dynamic] },
                (rawNodes, property, value) => {
                  invariant(rawNodes instanceof AValue, "z.dynamic slot is a boxed scheme value");
                  const nodes = toJS(rawNodes) as Array<{ style?: Record<string, string> }>;
                  // Raw JS return — the membrane boxes (world-flip rebaseline, 2026-08-13).
                  return nodes.filter((node) => node.style && node.style[property] === value) as never;
                },
              ),
          }),
        }),
      ]);

      // Create test node data
      const testNodes = [
        { name: "div1", style: { overflow: "hidden", color: "red" } },
        { name: "div2", style: { overflow: "visible", color: "blue" } },
        { name: "div3", style: { overflow: "hidden", color: "green" } },
        { name: "span1", style: { display: "block" } },
      ];

      // Convert to scheme and filter
      const schemeNodes = jsToScheme(CONSTANT_CTX, testNodes, {});
      const verb = env.get("filter-by-css-property");
      invariant(isRosettaVerb(verb), "filter-by-css-property must resolve to a bound rosetta verb");
      // The string args cross the membrane as real scheme values — the `z.string`
      // codec decodes them the same way a scheme-level call would.
      const result = await invoke(verb, schemeNodes, new AString("overflow"), new AString("hidden"));

      invariant(result instanceof AValue, "invoke returns a boxed scheme value");
      const jsResult = toJS(result as SchemeValue) as Array<{ name: string }>;
      expect(jsResult).toHaveLength(2);
      expect(jsResult[0].name).toBe("div1");
      expect(jsResult[1].name).toBe("div3");
    });

    // INVARIANT: a rosetta verb can aggregate scheme-converted JS objects into a stats object
    // that round-trips correctly
    it("should create CSS statistics like the MCP server needs", async () => {
      const env = await withCap([
        EnvCapability.define("test/css-property-stats", {
          symbols: (symbol, z) => ({
            "css-property-stats": symbol.rosetta`css-property-stats: aggregates node style property:value counts`(
              { input: [z.dynamic], output: [z.dynamic] },
              (rawNodes) => {
                invariant(rawNodes instanceof AValue, "z.dynamic slot is a boxed scheme value");
                const nodes = toJS(rawNodes) as Array<{ style?: Record<string, string> }>;
                const stats: Record<string, number> = {};
                nodes.forEach((node) => {
                  if (node.style) {
                    Object.entries(node.style).forEach(([prop, value]) => {
                      const key = `${prop}:${value}`;
                      stats[key] = (stats[key] || 0) + 1;
                    });
                  }
                });
                // Raw JS return — the membrane boxes (world-flip rebaseline, 2026-08-13).
                return stats as never;
              },
            ),
          }),
        }),
      ]);

      const testNodes = [
        { style: { overflow: "hidden", display: "block" } },
        { style: { overflow: "visible", display: "block" } },
        { style: { overflow: "hidden", display: "flex" } },
      ];

      const schemeNodes = jsToScheme(CONSTANT_CTX, testNodes, {});
      const verb = env.get("css-property-stats");
      invariant(isRosettaVerb(verb), "css-property-stats must resolve to a bound rosetta verb");
      const result = await invoke(verb, schemeNodes);

      invariant(result instanceof AValue, "invoke returns a boxed scheme value");
      const jsResult = toJS(result as SchemeValue) as Record<string, number>;
      expect(jsResult["overflow:hidden"]).toBe(2);
      expect(jsResult["overflow:visible"]).toBe(1);
      expect(jsResult["display:block"]).toBe(2);
      expect(jsResult["display:flex"]).toBe(1);
    });
  });
});
