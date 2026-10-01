// bun test runs every file in one process, so a test file that assigns process.env at load time changes the world for
// every file that runs after it. validator-reforward set WALK_BOARD=1 that way: the board joined the world of the
// files after it, and scenario "unilateral dispute" seed 0x303a (SEEDX=12345) diverged from og in the one-process
// suite while passing alone. A test states what it needs through the world it opens; only a default that leaves an
// already-set value alone (`process.env["K"] = process.env["K"] ?? ...`) may be assigned at load.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ENV_ASSIGN = /process\.env(?:\[\s*"([A-Za-z0-9_]+)"\s*\]|\.([A-Za-z0-9_]+))\s*=(?!=)\s*(.*)/;

/** Lines that assign process.env other than as a default over the same key. */
export const overwrites = (source: string): readonly string[] =>
  source.split("\n").flatMap((line, i) => {
    const m = ENV_ASSIGN.exec(line);
    if (m === null) return [];
    const key = m[1] ?? m[2]!;
    const isDefault = m[3]!.startsWith(`process.env["${key}"] ??`) || m[3]!.startsWith(`process.env.${key} ??`);
    return isDefault ? [] : [`${i + 1}: ${line.trim()}`];
  });

describe("env isolation: test files", () => {
  test("the scan sees an overwrite and lets a default through", () => {
    expect(overwrites('process.env["WALK_BOARD"] = "1";')).toEqual(['1: process.env["WALK_BOARD"] = "1";']);
    expect(overwrites('process.env["K"] = process.env["K"] ?? "x";')).toEqual([]);
    expect(overwrites('if (process.env["K"] === "1") {}')).toEqual([]);
  });

  test("no file of the suite overwrites process.env at load", () => {
    const dir = join(import.meta.dir, "..");
    const files = [...new Bun.Glob("**/*.ts").scanSync({ cwd: dir })].filter((f) => f !== "rig/env-isolation.test.ts");
    const found = files.flatMap((f) => overwrites(readFileSync(join(dir, f), "utf8")).map((l) => `${f}:${l}`));
    expect(found).toEqual([]);
  }, 60_000);
});
