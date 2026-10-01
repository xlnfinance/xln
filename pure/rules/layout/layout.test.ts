import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { parseRegister, parseRegisterFiles, type RegisterFile } from "../register.ts";
import { differences, fileOf, oldRows, port, splitFiles, type RawRow } from "./split.ts";
import { readRegisterAt, readRegisterFolder } from "./store.ts";

const row = (id: string, extra: Record<string, unknown> = {}): RawRow => ({
  id,
  statement: `the rule ${id}`,
  source: "test",
  layers: { arrival: "hold", quint: "-", contract: "n/a: no contract part", rig: "owed: test rig", ts: "hold" },
  killers: [{ kind: "test", layer: "ts", name: `${id} holds` }],
  ...extra,
});

const oldFile = (...rows: RawRow[]): string => JSON.stringify({ policy: "ids are names", rows }, null, 1);

const file = (each: RawRow): RegisterFile => fileOf(each);

describe("a rule is one file named by its id", () => {
  test("the folder reads as the register, in id order, whatever order the files come in", () => {
    const parsed = parseRegisterFiles([file(row("R-B")), file(row("A1")), file(row("R-A"))]);
    expect(parsed.ok && parsed.value.map((each) => each.id)).toEqual(["A1", "R-A", "R-B"]);
  });

  test("two rule files whose ids differ only in case are refused", () => {
    const clash = parseRegisterFiles([file(row("R-A")), file(row("r-a"))]);
    expect(!clash.ok && clash.error.detail).toContain("R-A and r-a differ only in case");
    expect(parseRegisterFiles([file(row("R-A")), file(row("R-AB"))]).ok).toBe(true);
  });

  test("a file named for another id, a file that is not <id>.json, and a file that is not JSON are each refused, naming the file", () => {
    const misnamed = parseRegisterFiles([{ name: "R-B.json", text: file(row("R-A")).text }]);
    expect(!misnamed.ok && misnamed.error.where).toBe("R-B.json");
    expect(!misnamed.ok && misnamed.error.detail).toContain("must be named R-A.json");
    const noExtension = parseRegisterFiles([{ name: "R-A", text: file(row("R-A")).text }]);
    expect(noExtension.ok).toBe(false);
    const readme = parseRegisterFiles([file(row("R-A")), { name: "README.md", text: "# rules" }]);
    expect(!readme.ok && readme.error.where).toBe("README.md");
  });

  test("a rule whose id would be a path is refused", () => {
    const traversal = parseRegisterFiles([{ name: "x.json", text: JSON.stringify(row("../x")) }]);
    expect(traversal.ok).toBe(false);
  });

  test("a bad row is refused with its file's name, and an empty folder is refused", () => {
    const bad = parseRegisterFiles([{ name: "R-A.json", text: JSON.stringify(row("R-A", { layers: { moon: "hold" } })) }]);
    expect(!bad.ok && bad.error.where).toBe("R-A");
    expect(parseRegisterFiles([]).ok).toBe(false);
  });

  test("the old one-file layout still parses, for a base from before the split", () => {
    expect(parseRegister(oldFile(row("R-A"), row("R-B"))).ok).toBe(true);
  });
});

describe("splitting the old file into rule files, and proving nothing moved", () => {
  const text = oldFile(row("R-B"), row("R-A", { retired_by: ["R-B"] }));

  test("one file per rule, named by id, holding that row's data and nothing else", () => {
    const files = splitFiles(text);
    expect(files.ok && files.value.map((each) => each.name)).toEqual(["R-B.json", "R-A.json"]);
    expect(files.ok && JSON.parse(files.value[1]?.text ?? "")).toEqual(row("R-A", { retired_by: ["R-B"] }));
  });

  test("the typed register of the files is the typed register of the old file, rows in id order", () => {
    const files = splitFiles(text);
    const old = parseRegister(text);
    const split = files.ok ? parseRegisterFiles(files.value) : files;
    expect(old.ok && split.ok && split.value).toEqual(old.ok ? old.value.toSorted((left, right) => (left.id < right.id ? -1 : 1)) : []);
  });

  test("the proof is empty for an exact split and names a missing, an extra and a changed rule", () => {
    const files = splitFiles(text);
    const exact = files.ok ? files.value : [];
    expect(differences(text, exact)).toEqual([]);
    expect(differences(text, exact.slice(1))).toEqual(["R-B.json is missing"]);
    expect(differences(text, [...exact, file(row("R-C"))])).toEqual(["R-C.json is not in the old file"]);
    const edited = exact.map((each) => (each.name === "R-B.json" ? file(row("R-B", { statement: "another" })) : each));
    expect(differences(text, edited)).toEqual(["R-B.json differs from its row"]);
  });

  test("a changed key order is a difference, because the data is the same data in the same order", () => {
    const files = splitFiles(text);
    const first = files.ok ? files.value[0] : undefined;
    const reordered = first === undefined ? [] : [{ name: first.name, text: JSON.stringify({ source: "test", ...row("R-B") }) }];
    expect(differences(oldFile(row("R-B")), reordered)).toEqual(["R-B.json differs from its row"]);
  });

  test("an id that is a path cannot be split or ported: it would name a file outside the folder", () => {
    ["../../../escaped", "a/b", "..", ".hidden", "R A", "-x", ""].forEach((id) => {
      expect(oldRows(oldFile(row(id))).ok).toBe(false);
      expect(splitFiles(oldFile(row(id))).ok).toBe(false);
    });
    expect(oldRows(oldFile(row("R2C-DEBT-FIRST"), row("J5"))).ok).toBe(true);
  });

  test("a row without an id, and an id that appears twice, cannot be split", () => {
    expect(oldRows(JSON.stringify({ rows: [{ statement: "s" }] })).ok).toBe(false);
    expect(splitFiles(oldFile(row("R-A"), row("R-A"))).ok).toBe(false);
    expect(oldRows("not json").ok).toBe(false);
  });

  test("two ids that differ only in case cannot be split: a case-insensitive file system would make them one file", () => {
    const clash = splitFiles(oldFile(row("R-A"), row("r-a")));
    expect(!clash.ok && clash.error.detail).toContain("differ only in case");
  });
});

describe("porting a branch's edits of the old file onto the folder", () => {
  const base = [row("R-A"), row("R-B")];
  const folder = base.map(file);

  test("a rule the branch added, one it changed and one it removed become a new file, a rewritten file and a deleted file", () => {
    const changed = row("R-A", { statement: "a new statement" });
    const plan = port(base, [changed, row("R-C")], folder);
    expect(plan.conflicts).toEqual([]);
    expect(plan.writes.map((each) => each.name).toSorted()).toEqual(["R-A.json", "R-C.json"]);
    expect(plan.deletes).toEqual(["R-B.json"]);
  });

  test("a rule the branch did not touch is never written, even when the folder has moved on since", () => {
    const moved = folder.map((each) => (each.name === "R-B.json" ? file(row("R-B", { statement: "main changed it" })) : each));
    const plan = port(base, [row("R-A", { statement: "mine" }), row("R-B")], moved);
    expect(plan.conflicts).toEqual([]);
    expect(plan.writes.map((each) => each.name)).toEqual(["R-A.json"]);
  });

  test("a rule both the branch and the folder changed is a conflict and is left alone", () => {
    const moved = folder.map((each) => (each.name === "R-A.json" ? file(row("R-A", { statement: "main changed it" })) : each));
    const plan = port(base, [row("R-A", { statement: "mine" }), row("R-B")], moved);
    expect(plan.conflicts).toEqual(["R-A.json: the folder changed this rule since the branch started"]);
    expect(plan.writes).toEqual([]);
  });

  test("an edit the folder already has is not a conflict and writes nothing", () => {
    const same = row("R-A", { statement: "same edit" });
    const moved = folder.map((each) => (each.name === "R-A.json" ? file(same) : each));
    const plan = port(base, [same, row("R-B")], moved);
    expect(plan).toEqual({ writes: [], deletes: [], conflicts: [] });
  });
});

describe("the folder and the commits it is read from", () => {
  const dir = mkdtempSync(`${tmpdir()}/rules-layout-`);

  test("a folder of rule files loads; a stray directory, a register.json beside it and a missing folder are refused", () => {
    const folder = `${dir}/register`;
    mkdirSync(folder);
    writeFileSync(`${folder}/R-A.json`, file(row("R-A")).text);
    const loaded = readRegisterFolder(folder);
    expect(loaded.ok && loaded.value.map((each) => each.id)).toEqual(["R-A"]);
    writeFileSync(`${folder}/.DS_Store`, "junk");
    expect(readRegisterFolder(folder).ok).toBe(true);
    mkdirSync(`${folder}/nested`);
    expect(readRegisterFolder(folder).ok).toBe(false);
    expect(readRegisterFolder(`${dir}/nowhere`).ok).toBe(false);
    const beside = mkdtempSync(`${tmpdir()}/rules-layout-`);
    mkdirSync(`${beside}/register`);
    writeFileSync(`${beside}/register/R-A.json`, file(row("R-A")).text);
    writeFileSync(`${beside}/register.json`, oldFile(row("R-A")));
    const doubled = readRegisterFolder(`${beside}/register`);
    expect(!doubled.ok && doubled.error.detail).toContain("must be deleted");
  });

  test("a commit is read in whichever layout it has: the folder, the one file, or neither; a bad commit is an error", () => {
    const repo = mkdtempSync(`${tmpdir()}/rules-layout-git-`);
    const sh = (...args: string[]): void => void Bun.spawnSync(["git", "-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd: repo });
    const sha = (): string => Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: repo }).stdout.toString().trim();
    sh("init", "-q", "-b", "main");
    writeFileSync(`${repo}/a.txt`, "a");
    sh("add", "-A");
    sh("commit", "-q", "-m", "none");
    const none = sha();
    mkdirSync(`${repo}/pure/rules`, { recursive: true });
    writeFileSync(`${repo}/pure/rules/register.json`, oldFile(row("R-B"), row("R-A")));
    sh("add", "-A");
    sh("commit", "-q", "-m", "one file");
    const single = sha();
    Bun.spawnSync(["git", "rm", "-q", "pure/rules/register.json"], { cwd: repo });
    mkdirSync(`${repo}/pure/rules/register`, { recursive: true });
    writeFileSync(`${repo}/pure/rules/register/R-A.json`, file(row("R-A")).text);
    writeFileSync(`${repo}/pure/rules/register/R-B.json`, file(row("R-B")).text);
    sh("add", "-A");
    sh("commit", "-q", "-m", "folder");
    const folder = sha();
    const ids = (at: ReturnType<typeof readRegisterAt>): readonly string[] => (at.ok && at.value._tag === "Found" ? at.value.register.map((each) => each.id) : []);
    expect(readRegisterAt(repo, none)).toEqual({ ok: true, value: { _tag: "Absent" } });
    expect(ids(readRegisterAt(repo, single))).toEqual(["R-B", "R-A"]);
    expect(ids(readRegisterAt(repo, folder))).toEqual(["R-A", "R-B"]);
    expect(readRegisterAt(repo, "no-such-commit").ok).toBe(false);
  });
});
