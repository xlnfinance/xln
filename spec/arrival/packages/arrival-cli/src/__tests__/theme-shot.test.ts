// theme-shot — cell IR, 1ch×1lh HTML, ANSI truecolor parse. No rasterizer.
import { afterEach, describe, expect, it } from "vitest";

import { REFERENCE_GROUND, setThemeCanvas } from "../tints.js";
import { ansiLinesToRows, ansiToCells } from "../__visual__/ansi-cells.js";
import { sampleFrame } from "../__visual__/frame.js";
import { rowsToHtml } from "../__visual__/html.js";
import { THEMES } from "../__visual__/themes.js";

afterEach(() => {
  setThemeCanvas({ ground: { l: REFERENCE_GROUND, c: 0, h: 0 } });
});

describe("ansiToCells", () => {
  it("keeps plain text as one cell per code point", () => {
    expect(ansiToCells("ab")).toEqual([
      { ch: "a", fg: undefined },
      { ch: "b", fg: undefined },
    ]);
  });

  it("attaches chalk truecolor SGR to the following run", () => {
    const cells = ansiToCells("\x1b[38;2;10;20;30mX\x1b[39mY");
    expect(cells[0]).toEqual({ ch: "X", fg: { r: 10, g: 20, b: 30 } });
    expect(cells[1]).toEqual({ ch: "Y", fg: undefined });
  });
});

describe("rowsToHtml", () => {
  it("emits 1ch×1lh cells and the paper/ink as data attributes", () => {
    const html = rowsToHtml(
      [[{ ch: "a", fg: { r: 1, g: 2, b: 3 } }]],
      { r: 0, g: 43, b: 54 },
      { r: 131, g: 148, b: 150 },
    );
    expect(html).toContain("width: 1ch");
    expect(html).toContain("height: 1lh");
    expect(html).toContain('data-paper="#002b36"');
    expect(html).toContain("rgb(1, 2, 3)");
  });
});

describe("sampleFrame", () => {
  it("paints a non-empty frame whose stripped text still contains arrival + an error door", () => {
    const { stripAnsi } = { stripAnsi: (s: string) => s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "") };
    const theme = THEMES[1]!; // solarized-dark
    const text = sampleFrame(theme.bg, theme.fg).map(stripAnsi).join("\n");
    expect(text).toContain("arrival");
    expect(text).toContain("fliter");
    expect(text).toContain("square");
  });

  it("two papers produce different truecolor bytes (the solver is canvas-live)", () => {
    const dark = sampleFrame(THEMES[0]!.bg, THEMES[0]!.fg).join("\n");
    const light = sampleFrame(THEMES[2]!.bg, THEMES[2]!.fg).join("\n");
    expect(dark).not.toBe(light);
    expect(dark).toContain("\x1b[38;2;");
    expect(ansiLinesToRows(sampleFrame(THEMES[0]!.bg, THEMES[0]!.fg)).length).toBeGreaterThan(8);
  });
});
