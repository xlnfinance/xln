// SRFI-8 — receive only. Multi-return sugar over call-with-values; both purity-doored
// (same family as call/cc). All-or-nothing: door the sole export.
// Destructure products instead: (let ((p (floor/ 7 2))) …) / (partition …).
import { EnvCapability } from "../../common/capability.js";

export default EnvCapability.define("scheme/srfi-8", {
  symbols: (symbol) => ({
    receive: symbol.notImplemented`receive: multiple-value returns are omitted from arrival by design — free multi-return packaging and its binders are the weak form of continuation arity (R7RS §6.10 / SRFI-8, same family as call/cc); a value's identity is a single construction site, not a multi-return package. Return a list / vector / dict and destructure with let / car+cdr instead`,
  }),
});
