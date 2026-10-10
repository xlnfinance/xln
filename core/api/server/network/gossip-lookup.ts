import type { GossipProfileAdmission } from './gossip-admission';

/** A missing profile is looked up on the relay at most once per minute per entity. */
const LOOKUP_MIN_INTERVAL_MS = 60_000;
/**
 * Lookups arriving within this window travel as one batched relay request; a
 * caller walking a list sequentially keeps extending the batch until it goes
 * quiet, so a hundred misses cost the relay one or two requests.
 */
const BATCH_QUIET_MS = 30;
const BATCH_MAX_MS = 300;
// Below the relay's per-request id cap: a batch it refuses fails every caller
// riding in it. A full batch makes the next miss open (and pay for) another.
export const GOSSIP_PROFILE_LOOKUP_BATCH_MAX_IDS = 256;
const REMEMBERED_MAX = 100_000;

type LookupBatch = { entityIds: Set<string>; done: Promise<void>; touch: () => void };

/**
 * Coalesce concurrent misses into one relay request and remember when each
 * entity was last asked for, so a caller polling for a profile that has not
 * been announced yet costs the relay one lookup per minute, not one per poll.
 */
export const createGossipProfileLookupBatcher = (admission: GossipProfileAdmission) => {
  const lookedUpAt = new Map<string, number>();
  let current: LookupBatch | null = null;

  const openBatch = (fetchProfiles: (entityIds: string[]) => Promise<void>): LookupBatch => {
    const entityIds = new Set<string>();
    const openedAt = Date.now();
    let lastAddedAt = openedAt;
    const settle = (resolve: () => void) => {
      const wait = Math.min(BATCH_QUIET_MS, openedAt + BATCH_MAX_MS - Date.now());
      setTimeout(() => {
        const quiet = Date.now() - lastAddedAt >= BATCH_QUIET_MS;
        if (quiet || Date.now() - openedAt >= BATCH_MAX_MS) resolve();
        else settle(resolve);
      }, Math.max(1, wait));
    };
    let batch: LookupBatch | null = null;
    const done = new Promise<void>(resolve => settle(resolve)).then(async () => {
      // A full batch is replaced before it flushes; never clear its successor.
      if (current === batch) current = null;
      await fetchProfiles([...entityIds]);
    });
    batch = { entityIds, done, touch: () => { lastAddedAt = Date.now(); } };
    return batch;
  };

  return {
    /** Resolves once the batch carrying this miss was fetched; 'rate-limited' when the caller is over budget. */
    lookup(
      targetEntityId: string,
      clientId: string,
      fetchProfiles: (entityIds: string[]) => Promise<void>,
    ): Promise<void> | 'rate-limited' {
      const now = Date.now();
      if (now - (lookedUpAt.get(targetEntityId) ?? 0) < LOOKUP_MIN_INTERVAL_MS) return Promise.resolve();
      // The budget guards the relay: one batched relay request spends one unit,
      // however many misses it carries.
      const batchFull = (current?.entityIds.size ?? 0) >= GOSSIP_PROFILE_LOOKUP_BATCH_MAX_IDS;
      if ((!current || batchFull) && !admission.admit(clientId)) return 'rate-limited';
      // Insertion order is lookup order, so the oldest entry is evicted first in
      // O(1). A full scan per miss above the cap let fresh random ids burn the
      // Runtime thread.
      lookedUpAt.delete(targetEntityId);
      lookedUpAt.set(targetEntityId, now);
      for (const oldest of lookedUpAt.keys()) {
        if (lookedUpAt.size <= REMEMBERED_MAX) break;
        lookedUpAt.delete(oldest);
      }
      if (!current || batchFull) current = openBatch(fetchProfiles);
      current.entityIds.add(targetEntityId);
      current.touch();
      return current.done;
    },
  };
};
