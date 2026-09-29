// @inhuman.tools/arrival-provenance — the trace-capture substrate + the
// render-model ANALYSIS stack (forest, region tree, statechart, flow graph,
// MDL forest-collapse, reverse-chain slicer) that turns a finished trace
// into diagrams. Reads finished traces; never drives the evaluator.
//
// Per the provenance analysis-stack relocation, this package now OWNS the
// analysis stack natively (`./analysis/*`) instead of re-exporting it from
// core's `/provenance` subpath — core keeps only the capture spine + static
// wireframe plane (`@inhuman.tools/arrival/provenance`), which this default
// entry still draws its capture-primitive re-exports from. Subpaths:
// default / `/analysis` / `/verdict` / `/reflect`. `/reflect` is not
// re-exported from here — opt in at the subpath.
//
// The only non-passthrough export is `EvalTrace`: this file keeps the local
// mobx-reactive `ObservableEvalTrace` (from `./trace.js`) so studio/UI
// consumers keep byte-identical reactive semantics without core taking on
// a mobx dependency.

export { EvalTrace, Invocation, NodeRecord, type InvocationState } from "./trace.js";
export { scopeId, type SourceLocation } from "@inhuman.tools/arrival/provenance";
export {
  traceToForest,
  type ForestOptions,
  type CandidateBox,
  type BoxType,
  type Decision,
} from "./analysis/trace-to-forest.js";
export { traceToRegions, type Region, type RegionGraph } from "./analysis/trace-to-regions.js";
// Incremental twin of `traceToRegions` — maintains the same RegionGraph in O(Δ) per streamed tick (vs O(N) full rebuild) for the live blueprint render. Parity-locked to traceToRegions.
export { TraceRegionFold } from "./analysis/trace-region-fold.js";
export {
  serializeTrace,
  loadTraceArtifact,
  TRACE_PROTOCOL_VERSION,
  type TraceArtifact,
} from "./analysis/trace-artifact.js";
// Plain (serializable) trace snapshot + structural clone — consumed by trace
// tooling and tests that round-trip a trace without the mobx-reactive class.
// (`snapshotTrace` accepts core's plain `EvalTrace`; this package's
// `ObservableEvalTrace` is a subclass, so passing either works.)
export { snapshotTrace, type PlainTrace, type PlainInv } from "@inhuman.tools/arrival/provenance";
