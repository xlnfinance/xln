/**
 * AJSArray — AValue term that re-presents a borrowed JS array as a vector inside
 * Scheme value space. Carries provenance and its own tagless-final (vector) algebra;
 * object sibling AJSObject is a separate term. See class doc for implements-not-
 * extends-AVector cycle rationale.
 *
 * IMPORT CYCLE (benign): jsToScheme (rosetta.ts) is a hoisted export function whose
 * module statically imports this class — importing it here closes a runtime cycle,
 * safe because wrapper methods call it only at runtime (never TDZ).
 *
 * INTEROP BOUNDARY: member-access walk stops at this prototype (before source or the
 * delegated vector) via interop-access's nominal arrival-family rule (`instanceof
 * AValue`); no per-class stamp needed.
 */

import { applyMembraneClosure, CONSTANT_CTX, type RunContext } from "../run/RunContext.js";
import { attestDeep, freshIfSingleton, isAttested } from "../values/attestation.js";
import { AValue, EMPTY_PROVENANCE } from "../values/primitives/AValue.js";
import { withInputProvenance } from "../values/op-helpers.js";
import { AVector } from "../values/primitives/AVector.js";
import { printValue } from "../values/print.js";
import { type JSWorldArray, type SchemeValue } from "../values/types.js";
// Runtime import cycle (benign — see header): hoisted export function, runtime-only use.
import { jsToScheme } from "./rosetta.js";
import { is_promise } from "../values/value-guards.js";
import { settleEntry } from "../values/primitives/pending-entry.js";
import { tf } from "../values/tagless-final.js";
import { type ANil, nil } from "../values/primitives/ANil.js";
import { AJSArrayList } from "../values/primitives/APair.js";
import { accessHas, accessKeys, accessMember, NOT_FOUND } from "./interop-access.js";
import { ForeignProxyFreezeError, InteropAccessError, strictGate } from "../errors.js";
import { foldMemberName } from "./AJSObject.js";
import type { ACallable } from "../values/primitives/ACallable.js";

/**
 * Pending-cell cache for Promise-valued reads off the borrowed source
 * (pending-entry.ts): number keys are element indices (vector-ref), string keys are
 * member names (tagless get trio) — two read protocols with different boxing, so cells
 * stay keyed apart even when they alias the same slot. WeakMap, not instance field
 * (same reasons as AJSObject entryCaches). Only pending reads land here — sync paths
 * stay uncached.
 */
// AJSArray<any>: store type parameter POLICES THE INBOUND CALL and is not part of the
// value's identity, so a cache keyed on the value accepts every instantiation.

const pendingCells = new WeakMap<AJSArray<any>, Map<number | string, SchemeValue | Promise<SchemeValue>>>();

/**
 * A borrowed JS array, re-presented as a vector. It is an AValue (sibling of AJSObject)
 * that *implements* the vector algebra — it does NOT inherit AVector. Extending
 * AVector would force AVector defined at this module's eval time, closing a
 * module-init cycle (AJSArray → AVector → … → AJSArray → extends AVector(undefined)).
 * Implementing by DELEGATION touches AVector only at RUNTIME (`new AVector` inside
 * vec()), so the binding need not exist when this module loads.
 *
 * Borrowed source boxes through the membrane ON DEMAND (vec() materializes once,
 * cached): reading .length or crossing back out to JS never copies the whole array.
 * Vector algebra (map/filter/reduce/sort) forwards to that materialized vector.
 *
 * Rosetta translation: a JS array IS an R7RS vector, so kind is "vector". A faithful
 * vector has neither car nor cdr — (car it) throws like (car #(1 2 3)); use
 * (vector->list it). equals stays reference-identity, matching opaque-view sibling
 * AJSObject. source is kept as the borrowed reference so toJS crosses it back
 * out raw without materializing.
 */
export class AJSArray<S extends readonly unknown[] = readonly unknown[]> extends AValue {
  readonly kind = "vector" as const;

  // Borrowed source materialized into an owned vector — lazy + cached (delegation
  // target). Plain field, NOT #-private (importHelpers emits tslib helper for ES
  // #-private; AJSObject's entry cache is a module-level WeakMap for the same reason).
  private boxedVec?: AVector;

  /**
   * source is typed JSWorldArray<S> — THE HYGIENE LAW at the type level
   * (docs/membrane.md §HYGIENE). A caller statically holding scheme values
   * (SchemeValue[], AValue[]) collapses to never and FAILS TO COMPILE. Egress-proxy
   * carve-out needs no exception: a Proxy over a plain target is not an AValue, so it
   * passes on its own merits.
   */
  constructor(
    readonly source: JSWorldArray<S>,
    provenance: ReadonlySet<number> = EMPTY_PROVENANCE,
  ) {
    super(provenance);
  }

  // Cheap read stays lazy — .length never boxes the array.
  get length(): number {
    this.freezeSource();
    return this.source.length;
  }

  // Materialized element array — vector surface the printer (and asVector) read.
  get __vector__(): readonly SchemeValue[] {
    return this.vec().__vector__;
  }

  // Crosses back OUT as the RAW borrowed source (not the boxed materialization).
  ["arrival/toJS"](): readonly unknown[] {
    return this.source;
  }

  valueOf(): readonly unknown[] {
    return this.source;
  }

  // Returns the DEFAULT instantiation (AJSArray<readonly unknown[]>): the store type
  // parameter POLICES THE INBOUND CALL, not tracked through the value's whole life.
  // Re-stamping does not re-open the crossing — store was vetted at construction.
  withProvenance(p: ReadonlySet<number>): AJSArray {
    return new AJSArray(this.source as readonly unknown[], p);
  }

  // ── Vector algebra — DELEGATED to the materialized vector ──
  // Return types MIRROR AVector's concrete returns (honest + precise, never abstract
  // AValue). map is box-preserving ("one algebra, every carrier") — returns a FRESH
  // AVector, same as AVector's own map.
  ["arrival/tagless-final/map"](
    fn: Parameters<AVector["arrival/tagless-final/map"]>[0],
    runCtx: RunContext,
  ): AVector | Promise<AVector> {
    return applyMembraneClosure(runCtx, () => this.vec()[tf("map")](fn, runCtx));
  }

  ["arrival/tagless-final/filter"](
    pred: Parameters<AVector["arrival/tagless-final/filter"]>[0],
    runCtx: RunContext,
  ): Promise<AVector> {
    return applyMembraneClosure(runCtx, () => this.vec()[tf("filter")](pred, runCtx));
  }

  ["arrival/tagless-final/reduce"]<Acc extends SchemeValue>(
    fn: Parameters<AVector["arrival/tagless-final/reduce"]>[0],
    initial: Acc,
    runCtx: RunContext,
  ): Acc | Promise<Acc> {
    return applyMembraneClosure(runCtx, () => this.vec()[tf("reduce")](fn, initial, runCtx));
  }

  ["arrival/tagless-final/sort"](
    comparator: Parameters<AVector["arrival/tagless-final/sort"]>[0],
    runCtx: RunContext,
  ): AVector {
    return applyMembraneClosure(runCtx, () => this.vec()[tf("sort")](comparator, runCtx));
  }

  ["arrival/tagless-final/take"](n: number, runCtx: RunContext): AVector {
    return applyMembraneClosure(runCtx, () => this.vec()[tf("take")](n, runCtx));
  }

  ["arrival/tagless-final/drop"](n: number, runCtx: RunContext): AVector {
    return applyMembraneClosure(runCtx, () => this.vec()[tf("drop")](n, runCtx));
  }

  ["arrival/tagless-final/take-while"](pred: ACallable, runCtx: RunContext): Promise<AVector> {
    return applyMembraneClosure(runCtx, () => this.vec()[tf("take-while")](pred, runCtx));
  }

  ["arrival/tagless-final/drop-while"](pred: ACallable, runCtx: RunContext): Promise<AVector> {
    return applyMembraneClosure(runCtx, () => this.vec()[tf("drop-while")](pred, runCtx));
  }

  // SPINE READING of the borrowed array (AJSArrayList header: chart law). Asking a
  // vector for car/cdr IS asking for its spine — project one straight off source, O(1),
  // no materialization. Strict gate stays on the CONTAINER (borrowed array is a vector;
  // strict mode still refuses car/cdr on it); the projected view is a genuine pair and
  // is never gated. Rejected alternative: delegate into vec() — (car (some-tool …))
  // would box the ENTIRE array just to read element 0, and (cdr …) would hand back a
  // vector slice that no null? could terminate on.
  ["arrival/tagless-final/car"](runCtx?: RunContext): SchemeValue {
    return applyMembraneClosure(runCtx, () => {
      strictGate(runCtx, {
        op: "car",
        rule: "R7RS `car` requires a pair; a vector is not a pair",
        alternative: "use `(vector-ref v 0)` for the first element, or `(vector->list v)`",
      });
      this.freezeSource();
      return this.source.length > 0 ? this.elementAt(0) : nil;
    });
  }

  ["arrival/tagless-final/cdr"](runCtx?: RunContext): AJSArrayList | ANil {
    return applyMembraneClosure(runCtx, () => {
      strictGate(runCtx, {
        op: "cdr",
        rule: "R7RS `cdr` requires a pair; a vector is not a pair",
        alternative: "use vector slicing or `(vector->list v)`",
      });
      this.freezeSource();
      return AJSArrayList.at(this, 1);
    });
  }

  /** Borrowed source's elements — raw, unboxed. Collapse walk only collects provenance
   *  off values that already ARE AValues; no materialization cost. */
  override ["arrival/provenanceChildren"](): Iterable<unknown> {
    return this.source;
  }

  // Print protocol — same #(...) vector repr as AVector; __vector__ materializes once.
  ["arrival/print"](): string {
    return `#(${this.__vector__.map((el) => printValue(el)).join(" ")})`;
  }

  // Setoid — reference identity (SAME borrowed source), matching AJSObject. Deep-
  // comparing source is the deep semantics the membrane exists to avoid.
  ["arrival/tagless-final/equals"](other: unknown): boolean {
    return other instanceof AJSArray && other.source === this.source;
  }

  // Length stamps the container grouping-fact, never the elements' union (R2).
  ["arrival/tagless-final/length"](runCtx?: RunContext): AValue | number {
    return applyMembraneClosure(runCtx, () => {
      this.freezeSource();
      return withInputProvenance([this], this.source.length);
    });
  }

  ["arrival/tagless-final/vector?"](): boolean {
    return true;
  }

  // Member trio (@/@?/@keys + :key) — borrowed-array arm of the protocol AJSObject/
  // ADict carry. Reads through interop policy over the RAW source (own members only).
  // NOT_FOUND/blocked → nil; array-valued member re-presents as borrowed AJSArray
  // (so car/cdr work on it); other members box via jsToScheme with EMPTY provenance
  // (historical face choice — element reads via vector-ref carry this container's
  // provenance instead; asymmetry pinned by identity/lineage suites).
  ["arrival/tagless-final/get"](key: SchemeValue | string, runCtx?: RunContext): SchemeValue | Promise<SchemeValue> {
    return applyMembraneClosure(runCtx, () => {
      this.freezeSource();
      const name = foldMemberName(key);
      let raw: unknown;
      try {
        raw = accessMember(this.source, name);
      } catch (error) {
        if (error instanceof InteropAccessError) return nil;
        throw error;
      }
      if (raw === NOT_FOUND) return nil;
      if (Array.isArray(raw)) return new AJSArray(raw as readonly unknown[]);
      // Promise-valued member is a lazy pending cell — settled box carries EMPTY
      // provenance, same as the sync read below.
      if (is_promise(raw))
        return this.pendingCell(name, raw, (settled) => jsToScheme(CONSTANT_CTX, settled, {}, EMPTY_PROVENANCE));
      const boxed: SchemeValue = jsToScheme(CONSTANT_CTX, raw, {}, EMPTY_PROVENANCE);
      return boxed;
    });
  }

  ["arrival/tagless-final/has"](key: SchemeValue | string, runCtx?: RunContext): boolean {
    return applyMembraneClosure(runCtx, () => {
      this.freezeSource();
      return accessHas(this.source, foldMemberName(key));
    });
  }

  ["arrival/tagless-final/keys"](runCtx?: RunContext): string[] {
    return applyMembraneClosure(runCtx, () => {
      this.freezeSource();
      return accessKeys(this.source);
    });
  }

  // Indexed access — boxes JUST element k (no full materialize). jsToScheme carries
  // THIS container's provenance so (vector-ref borrowed k) stamps identically to
  // (vector->list borrowed). A CONSTANT_CTX mint would drop provenance.
  ["arrival/tagless-final/vector-ref"](k: number, runCtx?: RunContext): SchemeValue | Promise<SchemeValue> {
    return applyMembraneClosure(runCtx, () => {
      this.freezeSource();
      const raw = this.source[k];
      // Promise-valued element is a lazy pending cell; settled box takes the SAME boxing
      // as the sync path (container provenance + attestation inheritance).
      if (is_promise(raw)) return this.pendingCell(k, raw, (settled) => this.boxElement(settled));
      return this.boxElement(raw);
    });
  }

  /**
   * THE declared membrane penetration for this container's elements
   * (docs/membrane.md §HYGIENE): the ONE place an element of a borrowed array crosses
   * into Scheme, and the only element-crossing any consumer may use. AJSArrayList
   * (spine chart over this same store) calls THIS rather than owning a second boxing
   * policy — one store, one crossing, owned by the class that owns the store (P7).
   *
   * Boxing discipline (shared by sync path and pending cell's settlement): jsToScheme
   * carrying THIS container's provenance, attestation inheritance (stamp site 2),
   * freshIfSingleton so a raw boolean surfaces as an attested clone, never the shared
   * flyweight.
   */
  elementAt(i: number): SchemeValue {
    this.freezeSource();
    return this.boxElement(this.source[i]);
  }

  private boxElement(raw: unknown): SchemeValue {
    // HYGIENE LAW at the O(1) penetration point (docs/membrane.md §HYGIENE) — not an
    // O(n) constructor scan the lazy borrow exists to avoid. An AValue here is an
    // unobserved flip that jsToScheme would deep-re-stamp with this container's
    // provenance, destroying its lineage; fail loudly instead.
    Error.invariant(
      !(raw instanceof AValue),
      "AJSArray: `source` must hold JS-world values only — an AValue here means a scheme value was " +
        "pushed into a borrowed JS store without crossing the membrane (an unobserved flip). Cross it " +
        "with `toJS` first, or hold it in an AVector.",
    );
    const boxed: SchemeValue = jsToScheme(CONSTANT_CTX, raw, {}, this.provenance);
    return isAttested(this) ? attestDeep(freshIfSingleton(boxed)) : boxed;
  }

  /** Mint-or-reuse the pending cell for a Promise-valued read: chain cached so
   *  concurrent readers share ONE settlement; settled box overwrites — sync-after. */
  private pendingCell(
    key: number | string,
    raw: unknown,
    box: (settled: unknown) => SchemeValue,
  ): SchemeValue | Promise<SchemeValue> {
    let cells = pendingCells.get(this);
    if (cells === undefined) {
      cells = new Map();
      pendingCells.set(this, cells);
    }
    const hit = cells.get(key);
    if (hit !== undefined) return hit;
    const slot = cells;
    const cell = settleEntry(raw, box, (boxed) => slot.set(key, boxed));
    slot.set(key, cell);
    return cell;
  }

  // Freeze contract — docs/membrane.md §BOXING. Idempotent (Object.isFrozen).
  // Always freezes on first read.
  private freezeSource(): void {
    if (!Object.isFrozen(this.source)) {
      try {
        Object.freeze(this.source);
      } catch (error) {
        throw new ForeignProxyFreezeError(error);
      }
    }
  }

  // Box the borrowed source into an owned AVector through the membrane, once. Vector
  // algebra DELEGATES here. new AVector runs only at call time (cycle-avoidance of
  // implements-not-extends).
  private vec(): AVector {
    this.freezeSource();
    // Each element through jsToScheme carrying THIS container's provenance — parallel
    // to AJSObject.get. Nested arrays/objects re-borrow faithfully.
    if (this.boxedVec === undefined) {
      // Attestation inheritance (stamp site 2): elements attested iff container is.
      // freshIfSingleton per element: raw boolean → shared flyweight; clone attests.
      const inherit = isAttested(this);
      this.boxedVec = new AVector(
        this.source.map((v) => {
          const boxed: SchemeValue = jsToScheme(CONSTANT_CTX, v, {}, this.provenance);
          return inherit ? attestDeep(freshIfSingleton(boxed)) : boxed;
        }),
        this.provenance,
      );
      if (inherit) attestDeep(this.boxedVec);
    }
    return this.boxedVec;
  }
}
