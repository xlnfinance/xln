#!/usr/bin/env bun
// Builds dist/<lang>/film.json: narration timeline, captions and the code excerpts the film shows.
//
//   bun design/film/tools/build.mjs --lang en --voice say:Samantha:172
//   bun design/film/tools/build.mjs --lang ru --strings docs/ru/film/strings.ru.json --voice say:Milena:180
//   bun design/film/tools/build.mjs --lang en --voice dir:/path/to/recorded   (one <beatId>.wav per beat)
//   bun design/film/tools/build.mjs --lang en --voice eleven:<voiceId>          (ElevenLabs, needs ELEVENLABS_API_KEY)
//   bun design/film/tools/build.mjs --lang en --voice none                     (silent, 150 words/min)
//
// Picture timing follows the voice: every beat lasts as long as its narration, so a new voice or
// language re-times the whole film without touching a scene.

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const FILM = resolve(import.meta.dirname, '..');
const REPO = resolve(FILM, '../..');

const RATE = 48_000;
/** Seconds of paper before the first word, between beats and between chapters. */
const LEAD = 0.8;
const BEAT_GAP = 0.2;
const CHAPTER_GAP = 1.0;
/** The last picture holds this long after the last word; then the end card stands for END_CARD seconds. */
const END_HOLD = 2.0;
const END_CARD = 4;
/** A chapter's picture is on screen this long before its narration starts. */
const CHAPTER_PREROLL = 0.5;
const MAX_EXCERPT_LINES = 24;
const CAPTION_CHARS = 86;
const SECONDS_PER_WORD = 0.4;

const fail = message => {
  console.error(`FILM_BUILD_FAILED: ${message}`);
  process.exit(1);
};

const option = (name, fallback) => {
  const at = process.argv.indexOf(`--${name}`);
  return at < 0 ? fallback : process.argv[at + 1];
};

const readJson = path => JSON.parse(readFileSync(path, 'utf8'));

/** Runs of lines the script elides become one marked row, indented like the first line it replaces. */
const elided = (lines, needles) =>
  lines.reduce((kept, line) => {
    if (!needles.some(needle => line.includes(needle))) return [...kept, line];
    const mark = `${line.slice(0, line.length - line.trimStart().length)}⋯`;
    return kept[kept.length - 1]?.trim() === '⋯' ? kept : [...kept, mark];
  }, []);

/**
 * The excerpt between two anchors, exactly as the repository has it, with common indent removed.
 * `elide` lists substrings; a line containing one is replaced by a visible ⋯, never silently dropped.
 */
const excerpt = ({ file, startAnchor, endAnchor, elide = [] }, beatId) => {
  const lines = readFileSync(join(REPO, file), 'utf8').split('\n');
  const start = lines.findIndex(line => line.includes(startAnchor));
  if (start < 0) fail(`beat ${beatId}: startAnchor not found in ${file}: ${startAnchor}`);
  const length = lines.slice(start).findIndex(line => line.includes(endAnchor)) + 1;
  if (length < 1) fail(`beat ${beatId}: endAnchor not found after ${file}:${start + 1}: ${endAnchor}`);
  if (length > MAX_EXCERPT_LINES) fail(`beat ${beatId}: excerpt ${file}:${start + 1} is ${length} lines; limit ${MAX_EXCERPT_LINES}`);
  elide.forEach(needle => {
    if (!lines.slice(start, start + length).some(line => line.includes(needle))) fail(`beat ${beatId}: elide text not in excerpt ${file}:${start + 1}: ${needle}`);
  });
  const raw = elided(lines.slice(start, start + length).map(line => line.replaceAll('\t', '  ')), elide);
  const indent = Math.min(...raw.filter(line => line.trim()).map(line => line.length - line.trimStart().length));
  return { file, start: start + 1, end: start + length, lines: raw.map(line => line.slice(indent)) };
};

/** Applies a translation file onto the English script; every beat must be translated. */
const localize = (script, strings) => ({
  ...script,
  title: strings.title ?? fail('translation has no title'),
  chapters: script.chapters.map(chapter => ({
    ...chapter,
    title: strings.chapters?.[chapter.id] ?? fail(`translation has no title for chapter ${chapter.id}`),
    beats: chapter.beats.map(beat => {
      const translated = strings.beats?.[beat.id] ?? fail(`translation has no beat ${beat.id}`);
      return { ...beat, vo: translated.vo, onscreen: translated.onscreen ?? '' };
    }),
  })),
});

/** Scratch-voice pronunciation only; a recorded voice never passes through this. A translation adds its own as `pronounce`: [[pattern, spoken], …]. */
const PRONOUNCE = {
  en: [
    [/\bxln\b/g, 'X L N'],
    [/Δ/g, 'delta'],
    [/J\/E\/A/g, 'J, E, A'],
    [/\bT2\b/g, 'T two'],
    [/\bmBridge\b/g, 'M bridge'],
  ],
};
const spoken = (text, lang) => (PRONOUNCE[lang] ?? []).reduce((value, [from, to]) => value.replace(from, to), text);

const wavSamples = path => {
  const bytes = readFileSync(path);
  const data = bytes.indexOf('data', 12, 'latin1');
  if (data < 0) fail(`not a PCM wav: ${path}`);
  const size = bytes.readUInt32LE(data + 4);
  const body = bytes.subarray(data + 8, data + 8 + size);
  return new Int16Array(body.buffer.slice(body.byteOffset, body.byteOffset + (body.byteLength & ~1)));
};

const wavFile = samples => {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'latin1');
  header.writeUInt32LE(36 + samples.byteLength, 4);
  header.write('WAVEfmt ', 8, 'latin1');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(RATE, 24);
  header.writeUInt32LE(RATE * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'latin1');
  header.writeUInt32LE(samples.byteLength, 40);
  return Buffer.concat([header, Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength)]);
};

const sayVoice = (lang, cacheDir, voice, rate) => async beat => {
  const text = spoken(beat.vo, lang);
  const key = createHash('sha256').update(`${voice}|${rate}|${text}`).digest('hex').slice(0, 12);
  const path = join(cacheDir, `${beat.id}-${key}.wav`);
  if (!existsSync(path)) await run('say', ['-v', voice, '-r', rate, '-o', path, '--file-format=WAVE', `--data-format=LEI16@${RATE}`, text]);
  return wavSamples(path);
};

/** ElevenLabs delivery: fast and sure of itself; 1.2 is the service's top speed. */
const ELEVEN_SETTINGS = { stability: 0.5, similarity_boost: 0.75, style: 0.2, use_speaker_boost: true, speed: 1.2 };
const ELEVEN_DEFAULT_MODEL = 'eleven_v4';
/** Narration tempo: `--tempo 1.2` plays the recorded voice 20% faster at the same pitch. */
const TEMPO = Number(option('tempo', '1'));
const ELEVEN_RETRY = new Set([409, 429]);
const ELEVEN_ATTEMPTS = 5;
/** A request that has not answered by then is dropped and retried; no beat takes this long. */
const ELEVEN_TIMEOUT_MS = 90_000;
/** Models that accept neighbouring text to keep intonation continuous across beats. */
const ELEVEN_STITCHING = new Set(['eleven_multilingual_v2']);

/**
 * One request per beat to ElevenLabs, cached by voice, model, settings and text, so only an
 * edited beat is paid for again. The key is read from ELEVENLABS_API_KEY and never written anywhere.
 */
const elevenVoice = (lang, cacheDir, voiceId, model, beats) => {
  const key = process.env.ELEVENLABS_API_KEY ?? fail('set ELEVENLABS_API_KEY in the environment to use --voice eleven:<voiceId>');
  if (!voiceId) fail('--voice eleven:<voiceId>[:<model>] needs a voice id; list them with tools/voices.mjs');
  return async beat => {
    const text = spoken(beat.vo, lang);
    const at = beats.findIndex(other => other.id === beat.id);
    const context = ELEVEN_STITCHING.has(model)
      ? { previous_text: beats[at - 1]?.vo ?? null, next_text: beats[at + 1]?.vo ?? null }
      : {};
    const body = { text, model_id: model, voice_settings: ELEVEN_SETTINGS, ...context };
    const hash = createHash('sha256').update(`${voiceId}|${JSON.stringify(body)}`).digest('hex').slice(0, 12);
    const path = join(cacheDir, `${beat.id}-eleven-${hash}.pcm`);
    if (!existsSync(path)) {
      const request = () =>
        fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}?output_format=pcm_${RATE}`, {
          method: 'POST',
          headers: { 'xi-api-key': key, 'content-type': 'application/json' },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(ELEVEN_TIMEOUT_MS),
        });
      // 409 and 429 are the service asking for a pause (a library voice being attached, a rate limit);
      // a dropped connection is retried the same way. The body is read inside the attempt.
      const attemptOnce = async () => {
        const response = await request();
        return { status: response.status, ok: response.ok, bytes: Buffer.from(await response.arrayBuffer()) };
      };
      let result = null;
      for (let attempt = 0; attempt <= ELEVEN_ATTEMPTS; attempt += 1) {
        if (attempt > 0) await new Promise(resume => setTimeout(resume, attempt * 3000));
        result = await attemptOnce().catch(error => ({ status: 0, ok: false, bytes: Buffer.from(String(error.code ?? error.message)) }));
        if (result.ok || (result.status !== 0 && !ELEVEN_RETRY.has(result.status))) break;
      }
      if (!result.ok) fail(`ElevenLabs ${result.status} on beat ${beat.id}: ${result.bytes.toString('utf8').slice(0, 300)}`);
      writeFileSync(path, result.bytes);
    }
    // The service's own speed setting barely moves the pace, so tempo is set here, pitch kept.
    const paced = join(cacheDir, `${beat.id}-eleven-${hash}-x${TEMPO}.pcm`);
    if (TEMPO !== 1 && !existsSync(paced))
      await run('ffmpeg', ['-y', '-loglevel', 'error', '-f', 's16le', '-ar', String(RATE), '-ac', '1', '-i', path, '-af', `atempo=${TEMPO}`, '-f', 's16le', paced]);
    const bytes = readFileSync(TEMPO === 1 ? path : paced);
    return new Int16Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + (bytes.byteLength & ~1)));
  };
};

const voiceSource = (spec, lang, cacheDir, beats) => {
  const [kind, ...rest] = spec.split(':');
  if (kind === 'none') return async beat => new Int16Array(Math.round(Math.max(1.5, beat.vo.split(/\s+/).length * SECONDS_PER_WORD) * RATE));
  if (kind === 'dir') return async beat => wavSamples(join(rest.join(':'), `${beat.id}.wav`));
  if (kind === 'say') return sayVoice(lang, cacheDir, rest[0] ?? 'Samantha', rest[1] ?? '172');
  if (kind === 'eleven') return elevenVoice(lang, cacheDir, rest[0], rest[1] ?? ELEVEN_DEFAULT_MODEL, beats);
  return fail(`unknown --voice ${spec}`);
};

const inBatches = async (items, size, work) => {
  const results = [];
  for (let at = 0; at < items.length; at += size) results.push(...(await Promise.all(items.slice(at, at + size).map(work))));
  return results;
};

/** Narration split into caption lines of readable length, timed in proportion to their text. */
const captionsFor = (vo, start, end) => {
  const lines = vo
    .split(/(?<=[.!?…:;,])\s+/)
    .reduce((acc, clause) => {
      const last = acc[acc.length - 1];
      if (last !== undefined && `${last} ${clause}`.length <= CAPTION_CHARS) return [...acc.slice(0, -1), `${last} ${clause}`];
      return [...acc, clause];
    }, []);
  const total = lines.reduce((sum, line) => sum + line.length, 0);
  let cursor = start;
  return lines.map(text => {
    const from = cursor;
    cursor += ((end - start) * text.length) / total;
    return { start: from, end: cursor, text };
  });
};

const srtTime = seconds => {
  const ms = Math.round(seconds * 1000);
  const pad = (value, width = 2) => String(value).padStart(width, '0');
  return `${pad(Math.floor(ms / 3_600_000))}:${pad(Math.floor(ms / 60_000) % 60)}:${pad(Math.floor(ms / 1000) % 60)},${pad(ms % 1000, 3)}`;
};

const main = async () => {
  const lang = option('lang', 'en');
  const stringsPath = option('strings');
  const english = readJson(join(FILM, 'script.en.json'));
  const strings = stringsPath ? readJson(resolve(REPO, stringsPath)) : undefined;
  if (strings?.pronounce) PRONOUNCE[lang] = strings.pronounce.map(([pattern, to]) => [new RegExp(pattern, 'g'), to]);
  const script = strings ? localize(english, strings) : english;
  const out = join(FILM, 'dist', lang);
  const cacheDir = join(out, 'voice');
  mkdirSync(cacheDir, { recursive: true });

  const flat = script.chapters.flatMap(chapter => chapter.beats.map(beat => ({ ...beat, chapter: chapter.id })));
  const ids = new Set(flat.map(beat => beat.id));
  if (ids.size !== flat.length) fail('duplicate beat ids');
  const voiceSpec = option('voice', 'say:Samantha:172');
  const voice = voiceSource(voiceSpec, lang, cacheDir, flat);
  // A hosted voice is rate-limited per account; the local ones are not.
  const audio = await inBatches(flat, voiceSpec.startsWith('eleven') ? 3 : 8, voice);

  const beats = {};
  const captions = [];
  const placed = [];
  let cursor = LEAD;
  flat.forEach((beat, index) => {
    const previous = flat[index - 1];
    if (previous) cursor += previous.chapter === beat.chapter ? BEAT_GAP + (previous.hold ?? 0) : CHAPTER_GAP + (previous.hold ?? 0);
    const start = cursor;
    const end = start + audio[index].length / RATE;
    cursor = end;
    beats[beat.id] = {
      chapter: beat.chapter,
      start,
      end,
      vo: beat.vo,
      onscreen: beat.onscreen ?? '',
      ...(beat.code ? { code: excerpt(beat.code, beat.id) } : {}),
    };
    captions.push(...captionsFor(beat.vo, start, end + 0.2));
    placed.push({ at: Math.round(start * RATE), samples: audio[index] });
  });
  const endCard = cursor + END_HOLD;
  const duration = endCard + END_CARD;

  const chapters = script.chapters.map(chapter => ({
    id: chapter.id,
    title: chapter.title,
    start: Math.max(0, beats[chapter.beats[0].id].start - CHAPTER_PREROLL),
    beats: chapter.beats.map(beat => beat.id),
  }));
  chapters.forEach((chapter, index) => {
    chapter.end = chapters[index + 1]?.start ?? endCard;
  });

  const track = new Int16Array(Math.ceil(duration * RATE));
  placed.forEach(({ at, samples }) => track.set(samples, at));
  writeFileSync(join(out, 'voice.wav'), wavFile(track));
  // A mix made for the previous narration would play against the wrong timeline.
  rmSync(join(out, 'mix.wav'), { force: true });
  writeFileSync(
    join(out, 'captions.srt'),
    captions.map((line, index) => `${index + 1}\n${srtTime(line.start)} --> ${srtTime(line.end)}\n${line.text}\n`).join('\n'),
  );
  writeFileSync(
    join(out, 'film.json'),
    `${JSON.stringify({ lang, title: script.title, duration, endCard, chapters, beats, captions, labels: strings?.labels ?? {} }, null, 1)}\n`,
  );
  const words = flat.reduce((sum, beat) => sum + beat.vo.split(/\s+/).length, 0);
  console.log(`${lang}: ${flat.length} beats, ${words} words, ${(duration / 60).toFixed(2)} min -> ${out}/film.json`);
  chapters.forEach(chapter => console.log(`  ${chapter.id.padEnd(3)} ${chapter.start.toFixed(1).padStart(6)}s  ${(chapter.end - chapter.start).toFixed(1).padStart(5)}s  ${chapter.title}`));
};

await main();
