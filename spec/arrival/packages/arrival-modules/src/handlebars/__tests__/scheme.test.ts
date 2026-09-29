import { describe, expect, it } from "vitest";

import { hbsContentsToSchemeSource } from "../scheme.js";
import { templateHandlebars } from "../runtime.js";

describe("hbsContentsToSchemeSource", () => {
  it("is pure convert to the CALLABLE RULE lambda shape (fixed-first, not bare variadic)", () => {
    const scheme = hbsContentsToSchemeSource("Hello {{name}}");
    expect(scheme).toBe(
      `(lambda (arg . rest) (template/handlebars ${JSON.stringify("Hello {{name}}")} (cons arg rest)))`,
    );
  });
});

describe("runtime (mercury emit target)", () => {
  it("templateHandlebars renders dict args", () => {
    expect(templateHandlebars("Hi {{name}}", { name: "V" })).toBe("Hi V");
  });

  it("templateHandlebars wraps a single primitive when template has one root field", () => {
    expect(templateHandlebars("Hi {{name}}", "V")).toBe("Hi V");
  });
});
