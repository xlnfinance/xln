// The composition of the single gate command: each part alone must be able to turn it red.
import { describe, expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { gateExit, isWanted, selectionOf, type Part } from "./compose.ts";

describe("the gate exits 1 when any one part fails", () => {
  const green = { register: true, style: true, width: true };

  test("all parts passing is 0", () => expect(gateExit(green)).toBe(0));
  test("R-GATE-COMPOSE a failing register alone is 1", () => expect(gateExit({ ...green, register: false })).toBe(1));
  test("a failing style gate alone is 1", () => expect(gateExit({ ...green, style: false })).toBe(1));
  test("a failing folder width alone is 1", () => expect(gateExit({ ...green, width: false })).toBe(1));
});

const pureRoot = `${import.meta.dir}/../..`;

// A scratch checkout holding a copy of the gate's own code and trees, run as the real command is.
const scratchPure = (plant: Readonly<Record<string, string>>): string => {
  const repo = mkdtempSync(`${tmpdir()}/gate-run-`);
  // The whole of pure/ but node_modules: the dead-export count reads every file that could use a name.
  cpSync(pureRoot, `${repo}/pure`, { recursive: true, filter: (source) => !source.includes("/node_modules") });
  Object.entries(plant).forEach(([file, text]) => {
    mkdirSync(`${repo}/pure/${file.split("/").slice(0, -1).join("/")}`, { recursive: true });
    writeFileSync(`${repo}/pure/${file}`, text);
  });
  Bun.spawnSync(["git", "init", "-q"], { cwd: repo });
  return repo;
};

const run = (repo: string, flag: string): Readonly<{ code: number | null; out: string }> => {
  const done = Bun.spawnSync(["bun", `${repo}/pure/rules/check.ts`, flag], { cwd: `${repo}/pure` });
  return { code: done.exitCode, out: done.stdout.toString() + done.stderr.toString() };
};

describe("the real command over a scratch copy", () => {
  const THROWS = "export const bad = () => { throw new Error('x'); };\n";

  test("a clean copy passes the style part", () => expect(run(scratchPure({}), "--style-only").code).toBe(0));

  test("a throw planted in kernel/ exits 1 and names the file", () => {
    const { code, out } = run(scratchPure({ "kernel/bad.ts": THROWS }), "--style-only");
    expect(code).toBe(1);
    expect(out).toContain("kernel/bad.ts");
  });

  test("a throw planted in chain/ exits 1 (chain is inside the gate)", () => {
    const { code, out } = run(scratchPure({ "chain/bad.ts": THROWS }), "--style-only");
    expect(code).toBe(1);
    expect(out).toContain("chain/bad.ts");
  });

  test("the register part alone turns the command red: a scratch copy has no contract tests to carry the ids", () => {
    const repo = scratchPure({});
    Bun.spawnSync(["git", "add", "-A"], { cwd: repo });
    Bun.spawnSync(["git", "-c", "user.email=a@b", "-c", "user.name=t", "commit", "-q", "-m", "scratch"], { cwd: repo });
    const done = Bun.spawnSync(["bun", `${repo}/pure/rules/check.ts`, "--register-only", "--base", "HEAD"], { cwd: `${repo}/pure` });
    expect(done.exitCode).toBe(1);
    expect(done.stdout.toString()).toContain("no contract name carries the id");
  });

  test("a folder of 11 source files exits 1 and names the folder", () => {
    const files = Object.fromEntries(Array.from({ length: 11 }, (_, index) => [`w/f${index}.ts`, "export {};\n"]));
    const { code, out } = run(scratchPure(files), "--width-only");
    expect(code).toBe(1);
    expect(out).toContain("FOLDER_TOO_WIDE pure/w:11 > 10");
  });
});

describe("which parts a command line runs", () => {
  const PARTS: readonly Part[] = ["register", "style", "width"];
  const ran = (...args: readonly string[]): readonly Part[] => PARTS.filter((part) => isWanted(part, selectionOf(args)));

  test("R-GATE-COMPOSE the plain command runs every part", () => expect(ran()).toEqual(["register", "style", "width"]));
  test("the matrix view keeps to the register", () => expect(ran("--matrix")).toEqual(["register"]));
  test("each --X-only flag runs that part alone", () => {
    expect(ran("--register-only")).toEqual(["register"]);
    expect(ran("--style-only")).toEqual(["style"]);
    expect(ran("--width-only")).toEqual(["width"]);
  });
  test("a flag that is not a part flag changes nothing", () => expect(ran("--base", "HEAD")).toEqual(["register", "style", "width"]));
});
