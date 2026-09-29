/**
 * The cons cell. Metadata (datum-label/cycle marks, provenance) rides on the instance
 * (symbol-keyed), not a sidecar map — value and origin travel together under structure
 * sharing. Source location is the base-class (`AValue`) channel, immutable and
 * constructor-only; Pair remains the one class whose span gets RE-STAMPED post-
 * construction (Parser list-head re-stamp, syntax-rules' `carrySpan`) — hence the
 * `withLocation` override. Cyclic spines (reader datum labels, the `__tieKnot` door —
 * `set-cdr!` is a notImplemented stub) are detected by `isCircularList` (Floyd's).
 * Interop boundary: nominal `instanceof AValue` FAMILY RULE in interop-access.ts.
 *
 * Lineage: free monoid over elements; Fantasy Land Functor/Foldable/Traversable/
 * Chain/Monoid/Semigroup. Trampolined style (Ganz et al., ICFP 1999); Floyd cycle detect.
 */
import { CYCLES, DATA, REF } from "../../well-known/symbols.js";
import { applyMembraneClosure, CONSTANT_CTX, type RunContext } from "../../run/RunContext.js";
import { makeCallCtx } from "../../run/CallCtx.js";
import { applyCallback, type ACallable } from "./ACallable.js";
import invariant from "tiny-invariant";
import { AValue, EMPTY_PROVENANCE, mergeProvenance } from "./AValue.js";
import { deriveSortCompare, withInputProvenance } from "../op-helpers.js";
import { type SeenMap, structuralEqual } from "../structural-equal.js";
import { NoLensError, type SourceLocation } from "../../errors.js";
import { is_false, is_plain_object, is_promise } from "../../values/value-guards.js";
import { promise_all } from "../../utils/promises.js";
// provenance-collapse.ts is a LEAF — it dispatches on the `arrival/provenanceChildren` term
// rather than importing every value class to instanceof them. Structurally required: an import
// cycle here would forbid any value class from `extends APair`, which AJSArrayList does.
import { collapseProvenance } from "../../provenance/provenance-collapse.js";
import { reStampChild } from "./deep-restamp.js";
import { egressContainerProxy } from "../../membrane/egress-proxy.js";
import { AListAlike, APairAsListValue, type MembraneExit, type SchemeValue } from "../types.js";
import { AString } from "./AString.js";
import { ASymbol } from "./ASymbol.js";
import { AExact } from "./AExact.js";
import { AInexact } from "./AInexact.js";
import { ANil, nil } from "./ANil.js";
import { printValue } from "../print.js";
import { tf } from "../tagless-final.js";
import type { MaybePromise } from "../../types/utility.js";

// Trampoline thunk: `mark_cycles` walks arbitrarily deep lists, so it bounces
// through these instead of recursing and overflowing the native stack.
class Thunk {
  constructor(
    public readonly fn: () => Thunk | void,
    public readonly cont: () => void = () => {},
  ) {}

  toString(): string {
    return "#<Thunk>";
  }
}

const trampoline =
  (fn: (pair: SchemeValue, parents: AListAlike[]) => Thunk | void) => (pair: SchemeValue, parents: AListAlike[]) => {
    let result = fn(pair, parents);
    while (result instanceof Thunk) {
      const thunk = result;
      result = result.fn();
      if (!(result instanceof Thunk)) {
        thunk.cont();
      }
    }
  };

/**
 * Floyd's tortoise/hare cycle detection on the cdr-spine. O(n) time, O(1) space.
 * Returns true iff the list is CIRCULAR. Unlike `have_cycles()` (metadata from
 * reader `#0=` labels only), this ACTIVELY detects any cyclic spine — the gap
 * behind list?/length/append non-termination. Spine-walking builtins guard on
 * this. Never throws; the caller decides what a cycle means.
 */
export function isCircularList(head: APair<any, any>): boolean {
  let slow = head;
  let fast = head;
  while (fast instanceof APair && fast.cdr instanceof APair) {
    slow = slow.cdr;
    fast = fast.cdr.cdr;
    if (slow === fast) return true;
  }
  return false;
}

function is_cycle(pair: unknown): boolean {
  if (!(pair instanceof APair)) {
    return false;
  }
  if (pair.have_cycles()) {
    return true;
  }
  return is_cycle(pair.car) || is_cycle(pair.cdr);
}

function mark_cycles(pair: APair<any, any>): void {
  const seen_pairs: AListAlike[] = [];
  const cycles: AListAlike[] = [];
  const refs: AListAlike[] = [];

  function visit(pair2: APair<any, any>): void {
    if (!seen_pairs.includes(pair2)) {
      seen_pairs.push(pair2);
    }
  }

  function set(node: AListAlike, type: "car" | "cdr", child: unknown, parents: AListAlike[]): boolean {
    if (child instanceof APair && parents.includes(child)) {
      if (!refs.includes(child)) {
        refs.push(child);
      }
      if (!node[CYCLES]) {
        node[CYCLES] = {};
      }
      node[CYCLES][type] = child;
      if (!cycles.includes(node)) {
        cycles.push(node);
      }
      return true;
    }
    return false;
  }

  const detect = trampoline(function detect_thunk(pair2: SchemeValue, parents: AListAlike[]): Thunk | void {
    if (pair2 instanceof APair) {
      const pairWithCycles = pair2;
      delete pairWithCycles[REF];
      delete pairWithCycles[CYCLES];
      visit(pair2);
      parents.push(pair2);
      const car = set(pairWithCycles, "car", pair2.car, parents);
      const cdr = set(pairWithCycles, "cdr", pair2.cdr, parents);
      if (!car) {
        detect(pair2.car, [...parents]);
      }
      if (!cdr) {
        return new Thunk(() => {
          return detect_thunk(pair2.cdr, [...parents]);
        });
      }
    }
  });

  function mark_node(node: AListAlike, type: "car" | "cdr"): void {
    const cycleData = node[CYCLES];
    if (cycleData && cycleData[type] instanceof APair) {
      const count = ref_nodes.indexOf(cycleData[type]);
      cycleData[type] = `#${count}#`;
    }
  }

  detect(pair, []);
  const ref_nodes = seen_pairs.filter((node) => refs.includes(node));
  for (const [i, node] of ref_nodes.entries()) {
    node[REF] = `#${i}=`;
  }
  for (const node of cycles) {
    mark_node(node, "car");
    mark_node(node, "cdr");
  }
}

/**
 * INTERNAL knot-tying door — the ONE mutation path through APair's readonly slots.
 * A cycle cannot be constructed immutably (self-referential spine has no construction
 * order), so clone, the reader's datum-label resolution, and syntax-rules' ellipsis
 * surgery patch through HERE. Ugly name IS the fence; not exported from the package index.
 */
export function __tieKnot(pair: AListAlike, slot: "car" | "cdr", v: SchemeValue): void {
  // Writes the protected SLOT, not the accessor. Must never target a lazy view
  // (AJSArrayList): a view computes car/cdr from its backing array and would swallow the write.
  Error.invariant(
    !(pair instanceof APair) || Object.getPrototypeOf(pair) === APair.prototype,
    "__tieKnot: refusing to tie a knot into a lazy pair view — only a stored cons cell can hold one",
  );
  (pair as unknown as { _car: SchemeValue; _cdr: SchemeValue })[slot === "car" ? "_car" : "_cdr"] = v;
}

// Local fold helpers for tagless-final/get — duplicated on purpose to avoid
// APair → AJSObject → rosetta import cycle (APair already on rosetta's build path).
function foldAlistKeyName(key: SchemeValue | string): string {
  const raw =
    typeof key === "string" ? key : String((key as { valueOf?: () => unknown } | null | undefined)?.valueOf?.() ?? key);
  return raw.startsWith(":") ? raw.slice(1) : raw;
}

/** An alist entry's key name, iff `entryCar` is itself a symbol/keyword-symbol or
 *  string (the only key shapes `:key` can ever be asked to match) — `undefined` for
 *  anything else (a numeric or pair key means this entry is never a `:key` candidate). */
function alistEntryKeyName(entryCar: SchemeValue): string | undefined {
  if (entryCar instanceof ASymbol) return foldAlistKeyName(entryCar.valueOf() as string);
  if (entryCar instanceof AString) return entryCar.valueOf();
  return undefined;
}

export class APair<Car extends SchemeValue, Cdr extends SchemeValue> extends AValue {
  // Interop: nominal FAMILY RULE (`instanceof AValue`) stops the prototype walk — no per-class stamp.
  readonly kind = "pair" as const;
  [DATA]?: boolean;
  [CYCLES]?: { car?: string | AListAlike; cdr?: string | AListAlike };
  [REF]?: string;

  // `car`/`cdr` are PROTOTYPE ACCESSORS over protected slots — load-bearing, not stylistic.
  // An own data field shadows a prototype accessor, so a subclass's `get cdr()` would never
  // be consulted after `super()`. Accessor form lets a value BE a pair without STORING a
  // spine (AJSArrayList: O(1) view over a borrowed JS array). Readonly contract (getter, no
  // setter); `__tieKnot` is the ONE mutation path and the only code that may touch `_car`/`_cdr`.
  protected _car: Car;
  protected _cdr: Cdr;

  get car(): Car {
    return this._car;
  }

  get cdr(): Cdr {
    return this._cdr;
  }

  constructor(car: Car, cdr: Cdr, provenance: ReadonlySet<number> = EMPTY_PROVENANCE, location?: SourceLocation) {
    super(provenance, location);
    this._car = car;
    this._cdr = cdr;
  }

  static match(obj: unknown, item: string | RegExp | ASymbol): boolean {
    if (obj instanceof ASymbol) {
      return ASymbol.is(obj, item);
    } else if (obj instanceof APair) {
      return APair.match(obj.car, item) || APair.match(obj.cdr, item);
    } else if (Array.isArray(obj)) {
      return obj.some((x) => APair.match(x, item));
    } else if (is_plain_object(obj)) {
      return Object.values(obj).some((x) => APair.match(x, item));
    }
    return false;
  }

  // `quote` false ⟹ APair | ANil; `quote: true` also admits DATA-marked array pass-through.
  // Runtime `quote: boolean` arm stays wide (internal recursion).
  static fromArray<T extends SchemeValue>(
    ctx: RunContext,
    array: readonly T[],
    deep?: boolean,
    quote?: false,
  ): AListAlike<T>;
  static fromArray<T extends SchemeValue>(
    ctx: RunContext,
    array: readonly T[],
    deep: boolean,
    quote: true,
  ): AListAlike<T> | unknown[];
  static fromArray<T extends SchemeValue>(
    ctx: RunContext,
    array: readonly T[],
    deep: boolean,
    quote: boolean,
  ): AListAlike<T> | unknown[];
  static fromArray<T extends SchemeValue>(
    ctx: RunContext,
    array: readonly T[],
    deep = true,
    quote = false,
  ): AListAlike<T> | unknown[] {
    if (
      array instanceof APair ||
      (quote && Array.isArray(array) && (array as unknown as { [key: symbol]: unknown })[DATA])
    ) {
      // AListAlike<T> conditional is deferred for abstract T — cast to parameterized alias.
      return array as AListAlike<T> | unknown[];
    }
    const arr = Array.isArray(array) ? array : [...(array as Iterable<unknown>)];
    if (deep === false) {
      let list: AListAlike = nil;
      for (let i = arr.length; i--; ) {
        list = new APair(arr[i], list);
      }
      return list as AListAlike<T>;
    }
    let result: AListAlike = nil;
    let i = arr.length;
    while (i--) {
      let car: unknown = arr[i];
      if (Array.isArray(car)) {
        car = APair.fromArray(ctx, car, deep, quote);
      } else if (typeof car === "string") {
        car = new AString(car);
      } else if (typeof car === "number" && !Number.isNaN(car)) {
        car = Number.isSafeInteger(car) ? new AExact(car) : new AInexact(car);
      } else if (typeof car === "bigint") {
        // Host bigint never enters scheme (NoLensError) — convert first.
        throw new NoLensError("bigint");
      }
      result = new APair(car as SchemeValue, result);
    }
    return result as AListAlike<T>;
  }

  static fromPairs(ctx: RunContext, array: [string, SchemeValue][]): AListAlike {
    return this.fromArray(
      ctx,
      array.map(([left, right]) => new APair(new ASymbol(left), right)),
    );
  }

  static fromObject(ctx: RunContext, obj: Record<string, SchemeValue>): AListAlike {
    return APair.fromPairs(
      ctx,
      Object.keys(obj).map((key) => [key, obj[key]] as const),
    );
  }

  static ["arrival/tagless-final/empty"](): ANil {
    return nil;
  }

  // Applicative — single-element list. No-arg static has no crossing to derive a live ctx from.
  static ["arrival/tagless-final/of"](value: SchemeValue): AListAlike {
    return new APair(value, nil);
  }

  flatten(): AListAlike | unknown[] {
    return APair.fromArray(CONSTANT_CTX, this.to_array().flat(Infinity));
  }

  length(): number {
    let len = 0;
    let node: AListAlike | unknown = this;
    while (true) {
      if (!node || node instanceof ANil || !(node instanceof APair) || node.have_cycles("cdr")) {
        break;
      }
      len++;
      node = node.cdr;
    }
    return len;
  }

  find(item: string | RegExp | ASymbol): boolean {
    return APair.match(this, item);
  }

  clone(deep = true): AListAlike {
    const visited = new Map<AListAlike, AListAlike>();

    function cloneNode<T extends SchemeValue>(node: T): T {
      if (node instanceof APair) {
        if (visited.has(node)) {
          return visited.get(node) as T;
        }
        // Register BEFORE descending (cycle resolves to this clone); knot door overwrites sub-spines.
        const pair = new APair(node.car, node.cdr);
        visited.set(node, pair);
        __tieKnot(pair, "car", (deep ? cloneNode(node.car) : node.car) as SchemeValue);
        __tieKnot(pair, "cdr", cloneNode(node.cdr) as SchemeValue);
        pair[CYCLES] = node[CYCLES];
        return pair as T;
      }
      return node;
    }

    return cloneNode(this) as AListAlike;
  }

  last_pair(): AListAlike | undefined {
    let node: AListAlike = this;
    while (node instanceof APair) {
      if (!(node.cdr instanceof APair)) {
        return node;
      }
      if (node.have_cycles("cdr")) {
        break;
      }
      node = node.cdr;
    }
  }

  to_array(deep = true): APairAsListValue<Car, Cdr>[] {
    // Circular list can't materialize to a finite array. isCircularList needed
    // because have_cycles() misses runtime knot cycles.
    invariant(!isCircularList(this), "cannot convert a circular list to an array");
    let result: unknown[] = [];
    if (this.car instanceof APair) {
      if (deep) {
        result.push(this.car.to_array());
      } else {
        result.push(this.car);
      }
    } else {
      const car = this.car;
      // deep=false preserves Scheme values. deep=true valueOf()s, EXCEPT ASymbol/AString/
      // AExact/AInexact which stay wrapped (downstream expects boxed).
      if (deep && car !== null && car !== undefined && typeof car === "object" && "valueOf" in car) {
        if (car instanceof ASymbol || car instanceof AString || car instanceof AExact || car instanceof AInexact) {
          result.push(car);
        } else {
          result.push((car as { valueOf(): unknown }).valueOf());
        }
      } else {
        result.push(car);
      }
    }
    if (this.cdr instanceof APair) {
      result = [...result, ...this.cdr.to_array(deep)];
    }
    return result as APairAsListValue<Car, Cdr>[];
  }

  mark_cycles(): this {
    mark_cycles(this);
    return this;
  }

  have_cycles(name: "car" | "cdr" | null = null): boolean {
    if (!name) {
      return this.have_cycles("car") || this.have_cycles("cdr");
    }
    return !!this[CYCLES]?.[name];
  }

  is_cycle(): boolean {
    return is_cycle(this);
  }

  // Print: toString → arrival/print (SOLE pair renderer). mark_cycles then cdr-walk;
  // cyclic repr is a known gap.
  toString(): string {
    return this["arrival/print"]();
  }

  /** The spine's children: car and cdr (the read-side twin of withProvenanceDeep — see AValue). */
  override ["arrival/provenanceChildren"](): Iterable<unknown> {
    return [this.car, this.cdr];
  }

  ["arrival/print"](): string {
    this.mark_cycles();
    const parts: string[] = [];

    if (this[REF]) {
      parts.push(`${this[REF]}(`);
    } else {
      parts.push("(");
    }

    let node: AListAlike = this;
    let first = true;

    while (node instanceof APair) {
      if (!first) {
        if (node[REF]) {
          parts.push(" . ", printValue(node));
          node = nil as unknown as AListAlike;
          continue;
        }
        parts.push(" ");
      }
      first = false;

      const carValue = node[CYCLES]?.car ?? printValue(node.car);
      if (carValue !== undefined) {
        parts.push(String(carValue));
      }

      if (node[CYCLES]?.cdr) {
        parts.push(" . ", String(node[CYCLES].cdr));
        break;
      }

      node = node.cdr as AListAlike;
    }

    if (!(node instanceof ANil) && !(node instanceof APair)) {
      parts.push(" . ", printValue(node));
    }

    parts.push(")");
    return parts.join("");
  }

  serialize(): [unknown, unknown] {
    return [this.car, this.cdr];
  }

  // R9 lazy egress — ONE method, keyed on `exit`. Spine snapshots once at proxy creation
  // (O(n) pointer copy); elements stay lazy. Improper tail folds in as last element.
  // Cyclic SPINE throws (no finite projection). Bare: per-box identity. Membrane: full
  // recursive crossing, proxy caches per (box, mode, SCOPE).
  // `readonly`: snapshot, never a mutate handle — also lets AJSArrayList return its
  // BORROWED source BY IDENTITY (round-trip law: toJS(adopt(arr)) === arr).
  ["arrival/toJS"](exit?: MembraneExit): readonly unknown[] {
    const spine: SchemeValue[] = [...this];
    return egressContainerProxy(
      this,
      "array",
      {
        keys: () => spine.map((_, i) => String(i)),
        read: (key) => spine[Number(key)],
      },
      exit ? { membrane: exit } : undefined,
    ) as unknown[];
  }

  // Setoid — structural car/cdr equality, threading shared `seen`. NO cycle bookkeeping
  // here: structuralEqual records (this, other) BEFORE dispatch, so cyclic lists short-
  // circuit in the harness. Non-Pair other → false.
  ["arrival/tagless-final/equals"](other: unknown, seen?: SeenMap): boolean {
    return (
      other instanceof APair && structuralEqual(this.car, other.car, seen) && structuralEqual(this.cdr, other.cdr, seen)
    );
  }

  // READ-side alist tolerance: `:key` finds an entry when spine is alist-shaped
  // (`((a . 1) …)`). FIRST match wins (assq/assoc shadowing). No match → nil; never throws.
  // LOAD-BEARING: nothing converted or promoted — pair stays a pair; only when asked via `:key`.
  ["arrival/tagless-final/get"](key: SchemeValue | string): SchemeValue {
    const wanted = foldAlistKeyName(key);
    let node: SchemeValue = this;
    while (node instanceof APair) {
      const entry = node.car;
      if (entry instanceof APair) {
        const entryName = alistEntryKeyName(entry.car);
        if (entryName !== undefined && entryName === wanted) return entry.cdr;
      }
      node = node.cdr;
    }
    return nil;
  }

  /**
   * Parser/macro metadata (LOCATION, CYCLES, REF) must survive — losing it breaks
   * stack traces and reader-cycle reconstruction. LOCATION is immutable, threaded
   * through the fresh cell's constructor.
   */
  withProvenance(p: ReadonlySet<number>): APair<Car, Cdr> {
    const copy = new APair<Car, Cdr>(this.car, this.cdr, p, this.location);

    if (this[CYCLES] !== undefined) copy[CYCLES] = this[CYCLES];
    if (this[REF] !== undefined) copy[REF] = this[REF];
    return copy;
  }

  /** RE-STAMP twin of withProvenance for location — fresh cell sharing car/cdr/provenance/
   *  CYCLES/REF. Callers: Parser list-head re-stamp, syntax-rules carrySpan. */
  override withLocation(loc: SourceLocation): APair<Car, Cdr> {
    const copy = new APair<Car, Cdr>(this.car, this.cdr, this.provenance, loc);

    if (this[CYCLES] !== undefined) copy[CYCLES] = this[CYCLES];
    if (this[REF] !== undefined) copy[REF] = this[REF];
    return copy;
  }

  /** Deep re-stamp (inbound membrane). Fresh cell; car/cdr through reStampChild.
   *  Does NOT copy LOCATION/CYCLES/REF — membrane-crossed cell is constructed, not reader-minted. */
  ["arrival/withProvenanceDeep"](
    ctx: RunContext,
    p: ReadonlySet<number>,
    seen: WeakSet<object> = new WeakSet(),
  ): APair<SchemeValue, SchemeValue> {
    seen.add(this);
    return new APair(
      reStampChild(this.car, ctx, p, seen),
      reStampChild(this.cdr, ctx, p, seen),
      // UNION, not replace — crossing ADDS its origin.
      mergeProvenance(this.provenance, p),
    );
  }

  // Term algebras: free monoid + Functor + Foldable + Traversable + Chain.
  // Recursors terminate on `instanceof Nil`, not `=== nil` — withProvenance mints
  // fresh Nil clones (mirrors value-guards.ts:is_nil).

  *[Symbol.iterator](): Generator<APairAsListValue<Car, Cdr>> {
    const seen = new WeakSet<SchemeValue>();
    let node: SchemeValue = this;
    while (node instanceof APair) {
      TypeError.invariant(
        !seen.has(node),
        "APair[Symbol.iterator]: list cycle detected — cannot iterate a cyclic list",
      );
      seen.add(node);
      if (isEmptyPairSentinel(node)) return;
      yield node.car;
      node = node.cdr;
    }
    // Improper tail folds in as last element: list→array is one-way, no round-trip promise.
    if (!(node instanceof ANil)) yield node as APairAsListValue<Car, Cdr>;
  }

  // Functor map — preserves every element's box. Concurrent fn; re-cons shallow.
  // LENGTH-PRESERVING — PROXY container stamp. Seam-routed (not bare fn(x)).
  // Callback is ACallable only — bare host fns are not scheme-applicable;
  // mint ANativeProcedure / hostFnToCallable. RegExp is a host-side filter sugar
  // evaluated without applyCallback.
  ["arrival/tagless-final/map"](fn: ACallable, runCtx: RunContext): MaybePromise<AListAlike> {
    const elements: SchemeValue[] = [];
    let node: unknown = this;
    while (node instanceof APair) {
      if (isEmptyPairSentinel(node)) break;
      elements.push(node.car);
      node = node.cdr;
    }
    const results = elements.map((x) => applyCallback(fn, [x], makeCallCtx(runCtx)));
    if (results.some(is_promise)) {
      return (promise_all(results) as Promise<unknown[]>).then((resolved) =>
        withInputProvenance([this], APair.fromArray(CONSTANT_CTX, resolved as SchemeValue[], false)),
      );
    }
    return withInputProvenance([this], APair.fromArray(CONSTANT_CTX, results as SchemeValue[], false));
  }

  // Filterable — preserves kept boxes. LENGTH-CHANGING — PROVENANCED fresh
  // (container stamp ∪ survivors). R7RS: only #f is false.
  ["arrival/tagless-final/filter"](arg: ACallable | RegExp, runCtx: RunContext): MaybePromise<AListAlike> {
    const elements: SchemeValue[] = [];
    let node: unknown = this;
    while (node instanceof APair) {
      if (isEmptyPairSentinel(node)) break;
      elements.push(node.car);
      node = node.cdr;
    }
    const kept = (verdict: unknown): boolean => !is_false(verdict);
    if (arg instanceof RegExp) {
      // Host-side sugar — not a scheme callable; never route through applyCallback.
      const re = arg;
      const survivors = elements.filter((x) => kept(String(x).match(re)));
      return withInputProvenance([this, ...survivors], APair.fromArray(CONSTANT_CTX, survivors, false));
    }
    const verdicts = elements.map((x) => applyCallback(arg, [x], makeCallCtx(runCtx)));
    if (verdicts.some(is_promise)) {
      return (promise_all(verdicts) as Promise<unknown[]>).then((results) => {
        const survivors = elements.filter((_, i) => kept(results[i]));
        return withInputProvenance([this, ...survivors], APair.fromArray(CONSTANT_CTX, survivors, false));
      });
    }
    const survivors = elements.filter((_, i) => kept(verdicts[i]));
    return withInputProvenance([this, ...survivors], APair.fromArray(CONSTANT_CTX, survivors, false));
  }

  // Async-aware reduce, SRFI fold `fn(element, acc)`, left fold.
  // `(reduce - 100 '(1 2 3 4 5))` = -97, NOT the FL acc-first 85.
  async ["arrival/tagless-final/reduce"]<Acc>(fn: ACallable, initial: Acc, runCtx: RunContext): Promise<Acc> {
    let acc = initial;
    let node: unknown = this;
    while (node instanceof APair) {
      const p = node;
      if (isEmptyPairSentinel(p)) break;
      acc = (await applyCallback(fn, [p.car, acc], makeCallCtx(runCtx))) as Acc;
      node = p.cdr;
    }
    return acc;
  }

  // Structure-preserving sort — LENGTH-PRESERVING, PROXIED stamp (must agree with AVector).
  // Comparator is ACallable when supplied — bare host less? mints via contourCallback in tests.
  ["arrival/tagless-final/sort"](comparator: ACallable | undefined, runCtx: RunContext): AListAlike {
    const out: SchemeValue[] = [];
    let node: unknown = this;
    while (node instanceof APair) {
      const p = node;
      if (isEmptyPairSentinel(p)) break;
      out.push(p.car);
      node = p.cdr;
    }
    // runCtx threaded for ctx-honesty. Host-schedule/RegionScope wiring is a separate concern.
    out.sort(deriveSortCompare(comparator, runCtx));
    return withInputProvenance([this], APair.fromArray(CONSTANT_CTX, out, false));
  }

  // SRFI-1 take — FRESH list, dotted-tail tolerant. LENGTH-CHANGING (PROVENANCED fresh).
  ["arrival/tagless-final/take"](n: number, _runCtx: RunContext): AListAlike {
    const out: SchemeValue[] = [];
    let node: unknown = this;
    let k = n;
    while (k > 0 && node instanceof APair) {
      if (isEmptyPairSentinel(node)) break;
      out.push(node.car);
      node = node.cdr;
      k--;
    }
    return withInputProvenance([this, ...out], APair.fromArray(CONSTANT_CTX, out, false));
  }

  // SRFI-1 drop — the n-th cdr ITSELF (shared structure, pure projection).
  ["arrival/tagless-final/drop"](n: number, _runCtx: RunContext): SchemeValue {
    let node: SchemeValue = this;
    let k = n;
    while (k > 0 && node instanceof APair) {
      if (isEmptyPairSentinel(node)) return node.cdr;
      node = node.cdr as SchemeValue;
      k--;
    }
    return node;
  }

  // SRFI-1 take-while — SEQUENTIAL (stop at first falsy). LENGTH-CHANGING.
  async ["arrival/tagless-final/take-while"](pred: ACallable, runCtx: RunContext): Promise<AListAlike> {
    const out: SchemeValue[] = [];
    let node: unknown = this;
    while (node instanceof APair) {
      if (isEmptyPairSentinel(node)) break;
      const verdict = await applyCallback(pred, [node.car], makeCallCtx(runCtx));
      if (is_false(verdict)) break; // R7RS: only #f is false
      out.push(node.car);
      node = node.cdr;
    }
    return withInputProvenance([this, ...out], APair.fromArray(CONSTANT_CTX, out, false));
  }

  // SRFI-1 drop-while — SHARED tail, sequential pred.
  async ["arrival/tagless-final/drop-while"](pred: ACallable, runCtx: RunContext): Promise<SchemeValue> {
    let node: SchemeValue = this;
    while (node instanceof APair) {
      if (isEmptyPairSentinel(node)) return node.cdr;
      const verdict = await applyCallback(pred, [node.car], makeCallCtx(runCtx));
      if (is_false(verdict)) return node; // R7RS: only #f is false
      node = node.cdr as SchemeValue;
    }
    return node;
  }

  // Element-count — container's OWN flat stamp, never elements' deep union.
  // Throws "length: circular list" on a cycle.
  ["arrival/tagless-final/length"](_runCtx?: unknown): AValue | number {
    if (isCircularList(this)) throw new TypeError("length: circular list");
    let count = 0;
    let node: SchemeValue = this;
    while (node instanceof APair) {
      if (isEmptyPairSentinel(node)) break;
      count++;
      node = node.cdr;
    }
    return withInputProvenance([this], count);
  }

  // car/cdr on the term. Result inherits ONLY the element's own provenance, never the container's.
  ["arrival/tagless-final/car"](): Car {
    return withInputProvenance([this.car], this.car);
  }

  ["arrival/tagless-final/cdr"](): Cdr {
    const cdr = this.cdr;
    // Projected sub-spine is a REBUILD boundary: only the OUTER head got stamped at
    // construction, so bare withInputProvenance finds nothing. Stamp with DEEP union of
    // what the sub-spine still reaches (conservation) — the "rebuild therefore drops" fix.
    if (cdr instanceof APair) {
      const deep = collapseProvenance(cdr);
      if (deep.size === 0) return cdr;
      const merged = cdr.provenance.size === 0 ? deep : new Set([...cdr.provenance, ...deep]);
      return cdr.withProvenance(merged) as Cdr;
    }
    return withInputProvenance([cdr], cdr);
  }

  ["arrival/tagless-final/pair?"](): boolean {
    return true;
  }

  ["arrival/tagless-final/traverse"](of: (x: unknown) => unknown, f: (x: unknown) => unknown): unknown {
    return traversePair(of as (x: unknown) => SchemeValue, f, this);
  }

  // Semigroup — pure list append (fresh spine, never mutates operands).
  ["arrival/tagless-final/concat"]<T extends AListAlike>(other: T): AConcatPair<APair<Car, Cdr>, T> {
    return concatPair<APair<Car, Cdr>, T>(this, other);
  }
}

function traversePair(
  // `of` lifts ANY SchemeValue into the applicative (called with nil seed and fresh APair).
  of: (x: SchemeValue) => SchemeValue,
  f: (x: unknown) => unknown,
  pair: unknown,
): unknown {
  // Iterative right fold: collect f(car) left-to-right, combine from the tail with of(nil).
  const heads: unknown[] = [];
  let node: unknown = pair;
  while (node instanceof APair) {
    heads.push(f(node.car));
    node = node.cdr;
  }
  let acc: SchemeValue = of(nil);
  for (let i = heads.length; i--; ) {
    const mappedCar = heads[i];
    const apFn = (mappedCar as AValue | null | undefined)?.[tf("ap")];
    acc = apFn ? (apFn.call(mappedCar, acc) as SchemeValue) : of(new APair(mappedCar as SchemeValue, acc));
  }
  return acc;
}

type AConcatPair<Car extends SchemeValue, Cdr extends AListAlike> =
  Car extends APair<infer Caar, infer Cadr>
    ? Cadr extends ANil
      ? APair<Caar, Cdr>
      : APair<Car, AConcatPair<Cadr, Cdr>>
    : APair<Car, Cdr>;

// Pure list append (Semigroup) — fresh spine of a's elements, then b. Iterative.
// Improper a still contributes its phantom car. Fresh head stamped with union of both
// operands' deep provenance (conservation; rebuild-drop fix, same as cdr).
export function concatPair<Car extends SchemeValue, Cdr extends AListAlike>(a: Car, b: Cdr): AConcatPair<Car, Cdr> {
  const cars: SchemeValue[] = [];
  let node: unknown = a;
  while (node instanceof APair) {
    cars.push(node.car);
    node = node.cdr;
  }
  let result: AListAlike = b ?? nil;
  for (let i = cars.length; i--; ) {
    result = new APair(cars[i], result);
  }
  if (result instanceof APair) {
    const deep = new Set([...collapseProvenance(a), ...collapseProvenance(b)]);
    if (deep.size > 0) result = result.withProvenance(deep);
  }
  return result as AConcatPair<Car, Cdr>;
}

/** Empty-pair sentinel: `car === undefined && cdr is nil`. A nil car is a legitimate element. */
function isEmptyPairSentinel(node: { readonly car: unknown; readonly cdr: unknown }): boolean {
  return node.car === undefined && node.cdr instanceof ANil;
}

// AJSArrayList — SPINE reading of a borrowed JS array. Zero-copy, O(1) per step.
//
// MANIFOLD LAW: a borrowed JS array is ONE POINT (backing source + provenance) with
// TWO CHARTS — AJSArray (INDEXED: vector?) and AJSArrayList (SPINE: pair?). Asking for
// the spine reading does NOT convert the value. Rules:
//   1. ONE identity (backing store + provenance), MANY charts.
//   2. CONSUMER'S CONTRACT selects the chart — never the membrane.
//   3. EVERY CHART IS TOTAL OVER ITS OWN ALGEBRA.
//   4. Transitions are O(1), lossless, provenance-preserving. A copy is not a transition.
//
// EXHAUSTION AT MINT: `null?` is `instanceof ANil`, hard-wired. THE SPINE CHART IS BORN
// NORMALIZED — `at()` never constructs a view at/past end; it returns `nil`. A view is
// ALWAYS a genuine non-empty pair (car/cdr total); an empty borrowed array adopts to nil.
//
// EXTENDS APair (nominal): pair-ness is IDENTITY, not capability. `is_pair` is
// `instanceof APair`; car/cdr TERMS are over-provided as tolerance (ANil answers both and
// is not a pair; AVector answers both and must report pair? #f). Prerequisite: APair's
// car/cdr are prototype getters over protected slots.

/** BORROWED-ARRAY container a spine view projects from. Structural (not AJSArray by name)
 *  to keep this module free of an import edge back to AJSArray.ts. */
export interface BorrowedArray {
  readonly provenance: ReadonlySet<number>;
  readonly source: readonly unknown[];
  /** THE declared membrane penetration for this container's elements — view ASKS, never reimplements. */
  elementAt(i: number): SchemeValue;
  /** Re-stamp the OWNER and re-project — stamp lives on the shared store. */
  withProvenance(p: ReadonlySet<number>): BorrowedArray;
}

export class AJSArrayList extends APair<SchemeValue, SchemeValue> {
  // Interop: extends APair extends AValue — nominal family rule covers it.

  private carBox?: SchemeValue;
  private cdrCell?: AJSArrayList | ANil;

  /**
   * View holds its OWNER, not a bare element array — that is the hygiene.
   * A bare array would be a second independent boxing policy (could project over
   * already-boxed AVector elements, silently destroying per-element lineage).
   * Holding the owner: exactly ONE backing store, ONE crossing (`owner.elementAt`), P7.
   */
  private constructor(
    readonly owner: BorrowedArray,
    readonly offset: number,
  ) {
    // nil,nil placeholders never read: accessors overridden; __tieKnot refuses views.
    super(nil, nil, owner.provenance);
  }

  /**
   * THE mint door — and the normalizer. Exhaustion decided HERE: offset at/past end is
   * `nil`, not an empty view. Terminal nil carries container's provenance (conservation).
   */
  static at(owner: BorrowedArray, offset: number): AJSArrayList | ANil {
    if (offset >= owner.source.length) {
      return owner.provenance.size > 0 ? (nil.withProvenance(owner.provenance) as ANil) : nil;
    }
    return new AJSArrayList(owner, offset);
  }

  // The two accessors that ARE the chart. Memoized; total by construction (at() guarantees live index).

  override get car(): SchemeValue {
    return (this.carBox ??= this.owner.elementAt(this.offset));
  }

  override get cdr(): AJSArrayList | ANil {
    return (this.cdrCell ??= AJSArrayList.at(this.owner, this.offset + 1));
  }

  // Everything NOT overridden is inherited from APair (reads this.car/this.cdr accessors).
  // map/filter/… re-cons genuine spines — views never propagate virally into results.

  override ["arrival/tagless-final/car"](runCtx?: RunContext): SchemeValue {
    return applyMembraneClosure(runCtx, () => {
      const car = this.car;
      return withInputProvenance([car], car);
    });
  }

  /**
   * MANDATORY override — inheriting APair's cdr term would be O(n²).
   * APair's version collapseProvenance-walks the tail (rebuild-drop repair). Here that is
   * ruinous (forces every remaining element on every cdr) and unnecessary (view's tail is
   * minted WITH the owner's provenance already on it).
   */
  override ["arrival/tagless-final/cdr"](runCtx?: RunContext): AJSArrayList | ANil {
    return applyMembraneClosure(runCtx, () => this.cdr);
  }

  /** O(1) — length - offset. View cannot cycle (offset strictly increases). */
  override ["arrival/tagless-final/length"](runCtx?: RunContext): AValue | number {
    return applyMembraneClosure(runCtx, () => withInputProvenance([this], this.owner.source.length - this.offset));
  }

  override ["arrival/tagless-final/get"](key: SchemeValue | string, runCtx?: RunContext): SchemeValue {
    return applyMembraneClosure(runCtx, () => super["arrival/tagless-final/get"](key));
  }

  override ["arrival/tagless-final/map"](fn: ACallable, runCtx: RunContext): MaybePromise<AListAlike> {
    return applyMembraneClosure(runCtx, () => super["arrival/tagless-final/map"](fn, runCtx));
  }

  override ["arrival/tagless-final/filter"](arg: ACallable | RegExp, runCtx: RunContext): MaybePromise<AListAlike> {
    return applyMembraneClosure(runCtx, () => super["arrival/tagless-final/filter"](arg, runCtx));
  }

  override ["arrival/tagless-final/reduce"]<Acc>(fn: ACallable, initial: Acc, runCtx: RunContext): Promise<Acc> {
    return applyMembraneClosure(runCtx, () => super["arrival/tagless-final/reduce"](fn, initial, runCtx));
  }

  override ["arrival/tagless-final/sort"](comparator: ACallable | undefined, runCtx: RunContext): AListAlike {
    return applyMembraneClosure(runCtx, () => super["arrival/tagless-final/sort"](comparator, runCtx));
  }

  override ["arrival/tagless-final/take"](n: number, runCtx: RunContext): AListAlike {
    return applyMembraneClosure(runCtx, () => super["arrival/tagless-final/take"](n, runCtx));
  }

  override ["arrival/tagless-final/drop"](n: number, runCtx: RunContext): SchemeValue {
    return applyMembraneClosure(runCtx, () => super["arrival/tagless-final/drop"](n, runCtx));
  }

  override ["arrival/tagless-final/take-while"](pred: ACallable, runCtx: RunContext): Promise<AListAlike> {
    return applyMembraneClosure(runCtx, () => super["arrival/tagless-final/take-while"](pred, runCtx));
  }

  override ["arrival/tagless-final/drop-while"](pred: ACallable, runCtx: RunContext): Promise<SchemeValue> {
    return applyMembraneClosure(runCtx, () => super["arrival/tagless-final/drop-while"](pred, runCtx));
  }

  /**
   * Crossing OUT. Bare arm special: offset 0 returns RAW BORROWED SOURCE by identity
   * (round-trip law: toJS(adopt(arr)) === arr). Past offset 0: honest slice.
   * Membrane arm (`exit` present): full recursive crossing via super — no borrowed identity
   * to preserve. Overriding only the bare arm without exit would shadow the whole protocol.
   */
  override ["arrival/toJS"](exit?: MembraneExit): readonly unknown[] {
    if (exit) return super["arrival/toJS"](exit);
    return this.offset === 0 ? this.owner.source : this.owner.source.slice(this.offset);
  }

  override valueOf(): readonly unknown[] {
    return this["arrival/toJS"]();
  }

  /** Remaining BORROWED elements, raw and uncrossed — forces no crossing. */
  override ["arrival/provenanceChildren"](): Iterable<unknown> {
    return this.offset === 0 ? this.owner.source : this.owner.source.slice(this.offset);
  }

  /** Re-stamp OWNER and re-project — never rebuild a spine. Constructs directly (not via at). */
  override withProvenance(p: ReadonlySet<number>): AJSArrayList {
    return new AJSArrayList(this.owner.withProvenance(p), this.offset);
  }
}
