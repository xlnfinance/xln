/**
 * Scheme↔JS membrane: `toJS` / `jsToScheme` marshal at the FFI boundary and
 * round-trip to identity both ways on values each side owns
 * (`toJS∘jsToScheme = id`, `jsToScheme∘toJS = id`). Full crossing map:
 * `docs/membrane.md`. Host-fn → callable mint is `hostFnToCallable`; playback
 * frames mint `ARosettaProcedure` at the bind site in `provenance/replay.ts`.
 */

import { AValue, EMPTY_PROVENANCE, mergeProvenance } from "../values/primitives/AValue.js";
import { fromJs } from "./boxing.js";
import { type RunContext } from "../run/RunContext.js";
import { AJSArray } from "./AJSArray.js";
import { AJSObject } from "./AJSObject.js";
import { ANil, nil } from "../values/primitives/ANil.js";
import { theVoid } from "../values/primitives/AVoid.js";
import { ASymbol } from "../values/primitives/ASymbol.js";
import { EOF } from "../values/primitives/EOF.js";

import { AOpaqueHandle } from "../values/primitives/AOpaqueHandle.js";
import { hasInheritedInteropStamp, isMarkedInteropPrivate } from "./interop-access.js";
import {
  R7RSError,
  UnrecognizedCrossingError,
  AsyncCrossingError,
  NoLensError,
  RedundantCrossingError,
} from "../errors.js";
import { is_promise } from "../values/value-guards.js";
import { hostFnToCallable, originalCallableOf, type ACallable } from "../values/primitives/ACallable.js";

import { type AUnwrap, type AWrap, type EgressMode, type SchemeValue } from "../values/types.js";
import invariant from "tiny-invariant";
import { currentRegionScope, DETACHED_SCOPE, withRegionScope } from "./region-scope.js";
import { originalBoxOf } from "./egress-proxy.js";
import { tf } from "../values/tagless-final.js";

export interface RosettaOptions {
  // New field ⇒ classify in `modeKeyOf` (projection-affecting ⇒ new EgressMode;
  // wrapper-call-only ⇒ Exclude list). `_modeKeyExhaustive` fails the compile otherwise.
  returnEither?: boolean;
  /**
   * When true, attaches `this.argProvenance` (flat `CallCtx`, not nested `ctx.…`) —
   * one DEEP provenance set per scheme arg (union of every reachable AValue). Needed:
   * `(list a b c)` carries no spine provenance, only elements — shallow `arg.provenance`
   * misses per-element origins. Computed before toJS strips AValue identity.
   */
  argProvenance?: boolean;
}

/**
 * Membrane-crossing cache mode for `options`. Every live crossing resolves to the
 * single non-bare mode `"mem"`; `returnEither`/`argProvenance` are wrapper-call-only
 * (never read by egressUnknown / inbound jsToScheme). Keys both (box, mode, scope)
 * container slots (egress-proxy) and
 * (callable, mode, scope) wrapper slots. Kept as a function so a projection-affecting
 * option still has one classification site — see `_modeKeyExhaustive`.
 */
export function modeKeyOf(_options: RosettaOptions): EgressMode {
  return "mem";
}

/** New RosettaOptions field makes this `never` and the assignment a compile error.
 *  (Destructure / `satisfies` do NOT exhaustiveness-check.) */
type _ModeKeyHandles = Exclude<keyof RosettaOptions, "returnEither" | "argProvenance"> extends never ? true : never;
const _modeKeyExhaustive: _ModeKeyHandles = true;
void _modeKeyExhaustive;

/**
 * Duck-typed EvalContext.currentInvocation — avoids circular import to
 * arrival-chain/trace.ts. Exported so common/symbol.ts reuses the shape for
 * provenance mint rather than re-spelling the cast.
 */
export interface InvocationLike {
  id: number;
  isProvenancePoint?: boolean;
  /** MobX-action setter (strict-mode forbids raw field write). Plain test POJO may omit. */
  markProvenancePoint?(): void;
  /** Trace-side only — binds node metadata at call time; never crosses to scheme. */
  setMetadata?(meta: unknown): void;
}

/**
 * Reverse-membrane wrapper (scheme callable → region-scoped async JS fn).
 * Discipline: `docs/membrane.md` §REGION — closes over ambient `RegionScope`
 * (`currentRegionScope()`), never re-reads it (late call sees closed scope → escape door);
 * identity is per (callable, scope, FAMILY) on the scope-owned cache.
 *
 * Thin dispatch onto `ACallable`'s `arrival/toJS(exit?)` (`hostProjectionOf`): region
 * discipline, arg/result marshaling, and the scope-owned cache live on the class.
 * `egressAValue` builds the `MembraneExit` that method wants. Named export kept so
 * call sites spell "host fn for this callable," not "egress this AValue." One cache
 * either way: `toJS` of a dict holding a callable and a direct
 * `callableToHostFn`/`toJS` under the SAME scope answer the identical wrapper.
 */
export function callableToHostFn(value: ACallable, options: RosettaOptions): (...args: unknown[]) => unknown {
  return egressAValue(value, options) as (...args: unknown[]) => unknown;
}

/**
 * Boxed-AValue egress via the single crossing protocol `arrival/toJS(exit)`.
 * Native containers (ADict/APair/AVector) thread `exit.element` through recursive
 * projection under the PINNED exporting region scope; scalars unwrap. Shared by
 * the public `toJS` door and container-element recursion so they cannot drift.
 *
 * Scope is pinned ONCE here (both rosetta crossings run inside the live
 * `withRegionScope` window); every lazy element materialization re-enters via
 * `withRegionScope(pinned, …)` — `docs/membrane.md` §EGRESS / §REGION. Unpinned, a
 * nested callable would mint under DETACHED_SCOPE/CONSTANT_CTX (discipline bypass).
 * Paths with no ambient scope (exec simple tier, trace/display) pin DETACHED_SCOPE.
 */
export function egressAValue(value: AValue, options: RosettaOptions): unknown {
  const pinned = currentRegionScope() ?? DETACHED_SCOPE;
  return value["arrival/toJS"]({
    element: (el: unknown) => withRegionScope(pinned, () => egressUnknown(el, options)),
    modeKey: modeKeyOf(options),
    cache: pinned.egressProxies,
  });
}

/** Terminal-passthrough door (P5): a boxed shape with no `arrival/toJS` term —
 *  silent return would leak internal repr. Fail at the crossing
 *  (P5, docs/PRINCIPLES.md). Named + exported for `instanceof` in catch. */
export function schemeToJsUnrecognizedDoor(value: object): Error {
  return new UnrecognizedCrossingError(value.constructor?.name ?? "<anonymous object>");
}

/**
 * R7RSError exit arm: an R7RS error AS A VALUE (guard `else`, `raise-continuable`
 * resume) exits as a same-class host `Error` — message preserved, irritants crossed
 * elementwise, stack carried. A RAISED error never touches this arm (throw path).
 * R7RSError is a host `Error` subclass, NOT an AValue (`z.error` exists because of
 * that — env/r7rs/exceptions.ts). Shared by `toJS` and element recursion
 * (egressAValue law).
 */
export function errorToHost(value: R7RSError, exitEl: (el: unknown) => unknown): R7RSError {
  const Ctor = value.constructor as new (message: string, ...irritants: unknown[]) => R7RSError;
  const crossed = new Ctor(value.message, ...value.irritants.map(exitEl));
  crossed.stack = value.stack;
  return crossed;
}

/**
 * Membrane-private recursive walker behind `MembraneExit.element` (and R7RSError
 * irritants). `unknown`-typed: recursion may see raw JS intermediates no public
 * generic can describe. Not a public peel — mixed-world arrays/objects here are
 * an upstream boxing bug; the public door is {@link toJS}.
 *
 * LAZY: every boxed shape delegates to its own `arrival/toJS` (P7). Containers
 * egress as lazy readonly proxies (egress-proxy.ts); borrowed AJSObject/AJSArray
 * unwrap to `source` IDENTITY; callables become inverse-rosetta region wrappers
 * through the same dispatch (ACallable extends AValue). HERE: only membrane-
 * internal surface — raw JS containers elementwise, sequence-op-term preserve,
 * FFI allow-list, P5 door.
 */
function egressUnknown(value: unknown, options: RosettaOptions): unknown {
  if (value == null) return value;

  // Every boxed shape — including a callable — through `egressAValue` (shared with
  // public `toJS`). Containers thread MembraneExit for recursive projection; callables
  // mint region-scoped host wrappers; scalars unwrap. Proxies: identity per
  // (box, mode, scope) for membrane, per box for bare.
  if (value instanceof AValue) {
    return egressAValue(value, options);
  }

  // RAW containers: element recursion / error irritants may hand raw arrays/objects
  // whose ELEMENTS are boxed — cross elementwise so no AValue leaks into JS.
  if (Array.isArray(value)) {
    return value.map((record) => egressUnknown(record, options));
  }
  if (typeof value === "object") {
    if (Object.getPrototypeOf(value) === Object.getPrototypeOf({}) || Object.getPrototypeOf(value) === null) {
      // `Object.entries` drops symbol keys — enumerate string keys then own symbols.
      const out: Record<string | symbol, unknown> = {};
      for (const key of Object.keys(value)) out[key] = egressUnknown((value as Record<string, unknown>)[key], options);
      for (const sym of Object.getOwnPropertySymbols(value)) {
        out[sym] = egressUnknown((value as Record<symbol, unknown>)[sym], options);
      }
      return out;
    }
    // Sequence-op contract objects (own map/filter/reduce terms): preserve, not unwrap.
    if (
      (value as Record<PropertyKey, unknown>)[tf("map")] !== undefined ||
      (value as Record<PropertyKey, unknown>)[tf("filter")] !== undefined ||
      (value as Record<PropertyKey, unknown>)[tf("reduce")] !== undefined
    ) {
      return value;
    }
    // R7RSError AS A VALUE — raised errors take the throw path.
    if (value instanceof R7RSError) {
      return errorToHost(value, (el) => egressUnknown(el, options));
    }
    // Reader token BEFORE branded-host — same order as inbound. EOF is not a
    // SchemeValue; projecting `#<EOF>` via INTEROP_BOUNDARY would invent a
    // string face. Identity if a walk ever sees one; public toJS does not accept it.
    if (value instanceof EOF) return value;
    // Raw FFI passthrough — never boxed (mirrors inbound exotic carve-out).
    if (
      value instanceof Uint8Array ||
      value instanceof ArrayBuffer ||
      value instanceof DataView ||
      value instanceof Promise ||
      (typeof Buffer !== "undefined" && value instanceof Buffer)
    ) {
      return value;
    }
    // `@arrival.private` host classes (LLMModel, McpServer, ChatSession, …) — opaque
    // handles. Trace serialization / toJS must not throw: project to the class face
    // (`#<LLMModel>`), same as scheme-ward printing. Structural poke stays blocked.
    if (isMarkedInteropPrivate(value)) {
      const name = (value as { constructor?: { name?: string } }).constructor?.name ?? "Object";
      return `#<${name}>`;
    }
    throw schemeToJsUnrecognizedDoor(value);
  }

  // Host bigint never rides scheme space as a raw scalar — inbound twin door
  // (NoLensError kind `"bigint"`). Convert before re-crossing.
  if (typeof value === "bigint") {
    throw new NoLensError("bigint");
  }
  return value;
}

/**
 * Public Scheme → JS exit. Honestly typed via `AUnwrap<T>`. Optional
 * `RosettaOptions` keeps region-scoped membrane crossings working; default `{}`
 * is byte-identical to a direct `arrival/toJS` protocol call under default mode.
 *
 * STRICT: only interpreter-minted {@link SchemeValue}s. Raw JS is already on
 * the JS side — `RedundantCrossingError`. Mixed-world walk of raw arrays/objects
 * is not a public behavior.
 */
export function toJS<T extends SchemeValue>(value: T, options: RosettaOptions = {}): AUnwrap<T> {
  // R7RS error AS A VALUE exits as same-class host Error via shared arm.
  // Raised errors take the throw path. Irritants recurse through the private walker
  // (static type unknowable).
  if (value instanceof R7RSError) {
    return errorToHost(value, (el) => egressUnknown(el, options)) as AUnwrap<T>;
  }
  if (value instanceof AValue) return egressAValue(value, options) as AUnwrap<T>;
  throw new RedundantCrossingError("toJS");
}

/** Teaching door (P5): bare Promise reaching jsToScheme. Sanctioned paths settle first
 *  (rosetta wrappers await; reverse-membrane settles promise args; container entries
 *  settle lazily — pending-entry.ts). A raw Promise in scheme space would be an opaque
 *  leak. Named + exported like `schemeToJsUnrecognizedDoor` (outbound twin). */
export function jsToSchemeAsyncDoor(): Error {
  return new AsyncCrossingError();
}

/**
 * One INBOUND claim — static dual of outbound `arrival/toJS` terms. Outbound
 * dispatches on OUR classes; inbound dispatches on JS shapes with no receiver yet,
 * so each claim pairs a shape predicate with its constructor. Router is a fold over
 * the DECLARED list. `claims` narrows; `box` re-asserts (invariant, never a cast).
 */
export interface InboundClaim {
  /** Stable name — pinned by inbound-registry.law.test.ts. */
  readonly name: string;
  readonly claims: (value: unknown) => boolean;
  readonly box: (ctx: RunContext, value: unknown, provenance: ReadonlySet<number>, seen: WeakSet<object>) => unknown;
}

/**
 * THE INBOUND ALGEBRA (`docs/membrane.md` §INBOUND). Binary: every inbound value
 * crosses through exactly one of three PHASES, run in order — concatenated into the
 * one flat, DECLARED fold `jsToSchemeImpl` walks (phase split is law-pinned structure
 * of {@link INBOUND_CLAIMS}, not a second dispatch):
 *
 *   PHASE 1 — {@link OWNED_ARTIFACT_CLAIMS}: already MARKED as ours (AValue, re-admitted
 *   egress proxy, reverse-membrane wrapper, reader-token EOF, scheme orphan,
 *   branded opaque-handle source)
 *   before ANY foreign-shape predicate. Phase 1 before phase 2 is load-bearing: an R9
 *   proxy over a vector is `Array.isArray`-true (and a reverse-membrane wrapper is
 *   `typeof === "function"`-true) and would otherwise be mis-claimed by phase 2.
 *   Within phase 1, mostly order-free EXCEPT: owned non-AValue (reader-token EOF,
 *   R7RSError) BEFORE branded-host — they carry the same `INTEROP_BOUNDARY`
 *   stamp `isMarkedInteropPrivate` reads; reverse order would mint them as AOpaqueHandle.
 *
 *   PHASE 2 — {@link FOREIGN_LENS_CLAIMS}: typeof-disjoint lenses (array/plain-object
 *   ladder lives INSIDE the single "object" row). Familiar crossings only — no
 *   warn-and-degrade middle tier. Inherited `INTEROP_BOUNDARY` (no own-class stamp)
 *   borrows as AJSObject — read-policy, not opaque. Bare host function → genuine
 *   `ARosettaProcedure` (`hostFnToCallable`), completing the callable bifunctor
 *   with `hostProjectionOf`.
 *
 *   PHASE 3 — {@link INCOMPATIBILITY_DOOR_CLAIMS}: explicitly incompatible — never silent
 *   degrade. Each row names its refusal and cure (`NoLensError` / `AsyncCrossingError`).
 *
 * Declared table (order written down, law-pinned) — not self-registration by import
 * accident (boxing.ts rejects that construction). Class knowledge stays in
 * closures/protocol methods so AJSObject/AJSArray ↔ rosetta cycles stay TDZ-safe.
 */
export const OWNED_ARTIFACT_CLAIMS: readonly InboundClaim[] = [
  {
    // Already-AValue: same/empty-provenance identity; else class re-stamp — deep on
    // spine carriers (`arrival/withProvenanceDeep`), shallow elsewhere. Scheme lambdas
    // are ALambda values and round-trip here.
    name: "AValue → identity / provenance re-stamp (class term)",
    claims: (v) => v instanceof AValue,
    box: (ctx, v, p, seen) => {
      invariant(v instanceof AValue, "inbound claim 'AValue': box called off its predicate");
      if (p === EMPTY_PROVENANCE || p === v.provenance) return v;
      // ADDITIVE LAW (docs/membrane.md §INBOUND): merge crossing origin onto the value —
      // never overwrite. Union keeps `origin ⊇ dependencies` (uneval Galois slicing);
      // replace would drop the value's own lineage.
      const merged = mergeProvenance(v.provenance, p);
      if (merged === v.provenance) return v;
      const deep = v["arrival/withProvenanceDeep"];
      return deep === undefined ? v.withProvenance(merged) : deep.call(v, ctx, p, seen);
    },
  },
  {
    // R9 RE-ADMISSION (docs/membrane.md §INBOUND / RULINGS.md R9): a value that crossed
    // OUT as an egress-proxy (bare/membrane/gated — all register in PROXY_ORIGIN) and
    // crosses back IN re-admits as its ORIGINAL box — `jsToScheme(toJS(box)) === box`.
    // Phase 1 before phase 2's array row is load-bearing (R9 proxy over vector is
    // Array.isArray-true). Re-dispatches through jsToSchemeImpl → AValue re-stamp row;
    // do NOT reimplement re-stamping here.
    name: "R9 egress proxy → original box (re-admission)",
    claims: (v) => typeof v === "object" && v !== null && originalBoxOf(v) !== undefined,
    box: (ctx, v, p, seen) => {
      const original = originalBoxOf(v as object);
      invariant(original !== undefined, "inbound claim 'R9 egress proxy': box called off its predicate");
      return jsToSchemeImpl(ctx, original, p, seen);
    },
  },
  {
    // Function-shaped sibling of R9: callable's host projection (`hostProjectionOf`)
    // crossing back IN re-admits as ORIGINAL callable, not re-wrapped by phase 2's
    // bare-function lens. Wrapper is a plain function (not a Proxy) — needs its own
    // reverse map (`WRAPPER_ORIGIN` / `originalCallableOf`). Before phase 2 function row.
    name: "reverse-membrane wrapper → original callable (re-admission)",
    claims: (v) => typeof v === "function" && originalCallableOf(v) !== undefined,
    box: (_ctx, v) => {
      const original = originalCallableOf(v as object);
      invariant(original !== undefined, "inbound claim 'reverse-membrane wrapper': box called off its predicate");
      return original;
    },
  },
  {
    // Reader-internal sentinel (not a SchemeValue). Identity so INTEROP_BOUNDARY
    // does not mint an AOpaqueHandle. Public toJS does not accept EOF.
    name: "reader token (EOF) → identity (not a SchemeValue)",
    claims: (v) => v instanceof EOF,
    box: (_ctx, v) => v,
  },
  {
    // Non-AValue scheme orphans: identity, no provenance slot. BEFORE branded-host
    // (INTEROP_BOUNDARY stamp overlap with isMarkedInteropPrivate — see phase header).
    name: "scheme orphan (R7RSError) → identity",
    claims: (v) => v instanceof R7RSError,
    box: (_ctx, v) => v,
  },
  {
    // Branded HOST class (`@arrival.private` / markInteropPrivate) — opaque-crossing
    // contract (docs/membrane.md §INBOUND; interop-access.ts). Mint/reuse THIS RUN's
    // canonical AOpaqueHandle (`AOpaqueHandle.for`). Phase 3 door fires only for
    // instances neither this nor other owned-artifact rows recognize. AFTER scheme-orphan
    // (load-bearing stamp overlap).
    name: "branded host instance → opaque handle (mint/reuse, whiteroom contract)",
    claims: (v) => typeof v === "object" && v !== null && isMarkedInteropPrivate(v),
    box: (ctx, v, p) => {
      invariant(
        typeof v === "object" && v !== null,
        "inbound claim 'branded host instance': box called off its predicate",
      );
      return AOpaqueHandle.for(ctx, v, p);
    },
  },
] as const;

export const FOREIGN_LENS_CLAIMS: readonly InboundClaim[] = [
  {
    // null → nil: list-end bottom, provenance-stamped when supplied.
    name: "null → nil",
    claims: (v) => v === null,
    box: (ctx, _v, p) => (p === EMPTY_PROVENANCE ? nil : new ANil(p)),
  },
  {
    // undefined: familiar host absence → #void lens, no warn. Never collapses with null→nil.
    name: "undefined → #void (lens)",
    claims: (v) => v === undefined,
    box: () => theVoid,
  },
  {
    // Object-typed plain data: JS array IS R7RS vector → AJSArray; plain-prototype →
    // AJSObject. ONE row, internal ladder (Array.isArray first) — not two order-dependent
    // siblings. Date/Map/Set/unbranded class → phase 3.
    name: "object → array/plain-object containment ladder",
    claims: (v) =>
      typeof v === "object" &&
      v !== null &&
      (Array.isArray(v) || Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null),
    box: (ctx, v, p) => {
      invariant(typeof v === "object" && v !== null, "inbound claim 'object ladder': box called off its predicate");
      return Array.isArray(v) ? new AJSArray(v, p) : new AJSObject(v, p);
    },
  },
  {
    // Host Error → borrowed AJSObject; `stack` collapses absent via interop read policy
    // (error-object-exit.law). R7RSError claimed by phase 1 scheme-orphan first.
    // Separate from object ladder: Error.prototype ≠ Object.prototype.
    name: "host Error → borrowed AJSObject (declared lens)",
    claims: (v) => v instanceof Error,
    box: (ctx, v, p) => {
      invariant(v instanceof Error, "inbound claim 'host Error': box called off its predicate");
      return new AJSObject(v, p);
    },
  },
  {
    // Ancestor `INTEROP_BOUNDARY` without an OWN-class stamp: read-policy stop,
    // not `@arrival.private`. Borrow so subclass accessors stay readable and
    // accessMember still blocks at the stamped ancestor. Own-class stamp is
    // phase 1's opaque-handle row; no stamp anywhere is phase 3's unbranded door.
    name: "inherited interop-boundary → borrowed AJSObject (read-policy, not opaque)",
    claims: (v) => typeof v === "object" && v !== null && hasInheritedInteropStamp(v),
    box: (_ctx, v, p) => {
      invariant(
        typeof v === "object" && v !== null,
        "inbound claim 'inherited interop-boundary': box called off its predicate",
      );
      return new AJSObject(v, p);
    },
  },
  {
    // JS primitives → boxing.ts. bigint EXCLUDED — phase 3 NoLensError `"bigint"`;
    // claiming here would silent-reinterpret into AExact.
    name: "scalar → boxer table (fromJs)",
    claims: (v) => {
      const tag = typeof v;
      return tag === "string" || tag === "number" || tag === "boolean";
    },
    box: (ctx, v, p) => fromJs(ctx, v, p),
  },
  {
    // Symbol.for('x') → keyword `:x`. Unique symbol → phase 3 (no portable identity).
    name: "symbol → :keyword (registered)",
    claims: (v) => typeof v === "symbol" && Symbol.keyFor(v) !== undefined,
    box: (ctx, v, p) => {
      invariant(typeof v === "symbol", "inbound claim 'registered symbol': box called off its predicate");
      const key = Symbol.keyFor(v);
      invariant(key !== undefined, "inbound claim 'registered symbol': box called off its predicate (unregistered)");
      return new ASymbol(`:${key}`, p);
    },
  },
  {
    // Declared raw passthrough (named superset: FFI identity) — mirrors outbound allow-list.
    name: "binary (Uint8Array/ArrayBuffer/DataView/Buffer) → raw passthrough (declared)",
    claims: (v) =>
      v instanceof Uint8Array ||
      v instanceof ArrayBuffer ||
      v instanceof DataView ||
      (typeof Buffer !== "undefined" && v instanceof Buffer),
    box: (_ctx, v) => v,
  },
  {
    // Bare host fn → ARosettaProcedure (docs/membrane.md §CALLABLE-LENS): args
    // scheme→js, result js→scheme. Reached only when phase 1 reverse-wrapper missed.
    name: "function → callable (reverse membrane: args scheme→js, result js→scheme)",
    claims: (v) => typeof v === "function",
    box: (ctx, v, p) => {
      invariant(typeof v === "function", "inbound claim 'function': box called off its predicate");
      return hostFnToCallable(ctx, v as (...args: unknown[]) => unknown, p);
    },
  },
] as const;

export const INCOMPATIBILITY_DOOR_CLAIMS: readonly InboundClaim[] = [
  {
    // Bare Promise doors — see jsToSchemeAsyncDoor. Promise VALUES inside structures
    // settle lazily (pending-entry.ts). FIRST in this phase: Promise typeof is "object".
    name: "promise → door (settle first; container entries settle lazily)",
    claims: (v) => is_promise(v),
    box: () => {
      throw jsToSchemeAsyncDoor();
    },
  },
  {
    // Unique symbol: no stable cross-realm key — EXPLICITLY INCOMPATIBLE.
    name: "unique symbol → door (no lens)",
    claims: (v) => typeof v === "symbol",
    box: () => {
      throw new NoLensError("unique-symbol");
    },
  },
  {
    // Host bigint: exact numbers are safe-integer ratios, not unbounded integers.
    // Cure: bigintToNumber (this file) or encode to AExact before the membrane (z.bigint).
    name: "bigint → door (no lens)",
    claims: (v) => typeof v === "bigint",
    box: () => {
      throw new NoLensError("bigint");
    },
  },
  {
    // Residual exotics (Date/Map/Set/RegExp, unbranded class): no lens. Cures: brand
    // `@arrival.private`, or hand plain data.
    name: "unbranded/exotic object → door (no lens)",
    claims: (v) => typeof v === "object" && v !== null,
    box: (_ctx, v) => {
      invariant(
        typeof v === "object" && v !== null,
        "inbound claim 'unbranded/exotic object': box called off its predicate",
      );
      throw new NoLensError("unbranded-class", v.constructor?.name ?? "<anonymous object>");
    },
  },
] as const;

/**
 * THE inbound claim registry — ordered fold: OWNED → FOREIGN → DOOR (first claim wins).
 * Cross-phase order IS semantic; within phase 1 and (mostly) phase 2 it is not —
 * see phase docs. inbound-registry.law pins the flat name list so accidental
 * cross-phase reorder is a caught diff.
 */
export const INBOUND_CLAIMS: readonly InboundClaim[] = [
  ...OWNED_ARTIFACT_CLAIMS,
  ...FOREIGN_LENS_CLAIMS,
  ...INCOMPATIBILITY_DOOR_CLAIMS,
] as const;

/**
 * Recursive body behind `jsToScheme` — ordered fold over INBOUND_CLAIMS.
 * `seen` is router infrastructure, not a claim: JS-side cycle / shared substructure
 * returns as-is (outer wrapper already carries the stamp).
 */
function jsToSchemeImpl(
  ctx: RunContext,
  value: unknown,
  provenance: ReadonlySet<number>,
  seen: WeakSet<object>,
): unknown {
  if (typeof value === "object" && value !== null) {
    if (seen.has(value)) return value;
    seen.add(value);
  }
  for (const claim of INBOUND_CLAIMS) {
    if (claim.claims(value)) return claim.box(ctx, value, provenance, seen);
  }
  // Total by construction: bottoms + AValue + object + scalar + symbol + function.
  invariant(false, `jsToScheme: no inbound claim for typeof "${typeof value}" — the registry must stay total`);
}

/**
 * JS → Scheme deep-stamping membrane — fold over INBOUND_CLAIMS. Single pass: every
 * constructed AValue inherits `provenance` so extractors see element-only lineage
 * carrying the rosetta origin without a separate re-stamp. Already-AValue with a
 * fresh stamp re-stamps through its own protocol (deep on spine carriers).
 * `seen` terminates JS-side cycles.
 * `_options` accepted for signature parity; inbound reads none of it (RosettaOptions
 * is outbound/wrapper-call only).
 * Honestly typed via `AWrap<T>` — ONE sanctioned narrowing (P3).
 */
export function jsToScheme<T>(
  ctx: RunContext,
  value: T,
  _options: RosettaOptions = {},
  provenance: ReadonlySet<number> = EMPTY_PROVENANCE,
  seen: WeakSet<object> = new WeakSet(),
): AWrap<T> {
  return jsToSchemeImpl(ctx, value, provenance, seen) as AWrap<T>;
}

/**
 * Explicit safe-range-checked host `bigint` → plain `number` for hand-off to
 * fromJs/mintExact/jsToScheme. Raw bigint never enters scheme (NoLensError `"bigint"`);
 * this is the sanctioned pre-crossing cure — throws rather than lose precision
 * (mirrors values/mint-numeric.ts crash-on-overflow). JS-level only; scheme surface
 * `bigint->number` belongs with other numeric verbs (env/r7rs/numeric.ts). Codecs that
 * speak bigint (`z.bigint`) encode to AExact BEFORE the membrane and never need this.
 */
export function bigintToNumber(value: bigint): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) {
    throw new TypeError(
      `bigint->number: ${value} exceeds safe-integer range — arrival's exact numbers are safe-integer ` +
        "ratios (docs/design-history/arrival-one-number-rework.md), so this host bigint cannot convert " +
        "without precision loss",
    );
  }
  return Number(value);
}
