// The two lanes of the gate workflow: each way the split could change without anyone noticing, planted, and the real workflow.
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { checkProblems } from "../workflow/ci-checks.ts";
import { ciDriftProblems, isWorkflowFile, withoutComments, type CiFiles } from "../ci-drift.ts";
import { triggerProblems } from "../workflow/ci-triggers.ts";
import { fastChecks, SLOW_IF, splitProblems } from "./ci-split.ts";

const repo = `${import.meta.dir}/../../../..`;
const SLOW = `    if: \${{ ${SLOW_IF} }}`;
const FAST = "          FAST: ${{ github.event_name == 'pull_request' && github.base_ref == 'development' }}";
const ALLOW = (variable: string): string => `          test "$${variable}" = success || test "$FAST:$${variable}" = true:skipped`;

type Plant = Readonly<{ push?: string; group?: string; cancel?: string; slowIf?: string; fastIf?: string; fastFlag?: string; lines?: readonly string[] }>;

// A workflow with two fast jobs, one slow gate job, one slow informational job and the aggregate.
const workflow = (plant: Plant = {}): string =>
  [
    "name: ci",
    "on:",
    "  push:",
    `    branches: ${plant.push ?? "[main, development]"}`,
    "  pull_request:",
    "concurrency:",
    `  group: ${plant.group ?? "build-and-test-${{ github.event_name }}-${{ github.ref }}"}`,
    `  cancel-in-progress: ${plant.cancel ?? "${{ github.event_name == 'pull_request' && !startsWith(github.head_ref, 'promote/') }}"}`,
    "jobs:",
    "  gate-static:",
    "    name: One gate (static)",
    ...(plant.fastIf === undefined ? [] : [`    if: ${plant.fastIf}`]),
    "    steps: []",
    "  gate-tests:",
    "    name: One gate (tests)",
    "    steps: []",
    "  gate-seeds:",
    "    name: One gate (seed ${{ matrix.seed }})",
    plant.slowIf === undefined ? SLOW : `    if: ${plant.slowIf}`,
    "    strategy:",
    "      matrix:",
    "        seed: ['0', '1']",
    "    steps: []",
    "  og:",
    "    name: Runtime Checks (og)",
    SLOW,
    "    steps: []",
    "  one-gate:",
    "    name: One gate",
    "    if: ${{ always() }}",
    "    needs: [gate-static, gate-tests, gate-seeds]",
    "    steps:",
    "      - env:",
    plant.fastFlag ?? FAST,
    "          STATIC: ${{ needs.gate-static.result }}",
    "          TESTS: ${{ needs.gate-tests.result }}",
    "          SEEDS: ${{ needs.gate-seeds.result }}",
    "        run: |",
    ...(plant.lines ?? ['          test "$STATIC" = success', '          test "$TESTS" = success', ALLOW("SEEDS")]),
    "",
  ].join("\n");

const problems = (text: string): readonly string[] => splitProblems("ci.yml", withoutComments(text));
const only = (code: string) => (text: string): readonly string[] => problems(text).filter((problem) => problem.startsWith(code));

describe("the canonical split agrees", () => {
  test("R-GATE-CI-SPLIT the canonical workflow agrees: both pushes, per-event concurrency, one slow-lane if, an aggregate that allows skips only there", () => {
    expect(problems(workflow())).toEqual([]);
    expect(problems(workflow({ push: "['main', \"development\", 'extra']" }))).toEqual([]);
    expect(problems(workflow({ slowIf: SLOW_IF.replace(/ /g, "  ") }))).toEqual([]);
    expect(problems(workflow({ cancel: "${{  github.event_name == 'pull_request'   &&  !startsWith(github.head_ref, 'promote/') }}" }))).toEqual([]);
  });

  test("R-GATE-CI-SPLIT a workflow with no one-gate job is not judged", () => {
    expect(splitProblems("other.yml", "on:\n  push:\n    branches: [x]\njobs:\n  a:\n    if: false\n    steps: []\n")).toEqual([]);
  });

  test("R-GATE-CI-SPLIT the fast checks are the jobs without an if, one-gate aside, and a matrix name is filled in", () => {
    expect(fastChecks(withoutComments(workflow()))).toEqual(["One gate (static)", "One gate (tests)"]);
    expect(fastChecks(withoutComments(workflow().replaceAll(SLOW + "\n", "")))).toEqual(["One gate (static)", "One gate (tests)", "One gate (seed 0)", "One gate (seed 1)", "Runtime Checks (og)"]);
    expect(fastChecks(withoutComments(workflow().replace("    if: ${{ always() }}\n", "")))).toEqual(["One gate (static)", "One gate (tests)"]);
    expect(fastChecks("jobs:\n  a:\n    name: x\n")).toEqual([]);
  });
});

describe("planted changes of the split are problems", () => {
  test("R-GATE-CI-SPLIT a push trigger that leaves out main or development, or cannot be read, is named", () => {
    const push = only("CI_SPLIT_PUSH");
    expect(push(workflow({ push: "[main]" }))).toEqual([expect.stringContaining("does not run on push to development")]);
    expect(push(workflow({ push: "[development]" }))).toEqual([expect.stringContaining("does not run on push to main")]);
    expect(push(workflow({ push: "[main, develop]" }))).toHaveLength(1);
    expect(push(workflow({ push: "[]" }))).toHaveLength(2);
    expect(push(workflow().replace("    branches: [main, development]\n", "    branches:\n      - main\n      - development\n"))).toHaveLength(2);
    expect(push(workflow().replace("  push:\n    branches: [main, development]\n", ""))).toHaveLength(2);
  });

  test("R-GATE-CI-SPLIT a concurrency group without the event or the ref, or a cancel that is not only for pull requests, is named", () => {
    const concurrency = only("CI_SPLIT_CONCURRENCY");
    expect(concurrency(workflow({ group: "build-and-test-${{ github.ref }}" }))).toEqual([expect.stringContaining("must name github.event_name and github.ref")]);
    expect(concurrency(workflow({ group: "build-and-test-${{ github.event_name }}" }))).toHaveLength(1);
    expect(concurrency(workflow({ cancel: "true" }))).toEqual([expect.stringContaining("is never cancelled")]);
    expect(concurrency(workflow({ cancel: "false" }))).toHaveLength(1);
    expect(concurrency(workflow({ cancel: "${{ github.ref != 'refs/heads/main' }}" }))).toHaveLength(1);
    expect(concurrency(workflow({ cancel: "${{ github.event_name != 'pull_request' }}" }))).toHaveLength(1);
    // A snapshot run is never cancelled: the exemption cannot be dropped, widened to other branches, or turned around.
    expect(concurrency(workflow({ cancel: "${{ github.event_name == 'pull_request' }}" }))).toEqual([expect.stringContaining("is never cancelled")]);
    expect(concurrency(workflow({ cancel: "${{ github.event_name == 'pull_request' && !startsWith(github.head_ref, 'claude/') }}" }))).toHaveLength(1);
    expect(concurrency(workflow({ cancel: "${{ github.event_name == 'pull_request' && startsWith(github.head_ref, 'promote/') }}" }))).toHaveLength(1);
    expect(concurrency(workflow().replace(/concurrency:\n.*\n.*\n/, ""))).toHaveLength(2);
  });

  test("R-GATE-CI-SPLIT a job-level if that is not the slow-lane condition is named, on a gate job and on any other job", () => {
    const ifs = only("CI_SPLIT_IF");
    expect(ifs(workflow({ slowIf: "github.base_ref != 'development'" }))).toEqual([expect.stringContaining("CI_SPLIT_IF ci.yml job gate-seeds has `if: github.base_ref != 'development'`")]);
    expect(ifs(workflow({ slowIf: "github.event_name != 'pull_request'" }))).toHaveLength(1);
    expect(ifs(workflow({ slowIf: "github.event_name != 'pull_request' || github.base_ref != 'main'" }))).toHaveLength(1);
    expect(ifs(workflow({ fastIf: "github.event_name == 'push'" }))).toEqual([expect.stringContaining("job gate-static")]);
    expect(ifs(workflow().replace("  og:\n    name: Runtime Checks (og)\n" + SLOW, "  og:\n    name: Runtime Checks (og)\n    if: false"))).toEqual([expect.stringContaining("job og")]);
    expect(ifs(workflow().replace("    if: ${{ always() }}", "    if: ${{ failure() }}"))).toEqual([]);
    const og = (condition: string): string => workflow().replace("  og:\n    name: Runtime Checks (og)\n" + SLOW, `  og:\n    name: Runtime Checks (og)\n    if: ${condition}`);
    expect(ifs(og("github.event_name == 'schedule' || github.event_name == 'workflow_dispatch'"))).toEqual([]);
    expect(ifs(og("github.event_name == 'schedule'"))).toEqual([expect.stringContaining("job og")]);
  });

  test("R-GATE-CI-SPLIT a skipped fast job must fail the aggregate: its line may only be the bare test, never the skip allowance", () => {
    const aggregate = only("CI_SPLIT_AGGREGATE");
    const allowStatic = ALLOW("STATIC");
    expect(aggregate(workflow({ lines: [allowStatic, '          test "$TESTS" = success', ALLOW("SEEDS")] }))).toEqual([expect.stringContaining("the fast job gate-static")]);
    expect(aggregate(workflow({ lines: ['          test "$STATIC" = success', '          test "$TESTS" = success || true', ALLOW("SEEDS")] }))).toEqual([expect.stringContaining("the fast job gate-tests")]);
    expect(aggregate(workflow({ lines: ['          test "$STATIC" = success', ALLOW("SEEDS")] }))).toEqual([expect.stringContaining("the fast job gate-tests")]);
  });

  test("R-GATE-CI-SPLIT a slow job needs exactly the skip allowance: the bare test (red on every development PR), another skip form, or none is named", () => {
    const aggregate = only("CI_SPLIT_AGGREGATE");
    const base = ['          test "$STATIC" = success', '          test "$TESTS" = success'];
    expect(aggregate(workflow({ lines: [...base, '          test "$SEEDS" = success'] }))).toEqual([expect.stringContaining("the slow job gate-seeds")]);
    expect(aggregate(workflow({ lines: [...base, '          test "$SEEDS" = success || test "$SEEDS" = skipped'] }))).toHaveLength(1);
    expect(aggregate(workflow({ lines: [...base, '          test "$SEEDS" = success || { test "$FAST" = true; }'] }))).toHaveLength(1);
    expect(aggregate(workflow({ lines: [...base, ALLOW("SEEDS").replace("true:skipped", "false:skipped")] }))).toHaveLength(1);
    expect(aggregate(workflow({ lines: [...base, ALLOW("SEEDS").replace("skipped", "cancelled")] }))).toHaveLength(1);
    expect(aggregate(workflow({ lines: base }))).toHaveLength(1);
  });

  test("R-GATE-CI-SPLIT FAST must be exactly a pull request into development, and every need must map to an env variable", () => {
    const aggregate = only("CI_SPLIT_AGGREGATE");
    expect(aggregate(workflow({ fastFlag: "          FAST: true" }))).toEqual([expect.stringContaining("must set FAST")]);
    expect(aggregate(workflow({ fastFlag: FAST.replace("== 'development'", "!= 'main'") }))).toHaveLength(1);
    expect(aggregate(workflow({ fastFlag: FAST.replace("pull_request", "push") }))).toHaveLength(1);
    expect(aggregate(workflow().replace(/ {10}SEEDS: .*\n/, ""))).toEqual([expect.stringContaining("no env variable for needs.gate-seeds.result")]);
    expect(aggregate(workflow().replace(/ {10}FAST: .*\n/, ""))).toEqual([expect.stringContaining("must set FAST")]);
  });
});

describe("the other checks leave the slow-lane if alone", () => {
  test("R-GATE-CI-SPLIT the trigger check accepts the slow-lane if on a gate job and still names any other", () => {
    expect(triggerProblems("ci.yml", withoutComments(workflow()))).toEqual([]);
    expect(triggerProblems("ci.yml", withoutComments(workflow({ slowIf: "github.event_name == 'push'" })))).toEqual([expect.stringContaining("CI_TRIGGER_JOB_SKIPPED ci.yml job gate-seeds")]);
  });

  test("R-GATE-CI-SPLIT the split check is part of the drift check", () => {
    const files: CiFiles = {
      workflows: { "ci.yml": workflow({ push: "[main]" }) },
      rootPackageJson: '{ "packageManager": "bun@1.4.0" }',
      pureScripts: '"test:seeds": "for s in ${SEEDS:-0 12345 987654}; do :; done"',
      styleCheck: '["uvx", "--from", "ast-grep-cli==0.45.3", "ast-grep"]',
    };
    expect(ciDriftProblems(files).filter((problem) => problem.startsWith("CI_SPLIT_"))).toEqual([expect.stringContaining("CI_SPLIT_PUSH ci.yml does not run on push to development")]);
  });
});

describe("the real workflow and the real ruleset names", () => {
  const real = readdirSync(`${repo}/.github/workflows`).filter(isWorkflowFile).map((name) => ({ name, text: withoutComments(readFileSync(`${repo}/.github/workflows/${name}`, "utf8")) }));
  const json = readFileSync(`${repo}/.github/required-checks.json`, "utf8");
  const development = (JSON.parse(json) as { development?: readonly string[] }).development ?? [];
  const gate = real.find(({ text }) => text.includes("one-gate:"));

  test("R-GATE-CI-SPLIT the real workflow keeps the split", () => expect(real.flatMap(({ name, text }) => splitProblems(name, text))).toEqual([]));

  test("R-GATE-CI-SPLIT the development ruleset's names are exactly the jobs that run on a pull request into development, and each is reported", () => {
    expect(gate).toBeDefined();
    expect([...fastChecks(gate?.text ?? "")].sort()).toEqual([...development].sort());
    expect(checkProblems("build-and-test.yml", gate?.text ?? "", development)).toEqual([]);
  });

  test("R-GATE-CI-SPLIT the check is not vacuous: two fast names, slow jobs that carry the if, and a push to development", () => {
    expect(development).toEqual(["One gate (tsc, rules, frozen, style)", "One gate (bun test)"]);
    expect((gate?.text.match(/^ {4}if: \$\{\{ github\.event_name != 'pull_request' \|\| github\.base_ref != 'development' \}\}$/gm) ?? []).length).toBeGreaterThanOrEqual(5);
    expect(gate?.text).toMatch(/branches: \[main, development\]/);
    expect(splitProblems("x", (gate?.text ?? "").replace("[main, development]", "[main]")).length).toBeGreaterThan(0);
  });
});

describe("the aggregate, run", () => {
  // The step is a bash script (`bash -e`), so what counts is what it does, not how it reads: every combination of lane and part results,
  // run through the real `run:` block of the real workflow. A failed part must fail it on a full run, whatever the line looks like.
  const body = (): string => {
    const text = readFileSync(`${import.meta.dir}/../../../../.github/workflows/build-and-test.yml`, "utf8");
    const block = /one-gate:[\s\S]*?\n {8}run: \|\n((?: {10}.*\n)+)/.exec(text)?.[1] ?? "";
    return block.split("\n").map((line) => line.slice(10)).join("\n");
  };
  const results = ["success", "failure", "cancelled", "skipped"];
  const slow = ["SEEDS", "QUINT", "ARRIVAL", "FORK"] as const;
  // One row per combination. Each axis is appended to every row so far, starting from a single empty row.
  const product = (axes: readonly (readonly string[])[]): readonly (readonly string[])[] =>
    axes.reduce<readonly (readonly string[])[]>(
      (rows, axis) => rows.flatMap((row) => axis.map((value) => [...row, value])),
      [[]],
    );
  const each = <T>(items: readonly T[], go: (item: T) => void): void => {
    const [head, ...rest] = items;
    if (head === undefined) return;
    go(head);
    each(rest, go);
  };

  test("R-GATE-CI-SPLIT the aggregate step passes exactly when every part passed, or a slow part was skipped on a pull request into development", () => {
    const script = body();
    expect(script).toContain("test");
    const allowed = (fast: string, result: string): boolean => result === "success" || (fast === "true" && result === "skipped");
    const rows = product(slow.map(() => results));
    const run = (env: Readonly<Record<string, string>>): number =>
      Bun.spawnSync(["bash", "-e", "-c", script], { env: { PATH: process.env.PATH ?? "", ...env } }).exitCode ?? 1;
    const quiet = Object.fromEntries(slow.map((name) => [name, "success"]));
    each(["true", "false"], (fast) => {
      each(rows, (row) => {
        const parts = Object.fromEntries(slow.map((name, index) => [name, row[index]!]));
        const passed = row.every((result) => allowed(fast, result));
        const got = run({ FAST: fast, STATIC: "success", TESTS: "success", ...parts }) === 0;
        expect({ fast, ...parts, passed: got }).toEqual({ fast, ...parts, passed });
      });
      each(results.filter((value) => value !== "success"), (result) => {
        expect(run({ FAST: fast, STATIC: result, TESTS: "success", ...quiet }), `static ${result} fast=${fast}`).not.toBe(0);
        expect(run({ FAST: fast, STATIC: "success", TESTS: result, ...quiet }), `tests ${result} fast=${fast}`).not.toBe(0);
      });
    });
  }, 120_000);
});
