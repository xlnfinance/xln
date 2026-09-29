/**
 * `ProvenanceStore` adapter backed by a REAL Durable Object (docs/PROVENANCE.md
 * §4: "In-memory region state is a cache of the stream, never the source of
 * truth").
 *
 * DELIBERATELY DUMB: `ProvenanceRegionDO` holds NO instance field beyond `ctx`/`env`
 * — every method reads/writes `ctx.storage` directly, every call. There is nothing
 * for a forced eviction (`DurableObjectState.abort()`) to lose, because nothing is
 * ever cached in JS-heap memory in the first place — this is the property §4
 * demands, made structurally true rather than merely tested for. One DO instance =
 * one region (the test binds a region via `idFromName(regionId)`); this class does
 * not itself branch on a `regionId` parameter the way the `ProvenanceStore`
 * interface's methods do — the DO's OWN identity IS the region.
 *
 * Storage layout (plain KV keys — SQLite-backed DOs still expose this surface):
 *   "seq"          → the region's monotonic sequence counter (number)
 *   "header"       → the region's `StreamHeader`, once written
 *   "rec:<idKey>"  → one `ProvenanceRecord`, keyed by `recordIdKey(record.id)` —
 *                    idempotent upsert by construction (§4), same as
 *                    `ProvenanceStoreFake`'s own Map-keyed-by-`recordIdKey` shape.
 *
 * `readStream`/`foldNow` page through `ctx.storage.list` (workerd's default list
 * page size is well below this harness's record counts) rather than assuming one
 * call returns everything.
 */
import { DurableObject } from "cloudflare:workers";

import { recordIdKey } from "../../provenance/store/ids.js";
import { foldRegionStream, type RegionFoldState } from "../../provenance/store/fold.js";
import type { StreamHeader } from "../../provenance/store/interfaces.js";
import type { ProvenanceRecord } from "../../provenance/store/records.js";

export interface Env {
  readonly PROVENANCE_DO: DurableObjectNamespace<ProvenanceRegionDO>;
}

const RECORD_PREFIX = "rec:";

export class ProvenanceRegionDO extends DurableObject<Env> {
  /** §4: idempotent upsert keyed by `recordIdKey(record.id)` — two `append`s
   *  for the same logical record land as ONE stored entry, exactly like
   *  `ProvenanceStoreFake.append`. Awaiting `ctx.storage.put` (no
   *  `allowUnconfirmed`) is what makes this method durable-write-barriered: the
   *  DO's output gate holds the RPC response back until the write is committed
   *  (§4: "Port completion BARRIERS on the durable write — this is exactly what
   *  DO output gates provide natively"). */
  async append(record: ProvenanceRecord): Promise<void> {
    await this.ctx.storage.put(`${RECORD_PREFIX}${recordIdKey(record.id)}`, record);
  }

  /** §4: "per-region monotonic sequence" — never resets, persisted in storage
   *  (not an instance field) so it survives eviction exactly like every other
   *  piece of this DO's state. */
  async allocateSeq(): Promise<number> {
    const current = (await this.ctx.storage.get<number>("seq")) ?? 0;
    const next = current + 1;
    await this.ctx.storage.put("seq", next);
    return next;
  }

  /** §4: the region's total order, EMISSION order, sorted by `seq` ascending —
   *  same contract as `ProvenanceStoreFake.readStream`. Pages through
   *  `ctx.storage.list` rather than assuming one call returns every key. */
  async readStream(): Promise<ProvenanceRecord[]> {
    const out: ProvenanceRecord[] = [];
    let cursor: string | undefined;
    for (;;) {
      const page = await this.ctx.storage.list<ProvenanceRecord>({
        prefix: RECORD_PREFIX,
        startAfter: cursor,
        limit: 500,
      });
      if (page.size === 0) break;
      for (const [key, value] of page) {
        out.push(value);
        cursor = key;
      }
      if (page.size < 500) break;
    }
    return out.toSorted((a, b) => a.seq - b.seq);
  }

  async getHeader(): Promise<StreamHeader | undefined> {
    return this.ctx.storage.get<StreamHeader>("header");
  }

  async putHeader(header: StreamHeader): Promise<void> {
    await this.ctx.storage.put("header", header);
  }

  /** Convenience RPC: fold THIS region's real, durable stream — §7's law
   *  ("fold(events) = final region state... the SAME fold reconstructs region
   *  state on DO wake") run against ACTUAL DO storage rather than a fake. The test
   *  could equivalently call `readStream()` then fold client-side with the SAME
   *  `foldRegionStream` import — this method exists so the fold happens INSIDE
   *  the DO too (proving the DO-side import path resolves and executes under
   *  workerd, not merely that the record shapes round-trip). */
  async foldNow(): Promise<RegionFoldState> {
    return foldRegionStream(await this.readStream());
  }

  /** Total stored record count — a cheap sanity probe distinct from `readStream`'s
   *  full materialization, useful for the test's "nothing was lost" assertions
   *  without re-deserializing every record. */
  async recordCount(): Promise<number> {
    const page = await this.ctx.storage.list({ prefix: RECORD_PREFIX });
    return page.size;
  }
}

// Required by wrangler even though this worker's only real surface is
// `ProvenanceRegionDO`'s RPC methods (called directly via a `DurableObjectStub` in
// the test) — no HTTP route is ever exercised.
export default {
  async fetch(): Promise<Response> {
    return new Response("provenance-budget workerd harness — RPC-only, no HTTP surface", { status: 404 });
  },
};
