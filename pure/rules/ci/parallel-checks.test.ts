// tools/run-parallel-checks.ts runs the real runner over stub gates that log when each starts and ends, so the order the
// runner keeps is read off the log: a quiet gate (a test with a fixed time limit that a busy machine cannot meet) runs
// first and alone, and a failure there stops everything after it.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

const runner = `${import.meta.dir}/../../../tools/run-parallel-checks.ts`;
const QUIET = "check:canonical-payment-surface";

type Outcome = Readonly<{ code: number | null; log: readonly string[] }>;

// Every gate is "bun gate.ts <name> <exit code>": it logs "start <name>", waits, logs "end <name>" and exits.
const run = (gates: readonly string[], failing: readonly string[] = []): Outcome => {
  const dir = mkdtempSync(`${tmpdir()}/parallel-checks-`);
  writeFileSync(
    `${dir}/gate.ts`,
    `import { appendFileSync } from "node:fs";\nconst [name, code] = process.argv.slice(2);\nappendFileSync("${dir}/log", "start " + name + "\\n");\nawait Bun.sleep(300);\nappendFileSync("${dir}/log", "end " + name + "\\n");\nprocess.exit(Number(code));\n`,
  );
  writeFileSync(`${dir}/log`, "");
  const scripts = Object.fromEntries(gates.map((name) => [name, `bun gate.ts ${name} ${failing.includes(name) ? 1 : 0}`]));
  writeFileSync(`${dir}/package.json`, JSON.stringify({ scripts }));
  const done = Bun.spawnSync(["bun", runner, ...gates], { cwd: dir, stdout: "pipe", stderr: "pipe" });
  return { code: done.exitCode, log: readFileSync(`${dir}/log`, "utf8").split("\n").filter((line) => line !== "") };
};

describe("run-parallel-checks quiet gates", () => {
  test("R-GATE-QUIET-GATES a quiet gate ends before any other gate starts, wherever it stands in the list", () => {
    const outcome = run(["a:one", "a:two", QUIET, "a:three", "a:four"]);
    expect(outcome.code).toBe(0);
    expect(outcome.log.slice(0, 2)).toEqual([`start ${QUIET}`, `end ${QUIET}`]);
    expect(outcome.log.filter((line) => line.startsWith("end ")).sort()).toEqual(
      ["a:one", "a:two", "a:three", "a:four", QUIET].map((name) => `end ${name}`).sort(),
    );
  }, 60_000);

  test("R-GATE-QUIET-GATES the other gates still run side by side", () => {
    const outcome = run(["a:one", "a:two", "a:three"]);
    expect(outcome.code).toBe(0);
    expect(outcome.log.slice(0, 2).sort()).toEqual(["start a:one", "start a:two"]);
  }, 60_000);

  test("R-GATE-QUIET-GATES a quiet gate that fails fails the run and no other gate starts", () => {
    const outcome = run(["a:one", QUIET, "a:two"], [QUIET]);
    expect(outcome.code).toBe(1);
    expect(outcome.log).toEqual([`start ${QUIET}`, `end ${QUIET}`]);
  }, 60_000);
});
