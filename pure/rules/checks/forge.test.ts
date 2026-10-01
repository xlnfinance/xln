// Canary for the Foundry part: a red forge test, a skipped one, a forge that ran fewer tests than the register's reader counts, a missing forge, a missing
// forge-std and one that is not the pinned checkout each turn the one command red, so a forge test cannot fail unseen the way test/deploy/guards.test.ts once did.
import { describe, expect, test } from "bun:test";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname } from "node:path";
import { existingFiles } from "./folder-width.ts";
import { expectedForgeTests, forgeProblems, type ForgeRun } from "./forge.ts";

const green = (total: number): string => `Ran 3 test suites in 4s (5s CPU time): ${total} tests passed, 0 failed, 0 skipped (${total} total tests)\n`;
const ran = (output: string, exitCode = 0): ForgeRun => ({ started: true, exitCode, output });

describe("what a forge run must say", () => {
  test("every test passed and the count is the reader's: no problem", () => expect(forgeProblems(ran(green(221)), 221)).toEqual([]));

  test("R-GATE-FORGE a failed test is a problem and is named", () => {
    const output = `[FAIL: boom] test_a() (gas: 1)\nRan 1 test suite in 1s (1s CPU time): 2 tests passed, 1 failed, 0 skipped (3 total tests)\n`;
    const problems = forgeProblems(ran(output, 1), 3);
    expect(problems).toContain("FORGE_TESTS_FAILED 1 of 3 failed");
    expect(problems).toContain("FORGE_FAIL [FAIL: boom] test_a() (gas: 1)");
  });

  test("a skipped test is a problem: it proves nothing", () => {
    expect(forgeProblems(ran("1 tests passed, 0 failed, 1 skipped (2 total tests)\n"), 2).join("\n")).toContain("FORGE_TESTS_SKIPPED");
  });

  test("a forge that ran fewer tests than the reader counts is a problem (a filter, a wrong root, a file it never found)", () => {
    expect(forgeProblems(ran(green(200)), 221)).toEqual(["FORGE_COUNT_MISMATCH forge ran 200 tests, the register's reader counts 221 under contracts/test/foundry/"]);
  });

  test("no tests at all is a problem", () => {
    expect(forgeProblems(ran(green(0)), 0).join("\n")).toContain("FORGE_RAN_NOTHING");
  });

  test("a compile error (no summary) is a problem and shows the end of the output", () => {
    const problems = forgeProblems(ran("Error: Compiler run failed\nParserError: boom\n", 1), 1);
    expect(problems[0]).toContain("FORGE_NO_SUMMARY");
    expect(problems.join("\n")).toContain("ParserError: boom");
  });

  test("a non-zero exit with a green summary is a problem", () => {
    expect(forgeProblems(ran(green(1), 2), 1).join("\n")).toContain("FORGE_EXIT");
  });

  test("a forge that did not start is a problem", () => {
    expect(forgeProblems({ started: false, exitCode: null, output: "" }, 1)[0]).toContain("FORGE_MISSING");
  });
});

const pureRoot = `${import.meta.dir}/../..`;

// A scratch checkout: the gate's own code (as git lists it) beside a contracts/ holding two forge tests and a stand-in forge-std.
const scratch = (): string => {
  const repo = mkdtempSync(`${tmpdir()}/forge-gate-`);
  existingFiles(pureRoot).forEach((file) => {
    mkdirSync(dirname(`${repo}/pure/${file}`), { recursive: true });
    copyFileSync(`${pureRoot}/${file}`, `${repo}/pure/${file}`);
  });
  const plant = (file: string, text: string): void => {
    mkdirSync(dirname(`${repo}/${file}`), { recursive: true });
    writeFileSync(`${repo}/${file}`, text);
  };
  plant("contracts/test/foundry/units/T.t.sol", "contract T is Test { function test_a() public {} function test_b() public {} }\n");
  plant("contracts/lib/forge-std/src/Test.sol", "// stand-in\n");
  plant("contracts/scripts/setup-forge-std.sh", "exit 0\n"); // stands in for the pin check: the real one needs the pinned git checkout
  Bun.spawnSync(["git", "init", "-q"], { cwd: repo });
  return repo;
};

// A forge on PATH that prints `output` and exits with `code`; the command is run with that PATH and no other forge.
const withFakeForge = (repo: string, output: string, code: number): Readonly<{ code: number | null; out: string }> => {
  const bin = mkdtempSync(`${tmpdir()}/fake-forge-`);
  writeFileSync(`${bin}/forge`, `#!/bin/sh\nprintf '%s\\n' '${output}'\nexit ${code}\n`);
  chmodSync(`${bin}/forge`, 0o755);
  const done = Bun.spawnSync([process.execPath, `${repo}/pure/rules/check.ts`, "--forge-only"], { cwd: `${repo}/pure`, env: { ...process.env, PATH: `${bin}:/usr/bin:/bin` } });
  return { code: done.exitCode, out: done.stdout.toString() + done.stderr.toString() };
};

describe("the real command over a scratch checkout", () => {
  test("the reader counts the two forge tests", () => expect(expectedForgeTests(scratch())).toBe(2), 30_000);

  test("a forge that passes both tests is green", () => {
    const { code, out } = withFakeForge(scratch(), "Ran 1 test suite in 1s (1s CPU time): 2 tests passed, 0 failed, 0 skipped (2 total tests)", 0);
    expect(out).toContain("FORGE_OK tests=2");
    expect(code).toBe(0);
  }, 30_000);

  test("R-GATE-FORGE a red forge test turns the command red and is named", () => {
    const { code, out } = withFakeForge(scratch(), "[FAIL: boom] test_a() (gas: 1)\nRan 1 test suite in 1s (1s CPU time): 1 tests passed, 1 failed, 0 skipped (2 total tests)", 1);
    expect(code).toBe(1);
    expect(out).toContain("FORGE_TESTS_FAILED 1 of 2 failed");
    expect(out).toContain("FORGE_FAIL [FAIL: boom] test_a()");
  }, 30_000);

  test("a green forge that ran fewer tests than the reader counts turns the command red", () => {
    const { code, out } = withFakeForge(scratch(), "Ran 1 test suite in 1s (1s CPU time): 1 tests passed, 0 failed, 0 skipped (1 total tests)", 0);
    expect(code).toBe(1);
    expect(out).toContain("FORGE_COUNT_MISMATCH");
  }, 30_000);

  test("no forge on PATH turns the command red", () => {
    const repo = scratch();
    const done = Bun.spawnSync([process.execPath, `${repo}/pure/rules/check.ts`, "--forge-only"], { cwd: `${repo}/pure`, env: { ...process.env, PATH: "/usr/bin:/bin" } });
    expect(done.exitCode).toBe(1);
    expect(done.stdout.toString()).toContain("FORGE_MISSING");
  }, 30_000);

  test("a checkout without forge-std turns the command red before forge runs", () => {
    const repo = scratch();
    Bun.spawnSync(["rm", "-r", `${repo}/contracts/lib`]);
    const done = Bun.spawnSync([process.execPath, `${repo}/pure/rules/check.ts`, "--forge-only"], { cwd: `${repo}/pure`, env: { ...process.env, PATH: "/usr/bin:/bin" } });
    expect(done.exitCode).toBe(1);
    expect(done.stdout.toString()).toContain("FORGE_STD_MISSING");
  }, 30_000);

  test("a forge-std that the pin check refuses turns the command red before forge runs", () => {
    const repo = scratch();
    writeFileSync(`${repo}/contracts/scripts/setup-forge-std.sh`, 'echo "FORGE_STD_TRACKED_WORKTREE_DIRTY:contracts/lib/forge-std" >&2\nexit 1\n');
    const { code, out } = withFakeForge(repo, "Ran 1 test suite in 1s (1s CPU time): 2 tests passed, 0 failed, 0 skipped (2 total tests)", 0);
    expect(code).toBe(1);
    expect(out).toContain("FORGE_STD_UNVERIFIED FORGE_STD_TRACKED_WORKTREE_DIRTY");
    expect(out).not.toContain("FORGE_OK");
  }, 30_000);
});
