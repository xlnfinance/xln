// Runs one step and judges it: skipped when a step it needs did not finish, blocked when it stopped at a named piece,
// failed when a check broke, and failed too when a piece it still lists as missing has landed on main (the tripwire).
import { GAPS, type Gap, type GapKey } from "./gaps.ts";
import type { StepResult } from "./report.ts";

export class Blocked extends Error {
  constructor(readonly gaps: readonly GapKey[], problem: string) { super(problem); }
}

export type Outcome = Readonly<{ checks: readonly string[]; gaps: readonly GapKey[] }>;

export type Step<W> = Readonly<{ id: string; title: string; needs: readonly string[]; run: (w: W) => Promise<Outcome> }>;

const describe = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export const runStep = async <W>(world: W, done: ReadonlyMap<string, StepResult>, step: Step<W>, gaps: Record<GapKey, Gap> = GAPS): Promise<StepResult> => {
  const unmet = step.needs.filter((id) => !["done", "scaffolded"].includes(done.get(id)?.status ?? "skipped"));
  if (unmet.length > 0) {
    return { id: step.id, title: step.title, status: "skipped", checks: [], gaps: [], problem: `needs ${unmet.join(", ")}, which did not finish` };
  }
  const verdict = await step.run(world).then(
    (outcome) => ({ kind: "ran" as const, outcome }),
    (error: unknown) => ({ kind: "stopped" as const, error }),
  );
  if (verdict.kind === "ran") {
    const landed = verdict.outcome.gaps.filter((g) => gaps[g].landed());
    const status = landed.length > 0 ? "failed" : verdict.outcome.gaps.length === 0 ? "done" : "scaffolded";
    const problem = landed.length === 0 ? null : `tripwire: ${landed.join(", ")} landed on main (${landed.map((g) => gaps[g].supplier).join("; ")}); replace the stand-in in this step`;
    return { id: step.id, title: step.title, status, checks: verdict.outcome.checks, gaps: verdict.outcome.gaps, problem };
  }
  if (verdict.error instanceof Blocked) {
    const stillMissing = verdict.error.gaps.filter((g) => !gaps[g].landed());
    return stillMissing.length === 0
      ? { id: step.id, title: step.title, status: "failed", checks: [], gaps: verdict.error.gaps, problem: `tripwire: everything this step was blocked on has landed on main (${verdict.error.gaps.join(", ")}); write it for real` }
      : { id: step.id, title: step.title, status: "blocked", checks: [], gaps: verdict.error.gaps, problem: verdict.error.message };
  }
  return { id: step.id, title: step.title, status: "failed", checks: [], gaps: [], problem: describe(verdict.error) };
};

