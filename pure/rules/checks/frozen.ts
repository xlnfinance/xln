// og is core/ and jurisdictions/ at 566c850 and is never edited, not even to debug. This gate fails when the tree
// differs from that commit under either folder, however it differs: edited, deleted, moved out, mode-changed, added
// or untracked. The allowlist is empty for good, so the gate is green only because og is untouched.
//   bun rules/checks/frozen.ts
import type { Result } from "../register.ts";

export const OG_COMMIT = "566c850";

export const FROZEN_ROOTS: readonly string[] = ["core/", "jurisdictions/"];

// Empty on purpose and for good. A path here would be og edited with permission, and there is none.
export const ALLOWED_DRIFT: readonly string[] = [];

export type GitFailure = Readonly<{ _tag: "GitFailed"; detail: string }>;

export const frozenTouches = (paths: readonly string[]): readonly string[] =>
  paths.filter((path) => FROZEN_ROOTS.some((root) => path.startsWith(root)) && !ALLOWED_DRIFT.includes(path));

const failed = (detail: string): Result<never, GitFailure> => ({ ok: false, error: { _tag: "GitFailed", detail } });

// NUL-separated output, so a path with a non-ASCII or odd character is never quoted by git.
const gitPaths = (repo: string, args: readonly string[]): Result<readonly string[], GitFailure> => {
  const run = Bun.spawnSync(["git", ...args], { cwd: repo });
  return run.exitCode === 0
    ? { ok: true, value: run.stdout.toString().split("\0").filter((path) => path !== "") }
    : failed(`git ${args.join(" ")} exited ${run.exitCode}: ${run.stderr.toString().trim()}`);
};

// Every path under the frozen roots that differs from `pin` in the working tree, plus untracked files there.
// --no-renames lists both ends of a move, so a file moved out of core/ shows its old path.
export const frozenDrift = (repo: string, pin: string): Result<readonly string[], GitFailure> => {
  const known = gitPaths(repo, ["rev-parse", "--verify", "--quiet", `${pin}^{commit}`]);
  if (!known.ok) return failed(`${pin} is not in this clone (fetch it): ${known.error.detail}`);
  const roots = FROZEN_ROOTS.map((root) => root.replace(/\/$/, ""));
  const changed = gitPaths(repo, ["diff", "--no-renames", "--name-only", "-z", pin, "--", ...roots]);
  const untracked = gitPaths(repo, ["ls-files", "-z", "--others", "--exclude-standard", "--", ...roots]);
  if (!changed.ok) return changed;
  if (!untracked.ok) return untracked;
  return { ok: true, value: frozenTouches([...changed.value, ...untracked.value]) };
};

const run = (): number => {
  const drift = frozenDrift(`${import.meta.dir}/../../..`, OG_COMMIT);
  if (!drift.ok) {
    console.error(`FAIL ${drift.error.detail}`);
    return 1;
  }
  drift.value.forEach((path) => console.error(`FAIL ${path} differs from og at ${OG_COMMIT}; monkeypatch from a test instead`));
  console.log(drift.value.length === 0 ? `ok   core/ and jurisdictions/ are identical to ${OG_COMMIT}` : `${drift.value.length} frozen paths differ`);
  return drift.value.length === 0 ? 0 : 1;
};

if (import.meta.main) process.exit(run());
