// The gate's judgment: a register and the names found in each layer in, problems and a matrix out.
import { carries } from "./names/names.ts";
import { LAYERS, byLayer, type Cell, type Killer, type Layer, type Name, type Problem, type Register, type Row } from "./model.ts";

export type CellVerdict = "held" | "owed" | "missing" | "stale-owed" | "unstated" | "na" | "na-but-present";

export type KillerVerdict = "found" | "owed" | "missing" | "stale-owed";

export type RowReport = Readonly<{
  row: Row;
  cells: Readonly<Record<Layer, Readonly<{ verdict: CellVerdict; hits: number }>>>;
  killers: readonly Readonly<{ killer: Killer; verdict: KillerVerdict }>[];
}>;

const hitsFor = (id: string, layer: Layer, names: readonly Name[]): number =>
  names.filter((name) => name.layer === layer && carries(id, name)).length;

const cellVerdict = (row: Row, layer: Layer, hits: number): CellVerdict => {
  const cell = row.cells[layer];
  switch (cell._tag) {
    case "unstated":
      return "unstated";
    case "na":
      return hits > 0 ? "na-but-present" : "na";
    case "hold":
      return hits > 0 ? "held" : "missing";
    case "owed":
      return hits > 0 ? "stale-owed" : "owed";
  }
};

const killerKinds: Readonly<Record<Killer["kind"], readonly Name["kind"][]>> = {
  test: ["title", "function", "file", "run", "invariant", "property"],
  bug: ["bug"],
  mutant: ["mutant"],
};

// A killer is found when a name of the right kind in its layer IS the killer's name, whole: a substring would let
// an unrelated name that contains "j5" stand in for a killer called J5.
const killerExists = (killer: Killer, names: readonly Name[]): boolean =>
  names.some(
    (name) => name.layer === killer.layer && killerKinds[killer.kind].includes(name.kind) && name.text === killer.name,
  );

const killerVerdict = (killer: Killer, names: readonly Name[]): KillerVerdict => {
  const exists = killerExists(killer, names);
  if (killer.owed === undefined) return exists ? "found" : "missing";
  return exists ? "stale-owed" : "owed";
};

export const reportRow = (row: Row, names: readonly Name[]): RowReport => ({
  row,
  cells: byLayer((layer) => {
    const hits = hitsFor(row.id, layer, names);
    return { verdict: cellVerdict(row, layer, hits), hits };
  }),
  killers: row.killers.map((killer) => ({ killer, verdict: killerVerdict(killer, names) })),
});

const cellProblem = (report: RowReport, layer: Layer): readonly Problem[] => {
  const id = report.row.id;
  const cell = report.row.cells[layer];
  switch (report.cells[layer].verdict) {
    case "missing":
      return [{ _tag: "MissingInLayer", id, layer }];
    case "stale-owed":
      return [{ _tag: "OwedButPresent", id, layer, by: cell._tag === "owed" ? cell.by : "" }];
    case "unstated":
      return [{ _tag: "UnstatedCell", id, layer }];
    case "na-but-present":
      return [{ _tag: "NotApplicableButPresent", id, layer, reason: cell._tag === "na" ? cell.reason : "" }];
    default:
      return [];
  }
};

const isNoClaim = (cell: Cell): boolean => cell._tag === "unstated" || cell._tag === "na";

const killerProblem = (row: Row, { killer, verdict }: RowReport["killers"][number]): readonly Problem[] => {
  const id = row.id;
  if (isNoClaim(row.cells[killer.layer])) return [{ _tag: "KillerInUnclaimedLayer", id, killer }];
  switch (verdict) {
    case "missing":
      return [{ _tag: "KillerNotFound", id, killer }];
    case "stale-owed":
      return [{ _tag: "KillerOwedButPresent", id, killer, owed: killer.owed ?? "" }];
    default:
      return [];
  }
};

export const problemsOf = (report: RowReport): readonly Problem[] =>
  report.row.retiredBy === undefined ? liveProblems(report) : [];

const liveProblems = (report: RowReport): readonly Problem[] => [
  ...(report.row.killers.length === 0 ? [{ _tag: "NoKiller", id: report.row.id } as const] : []),
  ...LAYERS.flatMap((layer) => cellProblem(report, layer)),
  ...report.killers.flatMap((entry) => killerProblem(report.row, entry)),
];

const duplicateIds = (register: Register): readonly Problem[] =>
  register
    .map((row) => row.id)
    .filter((id, index, ids) => ids.indexOf(id) !== index)
    .map((id) => ({ _tag: "DuplicateId", id }) as const);

// A retired row must point at rows that are still live, so a rule is never retired into nothing.
const retirementProblems = (register: Register): readonly Problem[] =>
  register.flatMap((row) =>
    (row.retiredBy ?? [])
      .filter((successor) => !register.some((other) => other.id === successor && other.retiredBy === undefined))
      .map((successor) => ({ _tag: "UnknownSuccessor", id: row.id, successor }) as const),
  );

// A name that carries a longer id ("R-COSIGN-FREEZE x") belongs to that rule, not to the shorter one it begins with ("R-COSIGN").
const apart = (id: string, register: Register, names: readonly Name[]): readonly Name[] => {
  const longer = register.map((row) => row.id).filter((other) => other.startsWith(`${id}-`));
  return names.filter((name) => !longer.some((other) => carries(other, name)));
};

export type Evaluation = Readonly<{ reports: readonly RowReport[]; problems: readonly Problem[] }>;

export const evaluate = (register: Register, names: readonly Name[]): Evaluation => {
  const reports = register.map((row) => reportRow(row, apart(row.id, register, names)));
  return { reports, problems: [...duplicateIds(register), ...retirementProblems(register), ...reports.flatMap(problemsOf)] };
};

// `na` and `unstated` are counted apart from `required` (a rule that says not applicable, or says nothing, is not required of the layer).
export type LayerCount = Readonly<{ layer: Layer; held: number; owed: number; required: number; na: number; unstated: number }>;

// The progress meter: per layer, how many rules that must be held are held, how many are still owed, how many say not applicable, how many say nothing.
export const layerCounts = (reports: readonly RowReport[]): readonly LayerCount[] =>
  LAYERS.map((layer) => {
    const verdicts = reports.filter((report) => report.row.retiredBy === undefined).map((report) => report.cells[layer].verdict);
    const held = verdicts.filter((verdict) => verdict === "held").length;
    const owed = verdicts.filter((verdict) => verdict === "owed" || verdict === "stale-owed").length;
    const missing = verdicts.filter((verdict) => verdict === "missing").length;
    return {
      layer,
      held,
      owed,
      required: held + owed + missing,
      na: verdicts.filter((verdict) => verdict === "na" || verdict === "na-but-present").length,
      unstated: verdicts.filter((verdict) => verdict === "unstated").length,
    };
  });
