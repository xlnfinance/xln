// The ast-grep edge of the tree gate: the legacy rules (style/rules, whose `files:` line names xln.ts, so it is
// dropped here) and the tree rules (style/tree-rules) over the new directories, read from a scratch copy.
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { relative, resolve } from "node:path";
import type { Hit } from "./counts.ts";

export type AstScan = Readonly<{ hits: readonly Hit[]; failed: boolean }>;

const RULE_FOLDERS = ["style/rules", "style/tree-rules"] as const;

const withoutFilesLine = (yaml: string): string =>
  yaml.split("\n").filter((line) => !line.startsWith("files:")).join("\n");

const stageRules = (root: string): string => {
  const stage = mkdtempSync(`${tmpdir()}/tree-rules-`);
  mkdirSync(`${stage}/rules`);
  RULE_FOLDERS.flatMap((folder) => readdirSync(`${root}/${folder}`).map((file) => `${root}/${folder}/${file}`)).forEach((path) =>
    writeFileSync(`${stage}/rules/${path.split("/").at(-1)}`, withoutFilesLine(readFileSync(path, "utf8"))));
  writeFileSync(`${stage}/sgconfig.yml`, "ruleDirs:\n  - rules\n");
  return stage;
};

// A planted file the rules must flag: if ast-grep answers "nothing" for it, the scan did not run and every clean
// answer for the real directories is worthless (a stub binary, a wrong PATH, a crash that leaves an empty list).
const CANARY = "export const canary = () => { throw new Error(\"canary\"); };\n";

const plantCanary = (stage: string): string => {
  mkdirSync(`${stage}/canary`);
  writeFileSync(`${stage}/canary/canary.ts`, CANARY);
  return `${stage}/canary`;
};

export const astHits = (root: string, dirs: readonly string[]): AstScan => {
  const stage = stageRules(root);
  const canary = plantCanary(stage);
  const scan = Bun.spawnSync(
    ["ast-grep", "scan", "--config", `${stage}/sgconfig.yml`, "--json=compact", canary, ...dirs.map((dir) => `${root}/${dir}`)],
    { cwd: stage, env: process.env },
  );
  const found: readonly Hit[] = JSON.parse(scan.stdout.toString().split("\n")[0] || "[]");
  const isCanary = (hit: Hit): boolean => resolve(stage, hit.file).startsWith(`${canary}/`);
  // Exit 0 is clean and 1 is "found errors"; anything else (2, a signal, which leaves the code null) is a failed scan.
  const ran = (scan.exitCode === 0 || scan.exitCode === 1) && found.some((hit) => hit.ruleId === "no-throw" && isCanary(hit));
  return {
    hits: found.filter((hit) => !isCanary(hit)).map((hit) => ({ ruleId: hit.ruleId, file: relative(root, resolve(stage, hit.file)) })),
    failed: !ran,
  };
};
