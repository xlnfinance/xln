/**
 * read-guard — read log + read∩write deferral guard on RunContext. Rule: a burst must not
 * read its own deferred write. Injectable seam + predict-at-enqueue write-set model:
 * docs/execution.md §READ-GUARD.
 *
 * `ReadTracker`/`WriteSetResolver` are injectable — this module adds NO mobx/plexus import.
 * No tracker ⇒ nothing paid. Keys are host-canonicalized strings; core compares by equality only.
 *
 * Phase 4: when an effect entry carries path-E `resourcePaths`, prefer those as write-set
 * keys via {@link writeSetOfResourcePaths} (serialized resource paths — same vocabulary as
 * the CQS door and later path-keyed atoms). Hosts may still supply a custom resolver.
 */

import type { EffectEntry } from "./effect-log.js";
import { serializeResourcePath } from "./path-algebra.js";

/**
 * One observed read. `clock` is this read's 1-BASED position among all reads observed so far
 * THIS run (the read counts itself — the Nth read has `clock === N`), minted by the tracker at
 * observation time, never re-derived by a consumer. A host implementing `ReadTracker` MUST mint
 * `clock` as `previousLogLength + 1`, matching `MemoryReadTracker` below.
 *
 * The 1-based basis is load-bearing: `EffectEntry.enqueuedAtReadClock` is stamped 0-BASED —
 * "how many reads completed before this enqueue" (`reads.log.length` at enqueue time). Pairing
 * a 1-based read against a 0-based enqueue makes `read.clock > enqueuedAtReadClock` a tie-free
 * fencepost: if ZERO reads preceded an enqueue (`enqueuedAtReadClock === 0`) and the very next
 * read is the first observed (`clock === 1`), `1 > 0` correctly flags it as after. A same-basis
 * comparison would tie exactly this case and silently miss the canonical enqueue-then-read
 * violation — the one case the guard exists to catch.
 */
export interface ReadEvent {
  /** Opaque read-target identity — host-canonicalized, compared by string equality only. */
  readonly key: string;
  readonly clock: number;
}

/**
 * The injectable read-tracking seam. `region` wraps evaluation of ONE top-level form (the
 * eval loop's unit) so the host can install and remove its own hook for exactly that call's
 * duration; arrival core never inspects HOW a read is observed, only reads `log` afterward.
 *
 * Async-shaped (`Promise<T>`), not sync, because form evaluation is async (the generator
 * trampoline yields at budget TICK boundaries): a host tracking substrate must survive an
 * `await`. Mobx's own stack-based `Reaction` does NOT, by construction — a host arming this
 * seam owns that constraint (e.g. an `AsyncLocalStorage`-scoped or per-run ambient swapped at
 * region entry/exit).
 */
export interface ReadTracker {
  region<T>(fn: () => Promise<T>): Promise<T>;
  /** Every read observed so far this run, in observation order (`clock` order). */
  readonly log: readonly ReadEvent[];
}

/**
 * A minimal, host-swappable reference implementation, one instance per run. `region` is a
 * pure pass-through (no hook installed — a host with a real reactive substrate installs its
 * OWN `ReadTracker` instead); `record` is the one extra surface this impl exposes for a caller
 * that already knows its own read keys without a reactive substrate to wrap.
 */
export class MemoryReadTracker implements ReadTracker {
  private readonly _log: ReadEvent[] = [];

  get log(): readonly ReadEvent[] {
    return this._log;
  }

  /** Record one read. `clock` is minted post-increment (1-based) — see `ReadEvent`. */
  record(key: string): void {
    this._log.push({ key, clock: this._log.length + 1 });
  }

  async region<T>(fn: () => Promise<T>): Promise<T> {
    return fn();
  }
}

/** Host-supplied: given a gathered effect entry, the opaque read-keys its deferred write will
 *  touch — or `undefined` when the host cannot derive a footprint for THIS entry (skipped, not
 *  treated as "no writes" — an honest abstention, never a false negative dressed as fact). Any
 *  iterable is accepted, deduplicated internally. */
export type WriteSetResolver = (entry: EffectEntry) => Iterable<string> | undefined;

/**
 * Phase 4 reference resolver: write-set keys = serialized resource paths from
 * `EffectEntry.resourcePaths` when path E rode the entry (3b storage). Absent/empty paths
 * ⇒ honest abstention (`undefined`), never "no writes." Compose with a host fallback when
 * some verbs lack path producers:
 *   `(e) => writeSetOfResourcePaths(e) ?? hostArgKeys(e)`
 */
export const writeSetOfResourcePaths: WriteSetResolver = (entry) => {
  const paths = entry.resourcePaths;
  if (paths === undefined || paths.length === 0) return undefined;
  return paths.map(serializeResourcePath);
};

/** The seam `RunContext.reads` carries. `writeSetOf` is optional independently of `tracker`: a
 *  host may track reads without yet being able to predict write footprints — the guard then
 *  degrades to a no-op, never a crash on incomplete information. */
export interface ReadGuard {
  readonly tracker: ReadTracker;
  readonly writeSetOf?: WriteSetResolver;
}

/**
 * Raised by `checkReadWriteGuard` — the teaching door naming both halves of the violation:
 * which gathered effect was enqueued, and which later read observed a target it will write. A
 * typed field per fact plus a human message built from them, so a catcher can render either.
 */
export class ReadYourDeferredWriteError extends Error {
  constructor(
    readonly effect: EffectEntry,
    readonly readKey: string,
    readonly readClock: number,
  ) {
    const enqueuedAt = effect.enqueuedAtReadClock ?? 0;
    super(
      `read-your-write on a deferred effect: effect ${effect.index} (${effect.verbName}) was gathered at ` +
        `read-clock ${enqueuedAt}, then a read of "${readKey}" (read-clock ${readClock}) observed a target ` +
        `this effect will write — a burst run cannot read its own writes (the deferral would become ` +
        `observable). Put the read in a follow-up call (the effect will be committed by then and the read ` +
        `will see the post-write state), or drop the read.`,
    );
  }
}

/**
 * THE GUARD: for every gathered effect, in program order, check whether any read observed
 * AFTER its enqueue (`read.clock > effect.enqueuedAtReadClock`) hits a key in that effect's
 * predicted write-set. First violation throws `ReadYourDeferredWriteError`; a clean run
 * returns silently.
 *
 * `writeSetOf` absent ⇒ no-op; an entry `writeSetOf` abstains on (returns `undefined`) is
 * skipped the same way — honest incompleteness, not a claim of "no writes." Reads BEFORE an
 * effect's enqueue (`read.clock <= enqueuedAtReadClock`) are the motivating query that led to
 * the effect (read `component.style`, then `set-style`) — never a violation, by construction.
 *
 * `fired` entries (effect-log.ts header) are skipped entirely: the guard's subject is a
 * DEFERRED write becoming observable. A fired effect's write already landed in-run, so a later
 * read of it is the post-write state — legal, and the CQS door owns whether re-querying that
 * domain was allowed at all.
 */
export function checkReadWriteGuard(
  entries: readonly EffectEntry[],
  reads: readonly ReadEvent[],
  writeSetOf: WriteSetResolver | undefined,
): void {
  if (writeSetOf === undefined) return;
  for (const entry of entries) {
    if (entry.fired === true) continue;
    const writeKeys = writeSetOf(entry);
    if (writeKeys === undefined) continue;
    const keySet = writeKeys instanceof Set ? writeKeys : new Set(writeKeys);
    if (keySet.size === 0) continue;
    const enqueuedAt = entry.enqueuedAtReadClock ?? 0;
    for (const read of reads) {
      if (read.clock > enqueuedAt && keySet.has(read.key)) {
        throw new ReadYourDeferredWriteError(entry, read.key, read.clock);
      }
    }
  }
}
