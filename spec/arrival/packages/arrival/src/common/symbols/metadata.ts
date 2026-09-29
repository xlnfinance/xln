// metadata — read-time resolver for a symbol's metadata extension bag. Canonical home for
// the describe-time read channel (docs/environments.md §DESCRIBE-TIME).
//
// DESCRIBE-TIME READ CHANNEL:
// 1. LAZY AT READ against phase-2 activation — never at bake. Touching this.resources.x.live
//    spawns on first read (connection-storm if resolved at assembly).
// 2. PER-READ, NO MEMO — matches McpAnnotation semantics; author owns staleness inside the fn.
// 3. undefined RESOLUTION = omit key, do NOT flag dynamic — consumer falls back to static sibling.
//
// Provenance: describe-time host-side IO, outside every wire. Scheme never sees metadata.

import type { Activation } from "../capability.js";
import type { MetadataRecord } from "./_bake.js";

export interface ResolvedMetadata {
  readonly resolved: Record<string, unknown>;
  readonly dynamicKeys: readonly string[];
}

/** Resolve fn-valued fields against activation. Discriminant: typeof === "function".
 *  Throwing dynamic fields propagate — honest failure is returning undefined. */
export async function resolveMetadata(
  metadata: MetadataRecord | undefined,
  activation: Activation<any, any>,
): Promise<ResolvedMetadata> {
  const resolved: Record<string, unknown> = {};
  const dynamicKeys: string[] = [];
  if (metadata === undefined) return { resolved, dynamicKeys };
  for (const [key, field] of Object.entries(metadata)) {
    if (typeof field === "function") {
      const value = await (field as (this: Activation<any, any>) => unknown).call(activation);
      if (value !== undefined) {
        resolved[key] = value;
        dynamicKeys.push(key);
      }
      // undefined ⇒ ruling 3: omit, do not flag dynamic
    } else {
      resolved[key] = field;
    }
  }
  return { resolved, dynamicKeys };
}

/** Static subset — total at module load, zero assembly. Fn-valued fields absent. */
export function staticMetadata(metadata: MetadataRecord | undefined): Record<string, unknown> {
  return Object.fromEntries(Object.entries(metadata ?? {}).filter(([, v]) => typeof v !== "function"));
}
