/**
 * store/fakes.ts — in-memory `ProvenanceStore`/`PayloadStore` implementations:
 * "law and unit tests run against in-memory fakes implementing the same
 * interfaces with fault injection (write failure, forced eviction..., delayed
 * R2 settle) — default CI, no cloud, no browser." A workerd suite validating a
 * real adapter against this same contract is a later concern.
 *
 * DETERMINISTIC BY CONSTRUCTION: no `setTimeout`/real timers anywhere. Delayed R2
 * settlement is modeled with an injected virtual clock (`PayloadStoreFake.step`) —
 * a test controls exactly when simulated time advances, never a race.
 */
import {
  ordinalPathKey,
  recordIdKey,
  type PayloadHash,
  type RegionId,
  type RegionSeq,
  type OrdinalPath,
  type SiteHash,
  type TemplateHash,
} from "./ids.js";
import type {
  Payload,
  PayloadRecord,
  PayloadStore,
  ProvenanceStore,
  PayloadTier,
  RetentionClass,
  RunStore,
  StoredTemplate,
  StreamHeader,
  TemplateStore,
} from "./interfaces.js";
import type { AggregationRun, ProvenanceRecord } from "./records.js";
import type { WireframeGraph } from "../wireframe/types.js";

// ─────────────────────────────────────────────────────────────────────────────
// ProvenanceStore fake
// ─────────────────────────────────────────────────────────────────────────────

interface RegionSlot {
  header: StreamHeader | undefined;
  nextSeq: number;
  records: Map<string, ProvenanceRecord>;
}

function freshSlot(): RegionSlot {
  return { header: undefined, nextSeq: 1, records: new Map() };
}

/** "A failed write kills the request." Thrown by `append` while the fake's
 *  write-failure knob is armed — the one door this fake needs, since production
 *  behavior on write failure is "throw, caller aborts the request." */
export class ProvenanceWriteFailure extends Error {
  constructor(regionId: RegionId) {
    super(`ProvenanceStoreFake: injected write failure for region ${JSON.stringify(regionId)}`);
    this.name = "ProvenanceWriteFailure";
  }
}

/** In-memory `ProvenanceStore` with one fault-injection knob: `setWriteFailure`.
 *  Everything else (append/allocateSeq/readStream/header) is a straightforward
 *  Map-backed implementation of the real contract — no timers, no async work beyond
 *  the `Promise` shape the interface requires. */
export class ProvenanceStoreFake implements ProvenanceStore {
  private readonly regions = new Map<RegionId, RegionSlot>();
  private writeFailure = false;

  private slot(regionId: RegionId): RegionSlot {
    let s = this.regions.get(regionId);
    if (s === undefined) {
      s = freshSlot();
      this.regions.set(regionId, s);
    }
    return s;
  }

  setWriteFailure(on: boolean): void {
    this.writeFailure = on;
  }

  async append(regionId: RegionId, record: ProvenanceRecord): Promise<void> {
    if (this.writeFailure) throw new ProvenanceWriteFailure(regionId);
    // Idempotent upsert keyed by record id — a retry with the same id
    // overwrites in place, never duplicates in `readStream`'s output.
    this.slot(regionId).records.set(recordIdKey(record.id), record);
  }

  async allocateSeq(regionId: RegionId): Promise<RegionSeq> {
    const s = this.slot(regionId);
    const seq = s.nextSeq;
    s.nextSeq += 1;
    return seq;
  }

  async readStream(regionId: RegionId): Promise<readonly ProvenanceRecord[]> {
    return [...this.slot(regionId).records.values()].toSorted((a, b) => a.seq - b.seq);
  }

  async getHeader(regionId: RegionId): Promise<StreamHeader | undefined> {
    return this.slot(regionId).header;
  }

  async putHeader(regionId: RegionId, header: StreamHeader): Promise<void> {
    this.slot(regionId).header = header;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// RunStore fake
// ─────────────────────────────────────────────────────────────────────────────

/** Upsert key for one `AggregationRun` — `interfaces.ts`'s `RunStore.putRun` doc:
 *  "idempotent by the run's own key (kind, templateHash, regionEpoch,
 *  parentOrdinalPath, start)." Distinct from `aggregate.ts`'s `RunKey` (which
 *  omits `start` — that one is the GROUPING key a run is folded under, before
 *  its start ordinal is even known; this one is the STORAGE key once it is). */
function runStorageKey(regionId: RegionId, run: AggregationRun): string {
  return JSON.stringify([regionId, run.kind, run.templateHash, run.regionEpoch, run.parentOrdinalPath, run.start]);
}

/** In-memory `RunStore`: a flat `Map` keyed by `runStorageKey`, matching
 *  `ProvenanceStoreFake`'s own upsert-by-key shape. No fault-injection knobs of
 *  its own — `AggregatingProvenanceStore` (the write-side hook, `aggregate.ts`)
 *  is what a law test drives to observe write-volume behavior; this fake is
 *  deliberately as simple as `TemplateStoreFake`. */
export class RunStoreFake implements RunStore {
  private readonly runs = new Map<RegionId, Map<string, AggregationRun>>();

  async putRun(regionId: RegionId, run: AggregationRun): Promise<void> {
    let byKey = this.runs.get(regionId);
    if (byKey === undefined) {
      byKey = new Map();
      this.runs.set(regionId, byKey);
    }
    byKey.set(runStorageKey(regionId, run), run);
  }

  async readRuns(regionId: RegionId): Promise<readonly AggregationRun[]> {
    return [...(this.runs.get(regionId)?.values() ?? [])];
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// PayloadStore fake
// ─────────────────────────────────────────────────────────────────────────────

/** Default DO per-value size cap this fake enforces before routing a `put` to the
 *  `pending` (oversize-awaiting-R2) tier instead of `do` — "bounded by
 *  per-value size limits... verify current SQLite-DO row caps at
 *  implementation." 128KB-CLASS placeholder; a real adapter's cap is whatever
 *  DO actually enforces, configurable here so law tests can probe both sides
 *  of it. */
const DEFAULT_VALUE_SIZE_CAP_BYTES = 128 * 1024;

interface PayloadSlot {
  tier: PayloadTier;
  value: unknown;
  stampIds: readonly number[];
  /** Privacy-LIMIT plumbing — set once at `put`, survives every subsequent tier
   *  transition (including `evict`/`applySettle`'s degrade-to-`stub`) unchanged. */
  retention: RetentionClass;
  /** Set while `tier === "pending"` and a `settle` call is scheduled but not yet
   *  applied (delayed-R2-settle fault injection) — cleared once `step` applies it. */
  scheduled: { outcome: "settled" | "failed"; dueAtTick: number } | undefined;
}

/** Thrown by `get`/`settle` for a hash this store never saw — distinct from `stub`
 *  (evicted-but-known) per interfaces.ts's `get` doc: "never returns a fabricated
 *  stub for an unknown hash." */
export class PayloadNotFound extends Error {
  constructor(hash: PayloadHash) {
    super(`PayloadStoreFake: no payload ever put under hash ${JSON.stringify(hash)}`);
    this.name = "PayloadNotFound";
  }
}

/** Thrown when `put` is called under the fake's write-failure knob — the R2/DO-
 *  storage-leg analogue of `ProvenanceWriteFailure`. */
export class PayloadWriteFailure extends Error {
  constructor(hash: PayloadHash) {
    super(`PayloadStoreFake: injected write failure for payload ${JSON.stringify(hash)}`);
    this.name = "PayloadWriteFailure";
  }
}

/** Best-effort size estimate for the fake's size-cap knob. Payloads are "peeled to
 *  plain JS" values (per `provenance/uneval.ts`'s convention) so JSON round-trips in
 *  the common case; a value that doesn't stringify (BigInt, a live AValue box, etc.)
 *  falls back to `String(value).length` rather than throwing — sizing is a fault-
 *  injection KNOB here, not a correctness-load-bearing computation. */
function estimateSizeBytes(value: unknown): number {
  try {
    return JSON.stringify(value)?.length ?? 0;
  } catch {
    try {
      return String(value).length;
    } catch {
      return 0;
    }
  }
}

/** In-memory `PayloadStore` with fault-injection knobs: `setPutFailure`,
 *  `setValueSizeCapBytes` (drives the `do`-vs-`pending` routing on `put`),
 *  `setSettleDelayTicks` + `step` (deterministic delayed-R2-settle, no real timers),
 *  and `evict`/`evictAll` (forced eviction to `stub`, from any tier). */
export class PayloadStoreFake implements PayloadStore {
  private readonly payloads = new Map<PayloadHash, PayloadSlot>();
  private putFailure = false;
  private valueSizeCapBytes = DEFAULT_VALUE_SIZE_CAP_BYTES;
  private settleDelayTicks = 0;
  private now = 0;

  setPutFailure(on: boolean): void {
    this.putFailure = on;
  }

  /** Fault-injection knob: the size threshold (bytes, `estimateSizeBytes`) above
   *  which `put` routes to `pending` instead of `do` — lets a law test probe the
   *  "oversize payloads... R2 by hash reference" leg with small fixtures. */
  setValueSizeCapBytes(bytes: number): void {
    this.valueSizeCapBytes = bytes;
  }

  /** Fault-injection knob: how many `step` ticks a scheduled `settle` waits before
   *  applying — 0 (default) settles synchronously within `settle` itself. */
  setSettleDelayTicks(ticks: number): void {
    this.settleDelayTicks = ticks;
  }

  /** Deterministic virtual clock advance — applies any `settle` scheduled at or
   *  before the new `now`. No wall-clock time is ever read; a test drives this
   *  explicitly to observe a payload sitting at `pending` before the settle lands. */
  step(ticks = 1): void {
    this.now += ticks;
    for (const [hash, slot] of this.payloads) {
      if (slot.scheduled !== undefined && slot.scheduled.dueAtTick <= this.now) {
        this.applySettle(hash, slot, slot.scheduled.outcome);
      }
    }
  }

  private applySettle(hash: PayloadHash, slot: PayloadSlot, outcome: "settled" | "failed"): void {
    if (outcome === "settled") {
      slot.tier = "r2";
    } else {
      // "On R2 failure the payload degrades to stub under tier honesty."
      slot.tier = "stub";
      slot.value = undefined;
    }
    slot.scheduled = undefined;
  }

  async put(hash: PayloadHash, payload: Payload): Promise<void> {
    if (this.putFailure) throw new PayloadWriteFailure(hash);
    const oversize = estimateSizeBytes(payload.value) > this.valueSizeCapBytes;
    this.payloads.set(hash, {
      tier: oversize ? "pending" : "do",
      value: payload.value,
      stampIds: payload.stampIds,
      retention: payload.retention ?? "standard",
      scheduled: undefined,
    });
  }

  async get(hash: PayloadHash): Promise<PayloadRecord> {
    const slot = this.payloads.get(hash);
    if (slot === undefined) throw new PayloadNotFound(hash);
    return {
      tier: slot.tier,
      value: slot.tier === "stub" ? undefined : slot.value,
      stampIds: slot.stampIds,
      retention: slot.retention,
    };
  }

  async settle(hash: PayloadHash, outcome: "settled" | "failed"): Promise<void> {
    const slot = this.payloads.get(hash);
    if (slot === undefined) throw new PayloadNotFound(hash);
    if (slot.tier !== "pending") {
      throw new Error(
        `PayloadStoreFake.settle: hash ${JSON.stringify(hash)} is at tier "${slot.tier}", not "pending" — ` +
          "settle only applies to the oversize-awaiting-R2 leg.",
      );
    }
    if (this.settleDelayTicks <= 0) {
      this.applySettle(hash, slot, outcome);
    } else {
      slot.scheduled = { outcome, dueAtTick: this.now + this.settleDelayTicks };
    }
  }

  async evict(hash: PayloadHash): Promise<void> {
    const slot = this.payloads.get(hash);
    if (slot === undefined) throw new PayloadNotFound(hash);
    // "Value dropped, identity + stamps retained" — forced eviction
    // wins over any in-flight scheduled settle (it is, after all, forced).
    slot.tier = "stub";
    slot.value = undefined;
    slot.scheduled = undefined;
  }

  async evictAll(): Promise<void> {
    for (const hash of this.payloads.keys()) await this.evict(hash);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// TemplateStore fake
// ─────────────────────────────────────────────────────────────────────────────

/** Thrown by `getTemplate` for a hash this store never saw — `PayloadNotFound`'s
 *  template-store analogue (never fabricate a miss as an empty template). */
export class TemplateNotFound extends Error {
  constructor(hash: TemplateHash) {
    super(`TemplateStoreFake: no template ever put under hash ${JSON.stringify(hash)}`);
    this.name = "TemplateNotFound";
  }
}

/** In-memory `TemplateStore`: a `Map<TemplateHash, WireframeGraph>` for the shared
 *  template pool, plus a nested `Map<TemplateHash, Map<pathKey, SiteHash>>`
 *  for the reverse index — DERIVABLE data (a caller-computed record,
 *  never invented by this store), kept as an ordinary in-memory map since a fake
 *  needs no persistence story beyond the default-CI shape. */
export class TemplateStoreFake implements TemplateStore {
  private readonly templates = new Map<TemplateHash, WireframeGraph>();
  private readonly siteIndex = new Map<TemplateHash, Map<string, SiteHash>>();

  async putTemplate(entry: StoredTemplate): Promise<void> {
    // Idempotent upsert by hash — same contract shape as PayloadStore.put.
    this.templates.set(entry.templateHash, entry.graph);
  }

  async getTemplate(hash: TemplateHash): Promise<WireframeGraph> {
    const graph = this.templates.get(hash);
    if (graph === undefined) throw new TemplateNotFound(hash);
    return graph;
  }

  async registerSite(hash: TemplateHash, path: OrdinalPath, site: SiteHash): Promise<void> {
    let byPath = this.siteIndex.get(hash);
    if (byPath === undefined) {
      byPath = new Map();
      this.siteIndex.set(hash, byPath);
    }
    byPath.set(ordinalPathKey(path), site);
  }

  async resolveSite(hash: TemplateHash, path: OrdinalPath): Promise<SiteHash | undefined> {
    return this.siteIndex.get(hash)?.get(ordinalPathKey(path));
  }
}
