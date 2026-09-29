// LAW — the `{…}` dict literal's datum face is a real ADict, not a borrowed-JS
// wrapper wearing a dict costume (the dict-literal true-shape design).
// P0 says the code/datum ambiguity of a literal lives in a VALUE OF ITS OWN KIND
// (a pair for applications, AVector for `[…]`, ADict for `{…}`) — the same
// `literalForms` + `arrival/tagless-final/lower` pattern AVector's `evalElements`
// already used. This file pins the five broken probe-table edges the AJSObject
// carrier produced (P4-P8, P11) as law, plus the sibling vector `writeForm`
// downgrade (P5b) the same migration closed in passing and the membrane-exit shape
// (P6). The semantics probes that were ALREADY right (P1-P3, P9, P10, P12) live in
// src/reader/__tests__/polyglot/curly-braces.spec.ts — not re-pinned here.
import { describe, expect, it, beforeAll } from "vitest";
import type { ResolvingAmbient } from "../../env/AmbientRuntime.js";
import { execStateOverFrame as execState } from "../../eval/generator-exec.js";
import { toJS } from "../../membrane/rosetta.js";
import { writeForm } from "../../provenance/slice.js";
import { printValue } from "../../values/print.js";
import { ADict } from "../../values/primitives/ADict.js";
import { AVector } from "../../values/primitives/AVector.js";
import { APair } from "../../values/primitives/APair.js";
import { freshEnv } from "../_fresh-env.js";

describe("dict-literal true shape — the P-table probes (dict-literal-true-shape.md)", () => {
  let env: ResolvingAmbient;
  beforeAll(async () => {
    env = await freshEnv();
  });

  /** Evaluate one top-level form, return its boxed (SchemeValue) result. */
  const evalOne = async (src: string) => {
    const { values } = await execState(src, { env });
    return values.at(-1);
  };

  it("P4/P11 — a quoted dict literal IS an ADict (not an opaque #<js-object>)", async () => {
    const v = await evalOne("'{:a 1}");
    expect(v).toBeInstanceOf(ADict);
    expect(v).not.toHaveProperty("source"); // AJSObject's borrowed-source field — absent, it's a real ADict
  });

  it("P4/P11 — prints as a readable dict, never `#<js-object>` (ADict's own arrival/print)", async () => {
    const v = await evalOne("'{:a 1 :b 2}");
    const printed = printValue(v);
    expect(printed).not.toBe("#<js-object>");
    expect(printed).toBe("(dict :a 1 :b 2)");
  });

  it("P5 — writeForm round-trips a quoted dict literal exactly, unquote-form keys included", async () => {
    const staticOnly = await evalOne("'{:a 1 :b 2}");
    expect(writeForm(staticOnly)).toBe("{:a 1 :b 2}");

    // `,k` in KEY position (curly-braces.spec.ts's own pinned `y_dict_unquote_key_after_separator`
    // shape): the reader always admits an unquote-form key (validated at read time,
    // independent of an enclosing quasiquote — see dict-grammar.ts's `isUnquoteForm`);
    // under plain `quote` it is never substituted, so the literal node's
    // `literalForms` carries the RAW `(unquote k)` form. writeForm must reproduce it
    // verbatim — the static-entry (`keys()`) path could never express this key at
    // all, which is exactly why `literalForms` is the AUTHORITATIVE sequence
    // writeForm serializes from (P8).
    const withUnquoteKey = await evalOne("'{:a 1,,k v}");
    expect(writeForm(withUnquoteKey)).toBe("{:a 1 (unquote k) v}");
  });

  it("P5 (sibling gap, closed in passing) — writeForm round-trips a quoted `[…]` literal as `[…]`, not the R7RS `#(…)` constant", async () => {
    // Before the fix, writeDatum's "vector" case ignored `evalElements` entirely and
    // always emitted `#(…)` — silently downgrading a `[…]` literal to a DIFFERENT
    // datum kind on re-parse (`(vector? '#(a b))` stays #t but a `[…]` node's own
    // identity is lost). Same family of gap as the dict case above: a reader-literal
    // flag the serializer forgot to consult.
    const bracket = await evalOne("'[a (+ 1 2)]");
    expect(bracket).toBeInstanceOf(AVector);
    expect((bracket as AVector).evalElements).toBe(true);
    expect(writeForm(bracket)).toBe("[a (+ 1 2)]");

    // A genuine R7RS `#(…)` constant (evalElements === false) is UNAFFECTED — still
    // its own syntax, never flipped to `[…]`.
    const constant = await evalOne("'#(a b)");
    expect(bracket).not.toBe(constant);
    expect((constant as AVector).evalElements).toBe(false);
    expect(writeForm(constant)).toBe("#(a b)");
  });

  it("P6 — membrane exit rides ADict's own egress proxy, not a raw null-proto reader artifact", async () => {
    const v = await evalOne("'{a: (+ 1 2)}");
    const crossed = toJS(v!) as Record<string, unknown>;
    expect(Object.keys(crossed)).toEqual(["a"]);
    // The OLD AJSObject carrier's `arrival/toJS` returned `this.source` directly — the
    // reader's own null-prototype static-key map, handed to JS AS-IS (an AST-adjacent
    // object crossing raw). ADict's egress goes through `egressContainerProxy`, whose
    // target is `Object.create(Object.prototype)` (egress-proxy.ts) — a plain-JS-shaped
    // proxy, never the null-proto reader source.
    expect(Object.getPrototypeOf(crossed)).toBe(Object.prototype);
    // The nested compound form (`(+ 1 2)`, an APair) egresses through ITS OWN
    // `arrival/toJS` (a list→array projection), never handed across as the raw
    // reader-AST pair instance — a second membrane-boundary leak the old carrier had.
    expect(crossed.a).not.toBeInstanceOf(APair);
    expect(Array.isArray(crossed.a)).toBe(true);
  });

  it("P7 — equal? is structural: two quoted dict literals of the same shape are equal?, and quote/eval coincide exactly when constant", async () => {
    const [a, b] = await Promise.all([evalOne("(equal? '{:a 1} '{:a 1})"), evalOne("(equal? '{:a 1} {:a 1})")]);
    expect(String(a)).toBe("#t");
    expect(String(b)).toBe("#t");

    // `'{:a (+ 1 2)}` holds the RAW form (+ 1 2); `{:a (+ 1 2)}` (code position, no
    // quote) evaluates it to 3 — quote and evaluation diverge here exactly as
    // `'(+ 1 2)` ≠ `(+ 1 2)` already does for a plain list. Before this migration this
    // pair compared unequal for the WRONG reason (AJSObject's Setoid was reference
    // identity, so even two `'{:a 1}` literals never compared equal at all).
    const c = await evalOne("(equal? '{:a (+ 1 2)} {:a (+ 1 2)})");
    expect(String(c)).toBe("#f");
  });

  it("P8 — the two faces agree on scope: `literalForms` is authoritative, `keys()` is honestly only the STATIC subset", async () => {
    const v = await evalOne("'{:a 1,,k v}");
    expect(ADict.isDictLiteral(v)).toBe(true);
    if (!ADict.isDictLiteral(v)) throw new Error("unreachable — asserted above");
    // Four flat forms: :a, 1, (unquote k), v — the unquote-form key has no static
    // entry, so `keys()` reports only the ONE static key (`a`), never lying about
    // having a total mapping the template doesn't have.
    expect(v.literalForms.length).toBe(4);
    expect(v.keys()).toEqual(["a"]);
  });

  it("P12 — two DISTINCT identical literal instances stay reference-distinct (documented, not a regression)", async () => {
    const eqResult = await evalOne("(eq? (@ '{:a (f x)} :a) (@ '{:a (f x)} :a))");
    // Consistent with reference-identity semantics for two SEPARATELY-read literals
    // (each `'{...}` mints its own node, its own form objects) — `equal?` (P7 above)
    // is the structural comparison; `eq?` was never expected to hold here.
    expect(String(eqResult)).toBe("#f");
  });

  it("(dict? '{...}) stays #t — a real ADict now, not an isDictShaped accident", async () => {
    const v = await evalOne("(dict? '{:a 1})");
    expect(String(v)).toBe("#t");
  });
});
