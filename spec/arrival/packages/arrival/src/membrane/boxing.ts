import invariant from "tiny-invariant";
import type { RunContext } from "../run/RunContext.js";
import { NoLensError } from "../errors.js";
import { AValue, EMPTY_PROVENANCE } from "../values/primitives/AValue.js";
import { AString } from "../values/primitives/AString.js";
import { AExact } from "../values/primitives/AExact.js";
import { AInexact } from "../values/primitives/AInexact.js";
import { ABool, schemeFalse, schemeTrue } from "../values/primitives/ABool.js";
import { ANil } from "../values/primitives/ANil.js";
import { AVoid } from "../values/primitives/AVoid.js";
import { AJSArray } from "./AJSArray.js";
import { AJSObject } from "./AJSObject.js";
import { hostFnToCallable, originalCallableOf } from "../values/primitives/ACallable.js";

/**
 * JS → Scheme boxing: a single `typeof`-tag switch that constructs the right AValue
 * subtype for a raw host value (already-AValue short-circuits). Tag set is JS's fixed
 * typeof family + the two null-ish tags — closed, no plugins.
 *
 * A single switch, not a registry: subtypes already extend AValue; object/function
 * boxers are plain construction. The function arm mints via hostFnToCallable — the
 * SAME reverse-membrane lens rosetta's INBOUND_CLAIMS function row uses (one mechanism,
 * two entry points; docs/membrane.md §CALLABLE-LENS is the law). Checks
 * originalCallableOf first so a reverse-membrane wrapper crossing back in re-admits as
 * its original callable.
 *
 * Host bigint DOORS (NoLensError `"bigint"`) — same spirit as unique-symbol. Exact
 * numbers are safe-int ratios; convert with Number/bigintToNumber in the safe range
 * before re-crossing. Codecs that speak bigint (`z.bigint`) encode to AExact BEFORE
 * the membrane and never reach here.
 */
export function fromJs(ctx: RunContext, v: unknown, provenance: ReadonlySet<number> = EMPTY_PROVENANCE): AValue {
  // Same-instance fast path. Re-stamp only when a distinct non-empty provenance is supplied.
  if (v instanceof AValue) {
    if (provenance === EMPTY_PROVENANCE || provenance === v.provenance) return v;
    // withProvenance is typed to the broad SchemeValue union; a clone of an AValue is
    // always an AValue subclass at runtime — narrow with a guard, not a cast.
    const restamped = v.withProvenance(provenance);
    invariant(restamped instanceof AValue, "fromJs: withProvenance must mint an AValue");
    return restamped;
  }

  if (v === null) {
    // null → nil (empty list); undefined → void: two host bottoms map to two Scheme absences.
    return new ANil(provenance);
  }
  switch (typeof v) {
    case "string":
      return new AString(v, provenance);
    case "number":
      // Safe-integer → exact (both AExact components are plain numbers); beyond
      // MAX_SAFE_INTEGER → inexact. Never a silent out-of-range exact
      // (mint-numeric crash-on-overflow is for ARITHMETIC; bare host number ingress
      // stays status-based).
      return Number.isSafeInteger(v) ? new AExact(v, 1, provenance) : new AInexact(v, provenance);
    case "bigint":
      // No lens — exact numbers are safe-int ratios; raw bigint never enters scheme.
      throw new NoLensError("bigint");
    case "boolean":
      // Reuse singletons on the empty-provenance path; allocate only when stamped.
      return provenance === EMPTY_PROVENANCE ? (v ? schemeTrue : schemeFalse) : new ABool(v, provenance);
    case "undefined":
      return new AVoid(provenance);
    case "object":
      // typeof [] === "object": JS array IS R7RS vector → AJSArray; plain object → AJSObject.
      return Array.isArray(v) ? new AJSArray(v, provenance) : new AJSObject(v, provenance);
    case "function": {
      // docs/membrane.md §CALLABLE-LENS — bare host fn → reverse-membrane callable.
      // Re-admission FIRST: hostProjectionOf wrapper re-admits as ORIGINAL callable (eq?).
      const original = originalCallableOf(v as object);
      return original ?? hostFnToCallable(ctx, v as (...args: unknown[]) => unknown, provenance);
    }
    default:
      // symbol and any future tag: not boxable here (symbols cross via membrane
      // keyword/Symbol.for path). Programmer error, not a runtime one.
      invariant(false, `fromJs: no boxer for typeof tag "${typeof v}"`);
  }
}
