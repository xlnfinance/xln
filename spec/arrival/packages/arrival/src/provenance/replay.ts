/**
 * Replay drivers. R1: replay from frozen port payloads is stable — NEVER
 * re-invoke a source; retrospective mint records are authoritative.
 *
 *   1. `replayGraphEgress` — per-wire γ over a loop-free graph (`applyWireInEnv`).
 *      Binder/fan/transparent/opaque are teaching doors, not silent approximations.
 *   2. `replayProgramWithPlayback` — whole program under silent region; membrane
 *      penetrations answered only from the recorded payload stream.
 *   3. `replayBetweenRecords` — effect tracks: pure stretches γ'd, mint events
 *      interleaved verbatim in seq order (fold requires completed region).
 *
 * D1 — Frozen ingress keyed PER-OP FIFO. Demand order in loop-free replay matches
 *      emission order per op; same-op ambiguity when only one arm fires is excluded
 *      by corpus (distinct arm ops), not silent. deferred: full (template, path, epoch) key.
 * D2 — Unrecorded demand → sentinel stamp (≥ SENTINEL_BASE). Laws assert
 *      cone(egress) ∩ sentinels = ∅.
 * D3 — Mux arm: recorded decision map wins; else γ selector (closed over frozen ports).
 * D4 — fan/binder/transparent/opaque → `ReplayScopeError` with route, never a wrong value.
 */
import { execState } from "../eval/generator-exec.js";
import { type AmbientValue } from "../env/AmbientRuntime.js";
import type { LexicalScopeWithInternals } from "../eval/LexicalScope.js";
import { BASE_ROSTER } from "../env/base-roster.js";
import { collapseProvenance } from "./provenance-collapse.js";
import { AValue, EMPTY_PROVENANCE, pointProvenance } from "../values/primitives/AValue.js";
import { ARosettaProcedure } from "../values/primitives/ARosettaProcedure.js";
import { toJS, jsToScheme } from "../membrane/rosetta.js";
import { CONSTANT_CTX } from "../run/RunContext.js";
import { withSilentRegion } from "../membrane/region-scope.js";
import type { SchemeValue } from "../values/types.js";
import type { EnvCapability } from "../common/capability.js";
import { applyWireInEnv } from "./gamma.js";
import { hermeticEnv, type HermeticEnv, type IngressBindings } from "./hermetic-env.js";
import { foldRegionStream } from "./store/fold.js";
import type { Payload, PayloadStore, ProvenanceStore } from "./store/interfaces.js";
import type { MintRecord } from "./store/records.js";
import type { RegionId } from "./store/ids.js";
import type { EmittedWire, Wire, WireframeGraph, WireframeProgram } from "./wireframe/types.js";

/** Teaching door: demand outside this driver's scope — routes, never silently wrong. */
export class ReplayScopeError extends Error {
  constructor(
    readonly nodeKind: string,
    readonly span: string,
    teach: string,
  ) {
    super(`replay: ${nodeKind} node at ${span} is outside this driver's scope — ${teach}`);
    this.name = "ReplayScopeError";
  }
}

/** Sentinel stamp base — outside eager/recorded ranges so cone∩sentinels is meaningful. */
export const SENTINEL_BASE = 1 << 30;

let nextSentinel = SENTINEL_BASE;

/** D1: per-op FIFO of recorded mint payloads + D2 sentinel ledger. */
export class FrozenMints {
  private readonly queues = new Map<string, Payload[]>();
  /** sentinel id → demand site (op+span). */
  readonly sentinels = new Map<number, string>();

  push(op: string, payload: Payload): void {
    const q = this.queues.get(op);
    if (q === undefined) this.queues.set(op, [payload]);
    else q.push(payload);
  }

  next(op: string): Payload | undefined {
    return this.queues.get(op)?.shift();
  }

  sentinel(desc: string): SchemeValue {
    const id = nextSentinel++;
    this.sentinels.set(id, desc);
    return jsToScheme(CONSTANT_CTX, `#sentinel:${id}`, {}, new Set([id]));
  }
}

/**
 * Mux control-dependency: taken arm carries selector cone (eager `if` + wireframe
 * selector walk). Exported so replay-walk applies the same union at yield points.
 */
export function withUnionedProvenance(value: SchemeValue, taintFrom: SchemeValue): SchemeValue {
  if (!(value instanceof AValue)) return value;
  const taint = collapseProvenance(taintFrom);
  if (taint.size === 0) return value;
  const merged = new Set<number>([...value.provenance, ...taint]);
  return value.withProvenance(merged);
}

/** Payload → boxed scheme (live rosetta boxing idiom) with recorded stamps. */
export function boxPayload(payload: Payload): SchemeValue {
  return jsToScheme(CONSTANT_CTX, payload.value, {}, new Set(payload.stampIds));
}

/** Boxed (cone queries) + peeled (payload compare). */
export interface ReplayedValue {
  readonly boxed: SchemeValue;
  readonly value: unknown;
}

export interface ReplayGraphOptions {
  readonly program: WireframeProgram;
  /** Defaults to `program.main`; track laws pass a fan template interior. */
  readonly graph?: WireframeGraph;
  readonly frozen: FrozenMints;
  readonly slots?: IngressBindings;
  /** D3: node index → taken arm; else selector-γ. */
  readonly decisions?: ReadonlyMap<number, number>;
  readonly basePacks?: readonly EnvCapability[];
  readonly config?: object;
}

/**
 * Face 1 — loop-free graph γ, lazy/memoized per node (untaken arms never demanded).
 */
export async function replayGraphEgress(opts: ReplayGraphOptions): Promise<ReplayedValue> {
  const { program, frozen, decisions, slots = {}, basePacks = [], config } = opts;
  const graph = opts.graph ?? program.main;
  return withSilentRegion(async () => {
    // Standard-base fold is this call site's job (see hermetic-env / gamma).
    const base = await hermeticEnv([...basePacks, ...BASE_ROSTER], program.prelude.source, {}, config);
    const boxed = await replayGraphIn(base, program, graph, frozen, slots, decisions);
    return { boxed, value: toJS(boxed) };
  });
}

async function replayGraphIn(
  base: HermeticEnv,
  program: WireframeProgram,
  graph: WireframeGraph,
  frozen: FrozenMints,
  slots: IngressBindings,
  decisions: ReadonlyMap<number, number> | undefined,
): Promise<SchemeValue> {
  const nodeMemo = new Map<number, SchemeValue>();

  const wireFor = (node: number, slot: string): Wire => {
    const wire = graph.wires.find((w) => w.consumer.node === node && w.consumer.slot === slot);
    if (wire === undefined) {
      const kind = graph.nodes[node]?.kind ?? "?";
      throw new ReplayScopeError(
        kind,
        graph.nodes[node]?.span ?? "?",
        `no wire feeds slot "${slot}" — record gap or builder gap; nothing to γ`,
      );
    }
    return wire;
  };

  const gammaWire = async (wire: EmittedWire): Promise<SchemeValue> => {
    const ingress: Record<string, AmbientValue> = {};
    for (const ref of wire.paramRefs) {
      if (ref.kind === "slot") {
        const bound = slots[ref.name];
        if (bound === undefined) {
          throw new ReplayScopeError(
            "slot",
            wire.span,
            `free slot "${ref.name}" has no caller binding — program ingress must be supplied to replay`,
          );
        }
        ingress[ref.name] = bound;
      } else {
        ingress[ref.name] = await nodeValue(ref.node);
      }
    }
    return applyWireInEnv(base, wire, ingress);
  };

  const nodeValue = async (idx: number): Promise<SchemeValue> => {
    const memo = nodeMemo.get(idx);
    if (memo !== undefined) return memo;
    const node = graph.nodes[idx];
    let value: SchemeValue;
    switch (node.kind) {
      case "source": {
        // R1: recorded payload is the value; unrecorded demand → sentinel (D2).
        const payload = frozen.next(node.op);
        value = payload === undefined ? frozen.sentinel(`source:${node.op}@${node.span}`) : boxPayload(payload);
        break;
      }
      case "sink":
        // No egress — sequencing residue; sentinel must not flow (D2).
        value = frozen.sentinel(`sink:${node.op}@${node.span}`);
        break;
      case "mux": {
        // D3: recorded arm or selector-γ; always γ selector for control-dependency taint.
        const selBoxed = await gammaWire(wireFor(idx, "selector"));
        let arm = decisions?.get(idx);
        if (arm === undefined) {
          const taken = toJS(selBoxed) !== false; // only #f is false
          arm = taken ? 0 : 1;
        }
        const armValue = await gammaWire(wireFor(idx, `arm${arm}`));
        value = withUnionedProvenance(armValue, selBoxed);
        break;
      }
      case "template-ref": {
        const template = program.templates.get(node.name);
        if (template?.graph.egress == null) {
          throw new ReplayScopeError(
            "template-ref",
            node.span,
            `template "${node.name}" is absent or has no egress — nothing to replay`,
          );
        }
        const args: Record<string, AmbientValue> = {};
        for (let k = 0; k < template.params.length; k++) {
          args[template.params[k]] = await gammaWire(wireFor(idx, `arg${k}`));
        }
        value = await replayGraphIn(base, program, template.graph, frozen, args, decisions);
        break;
      }
      case "fan":
        throw new ReplayScopeError(
          "fan",
          node.span,
          "a region replays as TRACKS (γ its template per element — the track laws' shape) or via whole-program playback (`replayProgramWithPlayback`), never as a single wire value",
        );
      case "binder":
      case "recur":
        throw new ReplayScopeError(
          node.kind,
          node.span,
          "loops are the half wire-γ does NOT claim (widening makes loop cones non-least); exact reconstruction is one γ-step away via aggregation count + quoted body — `replayProgramWithPlayback`",
        );
      case "transparent":
      case "opaque":
        throw new ReplayScopeError(
          node.kind,
          node.span,
          "a crossing with no recorded payload has nothing to be stable FROM — record it (source) or declare it pure",
        );
      case "port":
        throw new ReplayScopeError("port", node.span, "the out-port is the egress consumer, never a value producer");
      default: {
        const never: never = node;
        throw new ReplayScopeError(String((never as { kind?: string }).kind), "?", "unhandled node kind");
      }
    }
    nodeMemo.set(idx, value);
    return value;
  };

  if (graph.egress === null) {
    throw new ReplayScopeError(
      "port",
      "?",
      "graph has no value egress (all-defines or sink-tail program) — nothing to replay",
    );
  }
  return gammaWire(wireFor(graph.egress, "out"));
}

// ── Face 2 — whole-program playback (also loop reconstruction via count + body) ─

export interface PlaybackReplayOptions {
  readonly source: string;
  /** Recorded penetrations per op, stream order — live world not bound. */
  readonly playback: ReadonlyMap<string, readonly Payload[]>;
  readonly basePacks?: readonly EnvCapability[];
  readonly config?: object;
}

/**
 * Silent-region whole-program re-run; only playback sources bound. Underflow is
 * a teaching door — never live re-fetch, never silent default.
 */
export async function replayProgramWithPlayback(opts: PlaybackReplayOptions): Promise<ReplayedValue> {
  const { source, playback, basePacks = [], config } = opts;
  return withSilentRegion(async () => {
    const base = await hermeticEnv([...basePacks, ...BASE_ROSTER], "", {}, config);
    const playbackScope = base.scope.child("provenance-playback") as LexicalScopeWithInternals<typeof base.scope>;
    for (const [op, payloads] of playback) {
      const queue = [...payloads];
      // ARosettaProcedure — `.bind` doors a bare host fn. Fresh source point per
      // fire (same mint as a live source crossing); recorded stamps ride in boxPayload.
      playbackScope.env.bind(
        op,
        new ARosettaProcedure({
          name: op,
          arity: { min: 0, max: null },
          contract: undefined,
          hostApply: (_schemeArgs, callCtx) => {
            const next = queue.shift();
            if (next === undefined) {
              throw new ReplayScopeError(
                "source",
                op,
                `playback queue for "${op}" underflowed — the replay demanded more penetrations than the record run crossed; the stream is incomplete or the program diverged (never answered live)`,
              );
            }
            const { runCtx, invocation } = callCtx;
            const inv = invocation.currentInvocation;
            let resultProvenance = EMPTY_PROVENANCE;
            if (inv && typeof inv.id === "number") {
              if (typeof inv.markProvenancePoint === "function") inv.markProvenancePoint();
              else inv.isProvenancePoint = true;
              resultProvenance = pointProvenance(inv.id);
            }
            return jsToScheme(runCtx, boxPayload(next), undefined, resultProvenance);
          },
        }),
      );
    }
    const state = await execState(source, {
      capabilities: base.capabilities,
      config: base.config,
      scope: playbackScope,
      runCtx: base.runCtx,
    });
    const boxed = state.values.at(-1);
    if (boxed === undefined) {
      throw new ReplayScopeError("port", "program", "the program evaluated zero forms — nothing to replay");
    }
    return { boxed, value: toJS(boxed) };
  });
}

// ── Face 3 — effect-track replay-between-records ────────────────────────────

/** Port event verbatim, or pure-stretch γ value — order is the law subject. */
export type ReplayStep =
  | { readonly kind: "port-event"; readonly record: MintRecord; readonly payload: Payload }
  | { readonly kind: "pure"; readonly value: unknown };

/** Pure stretch between events: acc = egress(Tᵢ)→ingress(Tᵢ₊₁); event = recorded payload. */
export interface EffectStretch {
  readonly wire: EmittedWire;
  readonly accParam: string;
  readonly eventParam: string;
}

interface ReplayBetweenRecordsOptions {
  readonly store: ProvenanceStore;
  readonly payloads: PayloadStore;
  readonly regionId: RegionId;
  readonly stretch: EffectStretch;
  /** The chain's initial accumulator (boxed) — the fold's seed. */
  readonly initial: SchemeValue;
  readonly prelude?: string;
  readonly basePacks?: readonly EnvCapability[];
  readonly config?: object;
}

/**
 * Effect tracks: pure stretches γ'd, mint events interleaved in seq order.
 *   1. fold first — region must complete (`pending === 0`)
 *   2. mints in stream order are the events (never re-sorted)
 *   3. between events, γ stretch(acc, recorded payload) — middle of pure-only
 *      and record-only
 */
export async function replayBetweenRecords(opts: ReplayBetweenRecordsOptions): Promise<{
  readonly steps: readonly ReplayStep[];
  readonly egress: unknown;
  readonly egressBoxed: SchemeValue;
}> {
  const { store, payloads, regionId, stretch, initial, prelude = "", basePacks = [], config } = opts;
  const stream = await store.readStream(regionId);
  const fold = foldRegionStream(stream);
  if (fold.pending !== 0) {
    throw new ReplayScopeError(
      "track",
      regionId,
      `region has ${fold.pending} pending track(s) (started ${fold.started}, completed ${fold.completed}) — replay-between-records only replays COMPLETED regions; close the region (or accept the incomplete door) first`,
    );
  }
  const mints = stream.filter((r): r is MintRecord => r.kind === "mint");

  return withSilentRegion(async () => {
    const base = await hermeticEnv([...basePacks, ...BASE_ROSTER], prelude, {}, config);
    const steps: ReplayStep[] = [];
    let acc: SchemeValue = initial;
    for (const record of mints) {
      const payload = await payloads.get(record.payloadHash);
      const frozen: Payload = { value: payload.value, stampIds: payload.stampIds };
      steps.push({ kind: "port-event", record, payload: frozen });
      acc = await applyWireInEnv(base, stretch.wire, {
        [stretch.accParam]: acc,
        [stretch.eventParam]: boxPayload(frozen),
      });
      steps.push({ kind: "pure", value: toJS(acc) });
    }
    return { steps, egress: toJS(acc), egressBoxed: acc };
  });
}
