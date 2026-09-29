import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const POLYGLOT = join(dirname(fileURLToPath(import.meta.url)), "../polyglot");

/** Pull `input: "…"` / `input: '…'` rows out of the polyglot spec files. */
export function harvestPolyglotInputs(): ReadonlyArray<{ readonly file: string; readonly input: string }> {
  const out: Array<{ file: string; input: string }> = [];
  for (const name of readdirSync(POLYGLOT)) {
    if (!/\.(test|spec)\.ts$/.test(name)) continue;
    const text = readFileSync(join(POLYGLOT, name), "utf8");
    for (const m of text.matchAll(/\binput:\s*"((?:\\.|[^"\\])*)"/g)) {
      out.push({ file: name, input: JSON.parse(`"${m[1]}"`) as string });
    }
    for (const m of text.matchAll(/\binput:\s*'((?:\\.|[^'\\])*)'/g)) {
      out.push({ file: name, input: JSON.parse(`"${m[1].replaceAll('"', '\\"')}"`) as string });
    }
  }
  return out;
}
