/**
 * bg/fg → HTML (1ch×1lh cells) + SVG twin + optional PNG.
 *
 *   pnpm --filter @inhuman.tools/arrival-cli shot
 *
 * Writes src/__visual__/out/<theme>.{html,svg,png} and an index.html gallery.
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { ansiLinesToRows } from "./ansi-cells.js";
import { sampleFrame } from "./frame.js";
import { rowsToHtml } from "./html.js";
import { svgToPng } from "./render.js";
import { rowsToSvg } from "./svg.js";
import { THEMES } from "./themes.js";

const OUT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "out");

async function main(): Promise<void> {
  await mkdir(OUT, { recursive: true });
  let pngs = 0;
  const cards: string[] = [];
  for (const theme of THEMES) {
    const rows = ansiLinesToRows(sampleFrame(theme.bg, theme.fg));
    const html = rowsToHtml(rows, theme.bg, theme.fg, `arrival · ${theme.name}`);
    const svg = rowsToSvg(rows, theme.bg, theme.fg);
    await writeFile(path.join(OUT, `${theme.name}.html`), html);
    await writeFile(path.join(OUT, `${theme.name}.svg`), svg);
    const png = await svgToPng(svg);
    if (png !== undefined) {
      await writeFile(path.join(OUT, `${theme.name}.png`), png);
      pngs += 1;
    }
    cards.push(
      `    <figure><img src="${theme.name}.svg" alt="${theme.name}"><figcaption>${theme.name}</figcaption></figure>`,
    );
  }
  await writeFile(
    path.join(OUT, "index.html"),
    `<!doctype html>
<meta charset="utf-8">
<title>arrival theme shots</title>
<style>
  body { font: 14px/1.4 ui-sans-serif, system-ui; margin: 2rem; background: #111; color: #ddd; }
  h1 { font-weight: 500; }
  main { display: grid; gap: 2rem; }
  figure { margin: 0; }
  img { display: block; max-width: 100%; height: auto; image-rendering: pixelated; }
  figcaption { margin-top: 0.4rem; opacity: 0.7; }
</style>
<h1>arrival · theme shots</h1>
<main>
${cards.join("\n")}
</main>
`,
  );
  const extra = pngs === 0 ? " (no PNG — install @resvg/resvg-js or sharp to rasterize)" : ` + ${pngs} png`;
  process.stderr.write(`wrote ${THEMES.length} html/svg${extra} → ${OUT}\n`);
}

await main();
