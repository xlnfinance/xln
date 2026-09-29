/**
 * Offload protocol: γ is offloadable; replay pins to a semantics epoch.
 * Template hash + frozen ingress are serializable — workers may drill-in outside
 * the DO. Request carries stream epoch; mismatch refuses or runs sampled wire-γ
 * verification. Silent cross-version replay is EXCLUDED (newer evaluator can lie).
 *
 * `DrillInExecutor` is interface-level (no HTTP/workerd). SameProcessExecutor is
 * the reference — consumes replay / hashGraph / store types read-only.
 *
 * REQUEST: `templateHash` (per-graph content hash — main, define template, or
 * fan/binder interior), plain `Payload` ingress (slots + sources; box at γ time),
 * `streamEpoch`, `regionId` (seed verification + trust cache). JSON-safe.
 *
 * RESPONSE: peeled value + `evidenceTier: "replayed"` (live γ; memo is layered
 * in front) + executor `epoch` + `trust: "matched" | "verified"`.
 *
 * EPOCH: mismatch without pool (or policy off) → `EpochRefusalError`.
 * With pool: deterministic sample under current semantics vs recorded egresses;
 * all agree → trust stream (`regionId→streamEpoch` cache); any disagree → refuse.
 * Sampling: FNV-seeded xorshift32 by regionId — reproducible, no Math.random.
 */
import type { AmbientValue } from "../env/AmbientRuntime.js";
import type { EnvCapability } from "../common/capability.js";
import { boxPayload, FrozenMints, replayGraphEgress, ReplayScopeError } from "./replay.js";
import { hashGraph } from "./wireframe/hash.js";
import type { RegionId, TemplateHash } from "./store/ids.js";
import type { EvidenceTier, Payload } from "./store/interfaces.js";
import type { WireframeGraph, WireframeProgram } from "./wireframe/types.js";

// ── Wire format (JSON / structuredClone safe) ────────────────────────────────

/** Graph γ ingress: free slots + per-op source payloads (emission order). Plain Payload. */
export interface OffloadIngress {
  readonly slots: Readonly<Record<string, Payload>>;
  readonly sources: Readonly<Record<string, readonly Payload[]>>;
}

/** Same-stream recorded crossing for sampled verification. */
export interface VerificationCandidate {
  readonly templateHash: TemplateHash;
  readonly ingress: OffloadIngress;
  readonly recordedEgress: unknown;
}

/** Self-contained drill-in; executor serves one program version (= wireframe hash). */
export interface DrillInRequest {
  readonly templateHash: TemplateHash;
  readonly ingress: OffloadIngress;
  readonly streamEpoch: string;
  readonly regionId: RegionId;
  readonly verificationPool?: readonly VerificationCandidate[];
}

export interface DrillInResponse {
  readonly value: unknown;
  readonly evidenceTier: EvidenceTier;
  readonly epoch: string;
  readonly trust: "matched" | "verified";
}

// ── Epoch refusal (first disjunct) ───────────────────────────────────────────

/** Teaching door for mismatch / verification-disagreed. */
export class EpochRefusalError extends Error {
  constructor(
    readonly requestEpoch: string,
    readonly executorEpoch: string,
    readonly regionId: RegionId,
    readonly reason: "no-verification-offered" | "verification-disabled" | "verification-disagreed",
    teach: string,
  ) {
    super(
      `offload: stream epoch mismatch (request="${requestEpoch}" executor="${executorEpoch}") ` +
        `for region "${regionId}" — ${teach}`,
    );
    this.name = "EpochRefusalError";
  }
}

// ── Sampled verification (second disjunct) ───────────────────────────────────

/** Small by design — wrong interpreters disagree early. */
export const DEFAULT_SAMPLE_SIZE = 3;

/** FNV-1a seed (local copy — no store/hash import for four lines). */
function fnvSeed(text: string): number {
  let h = 0x81_1c_9d_c5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.codePointAt(i) ?? 0;
    h = Math.imul(h, 0x01_00_01_93);
  }
  return h >>> 0;
}

/** Deterministic partial Fisher–Yates; seed = regionId. Sorted indices. */
export function sampledIndices(seed: string, poolSize: number, sampleSize: number): readonly number[] {
  const n = Math.max(0, Math.min(sampleSize, poolSize));
  if (n === 0) return [];
  const pool = Array.from({ length: poolSize }, (_, i) => i);
  let state = fnvSeed(seed) || 1;
  const nextUint32 = (): number => {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state;
  };
  for (let i = 0; i < n; i++) {
    const j = i + (nextUint32() % (poolSize - i));
    const tmp = pool[i];
    pool[i] = pool[j];
    pool[j] = tmp;
  }
  return pool.slice(0, n).toSorted((a, b) => a - b);
}

/** JSON structural agree; String() fallback (values are JSON-safe by construction). */
function valuesAgree(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return String(a) === String(b);
  }
}

// ── Protocol surface ─────────────────────────────────────────────────────────

export interface DrillInExecutor {
  readonly semanticsEpoch: string;
  drillIn(request: DrillInRequest): Promise<DrillInResponse>;
}

interface SameProcessExecutorOptions {
  readonly program: WireframeProgram;
  readonly semanticsEpoch: string;
  readonly basePacks?: readonly EnvCapability[];
  readonly config?: object;
  /** Default true; false = refusal-only even with a pool (deployment policy). */
  readonly allowSampledVerification?: boolean;
  readonly sampleSize?: number;
}

function indexProgramGraphs(program: WireframeProgram): ReadonlyMap<TemplateHash, WireframeGraph> {
  const index = new Map<TemplateHash, WireframeGraph>();
  const visit = (graph: WireframeGraph): void => {
    const hash = hashGraph(graph);
    if (index.has(hash)) return;
    index.set(hash, graph);
    for (const node of graph.nodes) {
      if (node.kind === "fan" && node.template !== undefined) visit(node.template);
      else if (node.kind === "binder") visit(node.interior);
    }
  };
  visit(program.main);
  for (const template of program.templates.values()) visit(template.graph);
  return index;
}

/**
 * Reference executor. Only mutable field: `trustedStreams` cache (optimization;
 * no answer depends on it).
 */
export class SameProcessExecutor implements DrillInExecutor {
  readonly semanticsEpoch: string;
  private readonly program: WireframeProgram;
  private readonly basePacks: readonly EnvCapability[];
  private readonly config?: object;
  private readonly allowSampledVerification: boolean;
  private readonly sampleSize: number;
  private readonly graphIndex: ReadonlyMap<TemplateHash, WireframeGraph>;
  private readonly trustedStreams = new Map<RegionId, string>();

  constructor(opts: SameProcessExecutorOptions) {
    this.program = opts.program;
    this.semanticsEpoch = opts.semanticsEpoch;
    this.basePacks = opts.basePacks ?? [];
    this.config = opts.config;
    this.allowSampledVerification = opts.allowSampledVerification ?? true;
    this.sampleSize = opts.sampleSize ?? DEFAULT_SAMPLE_SIZE;
    this.graphIndex = indexProgramGraphs(opts.program);
  }

  async drillIn(request: DrillInRequest): Promise<DrillInResponse> {
    const { templateHash, ingress, streamEpoch, regionId } = request;
    const matches = streamEpoch === this.semanticsEpoch;
    const alreadyTrusted = this.trustedStreams.get(regionId) === streamEpoch;

    if (!matches && !alreadyTrusted) {
      if (!this.allowSampledVerification) {
        throw new EpochRefusalError(
          streamEpoch,
          this.semanticsEpoch,
          regionId,
          "verification-disabled",
          "this executor's deployment policy disallows sampled verification — " +
            "refusing outright via the first disjunct only; a request cannot opt this executor into the second disjunct",
        );
      }
      const pool = request.verificationPool;
      if (pool === undefined || pool.length === 0) {
        throw new EpochRefusalError(
          streamEpoch,
          this.semanticsEpoch,
          regionId,
          "no-verification-offered",
          "the request carried no `verificationPool` — refusing outright; attach " +
            "recorded (templateHash, ingress, recordedEgress) triples from this stream to make the second " +
            "disjunct (sampled wire-γ verification) reachable instead",
        );
      }
      const indices = sampledIndices(regionId, pool.length, this.sampleSize);
      for (const i of indices) {
        const candidate = pool[i];
        const computed = await this.computeEgress(candidate.templateHash, candidate.ingress);
        if (!valuesAgree(computed, candidate.recordedEgress)) {
          throw new EpochRefusalError(
            streamEpoch,
            this.semanticsEpoch,
            regionId,
            "verification-disagreed",
            `sampled wire-γ verification disagreed on template "${candidate.templateHash}" (sample index ${i} ` +
              `of ${pool.length}) — this executor's semantics ("${this.semanticsEpoch}") reproduce a DIFFERENT ` +
              `egress than the recorded run under "${streamEpoch}"; refusing rather than trusting a partially` +
              `-diverged interpreter — a newer evaluator lying politely is exactly what this protocol excludes`,
          );
        }
      }
      this.trustedStreams.set(regionId, streamEpoch);
    }

    const value = await this.computeEgress(templateHash, ingress);
    return {
      value,
      evidenceTier: "replayed",
      epoch: this.semanticsEpoch,
      trust: matches ? "matched" : "verified",
    };
  }

  /** γ via replayGraphEgress; unknown hash → ReplayScopeError (never silent). */
  private async computeEgress(templateHash: TemplateHash, ingress: OffloadIngress): Promise<unknown> {
    const graph = this.graphIndex.get(templateHash);
    if (graph === undefined) {
      throw new ReplayScopeError(
        "template-ref",
        templateHash,
        `no graph in this executor's program matches template-hash "${templateHash}" — this executor serves ` +
          "exactly ONE program version (program version = wireframe hash); a foreign/stale template-hash " +
          "is a caller bug or a program-version mismatch, never silently answered",
      );
    }
    const frozen = new FrozenMints();
    for (const [op, payloads] of Object.entries(ingress.sources)) {
      for (const payload of payloads) frozen.push(op, payload);
    }
    const slots: Record<string, AmbientValue> = {};
    for (const [name, payload] of Object.entries(ingress.slots)) slots[name] = boxPayload(payload);
    const replayed = await replayGraphEgress({
      program: this.program,
      graph,
      frozen,
      slots,
      basePacks: this.basePacks,
      config: this.config,
    });
    return replayed.value;
  }
}
