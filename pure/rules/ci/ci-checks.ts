// The names the repository's ruleset requires, against the names the workflow reports. A required check that no job reports never
// finishes, and the PR waits on it forever, so renaming a job (or a seed leaving the matrix) must be red here and not silent. The
// required names are listed in .github/required-checks.json (a copy of the ruleset's list, kept with the workflow it pins); a check
// run is named by its job's `name:` (the job id when it has none) with `${{ matrix.<key> }}` filled in for each value of the matrix.
// Only a workflow with a `one-gate` job is read, and its comments are removed first.
import { jobBlocks } from "./ci-steps.ts";

const unquote = (value: string): string => value.trim().replace(/^(['"])(.*)\1$/, "$2");

// The check names one job reports: one per combination of the matrix keys its name uses.
const jobCheckNames = (id: string, job: string): readonly string[] => {
  const name = unquote(/^ {4}name:\s*(.+)$/m.exec(job)?.[1] ?? id);
  const keys = [...new Set([...name.matchAll(/\$\{\{\s*matrix\.([\w-]+)\s*\}\}/g)].map((match) => match[1]!))];
  const values = (key: string): readonly string[] =>
    (new RegExp(`^\\s+${key}:\\s*\\[([^\\]]*)\\]`, "m").exec(job)?.[1] ?? "").split(",").map(unquote).filter((value) => value !== "");
  return keys.reduce<readonly string[]>(
    (names, key) => names.flatMap((current) => values(key).map((value) => current.replaceAll(new RegExp(`\\$\\{\\{\\s*matrix\\.${key}\\s*\\}\\}`, "g"), value))),
    [name],
  );
};

// Every check name the workflow reports, or none when it has no `one-gate` job.
export const reportedChecks = (workflow: string): readonly string[] => {
  const jobs = jobBlocks(workflow);
  return jobs["one-gate"] === undefined ? [] : Object.entries(jobs).flatMap(([id, job]) => jobCheckNames(id, job));
};

export const requiredChecks = (json: string): readonly string[] => {
  const contexts: unknown = (JSON.parse(json) as { contexts?: unknown }).contexts;
  return Array.isArray(contexts) ? contexts.filter((context): context is string => typeof context === "string") : [];
};

export const checkProblems = (name: string, workflow: string, required: readonly string[]): readonly string[] => {
  const reported = reportedChecks(workflow);
  return [
    ...(required.length === 0 ? ["CI_CHECK_NONE_REQUIRED .github/required-checks.json lists no required check"] : []),
    ...(reported.length === 0 ? [] : required.filter((context) => !reported.includes(context)).map((context) => `CI_CHECK_NOT_REPORTED ${name} reports no check named "${context}", which the ruleset requires: the PR would wait on it forever`)),
  ];
};
