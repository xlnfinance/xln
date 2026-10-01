// The names the repository's ruleset requires, against the names the workflow reports. A required check that no job reports never
// finishes, and the PR waits on it forever, so renaming a job (or a seed leaving the matrix) must be red here and not silent. The
// required names are listed in .github/required-checks.json (a copy of the ruleset's list, kept with the workflow it pins, and the names
// planned to join it); a check
// run is named by its job's `name:` (the job id when it has none) with `${{ matrix.<key> }}` filled in for each value of the matrix.
// Only a workflow with a `one-gate` job is read, and its comments are removed first.
import { gateJobs, jobBlocks } from "./ci-steps.ts";

const unquote = (value: string): string => value.trim().replace(/^(['"])(.*)\1$/, "$2");

// The check names one job reports: one per combination of the matrix keys its name uses.
export const jobCheckNames = (id: string, job: string): readonly string[] => {
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

const namesUnder = (json: string, key: "contexts" | "planned"): readonly string[] => {
  const names: unknown = (JSON.parse(json) as Readonly<Record<string, unknown>>)[key];
  return Array.isArray(names) ? names.filter((name): name is string => typeof name === "string") : [];
};

// What the ruleset requires now, and what is planned to be required (jobs that run already, not yet in the ruleset).
export const requiredChecks = (json: string): readonly string[] => namesUnder(json, "contexts");
export const plannedChecks = (json: string): readonly string[] => namesUnder(json, "planned");

export const checkProblems = (name: string, workflow: string, required: readonly string[]): readonly string[] => {
  const reported = reportedChecks(workflow);
  return [
    ...(required.length === 0 ? ["CI_CHECK_NONE_REQUIRED .github/required-checks.json lists no required check"] : []),
    ...(reported.length === 0 ? [] : required.filter((context) => !reported.includes(context)).map((context) => `CI_CHECK_NOT_REPORTED ${name} reports no check named "${context}", which the ruleset requires: the PR would wait on it forever`)),
  ];
};

// A need's result is tested when the aggregate compares it with success: `test "${{ needs.x.result }}" = success`, or the same through an
// env variable mapped to it (`VAR: ${{ needs.x.result }}` and `test "$VAR" = success`). A mention that is never compared is not a test.
const resultIsTested = (aggregate: string, id: string): boolean => {
  const inline = `\\$\\{\\{\\s*needs\\.${id.replace(/[-.]/g, "\\$&")}\\.result\\s*\\}\\}`;
  const vars = [...aggregate.matchAll(new RegExp(`^\\s*(\\w+):\\s*${inline}\\s*$`, "gm"))].map((match) => `\\$\\{?${match[1]}\\}?`);
  return [inline, ...vars].some((ref) => new RegExp(`\\btest\\s+"${ref}"\\s+=\\s+success\\b`).test(aggregate));
};

// The aggregate is the one name to require, so nothing may sit outside it: every job named `One gate ...` is a need of `one-gate`,
// `one-gate` tests each need's result against success (a need it never compares can fail and the aggregate still pass), and no gate job
// carries continue-on-error (its red would not fail the job, so it would not fail the aggregate either).
//   CI_CHECK_UNAGGREGATED         a job named One gate ... that one-gate does not need
//   CI_CHECK_UNREAD               a need of one-gate whose `needs.<job>.result` the job never tests against success
//   CI_CHECK_CONTINUE_ON_ERROR    a gate job (or one of its steps) with continue-on-error other than false
export const aggregateProblems = (name: string, workflow: string): readonly string[] => {
  const jobs = jobBlocks(workflow);
  const aggregate = jobs["one-gate"];
  if (aggregate === undefined) return [];
  const needs = gateJobs(workflow);
  return [
    ...Object.entries(jobs)
      .filter(([id, job]) => id !== "one-gate" && /^ {4}name:\s*['"]?One gate\b/m.test(job) && !needs.includes(id))
      .map(([id]) => `CI_CHECK_UNAGGREGATED ${name} job ${id} is named One gate ... but one-gate does not need it: it could fail and the aggregate still pass`),
    ...needs.filter((id) => !resultIsTested(aggregate, id)).map((id) => `CI_CHECK_UNREAD ${name} one-gate needs ${id} but never tests that needs.${id}.result is success`),
    ...needs.filter((id) => /^\s*continue-on-error:\s*(?!false\s*$)\S/m.test(jobs[id] ?? "")).map((id) => `CI_CHECK_CONTINUE_ON_ERROR ${name} gate job ${id} has continue-on-error, so its red would not fail the aggregate`),
  ];
};
