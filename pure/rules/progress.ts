// The progress report. From pure/:   bun rules/progress.ts [--since <ref>]
// For each register column (Arrival, Quint, ts code, contracts, walk): how many rules hold out of how many the column must carry,
// and the total as a percent. The six goal milestones follow, each decided by a check that already exists (a register column, or the
// Sepolia manifest); the one with no check yet prints as unchecked. With --since the report adds how many rules the register gained
// since that commit and how each column's denominator moved, so a growing denominator is visible.
// Read-only. It never changes the register and never fails the gate; it exits 1 only when it cannot read what it reports on.
import { readFileSync } from "node:fs";
import { parseManifest } from "../../contracts/deploy/manifest.ts";
import { evaluate } from "./evaluate.ts";
import { parseRegister } from "./register.ts";
import { scanNames } from "./scan.ts";
import { addedSince, columnsOf, milestonesOf, registerColumns, renderProgress, type Deployment, type Since } from "./progress/measure.ts";

const here = import.meta.dir;
const repoRoot = `${here}/../..`;
const REGISTER_PATH = "pure/rules/register.json";
const MANIFEST_PATH = `${repoRoot}/contracts/deploy/sepolia.manifest.json`;

const fail = (detail: string): never => {
  console.error(`FAIL ${detail}`);
  return process.exit(1);
};

const git = (args: readonly string[]): Readonly<{ code: number; out: string; err: string }> => {
  const run = Bun.spawnSync(["git", ...args], { cwd: repoRoot });
  return { code: run.exitCode, out: run.stdout.toString().trim(), err: run.stderr.toString().trim() };
};

const args = process.argv.slice(2);
const sinceAt = args.indexOf("--since");
const sinceRef = sinceAt === -1 ? undefined : args[sinceAt + 1];
const known = sinceAt === -1 ? args.length === 0 : args.length === 2 && sinceRef !== undefined;
if (!known) fail("usage: bun rules/progress.ts [--since <ref>]");

const readRegister = (text: string, where: string) => {
  const parsed = parseRegister(text);
  return parsed.ok ? parsed.value : fail(`${where}: ${parsed.error.where}: ${parsed.error.detail}`);
};

// The register at the commit `ref` names, exactly: the commit itself, not the merge base with HEAD.
const registerAt = (ref: string) => {
  const sha = git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
  if (sha.code !== 0 || sha.out === "") return fail(`--since ${ref}: not a commit in this repository (fetch it first)`);
  const shown = git(["show", `${sha.out}:${REGISTER_PATH}`]);
  return shown.code === 0
    ? { sha: sha.out, register: readRegister(shown.out, `the register at ${ref}`) }
    : fail(`--since ${ref}: ${REGISTER_PATH} cannot be read at ${sha.out.slice(0, 7)}: ${shown.err}`);
};

const deployment = (): Deployment => {
  const verdict = parseManifest(JSON.parse(readFileSync(MANIFEST_PATH, "utf8")));
  return !verdict.ok
    ? { deployed: false, detail: `invalid (${verdict.problems.join("; ")})` }
    : { deployed: verdict.value.status === "deployed" && verdict.value.contracts !== null, detail: `status ${verdict.value.status} on ${verdict.value.network}` };
};

const register = readRegister(readFileSync(`${here}/register.json`, "utf8"), "register.json");
const evaluation = evaluate(register, scanNames(repoRoot));
const columns = columnsOf(evaluation.reports);

const since = (ref: string): Since => {
  const base = registerAt(ref);
  return { ref: base.sha.slice(0, 7), added: addedSince(base.register, register), then: registerColumns(base.register) };
};

const head = git(["rev-parse", "--short", "HEAD"]);

console.log(
  renderProgress({
    at: head.code === 0 ? head.out : "an unborn branch",
    liveRules: register.filter((row) => row.retiredBy === undefined).length,
    columns,
    milestones: milestonesOf(columns, deployment()),
    since: sinceRef === undefined ? undefined : since(sinceRef),
    problems: evaluation.problems.length,
  }),
);
