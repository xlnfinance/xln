// Every contract test runs in a gate, or is listed here as run by Hardhat only. A test file that holds a runnable check and
// sits in no gate folder is red: it would pass or fail unseen, and the register's contract scan would never read it
// (a rule held only there looks missing, or worse, a test that guards a refusal is never run). The gated folders are
// the ones rules/scan.ts `isGateTest` accepts, the same globs as the contracts-fork job in the workflow.
//   bun rules/check.ts --tests-only
import { readFileSync } from "node:fs";
import { posix } from "node:path";
import { existingFiles } from "./folder-width.ts";
import { isGateTest } from "../scan.ts";
import { testFileNames } from "../names/names.ts";

export const CONTRACT_TEST_ROOT = "contracts/test";

// The inherited mocha suites that only `hardhat test` runs, per file and relative to contracts/test: the known debt
// (BASELINE.md; the og "test:contracts:full" check is red on them). A new file in these folders is red until it is
// listed, a listed file that is gone or has since moved into a gate is red too, so the list only shrinks on purpose.
export const HARDHAT_ONLY: readonly string[] = [
  "dispute/DebtForgiveness.test.ts",
  "dispute/DeltaTransformer.test.ts",
  "dispute/Depository-part-1.ts",
  "dispute/Depository-part-2.ts",
  "dispute/DisputeOndeltaLiveness.test.ts",
  "dispute/SecretRevealLiveness.test.ts",
  "dispute/SettlementFinality.test.ts",
  "governance/BoardRotationAuthority.test.ts",
  "governance/BoardRotationGrace.test.ts",
  "governance/ControlShares.test.mjs",
  "governance/EntityProvider.test.mjs",
  "governance/FoundationRegistry.test.ts",
  "governance/HankoAuthorization.test.ts",
  "governance/HankoMembers.test.ts",
  "governance/OnchainHankoDomain.test.ts",
  "governance/Redesign.test.ts",
  "governance/ReleaseHanko.test.ts",
  "protocol/CanonicalTransformerReveal.test.ts",
  "protocol/ContractSize.test.ts",
  "protocol/ControlLaneFaultIsolation.test.ts",
  "protocol/HashLadder.test.ts",
  "protocol/HashLadderRegistry.test.ts",
];

const SOURCE = /\.(?:[cm]?[jt]sx?|sol)$/;

// What bun test (and forge) take for a test by its NAME: `.test.`, `_test.`, `.spec.`, `_spec.` in any script extension, and `.t.sol`. Such a file is a
// test whatever its body: `test.each`, `test.concurrent` or `test.if(...)`, which the register's reader does not count as checks, must not hide it.
const TEST_NAME = /(?:[._])(?:test|spec)\.[cm]?[jt]sx?$|\.t\.sol$/;

// Output and vendored trees under contracts/: not ours to place.
const NOT_OURS = /^contracts\/(?:node_modules|artifacts|cache|typechain-types|\.typechain-hardhat|forge-out|forge-cache|lib)\//;

// The test files under contracts/, relative to contracts/test (a file outside it, say scripts/x.test.ts, reads `../scripts/x.test.ts` and is in
// no gate by construction). Under contracts/test a file is a test when its name says so or when it holds at least one check the register's
// contract scan would read, so a helper or a fixture is not a test and a Foundry `.t.sol` is.
const testFiles = (repo: string): readonly string[] =>
  existingFiles(repo)
    .filter((file) => file.startsWith("contracts/") && !NOT_OURS.test(file) && SOURCE.test(file))
    .filter((file) =>
      TEST_NAME.test(file) ||
      (file.startsWith(`${CONTRACT_TEST_ROOT}/`) && testFileNames("contract", file.slice(CONTRACT_TEST_ROOT.length + 1), readFileSync(`${repo}/${file}`, "utf8")).length > 0),
    )
    .map((file) => posix.relative(CONTRACT_TEST_ROOT, file));

const repoPath = (file: string): string => posix.normalize(`${CONTRACT_TEST_ROOT}/${file}`);

export const contractTestProblems = (held: readonly string[], hardhatOnly: readonly string[] = HARDHAT_ONLY): readonly string[] => {
  const ungated = held
    .filter((file) => !isGateTest(file) && !hardhatOnly.includes(file))
    .map((file) => `UNGATED_CONTRACT_TEST ${repoPath(file)}: no gate runs it (move it under contracts/test/vm/<area>/, gate/ or foundry/)`);
  const stale = hardhatOnly.flatMap((file) =>
    !held.includes(file)
      ? [`STALE_HARDHAT_ONLY ${repoPath(file)}: no such test (drop it from the list)`]
      : isGateTest(file)
        ? [`STALE_HARDHAT_ONLY ${repoPath(file)}: a gate runs it now (drop it from the list)`]
        : [],
  );
  return [...ungated, ...stale].sort();
};

export type ContractTestsReport = Readonly<{ failed: boolean; lines: readonly string[] }>;

export const contractTestsReport = (repo: string, hardhatOnly: readonly string[] = HARDHAT_ONLY): ContractTestsReport => {
  const held = testFiles(repo);
  const problems = contractTestProblems(held, hardhatOnly);
  const gated = held.filter(isGateTest).length;
  const summary = problems.length === 0 ? `CONTRACT_TESTS_OK gated=${gated} hardhatOnly=${hardhatOnly.length}` : "CONTRACT_TESTS_INVARIANT_FAILED";
  return { failed: problems.length > 0, lines: [...problems, summary] };
};

if (import.meta.main) {
  const report = contractTestsReport(`${import.meta.dir}/../../..`);
  report.lines.forEach((line) => console.log(line));
  process.exit(report.failed ? 1 : 0);
}
