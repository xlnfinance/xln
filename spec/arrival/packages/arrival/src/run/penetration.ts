/**
 * penetration — THE §CHOKEPOINT composition point. Composes four channels
 * (cache + effects + reads + paths) at the one place args are decoded and the
 * impl has not fired yet: the baked rosetta `run` wrapper. Sole value caller
 * is the baked rosetta apply (`common/symbols/rosetta.ts`), reached today via
 * `run-cache.ts`'s compatibility re-export (hermeticity audit P2 — split out
 * of run-cache.ts, a file named for one of the four channels it composes).
 *
 * Full model: docs/execution.md §MODE-LAW, §BURST, §TWO-REPLAYS.
 *
 * THE MODE LAW (keep in step with docs/execution.md §MODE-LAW):
 *
 *   class      | record                               | replay
 *   -----------|--------------------------------------|-------------------------------
 *   view       | fire, write/OVERWRITE `{value}`      | hit → serve; miss → fire+write
 *              | (settled entry never suppresses live)| (novel call is fresh)
 *   sink       | fire, write `{effect}` tombstone     | tombstone → skip; miss → fire
 *              | (two identical sinks = TWO effects)  | (new intent, not a repeat)
 *   pure       | fire                                 | fire — determinism from args;
 *              |                                      | never stored
 *   undeclared | fire                                 | fire — regenerateable default
 */

import type { EffectLog } from "./effect-log.js";
import type { ReadTracker } from "./read-guard.js";
import type { ResourcePath } from "./path-algebra.js";
import { runCacheKey, type RunCache, type RunCacheClass } from "./run-cache.js";

/** Per-cache in-flight registry (single-flight). WeakMap keyed by the cache ENTITY: the pending
 *  map's lifetime IS the run cache's residency — no module-level state outlives it (hermetic),
 *  and two concurrent runs sharing one isolate never see each other's pendings unless they
 *  deliberately share one cache. Penetration-local: no other module reads this registry. */
const inFlight = new WeakMap<RunCache, Map<string, Promise<unknown>>>();

function pendingFor(cache: RunCache): Map<string, Promise<unknown>> {
  let map = inFlight.get(cache);
  if (map === undefined) {
    map = new Map();
    inFlight.set(cache, map);
  }
  return map;
}

/** Single-flight fire for the `view`/`pure` classes: register the in-flight promise BEFORE
 *  awaiting so concurrent identical penetrations share one impl call; settle removes the pending
 *  entry either way (rejection = eviction, retries allowed; `view` success = the settled
 *  `{value}` written to the cache). */
async function sharedFire(
  cache: RunCache,
  key: string,
  writeSettledValue: boolean,
  fire: () => Promise<unknown>,
): Promise<unknown> {
  const pending = pendingFor(cache);
  const existing = pending.get(key);
  if (existing !== undefined) return existing;
  const p = fire();
  pending.set(key, p);
  try {
    const value = await p;
    if (writeSettledValue) await cache.set(key, { kind: "value", value });
    return value;
  } finally {
    pending.delete(key);
  }
}

/**
 * THE INTERCEPTION — called by the baked rosetta `run` wrapper between arg decode and impl
 * fire, in place of the bare fire. Implements the mode law (file header) for the penetration
 * `(symbolName, decodedArgs)`; the arm each class takes is snapshotted at the branch below.
 *
 * `effects`, `reads`, and `penetration.rawArgs` are the sibling inputs the table does not
 * cover:
 *
 * `effects` is a sibling parameter, not a `cache` field: a burst run may gather effects with
 * no `RunCache` at all, or alongside a `view`/`pure` cache — independent lifecycles.
 *
 * `reads` is read-only here: when present, a gathered effect's `enqueuedAtReadClock` is stamped
 * from `reads.log.length` at enqueue time — the guard's comparison point. Absent ⇒ no clock
 * (the guard treats it as `0`, every read counts). This function never CHECKS the guard (that
 * is `checkReadWriteGuard`, run by the eval loop after each form) — it only stamps the clock at
 * the one point its value is known.
 *
 * `penetration.rawArgs` carries the boxed, pre-decode args onto a gathered `EffectEntry`
 * verbatim — never inspected here: a confirmation-manifest host needs the provenance-carrying
 * originals to compute per-argument lineage and reconstruct the effect's minimal re-runnable
 * invocation, neither of which `decodedArgs` (JS-plain, identity-stripped) can serve alone.
 *
 * Phase 3b resource-path storage (NO dual-key with sink):
 *   - Arm 1 (void-sink): unchanged — `sink && effects armed && !replay` → enqueue deferred,
 *     skip impl. Optional path E rides on the entry as `resourcePaths`.
 *   - Arm 2 (path E≠[]): SEPARATE — after a successful non-sink fire, when path effects
 *     non-empty and effects armed and !replay, enqueue a **fired** manifest entry carrying
 *     `resourcePaths` (I6). Hybrid (Q and E) uses this arm too — impl runs, not void-skip (I8).
 *   - Path Q≠[]: CQS journal only. Cache is `cacheClass: "view"` (opt-in), never
 *     implied by a query. Interpreter cache of a source (LLM, MCP, …) is a host
 *     plane — the membrane does not snapshot it.
 */
export async function penetrateThroughCache(
  cache: RunCache | undefined,
  penetration: {
    symbolName: string;
    cacheClass: RunCacheClass | undefined;
    sink: boolean;
    rawArgs?: readonly unknown[];
    /** Resource-path queries from contract producers (post-decode). */
    pathQueries?: readonly ResourcePath[];
    /** Resource-path effects from contract producers (post-decode). */
    pathEffects?: readonly ResourcePath[];
  },
  decodedArgs: readonly unknown[],
  fire: () => Promise<unknown>,
  effects?: EffectLog,
  reads?: ReadTracker,
): Promise<unknown> {
  const { symbolName, cacheClass, sink, rawArgs } = penetration;
  const pathEffects = penetration.pathEffects ?? [];
  const hasPathE = pathEffects.length > 0;

  // ARM 1 — classic void-sink gather during a PRIME run. Condition unchanged (not dual-keyed
  // with path E). `cache?.mode === "replay"` excludes a fold. Optional path E rides along.
  if (sink && effects !== undefined && cache?.mode !== "replay") {
    effects.enqueue({
      verbName: symbolName,
      decodedArgs,
      ...(reads === undefined ? {} : { enqueuedAtReadClock: reads.log.length }),
      ...(rawArgs === undefined ? {} : { rawArgs }),
      ...(hasPathE ? { resourcePaths: pathEffects } : {}),
    });
    return undefined;
  }

  // Post-fire path-E log (ARM 2). SEPARATE from sink: never skips impl. Only on successful
  // fire so a thrown impl does not leave a fired-manifest entry (CQS prior-E is recorded
  // pre-impl in applyResourcePathCqs; this is the EffectLog product arm).
  const fireWithPathELog = async (): Promise<unknown> => {
    const value = await fire();
    if (hasPathE && effects !== undefined && cache?.mode !== "replay") {
      effects.enqueue({
        verbName: symbolName,
        decodedArgs,
        fired: true,
        ...(reads === undefined ? {} : { enqueuedAtReadClock: reads.log.length }),
        ...(rawArgs === undefined ? {} : { rawArgs }),
        resourcePaths: pathEffects,
      });
    }
    return value;
  };

  if (cache === undefined) return fireWithPathELog();

  if (sink) {
    let key: string;
    try {
      key = runCacheKey(symbolName, decodedArgs);
    } catch {
      return fireWithPathELog(); // unkeyable sink args — honest plain fire, no tombstone
    }
    if (cache.mode === "replay") {
      const entry = await cache.get(key);
      if (entry?.kind === "effect") return undefined;
    }
    const result = await fireWithPathELog(); // record always fires; replay miss = new intent
    await cache.set(key, { kind: "effect" });
    return result;
  }

  // Cache is declared `cacheClass: "view"` — never implied by a CQS query.
  const treatAsView = cacheClass === "view";

  if (treatAsView) {
    // total by assertCacheClassShape (declared view). A throw here is a bake-gate miss.
    const key = runCacheKey(symbolName, decodedArgs);
    if (cache.mode === "replay") {
      const pending = pendingFor(cache).get(key);
      if (pending !== undefined) return pending; // share the concurrent miss's fire
      const entry = await cache.get(key);
      if (entry?.kind === "value") return entry.value; // hit → serve, never re-fire
    }
    return sharedFire(cache, key, true, fireWithPathELog);
  }

  if (cacheClass === "pure") {
    let key: string;
    try {
      key = runCacheKey(symbolName, decodedArgs);
    } catch {
      return fireWithPathELog(); // unkeyable pure args — unshared fire
    }
    return sharedFire(cache, key, false, fireWithPathELog);
  }

  return fireWithPathELog(); // unclassified — regenerateable, never touches the cache
}
