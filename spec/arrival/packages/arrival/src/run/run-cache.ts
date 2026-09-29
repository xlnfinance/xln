/**
 * run-cache — the `RunCache` entity (record/replay storage) + content-keying algorithm
 * (`canonicalJson`/`runCacheKey`). A run's durable twin is `(program, cache)`; cache can
 * outlive its program and answer a re-run of a NEW program over the SAME cache
 * (content-keyed).
 *
 * The membrane INTERCEPTION itself — the composition point that reads this cache
 * alongside effects/reads/paths at the baked rosetta `run` wrapper (docs/execution.md
 * §CHOKEPOINT) — lives in `./penetration.ts` (hermeticity audit P2: this file is named
 * for one of the four channels the chokepoint composes, not the chokepoint itself).
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

export type RunCacheEntry =
  | { kind: "value"; value: unknown } // a `view` result — the decoded-face JS value,
  //   JSON-serializable by the view shape gate
  | { kind: "effect" }; // tombstone — the effect (sink) fired in a recorded run

export interface RunCache {
  /** mode governs the membrane, not storage: "record" = live run (impl fires, result
   *  written); "replay" = fold (hit answers without firing; effect tombstone skips). */
  readonly mode: "record" | "replay";
  get(key: string): Promise<RunCacheEntry | undefined>;
  set(key: string, entry: RunCacheEntry): Promise<void>;
}

/** The in-memory materialization — a `Map` with the async face (in-memory always while a run
 *  executes). `entries` is deliberately readable: the session layer serializes SETTLED entries
 *  from it, and a replay cache is constructed OVER a recorded one's entries. Mode is fixed at
 *  construction — a rehydration builds a NEW replay cache over the same entries, never flips a
 *  live one. */
export class MemoryRunCache implements RunCache {
  readonly entries: Map<string, RunCacheEntry>;

  constructor(
    readonly mode: "record" | "replay",
    entries?: Iterable<readonly [string, RunCacheEntry]>,
  ) {
    this.entries = new Map(entries);
  }

  get(key: string): Promise<RunCacheEntry | undefined> {
    return Promise.resolve(this.entries.get(key));
  }

  set(key: string, entry: RunCacheEntry): Promise<void> {
    this.entries.set(key, entry);
    return Promise.resolve();
  }
}

/**
 * NORMATIVE canonical JSON: object keys recursively SORTED; arrays order-preserving; input
 * is DECODED (post-zod) values only, so codec coercion is already normalized before keying.
 * `undefined` cannot occur (zod output) — one arriving anyway throws rather than silently
 * canonicalizing two different shapes to one text. Numbers serialize as plain JSON numbers
 * (non-finite throw). Anything JSON cannot represent (function, symbol, bigint, a non-plain
 * object — class instances, Map/Set) THROWS: a value that cannot canonicalize cannot be a
 * cache key, and the caller decides the fallback (a `pure` key failure falls back to an
 * unshared fire; a `view` key is total BY CONSTRUCTION — its shape gate admits data codecs
 * only).
 */
export function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "boolean":
    case "string":
      return JSON.stringify(value);
    case "number":
      if (!Number.isFinite(value)) {
        throw new TypeError(`canonicalJson: a non-finite number (${value}) is not JSON — it cannot key a cache entry`);
      }
      return JSON.stringify(value);
    case "undefined":
      throw new TypeError(
        "canonicalJson: `undefined` cannot occur in decoded (post-zod) values — refusing to canonicalize it away",
      );
    case "object":
      break;
    default:
      throw new TypeError(`canonicalJson: a ${typeof value} is not JSON-representable — it cannot key a cache entry`);
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => canonicalJson(v)).join(",")}]`;
  }
  const proto: unknown = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) {
    throw new TypeError(
      "canonicalJson: a non-plain object (class instance / Map / Set / …) has no canonical JSON form — it cannot key a cache entry",
    );
  }
  // UTF-16 code-unit order (JSON canonical keys) — not localeCompare, which is locale-sensitive.
  const keys = Object.keys(value as Record<string, unknown>).toSorted((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const parts = keys.map((k) => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`);
  return `{${parts.join(",")}}`;
}

/** FNV-1a over a prefixed canonical string — the codebase's content-hash idiom (prefix tag +
 *  `|`-joined canonical parts, FNV-1a, zero-padded hex). A local copy, deliberately NOT
 *  imported from the sibling hash sites (`hashSteps`, wireframe hash): different domains (a
 *  sealed env chain, a wireframe graph, this one a membrane penetration) that must be free to
 *  drift independently. */
function fnv1a(prefix: string, canonical: string): string {
  const tagged = `${prefix}|${canonical}`;
  let h = 0x81_1c_9d_c5;
  for (let i = 0; i < tagged.length; i++) {
    h ^= tagged.codePointAt(i) ?? 0;
    h = Math.imul(h, 0x01_00_01_93);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/** The content key: `hash(symbolName ‖ canonicalJson(decodedArgs))` — keyed by PENETRATION
 *  CONTENT, not by position: a NEW program shares no positions with the recorded one; only
 *  (node, args) survives program edits. Throws whatever `canonicalJson` throws — the caller
 *  owns the fallback. */
export function runCacheKey(symbolName: string, decodedArgs: readonly unknown[]): string {
  return fnv1a("runcache-v0", `${symbolName}|${canonicalJson(decodedArgs)}`);
}

/** The stamped cache class, as this module needs it — structurally identical to `_bake.ts`'s
 *  `CacheClass` but declared locally: values/ is BELOW common/ in the import DAG, so this leaf
 *  must not reach up for the type. */
export type RunCacheClass = "view" | "pure";
