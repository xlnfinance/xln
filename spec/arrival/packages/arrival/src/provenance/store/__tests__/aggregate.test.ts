/**
 * aggregate.test.ts — Q12's own unit suite for `store/aggregate.ts`
 * (docs/PROVENANCE.md §5 A6 + round-3 m4). Direct
 * exercise of `foldRuns`/`unfoldRun` (the pure RLE core) and
 * `AggregatingProvenanceStore` (the write-side hook) against the store fakes —
 * this file is what flips `src/__tests__/provenance/aggregation.law.test.ts`'s
 * LAW-FILE-HOMED rows, same split as `emit.test.ts`/`track-stream.law.test.ts`.
 */
import { describe, expect, it } from "vitest";

import {
  AggregatingProvenanceStore,
  assertAggregatable,
  foldRuns,
  isAggregatableKind,
  NeverAggregatable,
  runKeyString,
  unfoldRun,
  type AggregatableRecord,
} from "../aggregate.js";
import { ProvenanceStoreFake, RunStoreFake } from "../fakes.js";
import { appendOrdinal, ROOT_ORDINAL_PATH, type RecordId } from "../ids.js";
import type { ProvenanceStore } from "../interfaces.js";
import type {
  FanInstantiationRecord,
  HostScheduleRecord,
  IngressBindingRecord,
  MintRecord,
  MuxDecisionRecord,
  TrackCloseRecord,
  TrackOpenRecord,
} from "../records.js";

const REGION = "agg-region";
const TEMPLATE = "t-loop";
const EPOCH = "e0";
const PARENT = appendOrdinal(ROOT_ORDINAL_PATH, 0); // one designated node's root ordinal

function idAt(ordinal: number): RecordId {
  return { templateHash: TEMPLATE, regionEpoch: EPOCH, ordinalPath: appendOrdinal(PARENT, ordinal) };
}

function fanAt(ordinal: number, seq: number): FanInstantiationRecord {
  return { kind: "fan-instantiation", id: idAt(ordinal), seq };
}

function ingressAt(ordinal: number, seq: number): IngressBindingRecord {
  return { kind: "ingress-binding", id: idAt(ordinal), seq };
}

function trackOpenAt(ordinal: number, seq: number): TrackOpenRecord {
  return { kind: "track-open", id: idAt(ordinal), seq };
}

function trackCloseAt(ordinal: number, seq: number, settled = true): TrackCloseRecord {
  return { kind: "track-close", id: idAt(ordinal), seq, settled };
}

describe("isAggregatableKind / assertAggregatable — the never-list boundary", () => {
  it("marks exactly the four §5 A6 aggregatable kinds true", () => {
    expect(isAggregatableKind("fan-instantiation")).toBe(true);
    expect(isAggregatableKind("ingress-binding")).toBe(true);
    expect(isAggregatableKind("track-open")).toBe(true);
    expect(isAggregatableKind("track-close")).toBe(true);
  });

  it("marks the never-list kinds — mint, mux-decision, host-schedule — false", () => {
    expect(isAggregatableKind("mint")).toBe(false);
    expect(isAggregatableKind("mux-decision")).toBe(false);
    expect(isAggregatableKind("host-schedule")).toBe(false);
  });

  it("assertAggregatable throws NeverAggregatable, by name, for each never-list kind", () => {
    const mint: MintRecord = { kind: "mint", id: idAt(0), seq: 1, payloadHash: "payload-v0:x" };
    const mux: MuxDecisionRecord = { kind: "mux-decision", id: idAt(0), seq: 1, arm: 0 };
    const schedule: HostScheduleRecord = { kind: "host-schedule", id: idAt(0), seq: 1, triples: [] };
    for (const record of [mint, mux, schedule]) {
      expect(() => assertAggregatable(record)).toThrow(NeverAggregatable);
      expect(() => assertAggregatable(record)).toThrow(/NEVER aggregatable/);
    }
  });

  it("assertAggregatable narrows/passes silently for an aggregatable-kind record", () => {
    expect(() => assertAggregatable(fanAt(0, 1))).not.toThrow();
  });
});

describe("foldRuns — path-scoped contiguous RLE", () => {
  it("folds a contiguous run of N same-key records into ONE run with count N", () => {
    const records: AggregatableRecord[] = [0, 1, 2, 3, 4].map((i) => fanAt(i, i + 1));
    const { runs, unaggregated } = foldRuns(records);
    expect(unaggregated).toHaveLength(0);
    expect(runs).toEqual([
      {
        kind: "fan-instantiation",
        templateHash: TEMPLATE,
        regionEpoch: EPOCH,
        parentOrdinalPath: PARENT,
        start: 0,
        count: 5,
      },
    ]);
  });

  it("a gap in ordinals breaks the run into two", () => {
    const records: AggregatableRecord[] = [fanAt(0, 1), fanAt(1, 2), fanAt(5, 3), fanAt(6, 4)];
    const { runs } = foldRuns(records);
    expect(runs).toHaveLength(2);
    expect(runs[0]).toMatchObject({ start: 0, count: 2 });
    expect(runs[1]).toMatchObject({ start: 5, count: 2 });
  });

  it("PATH-SCOPED (round-3 m4): different parent ordinal paths never merge, even with numerically-contiguous trailing ordinals", () => {
    const outerA = appendOrdinal(PARENT, 0); // outer loop's 0th instance
    const outerB = appendOrdinal(PARENT, 1); // outer loop's 1st instance
    const innerAt = (parent: readonly number[], ordinal: number, seq: number): IngressBindingRecord => ({
      kind: "ingress-binding",
      id: { templateHash: TEMPLATE, regionEpoch: EPOCH, ordinalPath: appendOrdinal(parent, ordinal) },
      seq,
    });
    // Inner loop restarts at ordinal 0 under EACH outer element — a naive
    // "contiguous ordinal" fold (ignoring parent) would wrongly chain outerA's
    // trailing ordinal into outerB's leading one.
    const records: AggregatableRecord[] = [
      innerAt(outerA, 0, 1),
      innerAt(outerA, 1, 2),
      innerAt(outerB, 0, 3),
      innerAt(outerB, 1, 4),
    ];
    const { runs } = foldRuns(records);
    expect(runs).toHaveLength(2);
    expect(runs[0]).toMatchObject({ parentOrdinalPath: outerA, start: 0, count: 2 });
    expect(runs[1]).toMatchObject({ parentOrdinalPath: outerB, start: 0, count: 2 });
  });

  it("a different kind at the same site breaks the run (kind is part of the key)", () => {
    const records: AggregatableRecord[] = [fanAt(0, 1), ingressAt(1, 2)];
    const { runs } = foldRuns(records);
    expect(runs).toHaveLength(2);
    expect(runs[0]).toMatchObject({ kind: "fan-instantiation", start: 0, count: 1 });
    expect(runs[1]).toMatchObject({ kind: "ingress-binding", start: 1, count: 1 });
  });

  it("track-open/track-close aggregate as counter deltas, independently keyed by kind", () => {
    const opens: AggregatableRecord[] = [0, 1, 2].map((i) => trackOpenAt(i, i + 1));
    const closes: AggregatableRecord[] = [0, 1, 2].map((i) => trackCloseAt(i, i + 4));
    const { runs, unaggregated } = foldRuns([...opens, ...closes]);
    expect(unaggregated).toHaveLength(0);
    expect(runs).toHaveLength(2);
    expect(runs.find((r) => r.kind === "track-open")).toMatchObject({ start: 0, count: 3 });
    expect(runs.find((r) => r.kind === "track-close")).toMatchObject({ start: 0, count: 3 });
  });

  it("a settled:false track-close is NEVER folded into a run — lands in unaggregated, breaking any open run at its key", () => {
    const records: AggregatableRecord[] = [trackCloseAt(0, 1), trackCloseAt(1, 2, false), trackCloseAt(2, 3)];
    const { runs, unaggregated } = foldRuns(records);
    expect(unaggregated).toEqual([trackCloseAt(1, 2, false)]);
    // ordinal 0 and ordinal 2 each land in their OWN run-of-one — the unsettled
    // record in between breaks contiguity, it does not get silently absorbed.
    expect(runs).toHaveLength(2);
    expect(runs[0]).toMatchObject({ start: 0, count: 1 });
    expect(runs[1]).toMatchObject({ start: 2, count: 1 });
  });

  it("runKeyString distinguishes kind/templateHash/regionEpoch/parentOrdinalPath independently", () => {
    const a = runKeyString({
      kind: "fan-instantiation",
      templateHash: "t1",
      regionEpoch: "e0",
      parentOrdinalPath: [0],
    });
    const b = runKeyString({ kind: "ingress-binding", templateHash: "t1", regionEpoch: "e0", parentOrdinalPath: [0] });
    const c = runKeyString({
      kind: "fan-instantiation",
      templateHash: "t2",
      regionEpoch: "e0",
      parentOrdinalPath: [0],
    });
    const d = runKeyString({
      kind: "fan-instantiation",
      templateHash: "t1",
      regionEpoch: "e1",
      parentOrdinalPath: [0],
    });
    const e = runKeyString({
      kind: "fan-instantiation",
      templateHash: "t1",
      regionEpoch: "e0",
      parentOrdinalPath: [1],
    });
    expect(new Set([a, b, c, d, e]).size).toBe(5);
  });
});

describe("unfoldRun — the losslessness law's witness", () => {
  it("fold∘unfold recovers the exact set of (kind, ordinalPath) pairs, order-insensitive", () => {
    const originalOrdinals = [3, 4, 5, 6];
    const records: AggregatableRecord[] = originalOrdinals.map((i) => fanAt(i, i));
    const { runs } = foldRuns(records);
    expect(runs).toHaveLength(1);
    const facts = unfoldRun(runs[0]);
    expect(facts.map((f) => f.id.ordinalPath[f.id.ordinalPath.length - 1]).toSorted((a, b) => a - b)).toEqual(
      originalOrdinals,
    );
    for (const fact of facts) {
      expect(fact.kind).toBe("fan-instantiation");
      expect(fact.id.templateHash).toBe(TEMPLATE);
      expect(fact.id.regionEpoch).toBe(EPOCH);
      expect(fact.settled).toBeUndefined(); // only track-close carries `settled`
    }
  });

  it("track-close runs unfold with settled: true on every instance — the only representable state", () => {
    const records: AggregatableRecord[] = [0, 1, 2].map((i) => trackCloseAt(i, i));
    const { runs } = foldRuns(records);
    const facts = unfoldRun(runs[0]);
    expect(facts).toHaveLength(3);
    for (const fact of facts) expect(fact.settled).toBe(true);
  });

  it("unfoldRun(run).length === run.count always", () => {
    const records: AggregatableRecord[] = [0, 1, 2, 3, 4, 5, 6].map((i) => ingressAt(i, i));
    const { runs } = foldRuns(records);
    expect(unfoldRun(runs[0])).toHaveLength(runs[0].count);
    expect(runs[0].count).toBe(7);
  });
});

describe("AggregatingProvenanceStore — the write-side hook", () => {
  it("O(1) writes: N contiguous aggregatable appends never touch the base store until flush, then land as ONE run", async () => {
    const base = new ProvenanceStoreFake();
    const runStore = new RunStoreFake();
    let baseAppendCalls = 0;
    const spiedBase: ProvenanceStore = {
      append: async (regionId, record) => {
        baseAppendCalls++;
        return base.append(regionId, record);
      },
      allocateSeq: (regionId) => base.allocateSeq(regionId),
      readStream: (regionId) => base.readStream(regionId),
      getHeader: (regionId) => base.getHeader(regionId),
      putHeader: (regionId, header) => base.putHeader(regionId, header),
    };
    const agg = new AggregatingProvenanceStore(spiedBase, runStore);

    const N = 500;
    for (let i = 0; i < N; i++) {
      await agg.append(REGION, fanAt(i, i));
    }
    // The whole point of the gate: N instances, ZERO raw writes so far.
    expect(baseAppendCalls).toBe(0);
    expect(await base.readStream(REGION)).toHaveLength(0);

    await agg.flush(REGION);

    // O(1) run records + a count — ONE run, count === N, not N records.
    const runs = await runStore.readRuns(REGION);
    expect(runs).toHaveLength(1);
    expect(runs[0].count).toBe(N);
    expect(baseAppendCalls).toBe(0); // flush never touches the raw-record store either
  });

  it("never-list kinds (mint/mux-decision/host-schedule) pass straight through to the base store, exactly once each, never buffered", async () => {
    const base = new ProvenanceStoreFake();
    const runStore = new RunStoreFake();
    const agg = new AggregatingProvenanceStore(base, runStore);

    const mint: MintRecord = { kind: "mint", id: idAt(0), seq: 1, payloadHash: "payload-v0:x" };
    const mux: MuxDecisionRecord = { kind: "mux-decision", id: idAt(1), seq: 2, arm: 0 };
    const schedule: HostScheduleRecord = { kind: "host-schedule", id: idAt(2), seq: 3, triples: [] };

    await agg.append(REGION, mint);
    await agg.append(REGION, mux);
    await agg.append(REGION, schedule);

    const stream = await base.readStream(REGION);
    expect(stream).toHaveLength(3);
    expect(stream.map((r) => r.kind).toSorted()).toEqual(["host-schedule", "mint", "mux-decision"]);
    expect(await runStore.readRuns(REGION)).toHaveLength(0); // never absorbed into a run
  });

  it("a run CLOSES (materializes) when a non-matching record breaks contiguity, without waiting for flush", async () => {
    const base = new ProvenanceStoreFake();
    const runStore = new RunStoreFake();
    const agg = new AggregatingProvenanceStore(base, runStore);

    await agg.append(REGION, fanAt(0, 1));
    await agg.append(REGION, fanAt(1, 2));
    await agg.append(REGION, fanAt(5, 3)); // gap — closes the first run, opens a new one
    await agg.flush(REGION);

    const runs = await runStore.readRuns(REGION);
    expect(runs).toHaveLength(2);
    expect(runs.find((r) => r.start === 0)).toMatchObject({ count: 2 });
    expect(runs.find((r) => r.start === 5)).toMatchObject({ count: 1 });
  });

  it("readStream stays byte-for-byte the base store's contract — untouched by aggregation for non-aggregatable kinds", async () => {
    const base = new ProvenanceStoreFake();
    const runStore = new RunStoreFake();
    const agg = new AggregatingProvenanceStore(base, runStore);
    const mint: MintRecord = { kind: "mint", id: idAt(0), seq: 1, payloadHash: "payload-v0:x" };
    await agg.append(REGION, mint);
    expect(await agg.readStream(REGION)).toEqual(await base.readStream(REGION));
  });

  it("an unsettled (settled:false) track-close is written straight through, never buffered into a run", async () => {
    const base = new ProvenanceStoreFake();
    const runStore = new RunStoreFake();
    const agg = new AggregatingProvenanceStore(base, runStore);

    await agg.append(REGION, trackCloseAt(0, 1)); // settled:true — buffered
    await agg.append(REGION, trackCloseAt(1, 2, false)); // settled:false — straight through, closes the open run
    await agg.flush(REGION);

    expect(await base.readStream(REGION)).toEqual([trackCloseAt(1, 2, false)]);
    const runs = await runStore.readRuns(REGION);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ kind: "track-close", start: 0, count: 1 });
  });
});
