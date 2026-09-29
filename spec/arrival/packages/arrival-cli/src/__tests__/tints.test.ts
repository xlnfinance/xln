// tints — depth ladder, H-K ground solve, chalk emission.
import { oklch } from "culori";
import { afterEach, describe, expect, it } from "vitest";

import {
  attuneFromProbe,
  canvasFromColorFgBg,
  colorMode,
  DARCULA,
  hueFactor,
  paint,
  paintHex,
  REFERENCE_CANVAS,
  REFERENCE_GROUND,
  setThemeCanvas,
  setThemeGround,
  solveLightness,
  solveRgb,
  streamColorMode,
  themeCanvas,
  themeGround,
  tintRgb,
} from "../tints.js";
import { stripAnsi } from "./ansi-strip.js";

/** 0–255 sRGB → OKLCH L. Culori takes 0–1 channels. */
function lightness(r: number, g: number, b: number): number {
  return oklch({ mode: "rgb", r: r / 255, g: g / 255, b: b / 255 })?.l ?? Number.NaN;
}

afterEach(() => {
  setThemeGround(REFERENCE_GROUND);
  setThemeCanvas(REFERENCE_CANVAS);
});

describe("colorMode", () => {
  it("NO_COLOR wins over everything (https://no-color.org)", () => {
    expect(colorMode({ NO_COLOR: "1", COLORTERM: "truecolor" })).toBe("none");
    expect(colorMode({ NO_COLOR: "", TERM: "xterm-256color" })).toBe("none");
  });

  it("TERM=dumb is no color (capability)", () => {
    expect(colorMode({ TERM: "dumb", COLORTERM: "truecolor" })).toBe("none");
  });

  it("COLORTERM=truecolor|24bit selects the truecolor rung", () => {
    expect(colorMode({ COLORTERM: "truecolor" })).toBe("truecolor");
    expect(colorMode({ COLORTERM: "24bit" })).toBe("truecolor");
  });

  it("TERM=*256color* without COLORTERM is 256, not a truecolor lie", () => {
    expect(colorMode({ TERM: "xterm-256color" })).toBe("256");
  });

  it("TERM=*truecolor*|*direct* is truecolor even without COLORTERM", () => {
    expect(colorMode({ TERM: "xterm-direct" })).toBe("truecolor");
  });

  it("iTerm.app and Windows Terminal are truecolor hosts", () => {
    expect(colorMode({ TERM_PROGRAM: "iTerm.app" })).toBe("truecolor");
    expect(colorMode({ WT_SESSION: "1" })).toBe("truecolor");
  });

  it("no COLORTERM / no 256 TERM under-claims 16 (never over-claims 256)", () => {
    expect(colorMode({})).toBe("16");
    expect(colorMode({ TERM: "xterm" })).toBe("16");
  });

  it("`force` pins the mode regardless of env — the tape-recording / test escape hatch", () => {
    expect(colorMode({ COLORTERM: "truecolor" }, "none")).toBe("none");
    expect(colorMode({ NO_COLOR: "1" }, "16")).toBe("16");
  });
});

describe("streamColorMode — policy", () => {
  it("piped (not a TTY) is none, unless CLICOLOR_FORCE", () => {
    expect(streamColorMode(false, { COLORTERM: "truecolor" })).toBe("none");
    expect(streamColorMode(false, { CLICOLOR_FORCE: "1", COLORTERM: "truecolor" })).toBe("truecolor");
  });

  it("NO_COLOR wins over CLICOLOR_FORCE", () => {
    expect(streamColorMode(false, { NO_COLOR: "1", CLICOLOR_FORCE: "1" })).toBe("none");
  });

  it("TERM=dumb on a TTY is none, unless CLICOLOR_FORCE (then 16, not truecolor)", () => {
    expect(streamColorMode(true, { TERM: "dumb" })).toBe("none");
    expect(streamColorMode(true, { TERM: "dumb", CLICOLOR_FORCE: "1" })).toBe("16");
  });

  it("TTY without extra env under-claims 16", () => {
    expect(streamColorMode(true, {})).toBe("16");
  });
});

describe("paint", () => {
  it("mode: none is the identity function", () => {
    expect(paint("hello", "error", "none")).toBe("hello");
  });

  it("emits a truecolor SGR open (chalk-rendered), stripping back to the original text", () => {
    const painted = paint("hello", "done", "truecolor");
    expect(painted).toMatch(/\x1b\[38;2;\d+;\d+;\d+mhello/); // chalk resets with \x1b[39m
    expect(stripAnsi(painted)).toBe("hello");
  });

  it("256 mode downsamples to the nearest-256 SGR form", () => {
    const painted = paint("hello", "done", "256");
    expect(painted).toMatch(/\x1b\[38;5;\d+mhello/);
    expect(stripAnsi(painted)).toBe("hello");
  });

  it("16 mode emits a basic/bright ANSI pin (hue-preserving, not nearest-RGB)", () => {
    const painted = paint("hello", "error", "16");
    // Bright red (91) on dark ground — NOT a yellow collapse of hue 35.
    expect(painted).toMatch(/\x1b\[91mhello/);
    expect(stripAnsi(painted)).toBe("hello");
  });

  it("different tints paint different colors (pending/dim vs error/danger are visually distinct)", () => {
    const pending = paint("x", "pending", "truecolor");
    const error = paint("x", "error", "truecolor");
    expect(pending).not.toBe(error);
  });

  it("paintHex is identity under none and strips back to the text", () => {
    expect(paintHex("ab", "#728e60", "none")).toBe("ab");
    expect(stripAnsi(paintHex("ab", "#728e60", "truecolor"))).toBe("ab");
  });
});

describe("H-K salience", () => {
  it("hueFactor is in the Nayatani range ~[0.54, 0.92]", () => {
    for (const h of [0, 25, 57, 134, 211, 285, 359]) {
      const f = hueFactor(h);
      expect(f).toBeGreaterThan(0.5);
      expect(f).toBeLessThan(1);
    }
  });

  it("chromatic L sits below achromatic L at the same target AL (H-K compensation)", () => {
    const chromatic = solveLightness(0.7, 0.15, 35);
    const gray = solveLightness(0.7, 0, 0);
    expect(chromatic).toBeLessThan(gray);
    expect(gray).toBeCloseTo(0.7, 5);
  });

  it("light ground solves tints darker than dark ground (polarity auto)", () => {
    setThemeCanvas({ ground: { l: 0.2, c: 0, h: 0 } });
    const [, , bDark] = solveRgb(0.15, 35, "alarm");
    const darkL = lightness(...solveRgb(0.15, 35, "alarm"));
    setThemeCanvas({ ground: { l: 0.85, c: 0, h: 0 } });
    const lightL = lightness(...solveRgb(0.15, 35, "alarm"));
    expect(lightL).toBeLessThan(darkL);
    expect(bDark).toBeGreaterThanOrEqual(0);
  });
});

describe("canvas attunement — ink + paper", () => {
  it("without fg, recede is the paper at recede AL (tinted dim, not a foreign gray)", () => {
    setThemeCanvas({ ground: { l: 0.2, c: 0.08, h: 200 } });
    const [r, g, b] = solveRgb(0, 0, "recede");
    const o = oklch({ mode: "rgb", r: r / 255, g: g / 255, b: b / 255 });
    expect(o?.h ?? 0).toBeGreaterThan(180);
    expect(o?.h ?? 0).toBeLessThan(220);
    expect(o?.c ?? 0).toBeGreaterThan(0.02);
  });

  it("an achromatic ground leaves recede gray", () => {
    setThemeCanvas({ ground: { l: 0.2, c: 0, h: 0 } });
    const [r, g, b] = solveRgb(0, 0, "recede");
    expect(oklch({ mode: "rgb", r: r / 255, g: g / 255, b: b / 255 })?.c ?? 0).toBeLessThan(0.02);
  });

  it("with fg, recede is their ink faded toward the paper (hue between them)", () => {
    setThemeCanvas({
      ground: { l: 0.2, c: 0.08, h: 200 },
      fg: { l: 0.78, c: 0.04, h: 80 },
    });
    const [r, g, b] = solveRgb(0, 0, "recede");
    const h = oklch({ mode: "rgb", r: r / 255, g: g / 255, b: b / 255 })?.h ?? 0;
    expect(h).toBeGreaterThan(80);
    expect(h).toBeLessThan(200);
  });

  it("fg apparent lightness becomes the native text brightness for differentiate", () => {
    setThemeCanvas({
      ground: { l: 0.2, c: 0, h: 0 },
      fg: { l: 0.78, c: 0.02, h: 250 },
    });
    const al = lightness(...solveRgb(0.08, 142, "differentiate"));
    expect(al).toBeGreaterThan(0.65);
    expect(al).toBeLessThan(0.82);
  });

  it("error on a teal paper is not unique-red — hue stains toward the paper", () => {
    setThemeCanvas({ ground: { l: 0.2, c: 0, h: 0 }, fg: { l: 0.75, c: 0.02, h: 250 } });
    const [r0, g0, b0] = solveRgb(0.15, 35, "alarm");
    const h0 = oklch({ mode: "rgb", r: r0 / 255, g: g0 / 255, b: b0 / 255 })?.h ?? 35;
    setThemeCanvas({
      ground: { l: 0.2, c: 0.1, h: 200 },
      fg: { l: 0.75, c: 0.02, h: 250 },
    });
    const [r1, g1, b1] = solveRgb(0.15, 35, "alarm");
    const h1 = oklch({ mode: "rgb", r: r1 / 255, g: g1 / 255, b: b1 / 255 })?.h ?? 35;
    // stained toward 200° — still in the warm family, not unique-red
    expect(h1).toBeGreaterThan(h0);
    expect(h1).toBeLessThan(120);
  });

  it("paintHex symbol with a probed fg sits at the native ink, not Darcula gray-blue", () => {
    setThemeCanvas({
      ground: { l: 0.2, c: 0.04, h: 200 },
      fg: { l: 0.8, c: 0.03, h: 90 },
    });
    const painted = paintHex("x", DARCULA.symbol, "truecolor");
    const m = /\x1b\[38;2;(\d+);(\d+);(\d+)m/.exec(painted);
    expect(m).not.toBeNull();
    const h =
      oklch({
        mode: "rgb",
        r: Number(m![1]) / 255,
        g: Number(m![2]) / 255,
        b: Number(m![3]) / 255,
      })?.h ?? 0;
    expect(h).toBeGreaterThan(50);
    expect(h).toBeLessThan(130);
  });

  it("attuneFromProbe ignores an fg that does not contrast with ground", () => {
    attuneFromProbe({
      bg: { r: 30, g: 30, b: 30 },
      fg: { r: 32, g: 32, b: 32 },
    });
    expect(themeCanvas().fg).toBeUndefined();
  });

  it("attuneFromProbe keeps a solarized-style teal ground tint", () => {
    attuneFromProbe({ bg: { r: 0, g: 43, b: 54 } });
    expect(themeCanvas().ground.c).toBeGreaterThan(0.03);
    expect(themeCanvas().ground.h).toBeGreaterThan(180);
    expect(themeCanvas().ground.h).toBeLessThan(250);
  });

  it("COLORFGBG=15;0 is white ink on black paper", () => {
    const c = canvasFromColorFgBg({ COLORFGBG: "15;0" });
    expect(c.fg).toEqual({ r: 255, g: 255, b: 255 });
    expect(c.bg).toEqual({ r: 0, g: 0, b: 0 });
  });
});

describe("oklch ↔ sRGB round-trip", () => {
  it("recovers L of a near-gray within a few percent (integer 8-bit rounding)", () => {
    const [r, g, b] = tintRgb(0.55, 0, 0);
    const back = oklch({ mode: "rgb", r: r / 255, g: g / 255, b: b / 255 });
    expect(back?.l).toBeCloseTo(0.55, 1);
    expect(back?.c ?? 0).toBeLessThan(0.02);
  });
});

describe("themeGround", () => {
  it("defaults to the dark reference and clamps", () => {
    expect(themeGround()).toBe(REFERENCE_GROUND);
    setThemeGround(2);
    expect(themeGround()).toBeLessThanOrEqual(0.97);
    setThemeGround(-1);
    expect(themeGround()).toBeGreaterThanOrEqual(0.03);
  });
});
