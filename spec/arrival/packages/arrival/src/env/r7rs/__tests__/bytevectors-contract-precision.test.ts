// bytevectors-contract-precision.test.ts — RUNTIME proof that the scheme/bytevectors precision
// fix (`bytevector` / `bytevector-append`) actually lands on the REAL exported ops — not a
// synthetic mirror (see the sibling `bytevectors.test-d.ts` for the type-level mechanism proofs,
// which must stay synthetic because `NativeSymbolDef.in`/`.out` erase `I`/`O` on any real
// export). Mirrors `numeric-contract-precision.test.ts`'s established pattern: a schema's
// PRECISION is only observable at runtime (zod's own `safeParse`) — native ops never run this
// validation during evaluation (see bytevectors.ts's own module doc comment), so this is a
// HARVEST/type-surface proof, not a behavior change. The behavior-unchanged proof is the full
// existing suite run byte-identical before/after (see the report).
//
// RED-before: both `bytevector` and `bytevector-append` declared `input: z.array(z.unknown())`
// — literally anything, any arity, slips through — so every "must reject" assertion below fails
// (`.success` is `true`, not `false`) until the fix narrows the element schema.
import { describe, expect, it } from "vitest";
import bytevectorsPack from "../bytevectors.js";
import type { AEntity } from "../../../common/symbols/_bake.js";
import { ABytevector } from "../../../values/primitives/ABytevector.js";
import { AExact } from "../../../values/primitives/AExact.js";
import { AString } from "../../../values/primitives/AString.js";
import { CONSTANT_CTX } from "../../../run/RunContext.js";
import { harvestContracts } from "../../../__tests__/_symbols-harvest.js";

const symbols = harvestContracts(bytevectorsPack.spec.symbols);

function nativeDef(name: string) {
  const def = symbols[name];
  if (def === undefined) throw new Error(`bytevectors pack: no symbol named ${name}`);
  if (def.kind !== "native") throw new Error(`bytevectors pack: ${name} is not a native def (got ${def.kind})`);
  return def;
}

const exact = (n: number): AExact => new AExact(n);
const bv = (bytes: number[]): ABytevector => new ABytevector(Uint8Array.from(bytes));

describe("scheme/bytevectors Contract precision — the real exported ops reject wrongly-typed args (were z.array(z.unknown()), now precise)", () => {
  it("bytevector: every arg must be a scheme number — a raw JS number or a non-number used to slip through the old z.array(z.unknown())", () => {
    const def = nativeDef("bytevector");
    expect(def.in.safeParse([exact(1), exact(2), exact(255)]).success).toBe(true);
    expect(def.in.safeParse([]).success).toBe(true); // 0-arg call stays legal (an empty bytevector)
    expect(def.in.safeParse(["not-a-number"]).success).toBe(false);
    expect(def.in.safeParse([1, 2]).success).toBe(false); // raw JS numbers, not boxed AExact/AInexact
  });

  it("bytevector-append: every arg must be a bytevector (z.sbytevector) — a non-bytevector used to slip through the old z.array(z.unknown())", () => {
    const def = nativeDef("bytevector-append");
    expect(def.in.safeParse([bv([1, 2]), bv([3])]).success).toBe(true);
    expect(def.in.safeParse([]).success).toBe(true); // 0-arg call stays legal (an empty bytevector)
    expect(def.in.safeParse(["not-a-bytevector"]).success).toBe(false);
    // The schema declares the SEMANTIC domain (z.sbytevector = instanceof ABytevector) even though
    // the runtime `asBytevector` helper tolerates raw binary too (FFI polymorphism, documented at
    // the top of bytevectors.ts) — "zod for TYPES purely" means this mismatch is harmless (native
    // ops run no validation), and matches the sibling ops in this same file (bytevector-copy,
    // utf8->string) which already declare z.sbytevector, not a raw-binary union.
    expect(def.in.safeParse([Uint8Array.from([1, 2, 3])]).success).toBe(false);
  });

  // bytevector?'s classifier is z.schemeValue (boxed scheme value), not host-blind.
  // The impl still classifies a raw Uint8Array at runtime (native ops never validate);
  // the harvest schema narrows to boxed scheme values.
  it("bytevector?'s classifier is z.schemeValue — a raw non-scheme value is genuinely rejected by the schema (though the impl's own instanceof checks still classify raw binary fine at runtime)", () => {
    const def = nativeDef("bytevector?");
    expect(def.in.safeParse([bv([1])]).success).toBe(true);
    expect(def.in.safeParse(["anything"]).success).toBe(false);
    expect(def.in.safeParse([Uint8Array.from([1])]).success).toBe(false);
  });

  it("EVERY bytevectors native op's Contract is precise — no straggler with BOTH sides still fully unconstrained", () => {
    // Mirrors numeric-contract-precision.test.ts's blanket sweep: the OLD bug was a degraded
    // `z.array(z.unknown())` input with an otherwise-precise output — checking BOTH sides matters
    // so a genuinely-blind predicate (bytevector?, precise `[z.boolean]` output) is never
    // false-flagged. A straggler is one where `.in` AND `.out` are STILL simultaneously
    // unconstrained (any arity, any raw JS garbage).
    const stragglers: string[] = [];
    for (const [name, def] of Object.entries(symbols)) {
      if (def.kind !== "native") continue;
      const inputStillDegraded =
        def.in.safeParse([]).success && def.in.safeParse(["anything", 123, null, {}, [1, 2, 3]]).success;
      const outputStillDegraded =
        def.out.safeParse(["anything"]).success && def.out.safeParse([{ garbage: true }]).success;
      if (inputStillDegraded && outputStillDegraded) stragglers.push(name);
    }
    expect(stragglers).toEqual([]);
  });

  it("utf8->string / string->utf8: unaffected siblings stay precise (regression guard, not part of this fix)", () => {
    const toStr = nativeDef("utf8->string");
    expect(toStr.in.safeParse([bv([104, 105])]).success).toBe(true);
    expect(toStr.in.safeParse(["not-a-bytevector"]).success).toBe(false);

    const toUtf8 = nativeDef("string->utf8");
    expect(toUtf8.in.safeParse([new AString("hi")]).success).toBe(true);
    expect(toUtf8.in.safeParse(["raw-js-string"]).success).toBe(false);
  });

  it("sanity: the pack exports exactly 12 symbols (the scope this fix must cover)", () => {
    expect(Object.keys(symbols)).toHaveLength(12);
  });
});
