// @inhuman.tools/arrival-provenance/reflect — the query layer over a finished run.
//
// Opt-in subpath, NOT re-exported from `.`. The default entry stays capture +
// forest + regions; `/analysis` is diagrams; `/verdict` is the host-side seal.
// This subpath is the named projections of those (`why`/`where`/`how`/`dag`/
// `blast` over `buildSlice` / the flow graph) plus the ResultHandle they read,
// the wire-safe choke, and the `arrival/reflect` capability that binds them as
// Scheme verbs. InferBinding cost/content sidecars stay in @inhuman.tools/llm-plane/cost.

export {
  ResultHandle,
  is_result_handle,
  type AttestedField,
  type AttestedLeaf,
  type AttestedLeafVerdict,
  type FieldPath,
  type ResultHandleCapabilities,
} from "./reflect/result-handle.js";
export {
  whyOf,
  whereOf,
  howOf,
  dagOf,
  blastOf,
  circuitOf,
  groundedOf,
  attestOf,
  parseFieldPathArg,
  renderFieldPath,
  REFLECT_VERBS,
  type ReflectVerb,
} from "./reflect/handle-provenance.js";
export { isWireSafe, assertWireSafe, WireUnsafeError } from "./reflect/wire-safe.js";
export { arrivalReflectCapability } from "./reflect/capability.js";
