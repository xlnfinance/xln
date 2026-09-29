/**
 * A synthetic driver reproducing docs/PROVENANCE.md Appendix A's reference
 * workload SHAPE ("~1000 SLOC agent-shaped program — 30 rosetta calls, 5 fans over
 * 100/500/1k/5k/10k elements (Σ≈16.6k), 3 loops to 10⁴, one nested map (10k×10)").
 *
 * A "synthetic program" here means the SAME idiom `provenance-emit.bench.test.ts`
 * already established — driving `store/emit.ts`'s real emission core directly
 * against real stores, not hand-parsing 1000 lines of Scheme source through the
 * interpreter. Every category below cites the exact Appendix A row it stands in
 * for, so the arithmetic is traceable, not invented.
 *
 * ── A.2's categories, and how this file realizes each one ─────────────────────────
 *
 *  "30 rosetta calls" — 30 `trackOpen → mint(≈500B) → trackClose` triples: a small
 *  agent-tool-call baseline, distinct templateHash per call (real rosetta call sites
 *  are distinct static positions), negligible payload volume.
 *
 *  "5 fans over 100/500/1k/5k/10k elements (Σ≈16.6k)" — A.1's "Fan/track records:
 *  Σ16.6k × ~3 records × ~64B ≈ 2.5MB; pressure" / A.2's fix: "RLE aggregation...
 *  active." Each fan emits `fan-instantiation` + `ingress-binding` records over
 *  STABLE wiring (one templateHash per fan, contiguous ordinals 0..N-1) through
 *  `AggregatingProvenanceStore` — §4's record-kinds table marks both kinds
 *  aggregatable, so the raw Σ33.2k facts (2 kinds × Σ16.6k) fold to exactly 10
 *  `AggregationRun`s (2 kinds × 5 fans), O(1)+count each, never N raw appends to
 *  the base store.
 *
 *  "3 loops to 10⁴" — SPLIT per A.1's own two DIFFERENT arithmetic rows, because a
 *  "loop" is not one shape:
 *    - 2 PURE loops: stable-wiring `ingress-binding` runs, 10⁴ each — A.1's "Loop
 *      records (no RLE) ... 6MB; fixed by aggregation." Folds to 2 runs.
 *    - 1 AGENT loop: a `MintRecord` payload (≈2KB) per iteration, 10⁴ iterations —
 *      A.1/A.2's "Mint payloads: ... 10⁴-iteration agent loop @2KB ≈ 20MB —
 *      IRREDUCIBLE INFORMATION, governed by tiering." Mints NEVER aggregate
 *      (§4's record-kinds table, never-list); this is the category that actually
 *      stresses the ring/tier budget, by design.
 *
 *  "one nested map (10k×10)" — A.1's "nested map +10⁵ tracks ≈ +15MB worst case
 *  pressure." §4: "aggregation runs are PATH-SCOPED... inner-loop/fan ordinals
 *  restart per outer element, so runs never span parents." Realized faithfully:
 *  10⁴ OUTER iterations, each opening its OWN inner `ingress-binding` run of count
 *  10 (a fresh `parentOrdinalPath` per outer element) — 10⁵ raw facts folding to
 *  10⁴ small runs, NOT one giant run. This is intentionally the category that
 *  demonstrates aggregation's LIMIT (many small runs, not one O(1) run) as
 *  honestly as its bulk win elsewhere.
 *
 *  Mux decisions — A.1's "10⁴–10⁵ recorded, pure noise" is the pre-mux-collapse
 *  number; A.2's own fix is the mux-collapse rule (§1: only PORT-COUPLED muxes are
 *  ever recorded, a pure-selector mux collapses into its wire and is never
 *  recorded). This workload therefore emits a SMALL, bounded number of
 *  port-coupled mux decisions (never aggregated, per §4's record-kinds table) —
 *  demonstrating the fix by construction, not by asserting a large number away.
 *
 * ── Ring/tiering wiring ─────────────────────────────────────────────────────────
 * Mint payloads (rosetta + agent-loop) land RING-resident first
 * (`PayloadTierMachine.ringPut`), then flush to the durable `PayloadStore` once the
 * harness's own FIFO-by-byte-cap policy exceeds `ringCapBytes` (§4's payload-tiering
 * list: "ring cap (~4-8MB, configurable)"; §4's real flush policy is "AT PORTS" —
 * this harness's simple oldest-first-over-cap policy is a reasonable stand-in for a
 * benchmark driver, not a re-implementation of the port-boundary trigger, which is
 * a separate concern this file does not take on).
 */
// `store/index.js` is now a CURATED studio read-slice (type-only — see that module's own
// header); the fakes/aggregation/tiering runtime values live at their own leaf modules, same
// import shape as the sibling `provenance-emit.bench.test.ts` / gate-suite `q16-harness.ts`.
import { AggregatingProvenanceStore } from "../../provenance/store/aggregate.js";
import { emitMuxDecision, setEmissionEnabled } from "../../provenance/store/emit.js";
import { PayloadStoreFake, ProvenanceStoreFake, RunStoreFake } from "../../provenance/store/fakes.js";
import type { PayloadHash, RegionId } from "../../provenance/store/ids.js";
import type { ProvenanceRecord } from "../../provenance/store/records.js";
import { PayloadTierMachine, type PayloadEvidenceEnvelope } from "../../provenance/store/tiering.js";

// ─────────────────────────────────────────────────────────────────────────────
// The reference workload's own SHAPE — every field cites its Appendix A row.
// ─────────────────────────────────────────────────────────────────────────────

export const WORKLOAD_SHAPE = {
  /** A.2 intro: "30 rosetta calls." */
  rosettaCalls: 30,
  rosettaPayloadBytes: 500,
  /** A.2 intro: "5 fans over 100/500/1k/5k/10k elements (Σ≈16.6k)." */
  fanSizes: [100, 500, 1000, 5000, 10000] as const,
  /** A.1's "Loop records (no RLE)... fixed by aggregation" — the 2 PURE loops of
   *  the "3 loops to 10⁴" row. */
  pureLoopCount: 2,
  pureLoopIterations: 10_000,
  /** A.1/A.2's "Mint payloads: ... 10⁴-iteration agent loop @2KB ≈ 20MB —
   *  irreducible information, governed by tiering" — the 3rd of the "3 loops." */
  agentLoopIterations: 10_000,
  agentLoopPayloadBytes: 2 * 1024,
  /** A.2 intro: "one nested map (10k×10)." */
  nestedOuter: 10_000,
  nestedInner: 10,
  /** A.2's pure-mux-collapse fix: a SMALL, bounded number of port-coupled
   *  decisions, not the pre-amendment 10⁴–10⁵ (see module doc). */
  portCoupledMuxDecisions: 128,
} as const;

export const DEFAULT_RING_CAP_BYTES = 6 * 1024 * 1024; // "~4-8MB, configurable" (§4's payload-tiering list, point 1)

// ─────────────────────────────────────────────────────────────────────────────
// Byte estimation — same idiom as `store/fakes.ts`'s own `estimateSizeBytes` (a
// fault-injection/accounting convenience, never correctness-load-bearing), kept as
// a separate small copy for the same "this leaf has no reason to import a private
// helper" reason `store/emit.ts`'s `hashPayload` states for its own FNV copy.
// ─────────────────────────────────────────────────────────────────────────────

export function estimateBytes(value: unknown): number {
  try {
    return JSON.stringify(value)?.length ?? 0;
  } catch {
    return String(value).length;
  }
}

/** A payload's content-hash — a small hand-rolled FNV-1a, the SAME idiom
 *  `store/emit.ts`'s private `hashPayload` uses (this harness cannot import that
 *  private function, and has no reason to depend on the module for four lines of
 *  math — see this repo's own established idiom for exactly this situation). */
function hashOf(templateHash: string, ordinal: number, value: unknown): PayloadHash {
  const tagged = `${templateHash}#${ordinal}:${estimateBytes(value)}`;
  let h = 0x81_1c_9d_c5;
  for (let i = 0; i < tagged.length; i++) {
    h ^= tagged.codePointAt(i) ?? 0;
    h = Math.imul(h, 0x01_00_01_93);
  }
  return `bench-payload-v0:${(h >>> 0).toString(16).padStart(8, "0")}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// The harness — bundles every store/machine layer the workload drives.
// ─────────────────────────────────────────────────────────────────────────────

export interface WorkloadHarness {
  readonly base: ProvenanceStoreFake;
  readonly runs: RunStoreFake;
  readonly aggregating: AggregatingProvenanceStore;
  readonly payloadStore: PayloadStoreFake;
  readonly tierMachine: PayloadTierMachine;
  readonly regionId: RegionId;
  readonly ringCapBytes: number;
  /** Bytes currently ring-resident (this harness's own accounting — the "in-memory
   *  hot layer" of §4's payload-tiering list, point 1 — `PayloadTierMachine` does
   *  not expose a byte total of its own, so the harness tracks alongside every
   *  `ringPut`/`flush` call). */
  ringBytesResident: number;
  /** Cumulative bytes moved past the ring into the durable store (§4: in a real
   *  deployment these live in DO storage/R2, off V8 heap — the fakes retain them in
   *  an in-memory `Map` regardless, a KNOWN fakes limitation this benchmark reports
   *  on explicitly rather than papering over). */
  flushedBytesTotal: number;
  /** FIFO order of ring-resident hashes, oldest first — the harness's simple
   *  over-cap eviction policy (module doc: "oldest-first-over-cap... a reasonable
   *  stand-in for a benchmark driver"). */
  readonly ringOrder: { hash: PayloadHash; bytes: number }[];
}

export function createWorkloadHarness(
  regionId: RegionId = "provenance-budget-workload",
  ringCapBytes: number = DEFAULT_RING_CAP_BYTES,
): WorkloadHarness {
  const base = new ProvenanceStoreFake();
  const runs = new RunStoreFake();
  const payloadStore = new PayloadStoreFake();
  return {
    base,
    runs,
    aggregating: new AggregatingProvenanceStore(base, runs),
    payloadStore,
    tierMachine: new PayloadTierMachine(payloadStore),
    regionId,
    ringCapBytes,
    ringBytesResident: 0,
    flushedBytesTotal: 0,
    ringOrder: [],
  };
}

/** Land one mint through the ring-first pipeline (§4's payload-tiering list, points 1-2), then enforce
 *  the ring's byte cap by flushing the OLDEST resident payloads until back under
 *  budget. Returns the record's `payloadHash` (for later tier-honesty reads). */
async function mintThroughRing(
  h: WorkloadHarness,
  templateHash: string,
  ordinal: number,
  value: unknown,
  stampIds: readonly number[],
): Promise<PayloadHash> {
  const hash = hashOf(templateHash, ordinal, value);
  const bytes = estimateBytes(value);
  h.tierMachine.ringPut(hash, { value, stampIds });
  h.ringBytesResident += bytes;
  h.ringOrder.push({ hash, bytes });

  const seq = await h.aggregating.allocateSeq(h.regionId);
  const record: ProvenanceRecord = {
    kind: "mint",
    id: { templateHash, ordinalPath: [ordinal], regionEpoch: "e0" },
    seq,
    payloadHash: hash,
  };
  await h.aggregating.append(h.regionId, record);

  while (h.ringBytesResident > h.ringCapBytes && h.ringOrder.length > 0) {
    const oldest = h.ringOrder.shift();
    if (oldest === undefined) break;
    await h.tierMachine.flush(oldest.hash);
    h.ringBytesResident -= oldest.bytes;
    h.flushedBytesTotal += oldest.bytes;
  }
  return hash;
}

/** One aggregatable run's raw facts, driven directly through the harness's
 *  `AggregatingProvenanceStore` so the store's own write-side aggregation hook
 *  folds them — this function does not fold anything itself, it only emits the
 *  raw per-ordinal appends the hook observes. */
async function emitAggregatableRun(
  h: WorkloadHarness,
  kind: "fan-instantiation" | "ingress-binding" | "track-open" | "track-close",
  templateHash: string,
  parentOrdinalPath: readonly number[],
  count: number,
): Promise<void> {
  for (let i = 0; i < count; i++) {
    const seq = await h.aggregating.allocateSeq(h.regionId);
    const id = { templateHash, ordinalPath: [...parentOrdinalPath, i], regionEpoch: "e0" };
    let record: ProvenanceRecord;
    switch (kind) {
      case "fan-instantiation":
        record = { kind, id, seq };
        break;
      case "ingress-binding":
        record = { kind, id, seq };
        break;
      case "track-open":
        record = { kind, id, seq };
        break;
      case "track-close":
        record = { kind, id, seq, settled: true };
        break;
    }
    await h.aggregating.append(h.regionId, record);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// The report — counts + sampled hashes a benchmark asserts against.
// ─────────────────────────────────────────────────────────────────────────────

export interface WorkloadReport {
  readonly regionId: RegionId;
  readonly counts: {
    readonly rosettaCalls: number;
    readonly fanRawFacts: number;
    readonly fanRuns: number;
    readonly pureLoopRawFacts: number;
    readonly pureLoopRuns: number;
    readonly agentLoopMints: number;
    readonly nestedOuterIterations: number;
    readonly nestedInnerRawFacts: number;
    readonly nestedRuns: number;
    readonly muxDecisions: number;
  };
  readonly sampleMintHashes: {
    readonly rosetta: readonly PayloadHash[];
    readonly agentLoop: readonly PayloadHash[];
  };
  readonly ringBytesResidentFinal: number;
  readonly flushedBytesTotal: number;
}

/** Drive the FULL Appendix A.2 reference workload through `harness`. Returns a
 *  report of what was emitted — every count traceable to a WORKLOAD_SHAPE field,
 *  every field traceable to an Appendix A row (module doc). Mints route through
 *  the ring/tier pipeline; the four aggregatable kinds route through
 *  `AggregatingProvenanceStore`; mux decisions (never-list) route through the real
 *  `emitMuxDecision` (the flag-gated emission core — this function flips the flag
 *  ON for its own extent, restoring it in `finally`). */
export async function runReferenceWorkload(h: WorkloadHarness): Promise<WorkloadReport> {
  setEmissionEnabled(true);
  try {
    // ── 30 rosetta calls: trackOpen → mint(≈500B) → trackClose ──────────────
    const rosettaHashes: PayloadHash[] = [];
    for (let i = 0; i < WORKLOAD_SHAPE.rosettaCalls; i++) {
      const templateHash = `rosetta-${i}`;
      await emitAggregatableRun(h, "track-open", templateHash, [], 1);
      const hash = await mintThroughRing(h, templateHash, 0, "x".repeat(WORKLOAD_SHAPE.rosettaPayloadBytes), [i]);
      rosettaHashes.push(hash);
      await emitAggregatableRun(h, "track-close", templateHash, [], 1);
    }
    // Flush here — each rosetta call's trackOpen/trackClose is its own natural
    // "port" (§4: "flush AT PORTS... durability boundaries coincide with
    // meaning boundaries"), so this category's runs close before the fan
    // category opens its own (never mixed into one combined delta below).
    await h.aggregating.flush(h.regionId);
    const runsAfterRosetta = (await h.runs.readRuns(h.regionId)).length;

    // ── 5 fans over 100/500/1k/5k/10k, Σ≈16.6k, RLE-aggregated ──────────────
    let fanRawFacts = 0;
    for (const [fanIndex, size] of WORKLOAD_SHAPE.fanSizes.entries()) {
      const templateHash = `fan-${fanIndex}`;
      await emitAggregatableRun(h, "fan-instantiation", templateHash, [], size);
      await emitAggregatableRun(h, "ingress-binding", templateHash, [], size);
      fanRawFacts += size * 2;
    }
    await h.aggregating.flush(h.regionId);
    const runsAfterFans = (await h.runs.readRuns(h.regionId)).length;
    const fanRuns = runsAfterFans - runsAfterRosetta;

    // ── 2 pure loops to 10⁴: stable-wiring ingress-binding, aggregated ──────
    for (let loopIndex = 0; loopIndex < WORKLOAD_SHAPE.pureLoopCount; loopIndex++) {
      const templateHash = `pure-loop-${loopIndex}`;
      await emitAggregatableRun(h, "ingress-binding", templateHash, [], WORKLOAD_SHAPE.pureLoopIterations);
    }
    await h.aggregating.flush(h.regionId);
    const runsAfterPureLoops = (await h.runs.readRuns(h.regionId)).length;
    const pureLoopRuns = runsAfterPureLoops - runsAfterFans;
    const pureLoopRawFacts = WORKLOAD_SHAPE.pureLoopCount * WORKLOAD_SHAPE.pureLoopIterations;

    // ── 1 agent loop to 10⁴: mint (≈2KB) per iteration — IRREDUCIBLE ────────
    const agentLoopHashes: PayloadHash[] = [];
    const agentTemplateHash = "agent-loop";
    for (let i = 0; i < WORKLOAD_SHAPE.agentLoopIterations; i++) {
      const hash = await mintThroughRing(h, agentTemplateHash, i, "y".repeat(WORKLOAD_SHAPE.agentLoopPayloadBytes), [
        1000 + i,
      ]);
      // Sample sparsely (every 500th) — enough for tier-honesty spot checks
      // without retaining a 10⁴-entry hash array of our own.
      if (i % 500 === 0) agentLoopHashes.push(hash);
    }

    // ── one nested map (10k×10): path-scoped, runs never span parents ──────
    const nestedTemplateHash = "nested-map-inner";
    for (let outer = 0; outer < WORKLOAD_SHAPE.nestedOuter; outer++) {
      await emitAggregatableRun(h, "ingress-binding", nestedTemplateHash, [outer], WORKLOAD_SHAPE.nestedInner);
    }
    await h.aggregating.flush(h.regionId);
    const runsAfterNested = (await h.runs.readRuns(h.regionId)).length;
    const nestedRuns = runsAfterNested - runsAfterPureLoops;
    const nestedInnerRawFacts = WORKLOAD_SHAPE.nestedOuter * WORKLOAD_SHAPE.nestedInner;

    // ── port-coupled mux decisions — A.2's pure-mux-collapse fix (bounded) ──
    for (let i = 0; i < WORKLOAD_SHAPE.portCoupledMuxDecisions; i++) {
      await emitMuxDecision({
        store: h.aggregating,
        regionId: h.regionId,
        id: { templateHash: "port-coupled-mux", ordinalPath: [i], regionEpoch: "e0" },
        arm: i % 2,
      });
    }

    return {
      regionId: h.regionId,
      counts: {
        rosettaCalls: WORKLOAD_SHAPE.rosettaCalls,
        fanRawFacts,
        fanRuns,
        pureLoopRawFacts,
        pureLoopRuns,
        agentLoopMints: WORKLOAD_SHAPE.agentLoopIterations,
        nestedOuterIterations: WORKLOAD_SHAPE.nestedOuter,
        nestedInnerRawFacts,
        nestedRuns,
        muxDecisions: WORKLOAD_SHAPE.portCoupledMuxDecisions,
      },
      sampleMintHashes: { rosetta: rosettaHashes, agentLoop: agentLoopHashes },
      ringBytesResidentFinal: h.ringBytesResident,
      flushedBytesTotal: h.flushedBytesTotal,
    };
  } finally {
    setEmissionEnabled(false);
  }
}

/** The "store's own accounting" of in-memory record/run METADATA volume — real
 *  serialized byte sizes (not a guessed constant; A.1's own "~64B" is itself an
 *  estimate this function can be compared against), summed over the raw stream +
 *  compacted runs currently held by `h.base`/`h.runs`. Deliberately EXCLUDES
 *  `h.payloadStore`'s own backing `Map` — the module doc's documented exclusion:
 *  once a payload is flushed past the ring, a REAL deployment's bytes live in DO
 *  storage/R2, off V8 heap; `PayloadStoreFake` retains them anyway (a fakes
 *  limitation, not a production behavior) — see `provenance-budget.bench.test.ts`'s
 *  memory-budget test for the complementary raw `process.memoryUsage()` cross-check,
 *  which DOES include that retained volume, and the gap between the two numbers
 *  this implies. */
export async function storeMetadataBytes(h: WorkloadHarness): Promise<{ recordBytes: number; runBytes: number }> {
  const stream = await h.base.readStream(h.regionId);
  const runsList = await h.runs.readRuns(h.regionId);
  let recordBytes = 0;
  for (const r of stream) recordBytes += estimateBytes(r);
  let runBytes = 0;
  for (const r of runsList) runBytes += estimateBytes(r);
  return { recordBytes, runBytes };
}

export async function readPayloadEnvelope(h: WorkloadHarness, hash: PayloadHash): Promise<PayloadEvidenceEnvelope> {
  return h.tierMachine.read(hash);
}
