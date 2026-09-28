// The whole draw table, composed from the areas. Each area's rows are typed by exactly its kinds (areas.ts), so the
// composition covers every Entity tx kind once.
import { AREA, type Area, type Kind, type Move, type WorldMove } from "./areas.ts";
import { CORE, CORE_WORLD } from "./core.ts";
import { SETTLEMENT } from "./settlement.ts";
import { ORDERBOOK } from "./orderbook.ts";
import { LENDING } from "./lending.ts";
import { BOARDS } from "./boards.ts";
import { DISPUTES } from "./disputes.ts";

export const MOVES: { readonly [K in Kind]: Move } = { ...CORE, ...SETTLEMENT, ...ORDERBOOK, ...LENDING, ...BOARDS, ...DISPUTES };

export type Drawn = readonly [Kind, Extract<Move, { _tag: "drawn" }>];
/** The drawn rows of the given areas (all of them when none is named). */
export const drawnIn = (areas: readonly Area[]): readonly Drawn[] =>
  (Object.entries(MOVES) as [Kind, Move][]).flatMap(([k, m]): Drawn[] =>
    m._tag === "drawn" && (areas.length === 0 || areas.includes(AREA[k])) ? [[k, m]] : []);

/** The world moves each area adds, by name; an area with none leaves its entry out. */
const WORLD: { readonly [A in Area]?: Readonly<Record<string, WorldMove>> } = { core: CORE_WORLD };
export type NamedWorldMove = readonly [string, WorldMove];
/** The world moves of the given areas (all of them when none is named). */
export const worldIn = (areas: readonly Area[]): readonly NamedWorldMove[] =>
  (Object.entries(WORLD) as [Area, Readonly<Record<string, WorldMove>>][])
    .filter(([a]) => areas.length === 0 || areas.includes(a))
    .flatMap(([, moves]) => Object.entries(moves));
