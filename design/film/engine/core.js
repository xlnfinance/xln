// Film clock. Every picture is a pure function of time: `renderAt(t)` draws frame t and nothing
// else moves. No timers, CSS transitions or randomness, so a frame renders identically on any
// machine, in any order, in any language.

export const W = 1920;
export const H = 1080;

/** Seconds a chapter takes to fade in from paper and back out to it. */
const CHAPTER_FADE = 0.4;

export const clamp = (x, lo = 0, hi = 1) => (x < lo ? lo : x > hi ? hi : x);
export const lerp = (a, b, p) => a + (b - a) * p;

const EASING = {
  linear: p => p,
  inOut: p => (p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2),
  out: p => 1 - Math.pow(1 - p, 3),
  in: p => p * p * p,
};

/** Eased progress in [0, 1]; values outside the interval clamp. */
export const ease = (p, kind = 'inOut') => EASING[kind](clamp(p));

/**
 * Time helpers for one chapter. Scenes never read absolute seconds: they anchor every motion to
 * a beat id, so a re-voiced or translated film keeps picture and narration in step.
 */
export const timeContext = (film, chapter) => {
  const beat = id => {
    const found = film.beats[id];
    if (!found) throw new Error(`FILM_UNKNOWN_BEAT: ${id} (chapter ${chapter.id})`);
    return found;
  };
  const T = {
    t: 0,
    chapter,
    beat,
    /** Seconds since the beat started; negative before it. */
    since: id => T.t - beat(id).start,
    /** Eased 0→1 starting `offset` seconds into the beat and lasting `dur` seconds. */
    p: (id, offset = 0, dur = 0.8, kind = 'inOut') => ease((T.t - beat(id).start - offset) / dur, kind),
    /**
     * Seconds into the beat at which the narrator has spoken `fraction` of it. Use it as the
     * `offset` of a motion that illustrates a later phrase; it holds in every language.
     */
    frac: (id, fraction) => fraction * (beat(id).end - beat(id).start),
    /**
     * Fraction of the beat at which `phrase` is spoken, by its place in the narration. A scene that
     * names a phrase the script no longer has fails loudly instead of drifting.
     */
    mark: (id, phrase) => {
      const at = beat(id).vo.indexOf(phrase);
      if (at < 0) throw new Error(`FILM_UNKNOWN_PHRASE: "${phrase}" in beat ${id}`);
      return at / beat(id).vo.length;
    },
    /** Opacity of something that enters at beat `from` and leaves when beat `until` starts. */
    win: (from, until, fadeIn = 0.7, fadeOut = 0.5) =>
      T.p(from, 0, fadeIn) * (until ? 1 - T.p(until, 0, fadeOut) : 1),
    /**
     * A value that holds, then moves at each cue: keys are `[beatId, value, dur = 0.9, offset = 0]`
     * in chronological order.
     */
    track: (initial, keys, kind = 'inOut') =>
      keys.reduce((value, [id, target, dur = 0.9, offset = 0]) => lerp(value, target, T.p(id, offset, dur, kind)), initial),
    /** A figure in the film's locale: `T.num(1000)` is "1,000" in English, "1 000" in Russian. */
    num: (value, decimals = 0) =>
      new Intl.NumberFormat(film.lang, { minimumFractionDigits: decimals, maximumFractionDigits: decimals })
        .format(value)
        .replace('-', '−'),
    /** On-screen text of a beat in the film's language. */
    str: id => beat(id).onscreen,
    /** A scene label in the film's language; scenes declare the English text in `strings`. A fallback makes it optional. */
    s: (key, fallback) => film.label(chapter.id, key, fallback),
    /** Id of the beat being narrated at the current time. */
    active: () => chapter.beats.reduce((current, id) => (film.beats[id].start <= T.t ? id : current), chapter.beats[0]),
  };
  return T;
};

/** Opacity of a chapter's stage: fades in from paper, holds, fades out before the next one. */
export const chapterOpacity = (chapter, t) =>
  ease((t - chapter.start) / CHAPTER_FADE) * (1 - ease((t - (chapter.end - CHAPTER_FADE)) / CHAPTER_FADE));
