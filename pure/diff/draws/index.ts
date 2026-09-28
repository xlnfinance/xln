// The whole draw table, composed from the areas. Each area's rows are typed by exactly its kinds (areas.ts), so the
// composition covers every Entity tx kind once.
import { AREA, type Area, type Kind, type Move } from "./areas.ts";
import { CORE } from "./core.ts";
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
