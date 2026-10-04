// What the jobs behind GitHub's `One gate` run, set against what the local gate runs. A command that CI runs and the local
// gate does not is how a test went red on GitHub alone (the contracts/ BrowserVM tests ran in one CI loop and nowhere else), and a
// gate command that CI stops running is how a local rule goes unchecked. Both are read from the workflow, from code, never from comments:
//   - every `run:` command of a job that `one-gate` needs is a gate command (the local gate's own) or listed set-up (installs,
//     `cd`, the ast-grep script); anything else, say `bun test "$f"` in a loop, is a problem of its own;
//   - every gate command is run by some gate job of a workflow that has a `one-gate` job.
// The commands of the local gate, written as CI writes them: `bun rules/check.ts` (with a --X-only flag for a part), the
// frozen check, the style ratchet, tsc, `bun test` and the seed runs. Each is a command the local one gate runs.
export const GATE_COMMANDS: readonly RegExp[] = [
  /^\.\.\/node_modules\/\.bin\/tsc --noEmit -p \.$/,
  /^bun rules\/check\.ts(?: --[a-z]+-only)?$/,
  /^bun rules\/checks\/frozen\.ts$/,
  /^bun style\/check\.ts$/,
  /^bun test$/,
  /^(?:SEEDS="[^"]*" )?bun run test:seeds$/,
  // The spec suites, run from spec/ (spec/README.md): the Quint check and the Arrival cases (a shard of them in CI).
  /^bash check\.sh$/,
  /^(?:SHARD="[^"]*" )?node test\.mjs$/,
];

// What a gate job may run besides the gate: it puts tools and dependencies in place and moves around.
export const SETUP_COMMANDS: readonly RegExp[] = [
  /^cd [\w./-]+$/,
  /^bun install --frozen-lockfile$/,
  /^bun run forge:setup$/,
  /^bash \.github\/scripts\/setup-ast-grep\.sh uv==\S+ ast-grep-cli==\S+$/,
  // The spec jobs: dependencies, the Arrival build, and the marker of a pass kept in the Actions cache.
  /^npm ci$/,
  /^npm install --global "pnpm@\$\(node -p "require\('\.\/package\.json'\)\.packageManager\.replace\('pnpm@',''\)"\)"$/,
  /^pnpm install --frozen-lockfile$/,
  /^pnpm build$/,
  /^mkdir -p \.spec-passed$/,
  /^echo ok > \.spec-passed\/(?:quint|arrival)$/,
];

// The gate commands every workflow with a `one-gate` job must run somewhere in its gate jobs (the plain `bun rules/check.ts` runs every part).
const REQUIRED: readonly Readonly<{ command: string; pattern: RegExp }>[] = [
  { command: "tsc --noEmit -p .", pattern: GATE_COMMANDS[0]! },
  { command: "bun rules/check.ts", pattern: /^bun rules\/check\.ts$/ },
  { command: "bun rules/checks/frozen.ts", pattern: GATE_COMMANDS[2]! },
  { command: "bun style/check.ts", pattern: GATE_COMMANDS[3]! },
  { command: "bun test", pattern: GATE_COMMANDS[4]! },
  { command: "bun run test:seeds", pattern: GATE_COMMANDS[5]! },
  { command: "bash check.sh", pattern: GATE_COMMANDS[6]! },
  { command: "node test.mjs", pattern: GATE_COMMANDS[7]! },
];

const JOB_START = /^ {2}([\w-]+):\s*$/;

// The text of each job under `jobs:`, by job id. The workflow is given with its comments already removed.
export const jobBlocks = (workflow: string): Readonly<Record<string, string>> => {
  const lines = workflow.split("\n");
  const from = lines.findIndex((line) => /^jobs:\s*$/.test(line));
  if (from < 0) return {};
  const starts = lines.flatMap((line, index) => (index > from && JOB_START.test(line) ? [index] : []));
  return Object.fromEntries(starts.map((start, at) => [JOB_START.exec(lines[start]!)![1]!, lines.slice(start, starts[at + 1] ?? lines.length).join("\n")]));
};

// The jobs a job's `needs:` lists, in any of the three forms YAML has for it: `needs: [a, b]`, `needs: a`, or a block list. Undefined when
// the job has no `needs` or writes it in a form this cannot read.
const needsOf = (job: string): readonly string[] | undefined => {
  const lines = job.split("\n");
  const flow = /^ {4}needs:\s*\[([^\]]*)\]\s*$/m.exec(job)?.[1];
  if (flow !== undefined) return flow.split(",").map((name) => name.trim()).filter((name) => name !== "");
  const scalar = /^ {4}needs:\s*([\w-]+)\s*$/m.exec(job)?.[1];
  if (scalar !== undefined) return [scalar];
  const at = lines.findIndex((line) => /^ {4}needs:\s*$/.test(line));
  if (at < 0) return undefined;
  const items = lines.slice(at + 1).map((line) => /^ {4,6}-\s+([\w-]+)\s*$/.exec(line)?.[1]);
  const end = items.findIndex((item) => item === undefined);
  const listed = (end < 0 ? items : items.slice(0, end)).flatMap((item) => (item === undefined ? [] : [item]));
  return listed.length === 0 ? undefined : listed;
};

// The jobs the `one-gate` job needs. A workflow with no `one-gate` job has none.
export const gateJobs = (workflow: string): readonly string[] => needsOf(jobBlocks(workflow)["one-gate"] ?? "") ?? [];

// A `one-gate` whose needs this cannot read is a problem of its own: every check that starts from its jobs would silently see none.
export const gateNeedsUnreadable = (workflow: string): boolean => {
  const job = jobBlocks(workflow)["one-gate"];
  return job !== undefined && (needsOf(job)?.length ?? 0) === 0;
};

// Every simple command of every `run:` of a job: a one-line `run:` or a `run: |` block, backslash continuations joined,
// then split at `&&` and `;`. A control word (for, do, done, if) is a command of its own, so a shell loop is never one gate command.
export const runCommands = (job: string): readonly string[] => {
  const lines = job.split("\n");
  return lines.flatMap((line, index) => {
    const run = /^(\s*)(?:-\s+)?run:\s*(.*)$/.exec(line);
    if (run === null) return [];
    const indent = run[1]!.length;
    const rest = run[2]!.trim();
    const body = /^[|>][+-]?$/.test(rest)
      ? lines.slice(index + 1).filter((_, offset, after) => after.slice(0, offset + 1).every((each) => each.trim() === "" || each.length - each.trimStart().length > indent))
      : [rest];
    return body
      .join("\n")
      .replace(/\\\n\s*/g, " ")
      .split("\n")
      .flatMap((each) => each.split(/&&|;/))
      .map((each) => each.trim().replace(/\s+/g, " "))
      .filter((each) => each !== "");
  });
};

const isOneOf = (command: string, patterns: readonly RegExp[]): boolean => patterns.some((pattern) => pattern.test(command));

// Problems of one workflow (comments already removed): a gate job command that is neither gate nor set-up, and a gate command no gate job runs.
export const stepProblems = (name: string, workflow: string): readonly string[] => {
  if (gateNeedsUnreadable(workflow)) return [`CI_DRIFT_GATE_JOB ${name} one-gate has no needs this check can read: write them as \`needs: [a, b]\`, \`needs: a\` or a block list`];
  const names = gateJobs(workflow);
  if (names.length === 0) return [];
  const blocks = jobBlocks(workflow);
  const commands = names.flatMap((job) => (blocks[job] === undefined ? [] : runCommands(blocks[job]!).map((command) => ({ job, command }))));
  const missingJobs = names.filter((job) => blocks[job] === undefined).map((job) => `CI_DRIFT_GATE_JOB ${name} one-gate needs ${job}, which is not a job of this workflow`);
  const ungated = commands
    .filter(({ command }) => !isOneOf(command, GATE_COMMANDS) && !isOneOf(command, SETUP_COMMANDS))
    .map(({ job, command }) => `CI_DRIFT_UNGATED_STEP ${name} job ${job} runs \`${command}\`, which no local gate command covers: route it through bun rules/check.ts (a part) or list it as set-up in rules/ci/workflow/ci-steps.ts`);
  const dropped = REQUIRED.filter(({ pattern }) => !commands.some(({ command }) => pattern.test(command))).map(({ command }) => `CI_DRIFT_GATE_MISSING ${name} no gate job runs \`${command}\`, which the local gate runs`);
  return [...missingJobs, ...ungated, ...dropped];
};
