/**
 * One representative arrival frame as ANSI lines, through the live canvas.
 * Glyph + highlighted source + colored value — the Ink TUI's shape, flattened
 * to lines so the shot path never needs a TTY.
 */
import { greetingLines } from "../greeting.js";
import { QUOTES } from "../quotes.js";
import { highlightScheme } from "../highlight.js";
import { colorizeSexpr } from "../sexpr-color.js";
import { paintDiagnostic } from "../session.js";
import { attuneFromProbe, paint, REFERENCE_GROUND, setThemeCanvas, type ColorMode } from "../tints.js";
import type { Rgb } from "./ansi-cells.js";

const MODE: ColorMode = "truecolor";

function block(state: "done" | "error" | "skipped" | "pending" | "running", source: string, value?: string): string[] {
  const glyph = { pending: "·", running: "▸", done: "✓", error: "✗", skipped: "·" }[state];
  const tint = state === "skipped" ? "skipped" : state === "pending" ? "pending" : state;
  const lines = [`${paint(glyph, tint, MODE)} ${highlightScheme(source, MODE)}`];
  if (state === "skipped") {
    lines.push(paint("  (skipped — an earlier form in this submission crashed)", "skipped", MODE));
    return lines;
  }
  if (value !== undefined) {
    const body = state === "error" ? paint(value, "error", MODE) : colorizeSexpr(value, MODE);
    for (const line of body.split("\n")) lines.push(`  ${line}`);
  }
  if (state === "done" || state === "error") lines.push(paint("  3ms", "gutter", MODE));
  return lines;
}

/** Paint the sample frame under this paper/ink. Restores the dark reference after. */
export function sampleFrame(paper: Rgb, ink: Rgb): string[] {
  attuneFromProbe({ bg: paper, fg: ink });
  const lines = [
    ...greetingLines({ version: "0.9.0", capabilityCount: 0, lens: "sugarcoat" }, MODE, {
      kind: "quote",
      quote: QUOTES[17],
      width: 72,
    }),
    "",
    ...block("done", "(define (square n) (* n n))"),
    "",
    ...block("done", "(map square (list 1 2 3))", "(list 1 4 9)"),
    "",
    ...block(
      "error",
      "(fliter even? xs)",
      paintDiagnostic(
        {
          severity: "error",
          code: "unbound-symbol",
          sites: [],
          message: "Unbound symbol `fliter` Referenced at 1:0 — this program would crash there.",
          publicMessage: "Unbound symbol `fliter`",
          suggestions: ["filter"],
        },
        MODE,
      ),
    ),
    "",
    ...block("skipped", "(map square xs)"),
  ];
  setThemeCanvas({ ground: { l: REFERENCE_GROUND, c: 0, h: 0 } });
  return lines;
}
