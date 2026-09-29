/**
 * In-memory provenance ring: buffers `append`s and flushes to a `ProvenanceStore` at
 * ports (every await), with size/time backstops and a forced `preHibernate` flush.
 * Port completion barriers on the durable write — failed write leaves the buffer
 * intact so retry re-emits under `ProvenanceStore.append`'s idempotent upsert.
 *
 * Interface-level, fake-backed (workerd adapter is separate). Contract:
 *   - buffered appends are not durable until flush / backstop / preHibernate
 *   - flush/atPort await store.append (barrier)
 *   - failed write keeps buffer intact
 *   - maxRecords + virtual-clock maxAgeTicks force flush without an explicit port
 *   - preHibernate flushes every region with buffered records
 *
 * Not wired into emit.ts (those await append per record). This ring batches across a
 * pure stretch between ports. deferred: wireframe-driver port designation.
 */
import type { ProvenanceStore } from "./interfaces.js";
import type { RegionId } from "./ids.js";
import type { ProvenanceRecord } from "./records.js";

export interface ProvenanceRingOptions {
  /** Size backstop: once a region's buffer reaches this many UNFLUSHED records, the
   *  next `append` to that region awaits a flush before returning. `undefined`
   *  (default) disables the size backstop — a ring with no configured backstops
   *  flushes only at explicit `flush`/`atPort`/`preHibernate` calls. */
  readonly maxRecords?: number;
  /** Time backstop, in the ring's own virtual-clock ticks (see `tick`): once a
   *  region's OLDEST unflushed record has aged at least this many ticks, that region
   *  is eligible for `flushAged`'s awaited flush. `undefined` disables the time
   *  backstop — mirrors `PayloadStoreFake`'s "no real timers anywhere" discipline: a
   *  test drives `tick` explicitly, never a real clock. */
  readonly maxAgeTicks?: number;
}

interface BufferedRecord {
  readonly record: ProvenanceRecord;
  readonly mintedAtTick: number;
}

/** In-memory ring buffering `ProvenanceStore.append` calls per region, deferring the
 *  durable write until a flush point. See the file header for the full contract this
 *  proves. DETERMINISTIC BY CONSTRUCTION, same discipline as `store/fakes.ts`: no
 *  `setTimeout`/real timers — `tick` is the only clock. */
export class ProvenanceRing {
  private readonly buffers = new Map<RegionId, BufferedRecord[]>();
  private now = 0;

  constructor(
    private readonly store: ProvenanceStore,
    private readonly options: ProvenanceRingOptions = {},
  ) {}

  private bufferFor(regionId: RegionId): BufferedRecord[] {
    let buf = this.buffers.get(regionId);
    if (buf === undefined) {
      buf = [];
      this.buffers.set(regionId, buf);
    }
    return buf;
  }

  /** Buffer one record for `regionId` — does NOT touch the underlying store. Awaits a
   *  backstop flush (size only; the time backstop is checked by `tick`/`flushAged`,
   *  never implicitly here — an `append` call carries no notion of "how much time has
   *  passed") if `maxRecords` is configured and now exceeded. */
  async append(regionId: RegionId, record: ProvenanceRecord): Promise<void> {
    const buf = this.bufferFor(regionId);
    buf.push({ record, mintedAtTick: this.now });
    if (this.options.maxRecords !== undefined && buf.length >= this.options.maxRecords) {
      await this.flush(regionId);
    }
  }

  /** Records buffered for `regionId` that have NOT yet reached the durable store —
   *  test/observability surface; a real DO output gate has no equivalent read (this
   *  is a fake-only introspection point, like `PayloadStoreFake`'s knobs). */
  buffered(regionId: RegionId): readonly ProvenanceRecord[] {
    return (this.buffers.get(regionId) ?? []).map((b) => b.record);
  }

  /** The durable-write barrier: AWAIT every buffered record's `store.append` for
   *  `regionId`, in buffered (emission) order, THEN drain the buffer — draining only
   *  after every write succeeds, so a write failure partway through leaves the WHOLE
   *  buffer intact (never a partial drain): the records that DID land before the
   *  throw are already durable (idempotent upsert) and a retried `flush`
   *  simply re-appends everything, landing the already-durable ones as no-op
   *  overwrites and the rest for the first time — "a failed write kills the request...
   *  the idempotent record ids make the retry's re-emission safe," exactly. */
  async flush(regionId: RegionId): Promise<void> {
    const buf = this.buffers.get(regionId);
    if (buf === undefined || buf.length === 0) return;
    for (const entry of buf) {
      await this.store.append(regionId, entry.record);
    }
    buf.length = 0;
  }

  /** Advance the ring's virtual clock — no I/O, no store access; a test calls this
   *  then `flushAged` to observe the time backstop, matching `PayloadStoreFake.step`'s
   *  two-step (advance, then apply) shape kept separate on purpose: advancing time is
   *  never itself an awaited operation, only the flush it enables is. */
  tick(ticks = 1): void {
    this.now += ticks;
  }

  /** Time backstop: AWAIT a flush for every region whose oldest buffered record has
   *  aged at least `maxAgeTicks` (per the constructor option). A no-op, for every
   *  region, if `maxAgeTicks` was never configured — mirrors `append`'s size-backstop
   *  gating (`undefined` disables the knob rather than defaulting to some magic
   *  number). */
  async flushAged(): Promise<void> {
    if (this.options.maxAgeTicks === undefined) return;
    const threshold = this.options.maxAgeTicks;
    for (const [regionId, buf] of this.buffers) {
      const oldest = buf[0];
      if (oldest !== undefined && this.now - oldest.mintedAtTick >= threshold) {
        await this.flush(regionId);
      }
    }
  }

  /** The port-completion barrier, as a wrapper: run `fn` (the port's own work),
   *  then AWAIT a flush of `regionId`'s buffer BEFORE this function's own promise
   *  settles — "a port's completion does not report until its records are durable."
   *  A `fn` that throws skips the flush entirely (the port itself failed; there is no
   *  completion to barrier) — `fn`'s rejection propagates unchanged. A flush failure
   *  AFTER a successful `fn` propagates as THIS function's rejection — the caller
   *  never observes `fn`'s result as if the port had completed, matching "a failed
   *  write kills the request" at the port grain, not just the record grain. */
  async atPort<T>(regionId: RegionId, fn: () => Promise<T> | T): Promise<T> {
    const result = await fn();
    await this.flush(regionId);
    return result;
  }

  /** The DO's pre-hibernation hook, on the interface: force-flush EVERY region with
   *  buffered records, awaited, sequentially (never abandon a later region's flush
   *  because an earlier one is still pending — hibernation must not begin with any
   *  region left dirty). A region whose flush fails here throws, same as `flush`
   *  itself — a real DO adapter decides how to surface that to the runtime;
   *  this interface only guarantees the attempt is made and failures are never
   *  swallowed. */
  async preHibernate(): Promise<void> {
    for (const regionId of this.buffers.keys()) {
      await this.flush(regionId);
    }
  }
}
