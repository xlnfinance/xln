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

export const astHits = (root: string, dirs: readonly string[]): AstScan => {
  const stage = stageRules(root);
  const scan = Bun.spawnSync(
    ["ast-grep", "scan", "--config", `${stage}/sgconfig.yml`, "--json=compact", ...dirs.map((dir) => `${root}/${dir}`)],
    { cwd: stage },
  );
  const found: readonly Hit[] = JSON.parse(scan.stdout.toString().split("\n")[0] || "[]");
  return {
    hits: found.map((hit) => ({ ruleId: hit.ruleId, file: relative(root, resolve(stage, hit.file)) })),
    failed: scan.exitCode > 1,
  };
};
