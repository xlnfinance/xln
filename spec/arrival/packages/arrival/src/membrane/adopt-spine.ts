// Spine ADOPTION — the transition that gives a borrowed array its list chart.
//
// Law: THE CONSUMER'S CONTRACT SELECTS THE CHART (APair.ts AJSArrayList header).
// A verb that declares z.listAlike is saying "I read my argument as a spine", and
// adoption honors that — hands the body an AJSArrayList view over the SAME backing
// array, SAME provenance. No copy, no codec, O(1).
//
// NOT a plane crossing. z.decode is scheme → JS (right for symbol.rosetta, whose
// impl wants JS values). It is wrong here: symbol.define's bake runs
// `if (def.validate) z.decode(def.in, args)` and THROWS THE RESULT AWAY — a scheme
// body must never receive a JS-marshalled value; symbol.native doesn't decode at all.
// A z.codec on the list schema would compute an eager APair copy of every tool array
// on every call and discard it, while the raw array sailed through to the body and
// hung it. Adoption is a REPRESENTATION choice on the SCHEME plane (AValue in,
// AValue out) — never routed through a plane crossing.
//
// MUST HAPPEN BEFORE THE IMPL, NOT INSIDE IT. Several native impls FIELD-READ their
// list argument (findImpl does list.car / list.cdr directly — srfi-1.ts). A borrowed
// array has no such member, so it read undefined, boxed to AVoid, and handed the
// predicate a void: (find even? (some-tool …)) THREW on every tool array. Term-level
// tolerance never reaches that class of consumer — only handing the impl a real
// APair subclass can, which is what adopting at the argument boundary does.

import { isSpineAdopting } from "../common/spine-adoption.js";
import type { DecodedArgsWithRest, RestSpec, VectorSpec } from "../common/symbols/_bake.js";
import { AJSArray } from "./AJSArray.js";
import { AJSArrayList } from "../values/primitives/APair.js";
import type { ANil } from "../values/primitives/ANil.js";
import type { SchemeValue } from "../values/types.js";

/**
 * Project one argument onto its spine chart, if it is a vector-chart value.
 * Everything else — a genuine pair, nil, or any non-list value the contract also
 * admits — passes through UNTOUCHED and by identity.
 *
 * Empty array adopts to nil, not to an empty view: null? is instanceof ANil
 * (hard-wired, not a term), so an empty container that stays a container can NEVER
 * terminate a scheme list walk. AJSArrayList.at decides this at mint.
 *
 * ONLY the borrowed array adopts — not AVector. Rejected alternative (adopting
 * genuine AVector too) fails twice:
 *   1. HYGIENE (docs/membrane.md §HYGIENE) — AVector.__vector__ holds ALREADY-BOXED
 *      AValues; a raw-JS-backed view would put both worlds through one slot and
 *      re-stamp every element's lineage. boxElement's invariant makes that
 *      impossible to reintroduce quietly.
 *   2. FAITHFULNESS — would widen (delete-duplicates #(1 2 1)) from an honest
 *      contract rejection into a silent success. A vector is not a list (R7RS); use
 *      (vector->list v) for the explicit, tracked way across.
 */
export function adoptSpine(v: AJSArray): AJSArrayList | ANil;
export function adoptSpine<T>(v: T): T;
export function adoptSpine(v: unknown): unknown {
  if (v instanceof AJSArray) return AJSArrayList.at(v, 0);
  return v;
}

/**
 * Precompute the per-slot adopter for a contract at BAKE time — call path pays nothing
 * for a verb with no list slots (common case); a verb that does pays one instanceof
 * per marked slot.
 *
 * Returns undefined when no slot adopts — bake sites skip the wrapper entirely.
 *
 * restSchema covers the variadic tail (for-each's inputRest), where EVERY trailing
 * argument is a list and each adopts independently.
 *
 * Incoming args are raw SchemeValues (a `z.listAlike` slot may still hold AJSArray).
 * The result is the impl's scheme-face tuple — `z.listAlike` is AListAlike after this
 * runs. Whether any slot adopts is a runtime WeakSet check, so the return stays
 * `| undefined`; the type cannot see the mark.
 *
 * `AdoptedArgs` keeps a concrete tuple when it is already SchemeValues, and falls
 * back to `SchemeValue[]` when `I`/`Rest` are still the wide VectorSpec bounds
 * (define's erased factory body).
 */
export type AdoptedArgs<I extends VectorSpec, Rest extends RestSpec = undefined> =
  DecodedArgsWithRest<I, Rest, "scheme"> extends infer T
    ? T extends readonly SchemeValue[]
      ? T
      : SchemeValue[]
    : SchemeValue[];

export type SlotAdopter<I extends VectorSpec, Rest extends RestSpec = undefined> = (
  args: readonly SchemeValue[],
) => AdoptedArgs<I, Rest>;

export function buildSlotAdopter<const I extends VectorSpec, const Rest extends RestSpec = undefined>(
  input: I,
  inputRest?: Rest,
): SlotAdopter<I, Rest> | undefined {
  const slots: readonly unknown[] = Array.isArray(input) ? input : [];
  const adoptingSlots = slots.map(isSpineAdopting);
  const restAdopts = isSpineAdopting(inputRest);
  if (!adoptingSlots.some(Boolean) && !restAdopts) return undefined;

  return (args) =>
    args.map((arg, i) => {
      const adopts = i < adoptingSlots.length ? adoptingSlots[i] : restAdopts;
      return adopts ? adoptSpine(arg) : arg;
      // `.map` erases the per-slot tuple; the contract is SlotAdopter's return.
    }) as AdoptedArgs<I, Rest>;
}
