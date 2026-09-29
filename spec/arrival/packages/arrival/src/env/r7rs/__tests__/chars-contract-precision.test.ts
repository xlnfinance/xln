// chars-contract-precision.test.ts — RUNTIME proof for the `scheme/chars` capability's
// 2026-07-05 fresh full-file audit fix: 10 comparison ops (`char=?`, `char<?`, `char>?`,
// `char<=?`, `char>=?`, `char-ci=?`, `char-ci<?`, `char-ci>?`, `char-ci<=?`, `char-ci>=?`)
// declared `input: z.array(z.unknown())` even though every element the impl reads is
// genuinely a character (`charValue(c)` per element, or `deriveOrd`'s
// `arrival/tagless-final/lte` dispatch — every ACharacter implements it) — the
// homogeneous-variadic-with-degraded-element-type pattern. Fix: `z.array(z.schemeChar)`.
//
// Mirrors numeric-contract-precision.test.ts's established pattern exactly: a schema's
// PRECISION is only observable at runtime (zod's own `safeParse`) — native ops never run
// this validation during evaluation (bakeNative binds `impl` raw, no decode/encode; see
// this file's own doc comment + _bake.ts), so this is a HARVEST/type-surface proof, not a
// behavior change. The behavior-unchanged proof is the pre-existing r7rs-* suites run
// byte-identical before/after (see the report).
//
// No head/rest split needed here (unlike for-each/string-map's `Contract.inputRest`
// migration in contract-precision-fixes.test.ts) — these ops have no callable head, just
// a flat homogeneous variadic list of characters, so narrowing the single `z.array(...)`
// element schema is the whole fix.

import { describe, expect, it } from "vitest";
import charsPack from "../chars.js";
import type { AEntity } from "../../../common/symbols/_bake.js";
import { ACharacter } from "../../../values/primitives/ACharacter.js";
import { CONSTANT_CTX } from "../../../run/RunContext.js";
import { harvestContracts } from "../../../__tests__/_symbols-harvest.js";

const symbols = harvestContracts(charsPack.spec.symbols);

function nativeDef(name: string) {
  const def = symbols[name];
  if (def === undefined) throw new Error(`chars pack: no symbol named ${name}`);
  if (def.kind !== "native") throw new Error(`chars pack: ${name} is not a native def (got ${def.kind})`);
  return def;
}

const ch = (c: string): ACharacter => new ACharacter(c);

const COMPARISON_OPS = [
  "char=?",
  "char<?",
  "char>?",
  "char<=?",
  "char>=?",
  "char-ci=?",
  "char-ci<?",
  "char-ci>?",
  "char-ci<=?",
  "char-ci>=?",
] as const;

describe("scheme/chars Contract precision — the 10 comparison ops reject a wrongly-typed element (were z.unknown(), now z.schemeChar)", () => {
  it("char=?: accepts real characters, rejects raw JS strings", () => {
    const def = nativeDef("char=?");
    expect(def.in.safeParse([ch("a"), ch("a")]).success).toBe(true);
    expect(def.in.safeParse(["a", "a"]).success).toBe(false);
  });

  it("char<?: accepts real characters, rejects raw JS strings (deriveOrd-driven impl — the schema narrowing is orthogonal to the shared helper)", () => {
    const def = nativeDef("char<?");
    expect(def.in.safeParse([ch("a"), ch("b")]).success).toBe(true);
    expect(def.in.safeParse(["a", "b"]).success).toBe(false);
  });

  it("char-ci<?: accepts real characters, rejects raw JS strings", () => {
    const def = nativeDef("char-ci<?");
    expect(def.in.safeParse([ch("a"), ch("B")]).success).toBe(true);
    expect(def.in.safeParse(["a", "B"]).success).toBe(false);
  });

  it("every comparison op: 0/1-arg trivial-true arities still parse, a real-character array of any length parses, a raw-string array of the SAME length no longer does", () => {
    for (const name of COMPARISON_OPS) {
      const def = nativeDef(name);
      expect(def.in.safeParse([]).success, `${name}: empty array`).toBe(true);
      expect(def.in.safeParse([ch("x")]).success, `${name}: single real char`).toBe(true);
      expect(def.in.safeParse([ch("x"), ch("y"), ch("z")]).success, `${name}: real char array`).toBe(true);
      expect(def.in.safeParse(["x", "y", "z"]).success, `${name}: raw string array — was true, now false`).toBe(false);
    }
  });

  it("EVERY native op in the pack now rejects an arbitrary-shape raw-JS-garbage array (the blanket straggler sweep — mirrors numeric-contract-precision.test.ts)", () => {
    const garbage = ["not-a-char", 123, null, {}];
    const stragglers: string[] = [];
    for (const [name, def] of Object.entries(symbols)) {
      if (def.kind !== "native") continue;
      if (def.in.safeParse(garbage).success) stragglers.push(name);
    }
    expect(stragglers).toEqual([]);
  });

  it("sanity: the pack exports exactly 22 symbols (21 contract-bearing natives + char? tagless-guard) — the scope this fix must cover", () => {
    expect(Object.keys(symbols)).toHaveLength(22);
  });
});
