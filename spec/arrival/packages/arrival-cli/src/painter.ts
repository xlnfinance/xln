/**
 * The ANSI painter — the FIRST renderer over the headless core (D6): a pure
 * `view(blocks, lens) → lines[]` plus one small stateful helper (`paintRegion`) that
 * repaints a just-submitted turn's region in place as its `ReplBlock`s settle
 * (pending → running → done/error/skipped, mcp-substrate's repl-fold.ts).
 *
 * SCOPE OF REPAINT (intentional cut): only the CURRENT turn's
 * region is repainted in place (cursor-up + clear-to-end + rewrite) as its own events
 * land — a handful of lines, imperceptible to redraw whole. Once a turn's last event
 * lands, its lines are frozen scrollback; the painter never touches them again ("settled
 * blocks never repaint" — repl-fold.ts's own invariant, mirrored at the render layer).
 * `,lens` (repl.ts) doesn't try to cursor-up over unknown, possibly-scrolled-off
 * history — it CLEARS the screen and replays the full turn history through the other
 * lens, which is also the doc's "before/after pair" screenshot (arrival-repl-viral-
 * research.md §2 point 5).
 *
 * NOT built (the explicit cut): a sub-block spinner/pulse animation ticking while a
 * single form is mid-flight. Local scheme evals settle in low-single-digit
 * milliseconds, so the "running" tint is real (the fold asserts it) but usually
 * invisible for a beat — the motion that DOES read in the demo is the per-EVENT
 * cascade across a multi-form submission (three forms settling in sequence is three
 * repaints, not one final frame). See demo.tape's timing notes for how this reads on
 * camera.
 */
import type { ReplBlock, ReplBlockState } from "./repl-model/repl-fold.js";

import { CARRIAGE_RETURN, CLEAR_TO_END, cursorUp } from "./ansi.js";
import { paint, type TintName } from "./tints.js";
import { toLens, type Lens } from "./lens.js";

const GLYPH: Record<ReplBlockState, string> = {
  pending: "·",
  running: "▸",
  done: "✓",
  error: "✗",
  skipped: "·",
};

const TINT: Record<ReplBlockState, TintName> = {
  pending: "pending",
  running: "running",
  done: "done",
  error: "error",
  skipped: "skipped",
};

/** One block's lines, through `lens`. The source line always renders (even `pending` —
 *  §5's "immediately paint every form as a block" so perceived latency collapses before
 *  any output exists); content/counters only once the statement event has landed. */
export function renderBlock(block: ReplBlock, lens: Lens): string[] {
  const glyph = paint(GLYPH[block.state], TINT[block.state]);
  const sourceText = block.source === "" ? "" : toLens(block.source, lens);
  const sourceLines = sourceText.split("\n");
  const lines: string[] = [`${glyph} ${paint(sourceLines[0] ?? "", TINT[block.state])}`];
  for (const rest of sourceLines.slice(1)) lines.push(`  ${paint(rest, TINT[block.state])}`);

  if (block.state === "skipped") {
    lines.push(paint("  (skipped — an earlier form in this submission crashed)", "skipped"));
    return lines;
  }
  for (const c of block.content) {
    if (c.type !== "text") continue; // text only (D8: no inline images)
    for (const line of toLens(c.text, lens).split("\n")) {
      lines.push(`  ${paint(line, block.state === "error" ? "error" : "done")}`);
    }
  }
  if (block.counters !== undefined && (block.state === "done" || block.state === "error")) {
    const { elapsedMs } = block.counters;
    lines.push(paint(`  ${elapsedMs}ms`, "gutter"));
  }
  return lines;
}

/** A submission's full block list, blank-line separated — one "turn". */
export function renderTurn(blocks: readonly ReplBlock[], lens: Lens): string[] {
  const out: string[] = [];
  blocks.forEach((b, i) => {
    if (i > 0) out.push("");
    out.push(...renderBlock(b, lens));
  });
  return out;
}

/** The one method `paintRegion` needs — `process.stdout` satisfies this structurally
 *  (its `write` returns `boolean`, which a `void`-returning call site accepts), so
 *  passing it as the default needs no cast; a test can hand a plain `{ write }` object
 *  with the same honesty. */
export interface Writer {
  write(chunk: string): void;
}

/** Repaint a turn's region in place: cursor up over the `prevLineCount` lines this
 *  turn last occupied, clear to end of screen, rewrite. Returns the new line count —
 *  thread it back in as `prevLineCount` on the next call for the SAME turn. */
export function paintRegion(lines: readonly string[], prevLineCount: number, out: Writer = process.stdout): number {
  out.write(cursorUp(prevLineCount) + CARRIAGE_RETURN + CLEAR_TO_END);
  if (lines.length > 0) out.write(`${lines.join("\n")}\n`);
  return lines.length;
}
