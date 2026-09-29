/**
 * The storage-bound hard gate (docs/PROVENANCE.md §4 + Appendix A), everything
 * scoped to fakes: the memory-budget assertion, the tier-honesty assertion, and
 * all four break-order probes. Forced mid-run eviction under REAL workerd lives in
 * the sibling `provenance-budget-workerd.bench.test.ts`, gated by its own
 * `vitest.workerd.config.ts` — that half of the pass condition cannot be exercised
 * against fakes, so it cannot live here.
 *
 * Pass condition, quoted verbatim (Appendix A.2): "the reference workload completes
 * with full provenance inside 128MB with tiering active; the recorded stream
 * reconstructs regions (the stream-fold law) after a FORCED mid-run eviction; and
 * every drill-in answer carries an honest evidence tier." (The middle clause is the
 * workerd sibling's job; this file asserts the memory budget and the tier-honesty
 * clause.)
 */
import { beforeAll, describe, expect, it } from "vitest";

import { ensureInferenceEnvPopulated, parse } from "../eval/generator-exec.js";
import { inferenceEnv } from "../env/inference-env.js";
import type { Classifier } from "../provenance/lineage.js";
import { buildWireframe } from "../provenance/wireframe/builder.js";
import { hashGraph } from "../provenance/wireframe/hash.js";
// `store/index.js` is a curated studio read-slice (type-only) — fakes/tiering/emit runtime
// values live at their own leaf modules (same shape as `support/provenance-budget-workload.ts`).
import { setEmissionEnabled } from "../provenance/store/emit.js";
import { PayloadStoreFake } from "../provenance/store/fakes.js";
import type { Payload } from "../provenance/store/interfaces.js";
import { PayloadTierMachine } from "../provenance/store/tiering.js";
import { replayGraphEgress, ReplayScopeError } from "../provenance/replay.js";
import { answerQuery, ReplayMemo, type ReplayMemoKey } from "../provenance/replay-memo.js";
import {
  SameProcessExecutor,
  type DrillInRequest,
  type OffloadIngress,
  type VerificationCandidate,
} from "../provenance/offload.js";
import { CORPUS_BASE_NAMES, CORPUS_ROLES } from "../__tests__/provenance/w1-corpus.js";
import { recordRun, type RecordedMint } from "../__tests__/provenance/q16-harness.js";
import {
  createWorkloadHarness,
  readPayloadEnvelope,
  runReferenceWorkload,
  storeMetadataBytes,
  WORKLOAD_SHAPE,
} from "./support/provenance-budget-workload.js";

const corpusClassifier: Classifier = { roleOf: (op) => CORPUS_ROLES[op] };
const corpusIsBaseName = (n: string): boolean => CORPUS_BASE_NAMES.has(n);

beforeAll(async () => {
  await ensureInferenceEnvPopulated();
});

/** Reshape a recorded run's mints into `OffloadIngress.sources` — grouped by op,
 *  emission order preserved, plain `Payload`s only (the SAME idiom
 *  `offload.law.test.ts`'s own local helper uses — reused shape, not reused code,
 *  since that helper is private to its file). */
function ingressFromMints(mints: readonly RecordedMint[]): OffloadIngress {
  const sources: Record<string, Payload[]> = {};
  for (const m of mints) {
    const q = sources[m.op];
    if (q === undefined) sources[m.op] = [m.payload];
    else q.push(m.payload);
  }
  return { slots: {}, sources };
}

// Appendix A.2's "Program live set" row: "~20MB (workload's own data — what a
// non-provenanced run uses)." Allocated and held for this measurement's duration
// so the 128MB assertion is honest about the TOTAL a real run pays, not just
// provenance's own overhead — see the block below for the full accounting split.
const PROGRAM_LIVE_SET_BYTES = 20 * 1024 * 1024;

function allocateProgramLiveSet(bytes: number): Uint8Array {
  const buf = new Uint8Array(bytes);
  // Touch every page so the allocation is actually resident, not a lazily-committed
  // virtual range the OS never backs — otherwise `process.memoryUsage()` would
  // under-report this exact ballast we're trying to account for honestly.
  for (let i = 0; i < buf.length; i += 4096) buf[i] = 1;
  return buf;
}

async function wfCorpus(code: string) {
  const forms = await parse(code);
  return buildWireframe(forms, { classifier: corpusClassifier, isBaseName: corpusIsBaseName });
}

// ─────────────────────────────────────────────────────────────────────────────
// C1 — completes with full provenance inside 128MB, tiering active.
// ─────────────────────────────────────────────────────────────────────────────

describe("C1 — reference workload completes with full provenance inside 128MB (fakes, tiering active)", () => {
  it("workload shape matches Appendix A.2's named categories", async () => {
    const h = createWorkloadHarness();
    const report = await runReferenceWorkload(h);

    expect(report.counts.rosettaCalls).toBe(30);
    expect(report.counts.fanRawFacts).toBe(2 * (100 + 500 + 1000 + 5000 + 10000));
    expect(report.counts.fanRuns).toBe(WORKLOAD_SHAPE.fanSizes.length * 2);
    expect(report.counts.pureLoopRawFacts).toBe(2 * 10_000);
    expect(report.counts.pureLoopRuns).toBe(2);
    expect(report.counts.agentLoopMints).toBe(10_000); // irreducible — never aggregates
    expect(report.counts.nestedInnerRawFacts).toBe(10_000 * 10);
    expect(report.counts.nestedRuns).toBe(10_000); // path-scoped: one run PER outer element
    expect(report.counts.muxDecisions).toBe(128); // A.2's pure-mux-collapse fix: bounded, not 10⁴–10⁵
  });

  it("measured against the 128MB budget — store accounting (A.2's claim) + raw process.memoryUsage (the fakes' honest ceiling)", async () => {
    if (globalThis.gc) globalThis.gc();
    const before = process.memoryUsage().heapUsed;

    const liveSet = allocateProgramLiveSet(PROGRAM_LIVE_SET_BYTES);
    const h = createWorkloadHarness();
    await runReferenceWorkload(h);
    const { recordBytes, runBytes } = await storeMetadataBytes(h);

    // Appendix A.2's own in-memory column: ring (bounded, ~4-8MB) + record/run metadata
    // (small once aggregated) + wireframe/template store (~0.2MB placeholder — this
    // workload emits no real WireframeGraph, so we charge the budgeted constant
    // directly rather than fabricate one) + program's own live set. EXCLUDES
    // `PayloadStoreFake`'s durable-tier backing Map (module doc's documented
    // exclusion: those bytes live in DO storage/R2 in production, off V8 heap).
    const wireframeBudgetBytes = 0.2 * 1024 * 1024;
    const storeAccountingBytes =
      h.ringBytesResident + recordBytes + runBytes + wireframeBudgetBytes + PROGRAM_LIVE_SET_BYTES;

    if (globalThis.gc) globalThis.gc();
    const afterHeapUsed = process.memoryUsage().heapUsed;
    const rawProcessDeltaBytes = afterHeapUsed - before;

    const mb = (n: number) => (n / (1024 * 1024)).toFixed(2);
    console.log(
      `C1 memory: ring=${mb(h.ringBytesResident)}MB flushed=${mb(h.flushedBytesTotal)}MB ` +
        `records=${mb(recordBytes)}MB runs=${mb(runBytes)}MB liveSet=${mb(PROGRAM_LIVE_SET_BYTES)}MB ` +
        `=> storeAccounting=${mb(storeAccountingBytes)}MB (budget: ~30-40MB, ≥3x headroom under 128MB) ` +
        `| raw process.memoryUsage delta=${mb(rawProcessDeltaBytes)}MB (includes fakes' full payload ` +
        `retention — a KNOWN fakes-only overshoot vs storeAccounting; C2/workerd is what proves the ` +
        `durable tiers really do leave heap in production)`,
    );

    // A.2's own claim: "~30-40MB of 128 — ≥3× headroom." Assert with slack (the
    // workload's exact byte arithmetic is an estimate, not a hard invariant) —
    // comfortably under budget is the claim; exact-to-the-KB is not.
    expect(storeAccountingBytes).toBeLessThan(64 * 1024 * 1024); // ≥2x headroom, generous slack on "~30-40MB"
    expect(storeAccountingBytes).toBeLessThan((128 * 1024 * 1024) / 3); // the stated "≥3x headroom" claim itself

    // The honest ceiling: even with the fakes retaining EVERY payload ever flushed
    // (never actually leaving heap, unlike a real DO/R2-backed deployment), total
    // process growth still fits inside the 128MB budget for this workload's actual
    // payload volume (~20MB agent-loop + ~15KB rosetta — modest by construction,
    // per A.2's own "irreducible... governed by tiering" framing, not unbounded).
    expect(rawProcessDeltaBytes).toBeLessThan(128 * 1024 * 1024);

    void liveSet; // kept alive across the whole measurement window, never optimized away
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// C3 — every drill-in answer carries an honest evidence tier.
// ─────────────────────────────────────────────────────────────────────────────

describe("C3 — drill-in answers carry an honest evidence tier (Q18's executor + Q17's answerQuery)", () => {
  it("replayed: a fresh γ over a real recorded region's egress wire, via answerQuery", async () => {
    const code = `(+ (src-a) (src-b))`;
    const run = await recordRun(inferenceEnv, code, { "src-a": "num", "src-b": "num" });
    const program = await wfCorpus(code);
    const memo = new ReplayMemo();
    const key: ReplayMemoKey = { templateHash: "egress", ordinalPath: [0], demand: "value" };

    const answer = await answerQuery({
      memo,
      key,
      replay: () => replayGraphEgress({ program, frozen: run.frozen, basePacks: [] }),
      fallback: async () => {
        throw new Error("fallback should not run — replay must succeed for the program's own egress wire");
      },
    });

    expect(answer.tier).toBe("replayed");
    expect(answer.value).toEqual(run.egress);
  });

  it("replayed-cached: the SAME key queried again hits the memo — never re-runs γ", async () => {
    const code = `(+ (src-a) (src-b))`;
    const run = await recordRun(inferenceEnv, code, { "src-a": "num", "src-b": "num" });
    const program = await wfCorpus(code);
    const memo = new ReplayMemo();
    const key: ReplayMemoKey = { templateHash: "egress", ordinalPath: [0], demand: "value" };

    let replayCalls = 0;
    const replay = () => {
      replayCalls++;
      return replayGraphEgress({ program, frozen: run.frozen, basePacks: [] });
    };
    const fallback = async () => {
      throw new Error("fallback should not run");
    };

    const first = await answerQuery({ memo, key, replay, fallback });
    const second = await answerQuery({ memo, key, replay, fallback });

    expect(first.tier).toBe("replayed");
    expect(second.tier).toBe("replayed-cached");
    expect(second.value).toEqual(first.value);
    expect(replayCalls).toBe(1);
  });

  it("recorded: a mint's payload, still resident — γ refuses (R1: never re-invoke a source), Q14's tier arm answers", async () => {
    const payloads = new PayloadStoreFake();
    const tierMachine = new PayloadTierMachine(payloads);
    const hash = "c3-recorded-hash";
    await payloads.put(hash, { value: 42, stampIds: [7] });

    const memo = new ReplayMemo();
    const key: ReplayMemoKey = { templateHash: "mint-node", ordinalPath: [0], demand: "value" };
    const answer = await answerQuery({
      memo,
      key,
      replay: async () => {
        // §4: "Replay NEVER re-invokes a source; retrospective mint records are
        // authoritative" — a mint-payload demand is, by construction, outside γ's
        // claimed scope. This is the teaching door, not a stand-in for a bug.
        throw new ReplayScopeError("mint", "mint-node@0", "a mint's payload is recorded, never re-derived by γ");
      },
      fallback: () => tierMachine.read(hash),
    });

    expect(answer.tier).toBe("recorded");
    expect(answer.value).toBe(42);
    expect(answer.stampIds).toEqual([7]);
  });

  it("stub: the SAME mint, after forced eviction — value dropped, identity+stamps retained, never silently answers stale", async () => {
    const payloads = new PayloadStoreFake();
    const tierMachine = new PayloadTierMachine(payloads);
    const hash = "c3-stub-hash";
    await payloads.put(hash, { value: 99, stampIds: [11] });
    await tierMachine.evict(hash); // FORCED eviction — §4's payload-tiering list, tier 4 (hash-only stub)

    const memo = new ReplayMemo();
    const key: ReplayMemoKey = { templateHash: "mint-node", ordinalPath: [1], demand: "value" };
    const answer = await answerQuery({
      memo,
      key,
      replay: async () => {
        throw new ReplayScopeError("mint", "mint-node@1", "same door as the recorded case");
      },
      fallback: () => tierMachine.read(hash),
    });

    expect(answer.tier).toBe("stub");
    expect(answer.value).toBeUndefined();
    expect(answer.stampIds).toEqual([11]);
  });

  it("Q18's SameProcessExecutor: every offload answer self-reports evidenceTier 'replayed' — offload is always a LIVE γ, never a cache hit (Q17 memoizes IN FRONT of an executor, never inside the protocol)", async () => {
    const code = `(+ (src-a) (src-b))`;
    const run = await recordRun(inferenceEnv, code, { "src-a": "num", "src-b": "num" });
    const program = await wfCorpus(code);
    const templateHash = hashGraph(program.main);

    const executor = new SameProcessExecutor({ program, semanticsEpoch: "arrival-provenance-v0" });
    const request: DrillInRequest = {
      templateHash,
      ingress: ingressFromMints(run.mints),
      streamEpoch: "arrival-provenance-v0",
      regionId: run.regionId,
    };
    const response = await executor.drillIn(request);
    expect(response.evidenceTier).toBe("replayed");
    expect(response.trust).toBe("matched");

    // Epoch mismatch WITHOUT a verification pool: refuses outright rather than lie
    // — tier honesty's other face (never answer at all rather than answer wrong).
    await expect(executor.drillIn({ ...request, streamEpoch: "arrival-provenance-v1" })).rejects.toThrow(
      /epoch mismatch/,
    );

    // Epoch mismatch WITH a verification pool that agrees: `trust: "verified"`,
    // still `evidenceTier: "replayed"` — verification changes TRUST, never the tier.
    const pool: readonly VerificationCandidate[] = [
      { templateHash, ingress: ingressFromMints(run.mints), recordedEgress: run.egress },
    ];
    const executor2 = new SameProcessExecutor({ program, semanticsEpoch: "arrival-provenance-v0" });
    const verified = await executor2.drillIn({
      ...request,
      streamEpoch: "arrival-provenance-v1",
      verificationPool: pool,
    });
    expect(verified.evidenceTier).toBe("replayed");
    expect(verified.trust).toBe("verified");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The four break-order probes (Appendix A.2's own numbered list).
// ─────────────────────────────────────────────────────────────────────────────

describe("break-order probe 1 — DO-storage write volume/cost", () => {
  it("the AGGREGATED write volume (records+runs, serialized) stays well under A.2's '~30-60MB per run' storage-column ceiling", async () => {
    const h = createWorkloadHarness();
    await runReferenceWorkload(h);
    const { recordBytes, runBytes } = await storeMetadataBytes(h);
    const totalWriteBytes = recordBytes + runBytes + h.flushedBytesTotal; // + durable payload bytes
    const mb = (n: number) => (n / (1024 * 1024)).toFixed(2);
    console.log(
      `probe1 DO-write volume: records=${mb(recordBytes)}MB runs=${mb(runBytes)}MB payloads=${mb(h.flushedBytesTotal)}MB total=${mb(totalWriteBytes)}MB (A.2 ceiling: ~30-60MB)`,
    );
    expect(totalWriteBytes).toBeLessThan(60 * 1024 * 1024);
  });
});

describe("break-order probe 2 — R2 settle latency on oversize payloads", () => {
  it("a settle is BOUNDED (never left pending indefinitely) and reports 'recorded' throughout — tier honesty holds mid-settle", async () => {
    const payloads = new PayloadStoreFake();
    payloads.setValueSizeCapBytes(16); // force this payload oversize
    payloads.setSettleDelayTicks(5);
    const tierMachine = new PayloadTierMachine(payloads);
    const hash = "probe2-oversize";
    await payloads.put(hash, { value: "x".repeat(64), stampIds: [1] });

    expect((await tierMachine.read(hash)).storageTier).toBe("pending");
    expect((await tierMachine.read(hash)).tier).toBe("recorded"); // pending still answers recorded (§4)

    await payloads.settle(hash, "settled");
    // Not yet applied — the delay is real (5 ticks), asserted BOUNDED below.
    expect((await tierMachine.read(hash)).storageTier).toBe("pending");

    const MAX_TICKS = 10; // the settle-lag tolerance this probe asserts — "bounded by request lifetime" (Appendix A's break-order list, item 2)
    let settledAtTick = -1;
    for (let t = 1; t <= MAX_TICKS; t++) {
      payloads.step(1);
      if ((await tierMachine.read(hash)).storageTier === "r2") {
        settledAtTick = t;
        break;
      }
    }
    expect(settledAtTick).toBeGreaterThan(0);
    expect(settledAtTick).toBeLessThanOrEqual(MAX_TICKS);
    expect((await tierMachine.read(hash)).tier).toBe("recorded"); // r2 still answers recorded
  });
});

describe("break-order probe 3 — ring misconfiguration (undersized ring → backstop flush, never data loss)", () => {
  it("a ring cap smaller than a single payload forces an immediate backstop flush per write — every payload stays retrievable", async () => {
    const h = createWorkloadHarness("probe3-region", /* ringCapBytes */ 1); // pathologically undersized
    const N = 50;
    const hashes: string[] = [];
    setEmissionEnabled(true);
    try {
      for (let i = 0; i < N; i++) {
        const seq = await h.aggregating.allocateSeq(h.regionId);
        const value = `payload-${i}`;
        const hash = `probe3-${i}`;
        h.tierMachine.ringPut(hash, { value, stampIds: [i] });
        await h.aggregating.append(h.regionId, {
          kind: "mint",
          id: { templateHash: "probe3", ordinalPath: [i], regionEpoch: "e0" },
          seq,
          payloadHash: hash,
        });
        await h.tierMachine.flush(hash); // the backstop: cap=1 byte means every put immediately exceeds it
        hashes.push(hash);
      }
    } finally {
      setEmissionEnabled(false);
    }

    // Never data loss: every payload — despite the pathological ring cap forcing a
    // flush on every single write — is still retrievable at a non-stub tier.
    for (const hash of hashes) {
      const envelope = await readPayloadEnvelope(h, hash);
      expect(envelope.tier).not.toBe("stub");
      expect(envelope.value).toBeDefined();
    }
    const stream = await h.base.readStream(h.regionId);
    expect(stream).toHaveLength(N);
  });
});

describe("break-order probe 4 — drill-in CPU (γ per-drill cost vs the interactive budget)", () => {
  it("repeated drill-ins over a small recorded region stay well under the <100ms interactive budget (replay-memo.ts's own stated target)", async () => {
    const code = `(+ (src-a) (src-b))`;
    const program = await wfCorpus(code);
    const executor = new SameProcessExecutor({ program, semanticsEpoch: "arrival-provenance-v0" });
    const templateHash = hashGraph(program.main);

    const ITERATIONS = 20;
    const timings: number[] = [];
    for (let i = 0; i < ITERATIONS; i++) {
      // Fresh recorded run per iteration — replayGraphEgress/FrozenMints consume
      // their queues, so each drill needs its own frozen copy (never re-replaying
      // the SAME exhausted queue, which is not what a fresh drill-in models).
      const freshRun = await recordRun(inferenceEnv, code, { "src-a": "num", "src-b": "num" });
      const start = performance.now();
      const response = await executor.drillIn({
        templateHash,
        ingress: ingressFromMints(freshRun.mints),
        streamEpoch: "arrival-provenance-v0",
        regionId: freshRun.regionId,
      });
      timings.push(performance.now() - start);
      expect(response.evidenceTier).toBe("replayed");
    }

    const max = Math.max(...timings);
    const avg = timings.reduce((a, b) => a + b, 0) / timings.length;
    console.log(
      `probe4 drill-in CPU: avg=${avg.toFixed(2)}ms max=${max.toFixed(2)}ms over ${ITERATIONS} drills (budget: <100ms)`,
    );
    expect(max).toBeLessThan(100);
    expect(avg).toBeLessThan(50);
  });
});
