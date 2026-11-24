// Shared by shot.mjs and render.mjs: opens the served film page in headless Chromium.

import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { FILM, REPO, serve } from './serve.mjs';

export const PAGE_TIMEOUT_MS = 180_000;

export { FILM, REPO };

export const W = 1920;
export const H = 1080;

/**
 * The Chromium this Playwright release expects, or the newest headless shell already installed
 * on the machine. The film needs only `evaluate` and `screenshot`, which every revision supports,
 * so rendering never waits on a browser download.
 */
const browserPath = () => {
  if (existsSync(chromium.executablePath())) return chromium.executablePath();
  const cache = join(homedir(), 'Library', 'Caches', 'ms-playwright');
  const shells = existsSync(cache) ? readdirSync(cache).filter(name => name.startsWith('chromium_headless_shell-')).sort() : [];
  const newest = shells[shells.length - 1];
  if (!newest) throw new Error('FILM_NO_CHROMIUM: install one with `bunx playwright install chromium`');
  const [build] = readdirSync(join(cache, newest)).filter(name => name.startsWith('chrome-headless-shell-'));
  return join(cache, newest, build, 'chrome-headless-shell');
};

export const option = (name, fallback) => {
  const at = process.argv.indexOf(`--${name}`);
  return at < 0 ? fallback : process.argv[at + 1];
};

export const options = name => process.argv.flatMap((arg, index) => (arg === `--${name}` ? [process.argv[index + 1]] : []));

/**
 * @returns `open()` gives a page with the film mounted and `window.film.renderAt` ready; a scene
 * error fails the caller instead of producing a blank frame.
 */
export const openStage = async ({ lang, captions, scale, animatic = false, only, theme }) => {
  const server = serve();
  const browser = await chromium.launch({ executablePath: browserPath() });
  const url = `http://127.0.0.1:${server.port}/design/film/film.html?render=1&lang=${lang}&captions=${captions ? 1 : 0}${animatic ? '&animatic=1' : ''}${only === undefined ? '' : `&only=${only}`}${theme ? `&theme=${theme}` : ''}`;
  const open = async () => {
    const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: scale });
    const errors = [];
    page.on('pageerror', error => errors.push(String(error.stack ?? error)));
    // A throttled machine (battery, low power mode) can stall for a minute; the page is local, so waiting is safe.
    await page.goto(url, { timeout: PAGE_TIMEOUT_MS });
    await page.waitForFunction(() => window.film !== undefined, undefined, { timeout: PAGE_TIMEOUT_MS });
    const film = await page.evaluate(() => ({ ready: window.film.ready, error: window.film.error, duration: window.film.duration, data: window.film.data }));
    if (!film.ready) throw new Error(`FILM_PAGE_FAILED: ${film.error}`);
    const renderAt = async t => {
      await page.evaluate(time => window.film.renderAt(time), t);
      if (errors.length) throw new Error(`FILM_FRAME_FAILED at ${t.toFixed(3)}s: ${errors[0]}`);
    };
    return { page, film, renderAt };
  };
  const close = async () => {
    await browser.close();
    server.stop(true);
  };
  return { open, close };
};
