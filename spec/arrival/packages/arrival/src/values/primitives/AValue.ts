/**
 * Provenance lives on the value, not in a sidecar WeakMap. A WeakMap keyed by
 * object identity snaps the instant any builtin produces a fresh value
 * (`string-append`, `car`, `+`, hundreds more) — every builtin would have to
 * remember to re-stamp. On-value means a builtin can only forget to *propagate*
 * (visible: empty result-set), never to *carry*.
 *
 * The JS→Scheme boxing membrane (`fromJs` + the boxer registry) lives in
 * `boxing.ts`, NOT here — see that file for why the registry's writer is kept off
 * this (leakable) class.
 *
 * Lineage: provenance-on-the-value is how-provenance — provenance as an
 * expression/circuit over operators, not a flat trace (Green, Karvounarakis &
 * Tannen, "Provenance Semirings", PODS 2007). Its dual — a demanded slice of the
 * output induces the minimal slice of the input — is Galois slicing (Perera,
 * Acar, Cheney & Levy, "Functional Programs That Explain Their Work", ICFP 2012).
 */

import { INTEROP_BOUNDARY, LOCATION } from "../../well-known/symbols.js";
import type { SeenMap } from "../structural-equal.js";
import type { MembraneExit, SchemeBounceMarker, SchemeValue } from "../types.js";
import type { RunContext } from "../../run/RunContext.js";
import type { CallCtx } from "../../run/CallCtx.js";
import type { SourceLocation } from "../../errors.js";
import type { MaybePromise } from "../../types/utility.js";
import { ACallable } from "./ACallable.js";

export const EMPTY_PROVENANCE: ReadonlySet<number> = new Set<number>();

/** `arrival/provenanceChildren` default — shared frozen empty so scalars allocate nothing. */
const EMPTY_CHILDREN: readonly unknown[] = Object.freeze([]);

export type AKind =
  | "string"
  | "number"
  | "boolean"
  | "pair"
  | "nil"
  | "symbol"
  | "character"
  | "procedure"
  | "lambda"
  | "object"
  | "js-array"
  | "vector"
  | "bytevector"
  | "void"
  | "keyword"
  | "dict"
  // Opaque-crossing contract's scheme-side face (AOpaqueHandle) — branded host class.
  | "opaque";

export abstract class AValue {
  static [INTEROP_BOUNDARY] = true;
  abstract readonly kind: AKind;
  readonly provenance: ReadonlySet<number>;
  /** Source span, IMMUTABLE — set only at construction, never mutated in place.
   *  Post-construction change mints a NEW instance via `withLocation` (like
   *  `withProvenance`). SYMBOLS are the deliberate exception: ASymbol never receives
   *  a location (interning identity is load-bearing — see parse_symbol).
   *
   *  `declare`d + defined non-enumerable when set: a self-evaluating literal can return
   *  the SAME parsed instance as a computation's result, so an ENUMERABLE location would
   *  make structural equality tests see a spurious mismatch. Span is real on-value data —
   *  just never part of structural identity. */
  declare [LOCATION]?: SourceLocation;

  protected constructor(provenance: ReadonlySet<number> = EMPTY_PROVENANCE, location?: SourceLocation) {
    this.provenance = provenance;
    if (location !== undefined) {
      // Non-enumerable + non-writable + non-configurable: hidden from structural
      // comparisons AND truly immutable.
      Object.defineProperty(this, LOCATION, { value: location, enumerable: false });
    }
  }

  get location(): SourceLocation | undefined {
    return this[LOCATION];
  }

  /** Compat shim for cross-package callers that read span as a method. */
  getLocation(): SourceLocation | undefined {
    return this.location;
  }

  /** RE-STAMP twin of `withProvenance`, for location: different span means minting a new
   *  instance, never writing through `[LOCATION]`. Default answers `this` unchanged —
   *  most kinds locate once at construction. APair overrides (Parser list-head re-stamp,
   *  syntax-rules carrySpan). */
  withLocation(loc: SourceLocation): SchemeValue {
    void loc;
    return this as unknown as SchemeValue;
  }

  /** Plain-JS projection — the ONE Scheme→JS crossing protocol.
   *
   *   • SERIALIZATION (no `exit`): cache / log / HTTP. Callable stringifies; container
   *     egresses a lazy proxy whose elements unwrap through their OWN `arrival/toJS()`.
   *   • MEMBRANE crossing (`exit` supplied): nested callables become reverse-membrane
   *     host fns; RosettaOptions reach every element. Only native containers read `exit`;
   *     every scalar ignores it. `exit` is built exclusively by rosetta's `egressAValue`. */
  abstract ["arrival/toJS"](exit?: MembraneExit): unknown;

  /** AValues are immutable — provenance updates mint a new instance. Returns the
   *  `SchemeValue` union (each concrete overrides with its own narrower type).
   *  NOT abstract `AValue` (not assignable to SchemeValue); NOT `this` (clone mints
   *  `new ConcreteClass(...)`, which TS will not accept as `this` without a cast). */
  abstract withProvenance(p: ReadonlySet<number>): SchemeValue;

  /** DEEP provenance re-stamp — inbound membrane's re-stamp claim. Spine carriers
   *  (APair / AVector) mint a fresh spine via `reStampChild`; carriers without this term
   *  re-stamp shallowly via `withProvenance`. `ctx` is the CROSSING's RunContext;
   *  `seen` terminates cyclic spines. */
  ["arrival/withProvenanceDeep"]?(ctx: RunContext, p: ReadonlySet<number>, seen?: WeakSet<object>): SchemeValue;

  /**
   * READ-side twin of `withProvenanceDeep`: values this one REACHES, for deep provenance
   * union (`collapseProvenance`). A carrier that holds AValues must answer with them, or
   * members are invisible to the trace. Class is sole authority on its representation (P7)
   * — not an instanceof ladder in provenance-collapse (which would close an init cycle with
   * any `extends APair` subclass). DEFAULT: reaches nothing (correct for every scalar).
   */
  ["arrival/provenanceChildren"](): Iterable<unknown> {
    return EMPTY_CHILDREN;
  }

  /**
   * Value-layer "is this a macro?" protocol slot — `is_macro_value` reads this so the
   * lineage shadow-cone skip needs no value→eval runtime edge. Declared HERE for the
   * protocol's typing home; Macro/Syntax set it as an OWN field (none extends AValue).
   * Duck/brand test, not `instanceof` — false positive is harmless for shadow-cone skip.
   */
  readonly ["arrival/is-macro"]?: boolean;

  // ── Tagless-final algebra — OPTIONAL on AValue, the single source of truth ──
  // An entity implements the SUBSET it can handle; `symbol.taglessGuard` presence
  // dispatches. Method-style (not function-typed property) so subclasses may override.
  // tagless-final.ts derives op-name type from `keyof AValue` — add an op by declaring it here.

  /**
   * Fantasy Land Setoid — structural equality ON THE TERM. Abstract forces every
   * subtype to own its equal? (totality). `structuralEqual` is the harness: records
   * the (this, other) co-induction pair, then dispatches HERE, threading shared `seen`
   * so recursive terms co-induct through one visited set. `seen` optional: a direct
   * call starts a fresh walk; leaf Setoids ignore it.
   */
  abstract ["arrival/tagless-final/equals"](other: unknown, seen?: SeenMap): boolean;
  ["arrival/tagless-final/lte"]?(other: unknown): boolean;
  /** Code-position lowering — reader-minted literal with Clojure-style element-eval
   *  answers the `(vector …)` / `(dict …)` application ONCE (cached); null otherwise. */
  ["arrival/tagless-final/lower"]?(): SchemeValue | null;
  /** Element count — per-primitive divergence lives on the term. */
  ["arrival/tagless-final/length"]?(runCtx?: RunContext): AValue | number;
  /** Functor — map over elements. `runCtx` REQUIRED. Callback is ACallable. */
  ["arrival/tagless-final/map"]?(fn: unknown, runCtx: RunContext): MaybePromise<SchemeValue>;
  /** Filterable — ACallable pred or host RegExp sugar. `runCtx` required. */
  ["arrival/tagless-final/filter"]?(pred: unknown, runCtx: RunContext): MaybePromise<SchemeValue>;
  /** Foldable left-fold — scheme convention `fn(element, acc)`. Callback is ACallable. */
  ["arrival/tagless-final/reduce"]?<Acc extends SchemeValue>(
    fn: unknown,
    initial: Acc,
    runCtx: RunContext,
  ): Acc | Promise<Acc>;
  /** Ordering — sorted sequence (container-preserving); default is elements' own `lte`. */
  ["arrival/tagless-final/sort"]?(comparator: unknown, runCtx: RunContext): SchemeValue;
  /** Prefix — first n elements, in the receiver's OWN representation. */
  ["arrival/tagless-final/take"]?(n: number, runCtx: RunContext): MaybePromise<SchemeValue>;
  /** Suffix — receiver after first n elements. */
  ["arrival/tagless-final/drop"]?(n: number, runCtx: RunContext): MaybePromise<SchemeValue>;
  /** Longest satisfying prefix — pred SEQUENTIAL (stop at first falsy). */
  ["arrival/tagless-final/take-while"]?(pred: ACallable, runCtx: RunContext): MaybePromise<SchemeValue>;
  /** The take-while remainder. */
  ["arrival/tagless-final/drop-while"]?(pred: ACallable, runCtx: RunContext): MaybePromise<SchemeValue>;
  /** Applicable — INVOKE this value as a procedure. Callability IS declaring this term.
   *  `callCtx` threaded WHOLE (never via `this` — `this` is the callable value itself).
   *  `canBounce` opts a lambda into TCO bounce protocol. */
  ["arrival/tagless-final/apply"]?(
    args: readonly SchemeValue[],
    callCtx: CallCtx,
    canBounce?: boolean,
  ): SchemeBounceMarker | MaybePromise<SchemeValue>;
  /** Keyed member read — `:key` accessor and membrane `readMember` face. Absence IS
   *  the semantics: no term ⇒ no members (face answers nil). */
  ["arrival/tagless-final/get"]?(key: SchemeValue | string, runCtx?: RunContext): MaybePromise<SchemeValue>;
  ["arrival/tagless-final/has"]?(key: SchemeValue | string, runCtx?: RunContext): boolean;
  ["arrival/tagless-final/keys"]?(runCtx?: RunContext): string[];
  ["arrival/tagless-final/car"]?(runCtx?: RunContext): SchemeValue;
  ["arrival/tagless-final/cdr"]?(runCtx?: RunContext): SchemeValue;
  ["arrival/tagless-final/vector-ref"]?(k: number, runCtx?: RunContext): MaybePromise<SchemeValue>;
  /** Semigroup — `this ⋄ other`: container-preserving PURE append. */
  ["arrival/tagless-final/concat"]?(other: unknown): SchemeValue;
  ["arrival/tagless-final/traverse"]?(of: (x: unknown) => unknown, f: (x: unknown) => unknown): unknown;
  ["arrival/tagless-final/ap"]?(other: unknown): unknown;
  // Type-predicate GUARDS: receiver answers its own kind; lacking the method answers #f.
  ["arrival/tagless-final/vector?"]?(): boolean;
  ["arrival/tagless-final/pair?"]?(): boolean;
  ["arrival/tagless-final/symbol?"]?(): boolean;
  ["arrival/tagless-final/char?"]?(): boolean;
}

/** Distinct-by-reference provenance sets: zero → empty, one → forward, two+ → union. */
export function unionProvenance(args: readonly AValue[]): ReadonlySet<number> {
  const distinct = new Set<ReadonlySet<number>>();
  for (const arg of args) {
    if (arg.provenance.size > 0) distinct.add(arg.provenance);
  }
  switch (true) {
    case distinct.size === 0:
      return EMPTY_PROVENANCE;
    case distinct.size === 1:
      return distinct.values().next().value!;
    default: {
      const merged = new Set<number>();
      for (const s of distinct) for (const x of s) merged.add(x);
      return merged;
    }
  }
}

/**
 * ADD an origin, never REPLACE one — the inbound membrane's stamping rule.
 *
 * WHY ADDITIVE: a crossing is entitled to make a HOLISTIC claim ("output caused by
 * inputs as a whole") because a JS impl is opaque. That claim is an EDGE. What a
 * crossing is NOT entitled to do is ERASE what the value already knew. Holistic means
 * ADD AN EDGE, never REPLACE THE GRAPH.
 *
 * REPLACE can make origin NOT A SUPERSET of true dependencies, breaking the Galois
 * slicing theorem uneval stands on (docs/PROVENANCE.md / Perera–Cheney): drop an id
 * and the slice is silently TOO SMALL. OVER-approximation is safe; UNDER-approximation
 * is fatal and silent. Union makes `origin ⊇ dependencies` hold by construction.
 *
 * Reference-identity fast paths (forwarding a single Set OBJECT) preserve additivity
 * by identity accident, not by law — they are allocation optimizations. Do not
 * mistake the fast path for the guarantee.
 */
export function mergeProvenance(own: ReadonlySet<number>, added: ReadonlySet<number>): ReadonlySet<number> {
  if (added.size === 0 || own === added) return own;
  if (own.size === 0) return added;
  // Already subsumed — keep existing SET OBJECT so identity fast paths keep hitting.
  let subsumed = true;
  for (const id of added) {
    if (!own.has(id)) {
      subsumed = false;
      break;
    }
  }
  if (subsumed) return own;
  return new Set([...own, ...added]);
}

export function pointProvenance(callId: number): ReadonlySet<number> {
  return new Set([callId]);
}

// INTEROP BOUNDARY (defensive on the abstract base): accessMember's symbol-to-field
// resolution walks the prototype chain. Concrete subtypes are covered by the nominal
// FAMILY RULE in interop-access.ts. The base keeps this ONE explicit stamp as the
// defensive belt: even without the instanceof check, a subtype's walk stops at
// AValue.prototype.
