// The ast-grep edge of the tree gate. Two scans over the files git lists: the style rules (the legacy rules in
// style/rules, whose `files:` line names xln.ts and is dropped here, and style/tree-rules) over the gated sources, and
// the fact rules (facts.yml) over every user of the tree. Each runs once per language (.ts/.mts/.cts as TypeScript,
// .tsx as Tsx), every time with one planted file per rule that the rule must report on.
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import type { Hit } from "./counts.ts";

export type AstFact = Readonly<{
  ruleId: string;
  file: string;
  text: string;
  range: Readonly<{ byteOffset: Readonly<{ start: number; end: number }>; start: Readonly<{ line: number }>; end: Readonly<{ line: number }> }>;
  metaVariables?: Readonly<{ single?: Readonly<Record<string, Readonly<{ text: string }>>> }>;
}>;
// `silent` names each canary whose rule did not report on it (a language other than TypeScript is named after the id).
export type AstRun = Readonly<{ found: readonly AstFact[]; silent: readonly string[]; failed: boolean }>;
export type AstScan = Readonly<{ hits: readonly Hit[]; failed: boolean }>;

const RULE_FOLDERS = ["style/rules", "style/tree-rules"] as const;
const LANGUAGES = [
  { language: "TypeScript", extension: /\.(ts|mts|cts)$/, suffix: "ts" },
  { language: "Tsx", extension: /\.tsx$/, suffix: "tsx" },
] as const;

const withoutFilesLine = (yaml: string): string =>
  yaml.split("\n").filter((line) => !line.startsWith("files:")).join("\n");

const RULE_FILES = (root: string): readonly string[] =>
  RULE_FOLDERS.flatMap((folder) => readdirSync(`${root}/${folder}`).map((file) => `${root}/${folder}/${file}`));

export const styleRules = (root: string): string =>
  RULE_FILES(root).map((path) => withoutFilesLine(readFileSync(path, "utf8"))).join("\n---\n");

const ruleIds = (root: string): readonly string[] =>
  RULE_FILES(root).flatMap((path) => readFileSync(path, "utf8").match(/^id: (\S+)$/m)?.slice(1, 2) ?? []);

export const factRules = (): string => readFileSync(`${import.meta.dir}/facts.yml`, "utf8");

// One planted file per rule, named after it: a rule must report on its own canary, so a scan that did not run (a stub
// binary, a wrong PATH, a crash that leaves an empty list) and a rule that was deleted, disabled or narrowed to match
// nothing are both caught, and every clean answer for the real files means something.
export type Canaries = Readonly<Record<string, string>>;

const plantCanaries = (canaries: Canaries): string => {
  const dir = mkdtempSync(`${tmpdir()}/tree-canary-`);
  mkdirSync(`${dir}/canary`);
  Object.entries(canaries).forEach(([id, snippet]) => LANGUAGES.forEach(({ suffix }) => writeFileSync(`${dir}/canary/${id}.${suffix}`, snippet)));
  return `${dir}/canary`;
};

// Runs `rules` over `files` (relative to root) in each language; the canaries' own records are dropped.
export const astRun = (root: string, rules: string, canaries: Canaries, files: readonly string[]): AstRun => {
  const canary = plantCanaries(canaries);
  const runs = LANGUAGES.map(({ language, extension, suffix }) => {
    const scan = Bun.spawnSync(
      ["ast-grep", "scan", "--inline-rules", rules.replace(/^language: TypeScript$/gm, `language: ${language}`), "--json=compact", canary, ...files.filter((file) => extension.test(file))],
      { cwd: root, env: process.env },
    );
    const found: readonly AstFact[] = JSON.parse(scan.stdout.toString().split("\n")[0] || "[]");
    const isCanary = (fact: AstFact): boolean => resolve(root, fact.file).startsWith(`${canary}/`);
    const reported = (id: string): boolean => found.some((fact) => fact.ruleId === id && resolve(root, fact.file) === `${canary}/${id}.${suffix}`);
    // Exit 0 is clean and 1 is "found errors"; anything else (2, a signal, which leaves the code null) is a failed scan.
    const exited = scan.exitCode === 0 || scan.exitCode === 1;
    const silent = Object.keys(canaries).filter((id) => !reported(id)).map((id) => (language === "TypeScript" ? id : `${id} (${language})`));
    return { found: found.filter((fact) => !isCanary(fact)), silent, failed: !exited };
  });
  // The planted files have been read by now; the folder is the scan's own, so it goes with it.
  rmSync(dirname(canary), { recursive: true, force: true });
  const silent = runs.flatMap((run) => run.silent);
  return { found: runs.flatMap((run) => run.found), silent, failed: runs.some((run) => run.failed) || silent.length > 0 };
};

// The fact rules have one canary: any top-level statement.
export const FACT_CANARIES: Canaries = { decl: "export const canary = () => 1;\n" };

// Every style rule file needs a canary and every canary a rule file: a rule deleted together with its exception row
// leaves its canary behind, and a new rule without one is not yet known to work.
export const astHits = (root: string, files: readonly string[]): AstScan => {
  const ids = ruleIds(root);
  const canaries: Canaries = JSON.parse(readFileSync(`${root}/style/canaries.json`, "utf8"));
  const covered = Object.fromEntries(Object.entries(canaries).filter(([id]) => ids.includes(id)));
  const run = astRun(root, styleRules(root), covered, files);
  const named = (ruleId: string, each: readonly string[]): readonly Hit[] => each.map((file): Hit => ({ ruleId, file }));
  const hits = [
    ...run.found.map((fact): Hit => ({ ruleId: fact.ruleId, file: fact.file })),
    ...named("canary-silent", run.silent),
    ...named("canary-missing", ids.filter((id) => !(id in canaries))),
    ...named("canary-orphan", Object.keys(canaries).filter((id) => !ids.includes(id))),
  ];
  return { hits, failed: run.failed };
};
