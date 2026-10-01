// The known-findings ratchet. From pure/:   bun diff/findings/check.ts
//   --base <ref>   the ref whose baseline may not be exceeded (default origin/main)
//   --update       drop from baseline.json the sites the table no longer holds and lower the line counts it now expects less of (it never adds or raises one)
// Exit 1 when the table holds a site, or more lines at a site, than the baseline allows, the baseline holds more than the base commit's,
// a finding repeats a site, names a rule that is not a live row of pure/rules/register.json, or an entry is empty.
import { readFileSync, writeFileSync } from "node:fs";
import { KNOWN_FINDINGS } from "./known.ts";
import { ratchet, siteLines, type Baseline } from "./ratchet.ts";

const here = import.meta.dir;
const repoRoot = `${here}/../../..`;
const BASELINE_PATH = "pure/diff/findings/baseline.json";
const args = process.argv.slice(2);
const baseRef = args[args.indexOf("--base") + 1] ?? "origin/main";

const git = (...argv: readonly string[]) => {
  const run = Bun.spawnSync(["git", ...argv], { cwd: repoRoot });
  return { code: run.exitCode, out: run.stdout.toString().trim(), err: run.stderr.toString().trim() };
};
const parse = (text: string): Baseline => (JSON.parse(text) as { sites: Baseline }).sites;
/** The ids of the register's rows that are not retired. */
const liveRules = (): readonly string[] =>
  (JSON.parse(readFileSync(`${here}/../../rules/register.json`, "utf8")) as { rows: readonly { id: string; retired_by?: unknown }[] }).rows
    .filter((row) => row.retired_by === undefined)
    .map((row) => row.id);

/** The baseline at the merge base: undefined when that commit has none; a git failure is a failure. */
const baseBaseline = (): Baseline | undefined => {
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

const readBaseline = (): Baseline => parse(readFileSync(`${here}/baseline.json`, "utf8"));
const now = siteLines(KNOWN_FINDINGS);

if (args.includes("--update")) {
  const before = readBaseline();
  const shrunk = Object.fromEntries(now.flatMap(([site, lines]) => (before[site] === undefined ? [] : [[site, Math.min(lines, before[site])] as const])));
  writeFileSync(`${here}/baseline.json`, `${JSON.stringify({ sites: shrunk }, null, 2)}\n`);
}

const baseline = readBaseline();
const problems = ratchet(KNOWN_FINDINGS, liveRules(), baseline, baseBaseline());
now.forEach(([site, lines]) => console.log(`known  ${site} (${lines} lines)`));
problems.forEach((problem) => console.log(`FAIL ${JSON.stringify(problem)}`));
console.log(problems.length === 0 ? `OK: ${now.length} known sites, baseline ${Object.keys(baseline).length}` : `FAIL: ${problems.length} problems`);
process.exit(problems.length === 0 ? 0 : 1);
