/**
 * LAW — a contract is FROZEN the moment it gets inside the symbol instance
 * (V's ruling, 2026-08-13, hermeticity audit B3).
 *
 * The contract is the declaration of record: harvest, catalog, static readers,
 * and the dispatch spine all treat its fields as truth. Post-construction
 * stamping (`Object.assign` on `.contract`) was a hard violation — an untyped
 * caller could stamp `queries` / `cacheClass` / `provenance` onto a sealed
 * contract AFTER every bake gate ran, making introspection lie.
 *
 * Production = instantiation: `ANativeProcedure` / `ARosettaProcedure` ctors
 * freeze the contract object. The declaration-site channels
 * (`withContractFields` / `withCallbackRoles`) keep their chainable API but
 * RE-MINT: a new instance around the same impl, with a new frozen contract —
 * never a mutation. Their key/vocabulary whitelists are enforced at runtime,
 * not just in types.
 */
import { describe, it, expect } from "vitest";
import * as z from "../scheme-zod/index.js";
import { symbol } from "../../symbol/index.js";
import { withContractFields, withCallbackRoles } from "./../symbols/_bake.js";
import { ContractSealError } from "../../errors.js";

describe("contract seal (audit B3)", () => {
  it("P-CONTRACT-FROZEN — every factory's contract is frozen at instantiation", () => {
    const native = symbol.native`seal-n: `({ input: [z.schemeValue], output: [z.schemeValue] }, (v) => v);
    const rosetta = symbol.rosetta`seal-r: `({ input: [z.string], output: [z.string] }, (s) => s);
    const sequence = symbol.sequence`seal-s: `({ input: [z.schemeValue], output: [z.schemeValue] }, ([v]) => v);
    const tagless = symbol.tagless`seal-t: doc`;
    for (const value of [native, rosetta, sequence, tagless]) {
      expect(Object.isFrozen(value.contract)).toBe(true);
    }
  });

  it("N-CONTRACT-STAMP — direct field mutation on a baked contract throws", () => {
    const value = symbol.rosetta`seal-mut: `({ input: [z.string], output: [z.string] }, (s) => s);
    expect(() => {
      (value.contract as { cacheClass?: string }).cacheClass = "view";
    }).toThrow(TypeError);
  });

  it("N-SEAL-CHANNEL — withContractFields refuses keys outside the declaration whitelist", () => {
    const value = symbol.tagless`seal-ch: doc`;
    expect(() => withContractFields(value, { queries: () => [["d"]] } as never)).toThrow(ContractSealError);
    expect(() => withContractFields(value, { provenance: "sink" } as never)).toThrow(ContractSealError);
    expect(() => withContractFields(value, { cacheClass: "view" } as never)).toThrow(ContractSealError);
  });

  it("N-SEAL-CHANNEL-ROLES — withCallbackRoles refuses out-of-vocabulary roles", () => {
    const value = symbol.tagless`seal-rv: doc`;
    expect(() => withCallbackRoles(value, ["definitely-not-a-role"] as never)).toThrow(ContractSealError);
  });

  it("P-SEAL-CHANNEL — the declaration chain re-mints; the base instance never mutates", () => {
    const base = symbol.tagless`seal-p: doc`;
    const stamped = withCallbackRoles(withContractFields(base, { type: "(x: T) => T" }), ["accumulator"]);

    expect((base.contract as { type?: string }).type).toBeUndefined();
    expect(base.callbackRoles).toBeUndefined();

    expect((stamped.contract as { type?: string }).type).toBe("(x: T) => T");
    expect(stamped.callbackRoles).toEqual(["accumulator"]);
    expect((stamped.contract as { callbackRoles?: readonly string[] }).callbackRoles).toEqual(["accumulator"]);
    expect(Object.isFrozen(stamped.contract)).toBe(true);

    // the impl travels: the re-mint is the same dispatchable value
    expect(typeof stamped["arrival/tagless-final/apply"]).toBe("function");
    expect(stamped.name).toBe(base.name);
  });
});
