// The properties that judge every committed frame (P2 and P4 over the Runtime, P-BELIEF over the chain), composed once so the walk's loop and
// the capacity probe after it judge a frame the same way. What the checks looked at goes into the walk's coverage (rig/properties/fired.ts).
import type { Runtime } from "../../xln.ts";
import { checkBelief, NOTHING_SEEN, type Trail } from "./properties/belief.ts";
import { vmOf } from "./properties/enforce.ts";
import { checkProperties, NOTHING_SIGNED, type Signed } from "./properties/properties.ts";
import type { World } from "./world.ts";

/** What the next frame's checks need of the last ones: the proofs signed so far (P4) and each Account's chain trail (P-BELIEF). */
export type Memory = Readonly<{ signed: Signed; trail: Trail }>;
export const NO_MEMORY: Memory = { signed: NOTHING_SIGNED, trail: NOTHING_SEEN };

/** A fault a test plants in the Runtime the properties read (never in the lane's own, so the lane still agrees): `frame` is the frame just committed. */
export type Plant = (rt: Runtime, frame: number) => Runtime;

export type Framed = Readonly<{ violations: readonly string[]; memory: Memory }>;

/** The lines a walk prints for a frame whose checks failed, and the memory the next frame judges against. */
export const judgeFrame = async (
  w: Pick<World, "tag" | "lane" | "coverage" | "chain" | "settled">,
  name: string,
  memory: Memory,
  plant?: Plant,
): Promise<Framed> => {
  const frame = w.lane.frames();
  const rt = plant === undefined ? w.lane.runtime() : plant(w.lane.runtime(), frame);
  const checked = checkProperties(rt, memory.signed);
  const believed = await checkBelief(vmOf(w as World), rt, memory.trail, w.settled);
  const bump = (counter: string, by: number): void => { w.coverage.actions[counter] = (w.coverage.actions[counter] ?? 0) + by; };
  bump("P2:ledgers", checked.looked.ledgers);
  bump("P4:heightPairs", checked.looked.heightPairs);
  w.coverage.actions["P4:signatures"] = checked.looked.signatures;
  w.coverage.actions["P-BELIEF:accounts"] = believed.trail.size;
  return {
    violations: [...checked.violations, ...believed.violations].map((v) => `${w.tag} frame ${frame} ${name}: ${v}`),
    memory: { signed: checked.signed, trail: believed.trail },
  };
};
