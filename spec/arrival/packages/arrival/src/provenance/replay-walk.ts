/**
 * provenance/replay-walk.ts — LAZY STEP-WALKS: step-WALKS are not memoized, they
 * stream lazily off the generator-based interpreter (a single wire's walk is small
 * and paged; the LRU memo instead covers whole-segment cone computation).
 *
 * A LAZY async-generator surface over the SAME γ semantics `replay.ts`'s
 * `replayGraphEgress` computes to completion: each `yield` is ONE γ STEP — one
 * `applyWireInEnv` (gamma.ts's same wire-application idiom `replay.ts` drives) —
 * so a caller (an interactive drill-in UI stepping through a wire) can `for await`
 * and STOP EARLY without paying for the rest of the graph. Nothing beyond the
 * pulled prefix is ever computed: an unpulled step's `applyWireInEnv` call, and
 * every recursive `nodeValueStep`/`gammaWireStep` it would have needed, never runs
 * (a JS async generator only advances to its next `yield` on `.next()` — this file
 * adds no scheduling machinery beyond that language guarantee).
 *
 * SCOPE — deliberately NEVER touches `replay-memo.ts` (the egress/cone LRU): this
 * file has ZERO import of that module, so it is structurally impossible to
 * memo-hit from here — a walk always streams fresh.
 *
 * DUPLICATION: `replay.ts`'s per-node switch (`nodeValue`, inside
 * `replayGraphIn`) has no seam to yield through — it is a private closure with no
 * step-observable boundary. This file re-implements the SAME node-kind coverage
 * (source / sink / mux / template-ref, with the SAME refusals for fan / binder /
 * recur / transparent / opaque / port) as a step-yielding async generator instead.
 * This is the ONE genuinely-needed additive surface that consuming `replay.ts`/
 * `gamma.ts` directly can't provide — kept honest by two seams that stop it from
 * drifting into a second, silently-diverging copy of the replay laws:
 *   1. every SHARED primitive (`FrozenMints`, `boxPayload`, `ReplayScopeError`,
 *      `withUnionedProvenance` — the last newly exported BY this node, see
 *      replay.ts's own doc on that export) is IMPORTED from `replay.ts`, never
 *      re-derived;
 *   2. the walk's FINAL egress+cone must be BYTE-IDENTICAL to `replayGraphEgress`'s
 *      over the same inputs — a divergence between the two node switches is a bug
 *      in this file, never an acceptable drift.
 */
import type { AmbientValue } from "../env/AmbientRuntime.js";
import { BASE_ROSTER } from "../env/base-roster.js";
import type { SchemeValue } from "../values/types.js";
import type { EnvCapability } from "../common/capability.js";
import { withSilentRegion } from "../membrane/region-scope.js";
import { applyWireInEnv } from "./gamma.js";
import { hermeticEnv, type HermeticEnv, type IngressBindings } from "./hermetic-env.js";
import { boxPayload, FrozenMints, ReplayScopeError, withUnionedProvenance, type ReplayedValue } from "./replay.js";
import { toJS } from "../membrane/rosetta.js";
import type { EmittedWire, Wire, WireframeGraph, WireframeProgram } from "./wireframe/types.js";

/** One γ step: a wire's application, its consumer coordinate (which node/slot it
 *  fed), and both faces of the result (boxed — cone queries; peeled — value compare,
 *  the same two-face shape `ReplayedValue` already carries for the whole-graph
 *  answer). */
export interface ReplayWalkStep {
  readonly node: number;
  readonly slot: string;
  readonly span: string;
  readonly boxed: SchemeValue;
  readonly value: unknown;
}

interface ReplayWalkOptions {
  readonly program: WireframeProgram;
  /** Which graph to walk — defaults to `program.main`, mirroring
   *  `ReplayGraphOptions.graph` (replay.ts) exactly. */
  readonly graph?: WireframeGraph;
  readonly frozen: FrozenMints;
  readonly slots?: IngressBindings;
  readonly decisions?: ReadonlyMap<number, number>;
  readonly basePacks?: readonly EnvCapability[];
  readonly config?: object;
}

function wireFor(graph: WireframeGraph, node: number, slot: string): Wire {
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
}

/** One designated node's value, computed lazily — mirrors `replay.ts`'s private
 *  `nodeValue` switch arm-for-arm (see this file's header on why it is a separate
 *  copy). `cache` is a PER-WALK memo (one graph traversal's own node dedup — the
 *  SAME shape `replayGraphIn`'s local `nodeMemo` is, not the LRU `replay-memo.ts`
 *  owns; a fresh `cache` per recursive `template-ref`/graph descent, exactly as
 *  `replayGraphIn` builds a fresh `nodeMemo` per recursive call). */
async function* nodeValueStep(
  base: HermeticEnv,
  program: WireframeProgram,
  graph: WireframeGraph,
  frozen: FrozenMints,
  slots: IngressBindings,
  decisions: ReadonlyMap<number, number> | undefined,
  cache: Map<number, SchemeValue>,
  idx: number,
): AsyncGenerator<ReplayWalkStep, SchemeValue> {
  const cached = cache.get(idx);
  if (cached !== undefined) return cached;
  const node = graph.nodes[idx];
  let value: SchemeValue;
  switch (node.kind) {
    case "source": {
      // R1 — NEVER re-invoke: the recorded payload IS the value; an unrecorded
      // demand binds a sentinel (D2), matching replay.ts exactly.
      const payload = frozen.next(node.op);
      value = payload === undefined ? frozen.sentinel(`source:${node.op}@${node.span}`) : boxPayload(payload);
      break;
    }
    case "sink":
      value = frozen.sentinel(`sink:${node.op}@${node.span}`);
      break;
    case "mux": {
      const selBoxed = yield* gammaWireStep(
        base,
        program,
        graph,
        frozen,
        slots,
        decisions,
        cache,
        wireFor(graph, idx, "selector"),
        idx,
        "selector",
      );
      let arm = decisions?.get(idx);
      if (arm === undefined) {
        const taken = toJS(selBoxed) !== false; // scheme truth: only #f is false
        arm = taken ? 0 : 1;
      }
      const armValue = yield* gammaWireStep(
        base,
        program,
        graph,
        frozen,
        slots,
        decisions,
        cache,
        wireFor(graph, idx, `arm${arm}`),
        idx,
        `arm${arm}`,
      );
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
        args[template.params[k]] = yield* gammaWireStep(
          base,
          program,
          graph,
          frozen,
          slots,
          decisions,
          cache,
          wireFor(graph, idx, `arg${k}`),
          idx,
          `arg${k}`,
        );
      }
      value = yield* graphEgressStep(base, program, template.graph, frozen, args, decisions);
      break;
    }
    case "fan":
      throw new ReplayScopeError(
        "fan",
        node.span,
        "a region replays as TRACKS (γ its template per element) or via whole-program playback, never as a single wire value",
      );
    case "binder":
    case "recur":
      throw new ReplayScopeError(
        node.kind,
        node.span,
        "loops are the half wire-γ does NOT claim; exact reconstruction is one γ-step away via aggregation count + quoted body",
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
  cache.set(idx, value);
  return value;
}

/** ONE γ step: resolve a wire's ingress (recursing into `nodeValueStep` for `node`
 *  refs, the caller's `slots` for `slot` refs), apply it (`gamma.ts`'s
 *  `applyWireInEnv`, under a silent region for exactly this call's extent), and
 *  YIELD the result before returning it — the single point every external
 *  `for await` pull actually observes. */
async function* gammaWireStep(
  base: HermeticEnv,
  program: WireframeProgram,
  graph: WireframeGraph,
  frozen: FrozenMints,
  slots: IngressBindings,
  decisions: ReadonlyMap<number, number> | undefined,
  cache: Map<number, SchemeValue>,
  wire: EmittedWire,
  node: number,
  slot: string,
): AsyncGenerator<ReplayWalkStep, SchemeValue> {
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
      ingress[ref.name] = yield* nodeValueStep(base, program, graph, frozen, slots, decisions, cache, ref.node);
    }
  }
  const boxed = await withSilentRegion(() => applyWireInEnv(base, wire, ingress));
  const step: ReplayWalkStep = { node, slot, span: wire.span, boxed, value: toJS(boxed) };
  yield step;
  return boxed;
}

async function* graphEgressStep(
  base: HermeticEnv,
  program: WireframeProgram,
  graph: WireframeGraph,
  frozen: FrozenMints,
  slots: IngressBindings,
  decisions: ReadonlyMap<number, number> | undefined,
): AsyncGenerator<ReplayWalkStep, SchemeValue> {
  if (graph.egress === null) {
    throw new ReplayScopeError(
      "port",
      "?",
      "graph has no value egress (all-defines or sink-tail program) — nothing to replay",
    );
  }
  const cache = new Map<number, SchemeValue>();
  return yield* gammaWireStep(
    base,
    program,
    graph,
    frozen,
    slots,
    decisions,
    cache,
    wireFor(graph, graph.egress, "out"),
    graph.egress,
    "out",
  );
}

/**
 * THE lazy step-walk: `for await (const step of walkGraphReplay(opts))` observes
 * one γ application at a time, in the SAME demand order `replayGraphEgress` would
 * compute internally, stopping the underlying computation the instant the caller
 * stops pulling. The generator's RETURN value (available once fully drained, or via
 * the final `.next()` whose `done` is `true`) is the same `ReplayedValue` shape
 * `replayGraphEgress` returns — a caller that walks to completion gets an identical
 * answer to one that called the whole-graph function directly.
 */
export async function* walkGraphReplay(opts: ReplayWalkOptions): AsyncGenerator<ReplayWalkStep, ReplayedValue> {
  const { program, frozen, decisions, slots = {}, basePacks = [], config } = opts;
  const graph = opts.graph ?? program.main;
  // THE STANDARD-BASE FOLD — this call site's own responsibility, not `hermeticEnv`'s
  // (see that module's own header; `replay.ts`'s `replayGraphEgress` mirrors this).
  const base = await withSilentRegion(() =>
    hermeticEnv([...basePacks, ...BASE_ROSTER], program.prelude.source, {}, config),
  );
  const boxed = yield* graphEgressStep(base, program, graph, frozen, slots, decisions);
  return { boxed, value: toJS(boxed) };
}
