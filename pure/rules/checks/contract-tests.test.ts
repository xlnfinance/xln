// Canary for the contract-test placement part: a test in a folder no gate runs turns the gate red, so a refusal test cannot
// sit unrun the way test/deploy/guards.test.ts once did.
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname } from "node:path";
import { contractTestProblems, contractTestsReport, HARDHAT_ONLY } from "./contract-tests.ts";
import { isGateTest } from "../scan.ts";

const A_TEST = 'import { describe, test } from "bun:test";\ndescribe("x", () => { test("y", () => {}); });\n';
const A_FOUNDRY_TEST = "contract T is Test { function test_y() public {} }\n";

// A scratch checkout holding the given files under contracts/test, as git lists them.
const scratch = (files: Readonly<Record<string, string>>): string => {
  const repo = mkdtempSync(`${tmpdir()}/contract-tests-`);
  Object.entries(files).forEach(([file, text]) => {
    mkdirSync(dirname(`${repo}/contracts/test/${file}`), { recursive: true });
    writeFileSync(`${repo}/contracts/test/${file}`, text);
  });
  Bun.spawnSync(["git", "init", "-q"], { cwd: repo });
  return repo;
};

const listed = (repoFiles: Readonly<Record<string, string>>): Readonly<Record<string, string>> => ({
  ...Object.fromEntries(HARDHAT_ONLY.map((file) => [file, A_TEST])),
  ...repoFiles,
});

describe("a contract test in a folder no gate runs makes the gate red", () => {
  test("a clean checkout (gated tests and the listed Hardhat-only ones) passes", () => {
    const report = contractTestsReport(scratch(listed({ "vm/area/a.test.ts": A_TEST, "gate/g.test.ts": A_TEST, "foundry/units/U.t.sol": A_FOUNDRY_TEST })));
    expect(report.lines.at(-1)).toContain("CONTRACT_TESTS_OK");
    expect(report.failed).toBe(false);
  });

  test("R-GATE-CONTRACT-TESTS a test in a folder no gate runs is red and named", () => {
    const report = contractTestsReport(scratch(listed({ "ungated/x.test.ts": A_TEST })));
    expect(report.failed).toBe(true);
    expect(report.lines.join("\n")).toContain("UNGATED_CONTRACT_TEST contracts/test/ungated/x.test.ts");
  });

  test("the folders the deploy and A12 tests once sat in are red too", () => {
    const report = contractTestsReport(scratch(listed({ "deploy/guards.test.ts": A_TEST, "a12/a12.test.ts": A_TEST })));
    expect(report.lines.join("\n")).toContain("UNGATED_CONTRACT_TEST contracts/test/deploy/guards.test.ts");
    expect(report.lines.join("\n")).toContain("UNGATED_CONTRACT_TEST contracts/test/a12/a12.test.ts");
  });

  test("a vm file outside an area folder is red: the workflow glob does not run it", () => {
    expect(contractTestsReport(scratch(listed({ "vm/loose.test.ts": A_TEST }))).failed).toBe(true);
  });

  test("a Foundry test outside foundry/ is red", () => {
    expect(contractTestsReport(scratch(listed({ "units/U.t.sol": A_FOUNDRY_TEST }))).failed).toBe(true);
  });

  test("a helper that holds no check is not a test", () => {
    expect(contractTestsReport(scratch(listed({ "helpers/h.ts": "export const h = 1;\n", "fixtures/f.ts": "export const f = 1;\n" }))).failed).toBe(false);
  });

  test("a listed Hardhat-only file that is gone is red", () => {
    const files = listed({});
    const [gone] = HARDHAT_ONLY;
    delete (files as Record<string, string>)[gone ?? ""];
    expect(contractTestsReport(scratch(files)).lines.join("\n")).toContain(`STALE_HARDHAT_ONLY contracts/test/${gone}: no such test`);
  });
});

describe("the placement rule itself", () => {
  test("a listed file that now sits in a gate folder is stale", () => {
    expect(contractTestProblems(["gate/moved.test.ts"], ["gate/moved.test.ts"])).toEqual(["STALE_HARDHAT_ONLY contracts/test/gate/moved.test.ts: a gate runs it now (drop it from the list)"]);
  });

  test("the gate folders are exactly vm/<area>, gate and foundry", () => {
    expect(["vm/a/x.test.ts", "vm/a/x.test.mjs", "gate/x.test.ts", "foundry/j5/X.t.sol"].every(isGateTest)).toBe(true);
    expect(["vm/x.test.ts", "vm/a/b/x.test.ts", "gate/x.ts", "gate/sub/x.test.ts", "dispute/x.test.ts", "foundry/X.sol"].some(isGateTest)).toBe(false);
  });
});
