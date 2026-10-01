// What GitHub CI repeats from files it cannot read. A version or a seed list written twice goes stale in one place and
// stays green in the other, so each copy is compared with its source and a mismatch is a problem:
//   - every `bun-version` in a workflow equals `packageManager` in the root package.json (older Bun segfaults on Worker teardown);
//   - the seed matrix of the gate equals the default seeds of `test:seeds` in pure/package.json;
//   - the ast-grep-cli the workflow puts on PATH for rules/ is the one style/check.ts runs through uvx;
//   - every command of a job behind `One gate` is a gate command or set-up, and every gate command runs somewhere (rules/ci/ci-steps.ts);
//   - the workflow starts on every pull request and no job behind `One gate` can be skipped (rules/ci/ci-triggers.ts).
// Each copy is read from code, never from a comment: a comment that still names the pin must not stand in for it. A form
// the comparison cannot read (a setup-bun with no bun-version, a bun-version-file) is a problem of its own, not a pass.
import { stepProblems } from "./ci-steps.ts";
import { triggerProblems } from "./ci-triggers.ts";

export type CiFiles = Readonly<{
  workflows: Readonly<Record<string, string>>;
  rootPackageJson: string;
  pureScripts: string;
  styleCheck: string;
}>;

// Every file in .github/workflows that GitHub runs, whichever extension it carries.
export const isWorkflowFile = (name: string): boolean => /\.ya?ml$/.test(name);

// A YAML or TypeScript line comment: `#` or `//` at the start of a line or after a space (so `https://` and `"#1"` stay).
export const withoutComments = (text: string): string => text.replace(/(^|\s)(#|\/\/).*$/gm, "$1");

const firstGroups = (text: string, pattern: RegExp): readonly string[] =>
  [...text.matchAll(pattern)].flatMap((match) => (match[1] === undefined ? [] : [match[1]]));

export const packageManagerBun = (rootPackageJson: string): string | undefined =>
  firstGroups(rootPackageJson, /"packageManager"\s*:\s*"bun@([^"]+)"/g)[0];

export const bunVersions = (workflow: string): readonly string[] => firstGroups(withoutComments(workflow), /bun-version:\s*['"]?([^\s'"]+)/g);

// The steps of a workflow that call setup-bun: a step starts at a list item with a key (`- name:`, `- uses:`).
export const setupBunSteps = (workflow: string): readonly string[] =>
  withoutComments(workflow)
    .split(/^(?=\s*-\s+[\w-]+:)/m)
    .filter((step) => /uses:\s*oven-sh\/setup-bun@/i.test(step));

// `seed: ['0', '12345']` in a strategy matrix.
export const matrixSeeds = (workflow: string): readonly string[] | undefined => {
  const row = firstGroups(withoutComments(workflow), /^\s*seed:\s*\[([^\]]*)\]/gm)[0];
  return row === undefined ? undefined : row.split(",").map((seed) => seed.replace(/['"\s]/g, ""));
};

// `${SEEDS:-0 12345 987654}` in the test:seeds script.
export const defaultSeeds = (pureScripts: string): readonly string[] | undefined => {
  const seeds = firstGroups(pureScripts, /\$\{SEEDS:-([^}]+)\}/g)[0];
  return seeds === undefined ? undefined : seeds.trim().split(/\s+/);
};

export const astGrepPins = (text: string): readonly string[] => firstGroups(withoutComments(text), /ast-grep-cli==([0-9][^\s"'`]*)/g);

// `ast-grep-cli` named in code with no `==<version>` after it.
export const astGrepUnpinned = (text: string): number => [...withoutComments(text).matchAll(/ast-grep-cli(?!==)/g)].length;

const same = (left: readonly string[], right: readonly string[]): boolean => left.length === right.length && left.every((item, index) => item === right[index]);

const bunProblems = (files: CiFiles): readonly string[] => {
  const pinned = packageManagerBun(files.rootPackageJson);
  if (pinned === undefined) return ["CI_DRIFT_NO_PACKAGE_MANAGER the root package.json has no packageManager \"bun@<version>\""];
  return Object.entries(files.workflows).flatMap(([name, text]) => [
    ...bunVersions(text).flatMap((version) => (version === pinned ? [] : [`CI_DRIFT_BUN ${name} sets bun-version ${version}, packageManager says ${pinned}`])),
    ...setupBunSteps(text).flatMap((step) => [
      ...(/bun-version:/.test(step) || /bun-version-file:/.test(step) ? [] : [`CI_DRIFT_BUN_UNSET ${name} has a setup-bun step with no bun-version`]),
      ...(/bun-version-file:/.test(step) ? [`CI_DRIFT_BUN_FILE ${name} reads the Bun version from a file, which this check cannot compare with packageManager`] : []),
    ]),
  ]);
};

const seedProblems = (files: CiFiles): readonly string[] => {
  const wanted = defaultSeeds(files.pureScripts);
  if (wanted === undefined) return ["CI_DRIFT_NO_DEFAULT_SEEDS pure/package.json test:seeds has no ${SEEDS:-...} default"];
  return Object.entries(files.workflows).flatMap(([name, text]) => {
    const matrix = matrixSeeds(text);
    return matrix === undefined || same(matrix, wanted) ? [] : [`CI_DRIFT_SEEDS ${name} runs seeds ${matrix.join(" ")}, test:seeds defaults to ${wanted.join(" ")}`];
  });
};

const astGrepProblems = (files: CiFiles): readonly string[] => {
  const [style] = astGrepPins(files.styleCheck);
  if (style === undefined) return ["CI_DRIFT_ASTGREP_UNPINNED style/check.ts runs ast-grep-cli without a pinned version"];
  return Object.entries(files.workflows).flatMap(([name, text]) => [
    ...astGrepPins(text).flatMap((version) => (version === style ? [] : [`CI_DRIFT_ASTGREP ${name} installs ast-grep-cli ${version}, style/check.ts pins ${style}`])),
    ...(astGrepUnpinned(text) === 0 ? [] : [`CI_DRIFT_ASTGREP_UNPINNED ${name} installs ast-grep-cli without a pinned version`]),
  ]);
};

const stepsProblems = (files: CiFiles): readonly string[] =>
  Object.entries(files.workflows).flatMap(([name, text]) => [...stepProblems(name, withoutComments(text)), ...triggerProblems(name, withoutComments(text))]);

export const ciDriftProblems = (files: CiFiles): readonly string[] => [...bunProblems(files), ...seedProblems(files), ...astGrepProblems(files), ...stepsProblems(files)];
