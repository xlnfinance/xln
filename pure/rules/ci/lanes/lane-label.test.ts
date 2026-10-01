// The lane rule for pull requests into development: one open pull request per lane (core, chain, spec), process exempt.
// The real .github/scripts/lane-label.sh runs here against open-pull-request lists shaped like the GitHub API's, and the
// workflow that calls it is pinned: the events it re-runs on, the check name to require, the permission the re-run needs.
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withoutComments } from "../ci-drift.ts";

const repo = `${import.meta.dir}/../../../..`;
const script = `${repo}/.github/scripts/lane-label.sh`;
const workflow = readFileSync(`${repo}/.github/workflows/lane-label.yml`, "utf8");

type Pull = Readonly<{ number: number; labels?: readonly string[]; base?: string; head?: string; state?: string }>;
type Outcome = Readonly<{ code: number | null; out: string; err: string }>;

const apiShape = (pulls: readonly Pull[]): string =>
  JSON.stringify(
    pulls.map((pull) => ({
      number: pull.number,
      state: pull.state ?? "open",
      labels: (pull.labels ?? []).map((name) => ({ name })),
      base: { ref: pull.base ?? "development" },
      head: { ref: pull.head ?? `claude/branch-${pull.number}` },
    })),
  );

const file = (text: string): string => {
  const path = join(mkdtempSync(join(tmpdir(), "lane-label-")), "input.json");
  writeFileSync(path, text);
  return path;
};

const bash = (args: readonly string[]): Outcome => {
  const done = Bun.spawnSync(["bash", script, ...args], { stdout: "pipe", stderr: "pipe" });
  return { code: done.exitCode, out: done.stdout.toString(), err: done.stderr.toString() };
};

const check = (pr: number, pulls: readonly Pull[]): Outcome => bash(["check", String(pr), file(apiShape(pulls))]);

// The event of a closed pull request: its number and the labels it carried.
const closing = (number: number, labels: readonly string[]): string => file(JSON.stringify({ pull_request: { number, labels: labels.map((name) => ({ name })) } }));
const waiting = (event: string, pulls: readonly Pull[]): readonly string[] => bash(["waiting", event, file(apiShape(pulls))]).out.split("\n").filter((line) => line !== "");

describe("R-GATE-LANE-LABEL one open pull request per lane", () => {
  test("R-GATE-LANE-LABEL a pull request alone in its lane passes, for each of core, chain and spec", () => {
    ["core", "chain", "spec"].forEach((lane) => {
      const done = check(7, [{ number: 7, labels: [lane] }]);
      expect(done.code, lane).toBe(0);
      expect(done.out).toContain("holds lane " + lane);
    });
  });

  test("R-GATE-LANE-LABEL process is exempt, whatever else is open, and different lanes do not block each other", () => {
    expect(check(9, [{ number: 4, labels: ["process"] }, { number: 9, labels: ["process"] }, { number: 5, labels: ["core"] }]).code).toBe(0);
    expect(check(9, [{ number: 5, labels: ["core"] }, { number: 6, labels: ["chain"] }, { number: 9, labels: ["spec"] }]).code).toBe(0);
  });

  test("R-GATE-LANE-LABEL no lane label, two lane labels, or process together with a lane, fail and say what is carried; unrelated labels do not count", () => {
    const none = check(7, [{ number: 7, labels: ["bug"] }]);
    expect(none.code).toBe(1);
    expect(none.err).toContain("must carry exactly one of core, chain, spec, process");
    const two = check(7, [{ number: 7, labels: ["core", "chain"] }]);
    expect(two.code).toBe(1);
    expect(two.err).toContain("it carries 2 (core, chain)");
    expect(check(7, [{ number: 7, labels: ["process", "core"] }]).code).toBe(1);
    expect(check(7, [{ number: 7, labels: ["bug", "core", "help wanted"] }]).code).toBe(0);
  });

  test("R-GATE-LANE-LABEL a lower-numbered open pull request with the same label holds the lane: the higher number fails, the lower one does not, a draft holds it too", () => {
    const pulls: readonly Pull[] = [{ number: 5, labels: ["core"] }, { number: 8, labels: ["core", "bug"] }];
    const later = check(8, pulls);
    expect(later.code).toBe(1);
    expect(later.err).toContain("lane core is held by #5");
    expect(check(5, pulls).code).toBe(0);
    const three = check(11, [...pulls, { number: 11, labels: ["core"] }]);
    expect(three.err).toContain("held by #5, #8");
  });

  test("R-GATE-LANE-LABEL pull requests into main, closed ones, and a pull request that is not open into development are not counted", () => {
    expect(check(8, [{ number: 5, labels: ["core"], base: "main" }, { number: 6, labels: ["core"], state: "closed" }, { number: 8, labels: ["core"] }]).code).toBe(0);
    const absent = check(8, [{ number: 8, labels: ["core"], base: "main" }]);
    expect(absent.code).toBe(1);
    expect(absent.err).toContain("not among the open pull requests into development");
  });

  test("R-GATE-LANE-LABEL once the holder closes, the waiting pull requests of its lane are named with their branch, and nothing for process or no lane", () => {
    const open: readonly Pull[] = [{ number: 8, labels: ["core"], head: "claude/eight" }, { number: 9, labels: ["chain"] }, { number: 12, labels: ["core"], head: "claude/twelve" }, { number: 13, labels: ["core"], base: "main" }];
    expect(waiting(closing(5, ["core"]), open)).toEqual(["8 claude/eight", "12 claude/twelve"]);
    expect(waiting(closing(5, ["process"]), open)).toEqual([]);
    expect(waiting(closing(5, []), open)).toEqual([]);
    expect(waiting(closing(8, ["core"]), open)).toEqual(["12 claude/twelve"]);
  });

  test("R-GATE-LANE-LABEL a missing argument or an unknown mode is an error, not a pass", () => {
    expect(bash([]).code).not.toBe(0);
    expect(bash(["check"]).code).not.toBe(0);
    expect(bash(["merge"]).code).toBe(2);
  });

  test("R-GATE-LANE-LABEL the workflow runs on every event that can change the answer, only for development, and is named Lane label", () => {
    const text = withoutComments(workflow);
    expect(text).toMatch(/pull_request:\s*\n\s+branches: \[development\]/);
    const types = /types: \[([^\]]*)\]/.exec(text)?.[1]?.split(",").map((type) => type.trim()) ?? [];
    ["opened", "reopened", "synchronize", "edited", "labeled", "unlabeled", "closed"].forEach((type) => expect(types, type).toContain(type));
    expect(text).not.toMatch(/\bpush:|\bschedule:/);
    expect(text).toMatch(/\n {4}name: Lane label\n/);
    expect(text.match(/\n {2}[a-z-]+:\n {4}name:/g)?.length).toBe(1);
  });

  test("R-GATE-LANE-LABEL the check runs the script on the real number, is skipped only for a closed pull request, and a closed one re-runs the waiting ones with the permission that needs", () => {
    const text = withoutComments(workflow);
    expect(text).toContain("if: github.event.action != 'closed'\n        run: bash .github/scripts/lane-label.sh check \"${{ github.event.pull_request.number }}\" \"$RUNNER_TEMP/open-prs.json\"");
    expect(text).toContain("if: github.event.action == 'closed'");
    expect(text).toContain("lane-label.sh waiting");
    expect(text).toContain("gh run rerun");
    expect(text).toMatch(/permissions:[^]*?\n {2}actions: write/);
    expect(text).toMatch(/group: lane-label-\$\{\{ github\.event\.pull_request\.number \}\}\n\s+cancel-in-progress: true/);
    expect(existsSync(script)).toBe(true);
  });

  test("R-GATE-LANE-LABEL the lists are read under the same base and state the script filters on", () => {
    expect(workflow).toContain("state=open&base=development");
    expect(workflow).toContain("--paginate");
  });
});
