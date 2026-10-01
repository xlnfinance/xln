// The rule register gate. From pure/:   bun rules/check.ts
//   --matrix                 print the matrix as markdown (for review/)
//   --who <id>               list the names that carry an id, per layer
//   --names-json             dump every name the scanners read, as JSON (to write or audit register rows)
//   --layer-root <l>=<dir>   read layer l from another checkout (project the matrix onto a spec branch)
//   --base <ref>             the ref the register may only grow from (default origin/main)
//   --register-only          run only the register gate
//   --style-only             run only the style gate of the new tree (kernel/, chain/), see rules/tree/gate.ts
//   --width-only             run only folder width (rules/checks/folder-width.ts)
//   --tests-only             run only contract-test placement: every contract test runs in a gate (rules/checks/contract-tests.ts)
//   --findings-only          run only the known-findings ratchet (diff/findings/check.ts)
// Runs the register gate, the style gate of the new tree, folder width (rules/checks/folder-width.ts), contract-test placement
// (rules/checks/contract-tests.ts) and the known-findings ratchet of the rig (diff/findings/check.ts): one command, one exit code.
// Exit 1 when an id is missing from a layer that must hold it, an owed cell is already satisfied, a row has
// no killer, the new tree breaks a style rule, a folder holds more than its allowed source files, a contract test sits in no gate folder, or the rig registers more known findings than its baseline allows. See plan/first-moves.md, brief 3.
import { existsSync, readFileSync } from "node:fs";
import { evaluate } from "./evaluate.ts";
import { carries } from "./names/names.ts";
import { LAYERS, type Layer } from "./model.ts";
import { readBase } from "./base.ts";
import { parseRegister } from "./register.ts";
import { ratchet } from "./ratchet.ts";
import { renderMarkdown, renderText } from "./render.ts";
import { scanNames } from "./scan.ts";
import { gateExit, isWanted, selectionOf, type Part } from "./checks/compose.ts";
import { contractTestsReport } from "./checks/contract-tests.ts";
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

const runContractTests = (): boolean => {
  const report = contractTestsReport(repoRoot);
  report.lines.forEach((line) => console.log(line));
  return !report.failed;
};

const flagValues = (flag: string): readonly string[] =>
  args.flatMap((arg, index) => (arg === flag ? [args[index + 1] ?? ""] : []));

// The rig's registry of known findings may only shrink; its own script holds the rules (diff/findings/check.ts) and its output is ours.
const runFindings = (): boolean => {
  const child = Bun.spawnSync([process.execPath, `${here}/../diff/findings/check.ts`, "--base", flagValues("--base")[0] ?? "origin/main"], { cwd: `${here}/..` });
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

  const parsed = parseRegister(readFileSync(`${here}/register.json`, "utf8"));
  if (!parsed.ok) {
    console.error(`FAIL register.json ${parsed.error.where}: ${parsed.error.detail}`);
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

  const base = readBase(repoRoot, flagValues("--base")[0] ?? "origin/main");
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

// One table for every way in; `isWanted` says which parts the command line runs. A part that does not run counts as passed.
const PARTS: Readonly<Record<Part, () => boolean>> = { register: runRegister, style: runStyle, width: runFolderWidth, tests: runContractTests, findings: runFindings };
const passes = (part: Part): boolean => !isWanted(part, selection) || PARTS[part]();

process.exit(gateExit({ register: passes("register"), style: passes("style"), width: passes("width"), tests: passes("tests"), findings: passes("findings") }));
