/**
 * store-fakes.smoke.test.ts — Q10's own smoke test: proves the fault-injection knobs
 * on `ProvenanceStoreFake`/`PayloadStoreFake` actually work. NOT a law suite (the §7
 * law families are Q5's stub files, flipped green by later Q-nodes) — just: does
 * append→read round-trip, does idempotent double-append dedupe, does forced eviction
 * degrade to stub, does an armed write-failure knob throw.
 */
import { describe, expect, it } from "vitest";

import type { MintRecord } from "../records.js";
import type { RecordId } from "../ids.js";
import { PayloadStoreFake, ProvenanceStoreFake, ProvenanceWriteFailure } from "../fakes.js";
import { recordIdKey } from "../ids.js";

function mintRecord(id: RecordId, seq: number, payloadHash: string): MintRecord {
  return { kind: "mint", id, seq, payloadHash };
}

describe("ProvenanceStoreFake — append/read round-trip + idempotent upsert", () => {
  it("append then readStream returns the record, in seq order", async () => {
    const store = new ProvenanceStoreFake();
    const regionId = "region-1";
    const idA: RecordId = { templateHash: "t-a", ordinalPath: [0], regionEpoch: "e0" };
    const idB: RecordId = { templateHash: "t-b", ordinalPath: [1], regionEpoch: "e0" };

    const seqB = await store.allocateSeq(regionId);
    await store.append(regionId, mintRecord(idB, seqB, "hash-b"));
    const seqA = await store.allocateSeq(regionId);
    await store.append(regionId, mintRecord(idA, seqA, "hash-a"));

    const stream = await store.readStream(regionId);
    expect(stream.map((r) => r.id.templateHash)).toEqual(["t-b", "t-a"]); // seq order, not id order
    expect(stream).toHaveLength(2);
  });

  it("double-append with the same RecordId is idempotent — one record, not two", async () => {
    const store = new ProvenanceStoreFake();
    const regionId = "region-1";
    const id: RecordId = { templateHash: "t-a", ordinalPath: [0], regionEpoch: "e0" };
    const seq = await store.allocateSeq(regionId);

    await store.append(regionId, mintRecord(id, seq, "hash-a"));
    await store.append(regionId, mintRecord(id, seq, "hash-a")); // retry, same id — the W3 idempotence gate
    await store.append(regionId, mintRecord(id, seq, "hash-a"));

    const stream = await store.readStream(regionId);
    expect(stream).toHaveLength(1);
    expect(recordIdKey(stream[0]!.id)).toBe(recordIdKey(id));
  });

  it("armed write-failure knob throws instead of writing", async () => {
    const store = new ProvenanceStoreFake();
    const regionId = "region-1";
    const id: RecordId = { templateHash: "t-a", ordinalPath: [0], regionEpoch: "e0" };
    const seq = await store.allocateSeq(regionId);

    store.setWriteFailure(true);
    await expect(store.append(regionId, mintRecord(id, seq, "hash-a"))).rejects.toBeInstanceOf(ProvenanceWriteFailure);
    expect(await store.readStream(regionId)).toHaveLength(0);

    store.setWriteFailure(false);
    await store.append(regionId, mintRecord(id, seq, "hash-a"));
    expect(await store.readStream(regionId)).toHaveLength(1);
  });

  it("stream header round-trips, undefined before first write", async () => {
    const store = new ProvenanceStoreFake();
    const regionId = "region-1";
    expect(await store.getHeader(regionId)).toBeUndefined();
    await store.putHeader(regionId, { semanticsEpoch: "v1" });
    expect(await store.getHeader(regionId)).toEqual({ semanticsEpoch: "v1" });
  });
});

describe("PayloadStoreFake — tiering + fault injection", () => {
  it("put then get round-trips value + stampIds at tier 'do'", async () => {
    const store = new PayloadStoreFake();
    await store.put("hash-1", { value: { hello: "world" }, stampIds: [1, 2, 3] });
    const rec = await store.get("hash-1");
    expect(rec).toEqual({ tier: "do", value: { hello: "world" }, stampIds: [1, 2, 3], retention: "standard" });
  });

  it("oversize payload routes to 'pending' instead of 'do'", async () => {
    const store = new PayloadStoreFake();
    store.setValueSizeCapBytes(8); // tiny cap so a short string still trips it
    await store.put("hash-big", { value: "a very long payload value indeed", stampIds: [] });
    expect((await store.get("hash-big")).tier).toBe("pending");
  });

  it("forced eviction (evict) drops value, keeps stampIds — degrades to stub", async () => {
    const store = new PayloadStoreFake();
    await store.put("hash-1", { value: "some evidence", stampIds: [7, 8] });
    expect((await store.get("hash-1")).tier).toBe("do");

    await store.evict("hash-1");

    const rec = await store.get("hash-1");
    expect(rec.tier).toBe("stub");
    expect(rec.value).toBeUndefined();
    expect(rec.stampIds).toEqual([7, 8]); // §5 A1 tier 4: identity + stamps retained
  });

  it("evictAll forces every known hash to stub", async () => {
    const store = new PayloadStoreFake();
    await store.put("h1", { value: 1, stampIds: [] });
    await store.put("h2", { value: 2, stampIds: [] });
    await store.evictAll();
    expect((await store.get("h1")).tier).toBe("stub");
    expect((await store.get("h2")).tier).toBe("stub");
  });

  it("armed put-failure knob throws instead of writing", async () => {
    const store = new PayloadStoreFake();
    store.setPutFailure(true);
    await expect(store.put("hash-1", { value: 1, stampIds: [] })).rejects.toThrow();
  });

  it("delayed R2-settle: pending until enough clock ticks pass, then settles deterministically", async () => {
    const store = new PayloadStoreFake();
    store.setValueSizeCapBytes(1); // force oversize -> pending
    store.setSettleDelayTicks(3);
    await store.put("hash-1", { value: "oversize", stampIds: [42] });
    expect((await store.get("hash-1")).tier).toBe("pending");

    await store.settle("hash-1", "settled"); // scheduled, not yet applied
    expect((await store.get("hash-1")).tier).toBe("pending");

    store.step(2);
    expect((await store.get("hash-1")).tier).toBe("pending"); // still short of the 3-tick delay

    store.step(1);
    const rec = await store.get("hash-1");
    expect(rec.tier).toBe("r2");
    expect(rec.value).toBe("oversize");
  });

  it("R2 settle failure degrades to stub, never silently", async () => {
    const store = new PayloadStoreFake();
    store.setValueSizeCapBytes(1);
    await store.put("hash-1", { value: "oversize", stampIds: [1] });
    await store.settle("hash-1", "failed"); // delay=0 default -> applies immediately

    const rec = await store.get("hash-1");
    expect(rec.tier).toBe("stub");
    expect(rec.value).toBeUndefined();
    expect(rec.stampIds).toEqual([1]);
  });

  it("get on an unknown hash throws (never fabricates a stub)", async () => {
    const store = new PayloadStoreFake();
    await expect(store.get("nope")).rejects.toThrow();
  });
});
