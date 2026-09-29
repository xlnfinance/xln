// wordmark — the greeting's static screenshot artifact (arrival-repl-viral-research.md
// §1.2). `mode: "none"` gives the deterministic plain-text art (an exact-match
// assertion is legitimate there — it's fixed glyph data, not a rendering computation
// that should be free to change); truecolor/256 modes are checked by stripping and
// diffing against the SAME plain art, so the projection math can be retuned without
// breaking this suite for no behavioral reason.
import { describe, expect, it } from "vitest";

import { wordmark } from "../wordmark.js";
import { stripAnsi } from "./ansi-strip.js";

const PLAIN = [
  " ████  █████  █████  ████ ██  ██  ████  ██    ",
  "██  ██ ██  ██ ██  ██  ██  ██  ██ ██  ██ ██    ",
  "██████ █████  █████   ██  ██  ██ ██████ ██    ",
  "██  ██ ███    ███     ██  ██  ██ ██  ██ ██    ",
  "██  ██ ██ ██  ██ ██   ██   ████  ██  ██ ██    ",
  "██  ██ ██  ██ ██  ██ ████   ██   ██  ██ ██████",
];

describe("wordmark", () => {
  it("renders six rows of block-art spelling ARRIVAL, uncolored (mode: none)", () => {
    expect(wordmark("none")).toEqual(PLAIN);
  });

  it("truecolor mode paints every non-space glyph cell — stripped text is unchanged", () => {
    const rows = wordmark("truecolor");
    expect(rows.map(stripAnsi)).toEqual(PLAIN);
    // At least one row actually carries color codes — a silently-uncolored wordmark
    // would still pass the stripped-text check above, so this is the load-bearing half.
    expect(rows.some((r) => r.includes("\x1b[38;2;"))).toBe(true);
  });

  it("256 mode also round-trips to the same plain art, via the nearest-256 fallback (D4)", () => {
    const rows = wordmark("256");
    expect(rows.map(stripAnsi)).toEqual(PLAIN);
    expect(rows.some((r) => r.includes("\x1b[38;5;"))).toBe(true);
  });

  it("16 mode round-trips to the same plain art through chalk's basic rung", () => {
    const rows = wordmark("16");
    expect(rows.map(stripAnsi)).toEqual(PLAIN);
    expect(rows.some((r) => r.includes("\x1b["))).toBe(true);
  });

  it("the gradient sweeps hue left→right — first and last painted glyph differ in color", () => {
    const [row] = wordmark("truecolor");
    const codes = [...(row ?? "").matchAll(/\x1b\[38;2;(\d+);(\d+);(\d+)m/g)];
    expect(codes.length).toBeGreaterThan(1);
    expect(codes[0]?.[0]).not.toBe(codes.at(-1)?.[0]);
  });
});
