// CI repeats a Bun version, the seed list and an ast-grep version from files it does not read. These tests compare the
// real copies, and plant each drift to show the comparison goes red.
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { astGrepPins, bunVersions, ciDriftProblems, defaultSeeds, isWorkflowFile, matrixSeeds, packageManagerBun, setupBunSteps, type CiFiles } from "./ci-drift.ts";

const repo = `${import.meta.dir}/../../..`;
const workflowDir = `${repo}/.github/workflows`;

const realFiles = (): CiFiles => ({
  workflows: Object.fromEntries(readdirSync(workflowDir).filter(isWorkflowFile).map((name) => [name, readFileSync(`${workflowDir}/${name}`, "utf8")])),
  rootPackageJson: readFileSync(`${repo}/package.json`, "utf8"),
  pureScripts: readFileSync(`${repo}/pure/package.json`, "utf8"),
  styleCheck: readFileSync(`${repo}/pure/style/check.ts`, "utf8"),
});

const planted: CiFiles = {
  workflows: {
    "ci.yml": "  bun-version: 1.4.0\n  bun-version: 1.4.0\n    seed: ['0', '12345', '987654']\n  uv tool install ast-grep-cli==0.45.3\n",
  },
  rootPackageJson: '{ "packageManager": "bun@1.4.0" }',
  pureScripts: '"test:seeds": "for s in ${SEEDS:-0 12345 987654}; do :; done"',
  styleCheck: '["uvx", "--from", "ast-grep-cli==0.45.3", "ast-grep"]',
};

const withWorkflow = (text: string): CiFiles => ({ ...planted, workflows: { "ci.yml": text } });

describe("the readers", () => {
  test("R-GATE-CI-DRIFT packageManager, bun-version, the seed matrix, the default seeds and the pins are read from their own syntax", () => {
    expect(packageManagerBun(planted.rootPackageJson)).toBe("1.4.0");
    expect(bunVersions(planted.workflows["ci.yml"] ?? "")).toEqual(["1.4.0", "1.4.0"]);
    expect(matrixSeeds(planted.workflows["ci.yml"] ?? "")).toEqual(["0", "12345", "987654"]);
    expect(defaultSeeds(planted.pureScripts)).toEqual(["0", "12345", "987654"]);
    expect(astGrepPins(planted.styleCheck)).toEqual(["0.45.3"]);
  });
});

describe("CI repeats nothing that has drifted", () => {
  test("R-GATE-CI-DRIFT the real workflows, package.json files and style/check.ts agree", () => expect(ciDriftProblems(realFiles())).toEqual([]));

  test("R-GATE-CI-DRIFT the real files hold at least one copy of each thing compared (the comparison is not vacuous)", () => {
    const files = realFiles();
    expect(Object.values(files.workflows).flatMap(bunVersions).length).toBeGreaterThan(0);
    expect(Object.values(files.workflows).flatMap((text) => matrixSeeds(text) ?? []).length).toBeGreaterThan(0);
    expect(Object.values(files.workflows).flatMap(astGrepPins).length).toBeGreaterThan(0);
  });
});

describe("planted drift is a problem", () => {
  test("R-GATE-CI-DRIFT the planted baseline agrees", () => expect(ciDriftProblems(planted)).toEqual([]));

  test("R-GATE-CI-DRIFT a job on another Bun than packageManager", () => {
    const problems = ciDriftProblems(withWorkflow("  bun-version: 1.4.0\n  bun-version: 1.3.14\n"));
    expect(problems).toEqual(["CI_DRIFT_BUN ci.yml sets bun-version 1.3.14, packageManager says 1.4.0"]);
  });

  test("R-GATE-CI-DRIFT a seed matrix that is not the default of test:seeds", () => {
    expect(ciDriftProblems(withWorkflow("    seed: ['0', '12345']\n"))).toEqual(["CI_DRIFT_SEEDS ci.yml runs seeds 0 12345, test:seeds defaults to 0 12345 987654"]);
    expect(ciDriftProblems(withWorkflow("    seed: ['0', '12345', '1']\n"))).toHaveLength(1);
  });

  test("R-GATE-CI-DRIFT an ast-grep on PATH that is not the one style/check.ts runs", () => {
    expect(ciDriftProblems(withWorkflow("uv tool install ast-grep-cli==0.46.0\n"))).toEqual(["CI_DRIFT_ASTGREP ci.yml installs ast-grep-cli 0.46.0, style/check.ts pins 0.45.3"]);
  });

  test("R-GATE-CI-DRIFT an unpinned ast-grep in style/check.ts, a missing packageManager and a missing default are problems, not silence", () => {
    expect(ciDriftProblems({ ...planted, styleCheck: '["uvx", "--from", "ast-grep-cli", "ast-grep"]' })[0]).toContain("CI_DRIFT_ASTGREP_UNPINNED");
    expect(ciDriftProblems({ ...planted, rootPackageJson: "{}" })[0]).toContain("CI_DRIFT_NO_PACKAGE_MANAGER");
    expect(ciDriftProblems({ ...planted, pureScripts: "{}" })[0]).toContain("CI_DRIFT_NO_DEFAULT_SEEDS");
  });
});

const setupBun = (withLines: string): string => `    steps:\n      - name: Setup Bun\n        uses: oven-sh/setup-bun@0123456789abcdef\n${withLines}      - name: Test\n        run: bun test\n`;

describe("forms the comparison cannot read are problems, not passes", () => {
  test("R-GATE-CI-DRIFT a setup-bun step with no bun-version is a problem, and a bun-version in another step does not rescue it", () => {
    expect(ciDriftProblems(withWorkflow(setupBun("")))).toEqual(["CI_DRIFT_BUN_UNSET ci.yml has a setup-bun step with no bun-version"]);
    const rescued = `${setupBun("")}      - name: Elsewhere\n        uses: other/action@1\n        with:\n          bun-version: 1.4.0\n`;
    expect(ciDriftProblems(withWorkflow(rescued))).toEqual(["CI_DRIFT_BUN_UNSET ci.yml has a setup-bun step with no bun-version"]);
    expect(ciDriftProblems(withWorkflow(setupBun("        with:\n          bun-version: 1.4.0\n")))).toEqual([]);
  });

  test("R-GATE-CI-DRIFT bun-version-file is a problem: the file cannot be compared with packageManager", () => {
    const problems = ciDriftProblems(withWorkflow(setupBun("        with:\n          bun-version-file: .bun-version\n")));
    expect(problems).toEqual(["CI_DRIFT_BUN_FILE ci.yml reads the Bun version from a file, which this check cannot compare with packageManager"]);
  });

  test("R-GATE-CI-DRIFT a setup-bun step is found with its with-block, whatever else sits around it", () => {
    const text = `jobs:\n  a:\n${setupBun("        with:\n          bun-version: 1.4.0\n")}  b:\n${setupBun("")}`;
    expect(setupBunSteps(text)).toHaveLength(2);
    expect(ciDriftProblems(withWorkflow(text))).toEqual(["CI_DRIFT_BUN_UNSET ci.yml has a setup-bun step with no bun-version"]);
  });

  test("R-GATE-CI-DRIFT a workflow named .yaml is read, and so is every file in .github/workflows", () => {
    expect(isWorkflowFile("build.yaml")).toBe(true);
    expect(isWorkflowFile("build.yml")).toBe(true);
    expect(isWorkflowFile("notes.md")).toBe(false);
    expect(ciDriftProblems({ ...planted, workflows: { "other.yaml": "  bun-version: 1.3.14\n" } })).toEqual(["CI_DRIFT_BUN other.yaml sets bun-version 1.3.14, packageManager says 1.4.0"]);
    const names = readdirSync(workflowDir);
    expect(names.length).toBeGreaterThan(0);
    expect(names.filter((name) => !isWorkflowFile(name))).toEqual([]);
    expect(Object.keys(realFiles().workflows).sort()).toEqual([...names].sort());
  });

  test("R-GATE-CI-DRIFT an install that lost its pin is a problem even when a comment still names the pin", () => {
    const stale = "# installs ast-grep-cli==0.45.3 for rules/\n  uv tool install ast-grep-cli\n";
    expect(ciDriftProblems(withWorkflow(stale))).toEqual(["CI_DRIFT_ASTGREP_UNPINNED ci.yml installs ast-grep-cli without a pinned version"]);
    expect(ciDriftProblems(withWorkflow("  uv tool install ast-grep-cli==0.45.3 # pinned\n"))).toEqual([]);
    expect(ciDriftProblems(withWorkflow("  uv tool install ast-grep-cli # was ast-grep-cli==0.45.3\n"))).toEqual(["CI_DRIFT_ASTGREP_UNPINNED ci.yml installs ast-grep-cli without a pinned version"]);
  });

  test("R-GATE-CI-DRIFT a comment is never a copy: a commented bun-version, seed matrix or pin counts for nothing", () => {
    expect(astGrepPins("// ast-grep-cli==0.45.3\n")).toEqual([]);
    expect(bunVersions("  # bun-version: 1.4.0\n")).toEqual([]);
    expect(matrixSeeds("    # seed: ['0']\n")).toBeUndefined();
    expect(ciDriftProblems({ ...planted, styleCheck: '["uvx", "--from", "ast-grep-cli", "ast-grep"] // was ast-grep-cli==0.45.3' })[0]).toContain("CI_DRIFT_ASTGREP_UNPINNED");
    expect(bunVersions("  uses: x # y\n  url: https://a/#b\n  bun-version: 1.4.0\n")).toEqual(["1.4.0"]);
  });

  test("R-GATE-CI-DRIFT the same plants on the real build-and-test.yml go red (its own syntax, its own comments)", () => {
    const real = realFiles();
    const text = real.workflows["build-and-test.yml"] ?? "";
    const noVersion = text.replace(/^\s*bun-version:.*\n/m, "");
    expect(ciDriftProblems({ ...real, workflows: { "build-and-test.yml": noVersion } }).map((problem) => problem.split(" ")[0])).toEqual(["CI_DRIFT_BUN_UNSET"]);
    const unpinned = text.replace("uv tool install ast-grep-cli==", "uv tool install ast-grep-cli #==");
    expect(unpinned).not.toBe(text);
    expect(ciDriftProblems({ ...real, workflows: { "build-and-test.yml": unpinned } }).map((problem) => problem.split(" ")[0])).toContain("CI_DRIFT_ASTGREP_UNPINNED");
    const byFile = text.replace(/^(\s*)bun-version:.*$/m, "$1bun-version-file: .bun-version");
    expect(ciDriftProblems({ ...real, workflows: { "build-and-test.yml": byFile } }).map((problem) => problem.split(" ")[0])).toContain("CI_DRIFT_BUN_FILE");
  });
});
