// The rule register gate. From pure/:   bun rules/check.ts
//   --matrix                 print the matrix as markdown (for review/)
//   --who <id>               list the names that carry an id, per layer
//   --names-json             dump every name the scanners read, as JSON (to write or audit register rows)
//   --layer-root <l>=<dir>   read layer l from another checkout (project the matrix onto a spec branch)
// Exit 1 when an id is missing from a layer that must hold it, an owed cell is already satisfied, or a row has
// no killer. See plan/first-moves.md, brief 3.
import { readFileSync } from "node:fs";
import { evaluate } from "./evaluate.ts";
import { carries } from "./names.ts";
import { LAYERS, type Layer } from "./model.ts";
import { parseRegister } from "./register.ts";
import { renderMarkdown, renderText } from "./render.ts";
import { scanNames } from "./scan.ts";

const here = import.meta.dir;
const repoRoot = `${here}/../..`;

const args = process.argv.slice(2);
const flagValues = (flag: string): readonly string[] =>
  args.flatMap((arg, index) => (arg === flag ? [args[index + 1] ?? ""] : []));

const overrides = Object.fromEntries(
  flagValues("--layer-root").flatMap((pair) => {
    const [layer, dir] = pair.split("=");
    return LAYERS.includes(layer as Layer) && dir !== undefined ? [[layer, dir]] : [];
  }),
) as Partial<Record<Layer, string>>;

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

const evaluation = evaluate(parsed.value, names);
console.log(args.includes("--matrix") ? renderMarkdown(evaluation) : renderText(evaluation));
process.exit(evaluation.problems.length === 0 ? 0 : 1);
