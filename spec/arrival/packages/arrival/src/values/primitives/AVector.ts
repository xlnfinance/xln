/**
 * Boxes a raw JS array into the AValue kernel so it carries provenance and hosts
 * Fantasy Land algebras. Vectors are IMMUTABLE — vector-set!/vector-fill!/vector-copy!
 * are notImplemented stubs; every "mutator" returns a fresh AVector.
 *
 * DISAMBIGUATION: a raw JS `Array` is heavily overloaded (evaluateArgs carrier,
 * syntax-rules ellipsis, JS-array-as-list at the membrane) and is NOT a vector. Only
 * vector literals / make-vector / vector builtins mint AVector. Being its own class
 * leaves `Array.isArray` sites unaffected — never widen them to accept it.
 *
 * Lineage: R7RS-small §6.8 vectors; Setoid/Semigroup/Functor/Filterable/Foldable are Fantasy Land.
 */
import { CONSTANT_CTX, type RunContext } from "../../run/RunContext.js";
import { makeCallCtx } from "../../run/CallCtx.js";
import { applyCallback, type ACallable } from "./ACallable.js";
import { is_false, is_promise } from "../../values/value-guards.js";
import { promise_all } from "../../utils/promises.js";
import { AValue, EMPTY_PROVENANCE, mergeProvenance } from "./AValue.js";
import { egressContainerProxy } from "../../membrane/egress-proxy.js";
import { ANil, nil } from "./ANil.js";
import { strictGate, type SourceLocation } from "../../errors.js";
import { printValue } from "../print.js";
import { type SeenMap, structuralEqual } from "../structural-equal.js";
import type { MembraneExit, SchemeValue } from "../types.js";
// op-helpers imports AVector back — both directions are function-body only, so the cycle
// never bites at module-eval.
import { deriveSortCompare, withInputProvenance } from "../op-helpers.js";
import { reStampChild } from "./deep-restamp.js";
import { APair } from "./APair.js";
import { ASymbol } from "./ASymbol.js";

/** Code-position lowering cache for `[…]` literal nodes — `(vector …)` built once per node. */
const LOWERED_LITERAL = new WeakMap<AVector, APair<SchemeValue, SchemeValue>>();

export class AVector<T extends SchemeValue = SchemeValue> extends AValue {
  readonly kind = "vector" as const;

  /** `[…]` reader-literal marker: CODE position evaluates elements (Clojure semantics)
   *  by lowering to `(vector …)`. Under `quote` the node is data. False for `#(…)`
   *  R7RS constants and constructed vectors. Reader-minted only. */
  evalElements = false;

  constructor(
    /** Element payload — public but dunder-named: read-only; mutation constructs a fresh vector. */
    public readonly __vector__: readonly T[],
    provenance: ReadonlySet<number> = EMPTY_PROVENANCE,
    location?: SourceLocation,
  ) {
    super(provenance, location);
  }

  get length(): number {
    return this.__vector__.length;
  }

  static isVector(x: unknown): x is AVector {
    return x instanceof AVector;
  }

  ref(i: number): SchemeValue {
    return this.__vector__[i];
  }

  copy(start = 0, end = this.__vector__.length): AVector {
    return new AVector(this.__vector__.slice(start, end));
  }

  // R9 lazy egress — ONE method, keyed on `exit`. Bare: per-box identity.
  // Membrane: full recursive crossing, proxy caches per (box, mode, SCOPE).
  ["arrival/toJS"](exit?: MembraneExit): readonly unknown[] {
    const elements = this.__vector__;
    return egressContainerProxy(
      this,
      "array",
      {
        keys: () => elements.map((_, i) => String(i)),
        read: (key) => elements[Number(key)],
      },
      exit ? { membrane: exit } : undefined,
    ) as readonly unknown[];
  }

  valueOf(): readonly T[] {
    return this.__vector__;
  }

  withProvenance(p: ReadonlySet<number>): AVector {
    const v = new AVector(this.__vector__, p, this.location);
    // Same-identity re-stamp: a `[…]` literal node stays a `[…]` literal node.
    v.evalElements = this.evalElements;
    return v;
  }

  /** Deep re-stamp (inbound membrane). Fresh vector; elements through reStampChild.
   *  Does NOT copy `evalElements` — a membrane-crossed vector is never a reader-minted literal. */
  ["arrival/withProvenanceDeep"](
    ctx: RunContext,
    p: ReadonlySet<number>,
    seen: WeakSet<object> = new WeakSet(),
  ): AVector {
    seen.add(this);
    return new AVector(
      this.__vector__.map((el) => reStampChild(el, ctx, p, seen)),
      // UNION, not replace — crossing ADDS its origin.
      mergeProvenance(this.provenance, p),
    );
  }

  // Code-position lowering: `[…]` reader-literal lowers ONCE, cached, to `(vector …)`.
  // `#(…)` and constructed vectors answer null.
  ["arrival/tagless-final/lower"](): APair<SchemeValue, SchemeValue> | null {
    if (!this.evalElements) return null;
    let lowered = LOWERED_LITERAL.get(this);
    if (lowered === undefined) {
      lowered = APair.fromArray(CONSTANT_CTX, [new ASymbol("vector"), ...this.__vector__], false) as APair<
        SchemeValue,
        SchemeValue
      >;
      LOWERED_LITERAL.set(this, lowered);
    }
    return lowered;
  }

  // Setoid — structural element-wise equality, threading shared `seen` for co-induction.
  ["arrival/tagless-final/equals"](other: unknown, seen?: SeenMap): boolean {
    if (!(other instanceof AVector)) return false;
    const a = this.__vector__;
    const b = other.__vector__;
    if (a.length !== b.length) return false;
    for (const [i, element] of a.entries()) {
      if (!structuralEqual(element, b[i], seen)) return false;
    }
    return true;
  }

  ["arrival/tagless-final/concat"](other: AVector): AVector {
    return new AVector([...this.__vector__, ...other.__vector__]);
  }

  // STRICT divergence: car/cdr are PAIR ops — a vector is not a pair. STRICT flags
  // non-portable; LOOSE tolerates: car = first element (nil when empty); cdr = rest as
  // fresh AVector SLICE — stays a genuine vector, deliberately NOT an AJSArrayList spine
  // view (that chart belongs on borrowed arrays only; see AJSArrayList manifold note).
  ["arrival/tagless-final/car"](runCtx?: RunContext): SchemeValue {
    strictGate(runCtx, {
      op: "car",
      rule: "R7RS `car` requires a pair; a vector is not a pair",
      alternative: "use `(vector-ref v 0)` for the first element, or `(vector->list v)`",
    });
    return this.__vector__.length > 0 ? this.__vector__[0] : nil;
  }

  ["arrival/tagless-final/cdr"](runCtx?: RunContext): AVector | ANil {
    strictGate(runCtx, {
      op: "cdr",
      rule: "R7RS `cdr` requires a pair; a vector is not a pair",
      alternative: "use vector slicing or `(vector->list v)`",
    });
    // Rest AS A VECTOR SLICE — not an AJSArrayList spine. Residual: a null?-terminated
    // walk over a VECTOR LITERAL will not terminate (exhausted slice is `#()`, null? is
    // ANil-only). Bites only genuine vector literals; strict mode doors it. Honest fix:
    // `(vector->list v)`.
    return new AVector(this.__vector__.slice(1), this.provenance);
  }

  /** Elements ground the vector; the vector itself does not stamp from them. */
  override ["arrival/provenanceChildren"](): Iterable<unknown> {
    return this.__vector__;
  }

  ["arrival/print"](): string {
    return `#(${this.__vector__.map((el) => printValue(el)).join(" ")})`;
  }

  // Functor map — PRESERVES every mapped element's box, rebuilds fresh AVector.
  // LENGTH-PRESERVING — PROXY container's own stamp through unchanged.
  // Callback is ACallable only — same discipline as APair.
  ["arrival/tagless-final/map"](fn: ACallable, runCtx: RunContext): AVector | Promise<AVector> {
    strictGate(runCtx, {
      op: "map",
      rule: "R7RS `map` operates on lists; a vector is not a list",
      alternative: "use `vector-map` for vectors",
    });

    const results = this.__vector__.map((v) => applyCallback(fn, [v], makeCallCtx(runCtx)));
    if (results.some(is_promise)) {
      return (promise_all(results) as Promise<SchemeValue[]>).then(
        (resolved): AVector => withInputProvenance([this], new AVector(resolved)),
      );
    }
    return withInputProvenance([this], new AVector(results as SchemeValue[]));
  }

  // Filterable — keeps matching elements, PRESERVING boxes. LENGTH-CHANGING —
  // PROVENANCED fresh as union of container stamp + survivors' stamps.
  async ["arrival/tagless-final/filter"](arg: ACallable | RegExp, runCtx: RunContext): Promise<AVector> {
    strictGate(runCtx, {
      op: "filter",
      rule: "`filter` (SRFI-1) operates on lists; a vector is not a list",
      alternative: "filter the list form: (list->vector (filter pred (vector->list v)))",
    });

    const out: SchemeValue[] = [];
    if (arg instanceof RegExp) {
      const re = arg;
      for (const v of this.__vector__) {
        if (!is_false(String(v).match(re))) out.push(v);
      }
      return withInputProvenance([this, ...out], new AVector(out));
    }
    for (const v of this.__vector__) {
      const verdict = await applyCallback(arg, [v], makeCallCtx(runCtx));
      if (!is_false(verdict)) out.push(v); // R7RS: only #f is false
    }
    return withInputProvenance([this, ...out], new AVector(out));
  }

  // Async-aware reduce, SRFI fold `fn(element, acc)`, left fold.
  async ["arrival/tagless-final/reduce"]<Acc extends SchemeValue>(
    fn: ACallable,
    initial: Acc,
    runCtx: RunContext,
  ): Promise<Acc> {
    strictGate(runCtx, {
      op: "reduce",
      rule: "`reduce` (SRFI-1) operates on lists; a vector is not a list",
      alternative: "reduce the list form via (vector->list v)",
    });

    let acc = initial;
    for (const v of this.__vector__) acc = (await applyCallback(fn, [v, acc], makeCallCtx(runCtx))) as Acc;
    return acc;
  }

  // Structure-preserving sort — LENGTH-PRESERVING, PROXIED stamp (must agree with APair).
  // Comparator is ACallable when supplied.
  ["arrival/tagless-final/sort"](comparator: ACallable | undefined, runCtx: RunContext): AVector {
    const out = [...this.__vector__];
    out.sort(deriveSortCompare(comparator, runCtx));
    return withInputProvenance([this], new AVector(out));
  }

  // Prefix — SAME-KIND, LENGTH-CHANGING (PROVENANCED fresh). `n` clamped into [0, length].
  ["arrival/tagless-final/take"](n: number, runCtx: RunContext): AVector {
    strictGate(runCtx, {
      op: "take",
      rule: "`take` (SRFI-1) operates on lists; a vector is not a list",
      alternative: "take the list form: (list->vector (take (vector->list v) n))",
    });
    const k = Math.max(0, Math.min(n, this.__vector__.length));
    const out = this.__vector__.slice(0, k);
    return withInputProvenance([this, ...out], new AVector(out));
  }

  ["arrival/tagless-final/drop"](n: number, runCtx: RunContext): AVector {
    strictGate(runCtx, {
      op: "drop",
      rule: "`drop` (SRFI-1) operates on lists; a vector is not a list",
      alternative: "drop the list form: (list->vector (drop (vector->list v) n))",
    });
    const k = Math.max(0, Math.min(n, this.__vector__.length));
    const out = this.__vector__.slice(k);
    return withInputProvenance([this, ...out], new AVector(out));
  }

  // Longest satisfying prefix — SEQUENTIAL walk (stop at first falsy is the semantics).
  async ["arrival/tagless-final/take-while"](pred: ACallable, runCtx: RunContext): Promise<AVector> {
    strictGate(runCtx, {
      op: "take-while",
      rule: "`take-while` (SRFI-1) operates on lists; a vector is not a list",
      alternative: "(list->vector (take-while pred (vector->list v)))",
    });
    const out: SchemeValue[] = [];
    for (const v of this.__vector__) {
      const verdict = await applyCallback(pred, [v], makeCallCtx(runCtx));
      if (is_false(verdict)) break;
      out.push(v);
    }
    return withInputProvenance([this, ...out], new AVector(out));
  }

  async ["arrival/tagless-final/drop-while"](pred: ACallable, runCtx: RunContext): Promise<AVector> {
    strictGate(runCtx, {
      op: "drop-while",
      rule: "`drop-while` (SRFI-1) operates on lists; a vector is not a list",
      alternative: "(list->vector (drop-while pred (vector->list v)))",
    });
    let i = 0;
    for (; i < this.__vector__.length; i++) {
      const verdict = await applyCallback(pred, [this.__vector__[i]!], makeCallCtx(runCtx));
      if (is_false(verdict)) break;
    }
    const out = this.__vector__.slice(i);
    return withInputProvenance([this, ...out], new AVector(out));
  }

  // Element-count — container's OWN flat stamp, never elements' deep union.
  ["arrival/tagless-final/length"](_runCtx?: unknown): AValue | number {
    return withInputProvenance([this], this.__vector__.length);
  }

  ["arrival/tagless-final/vector?"](): boolean {
    return true;
  }

  // Bounds-checked (R7RS §6.8) — out-of-range throws clean RangeError, never leaks undefined.
  ["arrival/tagless-final/vector-ref"](k: number): SchemeValue {
    if (!Number.isInteger(k) || k < 0 || k >= this.__vector__.length) {
      throw new RangeError(`vector-ref: index ${k} out of range for a vector of length ${this.__vector__.length}`);
    }
    return this.__vector__[k];
  }

  // Host-JS iterability. Membrane never exposes Symbol.iterator (BLOCKED_WELL_KNOWN_SYMBOL).
  [Symbol.iterator](): Iterator<SchemeValue> {
    return this.__vector__[Symbol.iterator]();
  }
}

// Producer-minted (#(...) / make-vector / vector / …), NOT boxed from JS —
// fromJs maps a JS array to borrowed AJSArray, not AVector.

// INTEROP BOUNDARY: nominal FAMILY RULE in interop-access.ts covers the hierarchy.
