/**
 * Nil — the empty list singleton (extracted from values/types.ts).
 * `Nil.append` builds a Pair via a plain `import { APair }`. ANil extends AValue
 * (not APair) and touches APair ONLY inside the `append` method body, so the
 * resulting ANil↔APair cycle is call-only on both sides — no module-eval edge,
 * no TDZ — and ESM live-bindings resolve APair at call-time regardless of which
 * file loads first, so no late-bound constructor injection is needed.
 */
import { type SchemeValue } from "../types.js";
import { type RunContext } from "../../run/RunContext.js";
import { AValue, EMPTY_PROVENANCE } from "./AValue.js";
import { APair } from "./APair.js";
import { AExact } from "./AExact.js";

export class ANil extends AValue {
  readonly kind = "nil" as const;

  constructor(provenance: ReadonlySet<number> = EMPTY_PROVENANCE) {
    super(provenance);
  }

  static ["arrival/tagless-final/empty"](): ANil {
    return nil;
  }

  toString(): string {
    return "()";
  }

  ["arrival/print"](): string {
    return this.toString();
  }

  valueOf(): undefined {
    return undefined;
  }

  serialize(): 0 {
    return 0;
  }

  to_object(): Record<string, never> {
    return {};
  }

  // No caller today — scheme `append`/`cons` route through `concatPair`/`APair`'s own ctor.
  append<T extends SchemeValue>(x: T): APair<T, ANil> {
    return new APair<T, ANil>(x, nil);
  }

  to_array(): never[] {
    return [];
  }

  ["arrival/toJS"](): never[] {
    // '()'s JS face is [] — the empty case of the ONE list projection (a proper list
    // egresses as an array; emptiness must not flip the JS type to `null`). This matches
    // what the compiled world emits for '(), so interpreter face and compiled face agree
    // (the differential oracle compares through this face). Ingress stays permissive: JS
    // null → nil, JS arrays → borrowed vectors — egress is canonical, ingress is forgiving;
    // the container round trip is projection∘borrow, not identity.
    return [];
  }

  withProvenance(p: ReadonlySet<number>): ANil {
    return new ANil(p);
  }

  // Setoid — every Nil (including provenance clones) is equal, matching eq?'s instanceof
  // check. structuralEqual/equal? consult this first.
  ["arrival/tagless-final/equals"](other: unknown): boolean {
    return other instanceof ANil;
  }

  // Semigroup/Monoid — Nil is the EMPTY LIST, the identity of the list monoid. `nil ⋄ other
  // = other`. Co-declared with Pair's list-append Semigroup so the algebra is total over all
  // lists. Returns `other` as-is — the identity does not allocate.
  ["arrival/tagless-final/concat"]<T extends SchemeValue>(other: T): T {
    return other;
  }

  // Head/tail projection of the EMPTY list — the nil-tolerance algebra. nil is a global
  // constant bearing no run-state, so the run's mode rides the THREADED runCtx (AValue no
  // longer carries a per-value ctx at all — see AValue.ts's ctx-removal note): strict ⇒
  // the R7RS "() is not a pair" throw; tolerant ⇒ nil, so a multi-leaf proof grounds its
  // OTHER leaves rather than crashing on one absent read.
  ["arrival/tagless-final/car"](runCtx: RunContext): ANil {
    if (runCtx.strict) throw new TypeError("car: () is not a pair");
    return nil;
  }

  ["arrival/tagless-final/cdr"](runCtx: RunContext): ANil {
    if (runCtx.strict) throw new TypeError("cdr: () is not a pair");
    return nil;
  }

  // Sequence ops over the EMPTY list — the identity cases (the fl-interop dissolution: the
  // empty case lives ON the term, not a dispatch branch). map/filter of nothing is nothing
  // (nil); reduce of nothing is the seed, fn never called.
  ["arrival/tagless-final/map"](_fn: unknown): ANil {
    return nil;
  }

  ["arrival/tagless-final/filter"](_arg: unknown): ANil {
    return nil;
  }

  ["arrival/tagless-final/reduce"]<A>(_fn: unknown, initial: A): A {
    return initial;
  }

  // Sort of the EMPTY list is the empty list — the identity case (mirrors map/filter above).
  // The comparator is never consulted; nil is the canonical empty singleton.
  ["arrival/tagless-final/sort"](_comparator?: unknown, _runCtx?: unknown): ANil {
    return nil;
  }

  ["arrival/tagless-final/take"](_n: unknown): ANil {
    return nil;
  }

  ["arrival/tagless-final/drop"](_n: unknown): ANil {
    return nil;
  }

  ["arrival/tagless-final/take-while"](_pred: unknown): ANil {
    return nil;
  }

  ["arrival/tagless-final/drop-while"](_pred: unknown): ANil {
    return nil;
  }

  // Length of the EMPTY list is 0 — the authoritative empty-count (mirrors the map/filter/
  // reduce empty cases above; the fl-interop `length` overlay's nil-branch dissolved ONTO
  // the term). No elements ⇒ no provenance to carry, but a raw `0` is a bare-value-purge
  // violation (every arithmetic result must be a boxed AValue) — so this mints a fresh
  // empty-provenance `AExact`.
  //
  // `_runCtx` is intentionally unread: `nil` itself is the shared singleton (see below), and
  // the sole caller (`env/r7rs/lists.ts`'s `length` builtin) dispatches via `m.call(obj)` with
  // no runCtx argument at all — so threading this parameter alone would not change what gets
  // minted. Fixing that requires the caller to thread its own live runCtx (`m.call(obj,
  // runCtx)`) first; that change is owned by the env/r7rs cluster, not this term.
  ["arrival/tagless-final/length"](_runCtx?: unknown): AExact {
    return new AExact(0);
  }
}

export const nil = new ANil();
