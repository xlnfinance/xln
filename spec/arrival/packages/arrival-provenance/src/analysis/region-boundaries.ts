/**
 * Region boundaries — the region-model's first-class boundary.
 *
 * Derives, for each control-operator REGION, the producers that cross its
 * boundary: `entrance` (external producers feeding its internals — the "dive-in")
 * and `exit` (internal producers feeding outside). This is what turns a region
 * from a transparent passthrough into a first-class boundary, and it's a PURE
 * derivation over what we already compute — the forest (region tree) + the
 * statechart's point→point causal edges. No interpreter change, no new trace data.
 *
 * The rule is just edge-vs-membership: an edge `P→C` is an ENTRANCE of every
 * region that contains the consumer `C` but not the producer `P`, and an EXIT of
 * every region that contains `P` but not `C`. (The cohort's convergent region
 * model — RVSDG region ports, PROV Activity `used`/`wasGeneratedBy`, Naiad
 * ingress/egress — is exactly "what crosses the scope boundary".) This is the real
 * boundary, computed once — not elk-layout's "lift each edge to the nearest visible
 * ancestor" heuristic.
 */
import { traceToStatechart } from "./statechart.js";
import { snapshotTrace, type PlainInv, scopeId, type EvalTrace } from "@inhuman.tools/arrival/provenance";
import { traceToForest, type CandidateBox } from "./trace-to-forest.js";

export interface RegionBoundary {
  /** The region's structural scope id (`head@line:col`). */
  id: string;
  /** Display label — the region's leading symbol (`map`, `filter`, `let`…). */
  label: string;
  /** External producer scope-ids whose values flow INTO this region (sorted). */
  entrance: string[];
  /** Internal producer scope-ids whose values flow OUT of this region (sorted). */
  exit: string[];
}

const headOf = (sid: string): string => sid.split("@")[0] ?? sid;

/**
 * Core derivation, over the forest + scope-id edges. Builders that already hold a
 * forest + their lifted (scope-id) edges call this directly — no recompute.
 */
export function regionBoundariesFromEdges(
  forest: readonly CandidateBox[],
  edges: ReadonlyArray<{ from: string; to: string }>,
): RegionBoundary[] {
  // Forest tree → ancestorsOf[sid] = the container regions enclosing that scope,
  // outermost-first. A region is any box that nests other boxes.
  const ancestorsOf = new Map<string, string[]>();
  const regions = new Set<string>();
  const walk = (box: CandidateBox, ancestors: string[]): void => {
    ancestorsOf.set(box.id, ancestors);
    const isRegion = box.children.length > 0;
    if (isRegion) regions.add(box.id);
    const childAncestors = isRegion ? [...ancestors, box.id] : ancestors;
    for (const child of box.children) walk(child, childAncestors);
  };
  for (const root of forest) walk(root, []);

  const entrance = new Map<string, Set<string>>();
  const exit = new Map<string, Set<string>>();
  const add = (m: Map<string, Set<string>>, region: string, producer: string): void => {
    (m.get(region) ?? m.set(region, new Set<string>()).get(region)!).add(producer);
  };
  for (const { from, to } of edges) {
    const fromAncestors = ancestorsOf.get(from) ?? [];
    const toAncestors = ancestorsOf.get(to) ?? [];
    const fromSet = new Set(fromAncestors);
    const toSet = new Set(toAncestors);
    for (const r of toAncestors) if (!fromSet.has(r)) add(entrance, r, from); // crosses IN
    for (const r of fromAncestors) if (!toSet.has(r)) add(exit, r, from); //     crosses OUT
  }

  return [...regions].map((id) => ({
    id,
    label: headOf(id),
    entrance: [...(entrance.get(id) ?? [])].sort(),
    exit: [...(exit.get(id) ?? [])].sort(),
  }));
}

/** Standalone: derive every region's boundary directly from a trace. */
export function regionBoundaries(trace: EvalTrace): RegionBoundary[] {
  const forest = traceToForest(trace);
  const chart = traceToStatechart(trace);
  const snap = snapshotTrace(trace);

  const invById = new Map<number, PlainInv>();
  for (const inv of snap.invocations) invById.set(inv.id, inv);

  const edges: { from: string; to: string }[] = [];
  for (const e of chart.edges) {
    const from = invById.get(e.from);
    const to = invById.get(e.to);
    if (from && to) edges.push({ from: scopeId(from.node), to: scopeId(to.node) });
  }
  return regionBoundariesFromEdges(forest, edges);
}
