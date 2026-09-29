// Provenance for value-COLLAPSING ops — the canonical home for `string-append` /
// `join` lineage.
//
// Most ops preserve structure, so provenance rides along for free: `cons`/`list`
// keep each element an `AValue` member the trace can still walk, and value→value
// ops stamp via `withInputProvenance` (AValue.ts). The COLLAPSING ops are the
// exception: `string-append` and `join` fold a (possibly nested) structure of
// inference-stamped values down to ONE flat string, destroying the members the
// trace would otherwise walk. Without re-stamping, a prompt hole fed by
// `(join "\n" (map :reaction personas))` shows NO edge back to any persona —
// field-to-field wiring silently breaks, and the provenance graph sift/MCP stand
// on loses granularity it cannot recover.
//
// `collapseProvenance` is the sound fix: DEEP-walk the inputs and union the
// EXISTING point ids of every reachable `AValue` (never minting fresh ids, so it
// stays idempotent under loop accumulation). It must be COMPLETE over the
// structured carriers — a gap is a silent provenance hole:
//   • `APair`       — list spines (`car`/`cdr`)
//   • `AVector`     — elements (the vector itself does NOT stamp from its members)
//   • `AJSArray`— the lazy JS-array wrapper's `source` (the wrapper is NOT an
//                      AValue, so its elements are invisible to a flat union)
//   • raw JS `Array`— elements
// A value's OWN provenance is collected for ANY `AValue` (so a bare AString
// input carries its lineage). Foreign-object (`AJSObject`) MEMBERS are not
// walked — a dict's own point is collected, but stringifying a dict directly is
// not a wiring path; access a member first.

// ─── WHY THIS MODULE DISPATCHES ON A TERM, NOT ON `instanceof` (P7) ──────────────────────────
//
// Dispatch on the `arrival/provenanceChildren` term, never `instanceof APair / AVector / AJSArray`.
// Two reasons, one fatal:
//
//   • ASYMMETRY. The classes ALREADY own child-enumeration for the WRITE direction —
//     `withProvenanceDeep` / `reStampChild` walk exactly these children to re-stamp them. P7: the
//     class is the sole authority on its own representation, so `arrival/provenanceChildren` is the
//     read-side twin and the two cannot drift. An outside `instanceof` walk re-derives the same
//     fact from a second place and drifts.
//
//   • A MODULE-INIT CYCLE — the fatal one. `AJSArrayList` (the borrowed array's spine chart)
//     `extends APair` — pair-ness is nominal in this tree — so APair is required AT ITS
//     CLASS-DEFINITION TIME. APair imports collapseProvenance; an `instanceof` walk here importing
//     AVector/AJSArray (which construct the view) closes the loop
//     APair → provenance-collapse → AVector → AJSArrayList → `extends APair` (undefined). Term
//     dispatch makes this module a LEAF (AValue + AString only), so the cycle is gone
//     STRUCTURALLY — not deferred behind a lazy import that would re-arm the same trap later.
//
// The completeness requirement lives where it can be checked: a carrier that reaches AValues must
// answer `arrival/provenanceChildren`, or its members are invisible here and the wiring silently
// loses an edge. (AJSObject deliberately answers nothing — a dict's own point is collected, but
// stringifying a dict is not a wiring path; access a member first.)

import { AString } from "../values/primitives/AString.js";
import { AValue } from "../values/primitives/AValue.js";

/** Union the provenance point-ids of every AValue reachable in `vals`, deep-walking
 *  the structured carriers (list spines, vectors, arrays) via their own
 *  `arrival/provenanceChildren` term. Idempotent: only existing ids, never fresh ones. */
export function collapseProvenance(...vals: unknown[]): Set<number> {
  const acc = new Set<number>();
  const seen = new Set<unknown>();
  const walk = (v: unknown): void => {
    if (v === null || typeof v !== "object" || seen.has(v)) return;
    seen.add(v);
    if (v instanceof AValue) {
      for (const p of v.provenance) acc.add(p);
      for (const child of v["arrival/provenanceChildren"]()) walk(child);
    } else if (Array.isArray(v)) {
      // A raw JS array is a carrier too (args vectors, ellipsis machinery) and is not an AValue,
      // so it has no term to answer with — it stays a structural arm.
      for (const el of v) walk(el);
    }
  };
  for (const v of vals) walk(v);
  return acc;
}

/** Re-stamp a collapsed string with provenance. Always the boxed AString (the scheme face —
 *  Face split); never a bare string, which would drop the provenance just unioned. */
export function taintString(result: string, prov: Set<number>): AString {
  return new AString(result, prov);
}
