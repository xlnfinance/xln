// Multi-signer boards and Entity provider action draws. Owner: the "boards and provider actions" area thread.
import { arises, pending, type Moves, type WorldMoves } from "./areas.ts";

export const BOARDS: Moves<"boards"> = {
  propose: pending("a multi-signer board"),
  vote: pending("a multi-signer board"),
  boardHandover: arises("an on-chain BoardActivated in a j_event"),
  r2e: pending("an Entity-provider receiver"),
  entityProviderTransfer: pending("an Entity provider board"),
  entityProviderProposeControlBoard: pending("an Entity provider board"),
  entityProviderActivateBoard: pending("a proposed control board"),
  entityProviderCancelAction: pending("a queued provider action"),
  entityProviderReleaseControlShares: pending("provider control shares"),
};

/** World moves: none yet. */
export const BOARDS_WORLD: WorldMoves = {};
