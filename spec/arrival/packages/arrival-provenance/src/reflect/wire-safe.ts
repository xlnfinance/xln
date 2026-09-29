// wire-safe.ts — the choke classifier between the discovery plane and an isolated run.
//
// A value is "wire-safe" iff it is pure serializable DATA: numbers, strings, booleans, nil,
// bytevectors, and lists/dicts of wire-safe values. NEVER a lambda/closure, continuation, raw
// symbol, port, or a ResultHandle. This is enforced at the two choke crossings:
//   • require/call ARGS going INTO a run  (so `(why)`, a handle, or a closure can't be smuggled in)
//   • require/eval|call RESULTS coming OUT (so a run can't hand back a live closure)
//
// It is the SAME law a deployed `/fn` function needs (its I/O must cross an HTTP/JSON boundary) —
// one classifier, two enforcers. Classification is over the PEELED JS value (the rosetta membrane
// already `toJS`-peels args/returns), so scheme boxes are gone and only JS shapes remain: a scheme
// closure peels to a `function`, a symbol to `symbol`, a Pair to an array, a dict to a plain object.

import { is_result_handle } from "./result-handle.js";

/** Recursively decide whether a peeled JS value may cross the choke. */
export function isWireSafe(value: unknown, seen = new Set<unknown>()): boolean {
  if (value === null || value === undefined) return true;
  switch (typeof value) {
    case "number":
    case "string":
    case "boolean":
    case "bigint":
      return true;
    case "function":
    case "symbol":
      return false; // closures / live symbols — MUST never cross
    case "object":
    case "undefined":
      break; // fall through to the structural checks below
  }
  if (is_result_handle(value)) return false; // a discovery handle must not re-enter a run
  if (value instanceof Uint8Array) return true; // bytevector
  if (seen.has(value)) return true; // already vetted (cyclic data is fine; identity, not re-walk)
  seen.add(value);
  if (Array.isArray(value)) return value.every((v) => isWireSafe(v, seen));
  // Plain data record only — a class instance (Pair survivor, Map, Date, port, …) is not wire data.
  const proto = Object.getPrototypeOf(value);
  if (proto === Object.prototype || proto === null) {
    return Object.values(value as Record<string, unknown>).every((v) => isWireSafe(v, seen));
  }
  return false;
}

export class WireUnsafeError extends Error {
  constructor(
    public readonly where: string,
    public readonly value: unknown,
  ) {
    const kind = describeKind(value);
    super(
      `wire-unsafe value at ${where}: ${kind} cannot cross the run/discovery boundary. ` +
        `Only data may cross — numbers, strings, booleans, nil, bytevectors, and lists/dicts of those. ` +
        `Closures, symbols, ports and provenance handles stay on their own plane.`,
    );
    this.name = "WireUnsafeError";
  }
}

/** Throw a teaching door if `value` may not cross the choke. */
export function assertWireSafe(value: unknown, where: string): void {
  if (!isWireSafe(value)) throw new WireUnsafeError(where, value);
}

function describeKind(value: unknown): string {
  if (typeof value === "function") return "a closure/function";
  if (typeof value === "symbol") return "a symbol";
  if (is_result_handle(value)) return "a provenance handle";
  if (value && typeof value === "object")
    return `a live ${Object.getPrototypeOf(value)?.constructor?.name ?? "object"}`;
  return typeof value;
}
