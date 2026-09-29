// Who draws what: every Entity tx kind belongs to exactly one area. The table is typed by the rewrite's EntityTx union,
// so a new kind without an area is a tsc error, and each area's draws file (draws/<area>.ts) is typed by exactly the
// kinds this table gives it, so a missing or foreign kind there is a tsc error too. review/walk-areas.md says why.
import type { EntityTx, RuntimeTx } from "../../xln.ts";
import type { World } from "../world.ts";
import type { User } from "../lane.ts";

export type Kind = EntityTx["type"];
export const AREAS = ["core", "settlement", "orderbook", "lending", "boards", "disputes"] as const;
export type Area = (typeof AREAS)[number];

export const AREA = {
  openAccount: "core",
  extendCredit: "core",
  directPayment: "core",
  htlcPayment: "core",
  r2c: "core",
  r2r: "core",
  j_broadcast: "core",
  chat: "core",
  chatMessage: "core",
  "profile-update": "core",
  setHubConfig: "core",
  setRebalancePolicy: "core",
  requestCollateral: "core",
  j_rebroadcast: "core",
  j_abort_sent_batch: "core",
  j_clear_batch: "core",
  e2r: "core",
  mintReserves: "core",
  accountInput: "core",
  entityCommand: "core",
  j_event: "core",
  runtimeOutput: "core",
  scheduledWake: "core",
  proposeAccountsNow: "core",
  processHtlcTimeouts: "core",
  resolveHtlcLock: "core",
  settle_propose: "settlement",
  settle_update: "settlement",
  settle_approve: "settlement",
  settle_execute: "settlement",
  settle_reject: "settlement",
  initOrderbookExt: "orderbook",
  placeSwapOffer: "orderbook",
  proposeCancelSwap: "orderbook",
  prepareCrossJurisdictionSwap: "orderbook",
  requestCrossJurisdictionClear: "orderbook",
  registerCrossJurisdictionSwap: "orderbook",
  materializeCrossJurisdictionSwap: "orderbook",
  materializeCrossJurisdictionClear: "orderbook",
  admitCrossJurisdictionBookOrder: "orderbook",
  removeCrossJurisdictionBookOrder: "orderbook",
  crossJurisdictionBookOrderRemoved: "orderbook",
  crossJurisdictionFillNotice: "orderbook",
  orderbookSweepCrossJurisdiction: "orderbook",
  crossPullClose: "orderbook",
  lendingOffer: "lending",
  lendingBorrow: "lending",
  lendingRepay: "lending",
  lendingClosePosition: "lending",
  propose: "boards",
  vote: "boards",
  boardHandover: "boards",
  r2e: "boards",
  entityProviderTransfer: "boards",
  entityProviderProposeControlBoard: "boards",
  entityProviderActivateBoard: "boards",
  entityProviderCancelAction: "boards",
  entityProviderReleaseControlShares: "boards",
  prepareDispute: "disputes",
  disputeStart: "disputes",
  disputeFinalize: "disputes",
  crossJurisdictionForceSiblingDispute: "disputes",
  crossJurisdictionSalvage: "disputes",
} as const satisfies { readonly [K in Kind]: Area };

/** The kinds one area draws. */
export type KindsOf<A extends Area> = { readonly [K in Kind]: (typeof AREA)[K] extends A ? K : never }[Kind];

/** What one frame of the walk hands the lane. */
export type Step = { readonly runtimeTxs: readonly RuntimeTx[]; readonly users: readonly User[] };
/**
 * drawn   - the walk can author it: `enabled` reads og's committed state (the lane keeps both sides' roots equal, so it
 *           holds for the rewrite too) and `draw` builds a valid input from it;
 * arises  - only og's own machinery emits it (routing, the J watcher, hooks); the walk reaches it through others;
 * pending - not drawn yet, with what drawing it needs.
 */
export type Move =
  | { readonly _tag: "drawn"; readonly enabled: (w: World) => boolean; readonly draw: (w: World) => Step }
  | { readonly _tag: "arises"; readonly via: string }
  | { readonly _tag: "pending"; readonly needs: string };
/**
 * A move on the world itself, not an Entity tx (the chain funds a reserve, the clock jumps to a deadline). The walk
 * takes one when it draws no Entity tx.
 *
 * `owed` marks a move that closes a lifecycle the area's draws opened (a dispute waits for its deadline): while it holds
 * the walk does not stop at its frame floor, takes the move as soon as it is enabled, and fails if the lifecycle is
 * still open when the walk's frame cap ends it.
 */
export type WorldMove = {
  readonly enabled: (w: World) => boolean;
  readonly draw: (w: World) => Step | Promise<Step>;
  readonly owed?: (w: World) => boolean;
};
/** One area's world moves, by name (`{}` when it has none). */
export type WorldMoves = Readonly<Record<string, WorldMove>>;
/** One area's rows: exactly its kinds. */
export type Moves<A extends Area> = { readonly [K in KindsOf<A>]: Move };

export const drawn = (enabled: (w: World) => boolean, draw: (w: World) => Step): Move => ({ _tag: "drawn", enabled, draw });
export const arises = (via: string): Move => ({ _tag: "arises", via });
export const pending = (needs: string): Move => ({ _tag: "pending", needs });
