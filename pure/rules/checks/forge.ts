// The Foundry suite runs inside the one gate: contracts/test/foundry counts as gated (rules/scan.ts), so a red forge test must turn the
// command red, and a forge that ran fewer tests than the register's own reader sees (a filter, a skipped file, a wrong root) must too.
//   bun rules/check.ts --forge-only        (forge is in /foundry: export PATH=$PATH:/foundry)
import { existsSync, readFileSync } from "node:fs";
import { existingFiles } from "./folder-width.ts";
import { foundryChecks } from "../names/solidity.ts";

const FORGE_ROOT = "contracts";
const FOUNDRY_TESTS = `${FORGE_ROOT}/test/foundry/`;

export type ForgeRun = Readonly<{ started: boolean; exitCode: number | null; output: string }>;

// forge's closing line: "Ran 23 test suites in 41s (60s CPU time): 221 tests passed, 0 failed, 0 skipped (221 total tests)".
const SUMMARY = /(\d+) tests passed, (\d+) failed, (\d+) skipped \((\d+) total tests\)/g;

const lastSummary = (output: string): readonly number[] | null => {
  const found = [...output.matchAll(SUMMARY)].at(-1);
  return found === undefined ? null : found.slice(1, 5).map(Number);
};

const failingNames = (output: string): readonly string[] =>
  output.split("\n").filter((line) => line.startsWith("[FAIL")).map((line) => `FORGE_FAIL ${line.trim()}`);

const tail = (output: string): readonly string[] => output.trimEnd().split("\n").slice(-12).map((line) => `  | ${line}`);

// What the run says, set against the number of checks the register's reader counts under contracts/test/foundry.
export const forgeProblems = (run: ForgeRun, expected: number): readonly string[] => {
  if (!run.started) return ["FORGE_MISSING forge did not start (export PATH=$PATH:/foundry)"];
  const summary = lastSummary(run.output);
  if (summary === null) return [`FORGE_NO_SUMMARY forge exited ${run.exitCode} without a test summary`, ...tail(run.output)];
  const [passed = 0, failed = 0, skipped = 0, total = 0] = summary;
  return [
    ...(failed > 0 ? [`FORGE_TESTS_FAILED ${failed} of ${total} failed`, ...failingNames(run.output)] : []),
    ...(skipped > 0 ? [`FORGE_TESTS_SKIPPED ${skipped} skipped: a skipped test proves nothing`] : []),
    ...(total === 0 ? ["FORGE_RAN_NOTHING forge ran no tests"] : []),
    ...(total !== expected ? [`FORGE_COUNT_MISMATCH forge ran ${total} tests, the register's reader counts ${expected} under ${FOUNDRY_TESTS}`] : []),
    ...(passed + failed + skipped !== total ? [`FORGE_SUMMARY_INCONSISTENT ${passed} + ${failed} + ${skipped} != ${total}`] : []),
    ...(run.exitCode !== 0 && failed === 0 ? [`FORGE_EXIT forge exited ${run.exitCode} with no failed test`, ...tail(run.output)] : []),
  ];
};

// The checks forge should discover: every public test* or invariant* function of a concrete test contract, as the register reads them.
export const expectedForgeTests = (repo: string): number =>
  existingFiles(repo)
    .filter((file) => file.startsWith(FOUNDRY_TESTS) && file.endsWith(".t.sol"))
    .reduce((sum, file) => sum + foundryChecks(readFileSync(`${repo}/${file}`, "utf8")).functions.length, 0);

const runForge = (repo: string): ForgeRun => {
  const binary = Bun.which("forge");
  if (binary === null) return { started: false, exitCode: null, output: "" };
  const done = Bun.spawnSync([binary, "test", "--root", FORGE_ROOT], { cwd: repo, stdout: "pipe", stderr: "pipe" });
  return { started: true, exitCode: done.exitCode, output: done.stdout.toString() + done.stderr.toString() };
};

export type ForgeReport = Readonly<{ failed: boolean; lines: readonly string[] }>;

// forge-std is a pinned checkout (contracts/scripts/setup-forge-std.sh), not a tracked file: without it forge cannot compile a single test.
export const forgeReport = (repo: string): ForgeReport => {
  if (!existsSync(`${repo}/${FORGE_ROOT}/lib/forge-std/src/Test.sol`)) {
    return { failed: true, lines: ["FORGE_STD_MISSING contracts/lib/forge-std is not checked out (cd contracts && bun run forge:setup)", "FORGE_INVARIANT_FAILED"] };
  }
  const expected = expectedForgeTests(repo);
  const problems = forgeProblems(runForge(repo), expected);
  return { failed: problems.length > 0, lines: [...problems, problems.length === 0 ? `FORGE_OK tests=${expected}` : "FORGE_INVARIANT_FAILED"] };
};

if (import.meta.main) {
  const report = forgeReport(`${import.meta.dir}/../../..`);
  report.lines.forEach((line) => console.log(line));
  process.exit(report.failed ? 1 : 0);
}
