// binding-contract-precision.test.ts — structural pin: scheme/r7rs/binding is a
// doors-only pack for set! + the multi-return family (impl-or-door R7RS law).
// No harvest signature proofs: doors carry no Contract.type / in/out surface.
import { describe, expect, it } from "vitest";
import bindingPack from "../binding.js";
import type { AEntity } from "../../../common/symbols/_bake.js";
import { harvestContracts } from "../../../__tests__/_symbols-harvest.js";

const symbols = harvestContracts(bindingPack.spec.symbols);

const DOOR_NAMES = ["set!", "values", "call-with-values", "let-values", "let*-values", "define-values"] as const;

describe("scheme/r7rs/binding — multi-return + set! are purity doors (R7RS implement-or-door)", () => {
  it("exports exactly the purity-door surface (no silent R7RS gaps, no live multi-return)", () => {
    expect(Object.keys(symbols).sort()).toEqual([...DOOR_NAMES].sort());
  });

  it.each(DOOR_NAMES)("%s is kind door with a teaching reason", (name) => {
    const def = symbols[name];
    if (def === undefined) throw new Error(`binding pack: no symbol named ${name}`);
    expect(def.kind).toBe("door");
    if (def.kind !== "door") throw new Error("unreachable");
    expect(def.reason.length).toBeGreaterThan(20);
  });

  it("multi-return doors name the continuation-family purity excuse", () => {
    for (const name of ["values", "call-with-values", "let-values", "let*-values", "define-values"] as const) {
      const def = symbols[name];
      if (def?.kind !== "door") throw new Error(`expected door: ${name}`);
      expect(def.reason).toMatch(
        /multiple-value returns are omitted from arrival by design|continuation arity|call\/cc/,
      );
    }
  });
});
