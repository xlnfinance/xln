/**
 * tiering.test.ts — Q14's own unit coverage for `PayloadTierMachine` (the `ring` tier
 * + read-side envelope) and `tierGateFromSnapshot` (the egress-proxy integration).
 * Built entirely against `PayloadStoreFake` synthetic payloads, per
 * Q14's scoping (docs/PROVENANCE.md §5 payload tiering) — no real emission, no
 * workerd adapter. `store-fakes.smoke.test.ts` already proves the do/pending/r2/stub
 * leg of the state machine directly against `PayloadStoreFake`; this file proves the
 * `ring` leg this module adds ON TOP of that, plus the envelope/gate this module owns.
 */
import { describe, expect, it } from "vitest";

import { PayloadStoreFake } from "../fakes.js";
import { evidenceTierOf, PayloadNotRingResident, PayloadTierMachine, tierGateFromSnapshot } from "../tiering.js";

describe("PayloadTierMachine — the ring leg (§5 A1 tier 1)", () => {
  it("a ring-resident payload reports tier 'ring' and its value, before any flush", async () => {
    const machine = new PayloadTierMachine(new PayloadStoreFake());
    machine.ringPut("h1", { value: "hot value", stampIds: [1, 2] });

    expect(await machine.currentTier("h1")).toBe("ring");
    const envelope = await machine.read("h1");
    expect(envelope).toEqual({
      tier: "recorded",
      storageTier: "ring",
      value: "hot value",
      stampIds: [1, 2],
      retention: "standard",
    });
  });

  it("ringPut without an explicit retention defaults to 'standard'; an explicit tag flows through", async () => {
    const machine = new PayloadTierMachine(new PayloadStoreFake());
    machine.ringPut("h1", { value: "v", stampIds: [] });
    machine.ringPut("h2", { value: "v", stampIds: [], retention: "sensitive" });

    expect((await machine.read("h1")).retention).toBe("standard");
    expect((await machine.read("h2")).retention).toBe("sensitive");
  });

  it("flush(small) moves ring -> do; the store, not the ring, now serves reads", async () => {
    const store = new PayloadStoreFake();
    const machine = new PayloadTierMachine(store);
    machine.ringPut("h1", { value: "small", stampIds: [7] });

    await machine.flush("h1");

    expect(await machine.currentTier("h1")).toBe("do");
    expect((await store.get("h1")).tier).toBe("do"); // the store itself now holds it
    await expect(machine.flush("h1")).rejects.toBeInstanceOf(PayloadNotRingResident); // no longer ring-resident
  });

  it("flush(oversize) moves ring -> pending, per PayloadStore's own size-cap routing", async () => {
    const store = new PayloadStoreFake();
    store.setValueSizeCapBytes(4);
    const machine = new PayloadTierMachine(store);
    machine.ringPut("h1", { value: "a very long payload indeed", stampIds: [] });

    await machine.flush("h1");

    expect(await machine.currentTier("h1")).toBe("pending");
    const envelope = await machine.read("h1");
    expect(envelope.tier).toBe("recorded"); // pending still HAS a value — recorded, not stub
    expect(envelope.value).toBe("a very long payload indeed");
  });

  it("evict on a ring-resident (pre-flush) payload degrades locally to stub — never touches the store", async () => {
    const store = new PayloadStoreFake();
    const machine = new PayloadTierMachine(store);
    machine.ringPut("h1", { value: "secret", stampIds: [9, 9] });

    await machine.evict("h1");

    expect(await machine.currentTier("h1")).toBe("stub");
    const envelope = await machine.read("h1");
    expect(envelope).toEqual({
      tier: "stub",
      storageTier: "stub",
      value: undefined,
      stampIds: [9, 9], // §5 A1 tier 4: identity + stamps retained
      retention: "standard",
    });
    await expect(store.get("h1")).rejects.toThrow(); // the store never saw this hash
    await expect(machine.flush("h1")).rejects.toBeInstanceOf(PayloadNotRingResident); // stubbed, not flushable
  });

  it("flush -> settle('settled') -> evict walks the full ring->do/pending->r2->stub chain", async () => {
    const store = new PayloadStoreFake();
    store.setValueSizeCapBytes(1); // force oversize on flush
    const machine = new PayloadTierMachine(store);
    machine.ringPut("h1", { value: "oversize evidence", stampIds: [3] });

    await machine.flush("h1");
    expect(await machine.currentTier("h1")).toBe("pending");

    await machine.settle("h1", "settled");
    expect(await machine.currentTier("h1")).toBe("r2");
    expect((await machine.read("h1")).tier).toBe("recorded");

    await machine.evict("h1");
    expect(await machine.currentTier("h1")).toBe("stub");
    expect((await machine.read("h1")).value).toBeUndefined();
  });

  it("evict on a hash this machine never saw (not ring-resident, never flushed) propagates the store's unknown-hash door", async () => {
    const machine = new PayloadTierMachine(new PayloadStoreFake());
    await expect(machine.evict("never-seen")).rejects.toThrow();
  });

  it("settle('failed') degrades pending -> stub under tier honesty (m6)", async () => {
    const store = new PayloadStoreFake();
    store.setValueSizeCapBytes(1);
    const machine = new PayloadTierMachine(store);
    machine.ringPut("h1", { value: "oversize", stampIds: [5] });
    await machine.flush("h1");

    await machine.settle("h1", "failed");

    expect(await machine.currentTier("h1")).toBe("stub");
    expect((await machine.read("h1")).tier).toBe("stub");
  });
});

describe("evidenceTierOf — the recorded/stub arms this node owns (§5 A1 / §7)", () => {
  it("every storage tier with a present value answers 'recorded'", () => {
    expect(evidenceTierOf("ring")).toBe("recorded");
    expect(evidenceTierOf("do")).toBe("recorded");
    expect(evidenceTierOf("pending")).toBe("recorded");
    expect(evidenceTierOf("r2")).toBe("recorded");
  });

  it("'stub' answers 'stub' — never silently claims 'recorded'", () => {
    expect(evidenceTierOf("stub")).toBe("stub");
  });
});

describe("PayloadTierMachine.snapshot — the async pre-pass a sync TierGate needs", () => {
  it("resolves multiple hashes' envelopes; an unknown hash is simply absent, never thrown through the batch", async () => {
    const store = new PayloadStoreFake();
    const machine = new PayloadTierMachine(store);
    machine.ringPut("h-ring", { value: "hot", stampIds: [] });
    machine.ringPut("h-stub", { value: "will be evicted", stampIds: [1] });
    await machine.evict("h-stub");

    const snapshot = await machine.snapshot(["h-ring", "h-stub", "h-unknown"]);

    expect(snapshot.get("h-ring")?.tier).toBe("recorded");
    expect(snapshot.get("h-stub")?.tier).toBe("stub");
    expect(snapshot.has("h-unknown")).toBe(false);
  });
});

describe("tierGateFromSnapshot — egress-proxy integration (Q14's NOTE)", () => {
  it("allows every key when nothing is payload-tracked (keyToHash always undefined) — the byte-stable default", () => {
    const gate = tierGateFromSnapshot(() => undefined, new Map());
    expect(gate.allows("0")).toBe(true);
    expect(gate.allows("anything")).toBe(true);
  });

  it("allows a key whose payload's tier is anything but stub (ring included)", async () => {
    const machine = new PayloadTierMachine(new PayloadStoreFake());
    machine.ringPut("h1", { value: "v", stampIds: [] });
    const snapshot = await machine.snapshot(["h1"]);
    const gate = tierGateFromSnapshot((key) => (key === "0" ? "h1" : undefined), snapshot);

    expect(gate.allows("0")).toBe(true);
    expect(gate.allows("1")).toBe(true); // untracked key — always allowed
  });

  it("gates off a key whose payload has degraded to stub, and its stub value carries the surviving stampIds", async () => {
    const store = new PayloadStoreFake();
    const machine = new PayloadTierMachine(store);
    machine.ringPut("h1", { value: "secret", stampIds: [11, 22] });
    await machine.evict("h1");
    const snapshot = await machine.snapshot(["h1"]);
    const gate = tierGateFromSnapshot((key) => (key === "0" ? "h1" : undefined), snapshot);

    expect(gate.allows("0")).toBe(false);
    expect(gate.stubbedValue("0")).toEqual({ "provenance/tier": "stub", payloadHash: "h1", stampIds: [11, 22] });
  });
});
