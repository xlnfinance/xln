// The progress report: how much of the register each column holds, and which goal milestones that makes true.
// Read-only and pure: names, git and files are read in rules/progress.ts, and the gate (rules/check.ts) is unchanged.
import { layerCounts, type CellVerdict, type RowReport } from "../evaluate.ts";
import { LAYERS, type Layer, type Register, type Row } from "../model.ts";

// One column of the register. `required` is what the column must carry (held plus owed plus a hold cell no name carries);
// `unclaimed` is the live rules that do not claim this column at all, so a quiet column is not read as a finished one.
export type Column = Readonly<{ layer: Layer; held: number; owed: number; required: number; unclaimed: number }>;

const isLive = (row: Row): boolean => row.retiredBy === undefined;

const isUnclaimed = (verdict: CellVerdict): boolean => verdict === "unclaimed" || verdict === "unclaimed-but-present";

export const columnsOf = (reports: readonly RowReport[]): readonly Column[] => {
  const live = reports.filter((report) => isLive(report.row));
  return layerCounts(live).map(({ layer, held, owed, required }) => ({
    layer,
    held,
    owed,
    required,
    unclaimed: live.filter((report) => isUnclaimed(report.cells[layer].verdict)).length,
  }));
};

// A register read from another commit has no names to check, so its columns come from the cells: a `hold` cell counts as held
// (the gate refuses a commit where no name carries it) and an `owed` cell as owed. On a green tree this equals `columnsOf`.
export const registerColumns = (register: Register): readonly Column[] => {
  const live = register.filter(isLive);
  return LAYERS.map((layer) => {
    const held = live.filter((row) => row.cells[layer]._tag === "hold").length;
    const owed = live.filter((row) => row.cells[layer]._tag === "owed").length;
    return { layer, held, owed, required: held + owed, unclaimed: live.filter((row) => row.cells[layer]._tag === "absent").length };
  });
};

// Held over required, to one decimal; nothing when the column is not required to carry anything.
export const percentOf = (held: number, required: number): number | undefined =>
  required === 0 ? undefined : Math.round((1000 * held) / required) / 10;

export const totalOf = (columns: readonly Column[]): Readonly<{ held: number; required: number }> => ({
  held: columns.reduce((sum, column) => sum + column.held, 0),
  required: columns.reduce((sum, column) => sum + column.required, 0),
});

// The live ids of `now` that `then` did not list at all, in register order. A rule retired since is not new, and neither is a
// rule that was in `then` already, live or retired.
export const addedSince = (then: Register, now: Register): readonly string[] => {
  const before = new Set(then.map((row) => row.id));
  return now.filter((row) => isLive(row) && !before.has(row.id)).map((row) => row.id);
};

export type Status = "done" | "not done" | "unchecked";

export type Milestone = Readonly<{ name: string; status: Status; detail: string }>;

// What the Sepolia manifest says (contracts/deploy/sepolia.manifest.json, judged by contracts/deploy/manifest.ts).
export type Deployment = Readonly<{ deployed: boolean; detail: string }>;

const columnFor = (columns: readonly Column[], layer: Layer): Column =>
  columns.find((column) => column.layer === layer) ?? { layer, held: 0, owed: 0, required: 0, unclaimed: 0 };

// Everything the column must carry is carried (required is held plus owed plus missing, so nothing is owed), and it must carry
// something: an empty column has not finished anything.
const isComplete = (column: Column): boolean => column.required > 0 && column.held === column.required;

const countsText = ({ held, required, owed, unclaimed }: Column): string =>
  `${held} of ${required} held, ${owed} owed, ${unclaimed} rules claim no cell here`;

const columnMilestone = (name: string, column: Column, note: string): Milestone => ({
  name,
  status: isComplete(column) ? "done" : "not done",
  detail: `${columnLabel(column.layer)} column: ${countsText(column)}${note}`,
});

export const SEPOLIA_STEPS = "open, pay, HTLC across hubs, swap, dispute";

// Six milestones, in the order of the goal. Each is decided by a check that already exists: a register column, or the manifest. The
// last has none yet (no recorded run is read by anything), so it says unchecked rather than guessing.
export const milestonesOf = (columns: readonly Column[], deployment: Deployment): readonly Milestone[] => {
  const contracts = columnFor(columns, "contract");
  const contractsDone = isComplete(contracts) && deployment.deployed;
  return [
    columnMilestone("Arrival on main", columnFor(columns, "arrival"), ""),
    columnMilestone("Quint on main", columnFor(columns, "quint"), ""),
    {
      name: "Contracts reviewed and deployed",
      status: contractsDone ? "done" : "not done",
      detail: `contracts column: ${countsText(contracts)}; manifest: ${deployment.detail}`,
    },
    columnMilestone("xln.ts cut to the spec", columnFor(columns, "ts"), " (every ts cell held)"),
    columnMilestone("Walk checks the spec against the contracts", columnFor(columns, "rig"), " (the register does not say which contracts the walk ran on)"),
    {
      name: "End-to-end run on Sepolia",
      status: "unchecked",
      detail: `${SEPOLIA_STEPS}: no recorded run exists and nothing reads one yet`,
    },
  ];
};

// The words the goal and the coordinator use for each register layer.
const LABELS: Readonly<Record<Layer, string>> = {
  arrival: "Arrival",
  quint: "Quint",
  ts: "ts code",
  contract: "contracts",
  rig: "walk",
};

const columnLabel = (layer: Layer): string => LABELS[layer];

const DISPLAY_ORDER: readonly Layer[] = ["arrival", "quint", "ts", "contract", "rig"];

const percentText = (held: number, required: number): string => {
  const percent = percentOf(held, required);
  return percent === undefined ? "-" : `${percent.toFixed(1)}%`;
};

const pad = (value: number, width: number): string => String(value).padStart(width);

export type Since = Readonly<{ ref: string; added: readonly string[]; then: readonly Column[] }>;

export type Report = Readonly<{
  at: string;
  liveRules: number;
  columns: readonly Column[];
  milestones: readonly Milestone[];
  since: Since | undefined;
  problems: number;
}>;

const MAX_LISTED = 10;

const columnLine = (column: Column): string =>
  `${columnLabel(column.layer).padEnd(10)} ${pad(column.held, 5)} ${pad(column.required, 8)} ${percentText(column.held, column.required).padStart(8)} ${pad(column.owed, 5)} ${pad(column.unclaimed, 9)}`;

const totalLine = (columns: readonly Column[]): string => {
  const { held, required } = totalOf(columns);
  const owed = columns.reduce((sum, column) => sum + column.owed, 0);
  return `${"Total".padEnd(10)} ${pad(held, 5)} ${pad(required, 8)} ${percentText(held, required).padStart(8)} ${pad(owed, 5)}`;
};

const sinceLines = ({ ref, added, then }: Since, columns: readonly Column[]): readonly string[] => [
  "",
  `Since ${ref}: ${added.length} ${added.length === 1 ? "rule" : "rules"} added${added.length > 0 && added.length <= MAX_LISTED ? ` (${added.join(", ")})` : ""}`,
  ...DISPLAY_ORDER.map((layer) => {
    const before = columnFor(then, layer);
    const now = columnFor(columns, layer);
    return `${columnLabel(layer).padEnd(10)} then ${percentText(before.held, before.required)} of ${before.required}, now ${percentText(now.held, now.required)} of ${now.required}`;
  }),
];

const milestoneLine = ({ name, status, detail }: Milestone): string => `${`[${status}]`.padEnd(11)} ${name}: ${detail}`;

const summaryLine = (milestones: readonly Milestone[]): string => {
  const count = (status: Status): number => milestones.filter((milestone) => milestone.status === status).length;
  return `Milestones: ${count("done")} done, ${count("not done")} not done, ${count("unchecked")} unchecked, of ${milestones.length}`;
};

export const renderProgress = ({ at, liveRules, columns, milestones, since, problems }: Report): string =>
  [
    `Progress on ${at}: ${liveRules} live rules in the register`,
    ...(problems > 0 ? [`the gate is red here (${problems} problems): run bun rules/check.ts; the numbers below rest on a tree the gate refuses`] : []),
    "",
    "Column      held  required  percent  owed  no cell here",
    ...DISPLAY_ORDER.map((layer) => columnLine(columnFor(columns, layer))),
    totalLine(columns),
    ...(since === undefined ? [] : sinceLines(since, columns)),
    "",
    "Goal milestones",
    ...milestones.map(milestoneLine),
    summaryLine(milestones),
  ].join("\n");
