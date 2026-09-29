/**
 * Per-form evaluation trace — arrival-scheme `EvalTap` (P12 capture spine).
 *
 * `Map<Pair, NodeRecord>` keyed by parser Pair identity. Per Pair:
 *   - `bindings` — every Invocation entered (kept after resolve; UI reads state)
 *   - `entered` / `exited` — lifetime counts
 * `Invocation.parent` walks the dynamic call stack to the program-root form.
 *
 * Untracked: atoms, bare symbols, quoted data, macro-Pairs (no `__location__`) —
 * evaluator tap rules already filter them.
 *
 * Provenance taxonomy (docs/PROVENANCE.md) — READ before changing
 * `computeProvenance`, authoritative-set forwarding, or `accessorField`:
 * mint only at boundaries; pure ops union/forward; branch is edge-role not node;
 * `(:field …)` FORWARDS the producer point (dropped key lives in static carrier).
 *
 * PLAIN FIELDS (P12). Deep TCO mints one Invocation per step; MobX admin on each
 * (~10× memory) plus O(n²) retained provenance Sets GC-freezes the tab. Chart
 * reads `snapshotTrace` over plain objects. Reactive signal is one SEAM pair:
 * `_entries` / `bumpEntries()` — `ObservableEvalTrace` (arrival-provenance)
 * overrides them with `observable.box` and wraps `enter` in `action`. Core
 * stays mobx-free.
 */
import invariant from "tiny-invariant";
import { TraceBudgetError } from "../errors.js";

import { AValue, EMPTY_PROVENANCE } from "../values/primitives/AValue.js";
import { AString } from "../values/primitives/AString.js";
import { AutoBindings } from "./lineage-auto-bindings.js";
import type { EvalTap } from "../eval/evaluator.js";
import { APair } from "../values/primitives/APair.js";
import type { ASymbol } from "../values/primitives/ASymbol.js";
import type { AListAlike, SchemeValue } from "../values/types.js";

export type InvocationState = "running" | "resolved" | "rejected";

function headNameOf(node: APair<SchemeValue, SchemeValue>): string | null {
  const head = (node as { car: unknown }).car;
  if (head === null || typeof head !== "object" || !("__name__" in head)) return null;
  const name = (head as { __name__: unknown }).__name__;
  return typeof name === "string" ? name : null;
}

/** Bare field name of `(:field x)` → `"verdict"`, else null. Head `":"` (no field) is not one. */
function accessorField(node: APair<SchemeValue, SchemeValue>): string | null {
  const head = (node as { car: unknown }).car;
  if (head === null || typeof head !== "object" || !("__name__" in head)) return null;
  const name = (head as { __name__: unknown }).__name__;
  return typeof name === "string" && name.length > 1 && name.startsWith(":") ? name.slice(1) : null;
}

/**
 * Provenance at exit:
 *   - provenance point → `{ self.id }` (authoritative)
 *   - authoritative set on a non-field form → forward by reference (no re-union —
 *     re-union collapses O(1)-per-hop links into O(history) flat sets)
 *   - else distinct non-empty child/symbol sets by reference: 0 empty, 1 forward, many union
 *   - `(:field …)` forwards producer points, marks authoritative (key lives in static carrier)
 * Control-flow restriction is rosetta wrappers, not here.
 */
function computeProvenance(inv: Invocation, trace: EvalTrace): ReadonlySet<number> {
  if (inv.isProvenancePoint) return trace.markAuthoritativeProvenance(new Set<number>([inv.id]));

  const field = accessorField(inv.node);

  if (field === null && inv.value instanceof AValue && trace.isAuthoritativeProvenance(inv.value.provenance)) {
    return inv.value.provenance;
  }

  const distinct = new Set<ReadonlySet<number>>();
  for (const child of inv.children) {
    if (child.provenance.size > 0) distinct.add(child.provenance);
  }
  if (inv.symbolContributions) {
    for (const s of inv.symbolContributions) {
      if (s.size > 0) distinct.add(s);
    }
  }
  if (distinct.size === 0) return EMPTY_PROVENANCE;

  if (field !== null) {
    const out = new Set<number>();
    for (const s of distinct) for (const p of s) out.add(p);
    return trace.markAuthoritativeProvenance(out);
  }

  if (distinct.size === 1) return distinct.values().next().value!;
  const merged = new Set<number>();
  for (const s of distinct) for (const x of s) merged.add(x);
  return merged;
}

export class Invocation {
  readonly id: number;
  readonly node: APair<SchemeValue, SchemeValue>;
  readonly parent: Invocation | null;
  /** Children entered under this evaluation — O(children) provenance without scanning records. */
  readonly children: Invocation[] = [];
  state: InvocationState = "running";
  // SchemeValue, not unknown — every assignment is one (docs/PRINCIPLES.md P3).
  value: SchemeValue | undefined = undefined;
  error: unknown = undefined;
  /** Provenance-point ids whose outputs flowed into this call. Computed on exit. */
  provenance: ReadonlySet<number> = EMPTY_PROVENANCE;
  /** Rosetta / sandbox marks a mint boundary. Read by exit-tap. */
  isProvenancePoint = false;
  /** Rosetta `resultWithProvenance` meta; never crosses into scheme. */
  metadata: unknown = undefined;
  /** `(infer …)` cache hit vs fresh — set at bind via `markInferCached`. */
  cached: boolean | undefined = undefined;
  /** R7RS §3.5 tail flag from evaluator (not inferred). Labels proper-TCO vs stack growth. */
  tailPosition = false;
  /** Symbol-resolution provenance; lazy (most invocations: none). */
  symbolContributions: Set<ReadonlySet<number>> | null = null;

  constructor(id: number, node: APair<SchemeValue, SchemeValue>, parent: Invocation | null) {
    this.id = id;
    this.node = node;
    this.parent = parent;
    if (parent) parent.children.push(this);
  }

  /** Named seam for rosetta duck-type write of {@link isProvenancePoint}. */
  markProvenancePoint(): void {
    this.isProvenancePoint = true;
  }

  setMetadata(meta: unknown): void {
    this.metadata = meta;
  }

  ancestors(): Invocation[] {
    const out: Invocation[] = [];
    let cur: Invocation | null = this;
    while (cur) {
      out.push(cur);
      cur = cur.parent;
      invariant(cur !== this, "ancestors should not walk off the root");
    }
    return out;
  }
}

export class NodeRecord {
  readonly bindings = new Set<Invocation>();
  entered = 0;
  exited = 0;
}

/** Default enter cap — stops runaway loops before OOM. Pass `Infinity` for unbounded. */
export const DEFAULT_TRACE_CAP = 500_000;

/** Flat per-point overhead for {@link EvalTrace.stats} (approximation, not measurement). */
const STATS_PER_ENTRY_OVERHEAD_BYTES = 128;

export class EvalTrace implements EvalTap {
  readonly records = new Map<APair<SchemeValue, SchemeValue>, NodeRecord>();
  /** Task → creating invocations. One task, many invs across HOF iterations; first is canonical. */
  readonly invocationByTask = new Map<object, Invocation[]>();
  /** Symbol-resolution log — symbol eval skips enter/exit. */
  readonly symbolValues = new WeakMap<Invocation, Map<string, unknown>>();

  /**
   * Optional auto-binding leaf-stamp sidecar. Default undefined: `exit` never
   * touches it. When attached, records per-invocation producer ids from
   * `symbolValues` without collapsing distinct source invocations. Alongside
   * `AValue.provenance`, never replacing it.
   */
  autoBindings: AutoBindings | undefined = undefined;

  withAutoBindings(sink: AutoBindings = new AutoBindings()): AutoBindings {
    this.autoBindings = sink;
    return sink;
  }

  #nextId = 0;

  /**
   * Monotonic enter-count (incl. re-entry of a seen Pair). Renderer "trace grew"
   * signal without scanning invocations. SEAM: `ObservableEvalTrace` overrides.
   */
  protected _entries = 0;
  get entries(): number {
    return this._entries;
  }

  /** SEAM: plain increment — subclass may make observable. */
  protected bumpEntries(): void {
    this._entries++;
  }

  /**
   * Enter-order invocation log (gap-free ids relative to `#logBaseId`). Region fold
   * O(Δ)-slices by cursor. `clear()` truncates; position cursors must reset.
   */
  readonly #invocationLog: Invocation[] = [];
  get invocationLog(): readonly Invocation[] {
    return this.#invocationLog;
  }

  /**
   * Authoritative provenance sets — complete lineage from a mint point or
   * `(:field …)` forward. Upstream is FOLLOWED by link, never closed transitively.
   * Forwarded across fn-return / let / tail without re-union (re-union → O(history)
   * flat sets). WeakSet by Set identity; GC'd with the set.
   */
  readonly #authoritativeProvenance = new WeakSet<ReadonlySet<number>>();

  markAuthoritativeProvenance<T extends ReadonlySet<number>>(set: T): T {
    if (set.size > 0) this.#authoritativeProvenance.add(set);
    return set;
  }

  isAuthoritativeProvenance(set: ReadonlySet<number>): boolean {
    return this.#authoritativeProvenance.has(set);
  }

  bindTask(task: object, invocation: Invocation): void {
    let list = this.invocationByTask.get(task);
    if (!list) {
      list = [];
      this.invocationByTask.set(task, list);
    }
    if (!list.includes(invocation)) list.push(invocation);
  }

  markInferCached = (invocation: Invocation, cached: boolean): void => {
    invocation.cached = cached;
  };

  invocationFor(task: object): Invocation | undefined {
    return this.invocationByTask.get(task)?.[0];
  }

  invocationsFor(task: object): readonly Invocation[] {
    return this.invocationByTask.get(task) ?? [];
  }

  /** Minting invocation for a provenance id (id − `#logBaseId` indexes the log). */
  invocationById(provenanceId: number): Invocation | undefined {
    const idx = provenanceId - this.#logBaseId;
    return idx >= 0 ? this.#invocationLog[idx] : undefined;
  }

  /** Provenance points — pull tool names / values BEFORE {@link clear}. Lazy over enter order. */
  *points(): IterableIterator<{ id: number; toolName: string | undefined; invocation: Invocation }> {
    for (const inv of this.#invocationLog) {
      if (inv.isProvenancePoint) yield { id: inv.id, toolName: this.toolNameFor(inv.id), invocation: inv };
    }
  }

  /** Head symbol that minted this id; resolve against the same tap that ran the eval. */
  toolNameFor(provenanceId: number): string | undefined {
    const inv = this.invocationById(provenanceId);
    return inv === undefined ? undefined : (headNameOf(inv.node) ?? undefined);
  }

  symbolValueIn(inv: Invocation, name: string): unknown {
    return this.symbolValues.get(inv)?.get(name);
  }

  /** Id of `#invocationLog[0]`; advanced to `#nextId` by {@link clear} so index math stays valid. */
  #logBaseId: number;

  /** Cap counter since construction/last clear — NOT `#nextId` (never resets). Coupling the
   *  cap to raw id would make clear() useless and trip nonzero `startId` on inv one. */
  #mintedSinceReset = 0;

  /** Open enter−exit frames; {@link clear} requires zero. */
  #openCount = 0;

  /**
   * Cap on mints since last clear (default {@link DEFAULT_TRACE_CAP}). `enter` throws
   * `TraceBudgetError` at cap — partial trace, not OOM. Pass `Infinity` unbounded.
   *
   * `startId` floors the id counter (process-restart seam: keep ids globally monotonic).
   * Ids below `startId` always resolve unminted.
   */
  constructor(
    readonly maxEntries: number = DEFAULT_TRACE_CAP,
    startId = 0,
  ) {
    invariant(Number.isInteger(startId) && startId >= 0, "EvalTrace startId must be a non-negative integer");
    this.#nextId = startId;
    this.#logBaseId = startId;
  }

  enter = (node: AListAlike, parent: unknown, tailPosition?: boolean): Invocation => {
    if (this.#mintedSinceReset >= this.maxEntries) {
      throw new TraceBudgetError(this.maxEntries);
    }
    // Tap only fires on located Pairs; AListAlike admits ANil — assert, don't widen type.
    invariant(node instanceof APair, "EvalTap.enter node must be a Pair");
    const inv = new Invocation(this.#nextId++, node, parent as Invocation | null);
    this.#mintedSinceReset++;
    this.#openCount++;
    if (tailPosition) inv.tailPosition = true;
    let rec = this.records.get(node);
    if (!rec) {
      rec = new NodeRecord();
      this.records.set(node, rec);
    }
    rec.bindings.add(inv);
    this.#invocationLog.push(inv);
    rec.entered += 1;
    this.bumpEntries();
    return inv;
  };

  exit = (inv: Invocation, result: Parameters<EvalTap["exit"]>[1]): ReturnType<EvalTap["exit"]> => {
    this.#openCount--;
    if (!("value" in result)) {
      inv.state = "rejected";
      inv.error = result.error;
      inv.provenance = computeProvenance(inv, this);
      this.#pruneChildProvenance(inv);
      const rec = this.records.get(inv.node);
      if (rec) rec.exited += 1;
      return;
    }

    inv.state = "resolved";
    inv.value = result.value;
    inv.provenance = computeProvenance(inv, this);
    this.#pruneChildProvenance(inv);

    if (this.autoBindings) this.autoBindings.recordInvocation(inv.id, this.symbolValues.get(inv));

    // Stamp onto AValue so provenance rides env bindings. LOAD-BEARING return:
    // `withProvenance` clones (identity); without returning the clone the evaluator
    // binds the unstamped original. Trampoline: Call.onResolve.
    if (inv.provenance.size > 0 && inv.value instanceof AValue) {
      const stamped = inv.value.withProvenance(inv.provenance);
      inv.value = stamped;
      const rec = this.records.get(inv.node);
      if (rec) rec.exited += 1;
      return { value: stamped };
    }

    const rec = this.records.get(inv.node);
    if (rec) rec.exited += 1;
  };

  /**
   * Drop child provenance Sets once parent has folded them (one level at exit).
   * Without this, deep TCO retains O(depth) Sets per inv → O(n²) GC freeze.
   * Keep predicate matches snapshot materialization (point + point's children),
   * plus `filter` heads (region rebuild needs pred children — deliberate divergence).
   * Scaffolding `.value` cleared too (parent already holds returned refs).
   */
  #pruneChildProvenance(inv: Invocation): void {
    if (inv.isProvenancePoint) return;
    if (headNameOf(inv.node) === "filter") return;
    for (const child of inv.children) {
      if (child.isProvenancePoint) continue;
      if (child.provenance.size > 0) child.provenance = EMPTY_PROVENANCE;
      child.value = undefined;
    }
  }

  /**
   * Drop the entire invocation graph; PRESERVE `#nextId` so live scheme values
   * carrying stamp ids never collide with new mints. Points are exempt from
   * per-exit value prune — call {@link points} first, then clear (release valve
   * for multi-MB tool responses).
   *
   * Only legal BETWEEN evals: throws if `#openCount > 0` (mid-eval clear would
   * null values an open ancestor still reads). WeakMap/WeakSet entries GC with
   * the graph (no strong refs). Position cursors into `invocationLog` must reset.
   */
  clear(): void {
    invariant(
      this.#openCount === 0,
      "EvalTrace.clear() called while an invocation is still running — only legal between evals " +
        "(call it after a run's exec/execState promise resolves, not from inside a tap callback).",
    );
    this.records.clear();
    this.invocationByTask.clear();
    this.#invocationLog.length = 0;
    this.#logBaseId = this.#nextId;
    this.#mintedSinceReset = 0;
  }

  /**
   * Arm the per-run cap: zero `#mintedSinceReset` and `#openCount`, leave retained
   * graph alone. Cap is a runaway-loop guard for ONE run; a shared long-lived tap
   * that never resets turns it into a session-lifetime budget, then a wedged session
   * (budget throw → open frames never exit → clear throws → counter stuck at cap).
   * After unwind, open-count is garbage — zero it. Straggler exit may go negative
   * (harmless). Graph survives across calls so stamps resolve cross-call.
   */
  beginRun(): void {
    this.#mintedSinceReset = 0;
    this.#openCount = 0;
  }

  /**
   * Approximate retained footprint (no sizeof). Points only for value bytes
   * (prune exempts them): flat overhead + 2×UTF-16 for string values.
   */
  stats(): { entries: number; points: number; retainedValueBytes: number } {
    let points = 0;
    let retainedValueBytes = 0;
    for (const inv of this.#invocationLog) {
      if (!inv.isProvenancePoint) continue;
      points++;
      retainedValueBytes += STATS_PER_ENTRY_OVERHEAD_BYTES;
      const text =
        inv.value instanceof AString ? inv.value.valueOf() : typeof inv.value === "string" ? inv.value : undefined;
      if (text !== undefined) retainedValueBytes += text.length * 2;
    }
    return { entries: this.#invocationLog.length, points, retainedValueBytes };
  }

  /** Mark mint boundary before exit → `{ self.id }` instead of union. */
  markProvenancePoint = (invocation: Invocation): void => {
    invocation.isProvenancePoint = true;
  };

  /** Once-per-session warn — evaluator swallows tap exceptions. */
  #symbolTapWarned = false;

  onSymbolResolved = (invocation: Invocation | null, symbol: ASymbol, value: unknown): void => {
    try {
      if (!invocation) return;
      let map = this.symbolValues.get(invocation);
      if (!map) {
        map = new Map<string, unknown>();
        this.symbolValues.set(invocation, map);
      }
      const name = (symbol as { __name__?: unknown }).__name__;
      if (typeof name === "string") map.set(name, value);

      if (value instanceof AValue && value.provenance.size > 0) {
        if (!invocation.symbolContributions) invocation.symbolContributions = new Set();
        invocation.symbolContributions.add(value.provenance);
      }
    } catch (error) {
      if (!this.#symbolTapWarned) {
        this.#symbolTapWarned = true;

        console.warn("EvalTrace.onSymbolResolved threw; tap data may be incomplete:", error);
      }
    }
  };
}
