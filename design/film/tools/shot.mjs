#!/usr/bin/env bun
// Still frames for review.
//
//   bun design/film/tools/shot.mjs --chapter 3 --out /tmp/shots        one frame per beat + contact sheets
//   bun design/film/tools/shot.mjs --at 3.4 --at 3.6+1.5 --at t:95.2   beat end, beat start + seconds, absolute time
//
// Options: --lang en, --scale 0.5 (frame size relative to 1920x1080), --captions 0|1.

import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { openStage, option, options } from './stage.mjs';

/** A beat is photographed just before it ends, when its picture is complete. */
const BEFORE_END = 0.05;
const SHEET_COLUMNS = 3;
const SHEET_ROWS = 3;

/** Film pixels a scene may draw text in; the rest belongs to the wordmark, chapter label and captions. */
const SAFE = { left: 120, right: 1800, top: 120, bottom: 915 };
const MIN_CODE_PX = 17;

/**
 * Runs in the page. Reports visible text that leaves the safe area, overlaps other text, or code
 * set too small to read. Shapes are not checked; look at the frame for those.
 */
const lintFrame = ({ safe, minCode }) => {
  const opacityOf = el => {
    let opacity = 1;
    for (let node = el; node && node.id !== 'film-root'; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (style.display === 'none') return 0;
      opacity *= Number(style.opacity);
    }
    return opacity;
  };
  const items = [...document.querySelectorAll('.stage .t, .stage .code')]
    .filter(el => el.textContent.trim() && opacityOf(el) > 0.2)
    .map(el => ({ el, box: el.getBoundingClientRect(), name: `"${el.textContent.trim().replace(/\s+/g, ' ').slice(0, 36)}"` }));
  const issues = [];
  items.forEach(({ el, box, name }) => {
    if (box.left < safe.left || box.right > safe.right || box.top < safe.top || box.bottom > safe.bottom)
      issues.push(`${name} leaves the safe area: x ${Math.round(box.left)}–${Math.round(box.right)}, y ${Math.round(box.top)}–${Math.round(box.bottom)}`);
    if (el.classList.contains('code') && parseFloat(getComputedStyle(el).fontSize) < minCode)
      issues.push(`${name} code is ${parseFloat(getComputedStyle(el).fontSize).toFixed(1)}px; widen the panel, elide lines or lower clip`);
  });
  items.forEach((a, index) =>
    items.slice(index + 1).forEach(b => {
      const overlapX = Math.min(a.box.right, b.box.right) - Math.max(a.box.left, b.box.left);
      const overlapY = Math.min(a.box.bottom, b.box.bottom) - Math.max(a.box.top, b.box.top);
      if (overlapX > 6 && overlapY > 6) issues.push(`${a.name} overlaps ${b.name}`);
    }),
  );
  return issues;
};

const timeOf = (film, spec) => {
  if (spec.startsWith('t:')) return { name: `t${spec.slice(2)}`, t: Number(spec.slice(2)) };
  const [id, offset] = spec.split('+');
  const beat = film.data.beats[id];
  if (!beat) throw new Error(`FILM_UNKNOWN_BEAT: ${id}`);
  return { name: spec.replace('+', '_'), t: offset === undefined ? beat.end - BEFORE_END : beat.start + Number(offset) };
};

const sheets = (files, out, chapter) => {
  const perSheet = SHEET_COLUMNS * SHEET_ROWS;
  return Array.from({ length: Math.ceil(files.length / perSheet) }, (_, index) => {
    const path = join(out, `sheet-ch${chapter}-${index + 1}.png`);
    const batch = files.slice(index * perSheet, (index + 1) * perSheet);
    const inputs = batch.flatMap(file => ['-i', file]);
    const filter = `${batch.map((_, i) => `[${i}:v]scale=640:360[v${i}]`).join(';')};${batch.map((_, i) => `[v${i}]`).join('')}xstack=inputs=${batch.length}:layout=${batch
      .map((_, i) => `${(i % SHEET_COLUMNS) * 640}_${Math.floor(i / SHEET_COLUMNS) * 360}`)
      .join('|')}:fill=white`;
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', ...inputs, '-filter_complex', batch.length > 1 ? filter : 'scale=640:360', '-frames:v', '1', path]);
    return path;
  });
};

const main = async () => {
  const out = option('out', join(process.cwd(), 'shots'));
  mkdirSync(out, { recursive: true });
  const chapter = option('chapter');
  const chapters = new Set([...(chapter ? [chapter] : []), ...options('at').filter(spec => !spec.startsWith('t:')).map(spec => spec.split('.')[0])]);
  const stage = await openStage({
    lang: option('lang', 'en'),
    theme: option('theme'),
    captions: option('captions', '1') === '1',
    scale: Number(option('scale', '0.5')),
    // Stills of one chapter mount only that chapter, so another chapter mid-edit cannot fail them.
    only: chapters.size === 1 && !options('at').some(spec => spec.startsWith('t:')) ? [...chapters][0] : undefined,
  });
  const { page, film, renderAt } = await stage.open();
  const specs = [...options('at'), ...(chapter ? film.data.chapters.find(entry => entry.id === chapter).beats : [])];
  const files = [];
  for (const spec of specs) {
    const { name, t } = timeOf(film, spec);
    await renderAt(t);
    const path = join(out, `${name}.png`);
    await page.screenshot({ path });
    files.push(path);
    console.log(`${path}  t=${t.toFixed(2)}s`);
    (await page.evaluate(lintFrame, { safe: SAFE, minCode: MIN_CODE_PX })).forEach(issue => console.log(`  LINT ${name}: ${issue}`));
  }
  await stage.close();
  if (chapter) sheets(files, out, chapter).forEach(path => console.log(`${path}  (contact sheet, beats in order, left to right)`));
};

await main();
