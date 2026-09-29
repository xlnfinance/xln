/**
 * Fold-as-recovery: in-memory region state is a cache of the stream; DO wake
 * reconstructs by folding durable records. `foldRegionStream` is pure over
 * readStream output — recovery IS re-calling it (no second recovery machine).
 */
import type { ProvenanceStore } from "./interfaces.js";
import { assertNeverRecord, type HostScheduleRecord, type ProvenanceRecord } from "./records.js";
import type { OrdinalPath, RegionEpoch, RegionId, RegionSeq, TemplateHash } from "./ids.js";

/**
 * Stream-derivable region state (opens/completions/schedules). Wrapper caches
 * are not stream facts — recovery needs coordinates (`nextTrackOrdinal`), not closures.
 */
export interface RegionFoldState {
  readonly started: number;
  /** settled:true closes. unsettled kept separate so they never inflate completed. */
  readonly completed: number;
  readonly unsettledCloses: number;
  /** started − completed; region close requires pending === 0. */
  readonly pending: number;
  /** Host schedules in emission order (only durably flushed ones). */
  readonly hostSchedules: readonly HostScheduleRecord[];
  /** Durable high-water mark; fold never mints seq. */
  readonly lastSeq: RegionSeq;
}

const EMPTY_FOLD: RegionFoldState = {
  started: 0,
  completed: 0,
  unsettledCloses: 0,
  pending: 0,
  hostSchedules: [],
  lastSeq: 0,
};

export function foldRegionStream(records: readonly ProvenanceRecord[]): RegionFoldState {
  if (records.length === 0) return EMPTY_FOLD;
  let started = 0;
  let completed = 0;
  let unsettledCloses = 0;
  let lastSeq = 0;
  const hostSchedules: HostScheduleRecord[] = [];
  const ordered = records.toSorted((a, b) => a.seq - b.seq);
  for (const record of ordered) {
    if (record.seq > lastSeq) lastSeq = record.seq;
    switch (record.kind) {
      case "track-open":
        started++;
        break;
      case "track-close":
        if (record.settled) completed++;
        else unsettledCloses++;
        break;
      case "host-schedule":
        hostSchedules.push(record);
        break;
      case "mint":
      case "mux-decision":
      case "fan-instantiation":
      case "ingress-binding":
        // Lifecycle fold ignores these; aggregation/demand own them.
        break;
      default:
        assertNeverRecord(record);
    }
  }
  return { started, completed, unsettledCloses, pending: started - completed, hostSchedules, lastSeq };
}

/** readStream + fold — same function for DO-wake recovery and post-hoc query. */
export async function foldRegionState(store: ProvenanceStore, regionId: RegionId): Promise<RegionFoldState> {
  return foldRegionStream(await store.readStream(regionId));
}

/** Track coordinate fields — local copy (store sits below region-scope). */
export interface FoldTrackCoordinate {
  readonly templateHash: TemplateHash;
  readonly ordinalPath: OrdinalPath;
  readonly regionEpoch: RegionEpoch;
}

/**
 * Next free trailing ordinal under coordinate. Without this seed, resumed scopes
 * re-mint ids that collide with durable pre-eviction records (id-only upsert).
 * Direct track events only (path = prefix + one ordinal).
 */
export function nextTrackOrdinal(records: readonly ProvenanceRecord[], coordinate: FoldTrackCoordinate): number {
  const prefixLen = coordinate.ordinalPath.length;
  let maxOrdinal = -1;
  for (const record of records) {
    if (record.kind !== "track-open" && record.kind !== "track-close") continue;
    const { id } = record;
    if (id.templateHash !== coordinate.templateHash) continue;
    if (id.regionEpoch !== coordinate.regionEpoch) continue;
    if (id.ordinalPath.length !== prefixLen + 1) continue;
    let matchesPrefix = true;
    for (let i = 0; i < prefixLen; i++) {
      if (id.ordinalPath[i] !== coordinate.ordinalPath[i]) {
        matchesPrefix = false;
        break;
      }
    }
    if (!matchesPrefix) continue;
    const trailing = id.ordinalPath[prefixLen];
    if (trailing > maxOrdinal) maxOrdinal = trailing;
  }
  return maxOrdinal + 1;
}
