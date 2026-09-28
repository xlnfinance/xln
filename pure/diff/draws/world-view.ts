// The world as draws see it: the Accounts, pairs and inputs every area's draws build on.
import { isBatchEmpty } from "../../../core/jurisdiction/machine/batch/index.ts";
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
export const sealed = (w: World, x: number): boolean => w.batchOf(x)?.sentBatch !== undefined;
export const queued = (w: World, x: number): boolean => {
  const batch = w.batchOf(x)?.batch;
  return batch !== undefined && !isBatchEmpty(batch as never);
};
