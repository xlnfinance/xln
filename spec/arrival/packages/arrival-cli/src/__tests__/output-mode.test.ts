// output-mode — the display boundary's POLICY resolver (format + whether to color),
// a pure function of (stdout-is-a-TTY, env, --json). No real terminal touched.
import { describe, expect, it } from "vitest";

import { resolveOutputMode } from "../output-mode.js";

describe("resolveOutputMode — format", () => {
  it("--json selects json, never colored (it's a payload, not a view)", () => {
    expect(resolveOutputMode({ stdoutIsTTY: true, env: {}, json: true })).toEqual({ format: "json", color: false });
  });

  it("default format is s-expr — machine output is opt-in, never pipe-triggered", () => {
    // Piped (not a TTY) still emits s-expr, NOT auto-JSON: the stdout contract holds.
    expect(resolveOutputMode({ stdoutIsTTY: false, env: {}, json: false }).format).toBe("sexpr");
  });
});

describe("resolveOutputMode — color", () => {
  it("colors s-expr when stdout is a TTY", () => {
    expect(resolveOutputMode({ stdoutIsTTY: true, env: {}, json: false }).color).toBe(true);
  });

  it("no color when piped — byte-identical to the pre-color output for `| jq` / `> file` / tests", () => {
    expect(resolveOutputMode({ stdoutIsTTY: false, env: {}, json: false }).color).toBe(false);
  });

  it("NO_COLOR disables color even on a TTY (https://no-color.org), regardless of value", () => {
    expect(resolveOutputMode({ stdoutIsTTY: true, env: { NO_COLOR: "" }, json: false }).color).toBe(false);
    expect(resolveOutputMode({ stdoutIsTTY: true, env: { NO_COLOR: "1" }, json: false }).color).toBe(false);
  });

  it("CLICOLOR_FORCE forces color back through a pipe", () => {
    expect(resolveOutputMode({ stdoutIsTTY: false, env: { CLICOLOR_FORCE: "1" }, json: false }).color).toBe(true);
  });

  it("CLICOLOR_FORCE=0 (or empty) is not a force", () => {
    expect(resolveOutputMode({ stdoutIsTTY: false, env: { CLICOLOR_FORCE: "0" }, json: false }).color).toBe(false);
    expect(resolveOutputMode({ stdoutIsTTY: false, env: { CLICOLOR_FORCE: "" }, json: false }).color).toBe(false);
  });

  it("NO_COLOR wins over CLICOLOR_FORCE (explicit off beats force)", () => {
    expect(
      resolveOutputMode({ stdoutIsTTY: false, env: { NO_COLOR: "1", CLICOLOR_FORCE: "1" }, json: false }).color,
    ).toBe(false);
  });

  it("TERM=dumb disables color on a TTY (but CLICOLOR_FORCE still overrides)", () => {
    expect(resolveOutputMode({ stdoutIsTTY: true, env: { TERM: "dumb" }, json: false }).color).toBe(false);
    expect(
      resolveOutputMode({ stdoutIsTTY: true, env: { TERM: "dumb", CLICOLOR_FORCE: "1" }, json: false }).color,
    ).toBe(true);
  });

  it("--json is never colored even on a forcing TTY", () => {
    expect(resolveOutputMode({ stdoutIsTTY: true, env: { CLICOLOR_FORCE: "1" }, json: true }).color).toBe(false);
  });
});
