// Each test plants a fool in a scratch tree and asks the gate whether it notices.
import { describe, expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { compare, declarationSpans, deadExports, isOff, longLines, wordsOf } from "./counts.ts";
import { treeStyle } from "./gate.ts";

const pureRoot = `${import.meta.dir}/../..`;

// A root with the real rule folders, an exceptions file and the given files under kernel/.
const scratch = (files: Readonly<Record<string, string>>, exceptions: object = {}): string => {
  const root = mkdtempSync(`${tmpdir()}/tree-gate-`);
  cpSync(`${pureRoot}/style/rules`, `${root}/style/rules`, { recursive: true });
  cpSync(`${pureRoot}/style/tree-rules`, `${root}/style/tree-rules`, { recursive: true });
  writeFileSync(`${root}/style/tree-exceptions.json`, JSON.stringify(exceptions));
  mkdirSync(`${root}/kernel`);
  mkdirSync(`${root}/chain`);
  Object.entries(files).forEach(([file, text]) => writeFileSync(`${root}/kernel/${file}`, text));
  return root;
};

const failing = (files: Readonly<Record<string, string>>, exceptions: object = {}): readonly string[] =>
  treeStyle(scratch(files, exceptions)).rows.filter(isOff).map((row) => `${row.rule} ${row.file}`);

const used = (name: string): Readonly<Record<string, string>> => ({ [`${name}.test.ts`]: `import { ${name} } from "./${name}.ts"; ${name}();\n` });

describe("the counts ast-grep cannot make", () => {
  test("a line over 120 characters is a hit and 120 is not", () => {
    expect(longLines("a.ts", `${"x".repeat(121)}\n${"y".repeat(120)}`)).toEqual([{ ruleId: "long-line", file: "a.ts" }]);
  });

  test("a declaration runs to the next line that starts in column 0", () => {
    const body = Array.from({ length: 60 }, (_, index) => `  const v${index} = ${index};`).join("\n");
    expect(declarationSpans(`export const big = () => {\n${body}\n};\nexport const small = 1;`)).toEqual([62, 1]);
  });

  test("an export nothing else names is dead; a name in another file keeps it live", () => {
    expect(deadExports("a.ts", "export const lonely = 1;", [wordsOf("const other = 2;")])).toHaveLength(1);
    expect(deadExports("a.ts", "export const lonely = 1;", [wordsOf("lonely();")])).toHaveLength(0);
  });

  test("an exception fails unless its count is exactly used: too many hits, or a stale row", () => {
    const hit = { ruleId: "no-throw", file: "kernel/a.ts" };
    expect(compare([hit], { "no-throw": { "kernel/a.ts": 1 } }).map(isOff)).toEqual([false]);
    expect(compare([hit, hit], { "no-throw": { "kernel/a.ts": 1 } }).map(isOff)).toEqual([true]);
    expect(compare([], { "no-throw": { "kernel/a.ts": 1 } })).toEqual([{ rule: "no-throw", file: "kernel/a.ts", now: 0, allowed: 1 }]);
    expect(compare([], { "no-throw": { "kernel/a.ts": 1 } }).map(isOff)).toEqual([true]);
  });
});

describe("no-literal-arg", () => {
  const callWith = (call: string): readonly string[] =>
    failing({ "a.ts": `export const a = (flag: number) => ${call};\n`, ...used("a") });

  test("a bare true, false or undefined passed to a function is a hit", () => {
    expect(callWith("encode(flag, true)")).toEqual(["no-literal-arg kernel/a.ts"]);
    expect(callWith("encode(false, flag)")).toEqual(["no-literal-arg kernel/a.ts"]);
    expect(callWith("fold(flag, undefined, step)")).toEqual(["no-literal-arg kernel/a.ts"]);
  });

  test("a value that a constructor wraps or a matcher compares is not a flag", () => {
    expect(callWith("ok(true)")).toEqual([]);
    expect(callWith("ok(undefined)")).toEqual([]);
    expect(callWith("some(false)")).toEqual([]);
    expect(callWith("P.bool(true)")).toEqual([]);
    expect(callWith("expect(flag).toBe(true)")).toEqual([]);
    expect(callWith("expect(flag).toEqual(undefined)")).toEqual([]);
  });

  test("a named constant is the fix, and a literal in a record is not positional", () => {
    expect(callWith("encode(flag, COMPRESSED)")).toEqual([]);
    expect(callWith("encode({ compressed: true })")).toEqual([]);
  });
});

describe("the tree gate over a scratch tree", () => {
  test("a clean tree has no failing rows", () => {
    expect(failing({ "a.ts": "export const a = 1;\n", ...used("a") })).toEqual([]);
  });

  test("a throw, a dead export and a positional boolean each fail by name", () => {
    expect(failing({ "a.ts": "export const a = () => { throw new Error('x'); };\n", ...used("a") })).toEqual(["no-throw kernel/a.ts"]);
    expect(failing({ "a.ts": "export const a = 1;\nexport const lonely = 2;\n", ...used("a") })).toEqual(["unreachable kernel/a.ts (lonely)"]);
    expect(failing({ "a.ts": "export const a = (mode: boolean) => mode;\n", ...used("a") })).toEqual(["no-boolean-param kernel/a.ts"]);
  });

  test("a registered exception allows exactly its count", () => {
    const file = { "a.ts": "export const a = () => { throw new Error('x'); };\n", ...used("a") };
    expect(failing(file, { "no-throw": { "kernel/a.ts": 1 } })).toEqual([]);
    expect(failing({ "a.ts": "export const a = 1;\n", ...used("a") }, { "no-throw": { "kernel/a.ts": 1 } })).toEqual(["no-throw kernel/a.ts"]);
  });
});
