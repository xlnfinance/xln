/**
 * The greeting's static screenshot artifact (arrival-repl-viral-research.md §1.2, §2.3):
 * a gradient-filled ASCII wordmark, Claude-Code/oh-my-logo style — the "identity shot"
 * genre the 2025-26 AI-CLI wave made the screenshot lingua franca for this category.
 * Composed, not busy: the wordmark IS the whole splash (the greeting's one identity
 * line rides alongside it in repl.ts, not here).
 *
 * A hand-rolled 6-row block font (D2's "no ink, no flexbox" posture applies here too —
 * this is data, not a dependency): only the five letters "arrival" needs (a, r, i, v,
 * l) are defined. The gradient sweeps left→right across two of Delta's OWN emphasis
 * hues (accent 211° → variant 285°, tints.ts's HUE table) — not an invented rainbow,
 * per D4's "derive from Delta" posture.
 */
import { colorMode, HUE, paintRgb, solveRgb, type ColorMode } from "./tints.js";

const GLYPH_HEIGHT = 6;

// prettier-ignore
const GLYPHS: Record<string, readonly string[]> = {
  a: [
    " ████ ",
    "██  ██",
    "██████",
    "██  ██",
    "██  ██",
    "██  ██",
  ],
  r: [
    "█████ ",
    "██  ██",
    "█████ ",
    "███   ",
    "██ ██ ",
    "██  ██",
  ],
  i: [
    "████",
    " ██ ",
    " ██ ",
    " ██ ",
    " ██ ",
    "████",
  ],
  v: [
    "██  ██",
    "██  ██",
    "██  ██",
    "██  ██",
    " ████ ",
    "  ██  ",
  ],
  l: [
    "██    ",
    "██    ",
    "██    ",
    "██    ",
    "██    ",
    "██████",
  ],
};

const GUTTER = " ";

/** The raw (uncolored) glyph grid for `word` — every character must be a defined
 *  glyph (the wordmark is a fixed word, "arrival", not general text rendering). */
function glyphRows(word: string): string[] {
  const letters = [...word].map((ch) => {
    const glyph = GLYPHS[ch];
    if (glyph === undefined) throw new Error(`wordmark: no glyph for ${JSON.stringify(ch)} (only a/r/i/v/l defined)`);
    return glyph;
  });
  const rows: string[] = [];
  for (let row = 0; row < GLYPH_HEIGHT; row++) {
    rows.push(letters.map((g) => g[row]).join(GUTTER));
  }
  return rows;
}

/** Paint one already-composed row with a left→right hue sweep, ONE truecolor/256 run
 *  per character (a run-length merge would shave escape-code bytes but this is a
 *  six-line, ~50-column splash printed once per session start — not a hot path). */
function paintRow(row: string, mode: ColorMode): string {
  if (mode === "none") return row;
  const width = row.length;
  let out = "";
  for (let i = 0; i < width; i++) {
    const ch = row[i] as string;
    if (ch === " ") {
      out += ch;
      continue;
    }
    const t = width <= 1 ? 0 : i / (width - 1);
    const hue = HUE.accent + t * (HUE.variant - HUE.accent);
    // Same differentiate-tier solve the rest of the palette uses, so the splash
    // tracks ground (a light terminal doesn't get a washed 0.72-L ribbon).
    const [r, g, b] = solveRgb(0.17, hue, "differentiate");
    out += paintRgb(ch, r, g, b, mode);
  }
  return out;
}

/** The wordmark's rendered lines — "arrival", gradient-tinted, ready to `console.log`
 *  one line per element. Callers compose it with the identity line (repl.ts). */
export function wordmark(mode: ColorMode = colorMode()): string[] {
  return glyphRows("arrival").map((row) => paintRow(row, mode));
}
