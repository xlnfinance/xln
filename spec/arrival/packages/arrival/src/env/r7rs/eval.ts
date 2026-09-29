// @inhuman.tools/arrival/r7rs/eval — R7RS §6.12 Eval (doors-only).
//
// Lineage: R7RS-small §6.12 — eval, environment, null-environment,
// scheme-report-environment, interaction-environment.
//
// Pure dataflow + closed sandbox: reifying an environment object and feeding
// arbitrary expressions through eval would mint values with no construction-site
// lineage and open an ambient code path the membrane cannot close. Each name is a
// permanent-omission `symbol.notImplemented` door (sandbox + reification).
//
// SINGLE SOURCE: `r7rs/index.ts` adds this to `allR7rs` → `base-packs.ts`.

import { EnvCapability } from "../../common/capability.js";

const EVAL =
  "eval is omitted from arrival by design — evaluating reified code at runtime mints values with no construction-site lineage and escapes the closed sandbox surface; compose dataflow over known procedures instead";
const REIFY =
  "environment reification is omitted from arrival by design — a first-class environment object would expose and re-enter the binding plane as ambient state with no construction-site lineage; the assembled capability env is the only surface, not a reifiable value";

export const EVAL_DOOR_NAMES = [
  "eval",
  "environment",
  "null-environment",
  "scheme-report-environment",
  "interaction-environment",
] as const;

export default EnvCapability.define("scheme/r7rs/eval", {
  symbols: (symbol) => ({
    eval: symbol.notImplemented`eval: ${EVAL}`,
    environment: symbol.notImplemented`environment: ${REIFY}`,
    "null-environment": symbol.notImplemented`null-environment: ${REIFY}`,
    "scheme-report-environment": symbol.notImplemented`scheme-report-environment: ${REIFY}`,
    "interaction-environment": symbol.notImplemented`interaction-environment: ${REIFY}`,
  }),
});
