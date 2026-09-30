// Each test plants a fool in a scratch tree and asks the gate whether it notices.
import { describe, expect, test } from "bun:test";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { compare, isOff, longLines } from "./counts.ts";
import { treeStyle } from "./gate.ts";
import { failing, offRows, pureRoot, scratch, used } from "./scratch.ts";

describe("the counts ast-grep cannot make", () => {
  test("a line over 120 characters is a hit and 120 is not", () => {
    expect(longLines("a.ts", `${"x".repeat(121)}\n${"y".repeat(120)}`)).toEqual([{ ruleId: "long-line", file: "a.ts" }]);
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

describe("the gate cannot be satisfied by doing nothing", () => {
  const clean = { "a.ts": "export const a = 1;\n", ...used("a") };

  // Runs the gate with `ast-grep` replaced by a script, and puts PATH back afterwards.
  const withStub = (script: string): boolean => {
    const bin = mkdtempSync(`${tmpdir()}/stub-bin-`);
    writeFileSync(`${bin}/ast-grep`, `#!/bin/sh\n${script}\n`);
    chmodSync(`${bin}/ast-grep`, 0o755);
    const before = process.env["PATH"];
    process.env["PATH"] = `${bin}:${before}`;
    try {
      return treeStyle(scratch(clean)).failed;
    } finally {
      process.env["PATH"] = before;
    }
  };

  test("R-GATE-STYLE an ast-grep that exits 0 and prints nothing fails the gate", () => expect(withStub("exit 0")).toBe(true));
  test("an ast-grep killed by a signal fails the gate", () => expect(withStub("kill -9 $$")).toBe(true));
  test("an ast-grep that exits 2 fails the gate", () => expect(withStub("exit 2")).toBe(true));

  // A scan that prints the canary's hit and then dies is still a failed scan: the answer is not to be trusted.
  // A stub answers like ast-grep would for the planted files: one hit per canary file, named by the rule its file is named after.
  const hitsFor = (skip: string): string =>
    `for a in "$@"; do case "$a" in */canary) c="$a";; esac; done\nj=""\nfor f in "$c"/*; do b=$(basename "$f"); case "$b" in ${skip}) continue;; esac; j="$j{\\"ruleId\\":\\"\${b%.*}\\",\\"file\\":\\"$f\\"},"; done\necho "[\${j%,}]"`;
  const PRINTS_CANARY = hitsFor("none");
  test("an ast-grep that prints the canary hit but exits 2 fails the gate", () => expect(withStub(`${PRINTS_CANARY}\nexit 2`)).toBe(true));
  test("an ast-grep that prints the canary hit and is then killed fails the gate", () => expect(withStub(`${PRINTS_CANARY}\nkill -9 $$`)).toBe(true));
  // The style scan and the fact scan each plant their own canaries: one that answers only the style rules has not read the facts.
  const PRINTS_STYLE_CANARY = hitsFor("decl.*");
  test("an ast-grep that answers the style canary but never the fact canary fails the gate", () => expect(withStub(PRINTS_STYLE_CANARY)).toBe(true));
  test("an ast-grep that prints the canary hit and exits 0 passes a clean tree", () => expect(withStub(`${PRINTS_CANARY}\nexit 0`)).toBe(false));
  test("the real ast-grep passes a clean tree", () => expect(treeStyle(scratch(clean)).failed).toBe(false));

  test("a directory under pure/ that is neither gated nor named as outside the gate is a failing row", () => {
    const root = scratch(clean);
    mkdirSync(`${root}/account`);
    writeFileSync(`${root}/account/bad.ts`, "export const bad = () => { throw new Error('x'); };\n");
    expect(treeStyle(root).rows.filter(isOff).map((row) => `${row.rule} ${row.file}`)).toContain("unlisted-dir account");
  });
});

describe("every style rule has a canary that it must report", () => {
  const clean = { "a.ts": "export const a = 1;\n", ...used("a") };
  const canaries = (root: string): Record<string, string> => JSON.parse(readFileSync(`${root}/style/canaries.json`, "utf8"));
  const planted = (root: string, snippets: Record<string, string>): void =>
    writeFileSync(`${root}/style/canaries.json`, JSON.stringify({ ...canaries(root), ...snippets }));

  test("a rule file that is deleted, with its exception row and its use gone, turns the gate red", () => {
    const root = scratch({ ...clean, "t.ts": "export const t = () => { try { return 1; } catch (e) { return 2; } };\n", ...used("t") });
    rmSync(`${root}/style/rules/no-try.yml`);
    expect(offRows(root)).toEqual(["canary-orphan no-try"]);
  });

  test("a rule that no longer matches its canary is silent, and the gate is red", () => {
    const root = scratch(clean);
    writeFileSync(`${root}/style/rules/no-let.yml`, readFileSync(`${root}/style/rules/no-let.yml`, "utf8").replace("^let\\s", "^never"));
    expect(offRows(root)).toEqual(["canary-silent no-let", "canary-silent no-let (Tsx)"]);
  });

  test("a canary that does not trigger its own rule is silent, even when that rule reports on another rule's canary", () => {
    const root = scratch(clean);
    planted(root, { "no-let": "export const a = 1;\n", "no-throw": "let x = 1;\nexport const a = () => { throw new Error(\"x\"); };\n" });
    expect(offRows(root)).toEqual(["canary-silent no-let", "canary-silent no-let (Tsx)"]);
  });

  test("a rule file without a canary is a failing row", () => {
    const root = scratch(clean);
    writeFileSync(`${root}/style/tree-rules/no-new.yml`, "id: no-new\nlanguage: TypeScript\nseverity: error\nmessage: m\nrule: { kind: debugger_statement }\n");
    expect(offRows(root)).toEqual(["canary-missing no-new"]);
  });

  test("every rule reports on its canary in both languages, so the real tree is clean", () => {
    expect(offRows(scratch(clean))).toEqual([]);
  });
});

describe("the gate reads the files git lists, never the disk", () => {
  const clean = { "a.ts": "export const a = 1;\n", ...used("a") };
  test("an ignored folder under pure/ (a local db-* from a test run) does not turn the gate red", () => {
    const root = scratch(clean);
    writeFileSync(`${root}/.gitignore`, "db-*\n");
    mkdirSync(`${root}/db-run`);
    writeFileSync(`${root}/db-run/junk.ts`, "export const junk = () => { throw new Error('x'); };\n");
    expect(offRows(root)).toEqual([]);
  });

  test("an ignored file under kernel/ is not counted, and the same file untracked-not-ignored is", () => {
    const root = scratch(clean);
    writeFileSync(`${root}/.gitignore`, "kernel/ignored.ts\n");
    const long = `export const ignored = "${"x".repeat(130)}";\n`;
    writeFileSync(`${root}/kernel/ignored.ts`, long);
    expect(offRows(root)).toEqual([]);
    writeFileSync(`${root}/kernel/seen.ts`, long.replace("ignored", "seen"));
    expect(offRows(root)).toContain("long-line kernel/seen.ts");
  });

  test("a directory that is not a git checkout is a failing gate, not an empty pass", () => {
    const root = mkdtempSync(`${tmpdir()}/tree-nogit-`);
    cpSync(`${pureRoot}/style`, `${root}/style`, { recursive: true });
    mkdirSync(`${root}/kernel`);
    mkdirSync(`${root}/chain`);
    // Named, because stale exception rows alone would also fail a scratch tree that has no sources.
    expect(treeStyle(root).rows.map((row) => row.rule)).toContain("git-listing");
  });
});
