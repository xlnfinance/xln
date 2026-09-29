/**
 * Retrospective-stream emission core — pure builders through
 * ProvenanceStore/PayloadStore. WHEN to emit is region-scope's job.
 *
 * Flag-gated (default OFF): `isEmissionEnabled()` first; off → boolean check only,
 * no hash/store/alloc. Identity is caller-supplied `RecordId` (not seq) — store
 * upserts by id, so retries are idempotent without de-dup here.
 */
import type { PayloadHash, RecordId, RegionId, RegionSeq } from "./ids.js";
import type {
  FanInstantiationRecord,
  HostScheduleRecord,
  HostScheduleTriple,
  IngressBindingRecord,
  MintRecord,
  MuxDecisionRecord,
  TrackCloseRecord,
  TrackOpenRecord,
} from "./records.js";
import type { Payload, PayloadStore, ProvenanceStore } from "./interfaces.js";

// Flag — default OFF. Separate from eager-oracle (`isEagerProvenanceOracleEnabled`).

let emissionEnabled = false;

export function isEmissionEnabled(): boolean {
  return emissionEnabled;
}

/** Caller owns flip-back (no auto-reset). */
export function setEmissionEnabled(enabled: boolean): void {
  emissionEnabled = enabled;
}

/** Stream-header epoch when no richer interpreter version exists. Bump trailing digit on replay-relevant semantic change. */
export const DEFAULT_SEMANTICS_EPOCH = "arrival-provenance-v0";

/** FNV-1a over value + stampIds (local copy; stampIds prevent value-only collisions). */
function hashPayload(value: unknown, stampIds: readonly number[]): PayloadHash {
  let canonicalValue: string;
  try {
    canonicalValue = JSON.stringify(value) ?? "null";
  } catch {
    canonicalValue = String(value);
  }
  const tagged = `payload-v0|${canonicalValue}#${stampIds.join(",")}`;
  let h = 0x81_1c_9d_c5;
  for (let i = 0; i < tagged.length; i++) {
    h ^= tagged.codePointAt(i) ?? 0;
    h = Math.imul(h, 0x01_00_01_93);
  }
  return `payload-v0:${(h >>> 0).toString(16).padStart(8, "0")}`;
}

/** Write stream header once (by absence); never overwrite an existing epoch. */
export async function ensureStreamHeader(
  store: ProvenanceStore,
  regionId: RegionId,
  semanticsEpoch: string = DEFAULT_SEMANTICS_EPOCH,
): Promise<void> {
  if (!isEmissionEnabled()) return;
  const existing = await store.getHeader(regionId);
  if (existing === undefined) await store.putHeader(regionId, { semanticsEpoch });
}

/** Mint: put payload then append record (hash never dangles). */
export async function emitMint(opts: {
  readonly store: ProvenanceStore;
  readonly payloads: PayloadStore;
  readonly regionId: RegionId;
  readonly id: RecordId;
  readonly value: unknown;
  readonly stampIds: readonly number[];
}): Promise<MintRecord | undefined> {
  if (!isEmissionEnabled()) return undefined;
  const { store, payloads, regionId, id, value, stampIds } = opts;
  const payloadHash = hashPayload(value, stampIds);
  const payload: Payload = { value, stampIds };
  await payloads.put(payloadHash, payload);
  const seq: RegionSeq = await store.allocateSeq(regionId);
  const record: MintRecord = { kind: "mint", id, seq, payloadHash };
  await store.append(regionId, record);
  return record;
}

/** Port-coupled mux arm index (pure-selector muxes are never recorded). */
export async function emitMuxDecision(opts: {
  readonly store: ProvenanceStore;
  readonly regionId: RegionId;
  readonly id: RecordId;
  readonly arm: number;
}): Promise<MuxDecisionRecord | undefined> {
  if (!isEmissionEnabled()) return undefined;
  const { store, regionId, id, arm } = opts;
  const seq: RegionSeq = await store.allocateSeq(regionId);
  const record: MuxDecisionRecord = { kind: "mux-decision", id, seq, arm };
  await store.append(regionId, record);
  return record;
}

/** Fan instance presence at ordinal (aggregation is fold's job). */
export async function emitFanInstantiation(opts: {
  readonly store: ProvenanceStore;
  readonly regionId: RegionId;
  readonly id: RecordId;
}): Promise<FanInstantiationRecord | undefined> {
  if (!isEmissionEnabled()) return undefined;
  const { store, regionId, id } = opts;
  const seq: RegionSeq = await store.allocateSeq(regionId);
  const record: FanInstantiationRecord = { kind: "fan-instantiation", id, seq };
  await store.append(regionId, record);
  return record;
}

/** Stable binder ingress wiring (varying values are mints, not this kind). */
export async function emitIngressBinding(opts: {
  readonly store: ProvenanceStore;
  readonly regionId: RegionId;
  readonly id: RecordId;
}): Promise<IngressBindingRecord | undefined> {
  if (!isEmissionEnabled()) return undefined;
  const { store, regionId, id } = opts;
  const seq: RegionSeq = await store.allocateSeq(regionId);
  const record: IngressBindingRecord = { kind: "ingress-binding", id, seq };
  await store.append(regionId, record);
  return record;
}

/** Track open (raw per-call; fold aggregates). */
export async function emitTrackOpen(opts: {
  readonly store: ProvenanceStore;
  readonly regionId: RegionId;
  readonly id: RecordId;
}): Promise<TrackOpenRecord | undefined> {
  if (!isEmissionEnabled()) return undefined;
  const { store, regionId, id } = opts;
  const seq: RegionSeq = await store.allocateSeq(regionId);
  const record: TrackOpenRecord = { kind: "track-open", id, seq };
  await store.append(regionId, record);
  return record;
}

/** Track close. Production always `settled: true`; false is shape-test only. */
export async function emitTrackClose(opts: {
  readonly store: ProvenanceStore;
  readonly regionId: RegionId;
  readonly id: RecordId;
  readonly settled: boolean;
}): Promise<TrackCloseRecord | undefined> {
  if (!isEmissionEnabled()) return undefined;
  const { store, regionId, id, settled } = opts;
  const seq: RegionSeq = await store.allocateSeq(regionId);
  const record: TrackCloseRecord = { kind: "track-close", id, seq, settled };
  await store.append(regionId, record);
  return record;
}

/** Full host comparator schedule once at boundary; empty triples → no write. */
export async function emitHostSchedule(opts: {
  readonly store: ProvenanceStore;
  readonly regionId: RegionId;
  readonly id: RecordId;
  readonly triples: readonly HostScheduleTriple[];
}): Promise<HostScheduleRecord | undefined> {
  if (!isEmissionEnabled()) return undefined;
  const { store, regionId, id, triples } = opts;
  if (triples.length === 0) return undefined;
  const seq: RegionSeq = await store.allocateSeq(regionId);
  const record: HostScheduleRecord = { kind: "host-schedule", id, seq, triples };
  await store.append(regionId, record);
  return record;
}
