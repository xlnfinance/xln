// The style gate of the new tree (kernel/, chain/, account/): every rule of the legacy ratchet, plus the tree rules, at zero.
//
// style/check.ts ratchets xln.ts down from its baseline and scans only that file. The new directories start at zero on
// every rule, so a hit here is a failure and the only way to allow one is a registered exception: a rule, a file and a
// count in style/tree-exceptions.json, each with its reason in style/README.md. `bun rules/check.ts` runs this after
// the register gate.
import { readFileSync } from "node:fs";
import { existingFiles } from "../checks/folder-width.ts";
import { FACT_CANARIES, astHits, astRun, factRules } from "./ast.ts";
import { compare, isOff, longLines, type Exceptions, type Hit, type Row } from "./counts.ts";
import { isSource, syntaxHits } from "./syntax.ts";

// A layer is a directory or a single file directly under pure/ (entity.ts is as much a layer as entity/ is).
export const TREE = ["kernel", "chain", "account", "entity", "runtime"] as const;

// Every other entry under pure/ is named here as deliberately outside this gate, so a new layer (account/, entity/,
// entity.ts, ...) cannot land ungated by accident: it is a failing row until it joins TREE or this list.
export const NOT_GATED = [
  "bench", "diff", "findings", "legacy", "node_modules", "rules", "style",
  "xln.ts", "xln_run.ts", "lexical-id.stub.ts", "oracle.test.ts",
] as const;

export type TreeStyle = Readonly<{ rows: readonly Row[]; files: number; failed: boolean }>;

const inEntry = (file: string, entry: string): boolean => file === entry || file.startsWith(`${entry}/`);

// The files the gate reads are the files git lists (tracked plus untracked-not-ignored), as in folder-width, so a
// local db-* folder or a build output that git ignores cannot turn the gate red on one machine only.
const sourcesUnder = (listed: readonly string[], entry: string): readonly string[] =>
  listed.filter((file) => inEntry(file, entry) && isSource(file));

// The legacy file declares every name the new tree moved out of it, so it cannot count as a user of one. The gate's
// own code and the ratchet's rules are not users either.
const LEGACY = new Set(["xln.ts", "xln_run.ts"]);
const isUser = (file: string): boolean =>
  isSource(file) && !/^(node_modules|style|legacy|rules)\//.test(file) && !LEGACY.has(file);

const textOf = (root: string, file: string): string => readFileSync(`${root}/${file}`, "utf8");

const unlistedEntries = (listed: readonly string[], entries: readonly string[]): readonly Row[] =>
  [...new Set(listed.filter((file) => file.includes("/") || isSource(file)).map((file) => file.split("/")[0] ?? ""))]
    .filter((name) => !entries.includes(name) && !(NOT_GATED as readonly string[]).includes(name))
    .map((name): Row => ({ rule: isSource(name) ? "unlisted-file" : "unlisted-dir", file: name, now: 1, allowed: 0 }));

export const treeStyle = (root: string, entries: readonly string[] = TREE): TreeStyle => {
  const listed = existingFiles(root);
  // Git listed nothing: not a checkout, or git failed. An empty list must not read as a clean tree.
  if (listed.length === 0) return { rows: [{ rule: "git-listing", file: root, now: 1, allowed: 0 }], files: 0, failed: true };
  const sources = entries.flatMap((entry) => sourcesUnder(listed, entry));
  const style = astHits(root, sources);
  const facts = astRun(root, factRules(), FACT_CANARIES, listed.filter(isUser));
  const syntax = syntaxHits(facts.found, new Set(listed), new Set(sources));
  const lines = sources.flatMap((file): readonly Hit[] => longLines(file, textOf(root, file)));
  const exceptions: Exceptions = JSON.parse(readFileSync(`${root}/style/tree-exceptions.json`, "utf8"));
  const rows = [...unlistedEntries(listed, entries), ...compare([...style.hits, ...lines, ...syntax], exceptions)];
  return { rows, files: sources.length, failed: style.failed || facts.failed || rows.some(isOff) };
};

export const renderTreeStyle = ({ rows, files, failed }: TreeStyle): string =>
  [
    ...rows.map(({ rule, file, now, allowed }) => `${now !== allowed ? "FAIL" : "ok  "} ${rule.padEnd(18)} ${file}: ${now} / ${allowed}`),
    failed ? "tree style: FAIL" : `tree style: ok (${files} files, ${rows.reduce((sum, row) => sum + row.now, 0)} registered exceptions in use)`,
  ].join("\n");
