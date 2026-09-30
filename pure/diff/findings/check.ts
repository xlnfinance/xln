// The known-findings ratchet. From pure/:   bun diff/findings/check.ts
//   --base <ref>   the ref whose baseline may not be exceeded (default origin/main)
//   --update       drop from baseline.json the sites the table no longer holds (it never adds one)
// Exit 1 when the table holds a site the baseline lacks, the baseline holds one the base commit's lacked, or an entry is empty.
import { readFileSync, writeFileSync } from "node:fs";
import { KNOWN_FINDINGS } from "./known.ts";
import { ratchet, siteIds } from "./ratchet.ts";

const here = import.meta.dir;
const repoRoot = `${here}/../../..`;
const BASELINE_PATH = "pure/diff/findings/baseline.json";
const args = process.argv.slice(2);
const baseRef = args[args.indexOf("--base") + 1] ?? "origin/main";

const git = (...argv: readonly string[]) => {
  const run = Bun.spawnSync(["git", ...argv], { cwd: repoRoot });
  return { code: run.exitCode, out: run.stdout.toString().trim(), err: run.stderr.toString().trim() };
};
const parse = (text: string): readonly string[] => (JSON.parse(text) as { sites: readonly string[] }).sites;

/** The baseline at the merge base: undefined when that commit has none; a git failure is a failure. */
const baseBaseline = (): readonly string[] | undefined => {
  const mergeBase = git("merge-base", baseRef, "HEAD");
  if (mergeBase.code !== 0 || mergeBase.out === "") {
    console.error(`FAIL no merge base with ${baseRef} (fetch it first): ${mergeBase.err}`);
    process.exit(1);
  }
  const listing = git("ls-tree", mergeBase.out, "--", BASELINE_PATH);
  if (listing.code !== 0) {
    console.error(`FAIL git ls-tree at ${mergeBase.out.slice(0, 7)}: ${listing.err}`);
    process.exit(1);
  }
  if (listing.out === "") return undefined;
  const shown = git("show", `${mergeBase.out}:${BASELINE_PATH}`);
  if (shown.code !== 0) {
    console.error(`FAIL git show at ${mergeBase.out.slice(0, 7)}: ${shown.err}`);
    process.exit(1);
  }
  return parse(shown.out);
};

const baseline = parse(readFileSync(`${here}/baseline.json`, "utf8"));
const now = siteIds(KNOWN_FINDINGS);

if (args.includes("--update")) {
  writeFileSync(`${here}/baseline.json`, `${JSON.stringify({ sites: baseline.filter((site) => now.includes(site)) }, null, 2)}\n`);
}

const problems = ratchet(KNOWN_FINDINGS, baseline, baseBaseline());
now.forEach((site) => console.log(`known  ${site}`));
problems.forEach((problem) => console.log(`FAIL ${JSON.stringify(problem)}`));
console.log(problems.length === 0 ? `OK: ${now.length} known sites, baseline ${baseline.length}` : `FAIL: ${problems.length} problems`);
process.exit(problems.length === 0 ? 0 : 1);
