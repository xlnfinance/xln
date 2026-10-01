// The progress report: how much of the register each column holds, and which goal milestones that makes true.
// Read-only and pure: names, git and files are read in rules/progress.ts, and the gate (rules/check.ts) is unchanged.
import { layerCounts, type RowReport } from "../evaluate.ts";
import { LAYERS, type Layer, type Register, type Row } from "../model.ts";

// One column of the register. `required` is what the column must carry (held plus owed plus a hold cell no name carries); `na` is the
// live rules whose cell says, with a reason, that the layer has no part in them (they leave `required`, and the report prints them so a
// shrunk column shows); `unstated` is the live rules that say nothing here, so a quiet column is not read as a finished one.
export type Column = Readonly<{ layer: Layer; held: number; owed: number; required: number; na: number; unstated: number }>;

const isLive = (row: Row): boolean => row.retiredBy === undefined;

export const columnsOf = (reports: readonly RowReport[]): readonly Column[] => layerCounts(reports);

// A register read from another commit has no names to check, so its columns come from the cells: a `hold` cell counts as held
// (the gate refuses a commit where no name carries it), an `owed` or `stale` cell as owed, `n/a` as not applicable, `-` as unstated. On a green tree
// this equals `columnsOf`.
export const registerColumns = (register: Register): readonly Column[] => {
  const live = register.filter(isLive);
  return LAYERS.map((layer) => {
    const held = live.filter((row) => row.cells[layer]._tag === "hold").length;
    const owed = live.filter((row) => row.cells[layer]._tag === "owed" || row.cells[layer]._tag === "stale").length;
    return {
      layer,
      held,
      owed,
      required: held + owed,
      na: live.filter((row) => row.cells[layer]._tag === "na").length,
      unstated: live.filter((row) => row.cells[layer]._tag === "unstated").length,
    };
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

// The ids live in `then` that are not live in `now`: retired since, or gone from the register (the gate refuses that, the report
// still says so). Retiring a rule takes it out of the numerator and the denominator, so the report prints it next to the percents.
export const retiredSince = (then: Register, now: Register): readonly string[] => {
  const stillLive = new Set(now.filter(isLive).map((row) => row.id));
  return then.filter((row) => isLive(row) && !stillLive.has(row.id)).map((row) => row.id);
};

export type Status = "done" | "not done" | "unchecked";

// `by` says what the status rests on, so `[done]` is not read as "ran".
export type Milestone = Readonly<{ name: string; status: Status; by?: string; detail: string }>;

// What the Sepolia manifest says (contracts/deploy/sepolia.manifest.json, judged by contracts/deploy/manifest.ts): a deployed manifest is
// recorded, or it is not (prepared, missing, unreadable or invalid).
export type Deployment = Readonly<{ recorded: boolean; detail: string }>;

// The spec milestones are read from origin/main, not from the checkout: the columns the register and the spec names give there.
export type SpecAtMain = Readonly<{ ref: string; columns: readonly Column[] }>;

const columnFor = (columns: readonly Column[], layer: Layer): Column =>
  columns.find((column) => column.layer === layer) ?? { layer, held: 0, owed: 0, required: 0, na: 0, unstated: 0 };

// Done when nothing in the column is owed, missing or unstated (required is held plus owed plus missing, so held equal to required leaves
// none), and it must carry something: a column that is all "n/a" has finished nothing. A "n/a" cell has a reason in the register that the
// PR which wrote it listed for review; the report prints how many there are.
const isComplete = (column: Column): boolean => column.required > 0 && column.held === column.required && column.unstated === 0;

const countsText = ({ held, required, owed, na, unstated }: Column): string =>
  `${held} of ${required} held, ${owed} owed, ${na} not applicable; ${unstated} of ${required + na + unstated} live rules leave the cell unstated`;

const BY_NAMES = "by names, not by a run";

// The spec columns finish only when every live rule states its cell there: a rule retired or blanked out of the column cannot finish it.
const specMilestone = (name: string, layer: Layer, main: SpecAtMain | undefined): Milestone => {
  if (main === undefined) {
    return { name, status: "unchecked", by: BY_NAMES, detail: "origin/main is not fetched here, so the spec cannot be read from main" };
  }
  const column = columnFor(main.columns, layer);
  return {
    name,
    status: isComplete(column) ? "done" : "not done",
    by: BY_NAMES,
    detail: `${columnLabel(layer)} column on origin/main at ${main.ref}: ${countsText(column)}`,
  };
};

// The checkout's columns finish when what they must carry is carried and no rule leaves its cell unstated.
const columnMilestone = (name: string, column: Column, note: string): Milestone => ({
  name,
  status: isComplete(column) ? "done" : "not done",
  by: BY_NAMES,
  detail: `${columnLabel(column.layer)} column: ${countsText(column)}${note}`,
});

export const SEPOLIA_STEPS = "open, pay, HTLC across hubs, swap, dispute";

// What `bun contracts/deploy/verify.ts` answered: exit 0 every contract matches the current build and the manifest, 1 at least one differs,
// 2 (or anything else, or a run that never finished) the check could not be made. `block` is the block it read the chain at.
export type Verification = Readonly<{ result: "match" | "differ" | "cannot-check"; block?: number; detail: string }>;

const lastLine = (text: string): string => text.trim().split("\n").at(-1)?.trim() ?? "";

const firstLine = (text: string): string => text.trim().split("\n")[0]?.trim() ?? "";

export const verificationOf = (exitCode: number | null, stdout: string, stderr: string): Verification => {
  const found = /at block (\d+)/.exec(stdout)?.[1];
  const block = found === undefined ? {} : { block: Number(found) };
  if (exitCode === 0) {
    return found === undefined
      ? { result: "cannot-check", detail: "verify.ts exited 0 but printed no block number, so its answer cannot be quoted" }
      : { result: "match", ...block, detail: lastLine(stdout) };
  }
  // Exit 1 is also what Bun itself exits with when the verifier cannot start (a missing module): only the block line, printed before
  // any row, shows that the verifier ran and read the chain.
  if (exitCode === 1) {
    return found === undefined
      ? { result: "cannot-check", detail: firstLine(stderr) || "verify.ts exited 1 before it read the chain" }
      : { result: "differ", ...block, detail: lastLine(stdout) };
  }
  if (exitCode === 2) return { result: "cannot-check", detail: firstLine(stderr).replace(/^verify: could not check: /, "") || "exit 2" };
  return { result: "cannot-check", detail: exitCode === null ? "verify.ts did not finish (killed or timed out)" : `verify.ts exited ${exitCode}, not 0, 1 or 2` };
};

const verifierText = (verification: Verification | undefined): string => {
  if (verification === undefined) return "verify.ts was not run";
  const at = verification.block === undefined ? "" : ` at block ${verification.block}`;
  switch (verification.result) {
    case "match":
      return `verify.ts exit 0${at}: ${verification.detail}`;
    case "differ":
      return `verify.ts exit 1${at}: ${verification.detail}`;
    case "cannot-check":
      return `verify.ts could not check: ${verification.detail}`;
  }
};

// Done only when the column is complete, the manifest records a deployment, and `bun contracts/deploy/verify.ts` exited 0 (the chain's code at
// every address is the current build's, read at the block quoted). Exit 1 is not done; exit 2, a run that never finished, or no run is unchecked,
// never done: an answer that was not obtained is not a yes.
const contractsMilestone = (contracts: Column, deployment: Deployment, verification: Verification | undefined): Milestone => {
  const complete = isComplete(contracts);
  const status = contractsStatus(complete && deployment.recorded, verification);
  return {
    name: "Contracts reviewed and deployed",
    status,
    by: "by the register's contract column and the manifest, and by verify.ts comparing the chain's code with the current build; not by a review",
    detail: `contracts column: ${countsText(contracts)}; manifest: ${deployment.detail}; ${verifierText(verification)}`,
  };
};

const contractsStatus = (ready: boolean, verification: Verification | undefined): Status => {
  if (!ready || verification?.result === "differ") return "not done";
  return verification?.result === "match" ? "done" : "unchecked";
};

// Six milestones, in the order of the goal. Each is decided by a check that already exists: a register column, or the verifier. The
// last has none yet (no recorded run is read by anything), so it says unchecked rather than guessing.
export const milestonesOf = (
  columns: readonly Column[],
  deployment: Deployment,
  main: SpecAtMain | undefined,
  verification?: Verification,
): readonly Milestone[] => [
  specMilestone("Arrival on main", "arrival", main),
  specMilestone("Quint on main", "quint", main),
  contractsMilestone(columnFor(columns, "contract"), deployment, verification),
  columnMilestone("xln.ts cut to the spec", columnFor(columns, "ts"), " (every ts cell held or not applicable)"),
  columnMilestone("Walk checks the spec against the contracts", columnFor(columns, "rig"), " (the register does not say which contracts the walk ran on)"),
  { name: "End-to-end run on Sepolia", status: "unchecked", detail: `${SEPOLIA_STEPS}: this report has no check for it` },
];

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

export type Since = Readonly<{ ref: string; added: readonly string[]; retired: readonly string[]; then: readonly Column[] }>;

// The checkout the numbers other than the spec milestones come from: branch, commit, and how many files differ from it.
export type Checkout = Readonly<{ branch: string; sha: string; changed: number }>;

export type Report = Readonly<{
  checkout: Checkout;
  specFrom: string;
  liveRules: number;
  columns: readonly Column[];
  milestones: readonly Milestone[];
  since: Since | "no base" | undefined;
  problems: number;
}>;

const MAX_LISTED = 10;

const columnLine = (column: Column): string =>
  `${columnLabel(column.layer).padEnd(10)} ${pad(column.held, 5)} ${pad(column.required, 8)} ${percentText(column.held, column.required).padStart(8)} ${pad(column.owed, 5)} ${pad(column.na, 15)} ${pad(column.unstated, 9)}`;

const totalLine = (columns: readonly Column[]): string => {
  const { held, required } = totalOf(columns);
  const owed = columns.reduce((sum, column) => sum + column.owed, 0);
  const na = columns.reduce((sum, column) => sum + column.na, 0);
  const unstated = columns.reduce((sum, column) => sum + column.unstated, 0);
  return `${"Total".padEnd(10)} ${pad(held, 5)} ${pad(required, 8)} ${percentText(held, required).padStart(8)} ${pad(owed, 5)} ${pad(na, 15)} ${pad(unstated, 9)}`;
};

const countedRules = (ids: readonly string[], verb: string): string =>
  `${ids.length} ${ids.length === 1 ? "rule" : "rules"} ${verb}${ids.length > 0 && ids.length <= MAX_LISTED ? ` (${ids.join(", ")})` : ""}`;

const sinceLines = (since: Since | "no base", columns: readonly Column[]): readonly string[] =>
  since === "no base"
    ? ["", "Since: no commit to compare with (origin/main is not fetched here)"]
    : [
        "",
        `Since ${since.ref}: ${countedRules(since.added, "added")}, ${countedRules(since.retired, "retired")}`,
        ...DISPLAY_ORDER.map((layer) => {
          const before = columnFor(since.then, layer);
          const now = columnFor(columns, layer);
          return `${columnLabel(layer).padEnd(10)} then ${percentText(before.held, before.required)} of ${before.required}, now ${percentText(now.held, now.required)} of ${now.required}`;
        }),
        "then is counted from the cells of that commit's register, now from the names; the two agree on a green tree",
      ];

const milestoneLine = ({ name, status, by, detail }: Milestone): string =>
  `${`[${status}]`.padEnd(11)} ${name}${by === undefined ? "" : ` (${by})`}: ${detail}`;

const summaryLine = (milestones: readonly Milestone[]): string => {
  const count = (status: Status): number => milestones.filter((milestone) => milestone.status === status).length;
  return `Milestones: ${count("done")} done, ${count("not done")} not done, ${count("unchecked")} unchecked, of ${milestones.length}`;
};

const treeState = (changed: number): string => (changed === 0 ? "clean" : `dirty (${changed} changed ${changed === 1 ? "file" : "files"})`);

// The banner counts the register evaluation only (the missing names and stale waivers). The ratchet, style, folder width, contract-test
// placement and forge parts of the composed gate are not run here.
export const renderProgress = ({ checkout, specFrom, liveRules, columns, milestones, since, problems }: Report): string =>
  [
    `Progress on branch ${checkout.branch} at ${checkout.sha}, ${treeState(checkout.changed)}: ${liveRules} live rules in the register`,
    `The Arrival and Quint milestones are read from ${specFrom}; every other number is from this checkout`,
    ...(problems > 0
      ? [`the register evaluation is red (${problems} problems); this report counts only the register, not the ratchet, style, folder width or forge parts: run bun rules/check.ts`]
      : []),
    "",
    "Column      held  required  percent  owed  not applicable  unstated",
    ...DISPLAY_ORDER.map((layer) => columnLine(columnFor(columns, layer))),
    totalLine(columns),
    ...(since === undefined ? [] : sinceLines(since, columns)),
    "",
    "Goal milestones",
    ...milestones.map(milestoneLine),
    summaryLine(milestones),
  ].join("\n");
