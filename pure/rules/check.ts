// The rule register gate. From pure/:   bun rules/check.ts
//   --matrix                 print the matrix as markdown (for review/)
//   --who <id>               list the names that carry an id, per layer
//   --names-json             dump every name the scanners read, as JSON (to write or audit register rows)
//   --layer-root <l>=<dir>   read layer l from another checkout (project the matrix onto a spec branch)
//   --base <ref>             the ref the register may only grow from (default origin/main)
//   --style-only             run only the style gate of the new tree (kernel/, chain/), see rules/tree/gate.ts
// Runs the register gate and then the style gate of the new tree: one command, one exit code.
// Exit 1 when an id is missing from a layer that must hold it, an owed cell is already satisfied, a row has
// no killer, or the new tree breaks a style rule. See plan/first-moves.md, brief 3.
import { existsSync, readFileSync } from "node:fs";
import { evaluate } from "./evaluate.ts";
import { carries } from "./names/names.ts";
import { LAYERS, type Layer } from "./model.ts";
import { readBase } from "./base.ts";
import { parseRegister } from "./register.ts";
import { ratchet } from "./ratchet.ts";
import { renderMarkdown, renderText } from "./render.ts";
import { scanNames } from "./scan.ts";
import { renderTreeStyle, treeStyle } from "./tree/gate.ts";

const here = import.meta.dir;
const repoRoot = `${here}/../..`;

const args = process.argv.slice(2);

const runStyle = (): number => {
  const style = treeStyle(`${here}/..`);
  console.log(renderTreeStyle(style));
  return style.failed ? 1 : 0;
};

if (args.includes("--style-only")) process.exit(runStyle());

const flagValues = (flag: string): readonly string[] =>
  args.flatMap((arg, index) => (arg === flag ? [args[index + 1] ?? ""] : []));

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
const registerFailed = evaluation.problems.length > 0;
// The matrix is for review/; the style gate runs with the plain gate.
const styleFailed = args.includes("--matrix") ? 0 : runStyle();
process.exit(registerFailed || styleFailed === 1 ? 1 : 0);
