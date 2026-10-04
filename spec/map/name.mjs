#!/usr/bin/env node
// One Scheme name across spec/. spec/test.mjs loads the page, then one extra file.
// A later top-level define replaces the page binding for that run. Two configs are
// two runs. A comment is not a hit. The parser does not resolve bindings.
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const config = path.join(root, "spec/map/sgconfig.yml");
const name = process.argv[2];
const ident = /^[A-Za-z!$%&*/:<=>?^_~][A-Za-z0-9!$%&*/:<=>?^_~+.@-]*$/;
if (!name || !ident.test(name)) {
  process.stderr.write("usage: node spec/map/name.mjs <scheme-name>\n");
  process.exit(2);
}

const forms = [
  ["overridable", `(define/overridable ${name} $$$)`],
  ["function", `(define (${name} $$$) $$$)`],
  ["value", `(define ${name} $$$)`],
];

const search = (pattern) => {
  const result = spawnSync(
    "ast-grep",
    ["run", "-c", config, "-l", "scheme", "-p", pattern, "spec", "--json=stream"],
    { cwd: root, encoding: "utf8" },
  );
  const stderr = result.stderr ?? "";
  if (result.error || /libraryPath|cannot find|failed to load/i.test(stderr)) {
    process.stderr.write(stderr);
    process.stderr.write("build the parser with spec/map/build.sh\n");
    process.exit(1);
  }
  const text = (result.stdout ?? "").trim();
  if (text === "") return [];
  return text.split("\n").map((line) => JSON.parse(line));
};

const at = (hit) => ({
  file: hit.file,
  line: hit.range.start.line + 1,
  column: hit.range.start.column,
  text: hit.lines.split("\n")[0].trim(),
});

const definitions = forms.flatMap(([kind, pattern]) => search(pattern).map((hit) => ({ kind, ...at(hit) })));
const definedLine = new Set(definitions.map((hit) => `${hit.file}:${hit.line}`));
const seen = new Map();
for (const hit of definitions) seen.set(`${hit.file}:${hit.line}`, 0);
const mentions = [];
for (const hit of search(name).map(at)) {
  const key = `${hit.file}:${hit.line}`;
  const nth = seen.get(key) ?? 0;
  seen.set(key, nth + 1);
  if (definedLine.has(key) && nth === 0) continue;
  mentions.push(hit);
}

const byPlace = (a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.column - b.column;
const place = (hit) => `${hit.file}:${hit.line}`;
const replaces = definitions.some((hit) => hit.file.includes("/configs/") || hit.file.includes("/bugs/"));
process.stdout.write(`name: ${name}\n`);
if (replaces) {
  process.stdout.write("binding: each configs/ or bugs/ file is its own run, loaded after the page. Its top-level define replaces the page binding for that run.\n");
}
process.stdout.write("definitions:\n");
for (const hit of definitions.sort(byPlace)) process.stdout.write(`  ${place(hit)}  ${hit.kind}  ${hit.text}\n`);
if (definitions.length === 0) process.stdout.write("  (none)\n");
process.stdout.write("mentions:\n");
for (const hit of mentions.sort(byPlace)) process.stdout.write(`  ${place(hit)}  ${hit.text}\n`);
if (mentions.length === 0) process.stdout.write("  (none)\n");
