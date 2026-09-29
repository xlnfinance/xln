/**
 * LAW — the CONTOUR/CROSSING slot-kind wall has a RUNTIME twin (hermeticity
 * audit B2, ruling 2026-08-13).
 *
 * The type-level brand bans (`_bake.ts` §1.7: ContourOnly / CrossingOnly) are
 * invisible to an untyped or `as never` caller. The runtime gate
 * `assertSlotKinds` re-checks the same wall at bake, copying the
 * `assertNoResourcePathProducers` (I9) pattern: every factory calls it, the
 * door names the cure.
 *
 *   - rosetta (crossing): `z.schemeValue` slots refuse — a crossing slot needs
 *     a real codec, `z.procedure`, or `z.dynamic`.
 *   - native / sequence / define (contour): `z.dynamic` / `z.instance` slots
 *     refuse — a contour never crosses the membrane; `z.schemeValue` is the
 *     honest top type there.
 *
 * Shallow scope — same top-level view as the sibling gates (`cacheGateSlots`);
 * the container gap is the documented shared contour (membrane.md §REGION).
 */
import { describe, it, expect } from "vitest";
import * as z from "../scheme-zod/index.js";
import { symbol } from "../../symbol/index.js";
import { ContractSlotKindError } from "../../errors.js";

class SomeHostThing {
  x = 1;
}

describe("slot-kind runtime gate (audit B2a)", () => {
  it("N-SLOT-KIND-ROSETTA — z.schemeValue slot refuses at bake (untyped caller)", () => {
    expect(() =>
      symbol.rosetta`sk-r-in: `({ input: [z.schemeValue], output: [z.string] } as never, (() => "x") as never),
    ).toThrow(ContractSlotKindError);

    expect(() =>
      symbol.rosetta`sk-r-out: `({ input: [z.string], output: [z.schemeValue] } as never, ((s: string) => s) as never),
    ).toThrow(ContractSlotKindError);

    // kwargs rest slots are inside the gate's view (object shape via cacheGateSlots)
    expect(() =>
      symbol.rosetta`sk-r-kw: `(
        { input: [], inputRest: { v: z.schemeValue }, output: [z.string] } as never,
        (() => "x") as never,
      ),
    ).toThrow(ContractSlotKindError);
  });

  it("N-SLOT-KIND-NATIVE — z.dynamic / z.instance slot refuses at bake (untyped caller)", () => {
    expect(() =>
      symbol.native`sk-n-dyn: `({ input: [z.dynamic], output: [z.schemeValue] } as never, ((v: unknown) => v) as never),
    ).toThrow(ContractSlotKindError);

    expect(() =>
      symbol.native`sk-n-inst: `(
        { input: [z.instance(SomeHostThing)], output: [z.schemeValue] } as never,
        ((v: unknown) => v) as never,
      ),
    ).toThrow(ContractSlotKindError);

    expect(() =>
      symbol.native`sk-n-out: `({ input: [z.schemeValue], output: [z.dynamic] } as never, ((v: unknown) => v) as never),
    ).toThrow(ContractSlotKindError);
  });

  it("N-SLOT-KIND-SEQUENCE — z.dynamic slot refuses at bake (untyped caller)", () => {
    expect(() =>
      symbol.sequence`sk-s-dyn: `(
        { input: [z.dynamic], output: [z.schemeValue] } as never,
        ((v: unknown) => v) as never,
      ),
    ).toThrow(ContractSlotKindError);
  });

  it("N-SLOT-KIND-DEFINE — z.dynamic / z.instance slot refuses at declaration (untyped caller)", () => {
    expect(() =>
      symbol.define`sk-d-dyn: `({ input: [z.dynamic], output: [z.schemeValue] } as never, "(lambda (x) x)"),
    ).toThrow(ContractSlotKindError);

    expect(() =>
      symbol.define`sk-d-inst: `(
        { input: [z.schemeValue], output: [z.instance(SomeHostThing)] } as never,
        "(lambda (x) x)",
      ),
    ).toThrow(ContractSlotKindError);
  });

  it("P-SLOT-KIND — each side's own honest slots still bake", () => {
    // rosetta: z.dynamic is the crossing's legitimate escape hatch
    expect(() => symbol.rosetta`sk-r-ok: `({ input: [z.dynamic], output: [z.dynamic] }, (v) => v)).not.toThrow();

    // native: z.schemeValue is the contour's honest top type
    expect(() => symbol.native`sk-n-ok: `({ input: [z.schemeValue], output: [z.schemeValue] }, (v) => v)).not.toThrow();
  });
});
