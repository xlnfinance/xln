#!/usr/bin/env bun
// Composes the underscore with ElevenLabs Music and mixes it under the narration.
//
//   bun design/film/tools/score.mjs --lang en      -> dist/<lang>/mix.wav
//
// render.mjs uses mix.wav when it exists; build.mjs deletes it whenever the narration changes, so a
// mix can never play against a timeline it was not made for. Cues are cached by prompt and length:
// a re-voiced film pays for music again only where a movement's length changed.
// The key is read from ELEVENLABS_API_KEY and never printed or stored.

import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const FILM = resolve(import.meta.dirname, '..');
const MODEL = 'music_v2_5';
/** Seconds a cue overlaps its neighbour; each fades over the overlap. */
const OVERLAP = 6;
/** Loudness every cue is brought to before the bus is placed under the narration. */
const CUE_LUFS = -18;
/** Extra seconds composed per cue, so its soft opening and ending can be cut away at a join. */
const SPARE = 14;
/** Seconds the score takes to enter at the film's first frame and to leave at its last. */
const EDGE_FADE = 2;
/** The underscore sits this many loudness units under the narration before ducking. */
const UNDER_VOICE_LU = 11;
/** Narration loudness of the finished mix; the usual level for online video. */
const TARGET_LUFS = -16;
/** Composing a movement takes a minute or two; a request silent for longer is dropped and retried. */
const TIMEOUT_MS = 300_000;
const ATTEMPTS = 8;
/** Composed lengths are rounded up to this many seconds, so two languages often share a cue. */
const LENGTH_STEP = 10;
const STYLE =
  'Neoclassical minimalism for deep focus. Close-miked felt upright piano with soft hammer and pedal noise, warm analog polysynth pads and arpeggios, gentle tape saturation, an intimate room. Instrumental. No drums, no vocals, no orchestral hits, no risers, no big melody. Leaves space for a narrator.';

/**
 * One cue per movement of the film, all in one sound world. The piano motif of the opening returns
 * at the end. v10 order: your number (a held breath), the wall of failures (weight), one picture
 * (curiosity, widening at the theory), the stick and the channel (an old ledger, then a stop), the
 * whole account (motion), the dispute (a clock), the aim and the close.
 * `from` is the chapter or beat a cue starts with; `lift` offsets a cue's loudness in dB.
 */
const CUES = [
  { name: 'number', from: '0', lift: -3, prompt: `${STYLE} Opening: one sustained analog pad and a few sparse felt piano notes, a held breath, something is wrong and nothing moves; a low sub note enters halfway. Very slow, D minor.` },
  { name: 'wall', from: '1', prompt: `${STYLE} A low analog synth drone and one slowly pulsing bass note; single felt piano notes fall one by one, like names being read out. Weight and quiet unease, never dramatic. 66 bpm, D minor.` },
  { name: 'picture', from: '2', prompt: `${STYLE} The felt piano builds a simple figure one note at a time, three notes that become a pattern, a soft pad underneath; clarity arriving step by step. 80 bpm, A minor moving to C major.` },
  { name: 'turn', from: '3', prompt: `${STYLE} A hypnotic analog synth arpeggio enters quietly and widens steadily, layer upon layer, its filter opening slowly, like something turning to show its other side; the felt piano answers with single notes. Wonder, never bombastic. 100 bpm, A minor and F major.` },
  { name: 'stick', from: '4', prompt: `${STYLE} The felt piano plays a gentle repeating two-chord motif, like turning the pages of a very old ledger, a soft pad underneath; in the last third the motif thins out and stops short on an unresolved chord. 66 bpm, D minor moving to F major.` },
  { name: 'whole', from: '5', prompt: `${STYLE} The arpeggio returns brighter and layers into flowing interlocking patterns, lighter and wider, many small things moving at once, felt piano chords underneath. 100 bpm, F major.` },
  { name: 'dispute', from: '5.4', prompt: `${STYLE} The arpeggio drops to a lower register, darker and more insistent, over a muted ticking pulse like a clock and a low drone. Serious and controlled, it eases toward the end without resolving fully. 100 bpm, D minor.` },
  { name: 'close', from: '6.2', prompt: `${STYLE} The felt piano motif of the opening returns over warm swelling pads and a slow arpeggio, opening gradually, clear and hopeful without triumph, ending on one held piano chord that rings out. 72 bpm, F major.` },
];

const fail = message => {
  console.error(`FILM_SCORE_FAILED: ${message}`);
  process.exit(1);
};

const option = (name, fallback) => {
  const at = process.argv.indexOf(`--${name}`);
  return at < 0 ? fallback : process.argv[at + 1];
};

const key = process.env.ELEVENLABS_API_KEY ?? fail('set ELEVENLABS_API_KEY in the environment');

const compose = async (act, seconds, dir) => {
  const body = { prompt: act.prompt, music_length_ms: seconds * 1000, model_id: MODEL, force_instrumental: true };
  const hash = createHash('sha256').update(JSON.stringify(body)).digest('hex').slice(0, 12);
  const path = join(dir, `${act.name}-${hash}.mp3`);
  if (existsSync(path)) return path;
  const attemptOnce = async () => {
    const response = await fetch('https://api.elevenlabs.io/v1/music', {
      method: 'POST',
      headers: { 'xi-api-key': key, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    return { status: response.status, ok: response.ok, bytes: Buffer.from(await response.arrayBuffer()) };
  };
  // A dropped connection (status 0) and a rate limit are retried; any other refusal is final.
  let result = null;
  for (let attempt = 0; attempt <= ATTEMPTS; attempt += 1) {
    if (attempt > 0) await new Promise(resume => setTimeout(resume, attempt * 10_000));
    result = await attemptOnce().catch(error => ({ status: 0, ok: false, bytes: Buffer.from(String(error.code ?? error.message)) }));
    if (result.ok || (result.status !== 0 && result.status !== 429)) break;
  }
  if (!result.ok) fail(`ElevenLabs ${result.status} composing "${act.name}": ${result.bytes.toString('utf8').slice(0, 300)}`);
  writeFileSync(path, result.bytes);
  return path;
};

/** Integrated loudness in LUFS; gated, so the silences between beats do not count. */
const loudness = (inputs, filter) => {
  // ffmpeg reports the measurement on stderr.
  const run = spawnSync('ffmpeg', ['-hide_banner', '-nostats', ...inputs, '-filter_complex', `${filter}ebur128[out]`, '-map', '[out]', '-f', 'null', '-'], {
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  });
  if (run.status !== 0) fail(`ffmpeg loudness measurement exited ${run.status}: ${run.stderr.slice(-300)}`);
  const log = run.stderr;
  const match = [...log.matchAll(/I:\s+(-?[\d.]+) LUFS/g)].pop();
  return match ? Number(match[1]) : fail('could not measure loudness');
};

const main = async () => {
  const lang = option('lang', 'en');
  const out = join(FILM, 'dist', lang);
  const film = JSON.parse(readFileSync(join(out, 'film.json'), 'utf8'));
  /** A cue starts at a chapter (`'3'`) or at one beat inside it (`'4.9'`). */
  const startOf = id => (film.chapters.find(chapter => chapter.id === id) ?? film.beats[id])?.start ?? fail(`no chapter or beat ${id}`);
  const dir = join(FILM, 'dist', 'score');
  mkdirSync(dir, { recursive: true });

  const cues = [];
  for (const [index, act] of CUES.entries()) {
    const start = index === 0 ? 0 : startOf(act.from) - OVERLAP / 2;
    const end = index === CUES.length - 1 ? film.duration : startOf(CUES[index + 1].from) + OVERLAP / 2;
    const seconds = Math.ceil(end - start);
    // Neighbours cross-fade at equal power; the film itself opens quickly and lets the last chord ring.
    const fadeIn = index === 0 ? EDGE_FADE : OVERLAP;
    const fadeOut = index === CUES.length - 1 ? EDGE_FADE : OVERLAP;
    // A generated piece starts and ends softly. Only the film's own first and last seconds want
    // that: every other join is cut from the middle of the music, so no join dips to silence.
    const skip = index === 0 ? 0 : index === CUES.length - 1 ? SPARE : SPARE / 2;
    const path = await compose(act, Math.ceil((seconds + SPARE) / LENGTH_STEP) * LENGTH_STEP, dir);
    // Every movement is brought to one loudness first: a sparse piano piece is quieter than an
    // arpeggio as generated, and would otherwise vanish under the narration.
    const level = loudness(['-i', path], `[0:a]atrim=${skip}:${skip + seconds},`);
    cues.push({ path, start, seconds, fadeIn, fadeOut, skip, gain: CUE_LUFS + (act.lift ?? 0) - level });
    console.log(`${act.name.padEnd(10)} ${start.toFixed(1).padStart(6)}s  ${seconds}s`);
  }

  const voice = join(out, 'voice.wav');
  const cueInputs = cues.flatMap(cue => ['-i', cue.path]);
  /** Every cue trimmed to its act, faded over the overlap and placed on the film's clock. */
  const bus = `${cues
    .map(
      (cue, i) =>
        `[${i}:a]aresample=48000,aformat=channel_layouts=stereo,atrim=${cue.skip}:${cue.skip + cue.seconds},asetpts=PTS-STARTPTS,volume=${cue.gain.toFixed(2)}dB,afade=t=in:d=${cue.fadeIn}:curve=qsin,afade=t=out:st=${cue.seconds - cue.fadeOut}:d=${cue.fadeOut}:curve=qsin,adelay=${Math.round(cue.start * 1000)}:all=1[c${i}]`,
    )
    .join(';')};${cues.map((_, i) => `[c${i}]`).join('')}amix=inputs=${cues.length}:normalize=0:duration=longest`;
  const voiceLufs = loudness(['-i', voice], '[0:a]');
  const musicLufs = loudness(cueInputs, `${bus},`);
  const gain = voiceLufs - UNDER_VOICE_LU - musicLufs;
  console.log(`narration ${voiceLufs} LUFS, score ${musicLufs} LUFS, score gain ${gain.toFixed(1)} dB`);

  const v = cues.length;
  execFileSync(
    'ffmpeg',
    ['-y', '-loglevel', 'error', ...cueInputs, '-i', voice, '-filter_complex',
      `${bus},volume=${gain.toFixed(2)}dB[music];` +
        `[${v}:a]aformat=channel_layouts=stereo,asplit=2[say][key];` +
        // The score steps back while the narrator speaks and returns in the pauses.
        `[music][key]sidechaincompress=threshold=0.015:ratio=5:attack=30:release=600[ducked];` +
        `[say][ducked]amix=inputs=2:normalize=0:duration=first,volume=${(TARGET_LUFS - voiceLufs).toFixed(2)}dB,alimiter=limit=0.84:level=false[out]`,
      '-map', '[out]', '-ar', '48000', join(out, 'mix.wav')],
    { stdio: 'inherit' },
  );
  console.log(`${join(out, 'mix.wav')}  ${film.duration.toFixed(1)}s`);
};

await main();
