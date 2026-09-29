// js-wrapper-freeze — the borrowed-source FREEZE contract (prevention, replacing the deleted
// dev-only purity ASSERT). A borrowed JS object/array, once Scheme READS it through
// AJSObject/AJSArray, has its `source` Object.freeze'd — so the host can no longer mutate a value
// it returned across the membrane. Freezing is unconditional on first read.
//
// Why this is sound — and why flipping it broke no interpreter test: arrival is PURE DATAFLOW. The
// mutation verbs (vector-set!/set-car!/…) are DOORED off (PurityError, see purity.ts), so the
// interpreter itself never writes to a borrowed source. Freezing it can only ever stop the HOST —
// exactly the lineage-soundness guarantee the old assert merely *detected* after the fact.

import { describe, it, expect } from "vitest";
// Import the package entry first so the membrane↔wrappers↔AmbientRuntime module cycle is fully
// initialized before we construct AJSArray/AJSObject directly below — the wrappers call jsToScheme
// from that cycle at runtime, and the entry sequences the bridge bootstrap (`void initBridge()`).
import "../../index.js";
import { AJSObject } from "../AJSObject.js";
import { AJSArray } from "../AJSArray.js";

describe("borrowed-source freeze (rosetta-return prevention)", () => {
  it("AJSObject freezes its source the first time Scheme reads a member", () => {
    const source = { x: 1 };
    const wrapped = new AJSObject(source);
    expect(Object.isFrozen(source)).toBe(false);
    wrapped.has("x"); // any read entry point arms the freeze
    expect(Object.isFrozen(source)).toBe(true);
  });

  it("AJSArray freezes its source the first time Scheme reads it", () => {
    const source = [1, 2, 3];
    const wrapped = new AJSArray(source);
    expect(Object.isFrozen(source)).toBe(false);
    void wrapped.length; // even the cheap lazy read arms the freeze
    expect(Object.isFrozen(source)).toBe(true);
  });
});
