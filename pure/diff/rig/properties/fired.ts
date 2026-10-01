// A property that applies to an area has to fire in that area's walks: one that looks at nothing (P1 skipped on every seed, no Account holds a signature)
// is the zero-moves trap again, and a green walk then says nothing about it. Each property names the counters its checks leave in `coverage.actions`;
// the walks of one area, taken together, must raise each of them. An area a property cannot reach is listed in NOT_APPLICABLE with the reason.
import type { Area } from "../../draws/areas.ts";

/** What each property counts when it looks at something. */
export const COUNTERS = {
  P1: ["P1:checked"],
  P2: ["P2:ledgers", "P2:probeDirect", "P2:probeLock", "P2:probeHoldSame", "P2:probeHold"],
  P4: ["P4:signatures", "P4:heightPairs"],
  "P-BELIEF": ["P-BELIEF:accounts", "P-BELIEF:atRest"],
} as const;
export type Property = keyof typeof COUNTERS;
export const PROPERTY_NAMES = Object.keys(COUNTERS) as readonly Property[];

/** Areas whose walks cannot fire a property, each with why. Every other (area, property) pair must fire. */
export const NOT_APPLICABLE: Readonly<Partial<Record<Area | "model", Readonly<Partial<Record<Property, string>>>>>> = {};

/** The properties one area's walks never fired, as red lines; `runs` holds each walk's `coverage.actions`. */
export const unfired = (area: Area | "model", runs: readonly Readonly<Record<string, number>>[]): readonly string[] => {
  const raised = (counter: string): number => runs.reduce((n, actions) => n + (actions[counter] ?? 0), 0);
  const excused = NOT_APPLICABLE[area] ?? {};
  return PROPERTY_NAMES
    .filter((property) => excused[property] === undefined)
    .flatMap((property) => {
      const silent = COUNTERS[property].filter((counter) => raised(counter) === 0);
      return silent.length === 0 ? [] : [`UNFIRED ${property} on ${area}: ${silent.join(", ")} never rose in ${runs.length} walks, so this property checked nothing there (list it in NOT_APPLICABLE with a reason only if it cannot apply)`];
    });
};
