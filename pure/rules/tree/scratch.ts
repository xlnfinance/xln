// Test helper: a scratch tree the gate can be run over, with the real rule folders and planted files.
import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { tmpdir } from "node:os";
import { isOff } from "./counts.ts";
import { treeStyle } from "./gate.ts";

export const pureRoot = `${import.meta.dir}/../..`;

// A root with the real rule folders, an exceptions file, the given files under kernel/ and the given files directly under the root.
export const scratch = (files: Readonly<Record<string, string>>, exceptions: object = {}, rootFiles: Readonly<Record<string, string>> = {}): string => {
  const root = mkdtempSync(`${tmpdir()}/tree-gate-`);
  cpSync(`${pureRoot}/style/rules`, `${root}/style/rules`, { recursive: true });
  cpSync(`${pureRoot}/style/tree-rules`, `${root}/style/tree-rules`, { recursive: true });
  cpSync(`${pureRoot}/style/canaries.json`, `${root}/style/canaries.json`);
  writeFileSync(`${root}/style/tree-exceptions.json`, JSON.stringify(exceptions));
  mkdirSync(`${root}/kernel`);
  mkdirSync(`${root}/chain`);
  mkdirSync(`${root}/account`);
  Object.entries(files).forEach(([file, text]) => {
    mkdirSync(dirname(`${root}/kernel/${file}`), { recursive: true });
    writeFileSync(`${root}/kernel/${file}`, text);
  });
  Object.entries(rootFiles).forEach(([file, text]) => writeFileSync(`${root}/${file}`, text));
  // The gate lists files with git (tracked plus untracked-not-ignored), so a scratch tree is a repository.
  Bun.spawnSync(["git", "init", "-q"], { cwd: root });
  return root;
};

export const offRows = (root: string): readonly string[] => treeStyle(root).rows.filter(isOff).map((row) => `${row.rule} ${row.file}`);

export const failing = (files: Readonly<Record<string, string>>, exceptions: object = {}): readonly string[] => offRows(scratch(files, exceptions));

// A test file that imports `name` from ./name.ts and calls it.
export const used = (name: string): Readonly<Record<string, string>> => ({ [`${name}.test.ts`]: `import { ${name} } from "./${name}.ts"; ${name}();\n` });
