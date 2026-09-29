/**
 * store/records.ts — the retrospective RECORD KINDS, per the "record kinds and
 * their aggregation applicability" table. TYPES ONLY — emission (deciding when
 * to mint one of these) lives elsewhere, never this file.
 *
 *   | Kind                | Aggregates (RLE/ring)? |
 *   |---------------------|-------------------------|
 *   | mint (WITH payload) | never — every payload is distinct information |
 *   | mux decision        | never — each is information (port-coupled muxes only) |
 *   | fan instantiation   | YES — ordinal runs under stable wiring |
 *   | ingress binding     | YES — stable wiring stores O(1)+count |
 *   | track open/close    | YES — counter deltas |
 *   | host-schedule       | never — the sequence IS the record |
 *
 * Aggregation runs are PATH-SCOPED: `(parent ordinal-path, start, count)`
 * — inner-loop/fan ordinals restart per outer element, so a run never spans parents.
 */
import type { PayloadHash, RecordId, RegionSeq } from "./ids.js";

/** The seven record kinds a `ProvenanceStore` stream carries. `track-open`/`track-close`
 *  are the table's one "track open/close" row split into two kinds (the
 *  completion invariant needs them distinguishable). */
export type RecordKind =
  | "mint"
  | "mux-decision"
  | "fan-instantiation"
  | "ingress-binding"
  | "track-open"
  | "track-close"
  | "host-schedule";

/** Fields every record kind shares: its deterministic `id` (the idempotent-
 *  upsert key) and its emission-order `seq` (allocated via
 *  `ProvenanceStore.allocateSeq` before the record is built). */
interface RecordBase<K extends RecordKind> {
  readonly kind: K;
  readonly id: RecordId;
  readonly seq: RegionSeq;
}

/** A mint NEVER aggregates — "every payload is distinct
 *  information." The payload itself (value + stamp ids) lives in `PayloadStore`,
 *  addressed by hash; "gensym is a mint; its identity is a recorded payload"
 *  is one instance of this kind, a source rosetta's return is another. */
export interface MintRecord extends RecordBase<"mint"> {
  readonly payloadHash: PayloadHash;
}

/** Only PORT-COUPLED muxes ever reach here — a pure-selector mux
 *  collapses into its wire and is rederived by γ, never recorded. `arm` is the taken
 *  arm's index (0-based, wireframe-arm-order); never aggregates, each decision is
 *  information a pure re-derivation cannot recover (that's WHY it's port-coupled). */
export interface MuxDecisionRecord extends RecordBase<"mux-decision"> {
  readonly arm: number;
}

/** One fan instance came into being at `id.ordinalPath`'s trailing
 *  ordinal. No payload of its own — presence (and, aggregated, COUNT) is the whole
 *  fact; a pure loop's T instances collapse to one `AggregationRun` below. */
export type FanInstantiationRecord = RecordBase<"fan-instantiation">;

/** A binder ingress bound at this ordinal, over STABLE wiring (same
 *  referenced port/prelude-name every iteration — T iterations of stable binder
 *  ingress-bindings store O(1)+count). A per-iteration value that itself varies is a
 *  `MintRecord` at the port that produced it (e.g. an agent-loop rosetta call), not
 *  this kind — this kind is the structural wiring fact, never the value. */
export type IngressBindingRecord = RecordBase<"ingress-binding">;

/** A track opened at this ordinal — sealed-ingress
 *  bookkeeping; aggregates as a counter delta like its close half. */
export type TrackOpenRecord = RecordBase<"track-open">;

/** "Started = completed at region close, throwing
 *  door." `settled` is false only for the async case ("a promise egress keeps
 *  its track PENDING until settled") caught by the incomplete door BEFORE this record
 *  would ever be emitted with `settled: false` in production — the field exists so the
 *  door's precondition is representable/testable at the record-shape level too. */
export interface TrackCloseRecord extends RecordBase<"track-close"> {
  readonly settled: boolean;
}

/** One `(left-ordinal, right-ordinal, verdict)` triple of an order-dependent
 *  selector host's comparator schedule (e.g. one `sort` comparator call). `verdict`
 *  is the raw comparator result (negative/zero/positive) — inlined so schedule
 *  reconstruction is replay-free. */
export interface HostScheduleTriple {
  readonly left: RecordId["ordinalPath"];
  readonly right: RecordId["ordinalPath"];
  readonly verdict: number;
}

/** "The sequence IS the record" — never aggregates, one
 *  `HostScheduleRecord` per order-dependent host invocation carries its FULL
 *  comparator-call sequence, not one record per triple. */
export interface HostScheduleRecord extends RecordBase<"host-schedule"> {
  readonly triples: readonly HostScheduleTriple[];
}

export type ProvenanceRecord =
  | MintRecord
  | MuxDecisionRecord
  | FanInstantiationRecord
  | IngressBindingRecord
  | TrackOpenRecord
  | TrackCloseRecord
  | HostScheduleRecord;

/** Exhaustiveness guard, house style (`src/provenance/lineage.ts`'s `assertNever`):
 *  a `switch (record.kind)` default arm calling this makes "added a `RecordKind`,
 *  forgot a switch arm" a compile error. */
export function assertNeverRecord(x: never): never {
  throw new Error(`unhandled RecordKind: ${JSON.stringify(x)}`);
}

/** The four kinds marked aggregatable (fan/ingress/track-open/
 *  track-close). `mint`/`mux-decision`/`host-schedule` are deliberately excluded —
 *  each of their records is irreducible information, not a repeatable structural fact. */
export type AggregatableRecordKind = "fan-instantiation" | "ingress-binding" | "track-open" | "track-close";

/** An aggregation run compresses a contiguous ordinal RUN of one
 *  aggregatable kind at one template site, under one region epoch, into O(1)+count.
 *  PATH-SCOPED: `parentOrdinalPath` is the enclosing fan/loop's ordinal path (NOT
 *  this run's own trailing ordinal, which `start..start+count` supplies) — "inner-
 *  loop/fan ordinals restart per outer element, so runs never span parents." */
export interface AggregationRun {
  readonly kind: AggregatableRecordKind;
  readonly templateHash: RecordId["templateHash"];
  readonly regionEpoch: RecordId["regionEpoch"];
  readonly parentOrdinalPath: RecordId["ordinalPath"];
  readonly start: number;
  readonly count: number;
}
