// og is core/ and jurisdictions/ at 566c850 and is never edited, not even to debug. This gate fails a branch
// whose diff against its base touches either folder.   bun rules/frozen.ts [base-ref]   (default origin/main)
export const FROZEN_ROOTS: readonly string[] = ["core/", "jurisdictions/"];

export const frozenTouches = (paths: readonly string[]): readonly string[] =>
  paths.filter((path) => FROZEN_ROOTS.some((root) => path.startsWith(root)));

const git = (args: readonly string[]): readonly string[] => {
  const run = Bun.spawnSync(["git", ...args], { cwd: `${import.meta.dir}/../../..` });
  return run.exitCode === 0 ? run.stdout.toString().split("\n").filter((line) => line !== "") : [];
};

const run = (): number => {
  const base = process.argv[2] ?? "origin/main";
  const [mergeBase] = git(["merge-base", base, "HEAD"]);
  if (mergeBase === undefined) {
    console.error(`FAIL no merge base with ${base}; fetch it first`);
    return 1;
  }
  // The branch's commits, its uncommitted edits to tracked files, and new untracked files.
  const changed = [...git(["diff", "--name-only", mergeBase]), ...git(["ls-files", "--others", "--exclude-standard"])];
  const touched = frozenTouches(changed);
  touched.forEach((path) => console.error(`FAIL ${path} is under og (${FROZEN_ROOTS.join(", ")}); monkeypatch from a test instead`));
  console.log(touched.length === 0 ? `ok   no change under ${FROZEN_ROOTS.join(" or ")} since ${mergeBase.slice(0, 7)}` : `${touched.length} frozen files touched`);
  return touched.length === 0 ? 0 : 1;
};

if (import.meta.main) process.exit(run());
