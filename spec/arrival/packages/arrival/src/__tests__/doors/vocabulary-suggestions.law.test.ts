// F6 — Unbound-variable TYPO SUGGESTIONS (P5 errors-as-doors; the typo half of the
// dissolved `polyglot-rich-errors` sub-capability). ONE law: suggestions derive from
// the resolution chain's ACTUAL VOCABULARY — every name the missed lookup could have
// found (real bindings, prelude defines, the declared `symbol.notImplemented` doors,
// lexical program names) — never from a curated side table.
//
// A mistyped name is the one class that CANNOT be a declared capability (it has no
// declaration site), so it survives inside `unboundVariableError` (src/unbound-
// variable.ts, consumed by AmbientRuntime.get / Resolver.resolveSynth). The EXACT-name
// half of the old registry became declarations: doors resolve through the ordinary
// chain and are thereby typo-suggestible FOR FREE through this same mechanism —
// suggest the door, and calling the door teaches the reason.
//
// GATE UNDER TEST (load-bearing): a hint fires ONLY for a close miss of a name that
// exists in the vocabulary — an arbitrary unbound identifier still gets the PLAIN,
// unenriched "Unbound variable", byte-identical to the pre-enrichment wording (the
// manifold's H-4 one-line-wall contract pins the plain form downstream).

import { describe, expect, it } from "vitest";
import { exec } from "../../eval/generator-exec.js";
import { suggestFromVocabulary, unboundVariableError } from "../../unbound-variable.js";

describe("suggestFromVocabulary — the vocabulary-sourced typo gate (unit, no eval)", () => {
  const VOCAB = ["reduce", "println", "string-split", "list", "dict", "dict?", "@", "@?", "->", "%purity-door"];

  it("fires on a one-character typo of a vocabulary name", () => {
    expect(suggestFromVocabulary("reduse", VOCAB)).toEqual(["reduce"]);
    expect(suggestFromVocabulary("printlm", VOCAB)).toEqual(["println"]);
  });

  it("fires on a CANONICAL-FORM match (dash/underscore/case variance)", () => {
    expect(suggestFromVocabulary("string_split", VOCAB)).toEqual(["string-split"]);
    expect(suggestFromVocabulary("StringSplit", VOCAB)).toEqual(["string-split"]);
  });

  it("does NOT fire for an arbitrary identifier near nothing", () => {
    expect(suggestFromVocabulary("csv-content", VOCAB)).toEqual([]);
    expect(suggestFromVocabulary("my-custom-helper-fn", VOCAB)).toEqual([]);
  });

  it("LENGTH FLOOR: short names never get edit-distance suggestions (a 1-char name is one substitution from everything)", () => {
    for (const name of ["a", "b", "z", "ab"]) {
      expect(suggestFromVocabulary(name, VOCAB)).toEqual([]);
    }
  });

  it("`%`-prefixed internals and symbol-typed keys are never suggestion candidates", () => {
    expect(suggestFromVocabulary("purity-door", VOCAB)).toEqual([]);
    expect(suggestFromVocabulary("reduse", [Symbol("reduce"), "reduce"])).toEqual(["reduce"]);
  });

  it("resolver-STRUCTURAL names (c[ad]+r synthesis) are seeded candidates despite being absent from every enumerable vocabulary", () => {
    expect(suggestFromVocabulary("cair", [])).toEqual(["car"]);
    expect(suggestFromVocabulary("cdrr", [])).toContain("cdr");
  });

  it("caps at 3 deterministic (code-unit-sorted) suggestions on a tie", () => {
    const near = suggestFromVocabulary("dact", ["dbct", "dcct", "dect", "dfct", "daat"]);
    expect(near).toHaveLength(3);
    expect(near).toEqual([...near].sort());
  });
});

describe("unboundVariableError — message shapes + the `enriched` structured marker (unit, no eval)", () => {
  // `enriched` is a THIRD signal alongside `.message`/`.publicMessage` — unambiguously
  // true iff a did-you-mean suffix was appended, independent of either string's wording
  // (replaces a manifold-side string-shape sniff on `.message`; see unbound-variable.ts).
  it("true for a typo of a vocabulary name, false for a bare miss, false with no vocabulary at all", () => {
    expect(unboundVariableError("reduse", ["reduce"]).enriched).toBe(true);
    expect(unboundVariableError("csv-content", ["reduce"]).enriched).toBe(false);
    expect(unboundVariableError("reduse").enriched).toBe(false);
  });

  it("the enriched wording carries the suggestion; the plain wording is byte-identical to the pre-enrichment form", () => {
    const enriched = unboundVariableError("reduse", ["reduce"]);
    expect(enriched.message).toBe("Unbound variable `reduse' — did you mean `reduce`?");
    expect(enriched.publicMessage).toBe(
      "symbol reduse does not exist - look at list of available functions at tool description (did you mean `reduce`?)",
    );
    const bare = unboundVariableError("csv-content", ["reduce"]);
    expect(bare.message).toBe("Unbound variable `csv-content'");
    expect(bare.publicMessage).toBe(
      "symbol csv-content does not exist - look at list of available functions at tool description",
    );
    expect(bare.enriched).toBe(false);
  });
});

describe("LIVE enrichment at the arrival throw site (default assembled env)", () => {
  it("a typo of a REAL bound symbol suggests it", async () => {
    await expect(exec("reduse")).rejects.toThrow(/Unbound variable `reduse' — did you mean .*`reduce`/);
  });

  it("a typo of a DECLARED DOOR suggests it (declaring a stub makes it typo-suggestible for free)", async () => {
    await expect(exec("printlm")).rejects.toThrow(/Unbound variable `printlm' — did you mean .*`println`/);
  });

  it("a typo of a PRELUDE-DEFINED name suggests it (the static table never knew preludes)", async () => {
    // fold-right is a scheme prelude define in srfi-1.ts — in the chain's vocabulary
    // because the vocabulary IS the baked env, not a curated list.
    await expect(exec("fold-rigt")).rejects.toThrow(/did you mean .*`fold-right`/);
  });

  it("a canonical-form miss (underscore/case spelling of a bound name) suggests it", async () => {
    await expect(exec("string_split")).rejects.toThrow(/did you mean `string-split`\?/);
  });

  it("a typo of a LEXICALLY bound program name suggests it (the Resolver passes its composed scope+capabilities vocabulary)", async () => {
    await expect(exec("(define my-accumulator 41)\nmy-acumulator")).rejects.toThrow(
      /Unbound variable `my-acumulator' — did you mean `my-accumulator`\?/,
    );
  });

  it("an arbitrary unbound identifier throws the PLAIN message — no hint fabricated", async () => {
    await expect(exec("csv-content")).rejects.toThrow(/^Unbound variable `csv-content'$/);
  });

  // `UnboundVariableError` is itself an `ArrivalError` now (errors-as-doors extraction,
  // 2026-07-11), so whether it reaches the caller unwrapped or nested under `.cause` of a
  // further wrapper is an evaluator-internal wrapping-depth detail, not this law's subject.
  // The INVARIANT under test is narrower: the `.enriched` structured signal survives the
  // throw somewhere on the caught error's own chain — check both faces rather than pin the
  // wrap depth.
  const causeEnriched = async (src: string): Promise<boolean | undefined> => {
    try {
      await exec(src);
    } catch (e) {
      const err = e as Error & { enriched?: boolean; cause?: { enriched?: boolean } };
      return err.enriched ?? err.cause?.enriched;
    }
    throw new Error(`expected exec to reject for: ${src}`);
  };

  it("LIVE: `.enriched` is true when the throw carries a hint, false for the bare wall", async () => {
    expect(await causeEnriched("reduse")).toBe(true);
    expect(await causeEnriched("csv-content")).toBe(false);
  });

  it("LIVE: a structural c[ad]+r near-miss still routes to `car` without any table", async () => {
    await expect(exec("cair")).rejects.toThrow(/did you mean .*`car`/);
  });
});
