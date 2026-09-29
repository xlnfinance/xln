import { ABool } from "./primitives/ABool.js";
import { ASymbol } from "./primitives/ASymbol.js";
import { AExact } from "./primitives/AExact.js";
import { AInexact } from "./primitives/AInexact.js";
import { ANil } from "./primitives/ANil.js";
import { ACharacter } from "./primitives/ACharacter.js";
import { AOpaqueHandle } from "./primitives/AOpaqueHandle.js";
import { tf } from "./tagless-final.js";

/**
 * Cycle-safe structural deep-equality for Scheme values — the ONE `equal?`
 * implementation (R7RS-small §6.1). Routed to by every surface (`env/r7rs/equality.ts`'s
 * `equal?`, `env/r7rs/lists.ts`'s `member`/`assoc`, and each term's own Setoid recursion)
 * — a single walker so every caller agrees on cycles, SchemeCharacter, and
 * Scheme numeric/provenance types.
 *
 * Walks the two values in lock-step, tracking visited `(a, b)` reference pairs
 * so cycles terminate co-inductively (a node already being compared against its
 * partner is assumed equal — the standard occurs-check). Never throws a native
 * serialization error; always returns a boolean.
 *
 * Equality dispatches through each value's Fantasy Land Setoid
 * (`arrival/tagless-final/equals`).
 */
/**
 * The co-induction visited set threaded through a single `equal?` walk. Maps each
 * visited `a`-reference to the SET of `b`-partners it has been compared against on
 * the current path; a re-encountered `(a, b)` short-circuits to true. Shared by the
 * harness AND by each term's `arrival/tagless-final/equals` (Pair/Vector recurse
 * through `structuralEqual` threading this map), so mutually-cyclic structures
 * terminate. Exported so AValue's abstract Setoid can type its optional `seen`
 * parameter identically.
 */
export type SeenMap = Map<object, Set<object>>;

export function structuralEqual(a: unknown, b: unknown, seen: SeenMap = new Map()): boolean {
  // Fast paths: identity, then valueOf-equality (covers SchemeExact/Inexact,
  // boxed primitives, SchemeCharacter's __char__ via valueOf) and SchemeString's
  // `__string__`.
  if (a === b) return true;
  if (a == null || b == null) return a === b;

  // Co-induction bookkeeping applies only to object pairs; record the (a, b)
  // partner BEFORE descending so cyclic structures (Pair/Vector/array/plain
  // object) terminate. Primitives can't carry cycles and fall straight through.
  if (typeof a === "object" && typeof b === "object") {
    const partners = seen.get(a);
    if (partners?.has(b)) return true;
    if (partners) partners.add(b);
    else seen.set(a, new Set([b]));
  }

  // Setoid (Fantasy Land): a value that defines its own equality OWNS the comparison.
  // Now total over every AValue (the abstract method forces it) — Pair and SchemeVector
  // route HERE, each threading the shared `seen` so cyclic terms terminate. Opaque
  // entities (IP/hash/SID) whose canonical match differs from structural key comparison
  // also own it; an entity compared to a non-entity (a bare literal) returns false.
  // Symmetric. The `seen` is forwarded so a Setoid's element recursion co-inducts
  // through the SAME visited set this harness just recorded into.
  // Narrow to a record only for the bracket dispatch; the original operand keeps its
  // type for the valueOf/`__string__` primitive fast-paths below.
  const ao = a as Record<PropertyKey, unknown>;
  const bo = b as Record<PropertyKey, unknown>;
  const aEquals = ao[tf("equals")];
  if (typeof aEquals === "function") return Boolean(aEquals.call(ao, b, seen));
  const bEquals = bo[tf("equals")];
  if (typeof bEquals === "function") return Boolean(bEquals.call(bo, a, seen));

  // valueOf covers SchemeExact/Inexact, boxed primitives, SchemeCharacter; __string__
  // covers SchemeString. These fast-paths are reachable for BOTH objects and primitives
  // (a boxed SchemeString vs a raw string compares equal here), so they run before the
  // object-only recursion below.
  const av = (ao.valueOf as (() => unknown) | undefined)?.call(ao);
  const bv = (bo.valueOf as (() => unknown) | undefined)?.call(bo);
  if (av === bv && (typeof av !== "object" || av === null)) return true;
  const aStr = ao.__string__ as unknown;
  const bStr = bo.__string__ as unknown;
  if (aStr != null && bStr != null) return aStr === bStr;

  if (typeof a !== "object" || typeof b !== "object") return false;

  // Arrays (incl. AJSArray sources are raw arrays by this point).
  const aArr = Array.isArray(a);
  const bArr = Array.isArray(b);
  if (aArr || bArr) {
    if (!aArr || !bArr || (a as unknown[]).length !== (b as unknown[]).length) return false;
    const aArr2 = a as unknown[];
    const bArr2 = b as unknown[];

    for (let i = 0; i < aArr2.length; i++) {
      if (!structuralEqual(aArr2[i], bArr2[i], seen)) return false;
    }
    return true;
  }

  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  const ao2 = a as Record<string, unknown>;
  const bo2 = b as Record<string, unknown>;
  for (const k of aKeys) {
    if (!Object.prototype.hasOwnProperty.call(bo2, k)) return false;
    if (!structuralEqual(ao2[k], bo2[k], seen)) return false;
  }
  return true;
}

// ----------------------------------------------------------------------
// R7RS § 6.1 — the lower two tiers of the equivalence hierarchy (`eq?`/`eqv?`).
// `equal?` (structuralEqual, above) is the third. Co-located here so the three
// grades live in one equality leaf — and so a future Setoid (arrival/tagless-final/
// equals) consolidation has a single home.
//
// Must stay three distinct functions, not two-plus-an-alias: a single
// structural-ish `equal` helper aliased to both `eq?`/`eqv?` collapses distinct
// heap SchemeString instances to #t via a `.valueOf() === .valueOf()` branch —
// flattening the three-tier hierarchy and breaking `memq`/`assv`/`case` dispatch
// and the atom-grade contract that `(eqv? (string-copy "a") (string-copy "a"))`
// MUST be #f.
//
// The three grades:
//   - `eq?` — pointer-grade. R7RS lets implementations make immediates (numbers,
//     chars, interned symbols, nil, booleans) answer #t across distinct heap
//     copies; we lean inclusive because the provenance clone machinery
//     (AValue.withProvenance) routinely mints copies of canonically-identifying
//     values that should still compare eq? — else `(eq? (if #t #f #t) (if #f #t #f))`
//     would surprise readers (both arms produce a SchemeBool(false) clone with a
//     different provenance heap-id, but the canonical answer is #t).
//   - `eqv?` — eq? plus explicit number/char value equality. eq? above already
//     covers SchemeExact/SchemeInexact (via .equals) and chars (__char__), so
//     eqv? reduces to eq? today. Kept distinct so any future divergence (NaN/±0,
//     exact/inexact crossing) lands in one named place.
//   - `equal?` — structural recursion (structuralEqual).
//
// Provenance-clone trap: `x === y` is NOT sufficient for symbols/nil/booleans —
// every withProvenance() call mints a fresh heap object. Use instance-aware
// checks so clones still compare eq? (else an `if`-induced clone of nil/#f fails
// eq? against the singleton, breaking `(eq? x '())`).
// ----------------------------------------------------------------------
export function eq(x: unknown, y: unknown): boolean {
  // Identity first (pointer-grade Pair / vector / SchemeString / plain object).
  // Scalars route through their Setoid (`arrival/tagless-final/equals`) on the term.
  // ABool is representation-blind (equals a raw JS boolean) but `eq?`/`eqv?` stay
  // pointer-grade over BOXED values — bare `true` is not eq? to a boxed ABool.
  if (x === y) return true;
  if (
    x instanceof ASymbol ||
    x instanceof ANil ||
    x instanceof ACharacter ||
    x instanceof AExact ||
    x instanceof AInexact
  ) {
    return x[tf("equals")](y);
  }
  if (x instanceof ABool) return y instanceof ABool && x[tf("equals")](y);
  // AOpaqueHandle is the SAME provenance-clone trap: `withProvenance` mints a fresh
  // wrapper on re-stamp (AValue's immutability rule), so two independently-minted
  // handles over the SAME host instance must still compare `eq?` true — routed through
  // its Setoid (`.instance` identity), never the wrapper's own `===`.
  if (x instanceof AOpaqueHandle) return x[tf("equals")](y);
  // Everything else (Pair, vector/Array, SchemeString, plain objects) keeps
  // strict pointer-grade — distinct heap instances answer #f (the === above is
  // the only true case).
  return false;
}

export function eqv(x: unknown, y: unknown): boolean {
  // eqv? = eq? + explicit number/char equality, both already in eq() above.
  return eq(x, y);
}
