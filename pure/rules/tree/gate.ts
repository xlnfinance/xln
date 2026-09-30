// The style gate of the new tree (kernel/, chain/): every rule of the legacy ratchet, plus the tree rules, at zero.
//
// style/check.ts ratchets xln.ts down from its baseline and scans only that file. The new directories start at zero on
// every rule, so a hit here is a failure and the only way to allow one is a registered exception: a rule, a file and a
// count in style/tree-exceptions.json, each with its reason in style/README.md. `bun rules/check.ts` runs this after
// the register gate.
import { readFileSync, readdirSync } from "node:fs";
import { astHits } from "./ast.ts";
import { compare, deadExports, isOff, longDeclarations, longLines, wordsOf, type Exceptions, type Hit, type Row } from "./counts.ts";

export const TREE = ["kernel", "chain"] as const;

// Every other directory under pure/ is named here as deliberately outside this gate, so a new layer directory
// (account/, entity/, ...) cannot land ungated by accident: it is a failing row until it joins TREE or this list.
export const NOT_GATED = ["bench", "diff", "findings", "legacy", "node_modules", "rules", "style"] as const;

export type TreeStyle = Readonly<{ rows: readonly Row[]; files: number; failed: boolean }>;

const sourcesUnder = (root: string, dir: string): readonly string[] =>
  [...new Bun.Glob("**/*.ts").scanSync({ cwd: `${root}/${dir}` })].map((file) => `${dir}/${file}`);

// The legacy file declares every name the new tree moved out of it, so it cannot count as a user of one. The gate's
// own code and the ratchet's rules are not users either.
const LEGACY = new Set(["xln.ts", "xln_run.ts"]);
const isUser = (file: string): boolean =>
  !/^(node_modules|style|legacy|rules)\//.test(file) && !LEGACY.has(file);

const textOf = (root: string, file: string): string => readFileSync(`${root}/${file}`, "utf8");

const countedHits = (root: string, sources: readonly string[], users: ReadonlyMap<string, ReadonlySet<string>>): readonly Hit[] =>
  sources.flatMap((file) => {
    const text = textOf(root, file);
    const others = [...users].filter(([user]) => user !== file).map(([, words]) => words);
    return [...longLines(file, text), ...longDeclarations(file, text), ...(file.endsWith(".test.ts") ? [] : deadExports(file, text, others))];
  });

const unlistedDirs = (root: string, dirs: readonly string[]): readonly Row[] =>
  readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !dirs.includes(entry.name) && !(NOT_GATED as readonly string[]).includes(entry.name))
    .map((entry): Row => ({ rule: "unlisted-dir", file: entry.name, now: 1, allowed: 0 }));

export const treeStyle = (root: string, dirs: readonly string[] = TREE): TreeStyle => {
  const sources = dirs.flatMap((dir) => sourcesUnder(root, dir));
  const users = new Map([...new Bun.Glob("**/*.ts").scanSync({ cwd: root })].filter(isUser).map((file) => [file, wordsOf(textOf(root, file))] as const));
  const ast = astHits(root, dirs);
  const exceptions: Exceptions = JSON.parse(readFileSync(`${root}/style/tree-exceptions.json`, "utf8"));
  const rows = [...unlistedDirs(root, dirs), ...compare([...ast.hits, ...countedHits(root, sources, users)], exceptions)];
  return { rows, files: sources.length, failed: ast.failed || rows.some(isOff) };
};

export const renderTreeStyle = ({ rows, files, failed }: TreeStyle): string =>
  [
    ...rows.map(({ rule, file, now, allowed }) => `${now !== allowed ? "FAIL" : "ok  "} ${rule.padEnd(18)} ${file}: ${now} / ${allowed}`),
    failed ? "tree style: FAIL" : `tree style: ok (${files} files, ${rows.reduce((sum, row) => sum + row.now, 0)} registered exceptions in use)`,
  ].join("\n");
