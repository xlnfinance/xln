/**
 * LAW — the offload protocol (docs/PROVENANCE.md §4 CHOSEN "γ is offloadable" (C5) +
 * "semantics-epoch pinning" (C6) — Q18's offload protocol).
 * FLIPS at Q18. Gate: "standing + epoch-mismatch refusal rows + sampled-verification
 * rows."
 *
 * MACHINERY (this wave's): `provenance/offload.ts` (`SameProcessExecutor`,
 * `DrillInRequest`/`DrillInResponse`, `EpochRefusalError`, `sampledIndices`) — the
 * interface-level protocol C5/C6 name, consuming Q16's `replay.ts`
 * (`replayGraphEgress`/`FrozenMints`/`boxPayload`) and Q8b's `wireframe/hash.ts`
 * (`hashGraph`) read-only. Fixture: `q16-harness.ts`'s `recordRun` produces a REAL
 * recorded stream (real Q11a `emitMint` core, real store fakes) whose mints this file
 * reshapes into `OffloadIngress` — the SAME retrospective side Q16's replay laws
 * already trust, never a second fixture idiom.
 *
 * Two epoch STRINGS stand in for "old interpreter" / "new interpreter" — this
 * reference executor has only ONE evaluator (there is no second arrival interpreter
 * version in this repo to swap in), so a "mismatch" here is a LABEL mismatch, not a
 * genuine semantic divergence. That is exactly right for what Q18 verifies: the
 * PROTOCOL mechanics (refuse / sample / trust-and-cache), not evaluator versioning
 * itself — the disagree-path row below manufactures an artificial disagreement (a
 * deliberately wrong `recordedEgress` in the verification pool) to exercise the
 * REJECT arm, since this executor cannot organically disagree with itself.
 */
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { parse } from "../../eval/generator-exec.js";
import { inferenceEnv } from "../../env/inference-env.js";
import type { Classifier } from "../../provenance/lineage.js";
import { buildWireframe } from "../../provenance/wireframe/builder.js";
import { hashGraph } from "../../provenance/wireframe/hash.js";
import { setEmissionEnabled } from "../../provenance/store/emit.js";
import type { Payload } from "../../provenance/store/interfaces.js";
import type { TemplateHash } from "../../provenance/store/ids.js";
import type { WireframeProgram } from "../../provenance/wireframe/types.js";
import {
  EpochRefusalError,
  SameProcessExecutor,
  sampledIndices,
  type DrillInRequest,
  type OffloadIngress,
  type VerificationCandidate,
} from "../../provenance/offload.js";
import { CORPUS_BASE_NAMES, CORPUS_ROLES } from "../../__tests__/provenance/w1-corpus.js";
import { recordRun, type RecordedMint, type RecordedRun } from "../../__tests__/provenance/q16-harness.js";

const corpusClassifier: Classifier = { roleOf: (op) => CORPUS_ROLES[op] };
const corpusIsBaseName = (n: string): boolean => CORPUS_BASE_NAMES.has(n);

const EPOCH_A = "arrival-provenance-v0";
const EPOCH_B = "arrival-provenance-v1"; // a LABEL mismatch, per this file's header note

async function wfCorpus(code: string): Promise<WireframeProgram> {
  const forms = await parse(code);
  return buildWireframe(forms, { classifier: corpusClassifier, isBaseName: corpusIsBaseName });
}

/** Reshape a recorded run's mints into `OffloadIngress.sources` — grouped by op,
 *  EMISSION order preserved (the same FIFO-per-op shape `FrozenMints.push` expects,
 *  D1's own keying), plain `Payload`s only (never boxed) — exactly what `DrillInRequest`
 *  is required to carry, per §4 C5. */
function ingressFromMints(mints: readonly RecordedMint[]): OffloadIngress {
  const sources: Record<string, Payload[]> = {};
  for (const m of mints) {
    const q = sources[m.op];
    if (q === undefined) sources[m.op] = [m.payload];
    else q.push(m.payload);
  }
  return { slots: {}, sources };
}

/** One fixture: a real recorded run over `(+ (src-a) (src-b))`, its main graph's
 *  template-hash, and the offload ingress derived from its mints — everything the
 *  rows below build `DrillInRequest`s / `VerificationCandidate`s from. */
async function buildFixture(): Promise<{
  readonly program: WireframeProgram;
  readonly templateHash: TemplateHash;
  readonly run: RecordedRun;
  readonly ingress: OffloadIngress;
}> {
  const code = `(+ (src-a) (src-b))`;
  const run = await recordRun(inferenceEnv, code, { "src-a": "num", "src-b": "num" });
  const program = await wfCorpus(code);
  return { program, templateHash: hashGraph(program.main), run, ingress: ingressFromMints(run.mints) };
}

beforeAll(async () => {});

afterEach(() => {
  setEmissionEnabled(false); // module-global flag; recordRun restores
});

describe("§4 C5 — self-contained request/response wire format", () => {
  // @ledger: Q18. Every field a `DrillInRequest`/`DrillInResponse` carries is a plain,
  // JSON-able value (task item 1's own requirement) — `structuredClone` (the actual
  // transport primitive a real Worker boundary would use) round-trips the request
  // byte-for-byte, with NO class instances, functions, or non-cloneable values hiding
  // inside `ingress`.
  it("a DrillInRequest survives structuredClone unchanged — no non-transferable payload sneaks in", async () => {
    const { templateHash, ingress, run } = await buildFixture();
    const request: DrillInRequest = { templateHash, ingress, streamEpoch: EPOCH_A, regionId: run.regionId };
    const cloned = structuredClone(request);
    expect(cloned).toEqual(request);
  });

  it("a DrillInResponse is plain JSON-able data — no boxed SchemeValue leaks out", async () => {
    const { program, templateHash, ingress, run } = await buildFixture();
    const executor = new SameProcessExecutor({ program, semanticsEpoch: EPOCH_A });
    const response = await executor.drillIn({ templateHash, ingress, streamEpoch: EPOCH_A, regionId: run.regionId });
    expect(structuredClone(response)).toEqual(response);
    expect(response).toEqual({ value: run.egress, evidenceTier: "replayed", epoch: EPOCH_A, trust: "matched" });
  });
});

describe("§4 C6 first disjunct — epoch-mismatch refusal (task item 2)", () => {
  it("a MATCHING stream epoch answers normally — no refusal, no verification attempted", async () => {
    const { program, templateHash, ingress, run } = await buildFixture();
    const executor = new SameProcessExecutor({ program, semanticsEpoch: EPOCH_A });
    const response = await executor.drillIn({ templateHash, ingress, streamEpoch: EPOCH_A, regionId: run.regionId });
    expect(response.trust).toBe("matched");
    expect(response.value).toEqual(run.egress);
  });

  // @ledger: Q18. A MISMATCHED epoch with no `verificationPool` refuses outright — the
  // teaching door names both sides' epochs and routes to the second disjunct.
  it("a MISMATCHED epoch with no verificationPool refuses outright (EpochRefusalError, first disjunct)", async () => {
    const { program, templateHash, ingress, run } = await buildFixture();
    const executor = new SameProcessExecutor({ program, semanticsEpoch: EPOCH_A });
    const request: DrillInRequest = { templateHash, ingress, streamEpoch: EPOCH_B, regionId: run.regionId };
    await expect(executor.drillIn(request)).rejects.toThrow(EpochRefusalError);
    try {
      await executor.drillIn(request);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(EpochRefusalError);
      const e = err as EpochRefusalError;
      expect(e.requestEpoch).toBe(EPOCH_B);
      expect(e.executorEpoch).toBe(EPOCH_A);
      expect(e.regionId).toBe(run.regionId);
      expect(e.reason).toBe("no-verification-offered");
      expect(e.message).toMatch(/verificationPool/);
    }
  });

  it("an executor with allowSampledVerification:false refuses even WITH a (valid) pool attached", async () => {
    const { program, templateHash, ingress, run } = await buildFixture();
    const executor = new SameProcessExecutor({ program, semanticsEpoch: EPOCH_A, allowSampledVerification: false });
    const candidate: VerificationCandidate = { templateHash, ingress, recordedEgress: run.egress };
    const request: DrillInRequest = {
      templateHash,
      ingress,
      streamEpoch: EPOCH_B,
      regionId: run.regionId,
      verificationPool: [candidate],
    };
    await expect(executor.drillIn(request)).rejects.toThrow(EpochRefusalError);
    try {
      await executor.drillIn(request);
      expect.unreachable();
    } catch (err) {
      expect((err as EpochRefusalError).reason).toBe("verification-disabled");
    }
  });
});

describe("§4 C6 second disjunct — sampled wire-γ verification (task item 3)", () => {
  it("AGREE path: a verificationPool whose candidates all agree trusts the answer (trust: verified)", async () => {
    const { program, templateHash, ingress, run } = await buildFixture();
    const executor = new SameProcessExecutor({ program, semanticsEpoch: EPOCH_A });
    const candidate: VerificationCandidate = { templateHash, ingress, recordedEgress: run.egress };
    const request: DrillInRequest = {
      templateHash,
      ingress,
      streamEpoch: EPOCH_B,
      regionId: run.regionId,
      verificationPool: [candidate],
    };
    const response = await executor.drillIn(request);
    expect(response.trust).toBe("verified");
    expect(response.value).toEqual(run.egress);
    expect(response.epoch).toBe(EPOCH_A); // the epoch it was ACTUALLY computed under — the executor's own
  });

  it("epoch upgrade persists for the stream — a later request skips re-verification with no pool attached", async () => {
    const { program, templateHash, ingress, run } = await buildFixture();
    const executor = new SameProcessExecutor({ program, semanticsEpoch: EPOCH_A });
    const candidate: VerificationCandidate = { templateHash, ingress, recordedEgress: run.egress };
    await executor.drillIn({
      templateHash,
      ingress,
      streamEpoch: EPOCH_B,
      regionId: run.regionId,
      verificationPool: [candidate],
    });
    // Second call: SAME (regionId, streamEpoch), no pool — must NOT refuse.
    const second = await executor.drillIn({ templateHash, ingress, streamEpoch: EPOCH_B, regionId: run.regionId });
    expect(second.trust).toBe("verified");
    expect(second.value).toEqual(run.egress);
  });

  // pool size-1 so the wrong candidate is always sampled
  it("DISAGREE path: a verificationPool candidate with a WRONG recorded egress refuses (never trusts)", async () => {
    const { program, templateHash, ingress, run } = await buildFixture();
    const executor = new SameProcessExecutor({ program, semanticsEpoch: EPOCH_A });
    const wrongEgress = Number(run.egress) + 1; // deliberately wrong — this executor CANNOT reproduce it
    const badCandidate: VerificationCandidate = { templateHash, ingress, recordedEgress: wrongEgress };
    const request: DrillInRequest = {
      templateHash,
      ingress,
      streamEpoch: EPOCH_B,
      regionId: run.regionId,
      verificationPool: [badCandidate], // size 1 <= DEFAULT_SAMPLE_SIZE: always sampled
    };
    await expect(executor.drillIn(request)).rejects.toThrow(EpochRefusalError);
    try {
      await executor.drillIn(request);
      expect.unreachable();
    } catch (err) {
      const e = err as EpochRefusalError;
      expect(e.reason).toBe("verification-disagreed");
      expect(e.message).toMatch(new RegExp(templateHash.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    }

    // And the stream is NEVER trusted off a disagreement — a later no-pool request
    // for the SAME (regionId, streamEpoch) still refuses (no silent upgrade); the
    // reason reverts to "no-verification-offered" (the trust cache was never set).
    try {
      await executor.drillIn({ templateHash, ingress, streamEpoch: EPOCH_B, regionId: run.regionId });
      expect.unreachable();
    } catch (err) {
      expect((err as EpochRefusalError).reason).toBe("no-verification-offered");
    }
  });

  it("an EMPTY verificationPool array refuses exactly like an absent one (never vacuous trust)", async () => {
    const { program, templateHash, ingress, run } = await buildFixture();
    const executor = new SameProcessExecutor({ program, semanticsEpoch: EPOCH_A });
    const request: DrillInRequest = {
      templateHash,
      ingress,
      streamEpoch: EPOCH_B,
      regionId: run.regionId,
      verificationPool: [],
    };
    await expect(executor.drillIn(request)).rejects.toThrow(EpochRefusalError);
    try {
      await executor.drillIn(request);
      expect.unreachable();
    } catch (err) {
      expect((err as EpochRefusalError).reason).toBe("no-verification-offered");
    }
  });
});

describe("sampling determinism (task item 3: seeded by stream id, no Math.random)", () => {
  // pinned exact values, not merely equal to itself
  it("sampledIndices is deterministic and pinned for fixed inputs", () => {
    expect(sampledIndices("q16-offload-region-A", 20, 3)).toEqual([0, 13, 16]);
    expect(sampledIndices("q16-offload-region-A", 20, 3)).toEqual([0, 13, 16]); // repeat: identical
    expect(sampledIndices("q16-offload-region-B", 20, 3)).toEqual([11, 12, 18]); // different seed: different sample
  });

  it("sampledIndices handles empty pool / zero sample size / oversized sample size", () => {
    expect(sampledIndices("seed", 0, 3)).toEqual([]);
    expect(sampledIndices("seed", 5, 0)).toEqual([]);
    expect(sampledIndices("seed", 3, 10)).toEqual([0, 1, 2]);
  });

  it("never calls Math.random — sampling still works with Math.random poisoned to throw", () => {
    const original = Math.random;
    Math.random = () => {
      throw new Error("sampledIndices must never call Math.random");
    };
    try {
      expect(sampledIndices("poisoned-seed", 12, 4)).toHaveLength(4);
    } finally {
      Math.random = original;
    }
  });

  // a real Fisher–Yates sample, never a naive modulo that could repeat
  it("property: sampled indices are always distinct and in [0, poolSize)", () => {
    for (let seedNum = 0; seedNum < 25; seedNum++) {
      const poolSize = 1 + (seedNum % 15);
      const sampleSize = 1 + (seedNum % 6);
      const indices = sampledIndices(`seed-${seedNum}`, poolSize, sampleSize);
      expect(new Set(indices).size).toBe(indices.length); // no duplicates
      for (const i of indices) {
        expect(i).toBeGreaterThanOrEqual(0);
        expect(i).toBeLessThan(poolSize);
      }
      expect(indices).toEqual([...indices].sort((a, b) => a - b)); // ascending, per contract
    }
  });
});

describe("unresolvable template-hash — a foreign/stale hash is a teaching door, never a silent answer", () => {
  it("a templateHash absent from this executor's program refuses (ReplayScopeError)", async () => {
    const { program, ingress, run } = await buildFixture();
    const executor = new SameProcessExecutor({ program, semanticsEpoch: EPOCH_A });
    const request: DrillInRequest = {
      templateHash: "template-v0:deadbeef",
      ingress,
      streamEpoch: EPOCH_A,
      regionId: run.regionId,
    };
    await expect(executor.drillIn(request)).rejects.toThrow(/no graph in this executor's program matches/);
  });
});
