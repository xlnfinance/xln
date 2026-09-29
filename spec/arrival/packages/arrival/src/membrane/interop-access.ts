/**
 * Interop Member-Access Policy
 *
 * Read policy of the polyglot membrane (`accessMember` is what borrowed-value
 * get/has/keys wrap): when Scheme reads a member via `@` / `:key`, expose OWN DATA
 * MEMBERS only — never the implementation substrate's prototype machinery
 * (`constructor`, `__proto__`, built-in prototype methods, well-known symbols).
 * Arrival's InteropLibrary.readMember contract, not a security fence around a guest:
 * a foreign object exposes its members, not its language's internals (Graal: JS can't
 * reach Java's `getClass()`). Arrival's own value-types opt in via `@arrival.private`
 * so `(@ a-string :__string__)` cannot reach their internals.
 *
 * "Boundary" = the prototype where the member walk STOPS — membrane sense, not sandbox.
 *
 * TWO CONCEPTS, co-located because the checker reads both:
 * 1. READ POLICY — accessMember/accessHas/accessKeys + boundary walk + blocklists.
 *    Mouths are exactly two: AJSObject and AJSArray (get/has/keys over `source`). The
 *    membrane has no readMember face: the value's own tagless get|has|keys term
 *    dispatches. Shared module is the honest home for shared blocklist + walk logic.
 * 2. PRIVACY BRAND — INTEROP_BOUNDARY + markInteropBoundary / @arrival.private: opt-in
 *    for HOST classes. Arrival's own value family uses the nominal family rule
 *    (`instanceof AValue`); structured errors use `instanceof ArrivalError`. Classes
 *    outside both families carry explicit `static [INTEROP_BOUNDARY] = true` (or, for
 *    non-ArrivalError errors.ts roots, an explicit instanceof arm below).
 *
 * Lineage: GraalVM Truffle InteropLibrary (Würthinger et al. 2013/2017);
 * object-capability membrane (Miller, "Robust Composition", 2006).
 */

// Installs global Error.invariant / TypeError.invariant (side-effect import).
import "@here.build/error-invariant";

import { InteropAccessError, ArrivalError, Unterminated, ParseError, EvalError, R7RSError } from "../errors.js";
// Nominal families the boundary walk recognizes in one shot: every AValue subclass
// and every ArrivalError subclass. InteropAccessError already came from errors.ts.
import { AValue } from "../values/primitives/AValue.js";
import { INTEROP_BOUNDARY } from "../well-known/symbols.js";

/**
 * Marks classes/prototypes as interop boundaries — inherited property access stops.
 *
 * ```typescript
 * class SecureAPI {
 *   static [INTEROP_BOUNDARY] = true;
 * }
 * ```
 *
 * Boundary mark must not be sandbox-forgeable. Home: `well-known/symbols.ts`.
 */

/**
 * Built-in prototypes that are ALWAYS interop boundaries — standard JS built-ins
 * Scheme code should never access through inheritance.
 */
const BUILTIN_BOUNDARY_PROTOTYPES: Set<object | null> = new Set([
  Object.prototype,
  Array.prototype,
  Function.prototype,
  String.prototype,
  Number.prototype,
  Boolean.prototype,
  Symbol.prototype,
  RegExp.prototype,
  Date.prototype,
  Map.prototype,
  Set.prototype,
  WeakMap.prototype,
  WeakSet.prototype,
  WeakRef.prototype,
  FinalizationRegistry.prototype,
  Promise.prototype,
  Error.prototype,
  Int8Array.prototype,
  Uint8Array.prototype,
  Uint8ClampedArray.prototype,
  Int16Array.prototype,
  Uint16Array.prototype,
  Int32Array.prototype,
  Uint32Array.prototype,
  Float32Array.prototype,
  Float64Array.prototype,
  BigInt64Array.prototype,
  BigUint64Array.prototype,
  ArrayBuffer.prototype,
  // SharedArrayBuffer only in crossOriginIsolated scopes.
  ...(typeof SharedArrayBuffer === "undefined" ? [] : [SharedArrayBuffer.prototype]),
  DataView.prototype,
  Object.getPrototypeOf(function* () {}).prototype, // GeneratorFunction.prototype
  Object.getPrototypeOf(async function* () {}).prototype, // AsyncGeneratorFunction.prototype
]);

/** Property names always blocked, regardless of definition site. */
const BLOCKED_PROPERTY_NAMES: Set<string> = new Set([
  "__proto__",
  "__defineGetter__",
  "__defineSetter__",
  "__lookupGetter__",
  "__lookupSetter__",
  "constructor",
  "prototype",
]);

/**
 * Well-known Symbols blocked from sandbox access — they trigger JS runtime
 * behaviors (coercion, iteration, instance checks) that could execute arbitrary
 * code or leak internal state.
 */
const BLOCKED_WELL_KNOWN_SYMBOLS: Set<symbol> = new Set([
  Symbol.toPrimitive,
  Symbol.hasInstance,
  Symbol.species,
  Symbol.iterator,
  Symbol.asyncIterator,
  Symbol.toStringTag,
  Symbol.unscopables,
  Symbol.isConcatSpreadable,
]);

/** Cache for prototype boundary status. WeakMap so prototypes stay GC-able. */
const boundaryCache = new WeakMap<object, boolean>();

/**
 * A prototype whose OWN `constructor` is a global (`globalThis[ctor.name] === ctor`)
 * is a built-in's prototype, hence a boundary — generalizes the explicit list so every
 * global (Date, Error subclasses, …) need not be enumerated. Identity-checked, not
 * name-checked: spoofed `constructor.name = "Object"` still fails.
 *
 * OWN-constructor is the discriminator: built-in/class prototypes have own
 * `constructor`; an ad-hoc object used as a prototype inherits Object and would
 * otherwise be falsely flagged, blocking its own data.
 */
function isGlobalConstructorPrototype(proto: object): boolean {
  // OWN descriptor: enforces own-requirement and hardens the read (hostile accessor never invoked).
  const ctor = Reflect.getOwnPropertyDescriptor(proto, "constructor")?.value;
  if (typeof ctor !== "function" || typeof ctor.name !== "string" || ctor.name.length === 0) return false;
  // Identity, not name.
  return (globalThis as Record<string, unknown>)[ctor.name] === ctor;
}

/** Whether a prototype is an interop boundary. Results cached. */
export function isInteropBoundary(proto: object | null): boolean {
  // null = end of chain, always a boundary.
  if (proto === null) return true;

  const cached = boundaryCache.get(proto);
  if (cached !== undefined) return cached;

  if (BUILTIN_BOUNDARY_PROTOTYPES.has(proto)) {
    boundaryCache.set(proto, true);
    return true;
  }

  // Global constructor's prototype — generalizes the explicit list above.
  if (isGlobalConstructorPrototype(proto)) {
    boundaryCache.set(proto, true);
    return true;
  }

  // ARRIVAL FAMILY: whole AValue hierarchy in one check. Explicit `===` arm required:
  // `AValue.prototype instanceof AValue` is always false (instanceof walks STARTING
  // ABOVE the receiver). AValue.ts keeps its own static stamp as a defensive belt,
  // caught by the class-level marker check further below.
  if (proto === AValue.prototype || proto instanceof AValue) {
    boundaryCache.set(proto, true);
    return true;
  }

  // Same shape for structured-error hierarchy. Pre-ArrivalError classes
  // (Unterminated/ParseError/EvalError/R7RSError extend Error directly) get explicit
  // arms; R7RSError subclasses pick up via instanceof (safe over-approximation —
  // more privacy, not less).
  if (proto === ArrivalError.prototype || proto instanceof ArrivalError) {
    boundaryCache.set(proto, true);
    return true;
  }
  if (
    proto === Unterminated.prototype ||
    proto instanceof Unterminated ||
    proto === ParseError.prototype ||
    proto instanceof ParseError ||
    proto === EvalError.prototype ||
    proto instanceof EvalError ||
    proto === R7RSError.prototype ||
    proto instanceof R7RSError
  ) {
    boundaryCache.set(proto, true);
    return true;
  }

  // Explicit marker on the prototype itself. hasOwnProperty, not `in` — don't inherit
  // boundary status from a parent.
  if (
    Object.prototype.hasOwnProperty.call(proto, INTEROP_BOUNDARY) &&
    (proto as Record<symbol, unknown>)[INTEROP_BOUNDARY] === true
  ) {
    boundaryCache.set(proto, true);
    return true;
  }

  // Class-level marker via static [INTEROP_BOUNDARY] = true. OWN descriptor only.
  const ctor = Reflect.getOwnPropertyDescriptor(proto, "constructor")?.value;
  if (
    ctor &&
    typeof ctor === "function" &&
    Object.prototype.hasOwnProperty.call(ctor, INTEROP_BOUNDARY) &&
    (ctor as unknown as Record<symbol, unknown>)[INTEROP_BOUNDARY] === true
  ) {
    boundaryCache.set(proto, true);
    return true;
  }

  boundaryCache.set(proto, false);
  return false;
}

/** Mark a class or object as an interop boundary — Scheme cannot access inherited
 *  properties through it. */
export function markInteropBoundary(target: object | Function): void {
  (target as unknown as Record<symbol, unknown>)[INTEROP_BOUNDARY] = true;
  if (typeof target === "function" && target.prototype) {
    boundaryCache.delete(target.prototype);
  } else {
    boundaryCache.delete(target);
  }
}

/**
 * `@arrival.private` — declaratively seal a host class as an interop boundary, so
 * Scheme can't reach its prototype members (`(:field x)`/`(@ x :field)` → nil).
 * Wraps {@link markInteropBoundary}, which uses the MODULE-PRIVATE boundary symbol —
 * the only correct one. Never brand with `Symbol.for("scheme:interop-boundary")`:
 * that registry-global symbol differs from the one the check reads, and is forgeable.
 *
 * Usable as a TC39 class decorator (stage-3 form) or a plain call:
 *
 *   @arrival.private class Ip { #bytes; get bytes() { … } }
 *   arrival.private(Ip)
 *
 * OPAQUE-CROSSING CONTRACT (docs/membrane.md §INBOUND): marking a class this way
 * grants full semi-opaque semantics, symmetric both directions:
 *
 *   - SCHEME-WARD (rosetta returns an instance, or one rides inside a container):
 *     crosses as AOpaqueHandle — identity-preserving within one run (eq?/equal?),
 *     printable as its class face (`#<McpServer>`), no reader term (member access is
 *     TypeError, not silent nil). Minted by rosetta's inbound registry via
 *     {@link isMarkedInteropPrivate}.
 *   - HOST-WARD (handle as rosetta impl ARG): UNWRAPS to the raw instance — every slot
 *     kind (z.dynamic, scheme-zod instance(Ctor), containers). See
 *     common/symbols/rosetta.ts buildOpaqueHandleUnwrap and scheme-zod instance codec.
 *   - ROUND-TRIP: out then in is the SAME instance (`===`) — handle holds .instance
 *     by reference.
 *
 * Unbranded class instances are unaffected (borrow as AJSObject, or no-lens door).
 * Brand is the sole opt-in; nothing ambient.
 */
export function markInteropPrivate<T extends Function>(target: T, _context?: unknown): T {
  markInteropBoundary(target);
  return target;
}

export const arrival = { private: markInteropPrivate };

/**
 * Explicit `INTEROP_BOUNDARY` on this prototype or its own constructor — the two
 * marker arms {@link isMarkedInteropPrivate} and {@link hasInheritedInteropStamp}
 * share. Not {@link isInteropBoundary}: that also answers true for Object.prototype
 * and every built-in, which would make every class instance look ancestor-stamped.
 */
function classCarriesExplicitStamp(proto: object): boolean {
  if (
    Object.prototype.hasOwnProperty.call(proto, INTEROP_BOUNDARY) &&
    (proto as Record<symbol, unknown>)[INTEROP_BOUNDARY] === true
  ) {
    return true;
  }
  const ctor = Reflect.getOwnPropertyDescriptor(proto, "constructor")?.value;
  return (
    typeof ctor === "function" &&
    Object.prototype.hasOwnProperty.call(ctor, INTEROP_BOUNDARY) &&
    (ctor as unknown as Record<symbol, unknown>)[INTEROP_BOUNDARY] === true
  );
}

/**
 * Does `value`'s OWN class carry the EXPLICIT `@arrival.private`/`markInteropPrivate`
 * stamp — opaque-crossing recognition test (rosetta inbound registry).
 *
 * OWN CLASS ONLY. An ancestor stamp is a READ-POLICY stop ({@link isInteropBoundary}
 * + {@link accessMember}), not opaque-crossing. A subclass of a stamped engine
 * (PlexusModel → DriverSpec) must borrow as AJSObject so its own accessors stay
 * readable; see {@link hasInheritedInteropStamp}.
 *
 * NARROWER than {@link isInteropBoundary}: that also answers true for every JS built-in
 * prototype, null, and the AValue/ArrivalError FAMILY rules ("does the READ POLICY stop
 * here"). This checks only the two explicit-marker arms on the immediate prototype
 * (own-prototype stamp, own-static class stamp) — never the built-in list,
 * global-constructor generalization, either nominal family, or ancestor classes.
 * Plain objects, Date/Map, and unstamped arrival-internal classes never answer true
 * unless THEY carry the marker.
 *
 * AValue/ArrivalError families may also carry this marker — callers place the
 * check AFTER rows that claim AValue, the EOF reader token, and scheme orphans (R7RSError); order,
 * not this predicate, scopes use to genuinely-new host classes.
 */
export function isMarkedInteropPrivate(value: object): boolean {
  const proto = Reflect.getPrototypeOf(value);
  return proto !== null && classCarriesExplicitStamp(proto);
}

/**
 * An ANCESTOR class (not the instance's own) carries an explicit `INTEROP_BOUNDARY`
 * stamp. Inherited stamp is a read-policy stop, not `@arrival.private`: inbound
 * borrows as AJSObject so subclass members stay readable and the walk still
 * blocks at the ancestor. Unstamped classes (no stamp anywhere) stay the
 * unbranded/exotic door.
 */
export function hasInheritedInteropStamp(value: object): boolean {
  let proto = Reflect.getPrototypeOf(value);
  if (proto === null) return false;
  proto = Reflect.getPrototypeOf(proto);
  while (proto !== null) {
    if (classCarriesExplicitStamp(proto)) return true;
    proto = Reflect.getPrototypeOf(proto);
  }
  return false;
}

/**
 * Sentinel: property not found. Distinct from `undefined` (a valid property value).
 * Module-local (NOT Symbol.for): unforgeable — global registry would let sandbox code
 * mint the same symbol and spoof NOT_FOUND.
 */
export const NOT_FOUND = Symbol("scheme:not-found");

type AccessResult<T> = T | typeof NOT_FOUND;

function isBlockedPropertyName(key: string | symbol): boolean {
  if (typeof key === "symbol") return BLOCKED_WELL_KNOWN_SYMBOLS.has(key);
  return BLOCKED_PROPERTY_NAMES.has(key);
}

/**
 * Member access — core interop-read primitive.
 *
 * 1. Blocked property names always throw
 * 2. Own properties always accessible
 * 3. Missing → NOT_FOUND
 * 4. Inherited: accessible only if found before an interop boundary; else throw
 *
 * @throws InteropAccessError if access would cross a boundary
 */
export function accessMember(data: unknown, key: string | symbol): AccessResult<unknown> {
  if (data === null || data === undefined) {
    return NOT_FOUND;
  }

  const keyStr = typeof key === "symbol" ? key : String(key);

  if (isBlockedPropertyName(keyStr)) {
    throw new InteropAccessError(
      `Cannot access '${String(keyStr)}' - blocked for security`,
      keyStr,
      "blocked-property",
    );
  }

  // Box primitives to check properties.
  const obj = new Object(data);

  if (Object.prototype.hasOwnProperty.call(obj, keyStr)) {
    return Reflect.get(obj, keyStr);
  }

  if (!Reflect.has(obj, keyStr)) {
    return NOT_FOUND;
  }

  let proto = Reflect.getPrototypeOf(obj);

  while (proto !== null) {
    if (isInteropBoundary(proto)) {
      throw new InteropAccessError(
        `Cannot access inherited property '${String(keyStr)}' - ` +
          `blocked at interop boundary (${proto.constructor?.name || "Object"})`,
        keyStr,
        proto.constructor?.name || "Object",
      );
    }

    if (Object.prototype.hasOwnProperty.call(proto, keyStr)) {
      return Reflect.get(obj, keyStr);
    }

    proto = Reflect.getPrototypeOf(proto);
  }

  return NOT_FOUND;
}

/**
 * Interop member existence. True only for own properties and inherited properties
 * from non-boundary prototypes. Returns false (not throws) for blocked properties.
 */
export function accessHas(data: unknown, key: string | symbol): boolean {
  if (data === null || data === undefined) {
    return false;
  }

  const keyStr = typeof key === "symbol" ? key : String(key);

  if (isBlockedPropertyName(keyStr)) {
    return false;
  }

  const obj = new Object(data);

  if (Object.prototype.hasOwnProperty.call(obj, keyStr)) {
    return true;
  }

  if (!Reflect.has(obj, keyStr)) {
    return false;
  }

  let proto = Reflect.getPrototypeOf(obj);

  while (proto !== null) {
    if (isInteropBoundary(proto)) {
      return false;
    }

    if (Object.prototype.hasOwnProperty.call(proto, keyStr)) {
      return true;
    }

    proto = Reflect.getPrototypeOf(proto);
  }

  return false;
}

/** Own enumerable keys only — never inherited. */
export function accessKeys(data: unknown): string[] {
  if (data === null || data === undefined) {
    return [];
  }

  return Object.keys(new Object(data));
}
