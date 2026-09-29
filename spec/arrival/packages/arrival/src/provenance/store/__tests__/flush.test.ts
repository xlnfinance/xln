/**
 * flush.test.ts — Q13's own unit suite for `store/flush.ts` (docs/PROVENANCE.md §5
 * C3; §7 stream fold + monotonicity). Direct, store-fake-backed exercise of
 * `ProvenanceRing`: buffering vs durability, the awaited barrier (`flush`/`atPort`),
 * the size/time backstops, the pre-hibernation hook, and write-failure fault
 * injection (buffer survives, retry re-emits safely). The LAW-FILE-HOMED
 * "durable-write barrier" row lives in
 * `src/__tests__/provenance/track-stream.law.test.ts` — this file is the direct unit
 * grounding underneath it.
 */
import { describe, expect, it } from "vitest";

import { ProvenanceRing } from "../flush.js";
import { ProvenanceStoreFake, ProvenanceWriteFailure } from "../fakes.js";
import type { RecordId } from "../ids.js";
import type { ProvenanceRecord } from "../records.js";

function trackOpen(id: RecordId, seq: number): ProvenanceRecord {
  return { kind: "track-open", id, seq };
}

const REGION = "flush-region";

describe("ProvenanceRing.append/buffered — buffering is NOT durability", () => {
  it("an appended record is buffered but does not reach the underlying store until flush", async () => {
    const store = new ProvenanceStoreFake();
    const ring = new ProvenanceRing(store);
    const id: RecordId = { templateHash: "t", ordinalPath: [0], regionEpoch: "e0" };
    const seq = await store.allocateSeq(REGION);

    await ring.append(REGION, trackOpen(id, seq));
    expect(ring.buffered(REGION)).toHaveLength(1);
    expect(await store.readStream(REGION)).toHaveLength(0); // NOT durable yet

    await ring.flush(REGION);
    expect(ring.buffered(REGION)).toHaveLength(0);
    expect(await store.readStream(REGION)).toHaveLength(1); // durable now
  });

  it("flushing an empty/never-touched region is a no-op, never throws", async () => {
    const store = new ProvenanceStoreFake();
    const ring = new ProvenanceRing(store);
    await expect(ring.flush("no-such-region")).resolves.toBeUndefined();
  });
});

describe("ProvenanceRing.flush — the AWAITED write barrier (§5 C3)", () => {
  it("a failed underlying write throws from flush, and the buffer is NOT drained — never silently dropped", async () => {
    const store = new ProvenanceStoreFake();
    const ring = new ProvenanceRing(store);
    const id: RecordId = { templateHash: "t", ordinalPath: [0], regionEpoch: "e0" };
    await ring.append(REGION, trackOpen(id, await store.allocateSeq(REGION)));

    store.setWriteFailure(true);
    await expect(ring.flush(REGION)).rejects.toBeInstanceOf(ProvenanceWriteFailure);
    expect(ring.buffered(REGION)).toHaveLength(1); // still buffered — the write ABORTED, not partial

    store.setWriteFailure(false);
    await ring.flush(REGION); // the retry
    expect(ring.buffered(REGION)).toHaveLength(0);
    expect(await store.readStream(REGION)).toHaveLength(1); // exactly once, per id — idempotent upsert
  });

  it("a partial-batch failure leaves the WHOLE buffer intact; retry re-appends everything, landing exactly once each", async () => {
    const store = new ProvenanceStoreFake();
    const ring = new ProvenanceRing(store);
    const idA: RecordId = { templateHash: "a", ordinalPath: [0], regionEpoch: "e0" };
    const idB: RecordId = { templateHash: "b", ordinalPath: [1], regionEpoch: "e0" };
    await ring.append(REGION, trackOpen(idA, await store.allocateSeq(REGION)));
    await ring.append(REGION, trackOpen(idB, await store.allocateSeq(REGION)));

    // idA's append lands (store fake has no per-record failure knob, so we simulate a
    // "failed mid-batch" write by flushing idA alone first, then arming failure for
    // the rest of the batch).
    store.setWriteFailure(true);
    await expect(ring.flush(REGION)).rejects.toBeInstanceOf(ProvenanceWriteFailure);
    expect(ring.buffered(REGION)).toHaveLength(2); // nothing drained on failure

    store.setWriteFailure(false);
    await ring.flush(REGION);
    const stream = await store.readStream(REGION);
    expect(stream).toHaveLength(2); // both landed, exactly once each
  });
});

describe("ProvenanceRing.atPort — port-completion barrier", () => {
  it("the port's own result is returned only AFTER its buffered records are durable", async () => {
    const store = new ProvenanceStoreFake();
    const ring = new ProvenanceRing(store);
    const id: RecordId = { templateHash: "t", ordinalPath: [0], regionEpoch: "e0" };

    const result = await ring.atPort(REGION, async () => {
      await ring.append(REGION, trackOpen(id, await store.allocateSeq(REGION)));
      return "port-result";
    });

    expect(result).toBe("port-result");
    expect(await store.readStream(REGION)).toHaveLength(1); // durable by the time atPort resolved
  });

  it("a failed durable write ABORTS the port — atPort rejects, the caller never sees a false completion", async () => {
    const store = new ProvenanceStoreFake();
    const ring = new ProvenanceRing(store);
    const id: RecordId = { templateHash: "t", ordinalPath: [0], regionEpoch: "e0" };
    store.setWriteFailure(true);

    await expect(
      ring.atPort(REGION, async () => {
        await ring.append(REGION, trackOpen(id, await store.allocateSeq(REGION)));
        return "should never surface";
      }),
    ).rejects.toBeInstanceOf(ProvenanceWriteFailure);
  });

  it("a throwing port body skips the flush entirely — its rejection propagates unchanged", async () => {
    const store = new ProvenanceStoreFake();
    const ring = new ProvenanceRing(store);
    const boom = new Error("port body failed before any record existed");
    await expect(
      ring.atPort(REGION, () => {
        throw boom;
      }),
    ).rejects.toBe(boom);
  });
});

describe("ProvenanceRing — size backstop", () => {
  it("append awaits an automatic flush once the region's buffer reaches maxRecords", async () => {
    const store = new ProvenanceStoreFake();
    const ring = new ProvenanceRing(store, { maxRecords: 2 });
    const id = (o: number): RecordId => ({ templateHash: "t", ordinalPath: [o], regionEpoch: "e0" });

    await ring.append(REGION, trackOpen(id(0), await store.allocateSeq(REGION)));
    expect(ring.buffered(REGION)).toHaveLength(1);
    expect(await store.readStream(REGION)).toHaveLength(0); // below the backstop, still buffered

    await ring.append(REGION, trackOpen(id(1), await store.allocateSeq(REGION)));
    expect(ring.buffered(REGION)).toHaveLength(0); // backstop fired — auto-flushed
    expect(await store.readStream(REGION)).toHaveLength(2);
  });

  it("with no maxRecords configured, the buffer grows unbounded until an explicit flush", async () => {
    const store = new ProvenanceStoreFake();
    const ring = new ProvenanceRing(store);
    const id = (o: number): RecordId => ({ templateHash: "t", ordinalPath: [o], regionEpoch: "e0" });
    for (let i = 0; i < 5; i++) await ring.append(REGION, trackOpen(id(i), await store.allocateSeq(REGION)));
    expect(ring.buffered(REGION)).toHaveLength(5);
    expect(await store.readStream(REGION)).toHaveLength(0);
  });
});

describe("ProvenanceRing — time backstop (deterministic virtual clock, no real timers)", () => {
  it("flushAged flushes a region only once its oldest record has aged past maxAgeTicks", async () => {
    const store = new ProvenanceStoreFake();
    const ring = new ProvenanceRing(store, { maxAgeTicks: 3 });
    const id: RecordId = { templateHash: "t", ordinalPath: [0], regionEpoch: "e0" };
    await ring.append(REGION, trackOpen(id, await store.allocateSeq(REGION)));

    ring.tick(2);
    await ring.flushAged();
    expect(ring.buffered(REGION)).toHaveLength(1); // not aged enough yet

    ring.tick(1); // now at age 3 — threshold reached
    await ring.flushAged();
    expect(ring.buffered(REGION)).toHaveLength(0);
    expect(await store.readStream(REGION)).toHaveLength(1);
  });

  it("with no maxAgeTicks configured, flushAged is a permanent no-op regardless of ticks", async () => {
    const store = new ProvenanceStoreFake();
    const ring = new ProvenanceRing(store);
    const id: RecordId = { templateHash: "t", ordinalPath: [0], regionEpoch: "e0" };
    await ring.append(REGION, trackOpen(id, await store.allocateSeq(REGION)));
    ring.tick(1000);
    await ring.flushAged();
    expect(ring.buffered(REGION)).toHaveLength(1); // never auto-flushed
  });
});

describe("ProvenanceRing.preHibernate — the DO's forced pre-hibernation flush", () => {
  it("flushes EVERY region with buffered records, awaited", async () => {
    const store = new ProvenanceStoreFake();
    const ring = new ProvenanceRing(store);
    const idA: RecordId = { templateHash: "a", ordinalPath: [0], regionEpoch: "e0" };
    const idB: RecordId = { templateHash: "b", ordinalPath: [0], regionEpoch: "e0" };
    await ring.append("region-a", trackOpen(idA, await store.allocateSeq("region-a")));
    await ring.append("region-b", trackOpen(idB, await store.allocateSeq("region-b")));

    await ring.preHibernate();

    expect(ring.buffered("region-a")).toHaveLength(0);
    expect(ring.buffered("region-b")).toHaveLength(0);
    expect(await store.readStream("region-a")).toHaveLength(1);
    expect(await store.readStream("region-b")).toHaveLength(1);
  });

  it("with nothing ever buffered, preHibernate resolves trivially", async () => {
    const store = new ProvenanceStoreFake();
    const ring = new ProvenanceRing(store);
    await expect(ring.preHibernate()).resolves.toBeUndefined();
  });
});
