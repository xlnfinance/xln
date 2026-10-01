// The Bun version part of the gate: a Bun older than pure/package.json asks for turns the command red at the start.
import { describe, expect, test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname } from "node:path";
import { atLeast, bunReport, installLine, requiredBun } from "./bun-version.ts";
import { existingFiles } from "./folder-width.ts";

const pureRoot = `${import.meta.dir}/../..`;
const pkg = (bun: string): string => `{ "name": "p", "engines": { "bun": "${bun}" } }`;

describe("version order", () => {
  test("equal and newer pass, older fails", () => {
    expect(atLeast([1, 4, 0], [1, 4, 0])).toBe(true);
    expect(atLeast([1, 4, 2], [1, 4, 0])).toBe(true);
    expect(atLeast([1, 3, 14], [1, 4, 0])).toBe(false);
    expect(atLeast([1, 3, 11], [1, 4, 0])).toBe(false);
  });
  test("numbers compare as numbers, not as text", () => {
    expect(atLeast([1, 10, 0], [1, 4, 2])).toBe(true);
    expect(atLeast([2, 0, 0], [1, 9, 9])).toBe(true);
  });
});

describe("the report", () => {
  test("Bun 1.3.11 fails and names the required version", () => {
    const report = bunReport("1.3.11", pkg(">=1.4.0"));
    expect(report.failed).toBe(true);
    expect(report.line).toContain(">=1.4.0");
    expect(report.line).toContain("1.3.11");
    expect(report.line).toContain('curl -fsSL https://bun.sh/install | bash -s "bun-v1.4.0"');
    expect(report.line).toContain("which bun");
  });
  test("the install line names the pinned version", () => expect(installLine("1.4.0")).toBe('curl -fsSL https://bun.sh/install | bash -s "bun-v1.4.0"'));
  test("the pinned version and a newer one pass", () => {
    expect(bunReport("1.4.0", pkg(">=1.4.0")).failed).toBe(false);
    expect(bunReport("1.4.2", pkg(">=1.4.0")).failed).toBe(false);
  });
  test("a pin that is missing or not >=x.y.z is a failure, so it cannot rot silently", () => {
    expect(requiredBun('{ "name": "p" }').ok).toBe(false);
    expect(requiredBun(pkg("^1.4.0")).ok).toBe(false);
    expect(requiredBun(pkg(">=1.4")).ok).toBe(false);
    expect(requiredBun(pkg("<=1.4.0")).ok).toBe(false);
    expect(requiredBun(pkg(">=1.4.0-beta")).ok).toBe(false);
    expect(requiredBun(pkg(">=v1.4.0")).ok).toBe(false);
    expect(bunReport("1.4.2", '{ "name": "p" }').failed).toBe(true);
  });
  test("a Bun version that is not x.y.z fails", () => {
    expect(bunReport("canary", pkg(">=1.4.0")).failed).toBe(true);
    expect(bunReport("1.4.0-canary.1", pkg(">=1.4.0")).failed).toBe(true);
    expect(bunReport("v1.4.2", pkg(">=1.4.0")).failed).toBe(true);
  });
  test("the real package.json asks for a Bun the running one satisfies", () => {
    const real = Bun.spawnSync(["cat", `${pureRoot}/package.json`]).stdout.toString();
    expect(requiredBun(real).ok).toBe(true);
    expect(bunReport(Bun.version, real).failed).toBe(false);
  });
});

// The real command over a scratch copy whose package.json asks for a Bun newer than any that exists.
describe("the real command", () => {
  const scratch = (packageJson: string): string => {
    const repo = mkdtempSync(`${tmpdir()}/bun-pin-`);
    existingFiles(pureRoot).forEach((file) => {
      mkdirSync(dirname(`${repo}/pure/${file}`), { recursive: true });
      copyFileSync(`${pureRoot}/${file}`, `${repo}/pure/${file}`);
    });
    writeFileSync(`${repo}/pure/package.json`, packageJson);
    Bun.spawnSync(["git", "init", "-q"], { cwd: repo });
    return repo;
  };
  const run = (repo: string): Readonly<{ code: number | null; out: string }> => {
    const done = Bun.spawnSync([process.execPath, `${repo}/pure/rules/check.ts`, "--bun-only"], { cwd: `${repo}/pure` });
    return { code: done.exitCode, out: done.stdout.toString() + done.stderr.toString() };
  };

  test("a package.json that asks for a newer Bun exits 1 and names it", () => {
    const { code, out } = run(scratch(pkg(">=99.0.0")));
    expect(code).toBe(1);
    expect(out).toContain(">=99.0.0");
  });
  test("the same copy with a satisfied pin exits 0", () => expect(run(scratch(pkg(">=1.4.0"))).code).toBe(0));
});
