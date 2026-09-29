/**
 * Test all examples from the Quick Start section to ensure they work
 */

import { describe, expect, it } from "vitest";
import { toSExprString } from "../serializer";
import "@here.build/arrival-env";

describe("Quick Start Examples", () => {
  it("Simple object serialization", () => {
    const result = toSExprString({ name: "Alice", age: 30 });
    // Strings without special chars are unquoted (AI-readable format)
    expect(result).toBe(`{:name Alice :age 30}`);
  });

  it("Array serialization", () => {
    const result = toSExprString([1, 2, 3]);
    expect(result).toBe("[1 2 3]");
  });

  it("Custom serialization with Symbol.toSExpr", () => {
    class Button {
      constructor(
        public label: string,
        public disabled: boolean,
      ) {}

      [Symbol.SExpr]() {
        return "Button"; // display name
      }

      [Symbol.toSExpr](context: any) {
        return [context.keyword("label"), this.label, context.keyword("disabled"), this.disabled];
      }
    }

    const result = toSExprString(new Button("Click me", false));
    // Multi-line formatting by default
    expect(result).toContain("Button");
    expect(result).toContain(`:label "Click me"`);
    expect(result).toContain(":disabled #f");
  });
});
