/**
 * LAW — Q12 aggregation (docs/PROVENANCE.md §5, round 2 A6's applicability table +
 * round 3 m4's path-scoped RLE; Q12's gate: standing +
 * aggregation rows (pure loop = O(1)+count observed)). This file is the LAW-FILE-
 * HOMED assertion of `store/aggregate.ts`'s properties — the SAME grain
 * `track-stream.law.test.ts`'s W3 block uses for Q11a/Q11b (direct, store-fake-
 * backed exercise, not through `region-scope.ts`'s real deciding-WHEN, which is a
 * later node's job). Detailed unit coverage of `foldRuns`/`unfoldRun`/
 * `AggregatingProvenanceStore` lives in `store/__tests__/aggregate.test.ts`; this
 * file states the three gate rows the plan names, once each, at law grain.
 *
 * Does NOT touch `track-stream.law.test.ts` — that file's remaining `it.todo` rows
 * (stream fold + monotonicity + fold-as-recovery, the I4 door) are Q13's sibling
 * concern this wave, not this node's.
 */
import { describe, expect, it } from "vitest";

import {
  AggregatingProvenanceStore,
  assertAggregatable,
  foldRuns,
  NeverAggregatable,
  unfoldRun,
  type AggregatableRecord,
} from "../../provenance/store/aggregate.js";
import { ProvenanceStoreFake, RunStoreFake } from "../../provenance/store/fakes.js";
import { appendOrdinal, ROOT_ORDINAL_PATH, type RecordId } from "../../provenance/store/ids.js";
import type { HostScheduleRecord, MintRecord, MuxDecisionRecord } from "../../provenance/store/records.js";

const REGION = "q12-law-region";
const TEMPLATE = "loop-body";
const EPOCH = "e0";
const PARENT = appendOrdinal(ROOT_ORDINAL_PATH, 0);

function idAt(ordinal: number): RecordId {
  return { templateHash: TEMPLATE, regionEpoch: EPOCH, ordinalPath: appendOrdinal(PARENT, ordinal) };
}

describe("Q12 aggregation (docs/PROVENANCE.md §5 A6, round-3 m4)", () => {
  it(
    "pure loop = O(1)+count observed: a stable-wiring loop of n iterations lands ONE " +
      "run record + a count through the write-side hook, not n records — true for n=3 " +
      "AND n=3000 alike, which is the O(1) claim (the run count grows, the RECORD COUNT " +
      "written to the base store never does)",
    async () => {
      for (const n of [3, 3000]) {
        const base = new ProvenanceStoreFake();
        const runs = new RunStoreFake();
        const store = new AggregatingProvenanceStore(base, runs);
        for (let i = 0; i < n; i++) {
          await store.append(REGION, { kind: "track-open", id: idAt(i), seq: i });
        }
        await store.flush(REGION);

        const baseStream = await base.readStream(REGION);
        const landedRuns = await runs.readRuns(REGION);
        expect(baseStream).toHaveLength(0);
        expect(landedRuns).toHaveLength(1);
        expect(landedRuns[0].count).toBe(n);
      }
    },
  );

  it(
    "losslessness — fold∘unfold = id on reads: the set of (kind, ordinalPath) an " +
      "AggregationRun's unfold answers with is EXACTLY the set its source records " +
      "carried, for every aggregatable kind (fan-instantiation, ingress-binding, " +
      "track-open, track-close), order-insensitive per §5 D4's counter-fold rule",
    () => {
      const kinds = ["fan-instantiation", "ingress-binding", "track-open", "track-close"] as const;
      for (const kind of kinds) {
        const source: AggregatableRecord[] =
          kind === "track-close"
            ? [0, 1, 2, 3].map((i) => ({ kind, id: idAt(i), seq: i, settled: true }))
            : [0, 1, 2, 3].map((i) => ({ kind, id: idAt(i), seq: i }) as AggregatableRecord);

        const { runs, unaggregated } = foldRuns(source);
        expect(unaggregated).toHaveLength(0);
        expect(runs).toHaveLength(1);

        const expanded = unfoldRun(runs[0]);
        const sourceOrdinals = source.map((r) => r.id.ordinalPath.at(-1)).toSorted((a, b) => (a ?? 0) - (b ?? 0));
        const expandedOrdinals = expanded.map((f) => f.id.ordinalPath.at(-1)).toSorted((a, b) => (a ?? 0) - (b ?? 0));
        expect(expandedOrdinals).toEqual(sourceOrdinals); // seq dropped by design
        expect(expanded).toHaveLength(source.length);
        for (const fact of expanded) expect(fact.kind).toBe(kind);
      }
    },
  );

  it(
    "the never-list — mint, mux-decision, host-schedule — is IMPOSSIBLE to fold: " +
      "assertAggregatable's runtime door throws NeverAggregatable for all three, and " +
      "the write-side hook never routes them into a run (they land in the base store, " +
      "one raw record per emission, exactly as before this node existed)",
    async () => {
      const mint: MintRecord = { kind: "mint", id: idAt(0), seq: 1, payloadHash: "payload-v0:x" };
      const mux: MuxDecisionRecord = { kind: "mux-decision", id: idAt(1), seq: 2, arm: 0 };
      const schedule: HostScheduleRecord = { kind: "host-schedule", id: idAt(2), seq: 3, triples: [] };

      for (const record of [mint, mux, schedule]) {
        expect(() => assertAggregatable(record)).toThrow(NeverAggregatable);
      }

      const base = new ProvenanceStoreFake();
      const runs = new RunStoreFake();
      const store = new AggregatingProvenanceStore(base, runs);
      await store.append(REGION, mint);
      await store.append(REGION, mux);
      await store.append(REGION, schedule);
      await store.flush(REGION);

      expect(await base.readStream(REGION)).toHaveLength(3); // all three, raw, untouched
      expect(await runs.readRuns(REGION)).toHaveLength(0); // NEVER absorbed into a run
    },
  );
});
