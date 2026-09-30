import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { ALLOWED_DRIFT, frozenDrift, frozenTouches } from "./frozen.ts";
import {
  EXCLUDED_REPOSITORY_PATHS,
  FOLDER_WIDTH_DEBT,
  evaluateFolderWidths,
  folderWidthReport,
  widthsOf,
} from "./folder-width.ts";

describe("frozen gate: paths", () => {
  test("a path under core/ or jurisdictions/ is a touch; pure/, contracts/ and spec/ are not", () => {
    const paths = ["core/runtime.ts", "jurisdictions/contracts/Depository.sol", "pure/xln.ts", "contracts/contracts/Account.sol", "spec/README.md", "core-notes/x.md"];
    expect(frozenTouches(paths)).toEqual(["core/runtime.ts", "jurisdictions/contracts/Depository.sol"]);
  });

  test("the allowlist is empty for good", () => expect(ALLOWED_DRIFT).toEqual([]));
});

// A scratch repository standing in for og: a pinned commit with files under both frozen roots.
const scratch = (): Readonly<{ repo: string; pin: string; git: (...args: string[]) => string }> => {
  const repo = mkdtempSync(`${tmpdir()}/frozen-`);
  const git = (...args: string[]): string =>
    Bun.spawnSync(["git", "-c", "user.email=t@t", "-c", "user.name=t", "-c", "core.quotepath=true", ...args], { cwd: repo }).stdout.toString().trim();
  git("init", "-q", "-b", "main");
  mkdirSync(`${repo}/core`, { recursive: true });
  mkdirSync(`${repo}/jurisdictions`, { recursive: true });
  mkdirSync(`${repo}/pure`, { recursive: true });
  writeFileSync(`${repo}/core/a.ts`, "export const a = 1;\nexport const b = 2;\nexport const c = 3;\n");
  writeFileSync(`${repo}/jurisdictions/j.sol`, "contract J {}\n");
  writeFileSync(`${repo}/pure/p.ts`, "export const p = 1;\n");
  git("add", "-A");
  git("commit", "-q", "-m", "og");
  return { repo, pin: git("rev-parse", "HEAD"), git };
};

const driftOf = (repo: string, pin: string): readonly string[] => {
  const drift = frozenDrift(repo, pin);
  return drift.ok ? drift.value : [`ERR ${drift.error.detail}`];
};

describe("frozen gate: every way of touching og is red (fools from the review of PR #66)", () => {
  test("clean: nothing differs", () => {
    const { repo, pin } = scratch();
    expect(driftOf(repo, pin)).toEqual([]);
  });

  test("a rename out of core/ is caught: the old path is listed", () => {
    const { repo, pin, git } = scratch();
    git("mv", "core/a.ts", "pure/moved.ts");
    git("commit", "-q", "-m", "move out");
    expect(driftOf(repo, pin)).toEqual(["core/a.ts"]);
  });

  test("a non-ASCII path in core/ is caught, not quoted away", () => {
    const { repo, pin, git } = scratch();
    writeFileSync(`${repo}/core/é-new.ts`, "export {};\n");
    git("add", "-A");
    git("commit", "-q", "-m", "add");
    expect(driftOf(repo, pin)).toEqual(["core/é-new.ts"]);
  });

  test("a deletion, a mode change, a dirty edit and an untracked file are caught", () => {
    const { repo, pin, git } = scratch();
    git("rm", "-q", "jurisdictions/j.sol");
    chmodSync(`${repo}/core/a.ts`, 0o755);
    writeFileSync(`${repo}/core/untracked.ts`, "export {};\n");
    expect([...driftOf(repo, pin)].sort()).toEqual(["core/a.ts", "core/untracked.ts", "jurisdictions/j.sol"]);
  });

  test("a rename into core/ and a file in pure/ only: the rename is caught, pure/ is not", () => {
    const { repo, pin, git } = scratch();
    git("mv", "pure/p.ts", "core/p.ts");
    writeFileSync(`${repo}/pure/new.ts`, "export {};\n");
    expect(driftOf(repo, pin)).toEqual(["core/p.ts"]);
  });

  test("a failing git is red, never ok: an unknown pin is an error", () => {
    const { repo } = scratch();
    const drift = frozenDrift(repo, "deadbee");
    expect(drift.ok).toBe(false);
  });

  test("not a git repository is an error", () => {
    const empty = mkdtempSync(`${tmpdir()}/nogit-`);
    expect(frozenDrift(empty, "566c850").ok).toBe(false);
    rmSync(empty, { recursive: true });
  });

  test("a move within core/ is caught at both ends", () => {
    const { repo, pin, git } = scratch();
    renameSync(`${repo}/core/a.ts`, `${repo}/core/a2.ts`);
    git("add", "-A");
    git("commit", "-q", "-m", "rename inside");
    expect([...driftOf(repo, pin)].sort()).toEqual(["core/a.ts", "core/a2.ts"]);
  });
});

describe("folder width on the files that exist", () => {
  test("counts direct source files per directory and ignores other extensions", () => {
    const files = ["a/x.ts", "a/y.ts", "a/notes.md", "a/b/z.sol"];
    expect(widthsOf(files)).toEqual([{ path: "a", files: 2 }, { path: "a/b", files: 1 }]);
  });

  test("a file under a generated or excluded folder is not counted", () => {
    const files = ["spec/arrival/p/x.ts", "contracts/typechain-types/x.ts", "contracts/artifacts/y.ts", "contracts/cache/z.ts", "pkg/node_modules/m/x.ts", "kept/x.ts"];
    expect(widthsOf(files)).toEqual([{ path: "kept", files: 1 }]);
  });

  test("a folder is wide only by the files given: gitignored local folders are never in the list", () => {
    const tracked = Array.from({ length: 3 }, (_, index) => `contracts/contracts/C${index}.sol`);
    expect(widthsOf(tracked)).toEqual([{ path: "contracts/contracts", files: 3 }]);
  });

  test("too wide without debt is red; the debt must match exactly; an unused debt is stale", () => {
    const eleven = Array.from({ length: 11 }, (_, index) => `w/f${index}.ts`);
    expect(evaluateFolderWidths(widthsOf(eleven), {}, 10)).toEqual(["FOLDER_TOO_WIDE w:11 > 10"]);
    expect(evaluateFolderWidths(widthsOf(eleven), { w: 12 }, 10)).toEqual(["FOLDER_WIDTH_DEBT_CHANGED w:11 != 12"]);
    expect(evaluateFolderWidths(widthsOf(eleven), { w: 11 }, 10)).toEqual([]);
    expect(evaluateFolderWidths(widthsOf(["w/a.ts"]), { w: 11 }, 10)).toEqual(["STALE_FOLDER_WIDTH_DEBT w:1 <= 10"]);
  });

  test("the copied config equals og's at 566c850 plus the recorded additions", () => {
    const show = Bun.spawnSync(["git", "show", "566c850:core/scripts/checks/architecture/check-folder-width.ts"], { cwd: `${import.meta.dir}/../../..` });
    const source = show.stdout.toString();
    const block = (name: string): readonly string[] =>
      [...(new RegExp(`const ${name}\\b[^=]*=\\s*new Set\\(\\[([\\s\\S]*?)\\]\\)`).exec(source)?.[1] ?? "").matchAll(/'([^']*)'/g)].map((found) => found[1] ?? "");
    const ogExcluded = block("EXCLUDED_REPOSITORY_PATHS");
    expect(ogExcluded.length).toBeGreaterThan(20);
    const additions = ["contracts/artifacts", "contracts/cache", "contracts/typechain-types", "spec/arrival"];
    expect([...EXCLUDED_REPOSITORY_PATHS].filter((path) => !ogExcluded.includes(path)).sort()).toEqual(additions);
    expect(ogExcluded.filter((path) => !EXCLUDED_REPOSITORY_PATHS.has(path))).toEqual([]);
    const ogDebt = [...source.matchAll(/^\s+'([^']+)': (\d+),$/gm)].map((found) => [found[1], Number(found[2])]);
    expect(ogDebt.length).toBe(14);
    expect(Object.entries(FOLDER_WIDTH_DEBT).filter(([path, width]) => !ogDebt.some(([p, w]) => p === path && w === width))).toEqual([["contracts/contracts", 16]]);
  });
});

describe("folder width report over a real git checkout (the part the single gate command runs)", () => {
  const checkout = (count: number): string => {
    const repo = mkdtempSync(`${tmpdir()}/width-repo-`);
    mkdirSync(`${repo}/w`);
    Array.from({ length: count }, (_, index) => writeFileSync(`${repo}/w/f${index}.ts`, "export {};\n"));
    Bun.spawnSync(["git", "init", "-q"], { cwd: repo });
    return repo;
  };

  test("a folder of 11 untracked source files is red and names the folder", () => {
    const report = folderWidthReport(checkout(11), {});
    expect(report.failed).toBe(true);
    expect(report.lines).toContain("FOLDER_TOO_WIDE w:11 > 10");
  });

  test("a folder of 10 is ok", () => {
    expect(folderWidthReport(checkout(10), {})).toEqual({ failed: false, lines: ["FOLDER_WIDTH_OK dirs=1 sourceFiles=10 max=10"] });
  });

  test("a directory that is not a git checkout is red, not an empty pass", () => {
    const report = folderWidthReport(mkdtempSync(`${tmpdir()}/width-none-`));
    expect(report.failed).toBe(true);
  });
});
