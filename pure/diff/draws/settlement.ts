// Settlement draws (og entity/tx/handlers/payments/settle.ts). Owner: thread "Independent review of main".
import { drawn, type Moves, type WorldMoves } from "./areas.ts";
import { activePairs, pick, one, tx, isLeft, sealed, replica, quiet } from "./world-view.ts";
import type { World } from "../world.ts";
import type { SettlementOp } from "../../xln.ts";
import { getSignedSettlementWorkspaceTxError } from "../../../core/account/tx/handlers/settlement/transition.ts";

// ---- settlement workspace (og entity/tx/handlers/payments/settle.ts) ----

type OgWorkspace = {
  workspaceHash: string;
  status: string;
  lastModifiedByLeft: boolean;
  executorIsLeft: boolean;
  postSettlementDisputeProof?: { leftHanko?: string; rightHanko?: string };
};
type SettledState = {
  settlementWorkspace?: OgWorkspace & { leftHanko?: string; rightHanko?: string; settlementHash?: string };
};
const workspace = (w: World, x: number, y: number) =>
  (replica(w, x, y)?.state as SettledState | undefined)?.settlementWorkspace;
const unsigned = (w: World, x: number, y: number): boolean => {
  const ws = workspace(w, x, y);
  return ws !== undefined && ws.leftHanko === undefined && ws.rightHanko === undefined && ws.settlementHash === undefined;
};
/** The Account's token-1 collateral as og holds it. */
const collateral = (w: World, x: number, y: number): bigint =>
  (w.ogAccount(x, y) as { state?: { deltas?: Map<number, { collateral: bigint }> } } | undefined)
    ?.state?.deltas?.get(1)?.collateral ?? 0n;
/**
 * Ops og's compileOps accepts: an r2c within the proposer's reserve, a c2r within the collateral (beyond it the
 * receiver throws SETTLEMENT_PROJECTED_COLLATERAL_RANGE, a halt), a forgive.
 */
const settleOps = (w: World, x: number, y: number): readonly SettlementOp[] => {
  const reserve = w.reserveOf(x);
  const held = collateral(w, x, y);
  const r2c: readonly SettlementOp[] = reserve > 0n ? [{ type: "r2c", tokenId: 1, amount: 1n + (reserve * BigInt(w.ri(50))) / 100n }] : [];
  const c2r: readonly SettlementOp[] = held > 0n ? [{ type: "c2r", tokenId: 1, amount: 1n + (held * BigInt(w.ri(90))) / 100n }] : [];
  const choices: readonly (readonly SettlementOp[])[] = [
    r2c,
    c2r,
    [{ type: "forgive", tokenId: 1 }],
    [...r2c, { type: "forgive", tokenId: 1 }],
  ];
  const drawn = pick(w, choices);
  return drawn.length > 0 ? drawn : [{ type: "forgive", tokenId: 1 }];
};
/** Every tx in this side's Account mempool is one og getSignedSettlementWorkspaceTxError freezes. */
const allFrozen = (w: World, x: number, y: number): boolean => {
  const account = w.ogAccount(x, y);
  const mempool = replica(w, x, y)?.mempool ?? [];
  return mempool.every((t) => getSignedSettlementWorkspaceTxError(account as never, t as never) !== undefined);
};
/**
 * quiet, except that txs og froze behind a signed workspace may wait in the mempools. og
 * accountHasProposableMempoolForEntity never proposes them, so no frame is in flight and nothing can sign or replace
 * the workspace; only settle_execute (its submit transition is exempt) and the J result unfreeze the Account. Asking
 * for empty mempools here deadlocked the walk: any payment drawn after the workspace was signed parked forever.
 */
const settledQuiet = (w: World, x: number, y: number): boolean =>
  [replica(w, x, y), replica(w, y, x)].every((r) => r?.pendingFrame == null) && allFrozen(w, x, y) && allFrozen(w, y, x);
const withWorkspace = (w: World, pred: (x: number, y: number, ws: OgWorkspace) => boolean) =>
  activePairs(w).filter(([x, y]) => {
    const ws = workspace(w, x, y);
    return ws !== undefined && settledQuiet(w, x, y) && pred(x, y, ws);
  });

/**
 * og buildSettlementHankoDraft: the side that did not last modify an unsubmitted workspace signs it, once (a second
 * approval throws SETTLEMENT_SIDE_HANKO_ALREADY_ATTACHED, a halt).
 */
const approvable = (w: World) => (x: number, y: number, ws: OgWorkspace): boolean => {
  const own = isLeft(w, x, y) ? ws.postSettlementDisputeProof?.leftHanko : ws.postSettlementDisputeProof?.rightHanko;
  return ws.status !== "submitted" && ws.lastModifiedByLeft !== isLeft(w, x, y) && own === undefined;
};

export const SETTLEMENT: Moves<"settlement"> = {
  settle_propose: drawn(
    (w) => activePairs(w).some(([x, y]) => workspace(w, x, y) === undefined && quiet(w, x, y)),
    (w) => {
      const [x, y] = pick(w, activePairs(w).filter(([x, y]) => workspace(w, x, y) === undefined && quiet(w, x, y)));
      return one(w, x, [tx("settle_propose", { counterpartyEntityId: w.ids[y], ops: settleOps(w, x, y), memo: `m${w.ri(100)}` })]);
    },
  ),
  settle_update: drawn(
    (w) => withWorkspace(w, (x, y) => unsigned(w, x, y)).length > 0,
    (w) => {
      const [x, y] = pick(w, withWorkspace(w, (x, y) => unsigned(w, x, y)));
      return one(w, x, [tx("settle_update", { counterpartyEntityId: w.ids[y], ops: settleOps(w, x, y) })]);
    },
  ),
  settle_approve: drawn(
    (w) => withWorkspace(w, approvable(w)).length > 0,
    (w) => {
      const [x, y] = pick(w, withWorkspace(w, approvable(w)));
      return one(w, x, [tx("settle_approve", { counterpartyEntityId: w.ids[y], workspaceHash: workspace(w, x, y)!.workspaceHash })]);
    },
  ),
  settle_execute: drawn(
    (w) => withWorkspace(w, (x, y, ws) => ws.status === "ready_to_submit" && ws.executorIsLeft === isLeft(w, x, y)
      && !sealed(w, x)).length > 0,
    (w) => {
      const [x, y] = pick(w, withWorkspace(w, (x, y, ws) => ws.status === "ready_to_submit"
        && ws.executorIsLeft === isLeft(w, x, y) && !sealed(w, x)));
      return one(w, x, [tx("settle_execute", { counterpartyEntityId: w.ids[y] })]);
    },
  ),
  settle_reject: drawn(
    (w) => withWorkspace(w, (x, y) => unsigned(w, x, y)).length > 0,
    (w) => {
      const [x, y] = pick(w, withWorkspace(w, (x, y) => unsigned(w, x, y)));
      return one(w, x, [tx("settle_reject", { counterpartyEntityId: w.ids[y], reason: "walk" })]);
    },
  ),
};

/** World moves: none yet. */
export const SETTLEMENT_WORLD: WorldMoves = {};
