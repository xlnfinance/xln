// numeric-contract-precision.test.ts — RUNTIME proof that the `bind` fix in numeric.ts
// actually replaces the degraded `{ input: z.array(z.unknown()), output: [z.unknown()] }`
// Contract with a precise one, for the REAL exported ops (not a synthetic mirror — see the
// sibling `numeric.test-d.ts` for the type-level mechanism proofs, which must stay synthetic
// because `NativeSymbolDef.in`/`.out` erase to plain `z.ZodTypeAny` on any real export).
//
// A schema's PRECISION is only observable at runtime, so this file checks: does `def.in` /
// `def.out` now REJECT a wrongly-shaped value it used to silently ACCEPT under the blanket
// `z.unknown()`? That rejection is the fix's entire externally visible effect (native ops
// never run this validation during evaluation — see numeric.ts's own `bind` doc comment —
// so this is a HARVEST/type-surface proof, not a behavior change; the behavioral
// byte-identical proof is the pre-existing `r7rs-numbers.test.ts` suite run unmodified
// before/after, plus the hand spot-checks in the report).
//
// IMPORTANT direction note (discovered while writing this file — a genuine `z.codec`
// subtlety, not a numeric.ts bug): a codec schema's bare `.safeParse(x)` validates `x`
// against the codec's SOURCE (scheme-value) side and runs `decode` — the SAME direction
// `.safeDecode` uses. There is no "parse the JS-land side" shorthand; testing the JS-land
// (decoded) side needs `.safeEncode(jsValue)` (JS → scheme, the direction `bakeRosetta`
// itself uses for a contract's OUTPUT side). So below: `.in` is probed with scheme values
// via `.safeDecode`, `.out` is probed with JS-land values via `.safeEncode`. Plain
// `.safeParse` is used only where the schema is a non-codec identity (`z.schemeNumber`,
// `z.schemeInexact`, `z.schemeExact`) — there A and B are the same type, so the direction
// is moot — or in the blanket sweep, which only ever feeds definitely-wrong-shaped raw JS
// garbage that fails the source-side instanceof check before any decode/encode body runs
// (never a shape-valid-but-semantically-invalid value, which is the one case where a
// couple of the PRE-EXISTING scheme-zod.ts codecs throw a raw Error past `safeParse`
// instead of reporting a graceful issue — orthogonal to this fix, so not exercised here).

import { describe, expect, it } from "vitest";
import numericPack from "../numeric.js";
import type { AEntity } from "../../../common/symbols/_bake.js";
import { AExact } from "../../../values/primitives/AExact.js";
import { AInexact } from "../../../values/primitives/AInexact.js";
import { APair } from "../../../values/primitives/APair.js";
import { CONSTANT_CTX } from "../../../run/RunContext.js";
import { harvestContracts } from "../../../__tests__/_symbols-harvest.js";

const symbols = harvestContracts(numericPack.spec.symbols);

function nativeDef(name: string) {
  const def = symbols[name];
  if (def === undefined) throw new Error(`numeric pack: no symbol named ${name}`);
  if (def.kind !== "native") throw new Error(`numeric pack: ${name} is not a native def (got ${def.kind})`);
  return def;
}

const exact = (n: number): AExact => new AExact(n);
const inexact = (n: number): AInexact => new AInexact(n);

describe("numeric Contract precision — the real exported ops reject wrongly-typed args (were z.unknown(), now precise)", () => {
  it("+ (pure-variadic SchemeNum): accepts scheme numbers, rejects a non-number rest element", () => {
    const def = nativeDef("+");
    expect(def.in.safeParse([exact(1), exact(2)]).success).toBe(true);
    expect(def.in.safeParse(["not a number"]).success).toBe(false);
    expect(def.out.safeParse([exact(3)]).success).toBe(true);
    expect(def.out.safeParse(["not a number"]).success).toBe(false);
  });

  it("- (fixed head + SchemeNum rest): rejects a wrongly-typed head or tail element", () => {
    const def = nativeDef("-");
    expect(def.in.safeParse([exact(1), exact(2), exact(3)]).success).toBe(true);
    expect(def.in.safeParse(["nope", exact(2)]).success).toBe(false);
    expect(def.in.safeParse([exact(1), "nope"]).success).toBe(false);
  });

  // quotient's out-channel encodes a plain safe-int JS `number` (`z.schemeNumber`),
  // same as `+`/`-`/`abs` — not a bigint codec.
  it("quotient (fixed Int,Int): rejects a non-scheme-number arg; output is z.schemeNumber (plain number), not bigint", () => {
    const def = nativeDef("quotient");
    expect(def.in.safeDecode([exact(7), exact(2)]).success).toBe(true);
    expect(def.in.safeDecode(["x", exact(2)]).success).toBe(false); // wrong scheme-value type entirely
    expect(def.out.safeEncode([7]).success).toBe(true);
    expect(def.out.safeEncode(["x"]).success).toBe(false); // not a number
  });

  it("abs (AnyNum in/out): accepts exact or inexact, rejects a non-number", () => {
    const def = nativeDef("abs");
    expect(def.in.safeDecode([exact(5)]).success).toBe(true);
    expect(def.in.safeDecode([inexact(5.5)]).success).toBe(true);
    expect(def.in.safeDecode(["x"]).success).toBe(false);
    expect(def.out.safeEncode([5]).success).toBe(true);
    // A raw JS bigint is not a scheme number (opaque host pass-through).
    // `z.schemeNumber` encode is exact | inexact, both `number`-typed.
    expect(def.out.safeEncode([5n]).success).toBe(false);
    expect(def.out.safeEncode(["x"]).success).toBe(false);
  });

  it("zero? (AnyNum in, Bool out): output schema now models a boolean, not unknown", () => {
    const def = nativeDef("zero?");
    expect(def.in.safeDecode([exact(0)]).success).toBe(true);
    expect(def.in.safeDecode(["x"]).success).toBe(false);
    expect(def.out.safeEncode([true]).success).toBe(true);
    expect(def.out.safeEncode(["not a bool"]).success).toBe(false);
  });

  it("floor/ (pair product): output is a pair of scheme numbers", () => {
    const def = nativeDef("floor/");
    const product = new APair(exact(1), exact(2));
    expect(def.out.safeParse([product]).success).toBe(true);
    expect(def.out.safeParse([exact(1)]).success).toBe(false);
    expect(def.out.safeParse(["x"]).success).toBe(false);
  });

  it("truncate/ (pair product): same pair shape as floor/", () => {
    const def = nativeDef("truncate/");
    const product = new APair(exact(3), exact(1));
    expect(def.out.safeParse([product]).success).toBe(true);
    expect(def.out.safeParse([exact(1)]).success).toBe(false);
  });

  it("inexact / exact (narrower than the generic scheme-number union): output pins the specific tower member", () => {
    const inexactDef = nativeDef("inexact");
    expect(inexactDef.out.safeParse([inexact(1.5)]).success).toBe(true);
    expect(inexactDef.out.safeParse([exact(1)]).success).toBe(false); // AExact is not AInexact

    const exactDef = nativeDef("exact");
    expect(exactDef.out.safeParse([exact(1)]).success).toBe(true);
    expect(exactDef.out.safeParse([inexact(1.5)]).success).toBe(false); // AInexact is not AExact
  });

  it("EVERY numeric native op's Contract has migrated off the degraded z.array(z.unknown())/[z.unknown()] shape", () => {
    // The blanket acceptance-criterion sweep. The OLD bug was BOTH sides degraded together
    // (`{ input: z.array(z.unknown()), output: [z.unknown()] }`) — so a genuine straggler is
    // one where `.in` AND `.out` are STILL simultaneously unconstrained (any arity, any raw
    // JS garbage). Checking both (not just `.in`) matters: `lcm`'s input is LEGITIMATELY
    // `z.array(z.unknown())` post-fix too (lcmFn's own signature is genuinely
    // `(...args: unknown[]) => ANumeric` — representation-blind per-element, matching
    // lists.ts's own convention), which alone would false-positive as "still degraded" — but
    // its OUTPUT did migrate (`[z.schemeNumber]`, no longer `[z.unknown()]`), so it correctly
    // is NOT a straggler. Only plain `.safeParse` with raw garbage is used here (never a
    // shape-valid AValue instance), so no codec's decode/encode body is ever invoked —
    // no risk of the pre-existing hard-throw-on-domain-violation behavior noted above.
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

  // JS-shaped aliases (** % == | & ~ >> <<) moved to scheme/sugarcoat — not on this pack.

  it("sanity: the pack exports exactly 76 symbols (the scope this fix must cover)", () => {
    expect(Object.keys(symbols)).toHaveLength(76);
  });
});
