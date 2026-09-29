/**
 * AJSObject — thin, read-only view of a borrowed JS object inside Scheme value space.
 * Own term with own tagless-final algebra; array sibling AJSArray carries a separate
 * vector algebra.
 *
 * IMPORT CYCLE (benign): jsToScheme (rosetta.ts) statically imports this class — safe
 * because get() calls it only at runtime, and a hoisted export function is never in TDZ.
 * interop-access.ts is a true leaf, imported directly.
 *
 * INTEROP BOUNDARY: this wrapper IS the JS↔Scheme membrane for objects. get/set/has/
 * delete/keys route through accessMember for the WRAPPED value; the wrapper's own
 * prototype is reachable via symbol-to-field auto-resolution, so the nominal
 * arrival-family rule in interop-access (`instanceof AValue`) stops the walk here —
 * sandbox code can't read get/toString to reach source.
 */

import { applyMembraneClosure, CONSTANT_CTX, type RunContext } from "../run/RunContext.js";
import { AValue, EMPTY_PROVENANCE } from "../values/primitives/AValue.js";
import { nil } from "../values/primitives/ANil.js";
import { accessHas, accessKeys, accessMember, NOT_FOUND } from "./interop-access.js";
import { ForeignProxyFreezeError, InteropAccessError } from "../errors.js";
import { attestDeep, freshIfSingleton, isAttested } from "../values/attestation.js";
import { type SchemeValue } from "../values/types.js";
// Runtime import cycle (benign — see header): jsToScheme is a hoisted export function,
// called only inside get() at runtime.
import { jsToScheme } from "./rosetta.js";
import { is_promise } from "../values/value-guards.js";
import { settleEntry } from "../values/primitives/pending-entry.js";

/**
 * Entry cache keyed by wrapper identity. WeakMap, not an instance field: keeps the
 * cache off the wrapper's own properties (sandbox symbol-to-field can't reach it) and
 * avoids the tslib helper this workspace's importHelpers:true needs for TS #-private.
 * GC-correct — cache entry disappears with the wrapper.
 */
const entryCaches = new WeakMap<AJSObject, Map<string, SchemeValue | Promise<SchemeValue>>>();

/** Borrowed-wrapper member-name fold: face-normalized string passes through; a
 *  SchemeValue key (keyword symbol, boxed string) unwraps via valueOf with the `:`
 *  accessor sigil stripped. Shared by AJSObject and AJSArray member terms. */
export function foldMemberName(key: SchemeValue | string): string {
  let name =
    typeof key === "string" ? key : String((key as { valueOf?: () => unknown } | null | undefined)?.valueOf?.() ?? key);
  if (name.startsWith(":")) name = name.slice(1);
  return name;
}

/**
 * Thin wrapper for JS objects. Property access is lazy — entries box on demand through
 * jsToScheme, stamped with the wrapper's own provenance, so e.g. an entry read off an
 * (infer …) result carries infer's id at the access point, not just at the container.
 * Identity is stable via the module-level cache: .get("x") twice returns the same
 * AValue, so (eq? (@ obj :x) (@ obj :x)) holds.
 *
 * All property access is sandboxed — see interop-access.ts.
 */
export class AJSObject extends AValue {
  readonly kind = "object" as const;

  constructor(
    readonly source: object,
    provenance: ReadonlySet<number> = EMPTY_PROVENANCE,
  ) {
    super(provenance);
  }

  ["arrival/toJS"](): Record<string, unknown> {
    return this.source as Record<string, unknown>;
  }

  withProvenance(p: ReadonlySet<number>): AJSObject {
    // New wrapper = new identity = empty cache. Provenance-variant entries would
    // otherwise leak between wrappers.
    return new AJSObject(this.source, p);
  }

  /**
   * Read a property as a security-validated, provenanced, cached AValue. Single
   * dispatch for dict-ref / @ / :key — boundary checks + provenance + identity
   * stability (repeated .get on the same key returns the cached AValue).
   *
   * Missing key → nil (dict-ref semantics); accessMember's NOT_FOUND collapses to nil.
   *
   * A Promise-valued property is a LAZY PENDING CELL (pending-entry.ts): first read
   * mints one settle chain (cached, concurrent readers share it); settlement replaces
   * the cache slot with the settled box. A raw Promise never leaks into scheme space.
   *
   * Cycle protection is in jsToScheme's WeakSet.
   */
  get(key: string | symbol): SchemeValue | Promise<SchemeValue> {
    this.freezeSource();
    if (this.isHostErrorStackKey(key)) return nil;
    // Symbol keys skip the cache (sandbox already blocks most symbol access).
    const cacheKey = typeof key === "string" ? key : undefined;
    if (cacheKey !== undefined) {
      const cached = entryCaches.get(this)?.get(cacheKey);
      if (cached !== undefined) return cached;
    }
    const writeCache = (entry: SchemeValue | Promise<SchemeValue>): void => {
      if (cacheKey === undefined) return;
      let cache = entryCaches.get(this);
      if (cache === undefined) {
        cache = new Map();
        entryCaches.set(this, cache);
      }
      cache.set(cacheKey, entry);
    };

    let raw: unknown;
    try {
      raw = accessMember(this.source, key);
    } catch (error) {
      // Boundary violations → nil — same shape as "absent" (no error detail leaks).
      if (error instanceof InteropAccessError) return nil;
      throw error;
    }
    if (raw === NOT_FOUND) return nil;

    // Function-valued property boxes through jsToScheme to a genuine reverse-membrane
    // callable (docs/membrane.md §CALLABLE-LENS). Getter reads already resolved above.

    // Box through jsToScheme so primitives become AValue subtypes stamped with this
    // wrapper's provenance; attestation inherits from container (attestation.ts stamp
    // site 2). freshIfSingleton first: raw boolean boxes to shared #t/#f flyweight on
    // empty-provenance path, and singletons never attest — the clone does.
    const boxEntry = (settled: unknown): SchemeValue => {
      const b: SchemeValue = jsToScheme(CONSTANT_CTX, settled, {}, this.provenance);
      return isAttested(this) ? attestDeep(freshIfSingleton(b)) : b;
    };

    // Pending cell: cache the settle chain itself, then overwrite with the settled box.
    if (is_promise(raw)) {
      const cell = settleEntry(raw, boxEntry, writeCache);
      writeCache(cell);
      return cell;
    }

    const boxed = boxEntry(raw);
    if (boxed instanceof AValue) writeCache(boxed);
    return boxed;
  }

  /** Always throws — writes are banned (pure-dataflow sandbox, read-only membrane). */
  set(key: string | symbol, _value: SchemeValue): void {
    // Throwing rather than silent no-op: the program would otherwise believe it wrote.
    throw new InteropAccessError(
      "Cannot assign to a foreign object — writes are banned in the pure-dataflow sandbox",
      typeof key === "symbol" ? key : String(key),
      "write-banned",
    );
  }

  has(key: string | symbol): boolean {
    this.freezeSource();
    if (this.isHostErrorStackKey(key)) return false;
    return accessHas(this.source, key);
  }

  /** Always throws — deletion is a mutation, banned for the same reason as set. */
  delete(key: string | symbol): boolean {
    throw new InteropAccessError(
      "Cannot delete from a foreign object — mutations are banned in the pure-dataflow sandbox",
      typeof key === "symbol" ? key : String(key),
      "write-banned",
    );
  }

  /** Own enumerable property keys (never inherited). */
  keys(): string[] {
    this.freezeSource();
    const ks = accessKeys(this.source);
    return this.source instanceof Error ? ks.filter((k) => k !== "stack") : ks;
  }

  /**
   * Host Error crosses borrowed: its `stack` is a host-internals confession (paths,
   * call sites) the sandbox has no use for — read collapses to absent (nil / not-has /
   * unlisted), same shape as a boundary violation. message / name / cause stay
   * readable; cause's chained Errors re-apply this rule on their own reads.
   */
  private isHostErrorStackKey(key: string | symbol): boolean {
    return key === "stack" && this.source instanceof Error;
  }

  // Setoid: two wrappers equal? iff same source (reference identity) — deep-comparing
  // would defeat the membrane's opacity (foreign getters/cycles).
  ["arrival/tagless-final/equals"](other: unknown): boolean {
    return other instanceof AJSObject && this.source === other.source;
  }

  // @ / dict-ref / :key are one protocol over the same .get. :-strip is the receiver's
  // own fold. Promise-valued entry surfaces as its pending cell.
  ["arrival/tagless-final/get"](key: SchemeValue | string, runCtx?: RunContext): SchemeValue | Promise<SchemeValue> {
    return applyMembraneClosure(runCtx, () => this.get(foldMemberName(key)));
  }

  ["arrival/tagless-final/has"](key: SchemeValue | string, runCtx?: RunContext): boolean {
    return applyMembraneClosure(runCtx, () => this.has(foldMemberName(key)));
  }

  ["arrival/tagless-final/keys"](runCtx?: RunContext): string[] {
    return applyMembraneClosure(runCtx, () => this.keys());
  }

  toString(): string {
    return "#<js-object>";
  }

  // Fixed "#<js-object>" literal, mirroring type()'s instanceof AJSObject arm.
  ["arrival/print"](): string {
    return this.toString();
  }

  valueOf(): object {
    return this.source;
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
}
