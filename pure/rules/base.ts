// The register as it was at the base commit, for the ratchet. A git failure is a failure, never "no base".
import type { Register } from "./model.ts";
import { parseRegister, type Result } from "./register.ts";

export type BaseRegister = Readonly<{ _tag: "Introduced" }> | Readonly<{ _tag: "Base"; sha: string; register: Register }>;

export type BaseError = Readonly<{ _tag: "BaseUnreadable"; detail: string }>;

const REGISTER_PATH = "pure/rules/register.json";

type Git = Readonly<{ code: number; out: string; err: string }>;

const git = (repo: string, args: readonly string[]): Git => {
  const run = Bun.spawnSync(["git", ...args], { cwd: repo });
  return { code: run.exitCode, out: run.stdout.toString().trim(), err: run.stderr.toString().trim() };
};

const unreadable = (detail: string): Result<never, BaseError> => ({ ok: false, error: { _tag: "BaseUnreadable", detail } });

export const readBase = (repo: string, baseRef: string): Result<BaseRegister, BaseError> => {
  const mergeBase = git(repo, ["merge-base", baseRef, "HEAD"]);
  if (mergeBase.code !== 0 || mergeBase.out === "") return unreadable(`no merge base with ${baseRef} (fetch it first): ${mergeBase.err}`);
  const listing = git(repo, ["ls-tree", mergeBase.out, "--", REGISTER_PATH]);
  if (listing.code !== 0) return unreadable(`git ls-tree failed at ${mergeBase.out.slice(0, 7)}: ${listing.err}`);
  // A base without the file is the commit that introduces the register: nothing to hold it to yet.
  if (listing.out === "") return { ok: true, value: { _tag: "Introduced" } };
  const shown = git(repo, ["show", `${mergeBase.out}:${REGISTER_PATH}`]);
  if (shown.code !== 0) return unreadable(`git show failed at ${mergeBase.out.slice(0, 7)}: ${shown.err}`);
  const parsed = parseRegister(shown.out);
  return parsed.ok
    ? { ok: true, value: { _tag: "Base", sha: mergeBase.out, register: parsed.value } }
    : unreadable(`the base register does not parse: ${parsed.error.detail}`);
};
