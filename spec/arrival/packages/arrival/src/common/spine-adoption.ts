// The spine-adoption REGISTRY — deliberately a LEAF (zero imports).
//
// It records which contract schemas mean "I want the SPINE reading of my argument". That is all it
// does. The adopter that acts on the mark lives in `values/adopt-spine.ts`, because acting requires
// the value classes, and this module must be importable from `scheme-zod.ts` — which `AValue`
// itself imports. Fusing the two would close the cycle
// (scheme-zod → adopt → AJSArrayList → APair → AValue → scheme-zod) and nothing would load.
//
// docs/environments.md §CONTRACT — the MARK-is-data / ADOPTION-is-behavior split here is the governing
// chart-vs-crossing law one layer down: the contract picks the chart, and is not the thing that
// performs the crossing.

/** Schemas whose argument slots take the spine reading. Identity-keyed: `z.listAlike` is ONE
 *  shared instance (scheme-zod), so a slot adopts iff it is literally that schema. */
const SPINE_ADOPTING = new WeakSet<object>();

/** Mark a schema as spine-adopting. Returns it unchanged, so it composes inline at its
 *  definition site: `export const listAlike = markSpineAdopting(z.union([...]))`. */
export function markSpineAdopting<T extends object>(schema: T): T {
  SPINE_ADOPTING.add(schema);
  return schema;
}

export function isSpineAdopting(schema: unknown): boolean {
  return typeof schema === "object" && schema !== null && SPINE_ADOPTING.has(schema);
}
