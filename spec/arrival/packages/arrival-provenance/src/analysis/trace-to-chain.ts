/**
 * trace → UNGROUPED provenance chain — the dead-simplest causal model: one node
 * per provenance-point INVOCATION (every actual infer call), one edge per
 * upstream→consumer flow. No collapse-by-scope (that's the statechart / flow-graph
 * — set aside here), no regions, no MDL. The rawest "what we're working with":
 * the literal chain of calls and what fed what.
 *
 * Edge rule (same as the statechart, kept ungrouped): an infer's own
 * `.provenance` is the singleton `{self}`, so the upstream of X lives one level
 * down — `⋃ child.provenance` over X's direct children, intersected with the
 * point set. Every id in that union is another provenance point (non-points never
 * emit their own id). snapshotTrace materializes `.provenance` exactly for
 * point-children, which is precisely what we read.
 *
 * Layering: ungrouped, provenance flows from earlier to later invocations (a
 * producer's id < its consumer's), so the graph is an acyclic DAG — no loopbacks
 * to classify. Lamport layer = longest upstream chain.
 *
 * O(points · children · provenance) — fine at small budgets; this is a v0 to SEE
 * the structure, not the scaled production path (that's the statechart's job, once
 * its O(n²) build is addressed).
 */
import { userCallSite, snapshotTrace, type EvalTrace } from "@inhuman.tools/arrival/provenance";

export interface ChainNode {
  /** The invocation id (one node per actual call — not collapsed by scope). */
  id: number;
  /** Display label — the call's scope id (`head@line:col`), so distinct infer
   *  sites (analyze vs decide) read apart even when ungrouped. */
  label: string;
  /** Lamport causal depth: longest upstream provenance chain. 0 = a source. */
  layer: number;
}

export interface ChainEdge {
  /** Upstream producer invocation id. */
  from: number;
  /** Downstream consumer invocation id. */
  to: number;
}

export interface ProvenanceChain {
  nodes: ChainNode[];
  edges: ChainEdge[];
  /** Max layer + 1; 0 if empty. */
  layerCount: number;
}

export function traceToChain(trace: EvalTrace): ProvenanceChain {
  const snap = snapshotTrace(trace);
  const points = snap.invocations.filter((i) => i.isProvenancePoint);
  const pointIds = new Set(points.map((p) => p.id));

  // upstream(X) = the points feeding X = ⋃ over X's children of child.provenance,
  // ∩ points, minus X itself (X's own subtree carries X's id past the override).
  // Under FORWARD (the field-point mint is retired), a value read across the
  // structured-output membrane (`(:verdict (car reactions))`, `(:next …)`) forwards
  // the producer's own point rather than a field-point that truncates to it — so each
  // provenance id IS already its origin point (no `fieldPointMeta` walk needed).
  const upstreamOf = new Map<number, number[]>();
  for (const x of points) {
    const up = new Set<number>();
    for (const child of x.children) {
      for (const p of child.provenance) {
        if (p !== x.id && pointIds.has(p)) up.add(p);
      }
    }
    upstreamOf.set(x.id, [...up]);
  }

  // Lamport layer via memoized longest-upstream-path. The `0` pre-seed guards a
  // (theoretically impossible) cycle from recursing forever.
  const layerOf = new Map<number, number>();
  const layer = (id: number): number => {
    const cached = layerOf.get(id);
    if (cached !== undefined) return cached;
    layerOf.set(id, 0);
    const up = upstreamOf.get(id) ?? [];
    const L = up.length === 0 ? 0 : Math.max(...up.map(layer)) + 1;
    layerOf.set(id, L);
    return L;
  };

  // A `.prompt` point mints on the resolver-generated `(infer/run …)` form (its own
  // `scope` carries `@dotprompt:<path>`, not the user's call site) — project through
  // `userCallSite` so the label reads as the real `(run-x …)` invocation's scope.
  const nodes: ChainNode[] = points.map((p) => ({ id: p.id, label: userCallSite(p).scope, layer: layer(p.id) }));
  const edges: ChainEdge[] = [];
  for (const [to, ups] of upstreamOf) for (const from of ups) edges.push({ from, to });
  const layerCount = nodes.reduce((m, n) => Math.max(m, n.layer + 1), 0);
  return { nodes, edges, layerCount };
}
