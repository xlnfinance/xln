// core-contract-precision.test.ts — HARVEST-surface proof that the author-asserted
// `Contract.type` overrides on scheme/core's native ops (env/core/core.ts) make
// `signatureOf` print a MEANINGFUL ambient signature instead of the catch-all
// `(...args: unknown[]) => unknown` their blind `z.custom<…>()` slots otherwise
// degrade to.
//
// WHY THEY DEGRADE WITHOUT THE OVERRIDE: `gensym`/`typecheck` type their genuinely-
// blind slots with a bare `z.custom<…>()` (a raw name-hint / a valueOf-haver / a
// predicate-or-Function) — an UNREGISTERED custom, which `printType` (schema-to-ts.ts,
// `unrepresentable: "throw"`) throws on, dragging the WHOLE signature into
// `signatureOf`'s total-harvest catch-all. `Contract.type` is the author's assertion of
// the real shape the blind schema can't itself express (mirrors author `type` override)
// — it recovers the arity + the honest return the catch-all destroyed. INERT at runtime
// (native ops never validate — see _bake.ts's bakeNative doc); this is a pure type-lens
// surface proof, same posture as the sibling polyglot-contract-precision.test.ts.
import { describe, expect, it } from "vitest";
import core from "../../core/core.js";
import { signatureOf } from "../../../type-layer/schema-to-ts.js";
import type { AEntity } from "../../../common/symbols/_bake.js";
import { harvestContracts } from "../../../__tests__/_symbols-harvest.js";

// `scheme/core`'s `symbols` is a plain object (no config/resources builder), but realize
// through the same builder-tolerant shape the polyglot precision test uses, so this stays
// correct if core ever grows a builder.
// `spec.symbols` IS the record. Each entry is a minted A-value — `harvestContracts`
// pulls the AEntity contract off each one.
const symbols = harvestContracts(core.spec.symbols ?? {});

function def(name: string): AEntity {
  const d = symbols[name];
  if (d === undefined) throw new Error(`scheme/core: no symbol named ${name}`);
  return d;
}

describe("scheme/core Contract precision — author-asserted `type` recovers the meaningful signature the blind z.custom<…> slots degrade to the catch-all", () => {
  it("gensym: an optional string name hint → a fresh symbol (string image), not (...args: unknown[]) => unknown", () => {
    expect(signatureOf(def("gensym"))).toBe("(name?: string) => string");
  });
});
