// Loads the built film data, mounts one stage per chapter and exposes `window.film.renderAt(t)`.
// The render tool drives `renderAt` frame by frame; a human opens the same page and scrubs it.

import { W, H, chapterOpacity, clamp, ease, timeContext } from './core.js';
import * as kit from './kit.js';
import animatic from './animatic.js';
import { DISPLAY, TONE, el, lockup } from '../scenes/sleek.js';

const params = new URLSearchParams(location.search);
const lang = params.get('lang') ?? 'en';
const withCaptions = params.get('captions') !== '0';
/** `?only=3` mounts just that chapter's scene, so a still of one chapter never depends on the others. */
const only = params.get('only');
kit.theme(params.get('theme'));
const root = document.getElementById('film-root');

/** The chapter in which the wordmark first appears; a film without that chapter shows it throughout. */
const WORDMARK_FROM = '5';

const fetchJson = async url => {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`FILM_DATA_MISSING: ${url} (${response.status}); run design/film/tools/build.mjs`);
  return response.json();
};

/**
 * A chapter without its own scene module plays as an animatic, so the whole film always renders.
 * `?animatic=1` plays every chapter that way: narration, headings and code only.
 */
const loadScene = async chapterId => {
  if (params.has('animatic') || (only !== null && only !== chapterId)) return animatic;
  const url = new URL(`../scenes/ch${chapterId}.js`, import.meta.url).href;
  const probe = await fetch(url, { method: 'HEAD' });
  return probe.ok ? (await import(url)).default : animatic;
};

const mountChapter = async (film, chapter) => {
  const scene = await loadScene(chapter.id);
  const stage = document.createElement('div');
  stage.className = 'stage';
  root.appendChild(stage);
  film.scenes[chapter.id] = scene;
  const T = timeContext(film, chapter);
  return { chapter, stage, scene, T, handles: scene.setup(stage, kit, T) };
};

const mountOverlay = film => {
  const layer = document.createElement('div');
  layer.className = 'overlay';
  root.appendChild(layer);
  const wordmark = el(layer, { left: '72px', top: '44px', font: `800 40px ${DISPLAY}`, letterSpacing: '-0.06em', color: TONE.ink }, 'xln');
  // The part the viewer is in: large enough to read on a phone, it doubles as the YouTube chapter.
  const caption = kit.text(layer, { x: 960, y: 952, w: 1320, size: 30, lh: 1.36, color: 'rgba(21,20,15,0.78)', align: 'center' });
  const bar = kit.svg(layer);
  const progress = bar.rect({ x: 0, y: H - 3, height: 3, fill: TONE.ink, opacity: 0.28 });
  // One notch per chapter start, so the bar reads as parts.
  // The end card: the mark and where to find it. Nothing else, and no names.
  // Where the thing stands today is part of the card: the film never ends on a bare promise.
  const end = lockup(layer, film.labels['end.status'] ?? 'A test network. No real money.');
  return t => {
    const index = film.chapters.findIndex(chapter => t < chapter.end);
    const chapter = film.chapters[index < 0 ? film.chapters.length - 1 : index];
    const shown = chapterOpacity(chapter, t);
    const ending = ease((t - film.endCard + 0.2) / 0.9);
    // The film argues first and names the project only where it enters the argument.
    const named = film.chapters.find(entry => entry.id === WORDMARK_FROM);
    const last = film.chapters[film.chapters.length - 1];
    wordmark.style.opacity = String((1 - ending) * (named ? ease((t - named.start) / 0.8) : 1) * (1 - ease((t - last.start) / 0.6)));
    end(t >= film.endCard - 0.4 ? 1 : 0);
    // Where we are: the chapter's number out of all, then its name.
    progress.attr({ width: (W * clamp(t / film.duration)).toFixed(2) });
    const line = withCaptions ? film.captions.find(entry => t >= entry.start && t < entry.end) : undefined;
    caption.set(line ? line.text : '').op(line ? ease((t - line.start) / 0.18) * (1 - ease((t - (line.end - 0.18)) / 0.18)) : 0);
  };
};

const fit = () => {
  const scale = Math.min(innerWidth / W, innerHeight / H);
  root.style.transform = `scale(${scale})`;
};

const start = async () => {
  const data = await fetchJson(`dist/${lang}/film.json`);
  const film = {
    ...data,
    scenes: {},
    label: (chapterId, key, fallback) => {
      const value = data.labels[`${chapterId}.${key}`] ?? film.scenes[chapterId].strings?.[key] ?? fallback;
      if (value === undefined) throw new Error(`FILM_UNKNOWN_LABEL: ${chapterId}.${key}`);
      return value;
    },
  };
  const mounted = [];
  for (const chapter of film.chapters) mounted.push(await mountChapter(film, chapter));
  const drawOverlay = mountOverlay(film);
  await document.fonts.ready;

  const renderAt = t => {
    mounted.forEach(({ chapter, stage, scene, T, handles }) => {
      const opacity = chapterOpacity(chapter, t);
      stage.style.display = opacity > 0 ? 'block' : 'none';
      if (opacity <= 0) return;
      stage.style.opacity = String(opacity);
      T.t = t;
      scene.frame(handles, T);
    });
    drawOverlay(t);
  };

  fit();
  addEventListener('resize', fit);
  renderAt(Number(params.get('t') ?? 0));
  window.film = { ready: true, duration: film.duration, data, renderAt };
  if (!params.has('render')) (await import('./preview.js')).default(window.film, lang);
};

start().catch(error => {
  window.film = { ready: false, error: String(error?.stack ?? error) };
  document.body.textContent = window.film.error;
  throw error;
});
