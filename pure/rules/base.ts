// The register as it was at the base commit, for the ratchet. A git failure is a failure, never "no base".
import type { Register } from "./model.ts";
import type { Result } from "./register.ts";
import { readRegisterAt } from "./layout/store.ts";

export type BaseRegister = Readonly<{ _tag: "Introduced" }> | Readonly<{ _tag: "Base"; sha: string; register: Register }>;

export type BaseError = Readonly<{ _tag: "BaseUnreadable"; detail: string }>;

type Git = Readonly<{ code: number; out: string; err: string }>;

const git = (repo: string, args: readonly string[]): Git => {
  const run = Bun.spawnSync(["git", ...args], { cwd: repo });
  return { code: run.exitCode, out: run.stdout.toString().trim(), err: run.stderr.toString().trim() };
};

const unreadable = (detail: string): Result<never, BaseError> => ({ ok: false, error: { _tag: "BaseUnreadable", detail } });

export const readBase = (repo: string, baseRef: string): Result<BaseRegister, BaseError> => {
  const mergeBase = git(repo, ["merge-base", baseRef, "HEAD"]);
  if (mergeBase.code !== 0 || mergeBase.out === "") return unreadable(`no merge base with ${baseRef} (fetch it first): ${mergeBase.err}`);
  const at = readRegisterAt(repo, mergeBase.out);
  if (!at.ok) return unreadable(`${at.error.detail} (the base is ${mergeBase.out.slice(0, 7)})`);
  // A base without a register is the commit that introduces it: nothing to hold it to yet.
  return at.value._tag === "Absent"
    ? { ok: true, value: { _tag: "Introduced" } }
    : { ok: true, value: { _tag: "Base", sha: mergeBase.out, register: at.value.register } };
};
