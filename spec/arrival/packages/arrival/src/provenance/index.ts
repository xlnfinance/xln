// `@inhuman.tools/arrival/provenance` — P12 capture spine + prospective wireframe.
// MobX-free: captures a finished trace; never drives the evaluator.
//
// Surfaces:
//   - Trace capture — `EvalTrace` / `Invocation` / `NodeRecord` / `snapshotTrace`
//   - Scope identity — `scopeId` / `headOf` / `userCallSite`
//   - Wireframe plane — `buildWireframe`, slice/defines, `hermeticApply` (γ)
//   - Lineage classifier — `classify` / `fieldResolve` (static plane + analysis consumers)
//
// Reactive `ObservableEvalTrace` lives in `@inhuman.tools/arrival-provenance`
// (overrides `bumpEntries`/`entries`; see `trace.ts`). Forest/region/flow-graph
// analysis lives there under `/analysis`, not here.

export { EvalTrace, Invocation, NodeRecord, DEFAULT_TRACE_CAP, type InvocationState } from "./trace.js";
export { snapshotTrace, type PlainTrace, type PlainInv } from "./trace-snapshot.js";
export { headOf, scopeId, userCallSite } from "./scope-id.js";

// ── Primitive layer (re-exported by arrival-provenance's default entry) ──
export type { SourceLocation } from "../errors.js";
export {
  buildSlice,
  writeForm,
  referencedSymbols,
  defineNameOf,
  lastTopLevelForm,
  resolveReadIds,
  type Slice,
} from "./slice.js";
export {
  type DefineTemplate,
  type EmittedWire,
  type Wire,
  type WireConsumer,
  type WireFact,
  type WireParam,
  type WireSlot,
  type WireframeGraph,
  type WireframeNode,
  type WireframeProgram,
} from "./wireframe/types.js";
export { buildWireframe, type WireframeBuildOptions } from "./wireframe/builder.js";
export { hermeticApply, type HermeticApplyOptions } from "./gamma.js";

// Cross-package reads from arrival-provenance `/analysis` (lineage engine stays core).
export { classify, fieldResolve, type LineageNode, type Bindings, type Classifier } from "./lineage.js";
export { slotsOf, type AutoBindings } from "./lineage-auto-bindings.js";
