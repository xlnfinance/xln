// The world as draws see it: the Accounts, pairs and inputs every area's draws build on.
import { batchOpCount, isBatchEmpty, J_BATCH_CONTRACT_LIMITS } from "../../../core/jurisdiction/machine/batch/index.ts";
import { getReserveCandidateIssue } from "../../../core/entity/tx/handlers/j-batch/j-batch-reserve-admission.ts";
import type { World } from "../world.ts";
import type { EntityTx } from "../../xln.ts";
import type { Step } from "./areas.ts";

export const PARTIES = [0, 1, 2, 3] as const;
export const pairs = (w: World): readonly (readonly [number, number])[] =>
  PARTIES.flatMap((x) => PARTIES.filter((y) => y !== x && w.hasAccount(x, y)).map((y) => [x, y] as const));
/** An Account both sides still trade on: not frozen by a dispute. */
export const active = (w: World, x: number, y: number): boolean =>
  w.hasAccount(x, y) && (w.ogAccount(x, y)?.status ?? "active") === "active";
export const activePairs = (w: World) => pairs(w).filter(([x, y]) => active(w, x, y) && active(w, y, x));
export const pick = <T>(w: World, xs: readonly T[]): T => xs[w.ri(xs.length)]!;
export const amount = (w: World, max: number): bigint => BigInt(1 + w.ri(max));
export const one = (w: World, entity: number, txs: readonly EntityTx[]): Step => ({ runtimeTxs: [], users: [w.user(entity, txs)] });
export const tx = (type: string, data: unknown): EntityTx => ({ type, data }) as unknown as EntityTx;
/** og isLeftEntity: the lexicographically smaller Entity id is left. */
export const isLeft = (w: World, x: number, y: number): boolean => w.ids[x]! < w.ids[y]!;
/** og's Account replica as draws read it: the mempool, the frame in flight, and the state an area narrows. */
export type OgAccountReplica = {
  mempool?: { type: string }[];
  pendingFrame?: { accountTxs: { type: string }[] };
  state?: unknown;
};
export const replica = (w: World, x: number, y: number): OgAccountReplica | undefined => w.ogAccount(x, y) as never;
/**
 * Neither side has Account work in flight: a draw reads committed state, and a frame applies routed Account inputs
 * before user txs, so an in-flight frame could sign or replace what the tx reads (og then throws, a halt).
 */
export const quiet = (w: World, x: number, y: number): boolean =>
  [replica(w, x, y), replica(w, y, x)].every((r) => r?.pendingFrame == null && (r?.mempool ?? []).length === 0);
export const sealed = (w: World, x: number): boolean => w.batchOf(x)?.sentBatch !== undefined;
export const queued = (w: World, x: number): boolean => {
  const batch = w.batchOf(x)?.batch;
  return batch !== undefined && !isBatchEmpty(batch as never);
};
/**
 * og requireBatchRoom: Entity x's draft batch takes `ops` more ops within J_BATCH_CONTRACT_LIMITS.maxTotalOps; beyond
 * it og throws J_BATCH_LIMIT_EXCEEDED, a halt. Every draw that queues a batch op guards on it; a per-array limit
 * (og requireArrayRoom) is the drawing area's own guard.
 */
export const batchRoom = (w: World, x: number, ops = 1): boolean => {
  const batch = w.batchOf(x)?.batch;
  return batch === undefined || batchOpCount(batch as never) + ops <= J_BATCH_CONTRACT_LIMITS.maxTotalOps;
};
/** A reserve op og's admission reads: the candidate og getReserveCandidateIssue appends to the draft batch. */
export type ReserveCandidate = Parameters<typeof getReserveCandidateIssue>[1];
/**
 * og getReserveCandidateIssue (entity/tx/handlers/j-batch/j-batch-reserve-admission.ts:68) over og's committed state:
 * the candidate fits beside the ops already in the draft batch and the open outgoing debts. The raw reserve is not
 * enough; og r2r and r2e throw on this check, a halt.
 */
export const reserveAdmits = (w: World, x: number, candidate: ReserveCandidate): boolean => {
  const state = w.ogState(x);
  return state !== undefined && getReserveCandidateIssue(state as never, candidate) === null;
};
