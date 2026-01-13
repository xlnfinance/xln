/**
 * signAsEntity - Helper for collecting hashes during entity frame creation
 *
 * During applyEntityFrame, handlers call signAsEntity() to register hashes
 * that need to be signed by the entity's validators.
 *
 * Flow:
 * 1. Initialize: env.currentFrameHashes = []
 * 2. Handlers call: signAsEntity(env, entityId, hash) for embedded objects
 * 3. After all handlers: add entityFrameHash itself
 * 4. Sort lexicographically for deterministic ordering
 * 5. Collect validator signatures
 * 6. Build hanko for each hash
 */

import type { Env } from './types';

/**
 * Register a hash that needs to be signed by entity validators
 * Called by handlers during frame creation (accountInput, j_broadcast, etc.)
 */
export function signAsEntity(env: Env, entityId: string, hash: string): void {
  if (!env.currentFrameHashes) {
    env.currentFrameHashes = [];
  }

  // Add hash if not already present (deduplication)
  if (!env.currentFrameHashes.includes(hash)) {
    env.currentFrameHashes.push(hash);
  }
}

/**
 * Finalize hash collection and sort lexicographically
 * Called after all handlers complete, before signing
 */
export function finalizeFrameHashes(env: Env, entityFrameHash: string): string[] {
  if (!env.currentFrameHashes) {
    env.currentFrameHashes = [];
  }

  // Add entity frame hash itself (index 0 after sort, usually)
  if (!env.currentFrameHashes.includes(entityFrameHash)) {
    env.currentFrameHashes.push(entityFrameHash);
  }

  // Sort lexicographically for deterministic ordering across all validators
  const sortedHashes = [...env.currentFrameHashes].sort();

  // Clear for next frame
  env.currentFrameHashes = [];

  return sortedHashes;
}

/**
 * Verify hash lists match (sanity check for Byzantine detection)
 */
export function verifyHashListsMatch(proposerHashes: string[], myHashes: string[]): boolean {
  if (proposerHashes.length !== myHashes.length) {
    return false;
  }

  // Both should be sorted already, but sort to be safe
  const sorted1 = [...proposerHashes].sort();
  const sorted2 = [...myHashes].sort();

  for (let i = 0; i < sorted1.length; i++) {
    if (sorted1[i] !== sorted2[i]) {
      return false;
    }
  }

  return true;
}
