// run-outline — the first renderer over the run-view model. Assertions are on the stripped
// (uncolored) lines: the structure — glyph, head, ×N badge, location — is what matters; the
// exact hue is tints.ts's business, and identity-under-strip is the invariant.
import { describe, expect, it } from "vitest";

import { renderRunOutline } from "../run-outline.js";
import type { TemplateNode } from "../run-view.js";
import { stripAnsi } from "./ansi-strip.js";

const NODES: TemplateNode[] = [
  { scope: "map@1:0", head: "map", line: 1, col: 0, count: 1, state: "done" },
  { scope: "lambda@1:5", head: "lambda", line: 1, col: 5, count: 1, state: "done" },
  { scope: "*@1:17", head: "*", line: 1, col: 17, count: 6, state: "done" },
  { scope: "iota@1:26", head: "iota", line: 1, col: 26, count: 1, state: "done" },
];

describe("renderRunOutline", () => {
  it("empty in, empty out", () => {
    expect(renderRunOutline([])).toEqual([]);
  });

  it("one line per node, source order preserved", () => {
    const lines = renderRunOutline(NODES);
    expect(lines).toHaveLength(4);
    expect(stripAnsi(lines[0]!)).toContain("map");
    expect(stripAnsi(lines[2]!)).toContain("*");
  });

  it("shows ×N only when count > 1 (a form that ran once reads plain)", () => {
    const lines = renderRunOutline(NODES).map(stripAnsi);
    expect(lines[0]).not.toContain("×"); // map ran once
    expect(lines[2]).toContain("×6"); // the lambda body ran six times
  });

  it("includes the source location on every line", () => {
    const lines = renderRunOutline(NODES).map(stripAnsi);
    expect(lines[0]).toContain("1:0");
    expect(lines[2]).toContain("1:17");
  });

  it("uses ✗ for an error form and · for reached/unreached (color carries the rest)", () => {
    const err = renderRunOutline([{ scope: "/@1:0", head: "/", line: 1, col: 0, count: 1, state: "error" }]);
    expect(stripAnsi(err[0]!).startsWith("✗")).toBe(true);
    const ok = renderRunOutline([{ scope: "x@1:0", head: "x", line: 1, col: 0, count: 1, state: "done" }]);
    expect(stripAnsi(ok[0]!).startsWith("·")).toBe(true);
  });

  it("color mode adds only escapes — heads align by raw width, not colored width", () => {
    const colored = renderRunOutline(NODES, "truecolor");
    const plain = renderRunOutline(NODES, "none");
    expect(colored.map(stripAnsi)).toEqual(plain);
  });

  it("with a file and a colored mode, wraps the location in an OSC 8 hyperlink to file:line", () => {
    const lines = renderRunOutline(NODES, "truecolor", "/abs/example.scm");
    expect(lines[0]).toContain("file:///abs/example.scm:1");
    // the visible line:col text still reads fine once the CSI color escapes are stripped —
    // the OSC 8 wrapper doesn't touch the text it wraps.
    expect(stripAnsi(lines[0]!)).toContain("1:0");
  });

  it('`mode: "none"` stays byte-identical even when a file is given — no OSC 8 leaks into piped output', () => {
    const plain = renderRunOutline(NODES, "none");
    const withFile = renderRunOutline(NODES, "none", "/abs/example.scm");
    expect(withFile).toEqual(plain);
  });
});
