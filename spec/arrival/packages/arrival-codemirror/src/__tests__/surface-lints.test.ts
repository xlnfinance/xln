/**
 * Sugarcoat surface lints — face-only warnings. Tight `@id[…]` is now the
 * canonical keyed-access surface inside at-bodies (not a lint target).
 */
import { describe, it, expect } from "vitest";
import { sugarcoatSurfaceLints } from "../sugarcoat-ide.js";

describe("sugarcoatSurfaceLints", () => {
  it("stays quiet on tight @id[…] accessor surface (canonical)", () => {
    expect(sugarcoatSurfaceLints("@{from @s[:baseline] to @s[:current]}")).toHaveLength(0);
  });

  it("stays quiet on grafts, boundaries, and ordinary forms", () => {
    expect(sugarcoatSurfaceLints("@{from @(:baseline s) to @(:current s)}")).toHaveLength(0);
    expect(sugarcoatSurfaceLints("@{v: @|ver|[beta]}")).toHaveLength(0);
    expect(sugarcoatSurfaceLints("`(a ,@xs[0])")).toHaveLength(0);
    expect(sugarcoatSurfaceLints("@{count @n [approx]}")).toHaveLength(0);
  });
});
