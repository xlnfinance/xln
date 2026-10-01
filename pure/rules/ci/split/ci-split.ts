// The two lanes of the gate workflow. A pull request into development runs only the fast jobs; every other event (a push to main or
// development, a pull request into main, the nightly run, a manual run) runs the whole gate. The split is a few lines of YAML that a
// later edit could change without anyone noticing, so each of them is pinned here (the workflow is given with its comments removed):
//   CI_SPLIT_PUSH         the `push` trigger lists both main and development, so the full set runs on every push to either
//   CI_SPLIT_CONCURRENCY  the group names the event and the ref, and only a pull_request run cancels a run in progress, so a full
//                         run on main or development always finishes (a newer push waits as the one pending run)
//   CI_SPLIT_IF           the only job-level `if` is the one slow-lane condition: not a pull request into development
//   CI_SPLIT_AGGREGATE    `one-gate` fails a skipped fast job, and accepts a skipped slow job only on a pull request into development
// The names the development ruleset requires are `fastChecks`: every job without an `if`, which the test compares with
// `development` in .github/required-checks.json.
import { jobCheckNames } from "../ci-checks.ts";
import { gateJobs, jobBlocks } from "../ci-steps.ts";

export const SLOW_IF = "github.event_name != 'pull_request' || github.base_ref != 'development'";
export const FAST_FLAG = "github.event_name == 'pull_request' && github.base_ref == 'development'";
export const CANCEL_ONLY_PRS = "github.event_name == 'pull_request'";

// An expression with its `${{ }}` and extra spaces removed.
export const expression = (value: string): string => value.trim().replace(/^\$\{\{\s*(.*?)\s*\}\}$/, "$1").replace(/\s+/g, " ");

const jobIf = (job: string): string | undefined => {
  const raw = /^ {4}if:\s*(.*)$/m.exec(job)?.[1];
  return raw === undefined ? undefined : expression(raw);
};

// The check names of the jobs that run on a pull request into development: every job with no `if` (one-gate aside, which is not required there).
export const fastChecks = (workflow: string): readonly string[] => {
  const jobs = jobBlocks(workflow);
  return jobs["one-gate"] === undefined ? [] : Object.entries(jobs).flatMap(([id, job]) => (id === "one-gate" || jobIf(job) !== undefined ? [] : jobCheckNames(id, job)));
};

const concurrencyValue = (workflow: string, key: string): string | undefined => {
  const lines = workflow.split("\n");
  const from = lines.findIndex((line) => /^concurrency:\s*$/.test(line));
  if (from < 0) return undefined;
  const rest = lines.slice(from + 1);
  const block = rest.slice(0, rest.findIndex((line) => /^\S/.test(line)) < 0 ? rest.length : rest.findIndex((line) => /^\S/.test(line)));
  return block.map((line) => new RegExp(`^\\s+${key}:\\s*(.*)$`).exec(line)?.[1]).find((value) => value !== undefined);
};

const pushBranches = (workflow: string): readonly string[] => {
  const listed = /^\s+push:\s*\n\s+branches:\s*\[([^\]]*)\]/m.exec(workflow)?.[1] ?? "";
  return listed.split(",").map((branch) => branch.trim().replace(/^['"]|['"]$/g, "")).filter((branch) => branch !== "");
};

const aggregateProblems = (name: string, workflow: string, jobs: Readonly<Record<string, string>>): readonly string[] => {
  const aggregate = jobs["one-gate"] ?? "";
  const lines = aggregate.split("\n").map((line) => line.trim());
  const flag = lines.map((line) => /^FAST:\s*(.*)$/.exec(line)?.[1]).find((value) => value !== undefined);
  const variables = new Map(lines.flatMap((line) => { const found = /^(\w+):\s*\$\{\{\s*needs\.([\w-]+)\.result\s*\}\}$/.exec(line); return found === null ? [] : [[found[2]!, found[1]!] as const]; }));
  return [
    ...(flag !== undefined && expression(flag) === FAST_FLAG ? [] : [`CI_SPLIT_AGGREGATE ${name} one-gate must set FAST to \`${FAST_FLAG}\``]),
    ...gateJobs(workflow).flatMap((id) => {
      const variable = variables.get(id);
      if (variable === undefined) return [`CI_SPLIT_AGGREGATE ${name} one-gate has no env variable for needs.${id}.result`];
      const bare = `test "$${variable}" = success`;
      const slow = jobIf(jobs[id] ?? "") !== undefined;
      const wanted = slow ? `${bare} || { test "$FAST" = true && test "$${variable}" = skipped; }` : bare;
      return lines.includes(wanted) ? [] : [`CI_SPLIT_AGGREGATE ${name} one-gate must have the line \`${wanted}\` for ${slow ? "the slow job" : "the fast job"} ${id}${slow ? "" : " (a skipped fast job must fail the aggregate)"}`];
    }),
  ];
};

export const splitProblems = (name: string, workflow: string): readonly string[] => {
  const jobs = jobBlocks(workflow);
  if (jobs["one-gate"] === undefined) return [];
  const group = concurrencyValue(workflow, "group") ?? "";
  const cancel = concurrencyValue(workflow, "cancel-in-progress");
  const pushes = pushBranches(workflow);
  return [
    ...["main", "development"].filter((branch) => !pushes.includes(branch)).map((branch) => `CI_SPLIT_PUSH ${name} does not run on push to ${branch}: the full set must run on every push to main and development`),
    ...(group.includes("github.event_name") && group.includes("github.ref") ? [] : [`CI_SPLIT_CONCURRENCY ${name} concurrency group \`${group}\` must name github.event_name and github.ref, so a push run and a pull_request run never share one`]),
    ...(cancel !== undefined && expression(cancel) === CANCEL_ONLY_PRS ? [] : [`CI_SPLIT_CONCURRENCY ${name} cancel-in-progress must be \`\${{ ${CANCEL_ONLY_PRS} }}\`, so a full run on main or development is never cancelled`]),
    ...Object.entries(jobs).flatMap(([id, job]) => {
      const condition = id === "one-gate" ? undefined : jobIf(job);
      return condition === undefined || condition === SLOW_IF ? [] : [`CI_SPLIT_IF ${name} job ${id} has \`if: ${condition}\`; the only job-level if allowed is \`${SLOW_IF}\``];
    }),
    ...aggregateProblems(name, workflow, jobs),
  ];
};
