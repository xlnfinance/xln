/**
 * Racket `#:limit` ≡ arrival `:limit`.
 *
 * The reader lexes `#:limit` as one symbol token; `ASymbol` construction
 * recognizes the `#:` prefix as a keyword spelling and canonicalizes to the
 * interned `AKeywordSymbol` named `:limit`. Same identity, self-eval, kwargs
 * pluck, and accessor apply as the colon form.
 */
import { describe, expect, it } from "vitest";

import { exec, parse } from "../eval/generator-exec.js";
import { AKeywordSymbol, ASymbol } from "../values/primitives/ASymbol.js";

describe("Racket #:keyword ≡ :keyword", () => {
  it("parses #:limit as the keyword :limit (AKeywordSymbol)", async () => {
    const [sym] = await parse("#:limit");
    expect(sym).toBeInstanceOf(AKeywordSymbol);
    expect((sym as ASymbol).__name__).toBe(":limit");
  });

  it("#:limit and :limit are the same interned instance", async () => {
    const [a] = await parse("#:limit");
    const [b] = await parse(":limit");
    expect(a).toBe(b);
  });

  it("self-evaluates (not unbound) and is eq? to :limit", async () => {
    // exec crosses keywords to JS strings via toJS — pin identity in scheme.
    const [same] = await exec("(eq? #:limit :limit)");
    expect(same).toBe(true);
  });

  it("works as a list element alongside :limit (same identity)", async () => {
    const [same] = await exec("(eq? (car (list #:limit)) (car (list :limit)))");
    expect(same).toBe(true);
  });

  it("dict keys accept #:a as :a", async () => {
    const [v] = await exec("(:a {#:a 42})");
    expect(v).toBe(42);
  });

  it("accessor apply: (#:name d) ≡ (:name d)", async () => {
    const [viaHash] = await exec('(#:name (dict :name "Ada"))');
    const [viaColon] = await exec('(:name (dict :name "Ada"))');
    expect(viaHash).toBe("Ada");
    expect(viaColon).toBe("Ada");
  });
});
