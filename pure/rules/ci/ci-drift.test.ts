// CI repeats a Bun version, the seed list and an ast-grep version from files it does not read. These tests compare the
// real copies, and plant each drift to show the comparison goes red.
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { astGrepPins, bunVersions, ciDriftProblems, defaultSeeds, matrixSeeds, packageManagerBun, type CiFiles } from "./ci-drift.ts";

const repo = `${import.meta.dir}/../../..`;
const workflowDir = `${repo}/.github/workflows`;

const realFiles = (): CiFiles => ({
  workflows: Object.fromEntries(readdirSync(workflowDir).filter((name) => name.endsWith(".yml")).map((name) => [name, readFileSync(`${workflowDir}/${name}`, "utf8")])),
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
  test("packageManager, bun-version, the seed matrix, the default seeds and the pins are read from their own syntax", () => {
    expect(packageManagerBun(planted.rootPackageJson)).toBe("1.4.0");
    expect(bunVersions(planted.workflows["ci.yml"] ?? "")).toEqual(["1.4.0", "1.4.0"]);
    expect(matrixSeeds(planted.workflows["ci.yml"] ?? "")).toEqual(["0", "12345", "987654"]);
    expect(defaultSeeds(planted.pureScripts)).toEqual(["0", "12345", "987654"]);
    expect(astGrepPins(planted.styleCheck)).toEqual(["0.45.3"]);
  });
});

describe("CI repeats nothing that has drifted", () => {
  test("the real workflows, package.json files and style/check.ts agree", () => expect(ciDriftProblems(realFiles())).toEqual([]));

  test("the real files hold at least one copy of each thing compared (the comparison is not vacuous)", () => {
    const files = realFiles();
    expect(Object.values(files.workflows).flatMap(bunVersions).length).toBeGreaterThan(0);
    expect(Object.values(files.workflows).flatMap((text) => matrixSeeds(text) ?? []).length).toBeGreaterThan(0);
    expect(Object.values(files.workflows).flatMap(astGrepPins).length).toBeGreaterThan(0);
  });
});

describe("planted drift is a problem", () => {
  test("the planted baseline agrees", () => expect(ciDriftProblems(planted)).toEqual([]));

  test("a job on another Bun than packageManager", () => {
    const problems = ciDriftProblems(withWorkflow("  bun-version: 1.4.0\n  bun-version: 1.3.14\n"));
    expect(problems).toEqual(["CI_DRIFT_BUN ci.yml sets bun-version 1.3.14, packageManager says 1.4.0"]);
  });

  test("a seed matrix that is not the default of test:seeds", () => {
    expect(ciDriftProblems(withWorkflow("    seed: ['0', '12345']\n"))).toEqual(["CI_DRIFT_SEEDS ci.yml runs seeds 0 12345, test:seeds defaults to 0 12345 987654"]);
    expect(ciDriftProblems(withWorkflow("    seed: ['0', '12345', '1']\n"))).toHaveLength(1);
  });

  test("an ast-grep on PATH that is not the one style/check.ts runs", () => {
    expect(ciDriftProblems(withWorkflow("uv tool install ast-grep-cli==0.46.0\n"))).toEqual(["CI_DRIFT_ASTGREP ci.yml installs ast-grep-cli 0.46.0, style/check.ts pins 0.45.3"]);
  });

  test("an unpinned ast-grep in style/check.ts, a missing packageManager and a missing default are problems, not silence", () => {
    expect(ciDriftProblems({ ...planted, styleCheck: '["uvx", "--from", "ast-grep-cli", "ast-grep"]' })[0]).toContain("CI_DRIFT_ASTGREP_UNPINNED");
    expect(ciDriftProblems({ ...planted, rootPackageJson: "{}" })[0]).toContain("CI_DRIFT_NO_PACKAGE_MANAGER");
    expect(ciDriftProblems({ ...planted, pureScripts: "{}" })[0]).toContain("CI_DRIFT_NO_DEFAULT_SEEDS");
  });
});
