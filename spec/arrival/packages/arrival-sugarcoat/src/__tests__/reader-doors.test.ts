/**
 * Educational error surfaces (errors-as-doors). A rejection must name the actual
 * rule broken and point at the exit — not the nearest symptom.
 */
import { describe, it, expect } from "vitest";
import { readSugarcoat } from "../sugarcoat-read.js";

describe("curly close-check names the real problem", () => {
  it("unknown infix operator is named, with the operator vocabulary", () => {
    expect(() => readSugarcoat("{a ?? b}")).toThrowError(/expected '}' or an infix operator, got '\?\?'.*operators: /s);
  });

  it("a truly unbalanced brace still says unbalanced", () => {
    expect(() => readSugarcoat("{a + b")).toThrowError(/unbalanced \{/);
  });
});

describe("trailing-lambda body teaches the code-context rule", () => {
  it("indentation forms inside a trailing lambda point at the delimited spelling", () => {
    const src = "rows.map{(r) => dict\n  id: r[:id]\n  label: r[:label]}";
    expect(() => readSugarcoat(src)).toThrowError(
      /trailing-lambda body.*indentation forms don't group inside braces.*delimited/s,
    );
  });

  it("unknown operator inside a trailing lambda names the operator too", () => {
    expect(() => readSugarcoat("xs.map{ it ?? fallback }")).toThrowError(/got '\?\?'.*trailing-lambda body/s);
  });
});
