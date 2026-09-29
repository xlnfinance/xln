// `@inhuman.tools/arrival/capabilities` — opt-in EnvCapability packs a host roots in
// `exec({ capabilities })` / a plane's `deps`. Pure named re-exports so tree-shaking
// drops unused packs (`sideEffects: false`). Base scheme/* packs are NOT here — they
// fold automatically via BASE_ROSTER. `(require …)` lives in
// `@inhuman.tools/arrival-modules`.
//
// Double-layer: import from this barrel, or from a leaf for a single pack:
//   import { overridableCapability } from "@inhuman.tools/arrival/capabilities";
//   import { overridableCapability } from "@inhuman.tools/arrival/capabilities/overridable";

export { overridableCapability } from "../env/overridable/overridable.js";
export { schemaCapability } from "../env/schema/schema.js";
