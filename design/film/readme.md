# xln film

"The whole account": a narrated motion-graphics film that explains xln through one object, the
viewer's $12,000, and one vocabulary: jurisdiction, entity, account.

Every frame is a pure function of time. `film.html` exposes `window.film.renderAt(t)`; a tool steps
it frame by frame through headless Chromium into ffmpeg. Nothing is hand-keyed in a video editor,
so a new voice or a new language re-times and re-renders the whole film.

```text
script.en.json     narration per beat: the source of truth for words and order
scenes/chN.js      one module per part: what is drawn and how it moves
scenes/sleek.js    the drawing kit the parts share (diagram, phone, tally stick, mark)
engine/            clock (core.js), loader (boot.js), preview player, stand-in scene
tools/make.sh      voice -> lint -> score -> render -> verify, with gates
dist/              generated, never committed
```

## Build

```bash
STAGE=lint VERSION=v20 zsh design/film/tools/make.sh en     # free: silent build, every beat photographed and linted
STAGE=sound VERSION=v20 zsh design/film/tools/make.sh en    # ElevenLabs voice and score, no render
VERSION=v20 zsh design/film/tools/make.sh en                # the 3840x2160 master, verified
bun design/film/tools/shot.mjs --lang en --at 5.4+12 --out /tmp/shots   # one still, 12 s into beat 5.4
bun design/film/tools/serve.mjs                             # watch it: space plays, arrows scrub
```

`ELEVENLABS_API_KEY` comes from the environment and is never printed. `DRAFT=1` uses the macOS
voice, no music and a small render, and sends nothing to ElevenLabs. Music cues are cached by
prompt and length, so every change of timing costs a new score.

## Scene contract

```js
export default {
  strings: { owed: 'owed to you' },      // English labels; read them with T.s('owed')
  setup(stage, kit, T) { return {...} }, // create every element once
  frame(h, T) { ... },                   // set values for time T.t; called for any t, in any order
};
```

`frame` is idempotent and stateless: no counters, no element creation, no `Date`, no
`Math.random`, no timers, no CSS transitions.

| call | meaning |
|---|---|
| `T.p(id, offset = 0, dur = 0.8, kind)` | 0→1 starting `offset` seconds into beat `id` |
| `T.mark(id, phrase)` | the fraction of the beat at which `phrase` is spoken; throws if the script lost it |
| `T.frac(id, f)` | seconds into the beat at fraction `f`; `T.frac(id, T.mark(id, phrase))` is the usual offset |
| `T.win(from, until, fadeIn, fadeOut)` | opacity: in at beat `from`, out when `until` starts |
| `T.since(id)` / `T.active()` / `T.beat(id)` | seconds since a beat began / the current beat id / its start and end |
| `T.s(key)` / `T.num(1000)` | a scene label / a figure, in the film's language |

Anchor motion to a spoken phrase with `T.mark`, not to a hand-tuned fraction: when the script
changes, a lost phrase fails the build instead of silently drifting. A beat may carry `"hold": 1.5`
to keep its last picture on screen in silence before the next beat.

## Rules

- **One object.** The viewer's $12,000 is followed through every part; the numbers add up on
  screen (12,000 locked, 2,000 of signed credit, 14,000 in the account, 12,000 back after a
  dispute, 2,000 left as signed debt).
- **Colour is a money state.** Red: someone's word. Green with a check: provable and locked.
  Amber: signed, not locked. Ink: not judged.
- **Honest.** The film says what xln is today: a test network, no real money, run by the project,
  open audit findings, no dispute shown on a public chain. Failures are "frozen",
  "missing", "owed", never "lost"; it never claims the account would have saved anyone.
- **Facts.** Every figure on screen comes from `sources.md`; lines marked there as unverified must
  be re-checked before a public release.
- **Look.** Light paper, one typeface family, product-grade cards and phones from `sleek.js`.
  Text stays inside x 140–1780, y 130–900; `shot.mjs` prints a `LINT` line for every violation.

## Translation

A language is one JSON file, `docs/<lang>/film/strings.<lang>.json`, with `beats` (narration) and
`labels` (overrides of each scene's `strings`). Scenes do not change. The Russian file predates the
current English script and has to be rewritten against it before a Russian build.
