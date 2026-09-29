// @inhuman.tools/arrival/r7rs/control — doors-only for control/dynamics omissions.
// R7RS-small §6.10 (call/cc, dynamic-wind), §4.2.6 (parameters), §4.2.5 (delay/force).
//
// Pure dataflow: every value carries construction-site lineage. Continuations,
// dynamic binding, and delayed evaluation tie identity to re-entry or force-time —
// no construction site to root lineage. Omitted by design; each door names the
// why and the supported alternative.
//
// Shared rationale (control-extent identity) → one section pack, not co-located with
// type packs. map/for-each live in lists; multi-return in binding. Sole definition
// site via r7rs/index → base-packs (all notImplemented; no bake/FV surface).

import { EnvCapability } from "../../common/capability.js";

export default EnvCapability.define("scheme/r7rs/control", {
  symbols: (symbol) => ({
    // §6.10 First-class continuations — non-local re-entry severs construction-site grounding.
    "call/cc": symbol.notImplemented`call/cc: first-class continuations are omitted from arrival by design — non-local re-entry severs value provenance, leaving no single construction site to root lineage at; for early exit use guard / raise (R7RS §6.11, supported)`,
    "call-with-current-continuation": symbol.notImplemented`call-with-current-continuation: first-class continuations are omitted from arrival by design — non-local re-entry severs value provenance, leaving no single construction site to root lineage at; for early exit use guard / raise (R7RS §6.11, supported)`,
    "dynamic-wind": symbol.notImplemented`dynamic-wind: omitted from arrival by design — degenerate without call/cc, and its before/after extent is dynamic state the dataflow engine cannot linearize; for teardown use (guard (e (#t (cleanup) (raise e))) ...)`,

    // §4.2.6 Dynamic bindings — identity tied to call-time extent, not construction.
    "make-parameter": symbol.notImplemented`make-parameter: dynamic binding is omitted from arrival by design — it ties a value's identity to call-time extent, not to where it was constructed; pass the value explicitly / thread it through your dataflow`,
    parameterize: symbol.notImplemented`parameterize: dynamic binding is omitted from arrival by design — it ties a value's identity to call-time extent, not to where it was constructed; pass the value explicitly / thread it through your dataflow`,

    // §4.2.5 Delayed evaluation — identity deferred to force-time, not construction.
    delay: symbol.notImplemented`delay: delayed evaluation is omitted from arrival by design — it defers a value's identity to force-time and the dynamic extent alive then, not to where it was constructed; compute the value where you need it`,
    force: symbol.notImplemented`force: delayed evaluation is omitted from arrival by design — it defers a value's identity to force-time and the dynamic extent alive then, not to where it was constructed; compute the value where you need it`,
    "make-promise": symbol.notImplemented`make-promise: delayed evaluation is omitted from arrival by design — it defers a value's identity to force-time and the dynamic extent alive then, not to where it was constructed; compute the value where you need it`,
    "delay-force": symbol.notImplemented`delay-force: delayed evaluation is omitted from arrival by design — it defers a value's identity to force-time and the dynamic extent alive then, not to where it was constructed; compute the value where you need it`,
    "promise?": symbol.notImplemented`promise?: delayed evaluation is omitted from arrival by design — with delay/force/make-promise/delay-force all doored (§4.2.5), no promise value can exist to test; there is nothing for this predicate to recognize`,

    // §4.2.9 case-lambda — multi-arity clause dispatch not yet built; same surface as lambda.
    "case-lambda": symbol.notImplemented`case-lambda: multi-arity lambda clauses are not yet implemented — express arity dispatch with lambda + guards (cond/case on argument shape, or one procedure per arity) instead`,
  }),
});
