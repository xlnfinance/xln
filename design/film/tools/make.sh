#!/bin/zsh
# The whole film, one command, with gates. Each gate stops the run with a FILM_GATE line.
#
#   zsh design/film/tools/make.sh ru            voice -> lint -> score -> render -> verify
#   zsh design/film/tools/make.sh en ru         both languages, one after the other
#   STAGE=lint zsh design/film/tools/make.sh ru  stop after the storyboard lint (free: no voice, no render)
#   STAGE=sound zsh design/film/tools/make.sh ru stop after voice, lint and score
#   DRAFT=1 zsh design/film/tools/make.sh ru     free draft: macOS voice, no music, 1280x720
#
# Gates, in order:
#   tools    bun, ffmpeg, ffprobe and a Playwright Chromium are installed
#   key      ELEVENLABS_API_KEY is in the environment (never printed); not needed for STAGE=lint
#   lint     every beat is photographed; one LINT line (text off the safe area, overlap) fails the run
#   master   the mp4 has the built duration and frame count, 3840x2160, narration at -16 LUFS +-1
#
# Voices and tempo are the owner's current picks; change them here, nowhere else.
set -euo pipefail

VERSION=${VERSION:-v9}
# DRAFT=1: the free macOS voice, no music, a half-size render. Nothing is sent to ElevenLabs.
# Production (ElevenLabs voice and score) runs only without DRAFT, and only when the owner says so.
DRAFT=${DRAFT:-}
typeset -A SAY
SAY=(en 'Eddy (English (US))' ru Milena)
STAGE=${STAGE:-all}
typeset -A VOICE TEMPO STRINGS
VOICE=(en EkK5I93UQWFDigLMpZcX ru gJEfHTTiifXEDmO687lC)
TEMPO=(en 1.22 ru 1.18)
STRINGS=(en "" ru docs/ru/film/strings.ru.json)

REPO=${0:a:h:h:h:h}
cd $REPO
export PATH="$HOME/.bun/bin:/opt/homebrew/bin:$PATH"
gate() { print -r -- "FILM_GATE $1: $2"; exit 1 }

for tool in bun ffmpeg ffprobe; do command -v $tool >/dev/null || gate tools "$tool is not installed"; done
ls ~/Library/Caches/ms-playwright 2>/dev/null | grep -q chromium || gate tools "no Playwright Chromium (bun x playwright install chromium)"
(( $# )) || gate usage "name at least one language: en, ru"

for lang in $@; do
  (( ${+VOICE[$lang]} )) || gate usage "unknown language $lang"
  out=output/film/$VERSION
  mkdir -p $out
  strings=()
  [[ -n ${STRINGS[$lang]} ]] && strings=(--strings ${STRINGS[$lang]})

  if [[ $STAGE == lint ]]; then
    # A silent build is enough to place every beat; it replaces dist/<lang>, so the voiced build is redone later.
    bun design/film/tools/build.mjs --lang $lang $strings --voice none >/dev/null
  elif [[ -n $DRAFT ]]; then
    env -u ELEVENLABS_API_KEY bun design/film/tools/build.mjs --lang $lang $strings --voice "say:${SAY[$lang]}:205"
  else
    [[ -n ${ELEVENLABS_API_KEY:-} ]] || gate key "ELEVENLABS_API_KEY is not set (the owner adds it to ~/.zshenv)"
    bun design/film/tools/build.mjs --lang $lang $strings --voice eleven:${VOICE[$lang]} --tempo ${TEMPO[$lang]}
  fi

  shots=$out/shots-$lang
  mkdir -p $shots
  beats=($(bun -e "console.log(Object.keys((await Bun.file('design/film/dist/$lang/film.json').json()).beats).join(' '))"))
  ats=()
  for beat in $beats; do ats+=(--at $beat); done
  bun design/film/tools/shot.mjs --lang $lang --captions 0 --out $shots $ats > $shots/lint.log
  if grep -q LINT $shots/lint.log; then grep LINT $shots/lint.log; gate lint "$lang: fix the lines above"; fi
  # Contact sheets of six frames, beats in order.
  n=1
  for (( i = 1; i <= ${#beats}; i += 6 )); do
    batch=(); inputs=(); layout=()
    for beat in ${beats[i,i+5]}; do batch+=($shots/$beat.png); done
    for (( k = 1; k <= ${#batch}; k++ )); do inputs+=(-i ${batch[k]}); layout+=("$(( (k - 1) % 2 * 960 ))_$(( (k - 1) / 2 * 540 ))"); done
    if (( ${#batch} > 1 )); then
      ffmpeg -y -loglevel error $inputs -filter_complex "xstack=inputs=${#batch}:layout=${(j:|:)layout}:fill=gray" -frames:v 1 $out/storyboard-$lang-$n.png
    else
      cp ${batch[1]} $out/storyboard-$lang-$n.png
    fi
    (( n++ ))
  done
  print "$lang: ${#beats} beats photographed, lint clean -> $out/storyboard-$lang-*.png"
  [[ $STAGE == lint ]] && continue

  if [[ -n $DRAFT ]]; then
    draft=$out/draft-$lang.mp4
    bun design/film/tools/render.mjs --lang $lang --captions 0 --scale 0.6666666667 --workers 4 --out $draft
    cp design/film/dist/$lang/captions.srt $out/draft-$lang.srt
    print "$lang: draft (system voice, no music) -> $draft"
    continue
  fi
  bun design/film/tools/score.mjs --lang $lang
  [[ $STAGE == sound ]] && { print "$lang: voice and score ready -> design/film/dist/$lang/mix.wav"; continue }
  master=$out/xln-$VERSION-$lang-4k.mp4
  bun design/film/tools/render.mjs --lang $lang --captions 0 --scale 2 --workers 4 --out $master
  cp design/film/dist/$lang/captions.srt $out/xln-$VERSION-$lang.srt

  want=$(bun -e "console.log((await Bun.file('design/film/dist/$lang/film.json').json()).duration.toFixed(3))")
  have=$(ffprobe -v error -show_entries format=duration -of csv=p=0 $master)
  frames=$(ffprobe -v error -select_streams v:0 -count_packets -show_entries stream=nb_read_packets -of csv=p=0 $master)
  size=$(ffprobe -v error -select_streams v:0 -show_entries stream=width,height -of csv=p=0 $master)
  lufs=$(ffmpeg -hide_banner -nostats -i $master -filter_complex ebur128 -f null - 2>&1 | grep -E "^\s+I:" | tail -1 | awk '{print $2}')
  print "$lang master: ${have}s (built ${want}s), $frames frames, $size, $lufs LUFS"
  bun -e "
    const [want, have, frames, lufs] = [$want, $have, $frames, $lufs];
    const bad = [];
    if (Math.abs(want - have) > 0.1) bad.push('duration');
    if (Math.abs(Math.round(want * 30) - frames) > 1) bad.push('frame count');
    if ('$size' !== '3840,2160') bad.push('size');
    if (Math.abs(lufs + 16) > 1) bad.push('loudness');
    if (bad.length) { console.log('FILM_GATE master: $lang: ' + bad.join(', ')); process.exit(1); }
  "
  print "$lang: master passed -> $master"
done
