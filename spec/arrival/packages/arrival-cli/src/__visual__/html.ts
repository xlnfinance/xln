/**
 * Cell grid → a terminal-shaped HTML page. Each glyph is one `1ch × 1lh` cell;
 * the paper is the theme bg, default ink is the theme fg. Open in any browser;
 * the same grid is what the SVG twin rasterizes.
 */
import { rgbCss, rgbHex, type Rgb, type Rows } from "./ansi-cells.js";

function esc(s: string): string {
  return s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

export function rowsToHtml(rows: Rows, paper: Rgb, ink: Rgb, title = "arrival"): string {
  const body = rows
    .map((row) => {
      const cells = row
        .map((c) => {
          const style = c.fg === undefined ? "" : ` style="color:${rgbCss(c.fg)}"`;
          return `<span class="cell"${style}>${esc(c.ch)}</span>`;
        })
        .join("");
      return `    <div class="row">${cells}</div>`;
    })
    .join("\n");

  return `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<title>${esc(title)}</title>
<style>
  html, body { margin: 0; background: ${rgbCss(paper)}; }
  .term {
    box-sizing: border-box;
    font-family: ui-monospace, "SF Mono", Menlo, "Cascadia Code", "DejaVu Sans Mono", monospace;
    font-size: 14px;
    line-height: 1.25;
    background: ${rgbCss(paper)};
    color: ${rgbCss(ink)};
    padding: 1lh 2ch;
    width: max-content;
  }
  .row { display: flex; height: 1lh; }
  .cell {
    display: block;
    width: 1ch;
    height: 1lh;
    white-space: pre;
  }
</style>
<body>
  <div class="term" data-paper="${rgbHex(paper)}" data-ink="${rgbHex(ink)}">
${body}
  </div>
</body>
</html>
`;
}
