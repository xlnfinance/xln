// Watchtower and dispute draws. Owner: the "watchtower and disputes" area thread.
import { arises, pending, type Moves, type WorldMoves } from "./areas.ts";

export const DISPUTES: Moves<"disputes"> = {
  prepareDispute: pending("a dispute freezes its Account for the rest of the run; scenario.test.ts drives the lifecycle"),
  disputeStart: pending("follows prepareDispute (og auto-drafts it)"),
  disputeFinalize: arises("the dispute deadline hook"),
  crossJurisdictionForceSiblingDispute: arises("cross-j dispute salvage"),
  crossJurisdictionSalvage: arises("cross-j dispute salvage"),
};

/** World moves: none yet. */
export const DISPUTES_WORLD: WorldMoves = {};
