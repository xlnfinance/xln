/**
 * tiering-egress-gate.test.ts — Q14's egress-proxy integration proof
 * (docs/PROVENANCE.md §5 payload tiering): `egressContainerProxy`'s optional `gate`
 * param, wired against `tierGateFromSnapshot`. Lives under `store/__tests__` (not
 * `src/values/__tests__`, which doesn't exist and isn't whitelisted by
 * `vitest.config.ts`) — this file is the ONE place both modules' tests meet, since
 * it's exercising the seam BETWEEN them, not either module's internals in isolation.
 *
 * The two claims the task requires:
 *  1. additive: omitting `gate` (every pre-Q14 call site) is byte-stable — unchanged
 *     from the pre-Q14 shape.
 *  2. the gate: a `stub`-tier key never reaches `reader.read`/`arrival/toJS` — it
 *     materializes to the degraded stand-in instead, and a non-stub key (including
 *     ring-resident) is completely unaffected.
 */
import { describe, expect, it } from "vitest";

import { egressContainerProxy, type EgressReader } from "../../../membrane/egress-proxy.js";
import { AVector } from "../../../values/primitives/AVector.js";
import { CONSTANT_CTX } from "../../../run/RunContext.js";
import { PayloadStoreFake } from "../fakes.js";
import { PayloadTierMachine, tierGateFromSnapshot } from "../tiering.js";

/** A run-neutral, elements-irrelevant `AVector` — `egressContainerProxy` only ever
 *  uses `box` as an identity key (the WeakMap cache), never reading `__vector__`
 *  itself; the caller-supplied `reader` is the sole source of element data in every
 *  test below. `CONSTANT_CTX` is the documented "no real run" ctx (AValue.ts). */
function testBox(): AVector {
  return new AVector([]);
}

/** A minimal `EgressReader` over a plain array of raw (non-`AValue`) elements,
 *  instrumented to record which keys were actually read — the byte-stability and
 *  gate-blocks-materialization claims both hinge on "was `read` called or not." */
function trackedReader(values: readonly unknown[]): EgressReader & { readKeys: string[] } {
  const readKeys: string[] = [];
  return {
    readKeys,
    keys: () => values.map((_, i) => String(i)),
    read(key: string): unknown {
      readKeys.push(key);
      return values[Number(key)];
    },
  };
}

describe("egressContainerProxy — Q14 gate, additive over the existing lazy-materialization seam", () => {
  it("byte-stable: omitting `gate` entirely behaves exactly as before — every key reads through", () => {
    const box = testBox();
    const reader = trackedReader(["a", "b", "c"]);

    const proxy = egressContainerProxy(box, "array", reader) as readonly unknown[];

    expect(proxy[0]).toBe("a");
    expect(proxy[1]).toBe("b");
    expect(reader.readKeys).toEqual(["0", "1"]); // lazy — index 2 never touched
  });

  it("a gate that allows everything is observationally identical to no gate at all", () => {
    const box = testBox();
    const reader = trackedReader(["x", "y"]);
    const passthroughGate = { allows: () => true, stubbedValue: () => "UNREACHABLE" };

    const proxy = egressContainerProxy(box, "array", reader, { gate: passthroughGate }) as readonly unknown[];

    expect(proxy[0]).toBe("x");
    expect(proxy[1]).toBe("y");
    expect(reader.readKeys).toEqual(["0", "1"]);
  });

  it("a stub-tier key never reaches reader.read — the gate substitutes the degraded stand-in", async () => {
    const store = new PayloadStoreFake();
    const machine = new PayloadTierMachine(store);
    machine.ringPut("hash-0", { value: "will be evicted", stampIds: [4, 2] });
    await machine.evict("hash-0"); // -> stub, pre-flush

    const snapshot = await machine.snapshot(["hash-0"]);
    const gate = tierGateFromSnapshot((key) => (key === "0" ? "hash-0" : undefined), snapshot);

    const box = testBox();
    const reader = trackedReader(["never-should-materialize", "untouched-by-tiering"]);

    const proxy = egressContainerProxy(box, "array", reader, { gate }) as readonly unknown[];

    expect(proxy[0]).toEqual({ "provenance/tier": "stub", payloadHash: "hash-0", stampIds: [4, 2] });
    expect(reader.readKeys).toEqual([]); // key 0 was gated OFF before reader.read ever ran

    // A key with no known payload hash (key "1") is untouched by the gate — normal
    // lazy materialization, same as if no gate were present at all.
    expect(proxy[1]).toBe("untouched-by-tiering");
    expect(reader.readKeys).toEqual(["1"]);
  });

  it("a ring-resident (non-stub) tracked key reads through normally — degradation is per-tier, not blanket", async () => {
    const machine = new PayloadTierMachine(new PayloadStoreFake());
    machine.ringPut("hash-0", { value: "irrelevant to the gate", stampIds: [] });

    const snapshot = await machine.snapshot(["hash-0"]);
    const gate = tierGateFromSnapshot((key) => (key === "0" ? "hash-0" : undefined), snapshot);

    const box = testBox();
    const reader = trackedReader(["real value made it through"]);

    const proxy = egressContainerProxy(box, "array", reader, { gate }) as readonly unknown[];

    expect(proxy[0]).toBe("real value made it through");
    expect(reader.readKeys).toEqual(["0"]);
  });

  it("gated egress caches per (gate, box): a gate is snapshot-scoped, its proxies are too", () => {
    const box = testBox();
    const reader = trackedReader(["v"]);
    const gateA = { allows: () => true, stubbedValue: () => "A" };
    const gateB = { allows: () => false, stubbedValue: () => "B-stub" };

    const underA1 = egressContainerProxy(box, "array", reader, { gate: gateA });
    const underA2 = egressContainerProxy(box, "array", reader, { gate: gateA });
    expect(underA2).toBe(underA1); // same gate → cache hit

    // A FRESH gate (a new snapshot's closure) mints a FRESH proxy honestly reflecting
    // its own tier view — never the earlier gate's cached materialization.
    const underB = egressContainerProxy(box, "array", reader, { gate: gateB }) as readonly unknown[];
    expect(underB).not.toBe(underA1);
    expect(underB[0]).toBe("B-stub");

    // Ungated bare egress of the same box is a third, independent identity.
    const bare = egressContainerProxy(box, "array", reader);
    expect(bare).not.toBe(underA1);
    expect(bare).not.toBe(underB);
    expect(egressContainerProxy(box, "array", reader)).toBe(bare); // bare = (box), forever
  });
});
