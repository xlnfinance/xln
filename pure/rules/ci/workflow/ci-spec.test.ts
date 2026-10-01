// A spec job that skips on a cache marker is sound only if the marker is keyed on every file the suite reads, every working step is guarded, and the pass is recorded last.
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { ciDriftProblems, isWorkflowFile, withoutComments, type CiFiles } from "../ci-drift.ts";
import { specProblems } from "./ci-spec.ts";

const repo = `${import.meta.dir}/../../../..`;
const GUARD = "        if: steps.marker.outputs.cache-hit != 'true'";

type Plant = Readonly<{ key?: string; path?: string; id?: string; unguarded?: boolean; suite?: string; recordFirst?: boolean; record?: string; matrix?: string }>;

// A workflow with one spec job behind one-gate.
const workflow = (plant: Plant = {}): string => {
  const suite = ["      - name: Suite", GUARD, "        working-directory: spec", `        run: ${plant.suite ?? 'SHARD="${{ matrix.shard }}/4" node test.mjs'}`];
  const record = ["      - name: Record", GUARD, `        run: ${plant.record ?? "mkdir -p .spec-passed && echo ok > .spec-passed/arrival"}`];
  return [
    "name: ci",
    "on:",
    "  pull_request:",
    "jobs:",
    "  gate-spec:",
    "    name: One gate (spec)",
    "    strategy:",
    "      matrix:",
    `        shard: ${plant.matrix ?? "['0', '1', '2', '3']"}`,
    "    steps:",
    "      - name: Checkout",
    "        uses: actions/checkout@abc # v4",
    "      - name: Marker",
    `        id: ${plant.id ?? "marker"}`,
    "        uses: actions/cache@abc # v4",
    "        with:",
    `          path: ${plant.path ?? ".spec-passed"}`,
    `          key: ${plant.key ?? "${{ runner.os }}-arrival-${{ matrix.shard }}-of-4-${{ hashFiles('spec/**') }}"}`,
    "      - name: Install",
    ...(plant.unguarded === true ? [] : [GUARD]),
    "        run: npm ci",
    ...(plant.recordFirst === true ? [...record, ...suite] : [...suite, ...record]),
    "  one-gate:",
    "    needs: [gate-spec]",
    "    steps: []",
    "",
  ].join("\n");
};

const problems = (plant?: Plant): readonly string[] => specProblems("ci.yml", withoutComments(workflow(plant)));

describe("a spec job that skips on a marker", () => {
  test("R-GATE-CI-SPEC a marker keyed on the spec files, every working step guarded, the pass recorded last, agrees", () => {
    expect(problems()).toEqual([]);
    expect(problems({ suite: "bash check.sh", key: "${{ runner.os }}-quint-${{ hashFiles('spec/quint/**') }}", record: "mkdir -p .spec-passed && echo ok > .spec-passed/quint" })).toEqual([]);
  });

  test("R-GATE-CI-SPEC an Arrival marker that leaves out the shard, or a matrix that does not match the n of SHARD=k/n, is named", () => {
    const named = [expect.stringContaining("CI_SPEC_SHARDS ci.yml job gate-spec")];
    expect(problems({ key: "${{ runner.os }}-arrival-of-4-${{ hashFiles('spec/**') }}" })).toEqual(named);
    expect(problems({ key: "${{ runner.os }}-arrival-${{ matrix.shard }}-of-3-${{ hashFiles('spec/**') }}" })).toEqual(named);
    expect(problems({ matrix: "['0', '1', '2']" })).toEqual(named);
    expect(problems({ matrix: "['0', '1', '2', '3', '4']" })).toEqual(named);
    expect(problems({ matrix: "['0', '1', '3', '3']" })).toEqual(named);
    expect(problems({ matrix: "[0, 1, 2, 3]" })).toEqual([]);
    expect(problems({ suite: 'SHARD="${{ matrix.shard }}/3" node test.mjs', matrix: "['0', '1', '2']" })).toEqual(named);
  });

  test("R-GATE-CI-SPEC a job that runs no spec suite, and a workflow with no one-gate, are not judged", () => {
    expect(problems({ suite: "bun test" })).toEqual([]);
    expect(specProblems("o.yml", "jobs:\n  a:\n    steps:\n      - run: node test.mjs\n")).toEqual([]);
  });

  test("R-GATE-CI-SPEC no marker step is named, whichever part of it is missing: the id, the cache action, the path", () => {
    expect(problems({ id: "other" })).toEqual([expect.stringContaining("CI_SPEC_MARKER_MISSING ci.yml job gate-spec")]);
    expect(problems({ path: "somewhere" })).toEqual([expect.stringContaining("CI_SPEC_MARKER_MISSING")]);
    expect(specProblems("ci.yml", withoutComments(workflow().replace("actions/cache@abc", "actions/other@abc")))).toEqual([expect.stringContaining("CI_SPEC_MARKER_MISSING")]);
  });

  test("R-GATE-CI-SPEC a key that does not hash the files the suite reads is named: too narrow for Arrival, none at all, another folder", () => {
    expect(problems({ key: "${{ runner.os }}-arrival-${{ matrix.shard }}-of-4-${{ hashFiles('spec/quint/**') }}" })).toEqual([expect.stringContaining("CI_SPEC_MARKER_KEY ci.yml job gate-spec keys its marker on spec/quint/**, not on spec/**")]);
    expect(problems({ key: "${{ runner.os }}-arrival-${{ matrix.shard }}-of-4-x" })).toEqual([expect.stringContaining("keys its marker on no hashFiles")]);
    expect(problems({ key: "${{ matrix.shard }}-of-4-${{ hashFiles('pure/**') }}" })).toHaveLength(1);
    expect(problems({ suite: "bash check.sh", key: "${{ hashFiles('spec/quint/*.qnt') }}", record: "echo ok > .spec-passed/quint" })).toHaveLength(1);
  });

  test("R-GATE-CI-SPEC a run step with no guard is named with its first line", () => {
    expect(problems({ unguarded: true })).toEqual([expect.stringContaining("CI_SPEC_UNGUARDED ci.yml job gate-spec has a run step without `if: steps.marker.outputs.cache-hit != 'true'`: - name: Install")]);
  });

  test("R-GATE-CI-SPEC a pass recorded before the suite, or not recorded, or recorded by a step that is not last, is named", () => {
    expect(problems({ recordFirst: true })).toEqual([expect.stringContaining("CI_SPEC_RECORD")]);
    expect(problems({ record: "echo done" })).toEqual([expect.stringContaining("CI_SPEC_RECORD")]);
    // The suite must be the one line of its own step, so that its place before the record can be read.
    const block = workflow().replace('        run: SHARD="${{ matrix.shard }}/4" node test.mjs', '        run: |\n          node test.mjs');
    expect(specProblems("ci.yml", withoutComments(block))).toEqual([expect.stringContaining("CI_SPEC_RECORD")]);
    const after = workflow().replace("  one-gate:", "      - name: After\n        if: steps.marker.outputs.cache-hit != 'true'\n        run: echo after\n  one-gate:");
    expect(specProblems("ci.yml", withoutComments(after))).toEqual([expect.stringContaining("CI_SPEC_RECORD")]);
  });

  test("R-GATE-CI-SPEC the spec check is part of the drift check", () => {
    const files: CiFiles = {
      workflows: { "ci.yml": workflow({ unguarded: true }) },
      rootPackageJson: '{ "packageManager": "bun@1.4.0" }',
      pureScripts: '"test:seeds": "for s in ${SEEDS:-0 12345 987654}; do :; done"',
      styleCheck: '["uvx", "--from", "ast-grep-cli==0.45.3", "ast-grep"]',
    };
    expect(ciDriftProblems(files).filter((problem) => problem.startsWith("CI_SPEC_"))).toEqual([expect.stringContaining("CI_SPEC_UNGUARDED")]);
  });
});

describe("the real workflows", () => {
  const real = readdirSync(`${repo}/.github/workflows`).filter(isWorkflowFile).map((name) => ({ name, text: withoutComments(readFileSync(`${repo}/.github/workflows/${name}`, "utf8")) }));

  test("R-GATE-CI-SPEC the real spec jobs skip soundly", () => expect(real.flatMap(({ name, text }) => specProblems(name, text))).toEqual([]));

  test("R-GATE-CI-SPEC the check is not vacuous: the real workflow has a quint job and an arrival job that it judges", () => {
    const gate = real.find(({ text }) => text.includes("gate-quint:"));
    expect(gate).toBeDefined();
    const text = gate?.text ?? "";
    expect(text).toContain("gate-arrival:");
    expect(specProblems("x", text.replace(/id: marker/g, "id: other")).length).toBeGreaterThanOrEqual(2);
  });
});
