// What GitHub CI repeats from files it cannot read. A version or a seed list written twice goes stale in one place and
// stays green in the other, so each copy is compared with its source and a mismatch is a problem:
//   - every `bun-version` in a workflow equals `packageManager` in the root package.json (older Bun segfaults on Worker teardown);
//   - the seed matrix of the gate equals the default seeds of `test:seeds` in pure/package.json;
//   - the ast-grep-cli the workflow puts on PATH for rules/ is the one style/check.ts runs through uvx.
export type CiFiles = Readonly<{
  workflows: Readonly<Record<string, string>>;
  rootPackageJson: string;
  pureScripts: string;
  styleCheck: string;
}>;

const firstGroups = (text: string, pattern: RegExp): readonly string[] =>
  [...text.matchAll(pattern)].flatMap((match) => (match[1] === undefined ? [] : [match[1]]));

export const packageManagerBun = (rootPackageJson: string): string | undefined =>
  firstGroups(rootPackageJson, /"packageManager"\s*:\s*"bun@([^"]+)"/g)[0];

export const bunVersions = (workflow: string): readonly string[] => firstGroups(workflow, /bun-version:\s*['"]?([^\s'"]+)/g);

// `seed: ['0', '12345']` in a strategy matrix.
export const matrixSeeds = (workflow: string): readonly string[] | undefined => {
  const row = firstGroups(workflow, /^\s*seed:\s*\[([^\]]*)\]/gm)[0];
  return row === undefined ? undefined : row.split(",").map((seed) => seed.replace(/['"\s]/g, ""));
};

// `${SEEDS:-0 12345 987654}` in the test:seeds script.
export const defaultSeeds = (pureScripts: string): readonly string[] | undefined => {
  const seeds = firstGroups(pureScripts, /\$\{SEEDS:-([^}]+)\}/g)[0];
  return seeds === undefined ? undefined : seeds.trim().split(/\s+/);
};

export const astGrepPins = (text: string): readonly string[] => firstGroups(text, /ast-grep-cli==([0-9][^\s"'`]*)/g);

const same = (left: readonly string[], right: readonly string[]): boolean => left.length === right.length && left.every((item, index) => item === right[index]);

const bunProblems = (files: CiFiles): readonly string[] => {
  const pinned = packageManagerBun(files.rootPackageJson);
  if (pinned === undefined) return ["CI_DRIFT_NO_PACKAGE_MANAGER the root package.json has no packageManager \"bun@<version>\""];
  return Object.entries(files.workflows).flatMap(([name, text]) =>
    bunVersions(text).flatMap((version) => (version === pinned ? [] : [`CI_DRIFT_BUN ${name} sets bun-version ${version}, packageManager says ${pinned}`])),
  );
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
  return Object.entries(files.workflows).flatMap(([name, text]) =>
    astGrepPins(text).flatMap((version) => (version === style ? [] : [`CI_DRIFT_ASTGREP ${name} installs ast-grep-cli ${version}, style/check.ts pins ${style}`])),
  );
};

export const ciDriftProblems = (files: CiFiles): readonly string[] => [...bunProblems(files), ...seedProblems(files), ...astGrepProblems(files)];
