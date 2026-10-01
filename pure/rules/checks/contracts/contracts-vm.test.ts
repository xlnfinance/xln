// The contracts/ BrowserVM and deploy-gate tests run inside the one gate: which files, what makes the part red, and what
// the rebuild of typechain-types must leave alone. The runner is injected, so no test here starts the real build.
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname } from "node:path";
import { contractsReport, inLanes, lanesFrom, typechainDigest, vmTestFiles, type Run, type Runner } from "./contracts-vm.ts";

const scratch = (files: Readonly<Record<string, string>>): string => {
  const repo = mkdtempSync(`${tmpdir()}/contracts-vm-`);
  Bun.spawnSync(["git", "init", "-q"], { cwd: repo });
  Object.entries(files).forEach(([file, text]) => {
    mkdirSync(`${repo}/${dirname(file)}`, { recursive: true });
    writeFileSync(`${repo}/${file}`, text);
  });
  return repo;
};

const T = "import { test } from \"bun:test\";\ntest(\"t\", () => {});\n";
const GATE_TREE: Readonly<Record<string, string>> = {
  "contracts/test/vm/rig.ts": "export {};\n",
  "contracts/test/vm/j5/b.test.ts": T,
  "contracts/test/vm/disputes/a.test.ts": T,
  "contracts/test/vm/disputes/helper.ts": "export {};\n",
  "contracts/test/vm/disputes/deep/c.test.ts": T,
  "contracts/test/gate/g.test.ts": T,
  "contracts/test/dispute/hardhat-only.test.ts": T,
  "contracts/test/foundry/A.t.sol": "// forge\n",
};

const OK: Run = { exitCode: 0, output: "" };

// A runner that records what it was asked and answers from a table, green otherwise.
const recording = (answers: Readonly<Record<string, Run>> = {}): Readonly<{ runner: Runner; calls: string[] }> => {
  const calls: string[] = [];
  return {
    calls,
    runner: async (_repo, command) => {
      const line = command.slice(command[0]?.endsWith("bun") ? 1 : 0).join(" ");
      calls.push(line);
      return answers[line] ?? OK;
    },
  };
};

describe("which test files the part runs", () => {
  test("R-GATE-CONTRACTS-VM the files are CI's globs: vm/<area>/*.test.ts and gate/*.test.ts, sorted, nothing else", () => {
    expect(vmTestFiles(scratch(GATE_TREE))).toEqual([
      "contracts/test/gate/g.test.ts",
      "contracts/test/vm/disputes/a.test.ts",
      "contracts/test/vm/j5/b.test.ts",
    ]);
  });

  test("R-GATE-CONTRACTS-VM a tree with no gate test is red, not an empty pass", async () => {
    const report = await contractsReport(scratch({ "contracts/test/vm/rig.ts": "export {};\n" }), recording().runner);
    expect(report.failed).toBe(true);
    expect(report.lines[0]).toContain("CONTRACTS_NO_TESTS");
  });
});

describe("what makes the part red", () => {
  const repo = scratch(GATE_TREE);
  const digest = (): string => "same";

  test("R-GATE-CONTRACTS-VM a green rebuild and green tests pass, the build first and each test file in a process of its own", async () => {
    const { runner, calls } = recording();
    const report = await contractsReport(repo, runner, digest, 1);
    expect(report).toEqual({ failed: false, lines: ["ok   contracts: typechain current, 3 BrowserVM and gate test files, one per process"] });
    expect(calls).toEqual([
      "bash contracts/scripts/build.sh",
      "test contracts/test/gate/g.test.ts",
      "test contracts/test/vm/disputes/a.test.ts",
      "test contracts/test/vm/j5/b.test.ts",
    ]);
  });

  test("R-GATE-CONTRACTS-VM with several lanes the build is still first, every file runs once, and the report does not depend on the lanes", async () => {
    const answers = { "test contracts/test/vm/disputes/a.test.ts": { exitCode: 1, output: "(fail) a\n" }, "test contracts/test/vm/j5/b.test.ts": { exitCode: 2, output: "(fail) b\n" } };
    const serial = await contractsReport(repo, recording(answers).runner, digest, 1);
    const { runner, calls } = recording(answers);
    const lanes = await contractsReport(repo, runner, digest, 3);
    expect(lanes).toEqual(serial);
    expect(calls[0]).toBe("bash contracts/scripts/build.sh");
    expect([...calls].sort()).toEqual(["bash contracts/scripts/build.sh", "test contracts/test/gate/g.test.ts", "test contracts/test/vm/disputes/a.test.ts", "test contracts/test/vm/j5/b.test.ts"]);
  });

  test("R-GATE-CONTRACTS-VM at most one file per lane runs at a time, and a lane keeps the order of its files", async () => {
    const running = { now: 0, most: 0 };
    const runner: Runner = async (_repo, command) => {
      const isTest = command.includes("test");
      running.now += isTest ? 1 : 0;
      running.most = Math.max(running.most, running.now);
      await Bun.sleep(30);
      running.now -= isTest ? 1 : 0;
      return OK;
    };
    await contractsReport(scratch({ ...GATE_TREE, "contracts/test/vm/j5/c.test.ts": T, "contracts/test/vm/j5/d.test.ts": T }), runner, () => "same", 2);
    expect(running.most).toBe(2);
    expect(inLanes([1, 2, 3, 4, 5], 2)).toEqual([[1, 3, 5], [2, 4]]);
    expect(inLanes([1, 2], 5)).toEqual([[1], [2]]);
  });

  test("the number of lanes is GATE_CONTRACT_LANES when it is a positive integer, else 3", () => {
    expect([lanesFrom("2"), lanesFrom("1"), lanesFrom(undefined), lanesFrom("0"), lanesFrom("x"), lanesFrom("1.5")]).toEqual([2, 1, 3, 3, 3, 3]);
  });

  test("R-GATE-CONTRACTS-VM a red test file is named with its exit code and the end of its output, and the other files still run", async () => {
    const { runner, calls } = recording({ "test contracts/test/vm/disputes/a.test.ts": { exitCode: 1, output: "x\n(fail) a broken thing\n" } });
    const report = await contractsReport(repo, runner, digest);
    expect(report.failed).toBe(true);
    expect(report.lines).toContain("CONTRACTS_TEST_FAILED contracts/test/vm/disputes/a.test.ts exited 1");
    expect(report.lines).toContain("  | (fail) a broken thing");
    const long = Array.from({ length: 20 }, (_, index) => `line ${index + 1}`).join("\n");
    const tailed = (await contractsReport(repo, recording({ "test contracts/test/gate/g.test.ts": { exitCode: 1, output: long } }).runner, digest)).lines;
    expect(tailed).toContain("  | line 20");
    expect(tailed).toContain("  | line 9");
    expect(tailed).not.toContain("  | line 8");
    expect(report.lines.at(-1)).toBe("CONTRACTS_INVARIANT_FAILED");
    expect(calls).toHaveLength(4);
  });

  test("R-GATE-CONTRACTS-VM a test that did not start is red, not skipped", async () => {
    const { runner } = recording({ "test contracts/test/gate/g.test.ts": { exitCode: null, output: "" } });
    expect((await contractsReport(repo, runner, digest)).lines).toContain("CONTRACTS_TEST_FAILED contracts/test/gate/g.test.ts exited null");
  });

  test("R-GATE-CONTRACTS-VM a failing rebuild is red and says so", async () => {
    const { runner } = recording({ "bash contracts/scripts/build.sh": { exitCode: 2, output: "solc: no\n" } });
    const report = await contractsReport(repo, runner, digest);
    expect(report.failed).toBe(true);
    expect(report.lines).toContain("CONTRACTS_BUILD_FAILED bash contracts/scripts/build.sh exited 2");
    expect(report.lines).toContain("  | solc: no");
  });

  test("R-GATE-CONTRACTS-VM a rebuild that changes typechain-types is red: the committed files are stale", async () => {
    const { runner, calls } = recording();
    const report = await contractsReport(repo, runner, () => (calls.length === 0 ? "before the build" : "after the build"));
    expect(report.failed).toBe(true);
    expect(report.lines).toContain("TYPECHAIN_STALE contracts/typechain-types/ differs after bash contracts/scripts/build.sh: commit the rebuilt files");
  });
});

describe("the typechain digest", () => {
  const typechain = (files: Readonly<Record<string, string>>): string =>
    typechainDigest(scratch(Object.fromEntries(Object.entries(files).map(([file, text]) => [`contracts/typechain-types/${file}`, text]))));

  test("R-GATE-CONTRACTS-VM the digest is the same for the same files and differs for a changed, an added and a renamed file", () => {
    const base = typechain({ "a.ts": "1", "b.ts": "2" });
    expect(typechain({ "b.ts": "2", "a.ts": "1" })).toBe(base);
    expect(typechain({ "a.ts": "1", "b.ts": "3" })).not.toBe(base);
    expect(typechain({ "a.ts": "1", "b.ts": "2", "c.ts": "" })).not.toBe(base);
    expect(typechain({ "a.ts": "1", "c.ts": "2" })).not.toBe(base);
  });

  test("a file outside typechain-types does not move it", () => {
    const repo = scratch({ "contracts/typechain-types/a.ts": "1", "contracts/other.ts": "x" });
    const before = typechainDigest(repo);
    writeFileSync(`${repo}/contracts/other.ts`, "y");
    expect(typechainDigest(repo)).toBe(before);
  });
});
