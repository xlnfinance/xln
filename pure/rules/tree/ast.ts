// The ast-grep edge of the tree gate. Two scans over the files git lists: the style rules (the legacy rules in
// style/rules, whose `files:` line names xln.ts and is dropped here, and style/tree-rules) over the gated sources, and
// the fact rules (facts.yml) over every user of the tree. Each runs once per language (.ts/.mts/.cts as TypeScript,
// .tsx as Tsx), every time with a planted file it must find something in.
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import type { Hit } from "./counts.ts";

export type AstFact = Readonly<{
  ruleId: string;
  file: string;
  text: string;
  range: Readonly<{ byteOffset: Readonly<{ start: number; end: number }>; start: Readonly<{ line: number }>; end: Readonly<{ line: number }> }>;
  metaVariables?: Readonly<{ single?: Readonly<Record<string, Readonly<{ text: string }>>> }>;
}>;
export type AstRun = Readonly<{ found: readonly AstFact[]; failed: boolean }>;
export type AstScan = Readonly<{ hits: readonly Hit[]; failed: boolean }>;

const RULE_FOLDERS = ["style/rules", "style/tree-rules"] as const;
const LANGUAGES = [
  { language: "TypeScript", extension: /\.(ts|mts|cts)$/, canary: "canary.ts" },
  { language: "Tsx", extension: /\.tsx$/, canary: "canary.tsx" },
] as const;

const withoutFilesLine = (yaml: string): string =>
  yaml.split("\n").filter((line) => !line.startsWith("files:")).join("\n");

export const styleRules = (root: string): string =>
  RULE_FOLDERS.flatMap((folder) => readdirSync(`${root}/${folder}`).map((file) => `${root}/${folder}/${file}`))
    .map((path) => withoutFilesLine(readFileSync(path, "utf8")))
    .join("\n---\n");

export const factRules = (): string => readFileSync(`${import.meta.dir}/facts.yml`, "utf8");

// A planted file every rule set must flag: if ast-grep answers "nothing" for it, the scan did not run and every clean
// answer for the real files is worthless (a stub binary, a wrong PATH, a crash that leaves an empty list).
const CANARY = "export const canary = () => { throw new Error(\"canary\"); };\n";

const plantCanary = (): string => {
  const dir = mkdtempSync(`${tmpdir()}/tree-canary-`);
  mkdirSync(`${dir}/canary`);
  LANGUAGES.forEach(({ canary }) => writeFileSync(`${dir}/canary/${canary}`, CANARY));
  return `${dir}/canary`;
};

// Runs `rules` over `files` (relative to root) in each language; the canary's own records are dropped, and a scan that
// did not report `canaryRule` for the canary has failed.
export const astRun = (root: string, rules: string, canaryRule: string, files: readonly string[]): AstRun => {
  const canary = plantCanary();
  const runs = LANGUAGES.map(({ language, extension }) => {
    const scan = Bun.spawnSync(
      ["ast-grep", "scan", "--inline-rules", rules.replace(/^language: TypeScript$/gm, `language: ${language}`), "--json=compact", canary, ...files.filter((file) => extension.test(file))],
      { cwd: root, env: process.env },
    );
    const found: readonly AstFact[] = JSON.parse(scan.stdout.toString().split("\n")[0] || "[]");
    const isCanary = (fact: AstFact): boolean => resolve(root, fact.file).startsWith(`${canary}/`);
    // Exit 0 is clean and 1 is "found errors"; anything else (2, a signal, which leaves the code null) is a failed scan.
    const ran = (scan.exitCode === 0 || scan.exitCode === 1) && found.some((fact) => fact.ruleId === canaryRule && isCanary(fact));
    return { found: found.filter((fact) => !isCanary(fact)), failed: !ran };
  });
  return { found: runs.flatMap((run) => run.found), failed: runs.some((run) => run.failed) };
};

export const astHits = (root: string, files: readonly string[]): AstScan => {
  const run = astRun(root, styleRules(root), "no-throw", files);
  return { hits: run.found.map((fact) => ({ ruleId: fact.ruleId, file: fact.file })), failed: run.failed };
};
