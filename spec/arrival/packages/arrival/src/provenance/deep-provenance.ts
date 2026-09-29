/**
 * Union of `.provenance` over every AValue reachable from a scheme value —
 * the value itself, Pair car/cdr spines, SchemeVector / plain-array elements.
 * List construction leaves spine provenance empty; origins live on elements —
 * a shallow top-level read returns ∅ for packed lists/vectors. Cycle-guarded.
 *
 * Shared by rosetta `argProvenance` and lineage-auto-bindings leaf-stamps —
 * same reachability the eager stamp union walks. Values-layer leaf only
 * (no import cycle into carrier modules).
 */
import { AValue } from "../values/primitives/AValue.js";
import { AVector } from "../values/primitives/AVector.js";
import { APair } from "../values/primitives/APair.js";

export function deepProvenance(value: unknown): ReadonlySet<number> {
  const acc = new Set<number>();
  const seen = new Set<unknown>();
  const walk = (v: unknown): void => {
    if (v === null || typeof v !== "object") return;
    if (seen.has(v)) return;
    seen.add(v);
    if (v instanceof AValue) {
      for (const p of v.provenance) acc.add(p);
      if (v instanceof APair) {
        walk(v.car);
        walk(v.cdr);
      } else if (v instanceof AVector) {
        for (const el of v.__vector__) walk(el);
      }
    } else if (Array.isArray(v)) {
      for (const el of v) walk(el);
    }
  };
  walk(value);
  return acc;
}
