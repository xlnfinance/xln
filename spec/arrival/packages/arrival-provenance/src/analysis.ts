// @inhuman.tools/arrival-provenance/analysis — the opt-in full-build analysis
// surface: render-models (statechart / flow graph / forest-collapse) plus
// the reverse-chain slicer (uneval/slice). The default `.` entry (see
// `index.ts`) stays the capture + region-model primitives (trace, forest,
// regions) — this subpath is for consumers that need the heavier
// render/analysis stack on top of a trace.
//
// Per the provenance analysis-stack relocation, every render-model producer
// below is now a NATIVE local module (`./analysis/*`) instead of a re-export
// of core's `/provenance` subpath — this package owns the analysis stack.
// `buildSlice`/`writeForm`/etc (slice.ts) stay re-exports of core: `slice.ts`
// itself stayed in core (a wireframe-adjacent static-plane dependency, not
// analysis) — only the two names above the line moved, not their source.
//
// Note: `CandidateBox`/`BoxType` are intentionally NOT re-exported here — they
// belong to the primitive layer (`./analysis/trace-to-forest.js`, re-exported from
// the default `.` entry) since they describe the forest's own candidate-box
// vocabulary, not an analysis-only concept.

export {
  traceToStatechart,
  forwardCone,
  backwardCone,
  type Statechart,
  type ChartNode,
  type ChartEdge,
  type EdgeKind,
} from "./analysis/statechart.js";
export { carrierFieldEdges } from "./analysis/carrier-fields.js";
export {
  traceToLineage,
  producerPluckFields,
  wireOpChains,
  type LineageGraph,
  type LineageWire,
} from "./analysis/trace-to-lineage.js";
export { collapseMDL, type CollapseParams, type CollapseResult } from "./analysis/mdl-collapse.js";
export { traceToFlowGraph, type FlowGraphOptions } from "./analysis/trace-to-flow-graph.js";
export {
  flowForwardCone,
  flowBackwardCone,
  type FlowGraph,
  type FlowGraphNode,
  type FlowGraphEdge,
  type FlowNodeKind,
} from "./analysis/flow-graph.js";
export { traceToChain, type ProvenanceChain, type ChainNode, type ChainEdge } from "./analysis/trace-to-chain.js";
export { regionBoundaries, type RegionBoundary } from "./analysis/region-boundaries.js";
export {
  buildSlice,
  writeForm,
  referencedSymbols,
  defineNameOf,
  lastTopLevelForm,
  resolveReadIds,
  type Slice,
} from "@inhuman.tools/arrival/provenance";
export { buildUneval, type Uneval, type UnevalContainer } from "./analysis/uneval.js";
