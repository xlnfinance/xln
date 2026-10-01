// The checks the ruleset requires are the checks the workflow reports: the readers, each planted rename, and the real files.
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { isWorkflowFile, withoutComments } from "../ci-drift.ts";
import { aggregateProblems, checkProblems, plannedChecks, reportedChecks, requiredChecks } from "./ci-checks.ts";

const repo = `${import.meta.dir}/../../../..`;

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
    expect(plannedChecks('{ "contexts": ["a"], "planned": ["p", 2] }')).toEqual(["p"]);
    expect(plannedChecks('{ "contexts": ["a"] }')).toEqual([]);
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

describe("the aggregate holds every One gate job", () => {
  const AGGREGATED = WORKFLOW.replace("    steps: []\n  gate-seeds:", "    steps: []\n  gate-seeds:").replace("needs: [gate-a, gate-seeds]\n    steps: []", "needs: [gate-a, gate-seeds]\n    steps:\n      - run: test \"${{ needs.gate-a.result }}\" = success && test \"${{ needs.gate-seeds.result }}\" = success");

  test("R-GATE-CI-CHECK-NAMES a one-gate that needs every One gate (...) job and reads each result agrees", () => {
    expect(aggregateProblems("ci.yml", AGGREGATED)).toEqual([]);
    expect(aggregateProblems("o.yml", "jobs:\n  a:\n    name: One gate (x)\n")).toEqual([]);
  });

  test("R-GATE-CI-CHECK-NAMES a One gate (...) job that one-gate does not need is named, so adding a job cannot leave it out", () => {
    const plant = AGGREGATED.replace("  unnamed:", "  gate-new:\n    name: One gate (new)\n    steps: []\n  unnamed:");
    expect(aggregateProblems("ci.yml", plant)).toEqual([expect.stringContaining("CI_CHECK_UNAGGREGATED ci.yml job gate-new")]);
    expect(aggregateProblems("ci.yml", plant.replace("name: One gate (new)", 'name: "One gate (new)"'))).toHaveLength(1);
    expect(aggregateProblems("ci.yml", plant.replace("name: One gate (new)", "name: Other"))).toEqual([]);
    expect(aggregateProblems("ci.yml", plant.replace("name: One gate (new)", "name: One gate extra"))).toHaveLength(1);
    expect(aggregateProblems("ci.yml", plant.replace("name: One gate (new)", "name: One gated"))).toEqual([]);
  });

  test("R-GATE-CI-CHECK-NAMES a need whose result one-gate never reads is named", () => {
    expect(aggregateProblems("ci.yml", AGGREGATED.replace('&& test "${{ needs.gate-seeds.result }}" = success', ""))).toEqual([expect.stringContaining("CI_CHECK_UNREAD ci.yml one-gate needs gate-seeds but never tests that needs.gate-seeds.result is success")]);
    expect(aggregateProblems("ci.yml", WORKFLOW)).toHaveLength(2);
  });

  test("R-GATE-CI-CHECK-NAMES a result that is only mentioned, never compared with success, is not tested; an env variable mapped to it is", () => {
    const unread = (text: string): readonly string[] => aggregateProblems("ci.yml", text).filter((problem) => problem.includes("CI_CHECK_UNREAD"));
    const echoed = AGGREGATED.replace('test "${{ needs.gate-seeds.result }}" = success', 'echo "${{ needs.gate-seeds.result }}"');
    expect(unread(echoed)).toEqual([expect.stringContaining("needs gate-seeds but never tests")]);
    const viaEnv = AGGREGATED.replace('test "${{ needs.gate-seeds.result }}" = success', 'test "$SEEDS" = success').replace("    steps:\n      - run:", "    steps:\n      - env:\n          SEEDS: ${{ needs.gate-seeds.result }}\n        run:");
    expect(viaEnv).toContain("SEEDS: ${{");
    expect(unread(viaEnv)).toEqual([]);
    expect(unread(viaEnv.replace('test "$SEEDS" = success', 'echo "$SEEDS"'))).toEqual([expect.stringContaining("needs gate-seeds but never tests")]);
    expect(unread(viaEnv.replace('test "$SEEDS" = success', 'test "$OTHER" = success'))).toEqual([expect.stringContaining("needs gate-seeds but never tests")]);
    expect(unread(viaEnv.replace('test "$SEEDS" = success', 'test "${SEEDS}" = success'))).toEqual([]);
    expect(unread(viaEnv.replace('test "$SEEDS" = success', 'test "$SEEDS" = failure'))).toEqual([expect.stringContaining("needs gate-seeds but never tests")]);
  });

  test("R-GATE-CI-CHECK-NAMES a gate job, or a step of one, with continue-on-error is named, false is not", () => {
    const on = (value: string): readonly string[] => aggregateProblems("ci.yml", AGGREGATED.replace("  gate-seeds:\n", `  gate-seeds:\n    continue-on-error: ${value}\n`)).filter((problem) => problem.includes("CI_CHECK_CONTINUE_ON_ERROR"));
    expect(on("true")).toEqual([expect.stringContaining("CI_CHECK_CONTINUE_ON_ERROR ci.yml gate job gate-seeds")]);
    expect(on("${{ matrix.x }}")).toHaveLength(1);
    expect(on("false")).toEqual([]);
    const step = AGGREGATED.replace("  gate-seeds:\n", "  gate-seeds:\n    steps:\n      - run: x\n        continue-on-error: true\n");
    expect(aggregateProblems("ci.yml", step).filter((problem) => problem.includes("CONTINUE_ON_ERROR"))).toHaveLength(1);
    expect(aggregateProblems("ci.yml", AGGREGATED.replace("  unnamed:", "  gate-other:\n    continue-on-error: true\n  unnamed:"))).toEqual([]);
  });
});

describe("the real workflow and the real list", () => {
  const json = readFileSync(`${repo}/.github/required-checks.json`, "utf8");
  const required = requiredChecks(json);
  const planned = plannedChecks(json);
  const real = readdirSync(`${repo}/.github/workflows`).filter(isWorkflowFile).map((name) => ({ name, text: withoutComments(readFileSync(`${repo}/.github/workflows/${name}`, "utf8")) }));

  test("R-GATE-CI-CHECK-NAMES every check the ruleset requires is reported by a job of the real workflow", () => {
    expect(real.flatMap(({ name, text }) => checkProblems(name, text, required))).toEqual([]);
  });

  test("R-GATE-CI-CHECK-NAMES every check planned for the ruleset is reported by a job of the real workflow", () => {
    expect(real.flatMap(({ name, text }) => checkProblems(name, text, planned))).toEqual([]);
  });

  test("R-GATE-CI-CHECK-NAMES the real one-gate needs every One gate (...) job and reads every result", () => expect(real.flatMap(({ name, text }) => aggregateProblems(name, text))).toEqual([]));

  test("R-GATE-CI-CHECK-NAMES the check is not vacuous: five names are required, and the real One gate workflow reports them", () => {
    expect(required).toHaveLength(5);
    expect(planned).toEqual(["One gate"]);
    expect(planned).toContain("One gate");
    expect(required).toContain("One gate (bun test)");
    const gate = real.find(({ text }) => reportedChecks(text).length > 0);
    expect(gate).toBeDefined();
    expect(reportedChecks(gate?.text ?? "")).toEqual(expect.arrayContaining([...required]));
  });
});
