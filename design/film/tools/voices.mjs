#!/usr/bin/env bun
// Lists the ElevenLabs voices this account can use, and auditions candidates on real lines.
//
//   bun design/film/tools/voices.mjs                                   list voices (name, id, labels)
//   bun design/film/tools/voices.mjs --filter american,male            only voices whose labels contain every word
//   bun design/film/tools/voices.mjs --audition <id>,<name>:<id> [--model eleven_v4]
//        -> output/film/audition/<name>.mp3, each reading the same four beats of the film
//
// The key is read from ELEVENLABS_API_KEY and never printed or stored.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const FILM = resolve(import.meta.dirname, '..');
const REPO = resolve(FILM, '../..');
const API = 'https://api.elevenlabs.io/v1';
/** The hook, the claim, the thesis and a punch line: the registers the narrator needs. */
const AUDITION_BEATS = ['0.1', '0.2', '1.1', '3.3'];
const SETTINGS = { stability: 0.55, similarity_boost: 0.75, style: 0, use_speaker_boost: true, speed: 0.96 };

const option = (name, fallback) => {
  const at = process.argv.indexOf(`--${name}`);
  return at < 0 ? fallback : process.argv[at + 1];
};

const key = process.env.ELEVENLABS_API_KEY;
if (!key) {
  console.error('FILM_VOICES_FAILED: set ELEVENLABS_API_KEY in the environment');
  process.exit(1);
}

const call = async (path, init = {}) => {
  const response = await fetch(`${API}${path}`, { ...init, headers: { 'xi-api-key': key, 'content-type': 'application/json' } });
  if (!response.ok) {
    console.error(`FILM_VOICES_FAILED: ${response.status} ${path}: ${(await response.text()).slice(0, 300)}`);
    process.exit(1);
  }
  return response;
};

/** Listing needs the key's `voices_read` permission; auditioning `name:id` pairs does not. */
const listVoices = async () => (await (await call('/voices')).json()).voices;
const describe = voice => Object.values(voice.labels ?? {}).join(', ');

const audition = async ids => {
  const script = JSON.parse(readFileSync(join(FILM, 'script.en.json'), 'utf8'));
  const beats = script.chapters.flatMap(chapter => chapter.beats);
  const text = AUDITION_BEATS.map(id => beats.find(beat => beat.id === id).vo.replace(/\bxln\b/g, 'X L N')).join('\n\n');
  const out = join(REPO, 'output', 'film', 'audition');
  mkdirSync(out, { recursive: true });
  const known = ids.every(id => id.includes(':')) ? [] : await listVoices();
  for (const spec of ids) {
    const [name, given] = spec.includes(':') ? spec.split(':') : [undefined, spec];
    const id = given;
    const voice = name ? { name, labels: {} } : known.find(entry => entry.voice_id === id);
    if (!voice) throw new Error(`FILM_UNKNOWN_VOICE: ${id}`);
    const response = await call(`/text-to-speech/${id}?output_format=mp3_44100_128`, {
      method: 'POST',
      body: JSON.stringify({ text, model_id: option('model', 'eleven_v4'), voice_settings: SETTINGS }),
    });
    const path = join(out, `${voice.name.replace(/[^A-Za-z0-9]+/g, '-').toLowerCase()}.mp3`);
    writeFileSync(path, Buffer.from(await response.arrayBuffer()));
    console.log(`${path}  ${voice.name} (${describe(voice)})  ${text.length} characters`);
  }
};

const ids = option('audition');
if (ids) await audition(ids.split(','));
else {
  const words = (option('filter', '') || '').toLowerCase().split(',').filter(Boolean);
  (await listVoices())
    .filter(voice => words.every(word => `${voice.name} ${describe(voice)}`.toLowerCase().includes(word)))
    .forEach(voice => console.log(`${voice.voice_id}  ${voice.name.padEnd(28)} ${voice.category ?? ''}  ${describe(voice)}`));
}
