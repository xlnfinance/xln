// The workflow behind One gate starts on every pull request and cannot skip a gate job: each way it could not, planted, and the real workflow.
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { ciDriftProblems, isWorkflowFile, withoutComments, type CiFiles } from "../ci-drift.ts";
import { jobBlocks } from "./ci-steps.ts";
import { triggerProblems } from "./ci-triggers.ts";

const repo = `${import.meta.dir}/../../../..`;
const workflowDir = `${repo}/.github/workflows`;

const workflow = (on: readonly string[], gateJob: readonly string[] = [], oneGate: readonly string[] = ["    if: ${{ always() }}"]): string =>
  ["name: ci", "on:", ...on, "concurrency:", "  group: x", "jobs:", "  gate:", ...gateJob, "    steps: []", "  one-gate:", ...oneGate, "    needs: [gate]", "    steps: []", ""].join("\n");

const PR = ["  push:", "    branches: [main]", "  pull_request:", "  workflow_dispatch:"];
const problems = (text: string): readonly string[] => triggerProblems("ci.yml", withoutComments(text));

describe("a workflow that starts on every pull request", () => {
  test("R-GATE-CI-TRIGGERS pull_request with no filter, and a one-gate that always runs, agree", () => {
    expect(problems(workflow(PR))).toEqual([]);
    expect(problems(workflow(["  pull_request:", "    # branches: [main]"]))).toEqual([]);
  });

  test("R-GATE-CI-TRIGGERS the inline forms of on: that include pull_request agree, and a push filter on another event is none of its business", () => {
    expect(problems(workflow([]).replace("on:", "on: [push, pull_request]"))).toEqual([]);
    expect(problems(workflow([]).replace("on:", "on: pull_request"))).toEqual([]);
    expect(problems(workflow(["  push:", "    paths: ['a/**']", "  pull_request:"]))).toEqual([]);
  });

  test("R-GATE-CI-TRIGGERS a workflow with no one-gate job is not judged", () => {
    expect(triggerProblems("other.yml", "on:\n  push:\n    branches: [main]\njobs:\n  a:\n    steps: []\n")).toEqual([]);
  });
});

describe("planted skips are problems", () => {
  test("R-GATE-CI-TRIGGERS a workflow that does not run on pull_request is named", () => {
    expect(problems(workflow(["  push:", "    branches: [main]"]))).toEqual([expect.stringContaining("CI_TRIGGER_NO_PULL_REQUEST ci.yml")]);
    expect(problems(workflow([]).replace("on:", "on: push"))).toEqual([expect.stringContaining("CI_TRIGGER_NO_PULL_REQUEST")]);
    expect(problems(workflow([]).replace("on:\n", ""))).toEqual([expect.stringContaining("CI_TRIGGER_NO_PULL_REQUEST")]);
  });

  test("R-GATE-CI-TRIGGERS every filter on pull_request is named: branches, branches-ignore, paths, paths-ignore, types", () => {
    ["branches: [main]", "branches-ignore: [wip]", "paths: ['pure/**']", "paths-ignore: ['**.md']", "types: [opened]"].forEach((filter) => {
      const found = problems(workflow(["  pull_request:", `    ${filter}`]));
      expect(found, filter).toEqual([expect.stringContaining(`CI_TRIGGER_FILTER ci.yml pull_request is filtered by ${filter.split(":")[0]}`)]);
    });
    expect(problems(workflow(["  pull_request:", "    branches: [main]", "    paths: [a]"]))).toHaveLength(2);
  });

  test("R-GATE-CI-TRIGGERS flow-style forms are read: a filter inside pull_request: { ... }, or inside on: { ... }, is named like a block one", () => {
    expect(problems(workflow(["  pull_request: { paths: ['pure/**'] }"]))).toEqual([expect.stringContaining("filtered by paths")]);
    expect(problems(workflow(["  pull_request: { branches: [main], types: [opened] }"]))).toHaveLength(2);
    expect(problems(workflow([]).replace("on:", "on: { pull_request: { branches-ignore: [wip] }, push: {} }"))).toEqual([expect.stringContaining("filtered by branches-ignore")]);
    expect(problems(workflow([]).replace("on:", "on: { push: { paths: [a] }, pull_request: { paths-ignore: [b] } }"))).toEqual([expect.stringContaining("filtered by paths-ignore")]);
  });

  test("R-GATE-CI-TRIGGERS flow-style forms without a filter agree, and a flow value that cannot be read for filters is a problem of its own", () => {
    expect(problems(workflow(["  pull_request: {}"]))).toEqual([]);
    expect(problems(workflow(["  pull_request: null"]))).toEqual([]);
    expect(problems(workflow(["  pull_request: ~"]))).toEqual([]);
    expect(problems(workflow([]).replace("on:", "on: { pull_request: null, push: {} }"))).toEqual([]);
    expect(problems(workflow([]).replace("on:", "on: { push: {}, pull_request: {} }"))).toEqual([]);
    expect(problems(workflow(["  pull_request: ${{ vars.TRIGGER }}"]))).toEqual([expect.stringContaining("CI_TRIGGER_UNREADABLE ci.yml writes pull_request as")]);
    expect(problems(workflow(["  pull_request: &anchor"]))).toEqual([expect.stringContaining("CI_TRIGGER_UNREADABLE")]);
    expect(problems(workflow([]).replace("on:", "on: { pull_request: anchored, push: {} }"))).toEqual([expect.stringContaining("CI_TRIGGER_UNREADABLE")]);
  });

  test("R-GATE-CI-TRIGGERS a filter that sits under another event, after pull_request, is not read as pull_request's", () => {
    expect(problems(workflow(["  pull_request:", "  push:", "    branches: [main]", "    paths: [a]"]))).toEqual([]);
  });

  test("R-GATE-CI-TRIGGERS a filter after a blank line of the pull_request block is still named", () => {
    expect(problems(workflow(["  pull_request:", "", "    branches: [main]"]))).toEqual([expect.stringContaining("filtered by branches")]);
  });

  test("R-GATE-CI-TRIGGERS only the on: block is read for the trigger: a job or a key that merely ends in pull_request is not one", () => {
    expect(problems(workflow(["  push:"]).replace("jobs:\n", "jobs:\n  pull_request:\n    steps: []\n"))).toEqual([expect.stringContaining("CI_TRIGGER_NO_PULL_REQUEST")]);
    expect(problems(workflow(["  push:", "  not_pull_request:"]))).toEqual([expect.stringContaining("CI_TRIGGER_NO_PULL_REQUEST")]);
  });

  test("R-GATE-CI-TRIGGERS a gate job with a job-level if is named, one-gate with any if but always() too", () => {
    expect(problems(workflow(PR, ["    if: github.event_name == 'push'"]))).toEqual([expect.stringContaining("CI_TRIGGER_JOB_SKIPPED ci.yml job gate has `if: github.event_name == 'push'`")]);
    expect(problems(workflow(PR, [], ["    if: github.actor != 'bot'"]))).toEqual([expect.stringContaining("job one-gate has `if: github.actor != 'bot'`")]);
    expect(problems(workflow(PR, [], ["    if: ${{ success() }}"]))).toHaveLength(1);
    expect(problems(workflow(PR, [], ["    if: ${{ always() && false }}"]))).toHaveLength(1);
    expect(problems(workflow(PR, [], []))).toEqual([]);
  });

  test("R-GATE-CI-TRIGGERS an if on a step is not a skipped job", () => {
    expect(problems(workflow(PR).replace("    steps: []\n  one-gate", "    steps:\n      - run: x\n        if: always()\n  one-gate"))).toEqual([]);
  });

  test("R-GATE-CI-TRIGGERS the trigger check is part of the drift check", () => {
    const files: CiFiles = {
      workflows: { "ci.yml": workflow(["  pull_request:", "    branches: [main]"]) },
      rootPackageJson: '{ "packageManager": "bun@1.4.0" }',
      pureScripts: '"test:seeds": "for s in ${SEEDS:-0 12345 987654}; do :; done"',
      styleCheck: '["uvx", "--from", "ast-grep-cli==0.45.3", "ast-grep"]',
    };
    expect(ciDriftProblems(files).filter((problem) => problem.startsWith("CI_TRIGGER_"))).toEqual([expect.stringContaining("CI_TRIGGER_FILTER ci.yml")]);
  });
});

describe("the real workflows", () => {
  const real = readdirSync(workflowDir).filter(isWorkflowFile).map((name) => ({ name, text: withoutComments(readFileSync(`${workflowDir}/${name}`, "utf8")) }));

  test("R-GATE-CI-TRIGGERS the real workflows start on every pull request and cannot skip a gate job", () => expect(real.flatMap(({ name, text }) => triggerProblems(name, text))).toEqual([]));

  test("R-GATE-CI-TRIGGERS the nightly run exists, a run on main is never cancelled, and og's informational suites run only nightly or by hand", () => {
    const gate = real.find(({ text }) => text.includes("one-gate:"))?.text ?? "";
    expect(gate).toMatch(/^\s+schedule:\s*\n\s+- cron:/m);
    expect(gate).toContain("cancel-in-progress: ${{ github.event_name == 'pull_request' && !startsWith(github.head_ref, 'promote/') }}");
    ["contracts-test", "e2e-tests"].forEach((job) => expect(jobBlocks(gate)[job], job).toContain("if: github.event_name == 'schedule' || github.event_name == 'workflow_dispatch'"));
  });

  test("R-GATE-CI-TRIGGERS the check is not vacuous: the real One gate workflow is judged, and its pull_request trigger is there", () => {
    const gate = real.find(({ text }) => text.includes("one-gate:"));
    expect(gate).toBeDefined();
    expect(gate?.text).toMatch(/^\s+pull_request:/m);
  });
});
