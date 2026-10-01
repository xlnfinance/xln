// A private copy of the contracts project for tests that spawn the deploy scripts. `hardhat run` and the matrix script's "always build
// fresh" step both run `hardhat compile`, and a compile rewrites artifacts/build-info, the cache and .typechain-hardhat. Spawned from the
// real project, they replaced the build that the other gate tests read in the same run: on a tree whose sources had moved since the last
// build, the first run failed five tests ("no compiled build matches ...") and every later run passed. Spawned from a copy, the real build
// is only ever read, so a stale build fails the same way on every run until `bash scripts/build.sh` is run.
//
// The copy holds sources and scripts but no build output: sandboxOf compiles it before handing it out (about half a minute, once per test
// process), so what the spawned scripts read is fresh whatever state the real build is in.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/** What a script run needs besides the build output. node_modules and core/ (og's, read-only: the scripts import its Hanko and TRON code) are the parent's, linked. */
const COPIED = ["contracts", "scripts", "deploy", "typechain-types", "vectors", "hardhat.config.ts", "package.json", "tsconfig.json"] as const;

const made: string[] = [];
process.on("exit", () => { for (const dir of made) rmSync(dir, { recursive: true, force: true }); });

/** A fresh private copy of `projectRoot`, returned as the copy's project root. Removed when the process exits. */
export const copyProject = (projectRoot: string): string => {
  const base = mkdtempSync(path.join(tmpdir(), "xln-project-sandbox-"));
  made.push(base);
  const copy = path.join(base, path.basename(projectRoot));
  for (const entry of COPIED.filter((name) => existsSync(path.join(projectRoot, name)))) cpSync(path.join(projectRoot, entry), path.join(copy, entry), { recursive: true });
  for (const shared of ["node_modules", "core"]) {
    const source = path.join(path.dirname(projectRoot), shared);
    if (existsSync(source)) symlinkSync(source, path.join(base, shared), "dir");
  }
  return copy;
};

const sandboxes = new Map<string, string>();

/** The one private copy of `projectRoot` for this test process: scripts that may compile run here, never in the real project. */
export const sandboxOf = (projectRoot: string): string => {
  const known = sandboxes.get(projectRoot);
  if (known !== undefined) return known;
  const copy = copyProject(projectRoot);
  const compiled = spawnSync("bunx", ["--bun", "hardhat", "compile"], {
    cwd: copy, encoding: "utf8", timeout: 600_000, env: { ...process.env, HARDHAT_EXPERIMENTAL_ALLOW_NON_LOCAL_INSTALLATION: "true" },
  });
  if (compiled.status !== 0) throw new Error(`the sandbox did not compile:\n${compiled.stdout}${compiled.stderr}`);
  sandboxes.set(projectRoot, copy);
  return copy;
};

/** Run a command in the project's private copy (the one door the gate tests spawn compiling scripts through). */
export const runInSandbox = (projectRoot: string, command: string, args: readonly string[], options: { env?: NodeJS.ProcessEnv; timeout?: number } = {}) =>
  spawnSync(command, [...args], { cwd: sandboxOf(projectRoot), encoding: "utf8", timeout: options.timeout ?? 240_000, env: { ...process.env, ...options.env } });

/** Every file under the build output, by path and content: any rewrite, addition or removal changes it. */
export const buildFingerprint = (root: string): string => {
  const hash = createHash("sha256");
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else hash.update(path.relative(root, full)).update(readFileSync(full));
    }
  };
  walk(path.join(root, "artifacts"));
  return hash.digest("hex");
};
