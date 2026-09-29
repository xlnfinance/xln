// lens — the sugarcoat flip (D3). `toLens` composes directly on top of arrival-
// sugarcoat's own printer (schemeToSugarcoat), per arrival-awesome-repl.md §8's
// documented route: no separate value→Node quotation step needed because the
// serializer already hands back parse-safe scheme text.
import { describe, expect, it } from "vitest";

import { toLens } from "../lens.js";

describe("toLens", () => {
  it("scheme lens is the identity — the stored text IS Scheme", () => {
    expect(toLens("(define (f x) (* x 2))", "scheme")).toBe("(define (f x) (* x 2))");
  });

  it("sugarcoat lens renders curly-infix + => lambda + colon kwargs", () => {
    expect(toLens("(define (f x) (* x 2))", "sugarcoat")).toBe("define (f x)\n  {x * 2}");
  });

  it("round-trips a multi-form pipeline through the sugarcoat printer", () => {
    const rendered = toLens("(map (lambda (n) (* n n)) (iota 6))", "sugarcoat");
    expect(rendered).toBe("(iota 6).map{(n) => n * n}");
  });

  it("falls back to the original text when the sugarcoat reader can't model it — never loses content", () => {
    const unparseable = "#| truncated |# )))";
    expect(toLens(unparseable, "sugarcoat")).toBe(unparseable);
  });

  it("empty text is left alone in either lens", () => {
    expect(toLens("", "sugarcoat")).toBe("");
    expect(toLens("   ", "sugarcoat")).toBe("   ");
  });
});
