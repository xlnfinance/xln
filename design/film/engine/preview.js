// Human preview only; the render tool never loads this. Space plays with the voice track,
// arrows step one second, shift+arrows step one beat. The audio element is the clock while playing.

export default async (film, lang) => {
  // The mix (voice over the score) when it has been made, else the bare voice.
  const mixed = (await fetch(`dist/${lang}/mix.wav`, { method: 'HEAD' })).ok;
  const audio = new Audio(`dist/${lang}/${mixed ? 'mix' : 'voice'}.wav`);
  const starts = Object.values(film.data.beats)
    .map(beat => beat.start)
    .sort((a, b) => a - b);
  let now = Number(new URLSearchParams(location.search).get('t') ?? 0);

  const seek = t => {
    now = Math.min(Math.max(t, 0), film.duration);
    audio.currentTime = now;
    film.renderAt(now);
    history.replaceState(null, '', `?${new URLSearchParams({ lang, t: now.toFixed(2) })}`);
  };
  const follow = () => {
    if (audio.paused) return;
    now = audio.currentTime;
    film.renderAt(now);
    requestAnimationFrame(follow);
  };
  const stepBeat = direction => {
    const next = direction > 0 ? starts.find(start => start > now + 0.05) : [...starts].reverse().find(start => start < now - 0.05);
    seek(next ?? now);
  };

  addEventListener('keydown', event => {
    if (event.code === 'Space') {
      event.preventDefault();
      if (audio.paused) audio.play().then(follow);
      else audio.pause();
    }
    if (event.code === 'ArrowRight') event.shiftKey ? stepBeat(1) : seek(now + 1);
    if (event.code === 'ArrowLeft') event.shiftKey ? stepBeat(-1) : seek(now - 1);
  });
};
