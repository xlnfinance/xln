/**
 * flow-graph — the pure, render-ready flow-graph data model + causal cones.
 *
 * No eval engine: just the node/edge value types (`BoxType`/`EdgeKind` come in
 * type-only, so this leaf imports nothing at runtime) and the cone traversals
 * (pure over `edges`). The EvalTrace → graph PRODUCER (`traceToFlowGraph`) lives
 * in `trace-to-flow-graph.ts` and imports these; this leaf is the engine-free model
 * `@inhuman.tools/arrival`'s provenance subpath surfaces (re-exported, unchanged, by the
 * `@inhuman.tools/arrival-provenance` shim) — so a UI can render and select over the
 * graph without pulling the interpreter.
 */
import type { EdgeKind } from "./statechart.js";
import type { BoxType } from "./trace-to-forest.js";

export type FlowNodeKind = "region" | "leaf";

export interface FlowGraphNode {
  /** Single id space — the forest's structural scope id (`head@line:col`),
   *  stable across runs. */
  id: string;
  /** `region` = has nested boxes (a compound/parent node); `leaf` = a terminal
   *  box (typically an infer/query provenance point, or an empty scope). */
  kind: FlowNodeKind;
  /** unfold (map fan-out) | loop (recursion) | dnf (branch) | fold | leaf. */
  boxType: BoxType;
  /** Parent region id, or null for a root. */
  parentId: string | null;
  /** Display label — the form's leading symbol (e.g. `map`, `infer/chat`). */
  label: string;
  /** Local multiplicity for the ×N stack badge: occurrences-per-parent-occurrence
   *  (the per-level number the mockup shows — ×3 inside ×K, not the flat 3K). 1 ⇒
   *  ran once ⇒ no stack (renderer hides the badge). */
  count: number;
  /** Lamport causal depth (longest upstream infer chain) for causal nodes; null
   *  for regions/leaves with no provenance counterpart. Drives left→right lanes. */
  layer: number | null;
  /** The optimizer's INITIAL fold decision: a region folds its children to a ×N
   *  card; a multi-instance leaf folds to a ×N stack (the mockup's stacked
   *  fan-out). n=1 scopes never fold. The human can expand/collapse from here. */
  collapsedByDefault: boolean;
  /** A human-forced collapse override (a promoted "forced" user-define). */
  forced: boolean;
  /** Region boundary (region-model): for a region node, the producer node-ids
   *  whose values cross IN (entrance) and the internal producers whose values
   *  cross OUT (exit), from regionBoundaries. Absent on leaves and on regions with
   *  no boundary crossing. The render draws these as the region's entrance/exit
   *  ports when collapsed — not elk-layout's edge-lift heuristic. */
  entrance?: string[];
  exit?: string[];
}

export interface FlowGraphEdge {
  /** Upstream leaf scope id. */
  from: string;
  /** Downstream leaf scope id. */
  to: string;
  /** `forward` = within-iteration dataflow (solid arrow); `loopback` = the `↺`
   *  back-edge (iter-k → iter-k+1 collapsed onto the same cells). */
  kind: EdgeKind;
  /** Field-qualified provenance: the producer output fields actually plucked
   *  across this edge (`["verdict"]` where the consumer read `(:verdict …)`).
   *  Absent when the whole value flowed unprojected. The blueprint per-property
   *  "pin" of the wire; carried verbatim from the statechart. See
   *  `ChartEdge.fields` for the spec-derived rule and the v0 capture bound. */
  fields?: string[];
}

export interface FlowGraph {
  nodes: FlowGraphNode[];
  edges: FlowGraphEdge[];
  /** MDL bit-budget of the chosen grouping (caption / debug). */
  totalBits: number;
  /** Fully-expanded raw bits — the compression anchor (`totalBits <= rawBits`). */
  rawBits: number;
  /** Non-fatal correlation issues (scope-id collisions). Empty in the common
   *  case; surfaced rather than hidden. */
  warnings: string[];
}

/** Causal cone over the flow-graph's directed edges (ignoring `kind` — a
 *  loopback is a real causal edge). `forward` = blast radius; `backward` = why.
 *  Self is never included; cycles terminate via the visited set. Mirrors
 *  statechart's `cone`, in the flow-graph's string id space (what the renderer
 *  selects on). */
function flowCone(graph: FlowGraph, startId: string, direction: "forward" | "backward"): Set<string> {
  const adj = new Map<string, string[]>();
  for (const e of graph.edges) {
    const [from, to] = direction === "forward" ? [e.from, e.to] : [e.to, e.from];
    (adj.get(from) ?? adj.set(from, []).get(from)!).push(to);
  }
  const out = new Set<string>();
  const queue = [startId];
  while (queue.length > 0) {
    for (const next of adj.get(queue.shift()!) ?? []) {
      if (next === startId || out.has(next)) continue;
      out.add(next);
      queue.push(next);
    }
  }
  return out;
}

/** Blast radius: every node that re-fires if the given node changes. */
export const flowForwardCone = (graph: FlowGraph, id: string): Set<string> => flowCone(graph, id, "forward");

/** Causal why: every node whose output flowed into the given node. */
export const flowBackwardCone = (graph: FlowGraph, id: string): Set<string> => flowCone(graph, id, "backward");
