/**
 * op-helpers — cross-cutting leaf shared by every primitive cluster.
 *
 * Type-coercion + provenance + allocation-guard helpers. Own leaf module
 * (value-type classes, plus the run-neutral CallCtx/RunContext leaf and named
 * membrane crossing seams — never the env layer) so cluster packs import
 * without a cycle. Dependency: clusters → op-helpers → value-type classes.
 */

import invariant from "tiny-invariant";
import { CONSTANT_CTX, type RunContext } from "../run/RunContext.js";
import { makeCallCtx } from "../run/CallCtx.js";
import { ACallable, applyCallback } from "./primitives/ACallable.js";
import { currentRegionScope, isSilentRegion, recordHostScheduleVerdict } from "../membrane/region-scope.js";

import { AValue, EMPTY_PROVENANCE, unionProvenance } from "./primitives/AValue.js";
import { type ABool, schemeFalse, schemeTrue } from "./primitives/ABool.js";
import { fromJs } from "../membrane/boxing.js";
import { ABytevector } from "./primitives/ABytevector.js";
import { AString } from "./primitives/AString.js";
import { AExact } from "./primitives/AExact.js";
import { AInexact } from "./primitives/AInexact.js";
import { is_false, is_promise } from "../values/value-guards.js";
import { type ANumeric } from "./numbers.js";
import { type SchemeValue } from "./types.js";
import { ACharacter } from "./primitives/ACharacter.js";
import { attachOffendingValue, ComparatorRequiredError } from "../errors.js";
import { tf } from "./tagless-final.js";

// Eager-stamp oracle flag: withInputProvenance/mintVerdict accumulate provenance.
// TEST-ONLY oracle — OFF by default so production hot paths skip accumulation while
// boxed-value discipline stays intact. Turned ON by CI agreement oracle and tests
// that assume eager accumulation is live. Module-GLOBAL; upgrade path if a process
// needs stamped AND unstamped envs simultaneously is a RunContext-carried flag.
let eagerProvenanceOracleEnabled = false;

/** Is the eager-stamp oracle live? Default FALSE. Reports the raw AMBIENT flag only —
 *  NOT the effective in-γ state withInputProvenance also consults. */
export function isEagerProvenanceOracleEnabled(): boolean {
  return eagerProvenanceOracleEnabled;
}

/** Opt out of (or back into) eager stamp accumulation process-wide. Values still box;
 *  OFF means EMPTY provenance outside a silent region. */
export function setEagerProvenanceOracleEnabled(enabled: boolean): void {
  eagerProvenanceOracleEnabled = enabled;
}

/**
 * EFFECTIVE accumulation switch: ambient flag OR "inside a silent region right now".
 *
 * WHY the OR is load-bearing: every γ/replay face re-executes a wire's body through
 * this SAME interpreter, wrapped in `withSilentRegion`. Ingress values carry recorded
 * stamp ids; the only mechanism that unions those ids into the egress's own
 * `.provenance` is this file's accumulation. If production default is OFF and γ did
 * not force accumulation on, replay would silently produce correct-looking values with
 * EMPTY provenance — breaking the wire-γ adjunction. Gating on `isSilentRegion()`
 * means every replay path is correct BY CONSTRUCTION.
 *
 * EXPORTED because hand-rolled `unionProvenance` sites (numeric arithmetic) import
 * this instead of duplicating the OR.
 */
export function isEagerAccumulationActive(): boolean {
  return eagerProvenanceOracleEnabled || isSilentRegion();
}

// Allocation cap — DoS defense for size-parameterized constructors
// Default 2^24: worst case (~32MB UTF-16 / one 16M-slot array) is recoverable.
const allocationLimit = 1 << 24;

export function assertAllocatable(len: number, fnName: string): void {
  invariant(Number.isFinite(len) && len >= 0, `${fnName}: length must be a non-negative integer, got ${len}`);
  invariant(len <= allocationLimit, `${fnName}: requested length ${len} exceeds allocation limit ${allocationLimit}`);
}

/**
 * Unwrap an `ACharacter`. Refuses anything else — never silently mints a wrong value.
 * A blind cast on a non-character silently reads `undefined` and `chars.join("")`
 * swallows that into `""` — `(list->string '(1 2))` would look like a correct empty result.
 */
export function charValue(char: unknown): string {
  if (char instanceof ACharacter) return char.__char__;
  throw attachOffendingValue(
    new TypeError(`expected a character, got ${char instanceof AValue ? char.kind : typeof char}: ${previewOf(char)}`),
    char,
  );
}

// Container/nil kinds stringValue refuses: `String(nil)` → `"()"` is plausible-looking but WRONG.
// Leaf/scalar kinds KEEP the `String(x)` fallback.
const STRING_COERCION_REFUSED_KINDS = new Set(["pair", "nil", "vector", "object", "dict"]);

/** Best-effort short preview for a door message — never throws, truncated. */
function previewOf(v: unknown): string {
  let s: string;
  try {
    s = String(v);
  } catch {
    s = "<unprintable>";
  }
  return s.length > 40 ? `${s.slice(0, 40)}…` : s;
}

/** Unwrap AString.valueOf(); String(str) for leaf/scalar; throws for container/nil kinds. */
export function stringValue(str: unknown): string {
  if (str instanceof AString) return str.valueOf();
  if (str instanceof AValue && STRING_COERCION_REFUSED_KINDS.has(str.kind)) {
    throw attachOffendingValue(new TypeError(`expected a string, got ${str.kind}: ${previewOf(str)}`), str);
  }
  return String(str);
}

/** Coerce to index number for vector/string ops. */
export function toIndex(v: unknown): number {
  return typeof v === "number" ? v : Number((v as AExact).valueOf());
}

/** Vector PROTOCOL guard: boxed AVector or borrowed AJSArray — both answer vector? + __vector__. */
interface VectorLike {
  "arrival/tagless-final/vector?"(): boolean;
  __vector__: SchemeValue[];
}
function isVectorLike(obj: unknown): obj is VectorLike {
  return obj != null && typeof (obj as Record<string, unknown>)["arrival/tagless-final/vector?"] === "function";
}

/**
 * Resolve vector arg to raw element array (read view). Protocol dispatch —
 * anything answering `arrival/tagless-final/vector?` exposes `__vector__`.
 * Raw JS array tolerated (transitional). Throws otherwise.
 */
export function asVector(obj: unknown, fnName: string): SchemeValue[] {
  if (isVectorLike(obj)) {
    return obj.__vector__;
  }
  if (Array.isArray(obj)) return obj; // transitional raw-array tolerance
  throw attachOffendingValue(new TypeError(`${fnName}: expected vector`), obj);
}

export function asBytevector(obj: unknown, fnName: string): Uint8Array {
  switch (true) {
    case obj instanceof ABytevector:
      // Unwrap by reference: env is immutable (bytevector-u8-set! is notImplemented stub).
      return obj.__bytevector__;
    case obj instanceof Uint8Array:
      // FFI coercion: raw Uint8Array from a JS fn. Stays permanently — it's the FFI adapter.
      return obj;
    case obj instanceof ArrayBuffer:
      return new Uint8Array(obj);
    case obj instanceof DataView:
      return new Uint8Array(obj.buffer, obj.byteOffset, obj.byteLength);
    case typeof Buffer !== "undefined" && obj instanceof Buffer:
      return new Uint8Array(obj.buffer, obj.byteOffset, obj.byteLength);
    default:
      throw attachOffendingValue(new TypeError(`${fnName}: expected bytevector, got ${typeof obj}`), obj);
  }
}

// ── Fantasy Land Ord — type-agnostic ordered-comparison chain ──
// All four relations derive from the single `lte`. Nil = universal-order BOTTOM
// (SRFI-128 + Clojure). Shared by deriveSortCompare and fl-interop loose ops.

export interface AOrd {
  "arrival/tagless-final/lte"(other: unknown): boolean;
}
export const isOrd = (x: unknown): x is AOrd => x != null && typeof (x as Partial<AOrd>)[tf("lte")] === "function";
const lte = (a: AOrd, b: unknown): boolean => Boolean(a[tf("lte")](b));

const isNilValue = (x: unknown): boolean =>
  x == null || (x as { constructor?: { name?: string } })?.constructor?.name === "ANil";
export function nilOrderCompare(a: unknown, b: unknown): -1 | 0 | 1 | undefined {
  const aN = isNilValue(a);
  const bN = isNilValue(b);
  if (!aN && !bN) return undefined;
  return aN && bN ? 0 : aN ? -1 : 1;
}
export const ORD_REL: Record<"<" | ">" | "<=" | ">=", (a: AOrd, b: AOrd) => boolean> = {
  "<": (a, b) => !lte(b, a),
  ">": (a, b) => !lte(a, b),
  "<=": (a, b) => lte(a, b),
  ">=": (a, b) => lte(b, a),
};
export function deriveOrd(sym: "<" | ">" | "<=" | ">="): (...args: unknown[]) => ABool {
  const rel = ORD_REL[sym];
  return (...args: unknown[]): ABool => {
    let verdict = true;
    for (let i = 0; i < args.length - 1; i++) {
      if (!rel(args[i] as AOrd, args[i + 1] as AOrd)) {
        verdict = false;
        break;
      }
    }
    return mintVerdict(args, verdict);
  };
}

const describeOrdElement = (v: unknown): string =>
  v instanceof AValue ? v.kind : v === null || v === undefined ? String(v) : Array.isArray(v) ? "array" : typeof v;

/** Derive JS Array.sort comparator for every primitive's `arrival/tagless-final/sort`.
 *  • No comparator → operand's OWN total order via `lte`; element lacking lte throws.
 *  • Comparator present → number comparator used DIRECTLY, else SRFI-95 `less?`.
 *    Number branch REQUIRED: reading number through `!is_false` mis-orders. */
export function deriveSortCompare(
  comparator: ACallable | undefined,
  runCtx: RunContext,
): (a: SchemeValue, b: SchemeValue) => number {
  if (comparator !== undefined && comparator !== null) {
    // Comparator is a callable VALUE — invoke through the seam, not bare fn.
    // runCtx threaded for ctx-honesty. Region-scope host-schedule wiring is separate
    // (order-attribution); this only closes the metering gap.
    const call = (a: SchemeValue, b: SchemeValue) => applyCallback(comparator, [a, b], makeCallCtx(runCtx));
    // Host-schedule: sort's comparator verdict SEQUENCE is the record.
    // Element ordinals fall back to comparator CALL ORDER (Array.sort carries no index).
    let callOrdinal = 0;
    return (a, b) => {
      const v = call(a, b);
      // Lambda comparator settles as a Promise — none of the verdict branches recognize it,
      // so the is_false fallthrough would mint constant -1 (silent reverse-sort). Door instead.
      if (is_promise(v)) {
        throw attachOffendingValue(
          new TypeError(
            "sort: a lambda comparator is not supported yet (its result resolves " +
              "asynchronously) — use a native comparator directly, e.g. `(sort xs <)`, " +
              "or sort by a derived key instead of comparing with a lambda.",
          ),
          v,
        );
      }
      let verdict: number;
      if (typeof v === "number") verdict = v;
      else if (v instanceof AExact || v instanceof AInexact) verdict = Number(v.valueOf());
      else verdict = is_false(v) ? (is_false(call(b, a)) ? 0 : 1) : -1;

      const scope = currentRegionScope();
      if (scope !== undefined) {
        recordHostScheduleVerdict(scope, [callOrdinal], [callOrdinal + 1], verdict);
        callOrdinal++;
      }
      return verdict;
    };
  }
  return (a, b) => {
    const nilCmp = nilOrderCompare(a, b);
    if (nilCmp !== undefined) return nilCmp;
    if (!isOrd(a)) throw new ComparatorRequiredError(describeOrdElement(a));
    if (!isOrd(b)) throw new ComparatorRequiredError(describeOrdElement(b));
    const aLE = lte(a, b);
    const bLE = lte(b, a);
    return aLE ? (bLE ? 0 : -1) : bLE ? 1 : 0;
  };
}

// Numeric coercion into AExact/AInexact tower

/**
 * Coerce to scheme numeric. Safe ints exact; non-safe + floats inexact.
 * Host bigint doors (NoLensError at membrane) — never mint an out-of-range exact.
 * `ctx` defaults to CONSTANT_CTX; live call sites may thread their own runCtx.
 * The default is safe: minting a numeric wrapper reads no run-varying state
 * (no env, no clock, no counters) — it is run-neutral, so CONSTANT_CTX and a
 * threaded live ctx are indistinguishable at this call.
 */
export function coerceNumeric(value: unknown, _ctx: RunContext = CONSTANT_CTX): ANumeric {
  switch (true) {
    case value instanceof AExact:
    case value instanceof AInexact:
      return value;
    case typeof value === "bigint":
      throw new TypeError(
        "host bigint is not a scheme number — convert with Number/bigintToNumber in the safe range before crossing",
      );
    case typeof value === "number":
      return Number.isSafeInteger(value) ? new AExact(value) : new AInexact(value);
    case value && typeof value === "object" && "valueOf" in value && typeof value.valueOf === "function": {
      const val = value.valueOf();
      switch (true) {
        case typeof val === "bigint":
          throw new TypeError(
            "host bigint is not a scheme number — convert with Number/bigintToNumber in the safe range before crossing",
          );
        case typeof val === "number":
          return Number.isSafeInteger(val) ? new AExact(val) : new AInexact(val);
        default:
          throw new TypeError(`Cannot convert to SchemeNumeric: ${val}`);
      }
      break;
    }
    default:
      throw new TypeError(`Cannot convert to SchemeNumeric: ${value}`);
  }
}

/** Convertible to SchemeNumeric without throwing. NOT a closed type guard:
 *  valueOf arm admits any object exposing number valueOf(). Host bigint never a scheme number. */
export function isSchemeNumber(value: unknown): boolean {
  switch (true) {
    case value instanceof AExact:
    case value instanceof AInexact:
      return true;
    case typeof value === "number":
      return true;
    case value && typeof value === "object" && "valueOf" in value && typeof value.valueOf === "function": {
      const val = value.valueOf();
      return typeof val === "number";
    }
    default:
      return false;
  }
}

// Provenance stamping

/**
 * Stamp `result` with union of `args`' provenances. Cluster-pack builtins produce
 * fresh results whose provenance must inherit from inputs.
 *
 * Scalars boxed UNCONDITIONALLY (bare-value purge): inside the membrane only boxed
 * AValues. Non-scalars stay raw — structural provenance, fromJs double-wraps.
 *
 * RETURN-TYPE CAST — `fromJs(…) as T` is inherent: seam between layers modeling
 * values differently (provenance boxes; contract layer types by decoded shape).
 */
export function withInputProvenance<T>(args: readonly unknown[], result: T): T {
  // Oracle inactive skips accumulation, NOT boxing. "Inactive" is the EFFECTIVE
  // switch (ambient flag OR silent-region γ — see isEagerAccumulationActive).
  if (!isEagerAccumulationActive()) {
    if (result instanceof AValue) return result;
    const t = typeof result;
    if (t === "string" || t === "number" || t === "boolean") {
      // Host bigint is not boxable (NoLensError at fromJs).
      return fromJs(CONSTANT_CTX, result, EMPTY_PROVENANCE) as T;
    }
    return result;
  }
  const inputs = args.filter((a): a is AValue => a instanceof AValue);
  if (result instanceof AValue) {
    if (inputs.length === 0) return result;
    const prov = unionProvenance(inputs);
    return (prov.size === 0 ? result : result.withProvenance(prov)) as T;
  }
  const t = typeof result;
  if (t === "string" || t === "number" || t === "boolean") {
    const prov = inputs.length > 0 ? unionProvenance(inputs) : EMPTY_PROVENANCE;
    return fromJs(CONSTANT_CTX, result, prov) as T;
  }
  return result;
}

/** Scheme face of predicate verdict — shared flyweights (eq?-stable, empty provenance). */
export const schemeBool = (v: boolean): ABool => (v ? schemeTrue : schemeFalse);

/**
 * THE ONE boolean-verdict boxing point: provenance-free operands → eq?-stable flyweight;
 * stamped operands → fresh ABool carrying union. Every boolean-verdict site routes here.
 */
export function mintVerdict(operands: readonly unknown[], verdict: boolean): ABool {
  return withInputProvenance(operands, schemeBool(verdict));
}
