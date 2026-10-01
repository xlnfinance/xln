// Whether the workflow behind `One gate` can skip a pull request. The five `One gate` checks are required, and a required check that
// never starts leaves the PR blocked forever, so the workflow must start on every PR whatever base it targets or files it touches:
//   - `pull_request` is a trigger, with no `branches`, `branches-ignore`, `paths`, `paths-ignore` or `types` filter;
//   - no job behind `one-gate` has a job-level `if` but the slow-lane one (a skipped job reports success to a required check; the slow
//     lane skips only on a pull request into development, where no slow job is required: split/ci-split.ts);
//   - `one-gate` itself has no `if` but `${{ always() }}`, which makes it run and fail when a part failed instead of skipping with it.
// A workflow with no `one-gate` job is not judged. The workflow is given with its comments already removed.
import { gateJobs, jobBlocks } from "./ci-steps.ts";
import { expression, SLOW_IF } from "./split/ci-split.ts";

const FILTERS = ["branches", "branches-ignore", "paths", "paths-ignore", "types"];

// The lines of the top-level `on:` block (what follows it, up to the next key at column 0), or its inline value.
const onBlock = (workflow: string): Readonly<{ inline: string; lines: readonly string[] }> | undefined => {
  const lines = workflow.split("\n");
  const from = lines.findIndex((line) => /^["']?on["']?:/.test(line));
  if (from < 0) return undefined;
  const rest = lines.slice(from + 1);
  const length = rest.findIndex((line) => /^\S/.test(line));
  return { inline: lines[from]!.replace(/^["']?on["']?:\s*/, "").trim(), lines: length < 0 ? rest : rest.slice(0, length) };
};

// The lines under `pull_request:` inside the `on:` block, deeper than the key itself.
const pullRequestLines = (lines: readonly string[]): readonly string[] | undefined => {
  const from = lines.findIndex((line) => /^\s+pull_request:/.test(line));
  if (from < 0) return undefined;
  const indent = /^(\s*)/.exec(lines[from]!)![1]!.length;
  const rest = lines.slice(from + 1);
  const length = rest.findIndex((line) => line.trim() !== "" && /^(\s*)/.exec(line)![1]!.length <= indent);
  return length < 0 ? rest : rest.slice(0, length);
};

export const triggerProblems = (name: string, workflow: string): readonly string[] => {
  const jobs = jobBlocks(workflow);
  if (jobs["one-gate"] === undefined) return [];
  const on = onBlock(workflow);
  const filters = pullRequestLines(on?.lines ?? [])?.flatMap((line) => FILTERS.filter((key) => new RegExp(`^\\s+${key}:`).test(line))) ?? [];
  const listed = on !== undefined && (/\bpull_request\b/.test(on.inline) || pullRequestLines(on.lines) !== undefined);
  const jobIf = (job: string): string | undefined => /^ {4}if:\s*(.*)$/m.exec(jobs[job] ?? "")?.[1]?.trim();
  return [
    ...(listed ? [] : [`CI_TRIGGER_NO_PULL_REQUEST ${name} does not run on pull_request, so a PR never gets the One gate checks`]),
    ...filters.map((key) => `CI_TRIGGER_FILTER ${name} pull_request is filtered by ${key}, so a PR outside the filter never gets the One gate checks`),
    ...gateJobs(workflow).flatMap((job) => (jobIf(job) === undefined || expression(jobIf(job)!) === SLOW_IF ? [] : [`CI_TRIGGER_JOB_SKIPPED ${name} job ${job} has \`if: ${jobIf(job)}\`: a skipped job reports success to a required check`])),
    ...(jobIf("one-gate") === undefined || /^\$\{\{\s*always\(\)\s*\}\}$/.test(jobIf("one-gate")!) ? [] : [`CI_TRIGGER_JOB_SKIPPED ${name} job one-gate has \`if: ${jobIf("one-gate")}\`; only \`\${{ always() }}\` is allowed`]),
  ];
};
