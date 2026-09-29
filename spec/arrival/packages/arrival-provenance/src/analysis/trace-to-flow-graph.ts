/**
 * trace → unified flow-graph: a render-ready model for an industrial flowchart
 * (React Flow + elkjs style). No studio view consumes it today — the trace views
 * render `traceToRegions`/`TraceRegionFold`; this builder is exercised by
 * arrival-chain's tests and benchmarks.
 *
 * The approved causal-statechart mockup is NOT a containment treemap — it is
 * MDL regions (loop / parallel / branch) *wrapping* Lamport-layered infer nodes,
 * connected by causal arrows (forward + `↺` loopback), with why/blast cones on
 * select. That needs BOTH graphs the kernel already builds:
 *
 *   - `traceToForest` + `collapseMDL` → the containment hierarchy + which boxes
 *     start collapsed (the anti-spaghetti optimizer). String ids
 *     (`head@line:col`, stable across runs).
 *   - `traceToStatechart` → the causal DAG: Lamport layers + forward/loopback
 *     edges + the cones. Numeric ids (representative invocation id).
 *
 * This composes the three (no new core logic) into one model with a SINGLE id
 * space — so the renderer's nodes, region nesting, and cone highlighting all
 * share keys. The only genuinely new step is the leaf↔chart correlation.
 *
 * ── why the bridge is sound ──────────────────────────────────────────────────
 * Both builders collapse by Pair identity (the same AST node entered N times).
 * A forest leaf's id is `scopeId(Pair)`; a chart node's id is the representative
 * invocation of that same Pair. So `scopeId(invById[chartNodeId].node)` is
 * exactly the forest leaf id. The map is a bijection on provenance-point Pairs.
 *
 * The one place it could fail: two DISTINCT Pairs sharing `head@line:col` (only
 * possible under macro expansion stamping identical locations). For infer/query
 * leaves this does not occur in practice (you don't write two infers at one
 * column, and macros expand to plumbing, not to multiple infer calls at one
 * source loc). We GUARD it anyway — a collision keeps the first node bridged,
 * routes the second to a distinct sentinel id (so it still renders, just without
 * a causal layer/edges), and records a non-fatal warning. Surfaced, not hidden.
 *
 * ── TCO nesting ──────────────────────────────────────────────────────────────
 * Tail-recursive loop bodies nest correctly: the forest boxes the recursive fn's
 * BODY scope (entered ×K, first call included), so the per-iteration work nests
 * under one loop box (see trace-to-forest). The causal edges are independent of
 * nesting anyway, so the graph would stay causally correct regardless.
 *
 * ── where the pure model lives ───────────────────────────────────────────────
 * The render-ready value types (`FlowGraph*`) and the causal cones moved to
 * `flow-graph.ts` — an engine-free leaf (a UI renders the graph without the
 * interpreter). They're
 * re-exported here so the barrel + existing importers keep the same surface;
 * `traceToFlowGraph` (the EvalTrace producer) stays here, where the engine is.
 */
import type { FlowGraph, FlowGraphEdge, FlowGraphNode, FlowNodeKind } from "./flow-graph.js";
import { collapseMDL, type CollapseParams } from "./mdl-collapse.js";
import { regionBoundariesFromEdges } from "./region-boundaries.js";
import { traceToStatechart } from "./statechart.js";
import { traceToForest, type CandidateBox, type ForestOptions } from "./trace-to-forest.js";
import { scopeId, type EvalTrace, type Invocation } from "@inhuman.tools/arrival/provenance";

export interface FlowGraphOptions extends ForestOptions, CollapseParams {
  /** v02-L2·C1 — an explicit `:fields` override, threaded straight to `traceToStatechart`
   *  (see there). Omitted ⇒ the statechart derives `:fields` from the static carrier
   *  (`carrierFieldEdges`), the sole source now the field-point mint is retired; tests pass
   *  a curated map here. The dag's scope-id-keyed surface keys both the same way. */
  fieldEdges?: Map<string, Set<string>>;
}

export function traceToFlowGraph(trace: EvalTrace, opts: FlowGraphOptions = {}): FlowGraph {
  const forest = traceToForest(trace, { promoted: opts.promoted });
  const { decisions, totalBits, rawBits } = collapseMDL(forest, { lambda: opts.lambda });
  const chart = traceToStatechart(trace, { fieldEdges: opts.fieldEdges });

  // Bridge chart node id (numeric rep invocation id) → forest scope id (string).
  const invById = new Map<number, Invocation>();
  for (const rec of trace.records.values()) for (const inv of rec.bindings) invById.set(inv.id, inv);

  const warnings: string[] = [];
  const scopeIdOfChart = new Map<number, string>(); // chart id → (bridged) scope id
  const claimedBy = new Map<string, number>(); // scope id → first chart id that claimed it
  for (const node of chart.nodes) {
    const inv = invById.get(node.id);
    const sid = inv ? scopeId(inv.node) : `#${node.id}`;
    const prior = claimedBy.get(sid);
    if (prior !== undefined && prior !== node.id) {
      warnings.push(
        `scope-id collision: "${sid}" maps to chart nodes ${prior} and ${node.id} ` +
          `(distinct AST Pairs at one source location); causal layer/edges kept on the first.`,
      );
      scopeIdOfChart.set(node.id, `${sid}#${node.id}`); // distinct sentinel ⇒ unbridged
      continue;
    }
    claimedBy.set(sid, node.id);
    scopeIdOfChart.set(node.id, sid);
  }

  // Layer per bridged leaf (sentinel ids carry no layer).
  const layerOf = new Map<string, number>();
  for (const node of chart.nodes) {
    const sid = scopeIdOfChart.get(node.id)!;
    if (claimedBy.get(sid) === node.id) layerOf.set(sid, node.layer);
  }

  // Flatten the forest into nodes (regions + leaves), parentId from nesting.
  const nodes: FlowGraphNode[] = [];
  const walk = (box: CandidateBox, parentId: string | null): void => {
    const kind: FlowNodeKind = box.children.length > 0 ? "region" : "leaf";
    nodes.push({
      id: box.id,
      kind,
      boxType: box.type,
      parentId,
      label: box.id.split("@")[0] ?? box.id,
      count: Math.max(1, Math.round(box.n)),
      layer: layerOf.has(box.id) ? layerOf.get(box.id)! : null,
      collapsedByDefault: (decisions.get(box.id) ?? "expanded") === "collapsed",
      forced: box.force === "collapsed",
    });
    for (const child of box.children) walk(child, box.id);
  };
  for (const root of forest) walk(root, null);

  // Lift causal edges to scope ids (drop any touching a collision sentinel).
  const edges: FlowGraphEdge[] = [];
  for (const e of chart.edges) {
    const from = scopeIdOfChart.get(e.from);
    const to = scopeIdOfChart.get(e.to);
    if (from === undefined || to === undefined || from.includes("#") || to.includes("#")) continue;
    edges.push(e.fields ? { from, to, kind: e.kind, fields: e.fields } : { from, to, kind: e.kind });
  }

  // Region boundaries (region-model): attach each region's entrance/exit — the
  // producers crossing its scope. Same pure derivation the naive builder runs,
  // over the SAME forest + lifted edges (no recompute): the render draws these as
  // ports when the region is collapsed. Computed over the full forest hierarchy,
  // so a region carries its boundary whether or not the MDL pass folded it.
  const boundaries = new Map(regionBoundariesFromEdges(forest, edges).map((b) => [b.id, b] as const));
  for (const node of nodes) {
    const b = boundaries.get(node.id);
    if (b && (b.entrance.length > 0 || b.exit.length > 0)) {
      node.entrance = b.entrance;
      node.exit = b.exit;
    }
  }

  return { nodes, edges, totalBits, rawBits, warnings };
}
