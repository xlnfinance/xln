// @inhuman.tools/arrival/r7rs/binding — purity doors for binding-site omissions:
// set! (§4.1.6) + multi-return surface (§6.10 / §4.2.2 / §5.3.3). Same family as
// call/cc (r7rs/control): one expression → one value. implement-or-door for every
// name here. apply/map stay in lists; exceptions stay live.
import { EnvCapability } from "../../common/capability.js";

const MULTI_RETURN =
  "multiple-value returns are omitted from arrival by design — free multi-return packaging and its binders are the weak form of continuation arity (R7RS §6.10 / §4.2.2 / §5.3.3, same family as call/cc); a value's identity is a single construction site, not a multi-return package. Return a list / vector / dict (one structured product) instead";

export default EnvCapability.define("scheme/r7rs/binding", {
  symbols: (symbol) => ({
    "set!": symbol.notImplemented`set!: set! mutates — violates value provenance (R7RS §4.1.6 omitted) — arrival is pure dataflow; rebinding a variable severs the lineage a value carries from its binding site. Bind a fresh name (let / letrec / define in a new scope) or thread the value through your dataflow instead`,
    values: symbol.notImplemented`values: ${MULTI_RETURN}`,
    "call-with-values": symbol.notImplemented`call-with-values: ${MULTI_RETURN}`,
    "let-values": symbol.notImplemented`let-values: ${MULTI_RETURN}`,
    "let*-values": symbol.notImplemented`let*-values: ${MULTI_RETURN}`,
    "define-values": symbol.notImplemented`define-values: ${MULTI_RETURN}`,
  }),
});
