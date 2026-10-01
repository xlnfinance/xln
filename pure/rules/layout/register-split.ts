// Move the register between layouts. From pure/:
//   bun rules/layout/register-split.ts split <old.json>            write register/<id>.json for every rule of an old-layout register.json
//   bun rules/layout/register-split.ts verify <old.json>           exit 0 only when the folder holds exactly those rules, with identical data
//   bun rules/layout/register-split.ts port <base.json> <theirs.json>   apply what a branch changed in its register.json (against the one it
//                                                           started from) to the folder: added and changed rules are written, removed ones deleted
// An old-layout file comes from git, e.g.   git show origin/main~1:pure/rules/register.json > /tmp/old.json
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { differences, oldRows, port, splitFiles } from "./split.ts";
import type { RegisterFile } from "../register.ts";

const dir = `${import.meta.dir}/../register`;

const fail = (detail: string): never => {
  console.error(`FAIL ${detail}`);
  return process.exit(1);
};

const [command, ...paths] = process.argv.slice(2);

const read = (path: string | undefined): string => (path !== undefined && existsSync(path) ? readFileSync(path, "utf8") : fail(`cannot read ${path}`));

const folder = (): readonly RegisterFile[] =>
  existsSync(dir) ? readdirSync(dir).map((name) => ({ name, text: readFileSync(`${dir}/${name}`, "utf8") })) : [];

const write = (file: RegisterFile): void => writeFileSync(`${dir}/${file.name}`, file.text);

const rowsOf = (path: string | undefined) => {
  const rows = oldRows(read(path));
  return rows.ok ? rows.value : fail(`${path}: ${rows.error.detail}`);
};

if (command === "split") {
  const files = splitFiles(read(paths[0]));
  if (!files.ok) fail(`${paths[0]}: ${files.error.detail}`);
  else {
    mkdirSync(dir, { recursive: true });
    files.value.forEach(write);
    console.log(`wrote ${files.value.length} rule files to ${dir}`);
  }
} else if (command === "verify") {
  const found = differences(read(paths[0]), folder());
  if (found.length > 0) fail(`the folder is not the old register:\n  ${found.join("\n  ")}`);
  console.log(`ok   the folder holds the ${rowsOf(paths[0]).length} rules of ${paths[0]}, each with identical data`);
} else if (command === "port") {
  const plan = port(rowsOf(paths[0]), rowsOf(paths[1]), folder());
  if (plan.conflicts.length > 0) fail(`not applied, resolve by hand:\n  ${plan.conflicts.join("\n  ")}`);
  plan.writes.forEach(write);
  plan.deletes.forEach((name) => rmSync(`${dir}/${name}`));
  console.log(`ported: ${plan.writes.length} rule files written, ${plan.deletes.length} removed`);
} else {
  fail("usage: bun rules/layout/register-split.ts split <old.json> | verify <old.json> | port <base.json> <theirs.json>");
}
