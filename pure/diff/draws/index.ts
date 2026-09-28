// The whole draw table, composed from the areas. Each area's rows are typed by exactly its kinds (areas.ts), so the
// composition covers every Entity tx kind once, and WORLD is total over the areas, so an area file without its world
// moves export is a tsc error. Both lists come out sorted by name: where a row lives never changes a walk.
import { AREA, type Area, type Kind, type Move, type WorldMove, type WorldMoves } from "./areas.ts";
import { CORE, CORE_WORLD } from "./core.ts";
import { SETTLEMENT, SETTLEMENT_WORLD } from "./settlement.ts";
import { ORDERBOOK, ORDERBOOK_WORLD } from "./orderbook.ts";
import { LENDING, LENDING_WORLD } from "./lending.ts";
import { BOARDS, BOARDS_WORLD } from "./boards.ts";
import { DISPUTES, DISPUTES_WORLD } from "./disputes.ts";

export const MOVES: { readonly [K in Kind]: Move } = { ...CORE, ...SETTLEMENT, ...ORDERBOOK, ...LENDING, ...BOARDS, ...DISPUTES };
const WORLD: { readonly [A in Area]: WorldMoves } = {
  core: CORE_WORLD,
  settlement: SETTLEMENT_WORLD,
  orderbook: ORDERBOOK_WORLD,
  lending: LENDING_WORLD,
  boards: BOARDS_WORLD,
  disputes: DISPUTES_WORLD,
};

/** Which areas a walk draws from. */
export type Scope = "all" | readonly Area[];
const inScope = (scope: Scope, a: Area): boolean => scope === "all" || scope.includes(a);
const byName = <T>([a]: readonly [string, T], [b]: readonly [string, T]): number => (a < b ? -1 : a > b ? 1 : 0);

export type Drawn = readonly [Kind, Extract<Move, { _tag: "drawn" }>];
/** The drawn rows in scope, by kind. */
export const drawnIn = (scope: Scope): readonly Drawn[] =>
  (Object.entries(MOVES) as [Kind, Move][])
    .flatMap(([k, m]): Drawn[] => (m._tag === "drawn" && inScope(scope, AREA[k]) ? [[k, m]] : []))
    .toSorted(byName);

/** A world move named `area:move`, so two areas' moves never share a count. */
export type NamedWorldMove = readonly [string, WorldMove];
/** The world moves in scope, by name. */
export const worldIn = (scope: Scope): readonly NamedWorldMove[] =>
  (Object.entries(WORLD) as [Area, WorldMoves][])
    .filter(([a]) => inScope(scope, a))
    .flatMap(([a, moves]) => Object.entries(moves).map(([n, m]): NamedWorldMove => [`${a}:${n}`, m]))
    .toSorted(byName);
