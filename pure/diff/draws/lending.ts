// Lending draws. Owner: the "lending" area thread.
import { pending, type Moves, type WorldMoves } from "./areas.ts";

export const LENDING: Moves<"lending"> = {
  lendingOffer: pending("a hub lending book"),
  lendingBorrow: pending("a lending offer"),
  lendingRepay: pending("an active loan"),
  lendingClosePosition: pending("an idle lending position"),
};

/** World moves: none yet. */
export const LENDING_WORLD: WorldMoves = {};
