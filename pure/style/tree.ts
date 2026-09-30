// The gate for the new tree (kernel/, chain/): every rule of the legacy ratchet, at zero.
//
// style/check.ts ratchets xln.ts down from its baseline and only scans that file. The new directories start at zero on
// every rule, so a hit here is a failure and the only way to allow one is a registered exception: a rule, a file and a
// count in style/tree-exceptions.json, each with its reason in style/README.md.
//
// It runs the legacy rules (style/rules, whose `files:` line names xln.ts) and the new-tree rules (style/tree-rules)
// over the directories, then counts what ast-grep cannot: lines over 120 characters, declarations over 50 lines, and
// exports that no other file under pure/ names (a test counts as a user).
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { relative, resolve } from "node:path";

const root = `${import.meta.dir}/..`;
const TREE = ["kernel", "chain"] as const;
const MAX_LINE = 120;
const MAX_DECLARATION_LINES = 50;

const sources = TREE.flatMap((dir) => [...new Bun.Glob("**/*.ts").scanSync({ cwd: `${root}/${dir}` })]
  .map((f) => `${dir}/${f}`));
const textOf = (file: string): string => readFileSync(`${root}/${file}`, "utf8");

// ---- ast-grep rules, with the legacy `files:` restriction removed ----
const ruleDir = mkdtempSync(`${tmpdir()}/tree-rules-`);
mkdirSync(`${ruleDir}/rules`);
const ruleFiles = [
  ...readdirSync(`${root}/style/rules`).map((f) => `${root}/style/rules/${f}`),
  ...readdirSync(`${root}/style/tree-rules`).map((f) => `${root}/style/tree-rules/${f}`),
];
ruleFiles.forEach((path) => {
  const kept = readFileSync(path, "utf8").split("\n").filter((line) => !line.startsWith("files:")).join("\n");
  writeFileSync(`${ruleDir}/rules/${path.split("/").at(-1)}`, kept);
});
writeFileSync(`${ruleDir}/sgconfig.yml`, "ruleDirs:\n  - rules\n");
const scan = Bun.spawnSync(
  ["ast-grep", "scan", "--config", `${ruleDir}/sgconfig.yml`, "--json=compact", ...TREE.map((d) => `${root}/${d}`)],
  { cwd: ruleDir },
);
type Hit = { readonly ruleId: string; readonly file: string };
const hits: readonly Hit[] = JSON.parse(scan.stdout.toString().split("\n")[0] || "[]")
  .map((h: Hit) => ({ ruleId: h.ruleId, file: relative(root, resolve(ruleDir, h.file)) }));

// ---- what ast-grep cannot count ----
const longLines: readonly Hit[] = sources.flatMap((file) =>
  textOf(file).split("\n").filter((line) => line.length > MAX_LINE).map((): Hit => ({ ruleId: "long-line", file })));

/** A declaration runs from its first line to the last line before the next line that starts in column 0. */
const topLevelSpans = (text: string): readonly number[] => {
  const lines = text.split("\n");
  const opens = (line: string): boolean => /^(export )?(const|function|type) /.test(line);
  const closes = (line: string): boolean => line.length > 0 && !" })];*".includes(line[0] ?? " ");
  return lines.flatMap((line, start) => {
    if (!opens(line)) return [];
    const next = lines.findIndex((l, i) => i > start && closes(l));
    return [(next < 0 ? lines.length : next) - start];
  });
};
const longDeclarations: readonly Hit[] = sources.flatMap((file) =>
  topLevelSpans(textOf(file)).filter((n) => n > MAX_DECLARATION_LINES).map((): Hit => ({ ruleId: "long-declaration", file })));

// The legacy file declares every name the new tree moved out of it, so it cannot count as a user of one.
const LEGACY = new Set(["xln.ts", "xln_run.ts"]);
const everyFile = [...new Bun.Glob("**/*.ts").scanSync({ cwd: root })]
  .filter((f) => !f.startsWith("node_modules/") && !f.startsWith("style/") && !f.startsWith("legacy/") && !LEGACY.has(f));
const words = new Map(everyFile.map((f) => [f, new Set(textOf(f).match(/[A-Za-z_$][\w$]*/g) ?? [])] as const));
type Export = Readonly<{ name: string; isType: boolean }>;
const exportsOf = (file: string): readonly Export[] =>
  [...textOf(file).matchAll(/^export (const|function|type) ([A-Za-z_$][\w$]*)/gm)]
    .map((m) => ({ name: m[2] ?? "", isType: m[1] === "type" }));
const mentions = (file: string, name: string): number => (textOf(file).match(new RegExp(`\\b${name}\\b`, "g")) ?? []).length;
/** A value export needs a user in another file; a type export is live when its own file also names it in a signature. */
const isLive = (file: string, { name, isType }: Export): boolean =>
  everyFile.some((other) => other !== file && words.get(other)?.has(name)) || (isType && mentions(file, name) > 1);
const dead: readonly Hit[] = sources.filter((f) => !f.endsWith(".test.ts")).flatMap((file) =>
  exportsOf(file).filter((e) => !isLive(file, e)).map((e): Hit => ({ ruleId: "unreachable", file: `${file} (${e.name})` })));

// ---- compare with the registered exceptions ----
const exceptions: Record<string, Record<string, number>> =
  JSON.parse(readFileSync(`${import.meta.dir}/tree-exceptions.json`, "utf8"));
const all = [...hits, ...longLines, ...longDeclarations, ...dead];
const counts = Map.groupBy(all, (h) => `${h.ruleId}\t${h.file}`);
const rows = [...counts].map(([key, hs]) => {
  const [rule = "", file = ""] = key.split("\t");
  return { rule, file, now: hs.length, allowed: exceptions[rule]?.[file] ?? 0 };
});
const registeredButGone = Object.entries(exceptions).flatMap(([rule, byFile]) =>
  Object.entries(byFile).filter(([file]) => !rows.some((r) => r.rule === rule && r.file === file))
    .map(([file, allowed]) => ({ rule, file, now: 0, allowed })));
const report = [...rows, ...registeredButGone].toSorted((a, b) => `${a.rule}${a.file}`.localeCompare(`${b.rule}${b.file}`));
report.forEach(({ rule, file, now, allowed }) => console.log(`${now > allowed ? "FAIL" : "ok  "} ${rule.padEnd(18)} ${file}: ${now} / ${allowed}`));
const failed = report.some((r) => r.now > r.allowed) || scan.exitCode > 1;
console.log(failed ? "tree style: FAIL" : `tree style: ok (${sources.length} files, ${all.length} registered exceptions in use)`);
process.exit(failed ? 1 : 0);
