/**
 * deep-restamp.ts — the CHILD recursion behind `arrival/withProvenanceDeep` (the inbound
 * membrane's deep re-stamp term, declared optional on AValue beside `arrival/toJS`).
 *
 * A spine carrier (APair / AVector) re-stamps by MINTING a fresh spine whose children are
 * re-stamped through THIS fold; every other carrier re-stamps shallowly via its own
 * `withProvenance` (borrowed wrappers stay lazy — their entries pick the stamp up on
 * access). The fold is CLOSED over what a spine child can be at runtime (the SchemeValue
 * union), so the recursion needs no `unknown` router re-entry and no casts. That is why the
 * term lives on the classes rather than an `unknown`-typed router: a router cannot see a
 * class's internal representation, so it must cast; the class, closed over its own children,
 * never does.
 *
 * Behavior:
 *  - same-provenance / empty-provenance children pass through by identity;
 *  - `seen` terminates cyclic spines: re-encounter returns AS-IS (outer clone already
 *    stamped); shared/diamond past first occurrence keeps original box;
 *  - residual bare JS function in a spine → #void + warn (not a fresh crossing; inbound
 *    mints ARosettaProcedure via hostFnToCallable — docs/membrane.md §CALLABLE-LENS);
 *  - non-AValue orphans (R7RSError) carry no provenance → identity.
 *
 * Leaf-ish module: imports the AValue base, the #void singleton and the membrane warn
 * flag — never the router (rosetta.ts), so APair/AVector can import it without widening
 * their existing benign cycles.
 */
import type { RunContext } from "../../run/RunContext.js";
import type { SchemeValue } from "../types.js";
import { AValue, EMPTY_PROVENANCE, mergeProvenance } from "./AValue.js";
import { theVoid } from "./AVoid.js";
import { ANil, nil } from "./ANil.js";
import { warnMembrane } from "../../membrane/membrane-warn.js";

/** Re-stamp ONE spine child. The caller (a carrier's own `arrival/withProvenanceDeep`)
 *  threads its `seen` set so mutual/cyclic spines terminate co-inductively. */
export function reStampChild(
  child: SchemeValue,
  ctx: RunContext,
  p: ReadonlySet<number>,
  seen: WeakSet<object>,
): SchemeValue {
  // The two host bottoms. `undefined` is REACHABLE — the empty-pair sentinel carries
  // `car === undefined` at runtime (APair's iterator documents it) — and takes the same
  // warn+#void crossing every inbound undefined does; `null` (type-impossible,
  // runtime-defensive) maps to nil.
  if (child === undefined) {
    warnMembrane("a JS `undefined`");
    return theVoid;
  }
  if (child === null) return p === EMPTY_PROVENANCE ? nil : new ANil(p);
  // Residual bare-fn already in a spine — re-stamp, not a fresh js→scheme crossing.
  if (typeof child === "function") {
    warnMembrane("a JS function");
    return theVoid;
  }
  if (seen.has(child)) return child;
  seen.add(child);
  // Non-AValue orphans (R7RSError): no provenance slot → identity.
  if (!(child instanceof AValue)) return child;
  if (p === EMPTY_PROVENANCE || p === child.provenance) return child;
  // THE ADDITIVE LAW (docs/membrane.md §INBOUND): union the crossing's ids onto the child's own
  // origin, never substitute — erasing breaks `origin ⊇ dependencies` and uneval's slice soundness.
  const merged = mergeProvenance(child.provenance, p);
  if (merged === child.provenance) return child;
  const deep = child["arrival/withProvenanceDeep"];
  return deep === undefined ? child.withProvenance(merged) : deep.call(child, ctx, p, seen);
}
