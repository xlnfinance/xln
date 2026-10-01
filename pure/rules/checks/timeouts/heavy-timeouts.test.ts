// A heavy test names its own timeout: what is heavy, what is not, and what a timeout looks like. Each plant is the
// source text of a test file.
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname } from "node:path";
import { heavyWithoutTimeout, testCalls, timeoutsReport } from "./heavy-timeouts.ts";

const pureRoot = `${import.meta.dir}/../../..`;
const read = (path: string): string => readFileSync(path, "utf8");

const offenders = (source: string): readonly string[] => heavyWithoutTimeout(source).map((offender) => `${offender.line} ${offender.title}`);

describe("what is heavy", () => {
  test("R-GATE-TEST-TIMEOUTS a test that starts a bun, forge, ast-grep, quint or uvx process, or process.execPath, is heavy", () => {
    const heavy = (command: string): readonly string[] => offenders(`test("t", () => { Bun.spawnSync([${command}, "x"]); });\n`);
    ["\"bun\"", "process.execPath", "\"forge\"", "\"ast-grep\"", "\"quint\"", "\"uvx\""].forEach((command) => expect(heavy(command)).toEqual([`1 "t"`]));
    expect(offenders('test("t", () => { spawnSync(["bun", "x"]); });\n')).toEqual([`1 "t"`]);
    expect(offenders('test("t", () => { execFileSync(process.execPath, ["x"]); });\n')).toEqual([`1 "t"`]);
    expect(offenders('test("t", () => { Bun.spawn(\n  ["bun", "x"]); });\n')).toEqual([`1 "t"`]);
  });

  test("R-GATE-TEST-TIMEOUTS git, cat and rm are cheap: a test that only runs them is not heavy", () => {
    expect(offenders('test("t", () => { Bun.spawnSync(["git", "init", "-q"]); Bun.spawnSync(["rm", "-r", "x"]); });\n')).toEqual([]);
  });

  test("R-GATE-TEST-TIMEOUTS a test that opens og's world or lane, walks or calls an explorer is heavy; a name that only starts like one is not", () => {
    ["openWorld(seed, \"x\")", "createLane(cfg)", "bootChain()", "walk(seed, ROWS, WORLD)", "explore(REAL, WEATHER, seed, 4)", "exploreStorm(1)"].forEach((call) =>
      expect(offenders(`test("t", async () => { await ${call}; });\n`)).toEqual([`1 "t"`]),
    );
    ["walkLine(seed, c)", "uncovered(ROWS, seen)", "walkSeeds(3)", "o.walk(1)", "unexplored(1)"].forEach((call) => expect(offenders(`test("t", () => { ${call}; });\n`)).toEqual([]));
  });

  test("R-GATE-TEST-TIMEOUTS a heavy call in a comment or a string is not a call", () => {
    expect(offenders('test("t", () => {\n  // openWorld(seed, "x") is slow\n  expect("Bun.spawnSync([\\"bun\\"]) and walk(1)").toBe("x");\n});\n')).toEqual([]);
    expect(offenders('test("a test that calls walk(1) and Bun.spawnSync([\\"bun\\"])", () => {});\n')).toEqual([]);
  });

  test("R-GATE-TEST-TIMEOUTS a test is heavy through a helper of its own file, even two helpers away, and not through a cheap one", () => {
    const helpers = 'const run = (args: string[]) => Bun.spawnSync(["bun", "x", ...args]);\nconst check = (flag: string) => run([flag]).exitCode;\nconst cheap = () => 1 + 1;\n';
    expect(offenders(`${helpers}test("direct", () => { run(["a"]); });\n`)).toEqual([`4 "direct"`]);
    expect(offenders(`${helpers}test("indirect", () => { check("--x"); });\n`)).toEqual([`4 "indirect"`]);
    expect(offenders(`${helpers}test("cheap", () => { cheap(); });\n`)).toEqual([]);
    expect(offenders(`function scratch() {\n  return Bun.spawnSync(["bun", "x"]);\n}\ntest("function", () => { scratch(); });\n`)).toEqual([`4 "function"`]);
  });
});

describe("what names a timeout", () => {
  const spawn = 'Bun.spawnSync(["bun", "x"]);';

  test("R-GATE-TEST-TIMEOUTS a third argument is a timeout: a number, a constant or an object, with or without a trailing comma", () => {
    ["30_000", "SLOW_MS", "{ timeout: 30_000 }", "30_000,"].forEach((third) => expect(offenders(`test("t", () => { ${spawn} }, ${third});\n`)).toEqual([]));
    expect(offenders(`test("t", () => {\n  ${spawn}\n}, 120_000);\n`)).toEqual([]);
    expect(offenders(`test("t", () => ${spawn.slice(0, -1)}, 30_000);\n`)).toEqual([]);
  });

  test("R-GATE-TEST-TIMEOUTS commas inside the callback, its parameters and its default values are not arguments", () => {
    expect(offenders(`test("t", async ({ a, b }) => { f(a, b); const x = [1, 2, 3]; ${spawn} });\n`)).toEqual([`1 "t"`]);
    expect(offenders(`test("t", (a = g(1, 2), b = { c: 1, d: 2 }) => { ${spawn} });\n`)).toEqual([`1 "t"`]);
    expect(offenders(`test(\`t \${f(1, 2)}\`, () => { ${spawn} });\n`)).toEqual([`1 \`t \${f(1, 2)}\``]);
  });

  test("R-GATE-TEST-TIMEOUTS a test in a loop or a describe is read, it() and test.only() too, test.skip() and test.each() are not", () => {
    const loop = `describe("d", () => {\n  [1, 2].forEach((seed) => {\n    test(\`seed \${seed}\`, async () => { await walk(seed); });\n  });\n  it("i", () => { ${spawn} });\n  test.only("o", () => { ${spawn} });\n  test.skip("s", () => { ${spawn} });\n});\n`;
    expect(offenders(loop)).toEqual(["3 `seed ${seed}`", '5 "i"', '6 "o"']);
    expect(offenders(`describe("d", () => { [1, 2].forEach((seed) => { test(\`seed \${seed}\`, async () => { await walk(seed); }, 600_000); }); });\n`)).toEqual([]);
    expect(offenders(`test.each([1])("e %d", () => { ${spawn} });\n`)).toEqual([]);
  });

  test("R-GATE-TEST-TIMEOUTS testCalls says where each call is, whether it names a timeout, and where its callback ends", () => {
    const source = `test("a", () => {}, 5);\ntest("b", () => {});\n`;
    expect(testCalls(source).map((call) => [call.line, call.title, call.timeout])).toEqual([[1, '"a"', true], [2, '"b"', false]]);
    expect(source.slice(testCalls(source)[1]?.end)).toBe(");\n");
  });
});

describe("the report over a tree", () => {
  const scratch = (files: Readonly<Record<string, string>>): string => {
    const repo = mkdtempSync(`${tmpdir()}/timeouts-`);
    Bun.spawnSync(["git", "init", "-q"], { cwd: repo });
    Object.entries(files).forEach(([file, text]) => {
      mkdirSync(`${repo}/${dirname(file)}`, { recursive: true });
      writeFileSync(`${repo}/${file}`, text);
    });
    return repo;
  };
  const HEAVY = 'import { test } from "bun:test";\n\ntest("runs the gate", () => { Bun.spawnSync(["bun", "x"]); });\n';

  test("R-GATE-TEST-TIMEOUTS a heavy test with no timeout is red and named with its file and line", () => {
    const report = timeoutsReport(scratch({ "a/heavy.test.ts": HEAVY }), read);
    expect(report.failed).toBe(true);
    expect(report.lines[0]).toContain('TEST_TIMEOUT_MISSING pure/a/heavy.test.ts:3 "runs the gate" starts a bun, forge, ast-grep, quint or uvx process');
  });

  test("R-GATE-TEST-TIMEOUTS a .test.tsx and a .test.mts file are test files too", () => {
    const fine = 'import { test } from "bun:test";\n\ntest("cheap", () => {});\n';
    ["a/heavy.test.tsx", "a/heavy.test.mts"].forEach((file) => expect(timeoutsReport(scratch({ "b/fine.test.ts": fine, [file]: HEAVY }), read).lines[0]).toContain(`pure/${file}:3`));
  });

  test("R-GATE-TEST-TIMEOUTS the same test with a timeout is green, and a file that is not a test file is not read", () => {
    const green = timeoutsReport(scratch({ "a/heavy.test.ts": HEAVY.replace("); });", "); }, 30_000);"), "a/helper.ts": HEAVY }), read);
    expect(green).toEqual({ failed: false, lines: ["ok   test timeouts: every heavy test names its own (1 test files)"] });
  });

  test("R-GATE-TEST-TIMEOUTS a tree git does not list is red, not an empty pass", () => {
    expect(timeoutsReport(mkdtempSync(`${tmpdir()}/timeouts-none-`), read).failed).toBe(true);
    expect(timeoutsReport(scratch({ "a/readme.md": "x" }), read).failed).toBe(true);
  });
});

describe("the real tree", () => {
  test("R-GATE-TEST-TIMEOUTS every heavy test of pure/ names its own timeout", () => expect(timeoutsReport(pureRoot, read).lines.filter((line) => line.startsWith("TEST_TIMEOUT_MISSING"))).toEqual([]));

  test("R-GATE-TEST-TIMEOUTS the check is not vacuous: the real compose and forge tests are read as heavy, each with its timeout", () => {
    const heavy = ["rules/checks/compose.test.ts", "rules/checks/forge.test.ts"].flatMap((file) => testCalls(read(`${pureRoot}/${file}`)).filter((call) => call.why !== undefined));
    expect(heavy.length).toBeGreaterThan(10);
    expect(heavy.filter((call) => !call.timeout)).toEqual([]);
  });
});
