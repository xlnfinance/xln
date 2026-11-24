#!/usr/bin/env bun
// Renders the film frame by frame and muxes the voice track.
//
//   bun design/film/tools/render.mjs --lang en                         -> output/film/xln-en.mp4
//   bun design/film/tools/render.mjs --lang en --from 180 --to 210     a 30 second excerpt
//
// Options: --fps 30, --workers 6, --scale 1 (2 renders 3840x2160), --captions 0|1, --theme dark, --out <path>,
// --animatic 1 (narration, headings and code only; ignores the scene modules).

import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { FILM, REPO, openStage, option } from './stage.mjs';

const CAPTURE_TIMEOUT_MS = 120_000;
const CAPTURE_ATTEMPTS = 4;

const encoder = (fps, path) =>
  spawn(
    'ffmpeg',
    ['-y', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', String(fps), '-c:v', 'png', '-i', '-',
      '-c:v', 'libx264', '-preset', 'slow', '-crf', '15', '-pix_fmt', 'yuv420p', '-r', String(fps), path],
    { stdio: ['pipe', 'inherit', 'inherit'] },
  );

const finished = child =>
  new Promise((resolveDone, reject) => child.on('close', code => (code === 0 ? resolveDone() : reject(new Error(`ffmpeg exited ${code}`)))));

/**
 * A frame is a pure function of time, so a capture that stalls is simply taken again. A machine on
 * battery in low power mode stalls for tens of seconds at random.
 */
const capture = async page => {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await page.screenshot({ type: 'png', timeout: CAPTURE_TIMEOUT_MS });
    } catch (error) {
      if (attempt === CAPTURE_ATTEMPTS) throw error;
    }
  }
};

/** One worker renders a contiguous run of frames into its own segment file. */
const renderSegment = async (stage, { first, last, fps, path, onFrame }) => {
  const { page, renderAt } = await stage.open();
  const ffmpeg = encoder(fps, path);
  const done = finished(ffmpeg);
  for (let frame = first; frame < last; frame += 1) {
    await renderAt(frame / fps);
    const image = await capture(page);
    if (!ffmpeg.stdin.write(image)) await new Promise(resume => ffmpeg.stdin.once('drain', resume));
    onFrame();
  }
  ffmpeg.stdin.end();
  await done;
  await page.close();
};

const main = async () => {
  const lang = option('lang', 'en');
  const fps = Number(option('fps', '30'));
  const workers = Number(option('workers', '6'));
  const out = option('out', join(REPO, 'output', 'film', `xln-${lang}.mp4`));
  const temp = join(FILM, 'dist', lang, 'segments');
  rmSync(temp, { recursive: true, force: true });
  mkdirSync(temp, { recursive: true });
  mkdirSync(dirname(out), { recursive: true });

  const stage = await openStage({
    theme: option('theme'),
    lang,
    captions: option('captions', '1') === '1',
    scale: Number(option('scale', '1')),
    animatic: option('animatic', '0') === '1',
  });
  const probe = await stage.open();
  const from = Number(option('from', '0'));
  const to = Math.min(Number(option('to', String(probe.film.duration))), probe.film.duration);
  await probe.page.close();

  const firstFrame = Math.round(from * fps);
  const total = Math.round((to - from) * fps);
  const share = Math.ceil(total / workers);
  const startedAt = performance.now();
  let rendered = 0;
  const onFrame = () => {
    rendered += 1;
    if (rendered % 300 === 0 || rendered === total) {
      const elapsed = (performance.now() - startedAt) / 1000;
      console.log(`${rendered}/${total} frames  ${(rendered / elapsed).toFixed(1)} fps  ${elapsed.toFixed(0)}s`);
    }
  };
  const segments = Array.from({ length: workers }, (_, index) => ({
    first: firstFrame + Math.min(index * share, total),
    last: firstFrame + Math.min((index + 1) * share, total),
    fps,
    path: join(temp, `segment-${String(index).padStart(2, '0')}.mp4`),
    onFrame,
  })).filter(segment => segment.last > segment.first);
  await Promise.all(segments.map(segment => renderSegment(stage, segment)));
  await stage.close();

  const list = join(temp, 'segments.txt');
  writeFileSync(list, segments.map(segment => `file '${segment.path}'\n`).join(''));
  // The narration with its underscore when score.mjs has made one, else the narration alone.
  const mix = join(FILM, 'dist', lang, 'mix.wav');
  const voice = existsSync(mix) ? mix : join(FILM, 'dist', lang, 'voice.wav');
  const audio = existsSync(voice) ? ['-ss', String(from), '-t', String(to - from), '-i', voice, '-c:a', 'aac', '-b:a', '192k'] : [];
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', list, ...audio, '-c:v', 'copy', '-movflags', '+faststart', out], { stdio: 'inherit' });
  console.log(`${out}  ${(to - from).toFixed(1)}s  ${total} frames`);
};

await main();
