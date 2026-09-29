/**
 * path-algebra — channel-neutral pure vocabulary for resource paths.
 *
 * Every channel may import this file; it imports nothing but types (no runtime
 * dependency on any channel, journal, or door). Split out of resource-paths.ts
 * (hermeticity audit P1) because sibling channels (read-guard.ts) value-import
 * a subset of this algebra while resource-paths.ts is ALSO the resourcePaths
 * channel proper (journal, door, CQS apply) — this file is the shared half,
 * not the channel.
 *
 * A resource path is a segment tuple (e.g. `["db","projects",id]`). Overlap is
 * segment-wise prefix either direction — not string-join.
 */

/** One named domain location — ordered segments. Empty tuples are out of generators. */
export type ResourcePath = readonly string[];

/** Segment-wise prefix overlap either direction. Empty path never overlaps. */
export function pathsOverlap(a: ResourcePath, b: ResourcePath): boolean {
  if (a.length === 0 || b.length === 0) return false;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/** Any-pair multi-set overlap (door fuel). */
export function anyPathOverlap(priorEffects: readonly ResourcePath[], thisQueries: readonly ResourcePath[]): boolean {
  return findOverlappingPair(priorEffects, thisQueries) !== undefined;
}

/** First overlapping (priorE, thisQ) pair, if any — classic door discriminator payload. */
export function findOverlappingPair(
  priorEffects: readonly ResourcePath[],
  thisQueries: readonly ResourcePath[],
): { priorEffect: ResourcePath; thisQuery: ResourcePath } | undefined {
  for (const priorEffect of priorEffects) {
    for (const thisQuery of thisQueries) {
      if (pathsOverlap(priorEffect, thisQuery)) {
        return { priorEffect, thisQuery };
      }
    }
  }
  return undefined;
}

/**
 * Serialize one resource path to a host footprint key (Phase 4).
 * JSON-escapes each segment and joins with `/` so keys are equality-stable and
 * round-trip display-safe (e.g. `["db","projects","a/b"]` → `"db"/"projects"/"a/b"`).
 * Empty path → `"[]"`. Same encoding as door error messages — one vocabulary for
 * read-guard write-sets, confirm-manifest rows, and (later) path-keyed atoms.
 */
export function serializeResourcePath(path: ResourcePath): string {
  return path.length === 0 ? "[]" : path.map((s) => JSON.stringify(s)).join("/");
}
