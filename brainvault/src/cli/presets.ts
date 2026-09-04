/**
 * User-facing BrainVault V1 work presets.
 *
 * These levels select an exact shard count. They never replace or renumber the
 * frozen factor that is committed into the V1 root. Exact and legacy recovery
 * remain available through --shards and --factor respectively.
 */

export const BRAINVAULT_LEVEL_SHARDS = Object.freeze([
  1,
  100,
  1_000,
  10_000,
  100_000,
  1_000_000,
] as const);

export const BRAINVAULT_DEFAULT_LEVEL = 4;
export const BRAINVAULT_PRIMARY_LEVELS = Object.freeze([4, 5, 6] as const);
export const BRAINVAULT_LEVEL_NAMES = Object.freeze([
  'test',
  'unsafe',
  'quick',
  'standard',
  'hard',
  'million',
] as const);

export function getShardCountForLevel(level: number): number {
  if (!Number.isSafeInteger(level) || level < 1 || level > BRAINVAULT_LEVEL_SHARDS.length) {
    throw new Error(`BRAINVAULT_LEVEL_INVALID:${level}`);
  }
  return BRAINVAULT_LEVEL_SHARDS[level - 1]!;
}
