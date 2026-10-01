// A register may only grow. Compared with the register at the base commit: a row may not vanish, a cell may not
// drop from hold to owed, from owed to not applicable, or from a stated cell back to unstated, and a killer the base named may not disappear.
// A claim (hold, owed) outranks "n/a", so a rule cannot leave a column's denominator by giving a reason. A rule is retired
// with retired_by, which the gate prints so the diff is reviewed.
import type { Cell, Problem, Register, Row } from "./model.ts";
import { LAYERS } from "./model.ts";

const strength = (cell: Cell): number => {
  switch (cell._tag) {
    case "hold":
      return 3;
    case "owed":
      return 2;
    case "na":
      return 1;
    case "unstated":
      return 0;
  }
};

const weakened = (before: Row, after: Row): readonly Problem[] =>
  LAYERS.filter((layer) => strength(after.cells[layer]) < strength(before.cells[layer])).map((layer) => ({
    _tag: "CellWeakened",
    id: before.id,
    layer,
    from: before.cells[layer]._tag,
    to: after.cells[layer]._tag,
  }));

const sameKiller = (left: Row["killers"][number], right: Row["killers"][number]): boolean =>
  left.kind === right.kind && left.layer === right.layer && left.name === right.name;

// A killer that was real (not owed) at the base may not vanish; an owed one may be replaced or found.
const dropped = (before: Row, after: Row): readonly Problem[] =>
  before.killers
    .filter((killer) => killer.owed === undefined)
    .filter((killer) => !after.killers.some((other) => sameKiller(killer, other)))
    .map((killer) => ({ _tag: "KillerDropped", id: before.id, killer }));

export type Ratchet = Readonly<{ problems: readonly Problem[]; retirements: readonly string[] }>;

export const ratchet = (base: Register, now: Register): Ratchet => {
  const pairs = base.map((before) => ({ before, after: now.find((row) => row.id === before.id) }));
  const removed = pairs.filter((pair) => pair.after === undefined).map((pair) => ({ _tag: "RowRemoved", id: pair.before.id }) as const);
  const kept = pairs.flatMap((pair) => (pair.after === undefined ? [] : [{ before: pair.before, after: pair.after }]));
  const live = kept.filter((pair) => pair.after.retiredBy === undefined);
  const newlyRetired = kept.filter((pair) => pair.before.retiredBy === undefined && pair.after.retiredBy !== undefined);
  return {
    problems: [...removed, ...live.flatMap((pair) => [...weakened(pair.before, pair.after), ...dropped(pair.before, pair.after)])],
    retirements: newlyRetired.map((pair) => `${pair.after.id} retired into ${(pair.after.retiredBy ?? []).join(", ")}`),
  };
};
