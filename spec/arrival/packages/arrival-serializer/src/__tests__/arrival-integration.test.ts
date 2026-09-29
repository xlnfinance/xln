import { describe, expect, it } from "vitest";
import { toSExprString } from "../serializer";
import { exec, execState, EnvCapability, toJS, ANil, LexicalScope } from "@inhuman.tools/arrival";
import { AExact, AString, ASymbol, APair } from "@inhuman.tools/arrival/reflect-internals";

async function serializeForm(expr: string): Promise<string> {
  // Raw scheme values (execState), not exec's toJS-collapsed ones — nil must stay ANil
  // for the serializer's isNil check to render `[nil]` instead of a plain `[]`.
  const { values } = await execState(expr);
  return toSExprString(values[0]);
}

describe("serialize exec results", () => {
  it.each([
    { expr: "(+ 1 2)", expected: "3" },
    { expr: "(list 1 2 3)", expected: "[1 2 3]" },
    { expr: "'hello", expected: "hello" },
    { expr: "(map (lambda (x) (* x 2)) (list 1 2 3))", expected: "[2 4 6]" },
    { expr: "42", expected: "42" },
    { expr: "3.14", expected: "3.14" },
    { expr: "#t", expected: "#t" },
    { expr: "#f", expected: "#f" },
    { expr: '"hello world"', expected: `"hello world"` },
    { expr: "'symbol-name", expected: "symbol-name" },
    { expr: "()", expected: "nil" },
    { expr: "#\\a", expected: "#\\a" },
  ] as const)("$expr serializes as $expected", async ({ expr, expected }) => {
    const serialized = await serializeForm(expr);
    expect(serialized).toBe(expected);
    expect(serialized).not.toContain(":__value__");
    expect(serialized).not.toContain(":car");
  });
});

describe("exec with proper environment", () => {
  it("should execute single expressions and return unwrapped values", async () => {
    // execState, not exec: a raw AExact reaches toJS directly here (exec's toJS
    // would collapse it before toJS ever saw it). `forceBigInt` itself is retired —
    // the one-number rework (docs/design-history/arrival-one-number-rework.md) makes every
    // scheme number's JS face a plain `number`; exactness is a box-class distinction
    // (AExact/AInexact), never a payload type — there is no bigint face left to force.
    const { values } = await execState("(+ 1 2)");
    const result = toJS(values[0]);
    expect(result).toBe(3);
  });

  it("should handle multiple expressions (returns first)", async () => {
    const { values: rawResults } = await execState("(+ 1 2) (* 3 4) (quote hello)");
    const results = rawResults.map((v) => toJS(v));
    expect(results[0]).toBe(3); // First result
    expect(results[1]).toBe(12); // Second result
    // Symbol needs special handling
    expect(rawResults[2]).toBeInstanceOf(ASymbol);
    expect(rawResults[2].__name__).toBe("hello");
  });

  it("should handle lists (returns Pair)", async () => {
    const result = (await execState("(list 1 2 3)")).values[0];
    expect(result).toBeInstanceOf(APair);
    expect(result.car).toBeInstanceOf(AExact);
  });

  it("should handle symbols (returns SchemeSymbol)", async () => {
    const result = (await execState("'symbol-name")).values[0];
    expect(result).toBeInstanceOf(ASymbol);
    expect(result.__name__).toBe("symbol-name");
  });

  it("should handle strings (returns SchemeString)", async () => {
    const result = (await execState('"hello world"')).values[0];
    expect(result).toBeInstanceOf(AString);
    expect(result.__string__).toBe("hello world");
  });

  it("should handle booleans", async () => {
    const result = (await exec("#t"))[0];
    expect(result).toBe(true);
  });

  it("should handle complex expressions (returns Pair structures)", async () => {
    const result = (await execState("(map (lambda (x) (* x 2)) (list 1 2 3))")).values[0];
    expect(result).toBeInstanceOf(APair);
    // Result is Pair with SchemeExact values
    expect(result.car).toBeInstanceOf(AExact);
    expect(result.car.num).toBe(2);
    expect(result.cdr.car.num).toBe(4);
  });

  it("should handle empty expressions (returns Nil)", async () => {
    const result = (await execState("()")).values[0];
    expect(result).toBeInstanceOf(ANil);
  });

  it("should have access to Ramda functions", async () => {
    const result = (await execState("(map (lambda (x) (+ x 1)) (list 1 2 3))")).values[0];
    expect(result).toBeInstanceOf(APair);

    // Convert to JS values for easier testing
    const values = toJS(result);
    expect(values).toEqual([2, 3, 4]);
  });

  it("should have access to functional composition", async () => {
    const { values } = await execState("((compose (lambda (x) (+ x 1)) (lambda (x) (+ x 1))) 5)");
    const result = toJS(values[0]);
    expect(result).toBe(7);
  });

  it("should support environment variables", async () => {
    // Host-supplied values enter as CAPABILITY data (`symbol.value` defs — the untagged
    // `{ value }` arm is retired) — the hermetic-Environment ruling retired the JS-side
    // `env.set` write surface.
    const scope = LexicalScope.fresh("test");
    const envVars = EnvCapability.define("serializer-test/env-vars", {
      symbols: (symbol) => ({ x: symbol.value`x: test constant`(10), y: symbol.value`y: test constant`(20) }),
    });
    const { values } = await execState("(+ x y)", { scope, capabilities: [envVars] });
    const result = toJS(values[0]);
    expect(result).toBe(30);
  });
});
