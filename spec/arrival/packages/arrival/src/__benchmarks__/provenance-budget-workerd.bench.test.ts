/**
 * The storage-bound hard gate's pass condition (docs/PROVENANCE.md §4, Appendix
 * A.2): "the recorded stream reconstructs regions (the stream-fold law) after a
 * FORCED mid-run eviction." The sibling `provenance-budget.bench.test.ts` proves
 * the fold LOGIC against fakes; this file proves the SAME logic survives a REAL
 * Durable Object's forced eviction (`DurableObjectState.abort()`, workerd's
 * genuine hibernation primitive — not a fake standing in for one).
 *
 * Run via `pnpm workerd` (its own `vitest.workerd.config.ts`) — opt-in, never part
 * of `pnpm test`/`pnpm benchmarks`: if this file is executing, workerd already
 * started successfully, and a pool that CAN'T start fails loudly at bootstrap,
 * before any test body runs, so a graceful in-test skip isn't meaningful here.
 *
 * SCOPE: `ProvenanceRegionDO` (`workerd/provenance-do-worker.ts`) implements the
 * `ProvenanceStore` contract ONLY (append/allocateSeq/readStream/getHeader/
 * putHeader) — the pass condition names the FOLD, not payload/R2 tiering, so this
 * file drives a REPRESENTATIVE, bounded slice of record volume (hundreds, not the
 * full ~150k-fact reference workload the fakes-based benchmark exercises) — the
 * fold LAW holds at any N by construction (a pure fold over whatever `readStream`
 * returns); the fakes-based benchmark is what proves the numbers hold AT SCALE.
 */
import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { foldRegionStream } from "../provenance/store/fold.js";
import type { ProvenanceRecord } from "../provenance/store/records.js";
import type { Env, ProvenanceRegionDO } from "./workerd/provenance-do-worker.js";

const typedEnv = env as Env;

function trackOpen(templateHash: string, ordinal: number, seq: number): ProvenanceRecord {
  return { kind: "track-open", id: { templateHash, ordinalPath: [ordinal], regionEpoch: "e0" }, seq };
}
function trackClose(templateHash: string, ordinal: number, seq: number, settled: boolean): ProvenanceRecord {
  return { kind: "track-close", id: { templateHash, ordinalPath: [ordinal], regionEpoch: "e0" }, seq, settled };
}
function mint(templateHash: string, ordinal: number, seq: number, payloadHash: string): ProvenanceRecord {
  return { kind: "mint", id: { templateHash, ordinalPath: [ordinal], regionEpoch: "e0" }, seq, payloadHash };
}
function fanInstantiation(templateHash: string, ordinal: number, seq: number): ProvenanceRecord {
  return { kind: "fan-instantiation", id: { templateHash, ordinalPath: [ordinal], regionEpoch: "e0" }, seq };
}
function muxDecision(templateHash: string, ordinal: number, seq: number, arm: number): ProvenanceRecord {
  return { kind: "mux-decision", id: { templateHash, ordinalPath: [ordinal], regionEpoch: "e0" }, seq, arm };
}
/** Force a real DO eviction and assert it actually happened — `state.abort(reason)`
 *  breaks the DO's output gate and THROWS `reason` back out of `runInDurableObject`
 *  (workerd's genuine behavior, observed empirically: the abort propagates as a
 *  rejection, it does not just quietly return). Swallowing anything OTHER than
 *  this exact expected rejection would hide a real bug, so this helper asserts the
 *  message before treating it as "eviction happened, as intended." */
async function forceEviction(stub: DurableObjectStub<ProvenanceRegionDO>, reason: string): Promise<void> {
  await expect(runInDurableObject(stub, (_instance, state) => state.abort(reason))).rejects.toThrow(reason);
}

function hostSchedule(templateHash: string, ordinal: number, seq: number): ProvenanceRecord {
  return {
    kind: "host-schedule",
    id: { templateHash, ordinalPath: [ordinal], regionEpoch: "e0" },
    seq,
    triples: [{ left: [0], right: [1], verdict: -1 }],
  };
}

describe("C2 — MERGE BLOCKER: forced mid-run eviction + fold-reconstruction under REAL workerd", () => {
  it("PROVENANCE_DO binding is wired (canary — fails loudly, not silently, if the harness misconfigures)", () => {
    expect(typedEnv.PROVENANCE_DO).toBeDefined();
  });

  it("a representative slice of every RecordKind survives a FORCED DurableObjectState.abort() mid-run, and foldRegionStream reconstructs identically", async () => {
    const id = typedEnv.PROVENANCE_DO.idFromName("q19-c2-region");
    let stub = typedEnv.PROVENANCE_DO.get(id);

    // ── Phase 1: write the FIRST half, covering every RecordKind at least once ──
    let seq = 0;
    const written: ProvenanceRecord[] = [];
    const writePhase1 = async (): Promise<void> => {
      for (let i = 0; i < 100; i++) {
        const templateHash = `wd-track-${i}`;
        const openSeq = await stub.allocateSeq();
        const openRec = trackOpen(templateHash, 0, openSeq);
        await stub.append(openRec);
        written.push(openRec);
      }
      for (let i = 0; i < 100; i++) {
        const rec = fanInstantiation("wd-fan", i, await stub.allocateSeq());
        await stub.append(rec);
        written.push(rec);
      }
      for (let i = 0; i < 20; i++) {
        const rec = mint("wd-mint", i, await stub.allocateSeq(), `wd-payload-${i}`);
        await stub.append(rec);
        written.push(rec);
      }
      seq = written.reduce((max, r) => Math.max(max, r.seq), 0);
    };
    await writePhase1();

    // ── FORCED MID-RUN EVICTION — the genuine workerd primitive, not a fake's
    //    knob. `state.abort()` breaks the DO's output gate and terminates the JS
    //    execution context. `ProvenanceRegionDO` holds no instance field beyond
    //    ctx/env — there is nothing else for this to lose. ──
    await forceEviction(stub, "Q19 conjunct C2 — simulated mid-run hibernation");
    // The ABORTED stub's own output gate stays broken for the REST of its JS
    // lifetime (observed empirically: every subsequent call on that exact stub
    // object rethrows `broken.outputGateBroken`) — this is workerd's real
    // behavior, not a harness artifact. A fresh `.get(id)` is exactly what a real
    // caller does after a DO wake (it never holds a stub across the eviction it's
    // discovering), so re-fetching here is the FAITHFUL simulation, not a workaround.
    stub = typedEnv.PROVENANCE_DO.get(id);

    // ── Phase 2: the "fresh" post-eviction stub — the next RPC call
    //    re-instantiates a fresh `ProvenanceRegionDO` (fresh constructor, zero
    //    surviving JS state) transparently; only what's in `ctx.storage`
    //    persists. Complete the run's SECOND half through this "fresh" instance.
    //    Track-close uses ordinal 1 (open used ordinal 0) — a real track's
    //    open/close pair are TWO DISTINCT designated instances under an
    //    incrementing `trackOrdinal` (`store/fold.ts`'s `nextTrackOrdinal` doc;
    //    `membrane/region-scope.ts`'s `mintTrackId` mints a fresh
    //    ordinal per event). Reusing ordinal 0 for both would collide on
    //    `recordIdKey` — `RecordId` intentionally excludes `kind` from its
    //    identity triple — so the close would silently idempotent-upsert OVER
    //    the open; real emission never mints two different kinds under one
    //    identical id. ──
    for (let i = 0; i < 100; i++) {
      const rec = trackClose(`wd-track-${i}`, 1, await stub.allocateSeq(), true);
      await stub.append(rec);
      written.push(rec);
    }
    for (let i = 0; i < 5; i++) {
      const rec = muxDecision("wd-mux", i, await stub.allocateSeq(), i % 2);
      await stub.append(rec);
      written.push(rec);
    }
    const scheduleRec = hostSchedule("wd-schedule", 0, await stub.allocateSeq());
    await stub.append(scheduleRec);
    written.push(scheduleRec);

    const header = { semanticsEpoch: "arrival-provenance-workerd-v0" };
    await stub.putHeader(header);

    // ── Assert: the REAL DO's fold matches an INDEPENDENTLY computed expectation
    //    (never derived from the DO's own answer — that would be circular). ──
    const expectedFold = foldRegionStream(written);
    const actualFold = await stub.foldNow();
    expect(actualFold).toEqual(expectedFold);
    expect(actualFold.started).toBe(100);
    expect(actualFold.completed).toBe(100);
    expect(actualFold.pending).toBe(0);
    expect(actualFold.hostSchedules).toHaveLength(1);

    const count = await stub.recordCount();
    expect(count).toBe(written.length); // nothing lost, nothing duplicated

    const streamBack = await stub.readStream();
    expect(streamBack).toHaveLength(written.length);
    // Idempotent-upsert identity (§4): every written record's id round-trips to
    // exactly one stored record — sort both sides by seq and compare directly.
    const sortedWritten = [...written].toSorted((a, b) => a.seq - b.seq);
    expect(streamBack).toEqual(sortedWritten);

    expect(await stub.getHeader()).toEqual(header);

    // ── FORCE EVICTION A SECOND TIME, post-completion — the "after the run
    //    finished" recovery case, not just "mid-run." Fold must still agree. ──
    await forceEviction(stub, "Q19 conjunct C2 — post-completion eviction");
    // Re-fetch the stub too (not just re-call the old reference) — the more
    // conservative form of "a fresh instance," exercising the namespace lookup
    // path a real DO-wake would take.
    stub = typedEnv.PROVENANCE_DO.get(id);
    expect(await stub.foldNow()).toEqual(expectedFold);
    expect(await stub.getHeader()).toEqual(header);

    // ── Recovery's OTHER half (fold.ts's own doc): allocateSeq must NEVER reset —
    //    the monotonic counter is durable state too, not a JS-heap cache. ──
    const nextSeq = await stub.allocateSeq();
    expect(nextSeq).toBeGreaterThan(seq);
  });
});
