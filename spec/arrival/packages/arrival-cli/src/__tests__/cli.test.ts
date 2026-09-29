/**
 * The suite exercises the REAL bin — `node dist/cli.js` (built by vitest.global-setup)
 * spawned over fixture programs — because the CLI's contract IS its process surface:
 * argv, stdin, stdout/stderr split, exit codes.
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const CLI = fileURLToPath(new URL("../../dist/cli.js", import.meta.url));
const fixture = (name: string): string => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));

function arrival(args: string[], stdin?: string): { code: number | null; stdout: string; stderr: string } {
  const res = spawnSync(process.execPath, [CLI, ...args], {
    input: stdin,
    encoding: "utf8",
    timeout: 90_000,
    cwd: path.dirname(CLI),
  });
  if (res.error) throw res.error;
  return { code: res.status, stdout: res.stdout, stderr: res.stderr };
}

describe("arrival run", () => {
  it("happy path: prints one value per top-level form (defines silent), exit 0", () => {
    const { code, stdout, stderr } = arrival(["run", fixture("ok.scm")]);
    expect(stderr).toBe("");
    expect(code).toBe(0);
    expect(stdout.trim()).toBe("42");
  });

  it("unbound symbol: the complete static diagnostic list on stderr, nothing evaluated, exit 1", () => {
    const { code, stdout, stderr } = arrival(["run", fixture("unbound.scm")]);
    expect(code).toBe(1);
    expect(stdout).toBe("");
    expect(stderr).toContain("frobnicate");
    // cascade fusion: ONE cause, BOTH reference sites (line:col, 0-based cols)
    expect(stderr).toContain("1:17");
    expect(stderr).toContain("2:0");
    expect(stderr).not.toMatch(/\n\s+at /); // teaching text, never a stack trace
  });

  it("(require …) resolves relative to the entry file's dir", () => {
    const { code, stdout } = arrival(["run", fixture("with-require/main.scm")]);
    expect(code).toBe(0);
    expect(stdout).toContain("hello, world");
  });

  it("missing file: teaching message, exit 1", () => {
    const { code, stderr } = arrival(["run", fixture("nope.scm")]);
    expect(code).toBe(1);
    expect(stderr).toContain("cannot read");
  });

  it("extra positional files: hard usage error (never silently ignored), exit 2", () => {
    const { code, stderr } = arrival(["run", fixture("ok.scm"), fixture("ok.scm")]);
    expect(code).toBe(2);
    expect(stderr).toContain("exactly ONE");
  });
});

describe("arrival check", () => {
  it("clean program: ok, exit 0", () => {
    const { code, stdout } = arrival(["check", fixture("ok.scm")]);
    expect(code).toBe(0);
    expect(stdout).toContain("ok");
  });

  it("unbound symbol: complete diagnostics on stdout, exit 1", () => {
    const { code, stdout } = arrival(["check", fixture("unbound.scm")]);
    expect(code).toBe(1);
    expect(stdout).toContain("frobnicate");
    expect(stdout).toMatch(/error/i);
  });

  it("multiple files: EVERY file is checked, per-file output, exit 0 only when all pass", () => {
    const { code, stdout } = arrival(["check", fixture("ok.scm"), fixture("ok.scm")]);
    expect(code).toBe(0);
    expect(stdout.match(/: ok/g)).toHaveLength(2);
  });

  it("multiple files: a failure in a LATER file is reported and fails the run (the silent-drop bug)", () => {
    const { code, stdout } = arrival(["check", fixture("ok.scm"), fixture("unbound.scm")]);
    expect(code).toBe(1);
    expect(stdout).toContain("ok.scm: ok"); // the first file was checked and reported
    expect(stdout).toContain("unbound.scm:"); // the second file was NOT silently dropped
    expect(stdout).toContain("frobnicate");
  });

  it("multiple files: a failure in an EARLIER file doesn't stop later files (complete list, worst exit)", () => {
    const { code, stdout } = arrival(["check", fixture("unbound.scm"), fixture("ok.scm")]);
    expect(code).toBe(1);
    expect(stdout).toContain("frobnicate");
    expect(stdout).toContain("ok.scm: ok");
  });
});

describe("arrival repl", () => {
  it("persists defines across lines", () => {
    const { code, stdout } = arrival(["repl"], "(define x 21)\n(* x 2)\n");
    expect(code).toBe(0);
    expect(stdout.trim()).toBe("42");
  });

  it("continues a structurally open form across lines (paren balance via the oracle scanner)", () => {
    const { code, stdout } = arrival(["repl"], "(define (f y)\n  (* y 3))\n(f 14)\n");
    expect(code).toBe(0);
    expect(stdout.trim()).toBe("42");
  });

  it("survives an error: teaching door on stderr, session scope intact", () => {
    const { code, stdout, stderr } = arrival(["repl"], "(define x 5)\n(nope)\n(+ x 2)\n");
    expect(code).toBe(0);
    expect(stderr).toContain("nope");
    expect(stderr).not.toMatch(/\n\s+at /);
    expect(stdout.trim()).toBe("7");
  });
});

describe("capability arming (--with / config file)", () => {
  const greetCap = fixture("caps/greet.mjs");

  it("run --with <path>: the module's EnvCapability exports are armed, its verb executes", () => {
    const { code, stdout, stderr } = arrival(["run", "--with", greetCap, fixture("uses-greet.scm")]);
    expect(stderr).toBe("");
    expect(code).toBe(0);
    expect(stdout).toContain("hello, world");
  });

  it("check --with <path>: armed symbols join the validation vocabulary", () => {
    const { code, stdout } = arrival(["check", "--with", greetCap, fixture("uses-greet.scm")]);
    expect(code).toBe(0);
    expect(stdout).toContain("ok");
  });

  it("repl --with <path>: the session ambient carries the armed verb", () => {
    const { code, stdout } = arrival(["repl", "--with", greetCap], "(greet)\n");
    expect(code).toBe(0);
    expect(stdout).toContain("hello, world");
  });

  it("unarmed: the same program fails validation with the standard unbound diagnostic", () => {
    const { code, stdout } = arrival(["check", fixture("uses-greet.scm")]);
    expect(code).toBe(1);
    expect(stdout).toMatch(/unbound symbol `greet`/i);
  });

  it("non-capability module: teaching error naming what was found and what was expected", () => {
    const { code, stderr } = arrival([
      "run",
      "--with",
      fixture("caps/not-a-capability.mjs"),
      fixture("uses-greet.scm"),
    ]);
    expect(code).toBe(1);
    expect(stderr).toContain("not a capability module");
    expect(stderr).toContain("default (function)");
    expect(stderr).toContain("helper (number)");
    expect(stderr).toContain("EnvCapability");
  });

  it("--config <file>: config-file arming, per-capability config slice reaches the capability", () => {
    const { code, stdout, stderr } = arrival([
      "run",
      "--config",
      fixture("config-armed/arrival.config.json"),
      fixture("uses-config-greet.scm"),
    ]);
    expect(stderr).toBe("");
    expect(code).toBe(0);
    expect(stdout).toContain("hello, from-config-file");
  });

  it("arrival.config.json auto-discovers from cwd", () => {
    const res = spawnSync(process.execPath, [CLI, "run", fixture("uses-config-greet.scm")], {
      encoding: "utf8",
      timeout: 90_000,
      cwd: fixture("config-armed"),
    });
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("hello, from-config-file");
  });

  it("arrival.config.ts loads via native type stripping (node ≥ 22.18)", () => {
    const res = spawnSync(process.execPath, [CLI, "run", fixture("uses-config-greet.scm")], {
      encoding: "utf8",
      timeout: 90_000,
      cwd: fixture("config-ts"),
    });
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("hello, from-ts-config");
  });

  it("config-listed capability missing its enabling key: the degradation door's causal diagnostic", () => {
    const { code, stdout } = arrival([
      "check",
      "--config",
      fixture("config-degraded/arrival.config.json"),
      fixture("uses-config-greet.scm"),
    ]);
    expect(code).toBe(1);
    // Bucket c (missing-configuration): reference → door → owner → missing key, with the cure.
    expect(stdout).toContain("Configuration key `greeting`");
    expect(stdout).toContain("greet/configured @ fixture/config-greet");
    expect(stdout).toContain("Provide `greeting` to enable it");
  });
});

describe("arrival (dispatch)", () => {
  it("no command: usage on stderr, exit 2", () => {
    const { code, stderr } = arrival([]);
    expect(code).toBe(2);
    expect(stderr).toContain("usage: arrival");
  });

  it("unknown command: usage on stderr, exit 2", () => {
    const { code, stderr } = arrival(["frobnicate"]);
    expect(code).toBe(2);
    expect(stderr).toContain("unknown command");
  });
});
