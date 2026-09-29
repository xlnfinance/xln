/**
 * fold.test.ts — Q13's own unit suite for `store/fold.ts` (docs/PROVENANCE.md §5 C1;
 * §7 stream fold + monotonicity). Direct, store-fake-backed exercise of the pure fold:
 * shape correctness per record kind, purity (same input, same output, twice), and
 * `nextTrackOrdinal`'s collision-avoidance scoping. The LAW-FILE-HOMED assertions
 * (fold-as-recovery through real region-scope.ts machinery, monotonicity under
 * settlement reordering, the eviction-refold scenario) live in
 * `src/__tests__/provenance/track-stream.law.test.ts` — this file is the direct unit
 * grounding underneath those, mirroring `emit.test.ts`'s split from
 * `emission-hooks.test.ts`/`region-events.test.ts`.
 */
import { describe, expect, it } from "vitest";

import { foldRegionState, foldRegionStream, nextTrackOrdinal } from "../fold.js";
import { ProvenanceStoreFake } from "../fakes.js";
import type { RecordId } from "../ids.js";
import type { ProvenanceRecord } from "../records.js";

function trackOpen(id: RecordId, seq: number): ProvenanceRecord {
  return { kind: "track-open", id, seq };
}
function trackClose(id: RecordId, seq: number, settled = true): ProvenanceRecord {
  return { kind: "track-close", id, seq, settled };
}
function hostSchedule(
  id: RecordId,
  seq: number,
  triples: readonly { left: readonly number[]; right: readonly number[]; verdict: number }[],
): ProvenanceRecord {
  return { kind: "host-schedule", id, seq, triples };
}

const COORD = { templateHash: "t", ordinalPath: [0] as const, regionEpoch: "e0" };

describe("foldRegionStream — the empty/base case", () => {
  it("an empty stream folds to all-zero state", () => {
    expect(foldRegionStream([])).toEqual({
      started: 0,
      completed: 0,
      unsettledCloses: 0,
      pending: 0,
      hostSchedules: [],
      lastSeq: 0,
    });
  });
});

describe("foldRegionStream — started/completed/pending over track-open/track-close", () => {
  it("counts opens and settled closes independently, deriving pending", () => {
    const id = (o: number): RecordId => ({ templateHash: "t", ordinalPath: [o], regionEpoch: "e0" });
    const records = [trackOpen(id(0), 1), trackOpen(id(1), 2), trackClose(id(2), 3)];
    const fold = foldRegionStream(records);
    expect(fold.started).toBe(2);
    expect(fold.completed).toBe(1);
    expect(fold.pending).toBe(1);
    expect(fold.unsettledCloses).toBe(0);
  });

  it("an unsettled (settled: false) close is counted SEPARATELY — never folded into `completed`", () => {
    const id = (o: number): RecordId => ({ templateHash: "t", ordinalPath: [o], regionEpoch: "e0" });
    const records = [trackOpen(id(0), 1), trackClose(id(1), 2, false)];
    const fold = foldRegionStream(records);
    expect(fold.started).toBe(1);
    expect(fold.completed).toBe(0);
    expect(fold.unsettledCloses).toBe(1);
    // an unsettled close is NOT a completion — pending still reads 1 (started - completed)
    expect(fold.pending).toBe(1);
  });

  it("folds records out of seq order identically to in-order — the fold sorts by seq itself", () => {
    const id = (o: number): RecordId => ({ templateHash: "t", ordinalPath: [o], regionEpoch: "e0" });
    const inOrder = [trackOpen(id(0), 1), trackOpen(id(1), 2), trackClose(id(2), 3)];
    const shuffled = [inOrder[2], inOrder[0], inOrder[1]];
    expect(foldRegionStream(shuffled)).toEqual(foldRegionStream(inOrder));
  });

  it("lastSeq is the maximum seq observed", () => {
    const id = (o: number): RecordId => ({ templateHash: "t", ordinalPath: [o], regionEpoch: "e0" });
    const records = [trackOpen(id(0), 5), trackOpen(id(1), 2), trackClose(id(2), 9)];
    expect(foldRegionStream(records).lastSeq).toBe(9);
  });
});

describe("foldRegionStream — host-schedule accumulation", () => {
  it("collects every host-schedule record, in stream order", () => {
    const idA: RecordId = { templateHash: "sort-a", ordinalPath: [0], regionEpoch: "e0" };
    const idB: RecordId = { templateHash: "sort-b", ordinalPath: [1], regionEpoch: "e0" };
    const triplesA = [{ left: [0], right: [1], verdict: -1 }];
    const triplesB = [{ left: [0], right: [1], verdict: 1 }];
    const records = [hostSchedule(idB, 2, triplesB), hostSchedule(idA, 1, triplesA)];
    const fold = foldRegionStream(records);
    expect(fold.hostSchedules).toHaveLength(2);
    // sorted by seq — idA (seq 1) before idB (seq 2), despite input order
    expect(fold.hostSchedules[0]).toEqual(hostSchedule(idA, 1, triplesA));
    expect(fold.hostSchedules[1]).toEqual(hostSchedule(idB, 2, triplesB));
  });
});

describe("foldRegionStream — the payload-free/payload-bearing kinds it deliberately ignores", () => {
  it("mint/mux-decision/fan-instantiation/ingress-binding contribute NOTHING to region/track state", () => {
    const id = (t: string): RecordId => ({ templateHash: t, ordinalPath: [0], regionEpoch: "e0" });
    const records: ProvenanceRecord[] = [
      { kind: "mint", id: id("m"), seq: 1, payloadHash: "payload-v0:0" },
      { kind: "mux-decision", id: id("x"), seq: 2, arm: 0 },
      { kind: "fan-instantiation", id: id("f"), seq: 3 },
      { kind: "ingress-binding", id: id("i"), seq: 4 },
    ];
    const fold = foldRegionStream(records);
    expect(fold.started).toBe(0);
    expect(fold.completed).toBe(0);
    expect(fold.hostSchedules).toHaveLength(0);
    expect(fold.lastSeq).toBe(4); // lastSeq still tracks every kind
  });
});

describe("foldRegionState — reads the store, then folds (the DO-wake recovery shape)", () => {
  it("matches foldRegionStream(await store.readStream(regionId))", async () => {
    const store = new ProvenanceStoreFake();
    const region = "fold-state-region";
    const id = (o: number): RecordId => ({ templateHash: "t", ordinalPath: [o], regionEpoch: "e0" });
    await store.append(region, trackOpen(id(0), await store.allocateSeq(region)));
    await store.append(region, trackClose(id(1), await store.allocateSeq(region)));

    const fromConvenience = await foldRegionState(store, region);
    const fromManualFold = foldRegionStream(await store.readStream(region));
    expect(fromConvenience).toEqual(fromManualFold);
    expect(fromConvenience.started).toBe(1);
    expect(fromConvenience.completed).toBe(1);
    expect(fromConvenience.pending).toBe(0);
  });

  it("purity: calling it twice against an UNCHANGED store returns an identical result — the fold-as-recovery grounding", async () => {
    const store = new ProvenanceStoreFake();
    const region = "fold-purity-region";
    const id = (o: number): RecordId => ({ templateHash: "t", ordinalPath: [o], regionEpoch: "e0" });
    await store.append(region, trackOpen(id(0), await store.allocateSeq(region)));

    const first = await foldRegionState(store, region);
    const second = await foldRegionState(store, region); // simulates a post-eviction re-fold
    expect(second).toEqual(first);
  });
});

describe("nextTrackOrdinal — §5 C2/D1 collision avoidance for a resumed scope", () => {
  it("0 for a coordinate with no track events yet", () => {
    expect(nextTrackOrdinal([], COORD)).toBe(0);
  });

  it("one past the highest trailing ordinal already used under this EXACT coordinate", () => {
    const records: ProvenanceRecord[] = [
      trackOpen({ templateHash: COORD.templateHash, ordinalPath: [0, 0], regionEpoch: COORD.regionEpoch }, 1),
      trackClose({ templateHash: COORD.templateHash, ordinalPath: [0, 1], regionEpoch: COORD.regionEpoch }, 2),
      trackOpen({ templateHash: COORD.templateHash, ordinalPath: [0, 2], regionEpoch: COORD.regionEpoch }, 3),
    ];
    expect(nextTrackOrdinal(records, COORD)).toBe(3);
  });

  it("ignores a DIFFERENT templateHash/regionEpoch even at the same ordinalPath prefix", () => {
    const records: ProvenanceRecord[] = [
      trackOpen({ templateHash: "other-template", ordinalPath: [0, 9], regionEpoch: COORD.regionEpoch }, 1),
      trackOpen({ templateHash: COORD.templateHash, ordinalPath: [0, 9], regionEpoch: "other-epoch" }, 2),
    ];
    expect(nextTrackOrdinal(records, COORD)).toBe(0); // neither matches BOTH fields
  });

  it("ignores a DEEPER nested path (not a direct track event under this coordinate)", () => {
    const records: ProvenanceRecord[] = [
      trackOpen({ templateHash: COORD.templateHash, ordinalPath: [0, 5, 1], regionEpoch: COORD.regionEpoch }, 1),
    ];
    expect(nextTrackOrdinal(records, COORD)).toBe(0); // length mismatch — not COORD.ordinalPath + [n]
  });

  it("ignores non-track record kinds entirely", () => {
    const records: ProvenanceRecord[] = [
      {
        kind: "mint",
        id: { templateHash: COORD.templateHash, ordinalPath: [0, 7], regionEpoch: COORD.regionEpoch },
        seq: 1,
        payloadHash: "payload-v0:0",
      },
    ];
    expect(nextTrackOrdinal(records, COORD)).toBe(0);
  });
});
