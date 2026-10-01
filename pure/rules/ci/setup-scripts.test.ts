// The two scripts that keep a slow mirror from turning a gate lane red: retry.sh runs a command up to three times, and
// setup-ast-grep.sh uses what the CI cache restored or else installs with those retries. Each runs here against stub tools
// that log every call, so no network is touched.
import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

const scripts = `${import.meta.dir}/../../../.github/scripts`;

type Outcome = Readonly<{ code: number | null; calls: readonly string[]; err: string }>;

// A directory of stub commands. Each logs "<name> <args>" to calls.log and exits with the code its `<name>.exit` file holds
// (default 0), once per call: `exits` lists the codes in the order the calls should return them, the last one repeating.
const stubbed = (exits: Readonly<Record<string, readonly number[]>>): string => {
  const dir = mkdtempSync(`${tmpdir()}/setup-stubs-`);
  ["pipx", "uv", "uvx", "ast-grep", "flaky"].forEach((name) => {
    writeFileSync(`${dir}/${name}.exit`, (exits[name] ?? [0]).join("\n"));
    writeFileSync(
      `${dir}/${name}`,
      `#!/usr/bin/env bash\necho "${name}\${*:+ $*}" >> "${dir}/calls.log"\nline=$(head -n 1 "${dir}/${name}.exit")\nrest=$(tail -n +2 "${dir}/${name}.exit")\n[ -n "$rest" ] && printf '%s\\n' "$rest" > "${dir}/${name}.exit"\nexit "$line"\n`,
    );
    chmodSync(`${dir}/${name}`, 0o755);
  });
  writeFileSync(`${dir}/calls.log`, "");
  return dir;
};

const run = (dir: string, script: string, args: readonly string[]): Outcome => {
  const done = Bun.spawnSync(["bash", `${scripts}/${script}`, ...args], { env: { PATH: `${dir}:/usr/bin:/bin`, RETRY_DELAY: "0", HOME: dir }, stdout: "pipe", stderr: "pipe" });
  return { code: done.exitCode, calls: readFileSync(`${dir}/calls.log`, "utf8").split("\n").filter((line) => line !== ""), err: done.stderr.toString() };
};

describe("retry.sh", () => {
  test("R-GATE-CI-SETUP-RETRY a command that fails once and then works is run twice and passes", () => {
    const outcome = run(stubbed({ flaky: [1, 0] }), "retry.sh", ["flaky", "a", "b"]);
    expect(outcome.code).toBe(0);
    expect(outcome.calls).toEqual(["flaky a b", "flaky a b"]);
  });

  test("R-GATE-CI-SETUP-RETRY a command that always fails is run three times, then fails and says so", () => {
    const outcome = run(stubbed({ flaky: [7] }), "retry.sh", ["flaky"]);
    expect(outcome.code).toBe(1);
    expect(outcome.calls).toHaveLength(3);
    expect(outcome.err).toContain("retry.sh: attempt 3 of 3 failed: flaky");
  });

  test("R-GATE-CI-SETUP-RETRY a command that works is run once", () => {
    const outcome = run(stubbed({}), "retry.sh", ["flaky"]);
    expect(outcome).toMatchObject({ code: 0, calls: ["flaky"] });
  });
});

describe("setup-ast-grep.sh", () => {
  const SPECS = ["uv==0.8.17", "ast-grep-cli==0.45.3"];

  test("R-GATE-CI-SETUP-RETRY what the cache restored is used: the pinned ast-grep answers offline, so nothing is installed", () => {
    const outcome = run(stubbed({}), "setup-ast-grep.sh", SPECS);
    expect(outcome.code).toBe(0);
    expect(outcome.calls).toEqual(["uvx --offline --from ast-grep-cli==0.45.3 ast-grep --version"]);
  });

  test("R-GATE-CI-SETUP-RETRY with nothing cached, uv and then ast-grep are installed at their pins and the result is checked", () => {
    const outcome = run(stubbed({ uvx: [1, 0] }), "setup-ast-grep.sh", SPECS);
    expect(outcome.code).toBe(0);
    expect(outcome.calls).toEqual([
      "uvx --offline --from ast-grep-cli==0.45.3 ast-grep --version",
      "pipx install --force uv==0.8.17",
      "uv tool install --force ast-grep-cli==0.45.3",
      "uvx --from ast-grep-cli==0.45.3 ast-grep --version",
    ]);
  });

  test("R-GATE-CI-SETUP-RETRY a download that times out once is retried, and the lane stays green", () => {
    const outcome = run(stubbed({ uvx: [1, 0], uv: [1, 0] }), "setup-ast-grep.sh", SPECS);
    expect(outcome.code).toBe(0);
    expect(outcome.calls.filter((call) => call.startsWith("uv tool install"))).toHaveLength(2);
  });

  test("R-GATE-CI-SETUP-RETRY a download that never works fails the step after three tries, and the check at the end does not run", () => {
    const outcome = run(stubbed({ uvx: [1], uv: [1] }), "setup-ast-grep.sh", SPECS);
    expect(outcome.code).not.toBe(0);
    expect(outcome.calls.filter((call) => call.startsWith("uv tool install"))).toHaveLength(3);
    expect(outcome.calls.filter((call) => call.startsWith("uvx "))).toHaveLength(1);
  });

  test("R-GATE-CI-SETUP-RETRY a pipx install that times out once is retried too", () => {
    const outcome = run(stubbed({ uvx: [1, 0], pipx: [1, 0] }), "setup-ast-grep.sh", SPECS);
    expect(outcome.code).toBe(0);
    expect(outcome.calls.filter((call) => call.startsWith("pipx install"))).toHaveLength(2);
  });

  test("R-GATE-CI-SETUP-RETRY a cache that restored uvx but not the ast-grep command, or the other way round, is not enough: it installs", () => {
    ["ast-grep", "uvx"].forEach((missing) => {
      const dir = stubbed({});
      rmSync(`${dir}/${missing}`);
      expect(run(dir, "setup-ast-grep.sh", SPECS).calls).toContain("uv tool install --force ast-grep-cli==0.45.3");
    });
  });

  test("R-GATE-CI-SETUP-RETRY the versions are arguments, so the workflow's pin is the only copy", () => {
    expect(run(stubbed({ uvx: [1, 0] }), "setup-ast-grep.sh", ["uv==9.9.9", "ast-grep-cli==9.9.8"]).calls).toContain("uv tool install --force ast-grep-cli==9.9.8");
    expect(run(stubbed({}), "setup-ast-grep.sh", [])).toMatchObject({ code: 1 });
  });
});
