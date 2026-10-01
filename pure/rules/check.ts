// The rule register gate. From pure/:   bun rules/check.ts
//   --matrix                 print the matrix as markdown (for review/)
//   --who <id>               list the names that carry an id, per layer
//   --names-json             dump every name the scanners read, as JSON (to write or audit register rows)
//   --layer-root <l>=<dir>   read layer l from another checkout (project the matrix onto a spec branch)
//   --base <ref>             the ref the register may only grow from (default: the target branch of a pull request run, the replaced tip of a push run, else origin/main)
//   --register-only          run only the register gate
//   --style-only             run only the style gate of the new tree (kernel/, chain/), see rules/tree/gate.ts
//   --width-only             run only folder width (rules/checks/folder-width.ts)
//   --forge-only             run only the Foundry suite (rules/checks/forge.ts): forge in PATH (export PATH=$PATH:/foundry), contracts/lib/forge-std checked out
//   --tests-only             run only contract-test placement: every contract test runs in a gate (rules/checks/contract-tests.ts)
//   --timeouts-only          run only the test-timeout check: a heavy test names its own timeout (rules/checks/timeouts/heavy-timeouts.ts)
//   --contracts-only         run only the contracts/ BrowserVM and deploy-gate tests (rules/checks/contracts/contracts-vm.ts): rebuild, typechain-types unchanged, one test file per process
//   --bun-only               run only the Bun version check (rules/checks/bun/bun-version.ts)
//   --findings-only          run only the known-findings ratchet (diff/findings/check.ts)
//   --serial                 with no --X-only flag: run the Foundry suite and the contracts/ tests one after the other, in this process (the default runs each in a child of its own, side by side with the quick parts)
// Runs the register gate, the style gate of the new tree, folder width (rules/checks/folder-width.ts), contract-test
// placement (rules/checks/contract-tests.ts), test timeouts (rules/checks/timeouts/heavy-timeouts.ts), the Foundry suite (rules/checks/forge.ts), the contracts/ BrowserVM and deploy-gate tests (rules/checks/contracts/contracts-vm.ts), the Bun version
// (rules/checks/bun/bun-version.ts) and the known-findings ratchet of the rig (diff/findings/check.ts): one command, one exit code. The Bun
// version is judged first, so a Bun that is too old fails at the start, not after the long parts.
// Exit 1 when an id is missing from a layer that must hold it, an owed cell is already satisfied, a row has
// no killer, the new tree breaks a style rule, a folder holds more than its allowed source files, a contract test sits in no gate folder, a heavy test names no timeout, a forge test is red, a typechain-types rebuild changes the checkout, a contracts/ BrowserVM or deploy-gate test is red, or the rig registers more known findings than its baseline allows. See plan/first-moves.md, brief 3.
import { existsSync, readFileSync } from "node:fs";
import { evaluate } from "./evaluate.ts";
import { carries } from "./names/names.ts";
import { LAYERS, type Layer } from "./model.ts";
import { commitExists, defaultBase, readBase } from "./base.ts";
import { readRegisterFolder } from "./layout/store.ts";
import { ratchet } from "./ratchet.ts";
import { renderMarkdown, renderText } from "./render.ts";
import { scanNames } from "./scan.ts";
import { gateExit, isWanted, selectionOf, type Part } from "./checks/compose.ts";
import { bunReport } from "./checks/bun/bun-version.ts";
import { contractTestsReport } from "./checks/contract-tests.ts";
import { contractsReport } from "./checks/contracts/contracts-vm.ts";
import { forgeReport } from "./checks/forge.ts";
import { timeoutsReport } from "./checks/timeouts/heavy-timeouts.ts";
import { folderWidthReport } from "./checks/folder-width.ts";
import { renderTreeStyle, treeStyle } from "./tree/gate.ts";

const here = import.meta.dir;
const repoRoot = `${here}/../..`;

const args = process.argv.slice(2);

// Each returns whether its part passed.
const runStyle = (): boolean => {
  const style = treeStyle(`${here}/..`);
  console.log(renderTreeStyle(style));
  return !style.failed;
};

const runFolderWidth = (): boolean => {
  const report = folderWidthReport(repoRoot);
  report.lines.forEach((line) => console.log(line));
  return !report.failed;
};

const runBun = (): boolean => {
  const report = bunReport(Bun.version, readFileSync(`${here}/../package.json`, "utf8"));
  console.log(report.line);
  return !report.failed;
};

const runContractTests = (): boolean => {
  const report = contractTestsReport(repoRoot);
  report.lines.forEach((line) => console.log(line));
  return !report.failed;
};

const runTimeouts = (): boolean => {
  const report = timeoutsReport(`${here}/..`, (path) => readFileSync(path, "utf8"));
  report.lines.forEach((line) => console.log(line));
  return !report.failed;
};

const runForgeSuite = (): boolean => {
  const report = forgeReport(repoRoot);
  report.lines.forEach((line) => console.log(line));
  return !report.failed;
};

const runContractsVm = async (): Promise<boolean> => {
  const report = await contractsReport(repoRoot);
  report.lines.forEach((line) => console.log(line));
  return !report.failed;
};

const flagValues = (flag: string): readonly string[] =>
  args.flatMap((arg, index) => (arg === flag ? [args[index + 1] ?? ""] : []));

// The ref the register and the findings registry may only grow from: --base, else the target of the pull request or the tip a push replaced (see defaultBase).
const baseRef = (): string => flagValues("--base")[0] ?? defaultBase(process.env, (sha) => commitExists(repoRoot, sha));

// The rig's registry of known findings may only shrink; its own script holds the rules (diff/findings/check.ts) and its output is ours.
const runFindings = (): boolean => {
  const child = Bun.spawnSync([process.execPath, `${here}/../diff/findings/check.ts`, "--base", baseRef()], { cwd: `${here}/..` });
  process.stdout.write(child.stdout);
  process.stderr.write(child.stderr);
  return child.exitCode === 0;
};

// The register part: parse, scan names, evaluate, ratchet against the base. Returns whether it passed.
const runRegister = (): boolean => {
  const overrides = Object.fromEntries(
    flagValues("--layer-root").flatMap((pair) => {
      const [layer, dir] = pair.split("=");
      return LAYERS.includes(layer as Layer) && dir !== undefined ? [[layer, dir]] : [];
    }),
  ) as Partial<Record<Layer, string>>;

  // A layer root that was asked for and is not there would read as an empty layer and leave every owed cell owed.
  const missingRoot = Object.entries(overrides).find(([, dir]) => !existsSync(dir));
  if (missingRoot !== undefined) {
    console.error(`FAIL --layer-root ${missingRoot[0]}=${missingRoot[1]}: no such directory`);
    process.exit(1);
  }

  const parsed = readRegisterFolder(`${here}/register`);
  if (!parsed.ok) {
    console.error(`FAIL register/ ${parsed.error.where}: ${parsed.error.detail}`);
    process.exit(1);
  }

  const names = scanNames(repoRoot, overrides);
  const [who] = flagValues("--who");

  if (args.includes("--names-json")) {
    console.log(JSON.stringify(names));
    process.exit(0);
  }

  if (who !== undefined) {
    names.filter((name) => carries(who, name)).forEach((name) => console.log(`${name.layer.padEnd(9)} ${name.kind.padEnd(8)} ${name.text}  (${name.file})`));
    process.exit(0);
  }

  const base = readBase(repoRoot, baseRef());
  if (!base.ok) {
    console.error(`FAIL ${base.error.detail}`);
    process.exit(1);
  }
  const grown = base.value._tag === "Base" ? ratchet(base.value.register, parsed.value) : { problems: [], retirements: [] };
  const checked = evaluate(parsed.value, names);
  const evaluation = { ...checked, problems: [...checked.problems, ...grown.problems] };
  console.log(args.includes("--matrix") ? renderMarkdown(evaluation) : renderText(evaluation));
  grown.retirements.forEach((line) => console.log(`NOTE ${line}`));
  return evaluation.problems.length === 0;
};

const selection = selectionOf(args);

// The two slow parts (the Foundry suite and the contracts/ tests, minutes each) of the whole gate run in children of this process, started
// first and side by side with the quick parts here, so the command takes about as long as the slowest of them and not their sum. Each child
// is this command with its --X-only flag, so what it checks and how it fails is the part's own; this process prints the children's lines after
// the quick parts (in the order the parts have always run) and takes their exit codes. --serial runs them in this process as before.
const SLOW_PARTS: readonly Part[] = ["forge", "contracts"];
const inChildren = selection.only === undefined && !selection.matrixOnly && !args.includes("--serial");

type Child = Readonly<{ part: Part; finished: Promise<readonly [string, string, number]> }>;

const startChild = (part: Part): Child => {
  const child = Bun.spawn([process.execPath, `${here}/check.ts`, `--${part}-only`], { cwd: process.cwd(), env: process.env, stdout: "pipe", stderr: "pipe" });
  return { part, finished: Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]) };
};

const children: readonly Child[] = inChildren ? SLOW_PARTS.map(startChild) : [];

const childPasses = async (part: Part): Promise<boolean> => {
  const child = children.find((each) => each.part === part);
  if (child === undefined) return true;
  const [out, err, exitCode] = await child.finished;
  process.stdout.write(out);
  process.stderr.write(err);
  return exitCode === 0;
};

// One table for every way in; `isWanted` says which parts the command line runs. A part that does not run counts as passed.
const PARTS: Readonly<Record<Part, () => boolean | Promise<boolean>>> = {
  register: runRegister,
  style: runStyle,
  width: runFolderWidth,
  tests: runContractTests,
  timeouts: runTimeouts,
  forge: runForgeSuite,
  contracts: runContractsVm,
  bun: runBun,
  findings: runFindings,
};
const passes = async (part: Part): Promise<boolean> => !isWanted(part, selection) || (await PARTS[part]());

// Object properties evaluate in order: bun first, then the quick parts, the Foundry suite and the contracts/ tests last.
process.exit(
  gateExit({
    bun: await passes("bun"),
    register: await passes("register"),
    style: await passes("style"),
    width: await passes("width"),
    tests: await passes("tests"),
    timeouts: await passes("timeouts"),
    findings: await passes("findings"),
    forge: inChildren ? await childPasses("forge") : await passes("forge"),
    contracts: inChildren ? await childPasses("contracts") : await passes("contracts"),
  }),
);
