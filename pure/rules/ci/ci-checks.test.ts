// The checks the ruleset requires are the checks the workflow reports: the readers, each planted rename, and the real files.
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { isWorkflowFile, withoutComments } from "./ci-drift.ts";
import { checkProblems, reportedChecks, requiredChecks } from "./ci-checks.ts";

const repo = `${import.meta.dir}/../../..`;

const WORKFLOW = [
  "name: ci",
  "jobs:",
  "  gate-a:",
  "    name: One gate (a, b)",
  "    steps: []",
  "  gate-seeds:",
  "    name: One gate (seed ${{ matrix.seed }})",
  "    strategy:",
  "      matrix:",
  "        seed: ['0', \"12345\", 987654]",
  "    steps: []",
  "  unnamed:",
  "    steps: []",
  "  one-gate:",
  "    name: One gate",
  "    needs: [gate-a, gate-seeds]",
  "    steps: []",
  "",
].join("\n");

const REQUIRED = ["One gate (a, b)", "One gate (seed 0)", "One gate (seed 12345)", "One gate (seed 987654)"];

describe("the readers", () => {
  test("R-GATE-CI-CHECK-NAMES a job reports its name, the job id when it has none, and a matrix name once per value", () => {
    expect(reportedChecks(WORKFLOW)).toEqual(["One gate (a, b)", "One gate (seed 0)", "One gate (seed 12345)", "One gate (seed 987654)", "unnamed", "One gate"]);
  });

  test("R-GATE-CI-CHECK-NAMES a matrix name with two keys reports every combination, a key used twice is filled everywhere", () => {
    const text = ["jobs:", "  j:", "    name: t ${{ matrix.a }} ${{ matrix.b }} ${{ matrix.a }}", "    strategy:", "      matrix:", "        a: [x, y]", "        b: [1]", "  one-gate:", "    steps: []", ""].join("\n");
    expect(reportedChecks(text)).toEqual(["t x 1 x", "t y 1 y", "one-gate"]);
  });

  test("R-GATE-CI-CHECK-NAMES only the job's own name counts: a name: deeper in the job is not it, and a matrix key with no values reports no name", () => {
    const text = ["jobs:", "  j:", "    steps:", "      - uses: upload", "        with:", "          name: artifact", "  k:", "    name: t ${{ matrix.gone }}", "  one-gate:", "    steps: []", ""].join("\n");
    expect(reportedChecks(text)).toEqual(["j", "one-gate"]);
  });

  test("R-GATE-CI-CHECK-NAMES a workflow with no one-gate job reports nothing, so it is not judged", () => {
    expect(reportedChecks("jobs:\n  a:\n    name: x\n")).toEqual([]);
    expect(checkProblems("other.yml", "jobs:\n  a:\n    name: x\n", REQUIRED)).toEqual([]);
  });

  test("R-GATE-CI-CHECK-NAMES the required list is read from the contexts of the json, and anything else in it is not a name", () => {
    expect(requiredChecks('{ "contexts": ["a", 1, "b"] }')).toEqual(["a", "b"]);
    expect(requiredChecks('{ "contexts": "a" }')).toEqual([]);
    expect(requiredChecks("{}")).toEqual([]);
  });
});

describe("planted drift is a problem", () => {
  test("R-GATE-CI-CHECK-NAMES the workflow that reports every required name agrees", () => expect(checkProblems("ci.yml", WORKFLOW, REQUIRED)).toEqual([]));

  test("R-GATE-CI-CHECK-NAMES a renamed job, a seed gone from the matrix, a changed name are each named", () => {
    expect(checkProblems("ci.yml", WORKFLOW.replace("One gate (a, b)", "Gate (a, b)"), REQUIRED)).toEqual([expect.stringContaining('CI_CHECK_NOT_REPORTED ci.yml reports no check named "One gate (a, b)"')]);
    expect(checkProblems("ci.yml", WORKFLOW.replace(', "12345"', ""), REQUIRED)).toEqual([expect.stringContaining('"One gate (seed 12345)"')]);
    expect(checkProblems("ci.yml", WORKFLOW.replace("One gate (seed ${{ matrix.seed }})", "One gate (seed)"), REQUIRED)).toHaveLength(3);
    expect(checkProblems("ci.yml", WORKFLOW, [...REQUIRED, "One gate (seed 5)"])).toEqual([expect.stringContaining('"One gate (seed 5)"')]);
  });

  test("R-GATE-CI-CHECK-NAMES a job whose name is dropped reports its id, which is not the required name", () => {
    expect(checkProblems("ci.yml", WORKFLOW.replace("    name: One gate (a, b)\n", ""), REQUIRED)).toEqual([expect.stringContaining('"One gate (a, b)"')]);
  });

  test("R-GATE-CI-CHECK-NAMES an empty required list is a problem of its own, not a pass", () => {
    expect(checkProblems("ci.yml", WORKFLOW, [])).toEqual([expect.stringContaining("CI_CHECK_NONE_REQUIRED")]);
  });
});

describe("the real workflow and the real list", () => {
  const required = requiredChecks(readFileSync(`${repo}/.github/required-checks.json`, "utf8"));
  const real = readdirSync(`${repo}/.github/workflows`).filter(isWorkflowFile).map((name) => ({ name, text: withoutComments(readFileSync(`${repo}/.github/workflows/${name}`, "utf8")) }));

  test("R-GATE-CI-CHECK-NAMES every check the ruleset requires is reported by a job of the real workflow", () => expect(real.flatMap(({ name, text }) => checkProblems(name, text, required))).toEqual([]));

  test("R-GATE-CI-CHECK-NAMES the check is not vacuous: five names are required, and the real One gate workflow reports them", () => {
    expect(required).toHaveLength(5);
    expect(required).toContain("One gate (bun test)");
    const gate = real.find(({ text }) => reportedChecks(text).length > 0);
    expect(gate).toBeDefined();
    expect(reportedChecks(gate?.text ?? "")).toEqual(expect.arrayContaining([...required]));
  });
});
