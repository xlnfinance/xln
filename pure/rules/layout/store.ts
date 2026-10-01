// The register's two edges: the folder in a checkout and a commit's copy of it. Reading files and calling git live here; parsing is register.ts.
// A commit from before the split holds one register.json; the ratchet and the progress report may be pointed at such a commit, so both layouts are read.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import type { Register } from "../model.ts";
import { parseRegister, parseRegisterFiles, type ParseError, type RegisterFile, type Result } from "../register.ts";

export const REGISTER_DIR = "pure/rules/register";
// The layout before the split: one file of every rule. Read at an old commit only; a checkout that still has it is red.
export const REGISTER_FILE = "pure/rules/register.json";

export type AtCommit = Readonly<{ _tag: "Absent" }> | Readonly<{ _tag: "Found"; register: Register }>;

const failure = (detail: string): Result<never, ParseError> => ({ ok: false, error: { _tag: "BadRegister", where: "register", detail } });

// The folder of a checkout. Anything that is not a file, and any file that is not <id>.json, is refused by the parser or here.
export const readRegisterFolder = (dir: string): Result<Register, ParseError> => {
  if (!existsSync(dir)) return failure(`${dir} does not exist`);
  // A register.json beside the folder is a second copy that would drift from it.
  if (existsSync(`${dir}.json`)) return failure(`${dir}.json still exists: the register is the folder (one <id>.json per rule), so the old file must be deleted`);
  // A name that starts with a dot (.DS_Store, an editor's swap file) is local junk, never a rule: no rule id starts with one.
  const entries = readdirSync(dir, { withFileTypes: true }).filter((entry) => !entry.name.startsWith("."));
  const stray = entries.find((entry) => !entry.isFile());
  return stray !== undefined
    ? failure(`${stray.name} is not a file: only <id>.json files belong in the register folder`)
    : parseRegisterFiles(entries.map((entry): RegisterFile => ({ name: entry.name, text: readFileSync(`${dir}/${entry.name}`, "utf8") })));
};

type Git = Readonly<{ code: number; out: string; err: string }>;

const git = (repo: string, args: readonly string[]): Git => {
  const run = Bun.spawnSync(["git", ...args], { cwd: repo });
  return { code: run.exitCode, out: run.stdout.toString(), err: run.stderr.toString().trim() };
};

const filesAt = (repo: string, sha: string, paths: readonly string[]): Result<readonly RegisterFile[], ParseError> => {
  const shown = paths.map((path) => ({ path, run: git(repo, ["show", `${sha}:${path}`]) }));
  const failed = shown.find((each) => each.run.code !== 0);
  return failed !== undefined
    ? failure(`git show ${failed.path} failed at ${sha.slice(0, 7)}: ${failed.run.err}`)
    : { ok: true, value: shown.map((each) => ({ name: each.path.slice(each.path.lastIndexOf("/") + 1), text: each.run.out })) };
};

// The register as a commit holds it, in whichever layout that commit uses. A git failure is an error, never "absent".
export const readRegisterAt = (repo: string, sha: string): Result<AtCommit, ParseError> => {
  const folder = git(repo, ["ls-tree", "-r", "--name-only", sha, "--", `${REGISTER_DIR}/`]);
  if (folder.code !== 0) return failure(`git ls-tree failed at ${sha.slice(0, 7)}: ${folder.err}`);
  const paths = folder.out.split("\n").filter((path) => path !== "");
  if (paths.length > 0) {
    const files = filesAt(repo, sha, paths);
    if (!files.ok) return files;
    const parsed = parseRegisterFiles(files.value);
    return parsed.ok ? { ok: true, value: { _tag: "Found", register: parsed.value } } : parsed;
  }
  const single = git(repo, ["ls-tree", sha, "--", REGISTER_FILE]);
  if (single.code !== 0) return failure(`git ls-tree failed at ${sha.slice(0, 7)}: ${single.err}`);
  if (single.out.trim() === "") return { ok: true, value: { _tag: "Absent" } };
  const files = filesAt(repo, sha, [REGISTER_FILE]);
  if (!files.ok) return files;
  const parsed = parseRegister(files.value[0]?.text ?? "");
  return parsed.ok ? { ok: true, value: { _tag: "Found", register: parsed.value } } : parsed;
};
