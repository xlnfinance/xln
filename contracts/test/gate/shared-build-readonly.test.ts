// The gate tests read the real build (artifacts/build-info, .typechain-hardhat) and also spawn scripts that compile: `hardhat run` and the matrix
// script's "always build fresh" step. Spawned in the real project, a compile replaced the build the other tests were reading: on a tree whose
// sources had moved since the last build, the first run failed five tests and every later run passed (PR 81, merge thread, 2026-10-01).
// The spawns now go through test/helpers/project-sandbox.ts. These tests keep that true on a tiny project, so they do not wait for a real build.
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { buildFingerprint, copyProject, runInSandbox, sandboxOf } from "../helpers/project-sandbox.ts";

const realRoot = path.join(import.meta.dir, "..", "..");
const ENV = { HARDHAT_EXPERIMENTAL_ALLOW_NON_LOCAL_INSTALLATION: "true" };
const hardhat = (cwd: string, args: string[]) => spawnSync("bunx", ["--bun", "hardhat", ...args], { cwd, encoding: "utf8", timeout: 240_000, env: { ...process.env, ...ENV } });

const TINY = (note: string) => `// SPDX-License-Identifier: MIT\npragma solidity ^0.8.20;\ncontract Tiny { function one() external pure returns (uint256) { return 1; } }\n// ${note}\n`;
const PROBE = "console.log('probe ran');\n";

/** A one-contract project with a build that is STALE: the source was edited after the last compile. */
const staleProject = (): string => {
  const root = copyProject(realRoot);
  rmSync(path.join(root, "contracts"), { recursive: true });
  for (const dir of ["scripts", "deploy", "typechain-types", "vectors"]) rmSync(path.join(root, dir), { recursive: true, force: true });
  mkdirSync(path.join(root, "contracts"));
  mkdirSync(path.join(root, "scripts"));
  writeFileSync(path.join(root, "contracts", "Tiny.sol"), TINY("first"));
  writeFileSync(path.join(root, "scripts", "probe.cjs"), PROBE);
  const built = hardhat(root, ["compile"]);
  if (built.status !== 0) throw new Error(`the tiny project did not compile:\n${built.stdout}${built.stderr}`);
  writeFileSync(path.join(root, "contracts", "Tiny.sol"), TINY("edited after the build"));
  return root;
};

describe("a script that compiles never rewrites the build the gate tests read", () => {
  test("the premise: `hardhat run` on a project whose build is stale rewrites that project's build output", () => {
    const project = staleProject();
    const before = buildFingerprint(project);
    const run = hardhat(project, ["run", "scripts/probe.cjs"]);
    expect(run.stdout).toContain("probe ran");
    expect(buildFingerprint(project)).not.toBe(before);
  }, 300_000);

  test("spawned through the sandbox it leaves the stale build exactly as it was, and still runs", () => {
    const project = staleProject();
    const before = buildFingerprint(project);
    const run = runInSandbox(project, "bunx", ["--bun", "hardhat", "run", "scripts/probe.cjs"], { env: ENV });
    expect(run.stdout).toContain("probe ran");
    expect(buildFingerprint(project)).toBe(before);
  }, 300_000);

  test("the sandbox compiles for itself: the build its scripts read matches the current sources although the project's build is stale", () => {
    const project = staleProject();
    expect(runInSandbox(project, "bunx", ["--bun", "hardhat", "run", "scripts/probe.cjs"], { env: ENV }).status).toBe(0);
    const infoDir = path.join(sandboxOf(project), "artifacts", "build-info");
    const inputs = readdirSync(infoDir).filter((name) => !name.endsWith(".output.json")).map((name) => readFileSync(path.join(infoDir, name), "utf8"));
    expect(inputs.some((text) => text.includes("edited after the build"))).toBe(true);
    const staleDir = path.join(project, "artifacts", "build-info");
    expect(readdirSync(staleDir).filter((name) => !name.endsWith(".output.json")).some((name) => readFileSync(path.join(staleDir, name), "utf8").includes("edited after the build"))).toBe(false);
  }, 300_000);
});
