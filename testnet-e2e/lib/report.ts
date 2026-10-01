// The result of a run, in the order money flows: one row per step, then the list of what is missing.
import { GAPS, type Gap, type GapKey } from "./gaps.ts";

/**
 * done       every layer the step touched is the rewrite on main
 * scaffolded the step ran, with stand-ins for the gaps it lists
 * blocked    the step could not run: a named piece is not on main
 * failed     the step ran and something it checked was false (or its tripwire went off): a bug until shown otherwise
 * skipped    a step it depends on did not finish
 */
export type Status = "done" | "scaffolded" | "blocked" | "failed" | "skipped";

export type StepResult = Readonly<{
  id: string;
  title: string;
  status: Status;
  checks: readonly string[];
  gaps: readonly GapKey[];
  problem: string | null;
}>;

const ICON: Record<Status, string> = { done: "DONE", scaffolded: "SCAFFOLDED", blocked: "BLOCKED", failed: "FAILED", skipped: "SKIPPED" };

/** Gaps in the order the first step needs them, each once, with the steps that list it. */
export const gapsInMoneyOrder = (steps: readonly StepResult[]): readonly (readonly [Gap, readonly string[]])[] => {
  const order = steps.flatMap((s) => s.gaps).filter((key, i, all) => all.indexOf(key) === i);
  return order.map((key) => [GAPS[key], steps.filter((s) => s.gaps.includes(key)).map((s) => s.id)] as const);
};

export type RunFacts = Readonly<{
  head: string; mode: string; chainId: string; block: string; startedAt: string; seconds: number;
}>;

export const exitCode = (steps: readonly StepResult[]): number => {
  if (steps.some((s) => s.status === "failed")) return 2;
  return steps.every((s) => s.status === "done") ? 0 : 1;
};

export const renderReport = (facts: RunFacts, steps: readonly StepResult[]): string => {
  const counts = (status: Status): number => steps.filter((s) => s.status === status).length;
  const summary = (["done", "scaffolded", "blocked", "failed", "skipped"] as const).map((s) => `${counts(s)} ${s}`).join(", ");
  const rows = steps.map((s, i) => `| S${i} | ${s.title} | ${ICON[s.status]} | ${s.gaps.length === 0 ? "" : s.gaps.join(", ")} |`);
  const details = steps.map((s, i) => [
    `### S${i} ${s.title}: ${ICON[s.status]}`,
    ...(s.problem === null ? [] : ["", `**${s.status === "blocked" ? "Stopped" : "Problem"}:** ${s.problem}`]),
    ...(s.checks.length === 0 ? [] : ["", ...s.checks.map((c) => `- ${c}`)]),
    ...(s.gaps.length === 0 ? [] : ["", `Uses: ${s.gaps.map((g) => `\`${g}\``).join(", ")}`]),
  ].join("\n"));
  const gapRows = gapsInMoneyOrder(steps).map(([gap, ids], i) => [
    `${i + 1}. **${gap.layer}: ${gap.id}** (${gap.kind === "missing" ? "missing" : "stand-in in this harness"}; steps ${ids.map((id) => id).join(", ")})`,
    `   - Needed: ${gap.piece}`,
    `   - Expected from: ${gap.supplier}`,
    `   - Landed on main: ${gap.landed() ? "YES, so the step that lists it must be rewritten" : "no"}`,
  ].join("\n"));
  return [
    "# Testnet end-to-end skeleton: status",
    "",
    `Run ${facts.startedAt} on main ${facts.head}, ${facts.mode}, chain ${facts.chainId}, block ${facts.block}, ${facts.seconds.toFixed(1)} s.`,
    `Result: ${summary}. Exit ${exitCode(steps)} (0 only when every step is done; 1 blocked or scaffolded; 2 a check failed).`,
    "",
    "Scenario: two users and two hubs on the deployed Sepolia contracts (anvil fork, anvil dev keys only): deposit, open Accounts, pay, HTLC across both hubs, swap, forced dispute.",
    "A step is only DONE when every layer it touched is the rewrite on main. SCAFFOLDED steps ran on the real contracts with the pieces named under Uses done by this harness. BLOCKED steps stopped at the named piece.",
    "",
    "| Step | What | Status | Uses |",
    "| --- | --- | --- | --- |",
    ...rows,
    "",
    "## Steps",
    "",
    ...details.flatMap((d) => [d, ""]),
    "## Missing pieces, in the order money flows",
    "",
    ...gapRows,
    "",
  ].join("\n");
};
