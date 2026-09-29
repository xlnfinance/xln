/**
 * store/aggregate.ts — path-scoped RLE aggregation over the record kinds the
 * applicability table marks aggregatable. This is the entropy-coding argument
 * made concrete: a stable-wiring loop's T instances carry the SAME structural
 * fact T times — presence at ordinal 0, 1, 2, …, T-1 — which is O(1)+count
 * information (a run: where it starts, how many), not T records each
 * independently seq'd and stored.
 *
 * THE NEVER-LIST (restated here because it is the load-bearing boundary this
 * whole file exists to respect): mint (every payload is distinct information),
 * mux-decision (port-coupled only, each decision is information a pure
 * re-derivation cannot recover — that is WHY it is port-coupled), host-schedule
 * (the sequence IS the record). None of the three is EVER folded. Enforcement is
 * BOTH a type door (`AggregatableRecord` excludes all three — `foldRuns` below
 * cannot even be CALLED with a `MintRecord`/`MuxDecisionRecord`/`HostScheduleRecord`,
 * a compile error, not a runtime check) AND a runtime door (`assertAggregatable`,
 * for the boundary where a caller only has the wider `ProvenanceRecord` union —
 * e.g. `AggregatingProvenanceStore.append` below, which receives every kind and
 * must ROUTE, not assume).
 *
 * RUN REPRESENTATION: reused, not redefined — `AggregationRun` (`records.ts`)
 * is `(kind, templateHash, regionEpoch, parentOrdinalPath, start, count)`,
 * PATH-SCOPED: `parentOrdinalPath` is the enclosing fan/loop's path (never the
 * run's own trailing ordinals, which `start..start+count-1` supply), so
 * inner-loop ordinals that restart per outer element never merge into their
 * outer sibling's run — see `foldRuns`'s key below, which folds
 * `parentOrdinalPath` (not the record's own full `ordinalPath`) as part of the
 * grouping key for exactly this reason.
 *
 * THE WRITE-SIDE HOOK sits BEHIND `ProvenanceStore`, never in the emitters.
 * `store/emit.ts`'s `emit*` functions are UNCHANGED by this — they still
 * call `store.append(regionId, record)` exactly once per logical event. The
 * hook is `AggregatingProvenanceStore`, a decorator implementing the SAME
 * `ProvenanceStore` interface (zero change to that interface's
 * `append`/`readStream` contract — fold-as-recovery keeps working over
 * `readStream` untouched) plus one ADDITIVE companion port, `RunStore`
 * (`interfaces.ts`), that receives compacted runs instead of raw records for
 * the four aggregatable kinds:
 *
 *   emit*()  →  store.append(regionId, record)  →  AggregatingProvenanceStore
 *                                                       │
 *                                    non-aggregatable   │   aggregatable kind
 *                                    kind (never-list)  │   (fan/ingress/track-*)
 *                                         │              │
 *                                         ▼              ▼
 *                                 base.append(...)   buffered in memory,
 *                                 (unchanged, every   O(1) per append — the
 *                                 time, one raw       underlying store is
 *                                 record per call)     NOT written to per
 *                                                       instance
 *                                                       │
 *                                                  flush(regionId) (a run
 *                                                  boundary: non-contiguous
 *                                                  next ordinal, a different
 *                                                  key, or an explicit call —
 *                                                  a port boundary flushes)
 *                                                       │
 *                                                       ▼
 *                                              runs.putRun(regionId, run)
 *                                              — ONE write per closed run,
 *                                              not one per instance
 *
 * This is why the gate is provable without touching the evaluator: drive N
 * aggregatable appends through `AggregatingProvenanceStore` against a spy base
 * store and assert the base store's `append` was called ZERO times for that
 * kind while `RunStore.putRun` was called exactly ONCE with `count === N`.
 *
 * LOSSLESSNESS (fold∘unfold = id on reads): an `AggregationRun` deliberately
 * drops each instance's own `seq` — counter folds are order-insensitive by
 * construction for the four aggregatable kinds (fan-instantiation/ingress-
 * binding/track-open/track-close all reduce to a PRESENCE-or-COUNT fact, never
 * an order-sensitive one; an order-sensitive host cites a `HostScheduleRecord`
 * instead, which is why THAT kind is on the never-list). "The same reads" is
 * therefore precisely: the SET of `(kind, id)` pairs (and, for track-close,
 * `settled`) the run's instances answer to — `unfoldRun` reconstructs exactly
 * that set from `(start, count)`, never the discarded seqs.
 */
import type {
  AggregatableRecordKind,
  AggregationRun,
  FanInstantiationRecord,
  IngressBindingRecord,
  ProvenanceRecord,
  TrackCloseRecord,
  TrackOpenRecord,
} from "./records.js";
import {
  appendOrdinal,
  ordinalPathKey,
  parentOrdinalPath as parentOf,
  trailingOrdinal,
  type OrdinalPath,
  type RecordId,
  type RegionId,
} from "./ids.js";
import type { ProvenanceStore, RunStore } from "./interfaces.js";

// ─────────────────────────────────────────────────────────────────────────────
// The never-list boundary — type door + runtime door
// ─────────────────────────────────────────────────────────────────────────────

/** The four kinds marked aggregatable, narrowed to their own record shapes.
 *  Deliberately excludes `MintRecord`/`MuxDecisionRecord`/`HostScheduleRecord`
 *  — the TYPE half of the never-list door: `foldRuns` below is typed over
 *  this union, so passing a mint/mux-decision/host-schedule record to it is a
 *  compile error, not a runtime check. */
export type AggregatableRecord = FanInstantiationRecord | IngressBindingRecord | TrackOpenRecord | TrackCloseRecord;

const AGGREGATABLE_KINDS: ReadonlySet<AggregatableRecordKind> = new Set([
  "fan-instantiation",
  "ingress-binding",
  "track-open",
  "track-close",
]);

/** Kind-level membership test — the routing decision `AggregatingProvenanceStore
 *  .append` makes on every call (it receives the FULL `ProvenanceRecord` union,
 *  same as `ProvenanceStore.append` always did, so it cannot rely on the type
 *  door alone; this is the runtime half). */
export function isAggregatableKind(kind: ProvenanceRecord["kind"]): kind is AggregatableRecordKind {
  return AGGREGATABLE_KINDS.has(kind as AggregatableRecordKind);
}

/** Thrown by `assertAggregatable` for a never-list kind. A "teaching door"
 *  (`.claude/skills/errors-as-doors`): names WHICH kinds are forbidden and WHY,
 *  not just that this call failed. */
export class NeverAggregatable extends Error {
  constructor(kind: string) {
    super(
      `store/aggregate.ts: "${kind}" records are NEVER aggregatable — every ` +
        `mint/mux-decision/host-schedule record IS the information a pure re-derivation ` +
        "cannot recover (a mint's payload, a port-coupled mux's taken arm, a comparator " +
        "schedule's full sequence); folding one into an RLE run would silently discard it. " +
        "Aggregatable kinds: fan-instantiation, ingress-binding, track-open, track-close.",
    );
    this.name = "NeverAggregatable";
  }
}

/** Runtime door — the OR half of "TYPE or runtime door" for a caller holding
 *  only the wider `ProvenanceRecord` union (e.g. `AggregatingProvenanceStore
 *  .append`'s own parameter, or any future caller that reads a mixed batch off
 *  `readStream` and wants to fold JUST the aggregatable tail of it). Narrows on
 *  success; throws `NeverAggregatable` on a never-list kind. */
export function assertAggregatable(record: ProvenanceRecord): asserts record is AggregatableRecord {
  if (!isAggregatableKind(record.kind)) throw new NeverAggregatable(record.kind);
}

// ─────────────────────────────────────────────────────────────────────────────
// fold — raw contiguous-run records → AggregationRun[]
// ─────────────────────────────────────────────────────────────────────────────

/** Grouping key a run is scoped by: a run is `(parent ordinal-path, start,
 *  count)` at one `(kind, templateHash, regionEpoch)` site. Exported so a
 *  caller (the write-side hook, or a test) can compute/compare keys without
 *  reimplementing the string-encoding. */
export interface RunKey {
  readonly kind: AggregatableRecordKind;
  readonly templateHash: string;
  readonly regionEpoch: string;
  readonly parentOrdinalPath: OrdinalPath;
}

/** Stable string key for `RunKey` — same JSON-encoding idiom `recordIdKey`/
 *  `ordinalPathKey` (`ids.ts`) already use for this store family's compound keys. */
export function runKeyString(key: RunKey): string {
  return JSON.stringify([key.kind, key.templateHash, key.regionEpoch, key.parentOrdinalPath]);
}

function runKeyOf(record: AggregatableRecord): RunKey {
  return {
    kind: record.kind,
    templateHash: record.id.templateHash,
    regionEpoch: record.id.regionEpoch,
    parentOrdinalPath: parentOf(record.id.ordinalPath),
  };
}

/** `foldRuns`'s result: the compacted runs it could form, PLUS whatever it could
 *  not fold — never a silent drop. Two reasons a record lands in `unaggregated`
 *  even though its KIND passed the type door:
 *  1. a `track-close` with `settled: false` — the incomplete-door precondition
 *     made representable (`records.ts`'s `TrackCloseRecord` doc:
 *     "`settled` is false only for the async case... caught by the incomplete
 *     door BEFORE this record would ever be emitted... in production"). There is
 *     no `settled` field on `AggregationRun` — folding one in would misrepresent
 *     it as a completed close. A real production stream never produces this
 *     case (the door throws first); it stays representable here only because
 *     the record SHAPE allows it, per that same doc.
 *  2. a run-of-one whose predecessor didn't chain into it AND whose successor
 *     (if any) doesn't chain OUT of it either — still returned as a `count: 1`
 *     `AggregationRun`, not `unaggregated`; see `foldRuns`'s loop below. (Noted
 *     here so the two-bucket split reads complete: reason 1 is the only path
 *     that reaches `unaggregated` for an otherwise-aggregatable kind.) */
export interface FoldResult {
  readonly runs: readonly AggregationRun[];
  readonly unaggregated: readonly AggregatableRecord[];
}

interface OpenRun {
  kind: AggregatableRecordKind;
  templateHash: string;
  regionEpoch: string;
  parentOrdinalPath: OrdinalPath;
  start: number;
  count: number;
}

function closeRun(open: OpenRun): AggregationRun {
  return {
    kind: open.kind,
    templateHash: open.templateHash,
    regionEpoch: open.regionEpoch,
    parentOrdinalPath: open.parentOrdinalPath,
    start: open.start,
    count: open.count,
  };
}

/** Folds a SEQUENCE of aggregatable records (any emission order — runs are
 *  formed over already-grouped-by-key input in the write-side hook, but this
 *  pure function makes no ordering assumption beyond "records for the same
 *  key that are meant to chain arrive adjacent in the input" — the write-side
 *  hook guarantees that by construction, per-key, since it folds ON APPEND, one
 *  record at a time, in emission order) into maximal contiguous runs. A run
 *  extends only when kind + templateHash + regionEpoch + parentOrdinalPath all
 *  match AND the next record's trailing ordinal is EXACTLY the open run's
 *  `start + count` (contiguous trailing ordinals, never a gap-spanning run).
 *  Anything that cannot extend an open run starts a fresh
 *  run-of-one — every eligible record ends up IN some run (count ≥ 1); nothing
 *  aggregatable-by-kind is ever silently dropped, only `settled: false`
 *  track-close records are excluded (see `FoldResult`'s doc). */
export function foldRuns(records: readonly AggregatableRecord[]): FoldResult {
  const runs: AggregationRun[] = [];
  const unaggregated: AggregatableRecord[] = [];
  let open: OpenRun | undefined;

  const flushOpen = (): void => {
    if (open !== undefined) {
      runs.push(closeRun(open));
      open = undefined;
    }
  };

  for (const record of records) {
    if (record.kind === "track-close" && !record.settled) {
      flushOpen();
      unaggregated.push(record);
      continue;
    }
    const ordinal = trailingOrdinal(record.id.ordinalPath);
    if (ordinal === undefined) {
      // Defensive only — `ROOT_ORDINAL_PATH` (empty path) is documented as never
      // a real designated node's `ordinalPath` (ids.ts), so this never fires in
      // practice; kept so a malformed id degrades to "unaggregated", never a
      // thrown surprise mid-fold or a fabricated ordinal.
      flushOpen();
      unaggregated.push(record);
      continue;
    }
    const key = runKeyOf(record);
    const extends_ =
      open?.kind === key.kind &&
      open.templateHash === key.templateHash &&
      open.regionEpoch === key.regionEpoch &&
      ordinalPathKey(open.parentOrdinalPath) === ordinalPathKey(key.parentOrdinalPath) &&
      open.start + open.count === ordinal;
    if (extends_) {
      open!.count += 1;
    } else {
      flushOpen();
      open = {
        kind: key.kind,
        templateHash: key.templateHash,
        regionEpoch: key.regionEpoch,
        parentOrdinalPath: key.parentOrdinalPath,
        start: ordinal,
        count: 1,
      };
    }
  }
  flushOpen();
  return { runs, unaggregated };
}

// ─────────────────────────────────────────────────────────────────────────────
// unfold — AggregationRun → the per-ordinal facts it represents
// ─────────────────────────────────────────────────────────────────────────────

/** One instance-fact `unfoldRun` reconstructs. Deliberately NOT a `ProvenanceRecord`
 *  — there is no `seq` (discarded by aggregation; see the module doc's
 *  losslessness note) and no `arm`/`payloadHash`/`triples` (never-list fields
 *  that never reach a run in the first place). `settled` is present, and always
 *  `true`, only when `kind === "track-close"` (the only settled-carrying kind an
 *  `AggregationRun` can represent — see `FoldResult`'s doc). */
export interface UnfoldedFact {
  readonly kind: AggregatableRecordKind;
  readonly id: RecordId;
  readonly settled?: boolean;
}

/** The losslessness law's other half: expand a run back into the `count` facts
 *  it stands for, one per ordinal in `[start, start + count)`. `unfoldRun(run)`
 *  answers the SAME membership/count reads the original raw records would —
 *  `foldRuns` + `unfoldRun` round-trip the ordinal SET, which is order-
 *  insensitive by construction for these kinds (see the module doc). */
export function unfoldRun(run: AggregationRun): readonly UnfoldedFact[] {
  const facts: UnfoldedFact[] = [];
  for (let i = 0; i < run.count; i++) {
    const ordinal = run.start + i;
    const id: RecordId = {
      templateHash: run.templateHash,
      regionEpoch: run.regionEpoch,
      ordinalPath: appendOrdinal(run.parentOrdinalPath, ordinal),
    };
    facts.push(run.kind === "track-close" ? { kind: run.kind, id, settled: true } : { kind: run.kind, id });
  }
  return facts;
}

// ─────────────────────────────────────────────────────────────────────────────
// The write-side hook — AggregatingProvenanceStore
// ─────────────────────────────────────────────────────────────────────────────

/** Decorator implementing `ProvenanceStore` over a `base` store (raw records:
 *  the never-list kinds, unchanged) plus a `runs` companion port (`RunStore`,
 *  `interfaces.ts`) that receives compacted runs for the four aggregatable
 *  kinds. See the module doc's diagram for the full routing decision.
 *
 *  BUFFERING IS PER (regionId, RunKey): at most one open run per key at a time,
 *  extended in O(1) per matching `append` call and materialized (`runs.putRun`)
 *  only when the run CLOSES — a non-matching next record for that exact key
 *  (kind/templateHash/regionEpoch/parentOrdinalPath), an unsettled track-close
 *  (never bufferable — written straight through to `base.append`, since it is
 *  not representable as a run at all), or an explicit `flush`/`flushAll` call
 *  ("flush AT PORTS" — this class exposes the primitive; `region-scope.ts`
 *  wires the port-completion call site). */
export class AggregatingProvenanceStore implements ProvenanceStore {
  private readonly openByRegion = new Map<RegionId, Map<string, OpenRun>>();

  constructor(
    private readonly base: ProvenanceStore,
    private readonly runs: RunStore,
  ) {}

  private openMap(regionId: RegionId): Map<string, OpenRun> {
    let m = this.openByRegion.get(regionId);
    if (m === undefined) {
      m = new Map();
      this.openByRegion.set(regionId, m);
    }
    return m;
  }

  private async closeOpenRun(regionId: RegionId, keyStr: string): Promise<void> {
    const m = this.openMap(regionId);
    const open = m.get(keyStr);
    if (open === undefined) return;
    m.delete(keyStr);
    await this.runs.putRun(regionId, closeRun(open));
  }

  async append(regionId: RegionId, record: ProvenanceRecord): Promise<void> {
    if (!isAggregatableKind(record.kind)) {
      // The never-list — mint/mux-decision/host-schedule pass straight through,
      // unchanged, exactly once per call.
      await this.base.append(regionId, record);
      return;
    }
    const aggRecord = record as AggregatableRecord;
    if (aggRecord.kind === "track-close" && !aggRecord.settled) {
      // Not bufferable (see class doc) — close whatever run is open at this
      // exact key first (an unsettled close still ends the run, it just cannot
      // JOIN one), then write the record straight through as a raw record.
      await this.closeOpenRun(regionId, runKeyString(runKeyOf(aggRecord)));
      await this.base.append(regionId, record);
      return;
    }
    const ordinal = trailingOrdinal(aggRecord.id.ordinalPath);
    if (ordinal === undefined) {
      // Defensive mirror of `foldRuns`'s same guard — never fires for a real
      // record (see that function's comment); falls back to a raw write rather
      // than fabricating a run.
      await this.base.append(regionId, record);
      return;
    }
    const key = runKeyOf(aggRecord);
    const keyStr = runKeyString(key);
    const m = this.openMap(regionId);
    const open = m.get(keyStr);
    if (open !== undefined && open.start + open.count === ordinal) {
      open.count += 1; // O(1) — no store write for this instance
      return;
    }
    // Key changed, or this ordinal doesn't chain onto the open run: close
    // whatever was open at this key (if anything — always at most a no-op here
    // in practice, since a DIFFERENT ordinal at the SAME key with the open run
    // present is exactly the "gap" case) and open a fresh run-of-one.
    await this.closeOpenRun(regionId, keyStr);
    m.set(keyStr, {
      kind: key.kind,
      templateHash: key.templateHash,
      regionEpoch: key.regionEpoch,
      parentOrdinalPath: key.parentOrdinalPath,
      start: ordinal,
      count: 1,
    });
  }

  /** Materialize every currently-open run for `regionId` — the port-flush
   *  policy calls this at each port boundary; law tests call it directly to
   *  observe the compacted result without needing a real port to complete. */
  async flush(regionId: RegionId): Promise<void> {
    const m = this.openMap(regionId);
    const keys = [...m.keys()];
    for (const keyStr of keys) await this.closeOpenRun(regionId, keyStr);
  }

  /** Flush every region this instance has ever buffered for — the
   *  pre-hibernation-hook shape ("forced flush on the pre-hibernation hook");
   *  this exposes the primitive, the real hook calls it. */
  async flushAll(): Promise<void> {
    for (const regionId of this.openByRegion.keys()) await this.flush(regionId);
  }

  // Everything else is a pure pass-through — aggregation is exclusively an
  // `append`-side concern; `readStream` keeps `ProvenanceStore`'s EXISTING
  // contract byte-for-byte stable (fold-as-recovery over `readStream` is
  // untouched by this). A caller that wants the compacted view reads
  // `RunStore.readRuns` additionally, never instead.
  async allocateSeq(regionId: RegionId) {
    return this.base.allocateSeq(regionId);
  }

  async readStream(regionId: RegionId) {
    return this.base.readStream(regionId);
  }

  async getHeader(regionId: RegionId) {
    return this.base.getHeader(regionId);
  }

  async putHeader(regionId: RegionId, header: Parameters<ProvenanceStore["putHeader"]>[1]) {
    return this.base.putHeader(regionId, header);
  }
}
