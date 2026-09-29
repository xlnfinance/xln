/**
 * store/interfaces.ts — the two storage PORTS the DO surface is built interface-first
 * against: `ProvenanceStore` (DO-storage-shaped: append/read/upsert/seq/header) and
 * `PayloadStore` (R2-shaped: put/get by hash, async settle, tiered degradation).
 * Law and unit tests run against `fakes.ts`'s in-memory implementations with fault
 * injection — default CI, no cloud. A workerd adapter proving these same contracts
 * against real DO/R2 is a later concern, never this file's.
 */
import type { OrdinalPath, PayloadHash, RegionId, RegionSeq, SiteHash, TemplateHash } from "./ids.js";
import type { AggregationRun, ProvenanceRecord } from "./records.js";
import type { WireframeGraph } from "../wireframe/types.js";

/** "The stream header records the interpreter version (semantics epoch)."
 *  One header per region's stream, written once at region-open; the offload
 *  protocol reads it to refuse (or sampled-verify) a stale replay request. */
export interface StreamHeader {
  readonly semanticsEpoch: string;
}

/** A privacy LIMIT: "persisted payloads persist SECRETS (API responses, user
 *  data) — the tiering policy doubles as a privacy/retention surface; flagged
 *  for product review." This plumbs the FLAG end-to-end (write → every read,
 *  every tier including `stub` — same contract shape as `stampIds`); what a
 *  `"sensitive"` tag actually DOES (shorter TTL, R2 opt-out, redaction) is
 *  deliberately out of scope here — flagged for product review, not policy
 *  specified. `"standard"` is the default a `put` without an explicit tag
 *  settles to (`fakes.ts`). */
export type RetentionClass = "standard" | "sensitive";

/** "A persisted payload is the VALUE plus its STAMP IDS" — the write/read
 *  round-trip unit containment laws at replay need (the stamp ids are the eager-
 *  oracle's numeric ids, `AValue.provenance`'s TEST-ONLY today, `op-helpers.ts`).
 *  `retention` is OPTIONAL on write (a caller with no opinion omits it — see
 *  `RetentionClass`'s doc for the default) but always present on read
 *  (`PayloadRecord`, below). */
export interface Payload {
  readonly value: unknown;
  readonly stampIds: readonly number[];
  readonly retention?: RetentionClass;
}

/** The four-stage tiering pipeline: `ring` (in-memory, hot, bounded) → `do` (DO
 *  storage, fits the per-value size cap) → `pending`/`r2` (oversize, async R2
 *  settlement via the named `pending → R2-ref` transition) → `stub` (evicted; value
 *  dropped, identity + stamps retained). */
export type PayloadTier = "ring" | "do" | "pending" | "r2" | "stub";

/** The answer-envelope evidence tier — reproduced here (read-only reference)
 *  because `PayloadTier` state feeds it directly; the OWNING definition (the full
 *  answer envelope, `replayed`/`replayed-cached` distinguishing live-γ from memo-hit)
 *  lives in `store/tiering.ts`/`replay-memo.ts` — this store never computes it. */
export type EvidenceTier = "replayed" | "replayed-cached" | "recorded" | "stub";

/** A `PayloadStore.get` snapshot. "Value dropped, identity + stamps
 *  retained" — `value` is `undefined` at `stub` (and nowhere else); `stampIds`
 *  survives every tier including `stub` (small, identity-bearing, never evicted).
 *  `retention` survives every tier the same way (privacy-LIMIT plumbing —
 *  see `RetentionClass`'s doc; the tag is identity-adjacent metadata, not the secret
 *  payload itself, so there is no tier-honesty reason to ever drop it). */
export interface PayloadRecord {
  readonly tier: PayloadTier;
  readonly value: unknown | undefined;
  readonly stampIds: readonly number[];
  readonly retention: RetentionClass;
}

/** DO-storage-shaped port. `regionId` (see `ids.ts`) selects which region's stream;
 *  a `RecordId`'s `regionEpoch` component (opaque, minted upstream) disambiguates
 *  records within that region's lifetime across reopens — this store does not
 *  interpret it, only stores/returns it verbatim as part of each record's id. */
export interface ProvenanceStore {
  /** Idempotent UPSERT keyed by `record.id` — "CF request retries and
   *  multi-request programs re-emit safely"; two `append`s with the same id are one
   *  record (the second overwrites, assumed-identical content), never a duplicate.
   *  A failed write must abort the request (the fake's write-failure knob
   *  models this) — the caller relies on `append` throwing, never silently dropping. */
  append(regionId: RegionId, record: ProvenanceRecord): Promise<void>;

  /** "Per-region monotonic sequence" — allocate the next `seq` for a record
   *  about to be appended to `regionId`. Monotonic for the region's WHOLE lifetime
   *  (never resets on reopen — `RegionEpoch` disambiguates reopens, not this counter).
   *  Callers must allocate once per logical record and reuse that `seq` across a
   *  retry (re-`append`ing the identical record) — this store guarantees id-dedup,
   *  not "the same seq comes back if you call this twice." */
  allocateSeq(regionId: RegionId): Promise<RegionSeq>;

  /** The region's total order, EMISSION order (settlement order for async) —
   *  returned sorted by `seq` ascending. This is what fold-as-recovery
   *  replays after a DO wake/eviction to reconstruct region state; "the stream IS
   *  the durable region state," never a derived cache. */
  readStream(regionId: RegionId): Promise<readonly ProvenanceRecord[]>;

  getHeader(regionId: RegionId): Promise<StreamHeader | undefined>;

  /** Write the region's stream header — called once, at region-open. */
  putHeader(regionId: RegionId, header: StreamHeader): Promise<void>;
}

/** The write-side AGGREGATION HOOK's storage-side contract.
 *  ADDITIVE companion to `ProvenanceStore`, never a replacement: aggregation sits
 *  BEHIND `ProvenanceStore`, not in the emitters (`store/emit.ts`'s `emit*`
 *  functions are unchanged by this port's existence — they still call
 *  `ProvenanceStore.append` exactly once per logical event). `store/aggregate.ts`'s
 *  `AggregatingProvenanceStore` is the reference write-side hook: it decorates a
 *  base `ProvenanceStore` (the never-list kinds — mint/mux-decision/host-schedule
 *  — pass straight through to `base.append`, unchanged) plus a `RunStore` (the
 *  four aggregatable kinds — fan-instantiation/ingress-binding/track-open/
 *  track-close — buffered in memory and materialized here ONLY when a run
 *  closes, never one write per instance). This keeps `ProvenanceStore.append`/
 *  `readStream`'s EXISTING contract byte-for-byte stable — fold-as-recovery
 *  over `readStream` needs no changes; a reader that wants the compacted view
 *  reads `readRuns` ADDITIONALLY, never instead. See `aggregate.ts`'s module doc
 *  for the full routing diagram and the losslessness law (`unfoldRun`) that
 *  proves a run answers the same reads as its expansion. */
export interface RunStore {
  /** Persist one finalized run — called by the write-side hook when a run
   *  CLOSES (a non-matching next record arrives at that exact key, or an
   *  explicit `flush`/`flushAll` call, e.g. at a port boundary — "flush AT
   *  PORTS"). Idempotent by the run's own key (kind, templateHash,
   *  regionEpoch, parentOrdinalPath, start) — same upsert-by-key contract shape
   *  as `ProvenanceStore.append`; a run re-`putRun`'d under the identical key
   *  overwrites (assumed a wider/more-complete re-close of the same run, never
   *  a duplicate). */
  putRun(regionId: RegionId, run: AggregationRun): Promise<void>;

  /** The region's compacted runs — `readStream`'s counterpart for the
   *  aggregated view: the SAME underlying facts `readStream` would show as many
   *  raw records for an aggregatable kind, folded to `O(1)+count` per run.
   *  `unfoldRun` (`aggregate.ts`) is the losslessness law's witness between the
   *  two views. No ordering guarantee beyond "some order" — counter folds are
   *  order-insensitive by construction, unlike `readStream`'s emission
   *  order, which callers that need ordering (host-schedule, mints) still get
   *  from `readStream` itself. */
  readRuns(regionId: RegionId): Promise<readonly AggregationRun[]>;
}

/** R2-shaped port, content-addressed by `PayloadHash`. The tiering state machine
 *  lives behind this contract; `tiering.ts`'s fuller policy/envelope wraps it,
 *  never replaces it. */
export interface PayloadStore {
  /** Persist a payload. Idempotent by hash — same hash assumed same
   *  content, a re-`put` is a no-op-shaped overwrite, never a duplicate. Lands at tier
   *  `do` if the value fits the store's size cap, `pending` (awaiting R2 settlement)
   *  if oversize — the size cap itself is a fake-only fault-injection knob (`fakes.ts`);
   *  a real adapter's cap is DO storage's own per-value limit.
   *  `payload.retention` (privacy-LIMIT plumbing) flows through unchanged to
   *  every subsequent `get`, defaulting to `"standard"` when omitted. */
  put(hash: PayloadHash, payload: Payload): Promise<void>;

  /** "Drill-in degrades PER TIER, deterministically, and NEVER silently" — read
   *  back whatever tier the payload currently lives at. Throws if `hash` was never
   *  `put` (never returns a fabricated `stub` for an unknown hash — that would conflate
   *  "we don't have this" with "we had this and evicted it"). `retention` survives at
   *  every tier including `stub` (same as `stampIds`). */
  get(hash: PayloadHash): Promise<PayloadRecord>;

  /** Settle a `pending` (oversize, awaiting-R2) payload — idempotent upsert to
   *  `r2` on `"settled"`, or degrade to `stub` on `"failed"` ("on R2 failure the
   *  payload degrades to stub under tier honesty"). No-op-shaped if already settled
   *  to the SAME outcome; throws if called on a payload that was never `pending`. */
  settle(hash: PayloadHash, outcome: "settled" | "failed"): Promise<void>;

  /** Force-evict to hash-only stub from ANY tier — "value dropped,
   *  identity + stamps retained." Models both real eviction policy (memory pressure)
   *  and the fault-injection "forced eviction" knob the law tests drive. */
  evict(hash: PayloadHash): Promise<void>;
}

/** "The template store is shared and immutable: wire templates + prelude live
 *  in a cross-DO store (KV/R2) keyed by template-hash." One `StoredTemplate` per
 *  `WireframeGraph` the wireframe builder emits (`WireframeProgram.main`, one per
 *  `DefineTemplate`, or a fan node's private `template` interior) — `templateHash` is
 *  `wireframe/hash.ts`'s `hashGraph(graph)`, so a re-`put` of a structurally-identical
 *  graph is a same-hash no-op, matching "identical across every DO running the
 *  program version." */
export interface StoredTemplate {
  readonly templateHash: TemplateHash;
  readonly graph: WireframeGraph;
}

/** The TEMPLATE STORE port — the DO-storage-shaped seam `hashGraph`/`siteHash`
 *  (`wireframe/hash.ts`) feed: "records key on template-hash + ordinal-path,
 *  the plane keys on site-hash... the template-store interface must expose
 *  ordinal-path → site-hash resolution (a DERIVABLE index, not new stored
 *  state)." `registerSite`/`resolveSite` are that reverse index: DERIVABLE
 *  because a `siteHash` is a pure function of (`templateHash`, instantiation span) —
 *  this store never invents one, it only remembers what a caller (the wireframe
 *  builder, which still holds live spans before `hashGraph` strips them) already
 *  computed, so the mapping could always be recomputed from the wireframe + its
 *  original spans rather than needing independent versioning. */
export interface TemplateStore {
  /** Persist a template's graph, keyed by its own hash. Idempotent by hash — same
   *  contract shape as `PayloadStore.put`: a re-`put` of the SAME hash is assumed
   *  identical content, never a duplicate. */
  putTemplate(entry: StoredTemplate): Promise<void>;

  /** Read a template's graph by hash. Throws if never `put` — `PayloadStore.get`'s
   *  convention (never fabricate a miss as an empty/absent template). */
  getTemplate(hash: TemplateHash): Promise<WireframeGraph>;

  /** Register ONE occurrence's reverse-index row: this `(templateHash, ordinalPath)`
   *  coordinate renders at this `SiteHash`. Called once per static site the builder
   *  discovers — potentially MANY per `templateHash` (dedup means one template may be
   *  instantiated at several sites; "the same expression at two program sites
   *  shares storage"... "the two sites render as two wires"). Idempotent — the same
   *  triple re-registered is a no-op; a DIFFERENT site registered under an
   *  already-registered `(hash, path)` pair overwrites (last-registered wins, mirroring
   *  every other upsert-by-key contract in this store family). */
  registerSite(hash: TemplateHash, path: OrdinalPath, site: SiteHash): Promise<void>;

  /** The reverse index itself: resolve a record's `(templateHash, ordinalPath)`
   *  coordinate to the `SiteHash` the plane renders it at. `undefined` if no site was
   *  ever registered for that exact pair (a caller never wired `registerSite` through
   *  for it, or the coordinate doesn't correspond to any real designated node). */
  resolveSite(hash: TemplateHash, path: OrdinalPath): Promise<SiteHash | undefined>;
}
