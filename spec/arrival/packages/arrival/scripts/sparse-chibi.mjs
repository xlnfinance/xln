#!/usr/bin/env node
/**
 * Sparse-checkout the chibi-scheme submodule to the two corpus files the
 * conformance harness reads, plus COPYING. The gitlink SHA is still the full
 * chibi tree (bump the submodule to track a branch); the working tree is not.
 *
 * No-ops when the submodule is not initialized (those tests skip). Disable
 * with `git -C packages/arrival/vendor/chibi-scheme sparse-checkout disable`.
 */
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const chibi = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../vendor/chibi-scheme");
if (!existsSync(path.join(chibi, ".git"))) process.exit(0);

function git(...args) {
  const r = spawnSync("git", args, { cwd: chibi, encoding: "utf8" });
  if (r.status !== 0) {
    process.stderr.write(r.stderr || r.stdout || `git ${args.join(" ")} failed\n`);
    process.exit(r.status ?? 1);
  }
}

git("sparse-checkout", "init", "--no-cone");
git("sparse-checkout", "set", "--no-cone", "/COPYING", "/tests/r7rs-tests.scm", "/lib/srfi/1/test.sld");
