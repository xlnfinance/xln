/**
 * LAW — W3 port completeness (GREEN at Q11a); stream fold + monotonicity +
 * fold-as-recovery, and the I4 async-completion door (docs/PROVENANCE.md §3 I2/I4,
 * §5 "The retrospective stream", §7 law table — Q5's stub-file
 * mapping) — ALL GREEN as of Q13.
 *
 * Q5 CREATED this file as pure `it.todo` staged spec. W3 flipped at Q11a (real
 * emission hooks: `src/provenance/store/emit.ts`'s `emitMint`/`emitMuxDecision`/
 * `emitFanInstantiation`/`emitIngressBinding`, exercised through the store fakes with
 * fault injection — the SAME idempotent-upsert contract `store/__tests__/emit.test.ts`
 * drives in more detail; those two rows are the LAW-FILE-HOMED assertion of that same
 * property, per Q5's mapping table).
 *
 * Q11b ADDENDUM: track-open/track-close/host-schedule (§5 A6 rows 5-6, D5) had no
 * staged rows anywhere in the Q5 mapping — this file added them fresh, at the SAME
 * "LAW-FILE-HOMED assertion of the store-level property" grain the W3 block above
 * uses (direct `emit*` calls through the fakes); the REAL deciding-WHEN half — B3's
 * counters in `region-scope.ts` actually calling these — is exercised end-to-end in
 * `src/__tests__/provenance/region-events.test.ts` (Q11b's sibling of
 * `emission-hooks.test.ts`), not here.
 *
 * Q13 flips the remaining six rows (docs/PROVENANCE.md §7 stream fold + monotonicity; §5 C1's
 * fold-as-recovery, §5 C3's flush/barrier policy, §3 I4's completion door):
 *   - fold-as-recovery + monotonicity + eviction-refold exercise REAL
 *     `region-scope.ts` machinery (`openRegionScope`/`withRegionCall`/
 *     `closeRegionScope`/`reconstructRegionScope`) through `store/fold.ts`'s
 *     `foldRegionState`/`foldRegionStream` — the direct unit grounding for
 *     `fold.ts` itself lives in `store/__tests__/fold.test.ts`;
 *   - the durable-write-barrier row exercises `store/flush.ts`'s `ProvenanceRing`
 *     directly — its direct unit grounding lives in `store/__tests__/flush.test.ts`;
 *   - the two I4 rows exercise `region-scope.ts`'s `closeRegionScope`/
 *     `regionIncompleteDoor` in isolation (no store needed — the door is pure region
 *     discipline, independent of whether emission is even enabled) — "this row's
 *     test home is deliberately HERE... because region-close semantics live where
 *     regions themselves live."
 */
import { describe, expect, it } from "vitest";

import {
  emitFanInstantiation,
  emitHostSchedule,
  emitIngressBinding,
  emitMint,
  emitMuxDecision,
  emitTrackClose,
  emitTrackOpen,
  setEmissionEnabled,
} from "../../provenance/store/emit.js";
import { PayloadStoreFake, ProvenanceStoreFake, ProvenanceWriteFailure } from "../../provenance/store/fakes.js";
import { foldRegionState, foldRegionStream } from "../../provenance/store/fold.js";
import { ProvenanceRing } from "../../provenance/store/flush.js";
import type { RecordId } from "../../provenance/store/ids.js";
import {
  closeRegionScope,
  openRegionScope,
  reconstructRegionScope,
  recordHostScheduleVerdict,
  withRegionCall,
  withTrackCoordinate,
  type TrackCoordinate,
  type TrackEmissionSink,
} from "../../membrane/region-scope.js";
import { CONSTANT_CTX } from "../../run/RunContext.js";

/** A manually-controlled promise — the "no real timers" idiom `store/fakes.ts` uses
 *  for `PayloadStoreFake`'s virtual clock, applied here to control PROMISE
 *  SETTLEMENT order deterministically (§5 D4: "the stream's total order is EMISSION
 *  order (settlement order for async)") without a real await race. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe("W3 port completeness (docs/PROVENANCE.md §7 law table)", () => {
  const REGION = "w3-region";

  it(
    "every mint/decision/instantiation/ingress-binding record is emitted EXACTLY ONCE " +
      "PER RECORD ID — idempotent under request retry/re-emission (a repeated real " +
      "emission call for the same logical event never duplicates in the stream)",
    async () => {
      setEmissionEnabled(true);
      try {
        const store = new ProvenanceStoreFake();
        const payloads = new PayloadStoreFake();
        const mintId: RecordId = { templateHash: "mint", ordinalPath: [0], regionEpoch: "e0" };
        const muxId: RecordId = { templateHash: "mux", ordinalPath: [1], regionEpoch: "e0" };
        const fanId: RecordId = { templateHash: "fan", ordinalPath: [2], regionEpoch: "e0" };
        const ingressId: RecordId = { templateHash: "ingress", ordinalPath: [3], regionEpoch: "e0" };

        // Each kind's emission function called TWICE with the identical RecordId — a
        // re-emission (the retry shape), never a fresh id per call.
        for (let i = 0; i < 2; i++) {
          await emitMint({ store, payloads, regionId: REGION, id: mintId, value: "v", stampIds: [1] });
          await emitMuxDecision({ store, regionId: REGION, id: muxId, arm: 0 });
          await emitFanInstantiation({ store, regionId: REGION, id: fanId });
          await emitIngressBinding({ store, regionId: REGION, id: ingressId });
        }

        const stream = await store.readStream(REGION);
        expect(stream).toHaveLength(4); // one record per DISTINCT id — never per emit call
      } finally {
        setEmissionEnabled(false);
      }
    },
  );

  it(
    "W3's exactly-once is exactly-once PER ID, not per write attempt — a CF request " +
      "retry that re-emits the identical record overwrites in place (§5 C2/D1's " +
      "idempotent-upsert contract, exercised through real emission, not just the fake)",
    async () => {
      setEmissionEnabled(true);
      try {
        const store = new ProvenanceStoreFake();
        const payloads = new PayloadStoreFake();
        const id: RecordId = { templateHash: "mint-retry", ordinalPath: [0], regionEpoch: "e0" };

        // The FIRST attempt fails mid-write (the CF-request-retry shape §5 C3 names) —
        // nothing lands.
        store.setWriteFailure(true);
        await expect(
          emitMint({ store, payloads, regionId: REGION, id, value: "v", stampIds: [] }),
        ).rejects.toBeInstanceOf(ProvenanceWriteFailure);
        expect(await store.readStream(REGION)).toHaveLength(0);

        // The RETRY (clearing the fault, re-emitting the identical logical event)
        // succeeds — and a THIRD re-emission after that still overwrites in place,
        // never duplicates.
        store.setWriteFailure(false);
        await emitMint({ store, payloads, regionId: REGION, id, value: "v", stampIds: [] });
        await emitMint({ store, payloads, regionId: REGION, id, value: "v", stampIds: [] });

        const stream = await store.readStream(REGION);
        expect(stream).toHaveLength(1); // exactly once, per id — not per write attempt
      } finally {
        setEmissionEnabled(false);
      }
    },
  );
});

describe("region events + host-schedule (docs/PROVENANCE.md §5 A6 rows 5-6, D5)", () => {
  const REGION = "q11b-region";

  it(
    "a track-open/track-close pair is emitted EXACTLY ONCE PER RECORD ID under retry " +
      "— the SAME idempotent-upsert contract W3 asserts for mint/mux/fan/ingress, now " +
      "over the two region-event kinds (§5 A6 row 5). Open and close use DISTINCT ids " +
      "(`ProvenanceStoreFake.append` dedupes on id ALONE, never id+kind — sharing one " +
      "id would collapse the pair into one record) — correlation is by stream ORDER, " +
      "not shared identity (region-scope.ts's `mintTrackId` doc)",
    async () => {
      setEmissionEnabled(true);
      try {
        const store = new ProvenanceStoreFake();
        const openId: RecordId = { templateHash: "track", ordinalPath: [0], regionEpoch: "e0" };
        const closeId: RecordId = { templateHash: "track", ordinalPath: [1], regionEpoch: "e0" };

        for (let i = 0; i < 2; i++) {
          await emitTrackOpen({ store, regionId: REGION, id: openId });
          await emitTrackClose({ store, regionId: REGION, id: closeId, settled: true });
        }

        const stream = await store.readStream(REGION);
        expect(stream).toHaveLength(2); // one per DISTINCT id, despite 4 emit calls
        expect(new Set(stream.map((r) => r.kind))).toEqual(new Set(["track-open", "track-close"]));
      } finally {
        setEmissionEnabled(false);
      }
    },
  );

  it(
    "a host-schedule record carries its FULL comparator sequence as ONE record — " +
      '"the sequence IS the record" (§5 A6 row 6), never aggregated, never split ' +
      "across multiple records for one host invocation",
    async () => {
      setEmissionEnabled(true);
      try {
        const store = new ProvenanceStoreFake();
        const id: RecordId = { templateHash: "sort-call", ordinalPath: [0], regionEpoch: "e0" };
        const triples = [
          { left: [0], right: [1], verdict: -1 },
          { left: [1], right: [2], verdict: 1 },
        ];
        await emitHostSchedule({ store, regionId: REGION, id, triples });
        // A retry of the SAME logical host invocation (identical id) overwrites in
        // place — W3's exactly-once-per-id, applied to the one-kind-never-aggregates
        // row.
        await emitHostSchedule({ store, regionId: REGION, id, triples });

        const stream = await store.readStream(REGION);
        expect(stream).toHaveLength(1);
        expect(stream[0].kind).toBe("host-schedule");
        expect(stream[0].kind === "host-schedule" && stream[0].triples).toEqual(triples);
      } finally {
        setEmissionEnabled(false);
      }
    },
  );
});

describe("stream fold + monotonicity + fold-as-recovery (docs/PROVENANCE.md §5 C1, §7 stream fold)", () => {
  const REGION = "q13-fold-region";

  it(
    'fold(events) = final region state — the SAME fold that answers a post-hoc "what ' +
      "was this region's state\" query also RECONSTRUCTS region state on DO wake after " +
      'eviction/hibernation (§5 C1: "the law is the recovery mechanism")',
    async () => {
      setEmissionEnabled(true);
      try {
        const store = new ProvenanceStoreFake();
        const sink: TrackEmissionSink = { store, regionId: REGION };
        const coordinate: TrackCoordinate = { templateHash: "th-fold", ordinalPath: [0], regionEpoch: "e0" };

        const scope = withTrackCoordinate(coordinate, sink, () =>
          openRegionScope({ runCtx: CONSTANT_CTX, dynSite: undefined }),
        );
        await withRegionCall(scope, () => 1);
        await withRegionCall(scope, () => 2);
        recordHostScheduleVerdict(scope, [0], [1], -1);
        closeRegionScope(scope);

        // Detached emission — give its microtasks a turn (mirrors region-events.test.ts).
        await Promise.resolve();
        await Promise.resolve();

        // The "post-hoc query" answer.
        const postHoc = await foldRegionState(store, REGION);
        expect(postHoc.started).toBe(2);
        expect(postHoc.completed).toBe(2);
        expect(postHoc.pending).toBe(0);
        expect(postHoc.hostSchedules).toHaveLength(1);
        expect(postHoc.hostSchedules[0].triples).toEqual([{ left: [0], right: [1], verdict: -1 }]);

        // Simulate a DO wake after eviction/hibernation: nothing here re-reads the
        // in-memory `scope` object — recompute PURELY from `store.readStream`, the SAME
        // function, the SAME arguments. §5 C1's claim is that this is not a
        // coincidence: fold-as-recovery IS calling `foldRegionState` again.
        const reconstructed = await foldRegionState(store, REGION);
        expect(reconstructed).toEqual(postHoc);
      } finally {
        setEmissionEnabled(false);
      }
    },
  );

  it(
    "completed ≤ started, monotone, over EVERY emission order — async settlement " +
      "reordering (the stream's total order is settlement order for async, §5 D4) " +
      "never produces a state where more tracks are completed than were ever started",
    async () => {
      setEmissionEnabled(true);
      try {
        const store = new ProvenanceStoreFake();
        const sink: TrackEmissionSink = { store, regionId: REGION };
        const coordinate: TrackCoordinate = { templateHash: "th-mono", ordinalPath: [0], regionEpoch: "e0" };
        const scope = withTrackCoordinate(coordinate, sink, () =>
          openRegionScope({ runCtx: CONSTANT_CTX, dynSite: undefined }),
        );

        // Call A opens FIRST but settles SECOND; call B opens SECOND but settles FIRST —
        // the out-of-program-order settlement §5 D4 names. Both promises are manually
        // controlled (no real timers), so the ordering below is deterministic.
        const a = deferred<number>();
        const b = deferred<number>();
        const callA = withRegionCall(scope, () => a.promise);
        const callB = withRegionCall(scope, () => b.promise);

        b.resolve(2); // B settles first, despite starting second
        await callB;
        a.resolve(1);
        await callA;

        closeRegionScope(scope);
        await Promise.resolve();
        await Promise.resolve();

        const stream = await store.readStream(REGION);
        // Monotonicity over EVERY prefix of the emission-ordered stream — never more
        // completions than starts, at any point the stream is read.
        for (let k = 1; k <= stream.length; k++) {
          const prefixFold = foldRegionStream(stream.slice(0, k));
          expect(prefixFold.completed).toBeLessThanOrEqual(prefixFold.started);
          expect(prefixFold.pending).toBeGreaterThanOrEqual(0);
        }
        const finalFold = foldRegionStream(stream);
        expect(finalFold.started).toBe(2);
        expect(finalFold.completed).toBe(2);
        expect(finalFold.pending).toBe(0);
        // B's close (settled first) really did land BEFORE A's close (settled second) —
        // the emission order reflects settlement order, not call/open order.
        const closes = stream.filter((r) => r.kind === "track-close");
        expect(closes.map((r) => r.seq)).toEqual([...closes.map((r) => r.seq)].toSorted((x, y) => x - y));

        // RISK note (Q13, docs/PROVENANCE.md §7 stream fold + monotonicity): per-region seq must be settlement-
        // ordered under injected delays — use the fakes' setSettleDelayTicks/step to
        // prove it. Drive an INDEPENDENTLY-timed R2 payload settlement on its own
        // virtual clock (PayloadStoreFake's OWN knobs) concurrently, and prove it never
        // perturbs the ProvenanceStore stream's seq order or this region's fold — the
        // two stores are genuinely independent timelines, exactly as §5 A1's tiering
        // design assumes (`fold.ts` never reads `PayloadStore` at all).
        const payloads = new PayloadStoreFake();
        payloads.setValueSizeCapBytes(1); // force oversize -> "pending" tier
        payloads.setSettleDelayTicks(5);
        const oversizeHash = "payload-v0:mono-oversize";
        await payloads.put(oversizeHash, { value: "a value bigger than one byte", stampIds: [] });
        expect((await payloads.get(oversizeHash)).tier).toBe("pending");
        await payloads.settle(oversizeHash, "settled"); // scheduled, not yet applied
        payloads.step(3);
        expect((await payloads.get(oversizeHash)).tier).toBe("pending"); // still mid-delay
        payloads.step(2); // now at tick 5 — the scheduled settle applies
        expect((await payloads.get(oversizeHash)).tier).toBe("r2");

        // The region fold recomputed AFTER driving the payload store's independent
        // clock is byte-identical to the one computed before — settlement timing on ONE
        // store never leaks into the other's derived state.
        expect(foldRegionStream(await store.readStream(REGION))).toEqual(finalFold);
      } finally {
        setEmissionEnabled(false);
      }
    },
  );

  it(
    "forced mid-run eviction followed by a refold reconstructs the IDENTICAL region " +
      "state the in-memory cache held before eviction — exercised under fault injection " +
      "(in-memory region state is a CACHE of the stream, never the source of truth, " +
      "§5 C1 EXCLUDED: production regions that exist only in memory)",
    async () => {
      setEmissionEnabled(true);
      try {
        const store = new ProvenanceStoreFake();
        const sink: TrackEmissionSink = { store, regionId: REGION };
        const coordinate: TrackCoordinate = { templateHash: "th-evict", ordinalPath: [0], regionEpoch: "e0" };

        const scope = withTrackCoordinate(coordinate, sink, () =>
          openRegionScope({ runCtx: CONSTANT_CTX, dynSite: undefined }),
        );
        // One call completes CLEANLY before the crash.
        await withRegionCall(scope, () => 1);
        await Promise.resolve();
        await Promise.resolve();

        // A SECOND call starts but never settles before the simulated crash: the DO's
        // JS heap (this test's `scope` object, and the never-resolving promise's own
        // continuation) is discarded — nothing below ever resolves the deferred or
        // calls `closeRegionScope(scope)` again. Only the durable stream survives.
        const stuck = deferred<number>();
        void withRegionCall(scope, () => stuck.promise).catch(() => {}); // fire-and-forget, like a crashed call
        await Promise.resolve();
        await Promise.resolve();

        const beforeEviction = await foldRegionState(store, REGION);
        expect(beforeEviction.started).toBe(2);
        expect(beforeEviction.completed).toBe(1);
        expect(beforeEviction.pending).toBe(1); // the stuck call, honestly reported

        // "Forced eviction" — drop every in-memory reference (`scope` goes unused from
        // here on; a real DO wake has no way to reach it either) and refold PURELY
        // from the durable stream: SAME function, SAME arguments.
        const afterEviction = await foldRegionState(store, REGION);
        expect(afterEviction).toEqual(beforeEviction); // identical — the fold is pure

        // Continue: a resumed scope seeded from that SAME fold correctly reports the
        // crash as incomplete (I4, applied to recovery) — closing it immediately throws.
        const resumed = await reconstructRegionScope({ runCtx: CONSTANT_CTX, dynSite: undefined, coordinate, sink });
        expect(resumed.pending).toBe(1);
        expect(() => closeRegionScope(resumed)).toThrow(/incomplete/);

        // A FRESH resumed scope (recovery re-attempted after detecting the crash above)
        // mints its next track event past every ordinal already durable — no collision
        // with the crashed call's own id (§5 C2/D1).
        const resumedAgain = await reconstructRegionScope({
          runCtx: CONSTANT_CTX,
          dynSite: undefined,
          coordinate,
          sink,
        });
        await withRegionCall(resumedAgain, () => "recovered");
        await Promise.resolve();
        await Promise.resolve();

        const finalStream = await store.readStream(REGION);
        const ids = finalStream.map((r) => JSON.stringify(r.id));
        expect(new Set(ids).size).toBe(ids.length); // every id still unique, even post-recovery

        stuck.resolve(0); // let the abandoned promise settle so it never surfaces as an
        // unhandled rejection in the test runner — the crashed call's OWN `finally`
        // still fires in THIS test (JS doesn't actually crash), decrementing a
        // `pending` counter on the original `scope` nothing reads anymore; harmless.
      } finally {
        setEmissionEnabled(false);
      }
    },
  );

  it(
    "the durable-write barrier: a failed durable write kills the request (never " +
      "silently drops), and the idempotent record id makes the retry's re-emission safe " +
      "(§5 C3 flush policy — port completion barriers on the durable write)",
    async () => {
      const store = new ProvenanceStoreFake();
      const ring = new ProvenanceRing(store);
      const id: RecordId = { templateHash: "th-barrier", ordinalPath: [0], regionEpoch: "e0" };

      store.setWriteFailure(true);
      await expect(
        ring.atPort(REGION, async () => {
          await ring.append(REGION, { kind: "track-open", id, seq: await store.allocateSeq(REGION) });
          return "port completed"; // must NEVER surface — the write barrier aborts first
        }),
      ).rejects.toBeInstanceOf(ProvenanceWriteFailure);
      expect(await store.readStream(REGION)).toHaveLength(0); // never silently dropped as "durable"
      expect(ring.buffered(REGION)).toHaveLength(1); // still buffered — safe to retry

      store.setWriteFailure(false);
      await ring.flush(REGION); // the retry
      await ring.flush(REGION); // idempotent upsert
      const stream = await store.readStream(REGION);
      expect(stream).toHaveLength(1); // exactly once, per id — never per write attempt
    },
  );
});

describe("I4 — completion, the async promise-pending door (§3 I4; its test home is Q13)", () => {
  it(
    "started = completed at region close — a region with any track still started-but-" +
      "not-completed throws the incomplete door at close time",
    async () => {
      const scope = openRegionScope({ runCtx: CONSTANT_CTX, dynSite: undefined });
      const held = deferred<number>();
      const call = withRegionCall(scope, () => held.promise); // started, deliberately never settled
      expect(scope.pending).toBe(1);

      expect(() => closeRegionScope(scope)).toThrow(/incomplete/);

      held.resolve(0); // let the in-flight call settle so nothing lingers unhandled
      await call;
    },
  );

  it(
    "a promise egress keeps its track PENDING until settled — region close with an " +
      "unsettled promise egress throws the incomplete door (§4 CHOSEN panel C9 async " +
      "rule); this row's test home is deliberately HERE, not in replay.law.test.ts, " +
      "because region-close semantics live where regions themselves live (§5 C1/C3)",
    async () => {
      // Close BEFORE settlement: throws.
      const scopeA = openRegionScope({ runCtx: CONSTANT_CTX, dynSite: undefined });
      const heldA = deferred<number>();
      const callA = withRegionCall(scopeA, () => heldA.promise);
      expect(() => closeRegionScope(scopeA)).toThrow(/incomplete/);
      heldA.resolve(1);
      await callA;

      // Settle BEFORE close, on a FRESH scope: does NOT throw — "kept pending UNTIL
      // settled," never "forever poisoned by having been async at all."
      const scopeB = openRegionScope({ runCtx: CONSTANT_CTX, dynSite: undefined });
      const heldB = deferred<number>();
      const callB = withRegionCall(scopeB, () => heldB.promise);
      heldB.resolve(2);
      await callB; // settles — pending drops back to 0
      expect(scopeB.pending).toBe(0);
      expect(() => closeRegionScope(scopeB)).not.toThrow();
    },
  );
});
