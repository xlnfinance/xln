// Every container-producing vector/bytevector builtin DROPS input provenance —
// omitting the withInputProvenance call its string/list sibling makes.
// utf8->string / vector->string even returned RAW JS strings (provenance-blind
// escapees).
import { describe, expect, it } from "vitest";
import bytevectorsCap from "../../env/r7rs/bytevectors.js";
import vectorsCap from "../../env/r7rs/vectors.js";
import type { EnvCapability } from "../../common/capability.js";
import { ABytevector } from "../../values/primitives/ABytevector.js";
import { AString } from "../../values/primitives/AString.js";
import { AVector } from "../../values/primitives/AVector.js";
import { requireEagerOracle } from "../../__tests__/_require-eager-oracle.js";
import { harvestContracts } from "../../__tests__/_symbols-harvest.js";
import { ANativeProcedure } from "../../values/primitives/ANativeProcedure.js";
import { testCallCtx } from "../../run/CallCtx.js";

// this helper/execState needs the eager oracle ON
requireEagerOracle();

// Source op fns FROM THE CAPABILITY's inlined `symbols` (the bare *_OPS map was
// inlined into the constructor; the capability default export is the single
// declaration site). DUAL-ACCEPT the symbol shape (mirrors EnvCapability.lower()'s
// dispatch): a BAKED `symbol.native` def exposes the host fn as `.impl`; the historical
// `{ value: fn }` form exposes it as `.value`. Reading either keeps this raw-symbol
// harness valid across the per-pack native migration regardless of order.
const opFn = (v: { kind?: string; impl?: (...a: any[]) => any; value?: (...a: any[]) => any }) =>
  v && v.kind === "native" ? v.impl! : v.value!;
const opsOf = (cap: EnvCapability): Record<string, (...a: any[]) => any> =>
  // Stage A2: the CONTRACT (native's raw `.impl`) rides `.contract` on the minted
  // ANativeProcedure now — `harvestContracts` (the shared read-side seam) pulls it off.
  Object.fromEntries(Object.entries(harvestContracts(cap.spec.symbols)).map(([k, v]) => [k, opFn(v as never)]));
// The vector/bytevector primitives now live in their value-domain cluster packs
// (carved out of the old `wrappedOps` monolith); these are the exact fns assembled
// onto global_env.
const ops = { ...opsOf(vectorsCap), ...opsOf(bytevectorsCap) };
const PROV = new Set<number>([42]);
const provVec = (xs: any[]) => new AVector(xs, PROV);
const provBv = (xs: number[]) => new ABytevector(Uint8Array.from(xs), PROV);
const prov = (r: unknown) => [...((r as { provenance: ReadonlySet<number> }).provenance ?? [])];

describe("vector/bytevector builtins propagate input provenance (goal b)", () => {
  it("vector-copy carries the source's provenance", () => {
    expect(prov(ops["vector-copy"](provVec([1, 2, 3])))).toEqual([42]);
  });
  it("vector-map carries provenance", () => {
    // W8: proc is ACallable; raw ops are CallCtx-dispatch natives.
    const id = new ANativeProcedure({
      name: "id",
      arity: { min: 1, max: 1 },
      contract: undefined,
      impl: (args) => args[0] as never,
    });
    expect(prov(ops["vector-map"].call(testCallCtx(), id, provVec([1, 2])))).toEqual([42]);
  });
  it("vector-append carries provenance", () => {
    expect(prov(ops["vector-append"](provVec([1]), provVec([2])))).toEqual([42]);
  });
  it("list->vector via vector(...) elements carries union provenance", () => {
    // `vector` unions its element provenance onto the container.
    const el = new AString("x", PROV);
    expect(prov(ops["vector"](el))).toEqual([42]);
  });
  it("bytevector-copy carries provenance", () => {
    expect(prov(ops["bytevector-copy"](provBv([1, 2, 3])))).toEqual([42]);
  });
  it("bytevector-append carries provenance", () => {
    expect(prov(ops["bytevector-append"](provBv([1]), provBv([2])))).toEqual([42]);
  });

  it("utf8->string returns a SchemeString (not a raw JS string) and carries provenance", () => {
    const r = ops["utf8->string"](provBv([104, 105]));
    expect(r).toBeInstanceOf(AString);
    expect(r.valueOf()).toBe("hi");
    expect(prov(r)).toEqual([42]);
  });
  it("vector->string returns a SchemeString and carries provenance", () => {
    const r = ops["vector->string"](provVec([new AString("a")]));
    expect(r).toBeInstanceOf(AString);
  });
});
