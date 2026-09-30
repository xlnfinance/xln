// The matrix, as text for a terminal and as markdown for review/.
import { layerCounts, type CellVerdict, type Evaluation, type KillerVerdict, type RowReport } from "./evaluate.ts";
import { LAYERS, describeProblem } from "./model.ts";

const cellText = (verdict: CellVerdict, hits: number): string => {
  switch (verdict) {
    case "held":
      return `ok ${hits}`;
    case "owed":
      return "owed";
    case "missing":
      return "MISSING";
    case "stale-owed":
      return `PROMOTE ${hits}`;
    case "unclaimed":
      return "-";
    case "unclaimed-but-present":
      return `- (${hits})`;
  }
};

const killerText = (verdict: KillerVerdict): string => {
  switch (verdict) {
    case "found":
      return "found";
    case "owed":
      return "owed";
    case "missing":
      return "MISSING";
    case "stale-owed":
      return "PROMOTE";
  }
};

const killersText = (report: RowReport): string =>
  report.row.retiredBy !== undefined ? `retired, see ${report.row.retiredBy.join(", ")}` : report.killers.length === 0 ? "NONE" : report.killers.map((entry) => `${entry.killer.name} [${killerText(entry.verdict)}]`).join("; ");

const rowCells = (report: RowReport): readonly string[] =>
  LAYERS.map((layer) => cellText(report.cells[layer].verdict, report.cells[layer].hits));

const summaryLines = (evaluation: Evaluation): readonly string[] =>
  layerCounts(evaluation.reports).map(
    ({ layer, held, owed, required }) => `${layer.padEnd(9)} held ${String(held).padStart(3)} of ${String(required).padStart(3)} required, ${owed} owed`,
  );

export const renderMarkdown = (evaluation: Evaluation): string =>
  [
    "Named-killer matrix: a killer is found when a check of that name exists. The gate reads names; it does not run Arrival, Quint or the mutants, so `found` means the named killer exists, not that the bug is killed.",
    "",
    `| id | ${LAYERS.join(" | ")} | killers |`,
    `|---|${LAYERS.map(() => "---").join("|")}|---|`,
    ...evaluation.reports.map((report) => `| ${report.row.id} | ${rowCells(report).join(" | ")} | ${killersText(report)} |`),
    "",
    "Progress per layer (rules whose cell is `hold` or `owed`):",
    "",
    ...summaryLines(evaluation).map((line) => `- ${line}`),
    "",
    evaluation.problems.length === 0 ? "Gate: green." : `Gate: red, ${evaluation.problems.length} problems.`,
    ...evaluation.problems.map((problem) => `- ${describeProblem(problem)}`),
  ].join("\n");

export const renderText = (evaluation: Evaluation): string =>
  [
    ...evaluation.reports.map((report) => `${report.row.id.padEnd(22)} ${rowCells(report).map((cell) => cell.padEnd(9)).join(" ")} ${killersText(report)}`),
    "",
    ...summaryLines(evaluation),
    ...evaluation.problems.map((problem) => `FAIL ${describeProblem(problem)}`),
    evaluation.problems.length === 0 ? `ok   ${evaluation.reports.length} rules` : `${evaluation.problems.length} problems`,
  ].join("\n");
