/**
 * region-events.test.ts — Q11b's INTEGRATION exercise of `region-scope.ts`'s emission
 * hooks (docs/PROVENANCE.md §5 record kinds + host-schedule; `src/membrane/region-scope.ts`). Where
 * `provenance/store/__tests__/emit.test.ts` drives `emitTrackOpen`/`emitTrackClose`/
 * `emitHostSchedule` directly, this file drives them through REAL region discipline —
 * `openRegionScope`/`withRegionCall`/`closeRegionScope`, exactly the machinery
 * `membrane/region.law.test.ts` already exercises for the escape/incomplete doors —
 * with a `TrackCoordinate`/`TrackEmissionSink` installed around the run. Mirrors
 * `emission-hooks.test.ts`'s split from `store/__tests__/emit.test.ts` for Q11a.
 *
 * The three things this file exists to prove that the direct unit suite cannot:
 *   1. `withRegionCall`'s `pending++`/`pending--` (B3's counters) actually DRIVE
 *      `emitTrackOpen`/`emitTrackClose` on a REAL reverse-membrane call, not a
 *      hand-built `RecordId`;
 *   2. "sunset byte-identical when off" is true of a REAL reverse-lambda call's
 *      result and timing, not just "the emit* functions no-op in isolation";
 *   3. host-schedule's accumulate-then-flush-at-close design actually flushes at
 *      `closeRegionScope`, exactly once, with the full triple sequence — including
 *      the "flush happens even though the incomplete door still throws" ordering
 *      decision `closeRegionScope`'s own doc calls out.
 */
import { afterEach, describe, expect, it } from "vitest";

import { toJS } from "../../membrane/rosetta.js";
import { ANativeProcedure } from "../../values/primitives/ANativeProcedure.js";
import {
  closeRegionScope,
  openRegionScope,
  recordHostScheduleVerdict,
  withRegionScope,
  withTrackCoordinate,
  type TrackCoordinate,
  type TrackEmissionSink,
} from "../../membrane/region-scope.js";
import { CONSTANT_CTX } from "../../run/RunContext.js";
import { ProvenanceStoreFake } from "../../provenance/store/fakes.js";
import { setEmissionEnabled } from "../../provenance/store/emit.js";

const COORD: TrackCoordinate = { templateHash: "th-track", ordinalPath: [0], regionEpoch: "e0" };
const REGION = "region-events";

afterEach(() => {
  setEmissionEnabled(false);
});

/** A trivial one-arg echo callable — same shape `membrane/region.law.test.ts` uses;
 *  enough surface for open/close counting, indifferent to what it computes. */
function makeEcho(): ANativeProcedure {
  return new ANativeProcedure({
    name: "echo",
    arity: { min: 1, max: 1 },
    contract: undefined,
    impl: (args) => args[0],
  });
}

/** A callable whose impl always THROWS synchronously — proves track-close still fires
 *  (settled: true) on the reject path, not only the resolve path. */
function makeThrowingProc(): ANativeProcedure {
  return new ANativeProcedure({
    name: "boom",
    arity: { min: 0, max: 0 },
    contract: undefined,
    impl: () => {
      throw new Error("region-events probe: deliberate failure");
    },
  });
}

describe("track-open/track-close: real B3 counters through withRegionCall", () => {
  it("flag ON + coordinate/sink installed: one call yields exactly one track-open and one track-close", async () => {
    setEmissionEnabled(true);
    const store = new ProvenanceStoreFake();
    const sink: TrackEmissionSink = { store, regionId: REGION };

    const scope = withTrackCoordinate(COORD, sink, () => openRegionScope({ runCtx: CONSTANT_CTX, dynSite: undefined }));
    const wrapper = withRegionScope(scope, () => toJS(makeEcho()) as (...a: unknown[]) => Promise<unknown>);

    expect(await wrapper(41)).toBe(41); // sanity: the real call still works
    closeRegionScope(scope);

    // Detached emission — give its microtask a turn (mirrors emission-hooks.test.ts).
    await Promise.resolve();
    await Promise.resolve();

    const stream = await store.readStream(REGION);
    const opens = stream.filter((r) => r.kind === "track-open");
    const closes = stream.filter((r) => r.kind === "track-close");
    expect(opens).toHaveLength(1);
    expect(closes).toHaveLength(1);
    expect(closes[0].kind === "track-close" && closes[0].settled).toBe(true);
    // Distinct ids — see region-scope.ts's `mintTrackId` doc: sharing one id would
    // collapse the pair into one record under the store's id-only dedup.
    expect(opens[0].id).not.toEqual(closes[0].id);
  });

  it("TWO calls through the SAME scope claim four DISTINCT track ordinals (2 opens + 2 closes, never colliding)", async () => {
    setEmissionEnabled(true);
    const store = new ProvenanceStoreFake();
    const sink: TrackEmissionSink = { store, regionId: REGION };

    const scope = withTrackCoordinate(COORD, sink, () => openRegionScope({ runCtx: CONSTANT_CTX, dynSite: undefined }));
    const wrapper = withRegionScope(scope, () => toJS(makeEcho()) as (...a: unknown[]) => Promise<unknown>);

    await wrapper(1);
    await wrapper(2);
    closeRegionScope(scope);

    await Promise.resolve();
    await Promise.resolve();

    const stream = await store.readStream(REGION);
    expect(stream.filter((r) => r.kind === "track-open")).toHaveLength(2);
    expect(stream.filter((r) => r.kind === "track-close")).toHaveLength(2);
    // Every record's id is unique — the whole point of `mintTrackId` never reusing an
    // ordinal.
    const keys = stream.map((r) => JSON.stringify(r.id));
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("a REJECTING call still emits track-close settled:true — finally fires on the reject path too", async () => {
    setEmissionEnabled(true);
    const store = new ProvenanceStoreFake();
    const sink: TrackEmissionSink = { store, regionId: REGION };

    const scope = withTrackCoordinate(COORD, sink, () => openRegionScope({ runCtx: CONSTANT_CTX, dynSite: undefined }));
    const wrapper = withRegionScope(scope, () => toJS(makeThrowingProc()) as (...a: unknown[]) => Promise<unknown>);

    await expect(wrapper()).rejects.toThrow(/deliberate failure/);
    closeRegionScope(scope);

    await Promise.resolve();
    await Promise.resolve();

    const stream = await store.readStream(REGION);
    expect(stream.filter((r) => r.kind === "track-open")).toHaveLength(1);
    const closes = stream.filter((r) => r.kind === "track-close");
    expect(closes).toHaveLength(1);
    expect(closes[0].kind === "track-close" && closes[0].settled).toBe(true);
  });

  it("flag OFF: the SAME calls produce the SAME results, and NOTHING lands in the store — byte-identical, sunset", async () => {
    setEmissionEnabled(false);
    const store = new ProvenanceStoreFake();
    const sink: TrackEmissionSink = { store, regionId: REGION };

    const scope = withTrackCoordinate(COORD, sink, () => openRegionScope({ runCtx: CONSTANT_CTX, dynSite: undefined }));
    const wrapper = withRegionScope(scope, () => toJS(makeEcho()) as (...a: unknown[]) => Promise<unknown>);

    expect(await wrapper(41)).toBe(41);
    closeRegionScope(scope);

    await Promise.resolve();
    await Promise.resolve();

    expect(await store.readStream(REGION)).toHaveLength(0);
  });

  it("flag ON but NO coordinate/sink installed (today's actual production shape — nothing wires this yet): no-ops, same result", async () => {
    setEmissionEnabled(true);
    // No withTrackCoordinate wrapper — exactly what every real call site looks like
    // today (rosetta.ts's `openRegionScope` call is unchanged; nothing installs a
    // TrackCoordinate ambiently yet).
    const scope = openRegionScope({ runCtx: CONSTANT_CTX, dynSite: undefined });
    const wrapper = withRegionScope(scope, () => toJS(makeEcho()) as (...a: unknown[]) => Promise<unknown>);
    expect(await wrapper(41)).toBe(41);
    expect(() => closeRegionScope(scope)).not.toThrow();
    // No store to assert against — there IS no sink; the point is the run completes
    // identically without one (mirrors emission-hooks.test.ts's identical row).
  });
});

describe("host-schedule: accumulate-then-flush-at-close (§5 D5)", () => {
  it("closeRegionScope flushes ALL accumulated triples as ONE HostScheduleRecord", async () => {
    setEmissionEnabled(true);
    const store = new ProvenanceStoreFake();
    const sink: TrackEmissionSink = { store, regionId: REGION };
    const scope = withTrackCoordinate(COORD, sink, () => openRegionScope({ runCtx: CONSTANT_CTX, dynSite: undefined }));

    recordHostScheduleVerdict(scope, [0], [1], -1);
    recordHostScheduleVerdict(scope, [1], [2], 1);
    recordHostScheduleVerdict(scope, [0], [2], -1);
    closeRegionScope(scope);

    await Promise.resolve();
    await Promise.resolve();

    const stream = await store.readStream(REGION);
    const schedules = stream.filter((r) => r.kind === "host-schedule");
    expect(schedules).toHaveLength(1); // ONE record for the whole schedule
    expect(schedules[0].kind === "host-schedule" && schedules[0].triples).toEqual([
      { left: [0], right: [1], verdict: -1 },
      { left: [1], right: [2], verdict: 1 },
      { left: [0], right: [2], verdict: -1 },
    ]);
  });

  it("zero verdicts recorded: close flushes nothing — no empty HostScheduleRecord", async () => {
    setEmissionEnabled(true);
    const store = new ProvenanceStoreFake();
    const sink: TrackEmissionSink = { store, regionId: REGION };
    const scope = withTrackCoordinate(COORD, sink, () => openRegionScope({ runCtx: CONSTANT_CTX, dynSite: undefined }));

    closeRegionScope(scope);
    await Promise.resolve();
    await Promise.resolve();

    expect(await store.readStream(REGION)).toHaveLength(0);
  });

  it("the schedule flushes even when close ALSO throws the incomplete door (independent concerns)", async () => {
    setEmissionEnabled(true);
    const store = new ProvenanceStoreFake();
    const sink: TrackEmissionSink = { store, regionId: REGION };
    const scope = withTrackCoordinate(COORD, sink, () => openRegionScope({ runCtx: CONSTANT_CTX, dynSite: undefined }));
    const wrapper = withRegionScope(scope, () => toJS(makeEcho()) as (...a: unknown[]) => Promise<unknown>);

    recordHostScheduleVerdict(scope, [0], [1], 1);
    const call = wrapper(1); // started, deliberately never awaited before close
    expect(() => closeRegionScope(scope)).toThrow(/reverse-lambda call incomplete/);

    await Promise.resolve();
    await Promise.resolve();

    const stream = await store.readStream(REGION);
    expect(stream.filter((r) => r.kind === "host-schedule")).toHaveLength(1);
    await call; // let the in-flight call settle — nothing lingers as an unhandled rejection
  });

  it("flag OFF: recordHostScheduleVerdict never accumulates, close never emits", async () => {
    setEmissionEnabled(false);
    const store = new ProvenanceStoreFake();
    const sink: TrackEmissionSink = { store, regionId: REGION };
    const scope = withTrackCoordinate(COORD, sink, () => openRegionScope({ runCtx: CONSTANT_CTX, dynSite: undefined }));

    recordHostScheduleVerdict(scope, [0], [1], -1);
    expect(scope.hostSchedule).toHaveLength(0); // never accumulated while off
    closeRegionScope(scope);

    await Promise.resolve();
    expect(await store.readStream(REGION)).toHaveLength(0);
  });
});
