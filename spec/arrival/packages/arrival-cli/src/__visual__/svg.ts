/**
 * Cell grid → SVG twin of the HTML page. Layout is explicit px (resvg has no
 * CSS `ch`/`lh` engine); the HTML keeps 1ch×1lh. FONT_PX * 0.6 / 1.25 matches
 * a typical monospace em-box closely enough for a quasi-screenshot.
 */
import { rgbCss, type Rgb, type Rows } from "./ansi-cells.js";

export const FONT_PX = 14;
export const CH_PX = FONT_PX * 0.6;
export const LH_PX = FONT_PX * 1.25;
const PAD_X = CH_PX * 2;
const PAD_Y = LH_PX;

function esc(s: string): string {
  return s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

export function rowsToSvg(rows: Rows, paper: Rgb, ink: Rgb): string {
  const cols = rows[0]?.length ?? 0;
  const width = Math.ceil(PAD_X * 2 + cols * CH_PX);
  const height = Math.ceil(PAD_Y * 2 + rows.length * LH_PX);
  const spans: string[] = [];
  rows.forEach((row, y) => {
    row.forEach((c, x) => {
      if (c.ch === " " && c.fg === undefined) return;
      const fill = c.fg === undefined ? rgbCss(ink) : rgbCss(c.fg);
      const tx = (PAD_X + x * CH_PX).toFixed(1);
      const ty = (PAD_Y + (y + 0.8) * LH_PX).toFixed(1);
      spans.push(`<text x="${tx}" y="${ty}" fill="${fill}">${esc(c.ch === " " ? "\u00a0" : c.ch)}</text>`);
    });
  });
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <rect width="100%" height="100%" fill="${rgbCss(paper)}"/>
  <g font-family="Menlo, Monaco, 'DejaVu Sans Mono', 'Courier New', monospace" font-size="${FONT_PX}px">
    ${spans.join("\n    ")}
  </g>
</svg>
`;
}
