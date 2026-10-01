// The progress report. From pure/:   bun rules/progress.ts [--since <ref>] [--skip-verify]
// For each register column (Arrival, Quint, ts code, contracts, walk): how many rules hold out of how many the column must carry,
// and the total as a percent. The six goal milestones follow, each decided by a check that already exists (a register column, or the
// Sepolia manifest and `bun contracts/deploy/verify.ts`, which reads the chain; --skip-verify leaves that call out); the one with no check
// yet prints as unchecked. The Arrival and Quint milestones are read from origin/main (its
// register and its spec), every other number from this checkout, whose branch and clean or dirty state the header prints. The report
// also says how many rules the register gained and lost since a commit (default: the merge base with origin/main), so a growing or
// shrinking denominator is visible.
// Read-only. It never changes the register and never fails the gate; it exits 1 only when it cannot read what it reports on.
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseManifest } from "../../contracts/deploy/manifest.ts";
import { evaluate } from "./evaluate.ts";
import type { Layer, Register } from "./model.ts";
import { parseJson, parseRegister } from "./register.ts";
import { scanNames } from "./scan.ts";
import {
  addedSince, columnsOf, milestonesOf, registerColumns, renderProgress, retiredSince, verificationOf,
  type Checkout, type Deployment, type Since, type SpecAtMain, type Verification,
} from "./progress/measure.ts";

const here = import.meta.dir;
const repoRoot = `${here}/../..`;
const REGISTER_PATH = "pure/rules/register.json";
const MANIFEST_PATH = `${repoRoot}/contracts/deploy/sepolia.manifest.json`;
const MAIN = "origin/main";
const VERIFY_PATH = `${repoRoot}/contracts/deploy/verify.ts`;
// A public node answers in seconds; a run that has not finished by now is a check that could not be made.
const VERIFY_TIMEOUT_MS = 120_000;

const fail = (detail: string): never => {
  console.error(`FAIL ${detail}`);
  return process.exit(1);
};

const git = (args: readonly string[]): Readonly<{ code: number; out: string; err: string }> => {
  const run = Bun.spawnSync(["git", ...args], { cwd: repoRoot });
  return { code: run.exitCode, out: run.stdout.toString().trim(), err: run.stderr.toString().trim() };
};

const skipVerify = process.argv.slice(2).includes("--skip-verify");
const args = process.argv.slice(2).filter((arg) => arg !== "--skip-verify");
const sinceAt = args.indexOf("--since");
const sinceRef = sinceAt === -1 ? undefined : args[sinceAt + 1];
const known = sinceAt === -1 ? args.length === 0 : args.length === 2 && sinceRef !== undefined;
if (!known) fail("usage: bun rules/progress.ts [--since <ref>] [--skip-verify]");

const readRegister = (text: string, where: string): Register => {
  const parsed = parseRegister(text);
  return parsed.ok ? parsed.value : fail(`${where}: ${parsed.error.where}: ${parsed.error.detail}`);
};

// The commit a ref names, or nothing.
const commitOf = (ref: string): string | undefined => {
  const found = git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
  return found.code === 0 && found.out !== "" ? found.out : undefined;
};

// The register at a commit, exactly: the commit itself, not the merge base with HEAD.
const registerAt = (sha: string, ref: string): Register => {
  const shown = git(["show", `${sha}:${REGISTER_PATH}`]);
  return shown.code === 0
    ? readRegister(shown.out, `the register at ${ref}`)
    : fail(`${ref}: ${REGISTER_PATH} cannot be read at ${sha.slice(0, 7)}: ${shown.err}`);
};

// A manifest that is missing, not JSON or invalid is a deployment that is not recorded, never a crash.
const deployment = (): Deployment => {
  if (!existsSync(MANIFEST_PATH)) return { recorded: false, detail: "missing (contracts/deploy/sepolia.manifest.json)" };
  const json = parseJson(readFileSync(MANIFEST_PATH, "utf8"));
  if (!json.ok) return { recorded: false, detail: `unreadable (${json.error.detail})` };
  const verdict = parseManifest(json.value);
  return !verdict.ok
    ? { recorded: false, detail: `invalid (${verdict.problems.join("; ")})` }
    : { recorded: verdict.value.status === "deployed" && verdict.value.contracts !== null, detail: `status ${verdict.value.status} on ${verdict.value.network}` };
};

// The verifier is asked only about a deployment the manifest records, and only when the run is not offline: its exit code is the answer.
const verification = (recorded: Deployment): Verification | undefined => {
  if (skipVerify || !recorded.recorded) return undefined;
  const run = Bun.spawnSync([process.execPath, VERIFY_PATH], { cwd: repoRoot, timeout: VERIFY_TIMEOUT_MS });
  return verificationOf(run.exitCode, run.stdout.toString(), run.stderr.toString());
};

const SPEC_LAYERS: readonly Layer[] = ["arrival", "quint"];

// A layer root that is not there reads as an empty layer: the layers the spec milestones do not use are pointed at one.
const NOWHERE = "/nonexistent-progress-root";

// The register and the spec as origin/main has them: the spec tree is unpacked from git (without its vendored copy of Arrival, which the
// name reader skips anyway) into a scratch folder that is removed again. Nothing in the checkout is read for these two milestones.
const specAtMain = (): SpecAtMain | undefined => {
  const sha = commitOf(MAIN);
  if (sha === undefined) return undefined;
  const dir = mkdtempSync(join(tmpdir(), "progress-main-"));
  const archive = Bun.spawnSync(["git", "archive", "--format=tar", sha, "--", "spec", ":(exclude)spec/arrival"], { cwd: repoRoot });
  if (archive.exitCode !== 0) return fail(`git archive of the spec at ${MAIN} failed: ${archive.stderr.toString().trim()}`);
  const unpacked = Bun.spawnSync(["tar", "-x", "-C", dir], { stdin: archive.stdout });
  if (unpacked.exitCode !== 0) return fail(`unpacking the spec at ${MAIN} failed: ${unpacked.stderr.toString().trim()}`);
  const names = scanNames(dir, { arrival: `${dir}/spec`, quint: `${dir}/spec/quint`, contract: NOWHERE, rig: NOWHERE, ts: NOWHERE });
  rmSync(dir, { recursive: true, force: true });
  const columns = columnsOf(evaluate(registerAt(sha, MAIN), names).reports).filter((column) => SPEC_LAYERS.includes(column.layer));
  return { ref: sha.slice(0, 7), columns };
};

const checkoutState = (): Checkout => {
  const branch = git(["rev-parse", "--abbrev-ref", "HEAD"]);
  const sha = git(["rev-parse", "--short", "HEAD"]);
  const status = git(["status", "--porcelain"]);
  return {
    branch: branch.code === 0 ? branch.out : "(unknown)",
    sha: sha.code === 0 ? sha.out : "(no commit)",
    changed: status.out === "" ? 0 : status.out.split("\n").length,
  };
};

const register = readRegister(readFileSync(`${here}/register.json`, "utf8"), "register.json");
const evaluation = evaluate(register, scanNames(repoRoot));
const columns = columnsOf(evaluation.reports);

const since = (sha: string, ref: string): Since => {
  const base = registerAt(sha, ref);
  return { ref: sha.slice(0, 7), added: addedSince(base, register), retired: retiredSince(base, register), then: registerColumns(base) };
};

// An explicit ref must exist. With none, the base is the merge base with origin/main, as the register gate uses; with no origin/main the
// report says there is nothing to compare with.
const sinceReport = (): Since | "no base" => {
  if (sinceRef !== undefined) {
    const sha = commitOf(sinceRef);
    return sha === undefined ? fail(`--since ${sinceRef}: not a commit in this repository (fetch it first)`) : since(sha, sinceRef);
  }
  const mergeBase = git(["merge-base", MAIN, "HEAD"]);
  return mergeBase.code === 0 && mergeBase.out !== "" ? since(mergeBase.out, `${MAIN} merge base`) : "no base";
};

// Everything that can fail on a bad argument or an unreadable ref comes before the verifier, which reads the chain over the network and may
// take minutes: a mistyped --since must be an error at once, not after a node's timeout.
const sinceFrom = sinceReport();
const main = specAtMain();
const recorded = deployment();

console.log(
  renderProgress({
    checkout: checkoutState(),
    specFrom: main === undefined ? `nowhere (${MAIN} is not fetched here)` : `${MAIN} at ${main.ref}`,
    liveRules: register.filter((row) => row.retiredBy === undefined).length,
    columns,
    milestones: milestonesOf(columns, recorded, main, verification(recorded)),
    since: sinceFrom,
    problems: evaluation.problems.length,
  }),
);
