/**
 * The first renderer over the run-view nav model (run-view.ts): a source-ordered outline
 * of the forms a run touched, each with its aggregated state and — the whole point — its
 * invocation `×N` multiplicity. This is "tint as a view over the model": the model owns
 * the 1:N truth, the renderer just shows it.
 *
 * SUBTLE by the scrub-widget bar: the state is carried by the glyph's COLOR, not by a loud
 * column of checkmarks. Reached-and-settled forms are a quiet green dot; not-yet-reached a
 * dim gray dot; running the one arrow; only an error escalates to `✗`, because an error is
 * the thing you actually want your eye to catch. The `×N` badge appears only when a form
 * ran more than once — a form that ran once reads as plain; `if ×177` announces "there's a
 * dynamic tree behind me, poke it."
 *
 * Pure: `renderRunOutline(nodes, mode) → lines[]`. `mode "none"` is uncolored (the test /
 * pipe path); a color mode tints. Tests assert on the stripped lines.
 */
import { fileUrl, hyperlink } from "./osc.js";
import type { TemplateNode, TemplateState } from "./run-view.js";
import { paint, type TintName, type colorMode } from "./tints.js";

type ColorMode = ReturnType<typeof colorMode>;

/** One quiet dot for every reached state (color carries the meaning); `✗` for error so it
 *  breaks the column and catches the eye; `▸` for the one in-flight form. */
const GLYPH: Record<TemplateState, string> = {
  unreached: "·",
  running: "▸",
  done: "·",
  error: "✗",
};

const TINT: Record<TemplateState, TintName> = {
  unreached: "pending",
  running: "running",
  done: "done",
  error: "error",
};

function tint(text: string, name: TintName, mode: ColorMode): string {
  return mode === "none" ? text : paint(text, name, mode);
}

/** Render the outline. `mode` defaults to `"none"` (uncolored) — the caller passes a live
 *  color mode when a human is looking. Head and count columns are width-aligned (padding
 *  the RAW string, not the colored one, so escape bytes never throw off the column) so the
 *  dim locations form a clean right rail. `file` (the run's absolute source path, when known)
 *  wraps each location in an OSC 8 hyperlink to `file:line` — editor-aware terminals make it
 *  clickable. Gated on a live color mode too: a piped/`none` run stays byte-identical, never
 *  leaking escape bytes into output a script might parse. */
export function renderRunOutline(nodes: readonly TemplateNode[], mode: ColorMode = "none", file?: string): string[] {
  if (nodes.length === 0) return [];
  const headWidth = Math.max(...nodes.map((n) => n.head.length));
  const countStrs = nodes.map((n) => (n.count > 1 ? `×${n.count}` : ""));
  const countWidth = Math.max(0, ...countStrs.map((s) => s.length));
  return nodes.map((n, i) => {
    const glyph = tint(GLYPH[n.state], TINT[n.state], mode);
    const head = tint(n.head.padEnd(headWidth), TINT[n.state], mode);
    const raw = countStrs[i]!;
    const count = (raw === "" ? "" : tint(raw, "accent", mode)) + " ".repeat(countWidth - raw.length);
    const locText = tint(`${n.line}:${n.col}`, "gutter", mode);
    const loc = file !== undefined && mode !== "none" ? hyperlink(fileUrl(file, n.line), locText) : locText;
    // glyph  head   ×N     line:col  — count aligned, location dim on the right rail.
    return `${glyph} ${head}  ${count}  ${loc}`;
  });
}
