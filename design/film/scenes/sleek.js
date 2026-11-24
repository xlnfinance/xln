// The film's product-grade surface: real interface cards with depth, one accent, tight type.
// Everything is plain DOM positioned in film pixels and set from time, like the rest of the kit.

import { clamp } from '../engine/core.js';

export const UI = "-apple-system, 'SF Pro Display', 'Helvetica Neue', sans-serif";
export const DISPLAY = "'XLN Display', -apple-system, sans-serif";
export const MONO = "'JetBrains Mono', ui-monospace, monospace";

export const TONE = {
  bg: '#FBFBFA',
  card: '#FFFFFF',
  ink: '#0A0B0D',
  mute: '#5B616E',
  faint: '#8A919E',
  line: '#E7E9ED',
  wash: '#F3F4F6',
  accent: '#1F4FFF',
  red: '#E5484D',
  redWash: '#FFF0F0',
  green: '#12A150',
  greenWash: '#E9F8EF',
};

export const SHADOW = {
  card: '0 1px 2px rgba(10,11,13,.05), 0 12px 32px -12px rgba(10,11,13,.14)',
  lift: '0 2px 4px rgba(10,11,13,.05), 0 30px 70px -24px rgba(10,11,13,.28)',
  device: '0 4px 10px rgba(10,11,13,.10), 0 50px 110px -30px rgba(10,11,13,.42), 0 90px 160px -60px rgba(31,79,255,.22)',
};

/** An absolutely placed block. `style` is plain CSS in film pixels. */
export const el = (parent, style = {}, words) => {
  const node = document.createElement('div');
  Object.assign(node.style, { position: 'absolute', boxSizing: 'border-box', ...style });
  if (words !== undefined) node.textContent = words;
  parent.appendChild(node);
  return node;
};

/** Settles past the target and back: the motion of something with weight. */
export const spring = p => {
  const x = clamp(p);
  return 1 - Math.exp(-6.5 * x) * Math.cos(9 * x) * (1 - x);
};

/** Fast start, long glide. */
export const glide = p => 1 - Math.pow(1 - clamp(p), 4);

/** Sets opacity and a rise of `dy` pixels that closes as the element arrives. */
export const rise = (node, p, dy = 24, extra = '') => {
  node.style.opacity = String(clamp(p));
  node.style.transform = `translateY(${((1 - clamp(p)) * dy).toFixed(2)}px) ${extra}`;
};

/** A repeatable stream of numbers in [0, 1), so a frame is the same on every machine. */
export const noise = seed => {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let x = state;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
};

/** A rounded pill with a dot: a state, said once. */
export const chip = (parent, { x, y, words, tone = 'mute', size = 22 }) => {
  const [ink, wash] = { mute: [TONE.mute, TONE.wash], red: [TONE.red, TONE.redWash], green: [TONE.green, TONE.greenWash], ink: [TONE.card, TONE.ink] }[tone];
  const node = el(parent, {
    left: `${x}px`, top: `${y}px`, transform: 'translateX(-50%)', padding: `${size * 0.42}px ${size * 0.9}px`, borderRadius: '999px', background: wash, color: ink,
    font: `600 ${size}px ${UI}`, letterSpacing: '-0.01em', whiteSpace: 'pre', display: 'flex', alignItems: 'center', gap: `${size * 0.45}px`,
  });
  const dot = document.createElement('span');
  Object.assign(dot.style, { width: `${size * 0.4}px`, height: `${size * 0.4}px`, borderRadius: '50%', background: ink, flex: 'none' });
  node.append(dot, words);
  return node;
};

const PHONE = { w: 380, h: 780, bezel: 12 };

/**
 * A phone with the exchange app open: balance, assets, the withdraw button.
 * `update({ pressed, busy, paused, spin })` drives the button; `screen` can be cloned as a screenshot.
 */
export const phone = (parent, { x, y, brand, labels, balance, rows, proof = false }) => {
  const root = el(parent, {
    left: `${x - PHONE.w / 2}px`, top: `${y - PHONE.h / 2}px`, width: `${PHONE.w}px`, height: `${PHONE.h}px`, borderRadius: '64px', background: '#0B0C0F',
    boxShadow: SHADOW.device, transformOrigin: '50% 50%',
  });
  const screen = el(root, { left: `${PHONE.bezel}px`, top: `${PHONE.bezel}px`, right: `${PHONE.bezel}px`, bottom: `${PHONE.bezel}px`, borderRadius: '52px', background: TONE.card, overflow: 'hidden', fontFamily: UI, color: TONE.ink });
  el(screen, { left: '128px', top: '12px', width: '100px', height: '28px', borderRadius: '14px', background: '#0B0C0F' });
  el(screen, { left: '30px', top: '16px', font: `600 15px ${UI}` }, '9:41');
  el(screen, { right: '28px', top: '19px', width: '24px', height: '12px', borderRadius: '4px', border: `1.5px solid ${TONE.ink}`, opacity: '.8' });
  el(screen, { left: '24px', top: '66px', font: `800 24px ${DISPLAY}`, letterSpacing: '-0.03em' }, brand);
  el(screen, { right: '24px', top: '64px', width: '34px', height: '34px', borderRadius: '50%', background: TONE.wash });
  el(screen, { left: '24px', top: '124px', font: `500 15px ${UI}`, color: TONE.mute }, labels.total);
  const figure = el(screen, { left: '24px', top: '146px', font: `700 46px ${UI}`, letterSpacing: '-0.035em', fontVariantNumeric: 'tabular-nums' }, balance);
  el(screen, { left: '24px', top: '212px', padding: '5px 11px', borderRadius: '999px', background: proof ? TONE.greenWash : TONE.wash, font: `600 13px ${UI}`, color: proof ? TONE.green : TONE.mute, whiteSpace: 'pre' }, labels.available);

  const chart = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  chart.setAttribute('viewBox', '0 0 308 70');
  Object.assign(chart.style, { position: 'absolute', left: '24px', top: '254px', width: '308px', height: '70px' });
  chart.innerHTML = `<defs><linearGradient id="sleek-fill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${TONE.accent}" stop-opacity=".16"/><stop offset="1" stop-color="${TONE.accent}" stop-opacity="0"/></linearGradient></defs>
    <path d="M0,52 C40,50 60,30 96,34 S150,48 186,30 S250,22 308,14 L308,70 L0,70 Z" fill="url(#sleek-fill)"/>
    <path d="M0,52 C40,50 60,30 96,34 S150,48 186,30 S250,22 308,14" fill="none" stroke="${TONE.accent}" stroke-width="2.5" stroke-linecap="round"/>`;
  screen.appendChild(chart);

  el(screen, { left: '24px', top: '346px', font: `600 12px ${UI}`, letterSpacing: '.08em', color: TONE.faint }, labels.assets);
  (rows ?? [['$', 'US Dollar', balance, TONE.green], ['₿', 'Bitcoin', '$0.00', '#F7931A'], ['Ξ', 'Ethereum', '$0.00', '#627EEA']]).forEach(([sign, name, amount, tint], index) => {
    const top = 374 + index * 60;
    el(screen, { left: '24px', top: `${top}px`, width: '38px', height: '38px', borderRadius: '50%', background: tint, color: '#fff', font: `700 18px ${UI}`, display: 'flex', alignItems: 'center', justifyContent: 'center' }, sign);
    el(screen, { left: '76px', top: `${top + 8}px`, font: `600 16px ${UI}` }, name);
    el(screen, { right: '24px', top: `${top + 8}px`, font: `600 16px ${UI}`, fontVariantNumeric: 'tabular-nums', color: index ? TONE.faint : TONE.ink }, amount);
    if (index < 2) el(screen, { left: '76px', right: '24px', top: `${top + 49}px`, height: '1px', background: TONE.line });
  });

  const button = el(screen, { left: '24px', top: '586px', width: '308px', height: '58px', borderRadius: '18px', background: TONE.accent, color: '#fff', font: `600 18px ${UI}`, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '10px', transformOrigin: '50% 50%' });
  const spinner = el(button, { position: 'relative', width: '18px', height: '18px', borderRadius: '50%', border: '2.5px solid rgba(255,255,255,.35)', borderTopColor: '#fff', display: 'none' });
  const buttonWords = el(button, { position: 'relative' }, labels.withdraw);
  el(screen, { left: '24px', top: '656px', width: '308px', height: '54px', borderRadius: '18px', border: `1.5px solid ${TONE.line}`, font: `600 17px ${UI}`, display: 'flex', alignItems: 'center', justifyContent: 'center' }, labels.deposit);
  el(screen, { left: '116px', bottom: '9px', width: '124px', height: '5px', borderRadius: '3px', background: TONE.ink, opacity: '.85' });

  const banner = el(screen, { left: '14px', top: '50px', width: '328px', padding: '14px 16px', borderRadius: '18px', background: TONE.card, boxShadow: SHADOW.lift, border: `1px solid ${TONE.line}`, font: `600 15px ${UI}`, display: 'flex', alignItems: 'center', gap: '10px', opacity: '0' });
  const mark = document.createElement('span');
  Object.assign(mark.style, { width: '22px', height: '22px', borderRadius: '50%', background: TONE.red, color: '#fff', font: `800 14px ${UI}`, display: 'flex', alignItems: 'center', justifyContent: 'center', flex: 'none' });
  mark.textContent = '!';
  banner.append(mark, labels.disabled);
  const touch = el(screen, { left: '148px', top: '585px', width: '60px', height: '60px', borderRadius: '50%', background: 'rgba(10,11,13,.22)', opacity: '0' });
  const ripple = el(screen, { left: '148px', top: '585px', width: '60px', height: '60px', borderRadius: '50%', border: '2px solid rgba(255,255,255,.9)', opacity: '0' });
  const flash = el(screen, { inset: '0', background: '#fff', opacity: '0' });

  /** The clone for a screenshot is taken before the button is ever pressed. */
  const copy = () => screen.cloneNode(true);

  const update = ({ touching = 0, press = 0, wave = 0, busy = 0, paused = 0, done = 0, spin = 0, flash: lit = 0 }) => {
    button.style.transform = `scale(${1 - 0.045 * press})`;
    button.style.background = done > 0.5 ? TONE.green : paused > 0.5 ? TONE.wash : TONE.accent;
    button.style.color = paused > 0.5 && done <= 0.5 ? TONE.faint : '#fff';
    button.style.opacity = String(1 - 0.18 * press);
    spinner.style.display = busy > 0.5 && paused <= 0.5 && done <= 0.5 ? 'block' : 'none';
    spinner.style.transform = `rotate(${(spin * 400) % 360}deg)`;
    buttonWords.textContent = done > 0.5 ? labels.done : paused > 0.5 ? labels.paused : busy > 0.5 ? labels.busy : labels.withdraw;
    banner.style.opacity = String(clamp(paused));
    banner.style.transform = `translateY(${(spring(paused) - 1) * 70}px)`;
    touch.style.opacity = String(touching);
    touch.style.transform = `scale(${1.25 - 0.35 * touching})`;
    ripple.style.opacity = String(wave > 0 && wave < 1 ? (1 - wave) * 0.9 : 0);
    ripple.style.transform = `scale(${1 + 1.8 * wave})`;
    flash.style.opacity = String(lit);
  };
  return { root, screen, figure, copy, update, size: PHONE };
};

// ── The film's one picture, in product surfaces ─────────────────────────────────────────────────
//
//   ledger   the wide card on top: the book with the last word (the Fed's, or a blockchain).
//   you/them two round avatars. A small card under each is that side's own copy of the account.
//   bar      the account itself, between the two: collateral in the middle, credit at the ends.
//
// Colour is provability: red on someone's word, green provable and secured, amber signed and not
// secured, grey not judged.

export const GEO = {
  ledger: { x: 300, y: 130, w: 1320, h: 128 },
  you: { x: 470, y: 590 },
  them: { x: 1450, y: 590 },
  avatar: 84,
  bar: { x: 620, y: 590, w: 680, h: 68 },
  caption: 884,
};

const SVG = 'http://www.w3.org/2000/svg';
const ICON = {
  person: '<circle cx="0" cy="-16" r="15"/><path d="M-30,34 C-30,10 -16,4 0,4 C16,4 30,10 30,34"/>',
  exchange: '<path d="M-32,22 L-10,-2 L6,12 L32,-20"/><path d="M12,-20 L32,-20 L32,0"/>',
  bank: '<path d="M-32,-10 L0,-30 L32,-10 Z"/><path d="M-22,-2 V22 M0,-2 V22 M22,-2 V22 M-34,30 H34"/>',
};
const FILL = {
  red: { background: TONE.redWash, border: `2px solid ${TONE.red}`, color: TONE.red },
  green: { background: TONE.green, border: `2px solid ${TONE.green}`, color: '#fff' },
  amber: { background: '#F5A524', border: '2px solid #F5A524', color: '#3B2500' },
  amberEmpty: { background: 'rgba(245,165,36,.10)', border: '2px dashed #F5A524', color: '#9A6200' },
  empty: { background: 'transparent', border: `2px dashed ${TONE.faint}`, color: TONE.faint },
  ink: { background: TONE.wash, border: `2px solid ${TONE.line}`, color: TONE.mute },
};
export const AMBER = '#F5A524';

const avatar = (parent, { x, y }) => {
  const r = GEO.avatar;
  const ring = el(parent, { left: `${x - r}px`, top: `${y - r}px`, width: `${r * 2}px`, height: `${r * 2}px`, borderRadius: '50%', background: TONE.card, border: `1px solid ${TONE.line}`, boxShadow: SHADOW.lift });
  const art = document.createElementNS(SVG, 'svg');
  art.setAttribute('viewBox', '-60 -60 120 120');
  Object.assign(art.style, { position: 'absolute', inset: '24px', width: `${r * 2 - 48}px`, height: `${r * 2 - 48}px` });
  ring.appendChild(art);
  const name = el(parent, { left: `${x}px`, top: `${y + r + 16}px`, transform: 'translateX(-50%)', font: `700 28px ${UI}`, letterSpacing: '-0.02em', color: TONE.ink, whiteSpace: 'pre' });
  const note = el(parent, { left: `${x}px`, top: `${y + r + 54}px`, transform: 'translateX(-50%)', font: `500 22px ${UI}`, color: TONE.mute, whiteSpace: 'pre' });
  let drawn = '';
  return ({ op = 1, kind = 'person', name: words = '', note: under = '', tone = 'ink', pop = 1 }) => {
    if (drawn !== kind + tone) {
      drawn = kind + tone;
      const stroke = { ink: TONE.ink, red: TONE.red, green: TONE.green, mute: TONE.faint }[tone];
      art.innerHTML = `<g fill="none" stroke="${stroke}" stroke-width="6" stroke-linecap="round" stroke-linejoin="round">${ICON[kind]}</g>`;
    }
    ring.style.opacity = String(clamp(op));
    ring.style.transform = `scale(${0.8 + 0.2 * spring(clamp(op * pop))})`;
    name.textContent = words;
    name.style.opacity = String(clamp(op));
    note.textContent = under;
    note.style.opacity = String(clamp(op));
  };
};

/** A small statement card: one side's own copy of the account. */
const copyCard = (parent, { x, y }) => {
  const card = el(parent, { left: `${x - 130}px`, top: `${y}px`, width: '260px', height: '100px', borderRadius: '22px', background: TONE.card, boxShadow: SHADOW.card, fontFamily: UI, opacity: '0' });
  const title = el(card, { left: '20px', top: '14px', font: `600 19px ${UI}`, color: TONE.mute, whiteSpace: 'pre' });
  const figure = el(card, { left: '20px', top: '44px', font: `700 30px ${UI}`, letterSpacing: '-0.03em', fontVariantNumeric: 'tabular-nums', whiteSpace: 'pre' });
  const badge = el(card, { right: '16px', top: '34px', width: '34px', height: '34px', borderRadius: '50%', font: `800 19px ${UI}`, display: 'flex', alignItems: 'center', justifyContent: 'center' });
  return ({ op = 0, title: words = '', figure: value = '', state = 'none', dx = 0, dy = 0, scale = 1 }) => {
    const tone = { none: TONE.red, signed: TONE.green, theirs: TONE.red, plain: TONE.mute }[state];
    card.style.opacity = String(clamp(op));
    card.style.transform = `translate(${dx}px, ${dy + (1 - clamp(op)) * 16}px) scale(${scale})`;
    card.style.border = state === 'none' ? `2px dashed ${TONE.red}` : `2px solid ${state === 'signed' ? TONE.green : TONE.line}`;
    card.style.background = state === 'none' ? 'transparent' : TONE.card;
    card.style.boxShadow = state === 'none' ? 'none' : SHADOW.card;
    title.textContent = words;
    title.style.color = state === 'none' ? TONE.red : TONE.mute;
    figure.textContent = value;
    figure.style.color = state === 'none' ? TONE.red : TONE.ink;
    badge.textContent = state === 'signed' ? '✓' : '';
    badge.style.background = state === 'signed' ? TONE.green : 'transparent';
    badge.style.color = '#fff';
    badge.style.border = state === 'signed' ? 'none' : state === 'none' ? 'none' : `2px dashed ${tone}`;
    badge.style.opacity = state === 'plain' || state === 'none' ? '0' : '1';
  };
};

export const diagram = stage => {
  const { ledger: L, you, them, bar: B } = GEO;
  const root = el(stage, { inset: '0' });

  const tether = el(root, { left: `${B.x + B.w / 2 - 2}px`, top: `${L.y + L.h}px`, width: '4px', height: `${B.y - B.h / 2 - L.y - L.h}px`, background: TONE.green, borderRadius: '2px', transformOrigin: '50% 0', opacity: '0' });
  const book = el(root, { left: `${L.x}px`, top: `${L.y}px`, width: `${L.w}px`, height: `${L.h}px`, borderRadius: '32px', background: TONE.card, boxShadow: SHADOW.lift, border: `2px solid ${TONE.line}` });
  const bookTitle = el(book, { left: '40px', top: '22px', font: `800 40px ${DISPLAY}`, letterSpacing: '-0.035em', whiteSpace: 'pre' });
  const bookNote = el(book, { left: '40px', top: '76px', font: `500 24px ${UI}`, letterSpacing: '-0.01em', color: TONE.mute, whiteSpace: 'pre' });
  const field = el(book, { right: '40px', top: '24px', width: '432px', height: '78px' });
  const solo = el(book, { right: '40px', top: '48px', width: '30px', height: '30px', borderRadius: '50%', background: TONE.red });
  const keepers = el(book, { right: '500px', top: '46px', font: `600 24px ${UI}`, whiteSpace: 'pre', textAlign: 'right' });

  const track = el(root, { left: `${B.x}px`, top: `${B.y - B.h / 2}px`, width: `${B.w}px`, height: `${B.h}px` });
  const parts = Array.from({ length: 3 }, () => {
    const box = el(track, { top: '0', height: `${B.h}px`, borderRadius: '18px', display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden', font: `700 26px ${UI}`, letterSpacing: '-0.02em', whiteSpace: 'pre', fontVariantNumeric: 'tabular-nums' });
    const name = el(track, { top: `${B.h + 12}px`, transform: 'translateX(-50%)', font: `500 24px ${UI}`, color: TONE.mute, whiteSpace: 'pre' });
    return { box, name };
  });
  const marker = el(track, { top: '-16px', width: '6px', height: `${B.h + 32}px`, borderRadius: '3px', background: TONE.ink, boxShadow: '0 4px 10px rgba(10,11,13,.3)' });
  const markerName = el(track, { top: '-62px', transform: 'translateX(-50%)', font: `700 26px ${UI}`, whiteSpace: 'pre', fontVariantNumeric: 'tabular-nums' });
  const barName = el(root, { left: `${B.x + 4}px`, top: `${B.y - B.h / 2 - 66}px`, font: `700 30px ${UI}`, letterSpacing: '-0.02em', color: TONE.ink, whiteSpace: 'pre' });
  const seals = ['left', 'right'].map(side =>
    el(root, { left: `${side === 'left' ? B.x - 22 : B.x + B.w - 22}px`, top: `${B.y - 22}px`, width: '44px', height: '44px', borderRadius: '50%', font: `800 24px ${UI}`, display: 'flex', alignItems: 'center', justifyContent: 'center', boxShadow: SHADOW.card, opacity: '0' }),
  );

  const sides = { you: avatar(root, you), them: avatar(root, them) };
  const copies = { you: copyCard(root, { x: you.x, y: you.y + 170 }), them: copyCard(root, { x: them.x, y: them.y + 170 }) };
  const figure = el(root, { left: `${you.x}px`, top: `${you.y - GEO.avatar - 96}px`, transform: 'translateX(-50%)', font: `700 60px ${UI}`, letterSpacing: '-0.04em', fontVariantNumeric: 'tabular-nums', whiteSpace: 'pre' });
  const caption = el(stage, { left: '0', width: '1920px', top: `${GEO.caption}px`, textAlign: 'center', font: `800 46px ${DISPLAY}`, letterSpacing: '-0.035em', whiteSpace: 'pre' });

  return {
    root,
    /** `tone` red: one keeper; green: anyone checks; ink: not judged. `crowd` 0..1 fills the field of checkers. */
    ledger: ({ op = 0, title = '', note = '', tone = 'ink', crowd = 0, alone = 0, keepers: words = '', dy = 0 }) => {
      const tint = { red: TONE.red, green: TONE.green, ink: TONE.faint }[tone];
      book.style.opacity = String(clamp(op));
      book.style.transform = `translateY(${dy - (1 - glide(clamp(op))) * 40}px)`;
      book.style.borderColor = tone === 'ink' ? TONE.line : tint;
      bookTitle.textContent = title;
      bookNote.textContent = note;
      field.style.background = `radial-gradient(circle, ${tint} 3.4px, transparent 4px) 0 0 / 13.5px 13px`;
      field.style.clipPath = `inset(0 0 0 ${(100 - clamp(crowd) * 100).toFixed(2)}%)`;
      solo.style.opacity = String(clamp(alone));
      solo.style.transform = `scale(${spring(clamp(alone))})`;
      keepers.textContent = words;
      keepers.style.color = tint;
      keepers.style.right = `${crowd > 0.05 ? 40 + 432 * clamp(crowd) + 24 : alone > 0.5 ? 90 : 64}px`;
    },
    you: state => sides.you({ kind: 'person', ...state }),
    them: state => sides.them({ kind: 'exchange', ...state }),
    copy: (side, state) => copies[side](state),
    figure: (words, op = 1, color = TONE.ink) => {
      figure.textContent = words;
      figure.style.opacity = String(clamp(op));
      figure.style.color = color;
    },
    /**
     * `parts` is up to three `{ w, tone, label, name }` laid left to right, centred in the track;
     * `w` is in pixels. `marker` is pixels from the left end of the first part, or undefined.
     */
    bar: ({ op = 0, parts: shown = [], marker: at, markerName: words = '', name = '', gap = 6, shake = 0, split = 0 }) => {
      const live = shown.filter(part => part.w > 0.5);
      const total = shown.reduce((sum, part) => sum + part.w, 0) + gap * Math.max(live.length - 1, 0);
      let x = (B.w - total) / 2 + shake;
      track.style.opacity = String(clamp(op));
      parts.forEach(({ box, name: under }, index) => {
        const part = shown[index];
        if (!part || part.w <= 0.5) {
          box.style.opacity = '0';
          under.style.opacity = '0';
          return;
        }
        const half = index < shown.length / 2 ? -1 : 1;
        Object.assign(box.style, FILL[part.tone], { left: `${x + half * split * (shown.length === 1 ? 0 : 1)}px`, width: `${part.w}px`, opacity: String(part.op ?? 1) });
        box.textContent = part.w > (part.label ?? '').length * 14 + 30 ? (part.label ?? '') : '';
        under.textContent = part.name ?? '';
        under.style.left = `${x + part.w / 2}px`;
        under.style.opacity = String(part.w > 36 ? (part.op ?? 1) : 0);
        x += part.w + gap;
      });
      const start = (B.w - total) / 2;
      marker.style.opacity = at === undefined ? '0' : '1';
      marker.style.left = `${start + (at ?? 0) - 3}px`;
      markerName.textContent = words;
      markerName.style.left = `${start + (at ?? 0)}px`;
      markerName.style.opacity = at === undefined ? '0' : '1';
      barName.textContent = name;
      barName.style.opacity = String(clamp(op));
    },
    /** Signature seals at the two ends of the bar: 0 absent, hollow red when `missing`, green check when signed. */
    seals: ({ op = 0, you: mine = 0, them: theirs = 0 }) =>
      [mine, theirs].forEach((signed, index) => {
        const seal = seals[index];
        seal.style.opacity = String(clamp(op));
        seal.style.background = signed > 0.5 ? TONE.green : TONE.card;
        seal.style.border = signed > 0.5 ? `2px solid ${TONE.green}` : `2px dashed ${TONE.red}`;
        seal.style.color = '#fff';
        seal.textContent = signed > 0.5 ? '✓' : '';
        seal.style.transform = `scale(${signed > 0 && signed < 1 ? 0.7 + 0.3 * spring(signed) : 1})`;
      }),
    tether: p => {
      tether.style.opacity = p > 0 ? '1' : '0';
      tether.style.transform = `scaleY(${glide(p)})`;
    },
    caption: (words, op = 1, color = TONE.ink) => {
      caption.textContent = words;
      caption.style.color = color;
      rise(caption, clamp(op), 18);
    },
    dim: (op, blur = 0) => {
      root.style.opacity = String(op);
      root.style.filter = blur > 0.05 ? `blur(${blur.toFixed(1)}px)` : 'none';
    },
  };
};

/** The soft paper every chapter stands on. */
export const backdrop = stage => {
  el(stage, { inset: '0', background: `radial-gradient(1200px 700px at 50% 38%, #FFFFFF 0%, ${TONE.bg} 60%), ${TONE.bg}` });
  return el(stage, { left: '460px', top: '120px', width: '1000px', height: '840px', background: 'radial-gradient(closest-side, rgba(31,79,255,.08), rgba(31,79,255,0))' });
};

/** The strongest caption of several `[opacity, words, color]`; the first wins a tie. */
export const pick = lines => lines.reduce((best, next) => (next[0] > best[0] ? next : best));

/** The closing lockup: the mark, where to find it, and where it stands today. Returns `op => …`. */
export const lockup = (parent, status) => {
  const mark = el(parent, { left: '0', width: '1920px', top: '318px', textAlign: 'center', font: `800 210px ${DISPLAY}`, letterSpacing: '-0.07em', lineHeight: '1', color: TONE.ink }, 'xln');
  const link = el(parent, { left: '0', width: '1920px', top: '566px', textAlign: 'center', font: `600 46px ${UI}`, letterSpacing: '-0.02em', color: TONE.ink }, 'xln.finance');
  const note = el(parent, { left: '0', width: '1920px', top: '650px', textAlign: 'center', font: `500 30px ${UI}`, letterSpacing: '-0.01em', color: '#9A6200' }, status);
  return op => {
    rise(mark, clamp(op), 30);
    rise(link, clamp(op * 2 - 0.6), 18);
    rise(note, clamp(op * 2 - 1), 14);
  };
};

const WOOD = { fill: 'linear-gradient(180deg, #EFDDBE, #E2C99F)', edge: '#C7A46D', cut: '#7A5A2B' };

/**
 * A tally stick: one notched stick split lengthwise into two unequal pieces, the longer for the
 * creditor. `update({ op, cut, apart, shave })`: `cut` 0..1 makes the notches, `apart` is pixels
 * between the pieces, `shave` 0..1 removes one notch from the upper piece.
 */
export const tally = (parent, { x, y, w, h, notches = 10, shaved = 6 }) => {
  const root = el(parent, { left: `${x}px`, top: `${y}px`, width: `${w}px`, height: `${h}px` });
  const places = Array.from({ length: notches }, (_, index) => 0.07 * w + ((0.68 * w) / (notches - 1)) * index + (index % 3 === 1 ? 0.012 * w : 0));
  const piece = top => {
    const body = el(root, { left: '0', top: top ? '0' : `${h / 2}px`, width: `${top ? w : w * 0.82}px`, height: `${h / 2}px`, background: WOOD.fill, border: `2px solid ${WOOD.edge}`, borderRadius: top ? `${h * 0.16}px ${h * 0.16}px 4px 4px` : `4px 4px ${h * 0.16}px ${h * 0.16}px`, boxShadow: SHADOW.card, overflow: 'hidden' });
    const cuts = places.map(at => el(body, { left: `${at}px`, top: top ? `${h * 0.14}px` : '-2px', width: `${Math.max(5, w * 0.008)}px`, height: `${h / 2 - h * 0.12}px`, borderRadius: '3px', background: WOOD.cut }));
    return { body, cuts };
  };
  const pieces = [piece(true), piece(false)];
  return {
    root,
    notchX: index => x + places[index],
    update: ({ op = 1, cut = 1, apart = 0, shave = 0 }) => {
      root.style.opacity = String(clamp(op));
      pieces.forEach(({ body, cuts }, index) => {
        body.style.transform = `translateY(${(index ? 1 : -1) * apart}px)`;
        cuts.forEach((notch, n) => (notch.style.opacity = String(clamp(cut * (notches + 1) - n) * (index === 0 && n === shaved ? 1 - shave : 1))));
      });
    },
  };
};

/** The nine pages: a sheet with the header of the message that carried them. `w` sets its size. */
export const paper = (parent, { x, y, w }) => {
  const k = w / 520;
  const sheet = el(parent, { left: `${x - w / 2}px`, top: `${y}px`, width: `${w}px`, height: `${w * 1.24}px`, borderRadius: `${14 * k}px`, background: '#FFFFFF', border: `1px solid ${TONE.line}`, boxShadow: SHADOW.lift, transformOrigin: '50% 50%' });
  [['From:', 'Satoshi Nakamoto'], ['Date:', '31 Oct 2008'], ['Subject:', 'Bitcoin P2P e-cash paper']].forEach(([key, value], index) => {
    el(sheet, { left: `${44 * k}px`, top: `${(48 + index * 40) * k}px`, font: `400 ${21 * k}px ${MONO}`, color: TONE.faint, whiteSpace: 'pre' }, key);
    el(sheet, { left: `${176 * k}px`, top: `${(48 + index * 40) * k}px`, font: `400 ${21 * k}px ${MONO}`, color: TONE.ink, whiteSpace: 'pre' }, value);
  });
  el(sheet, { left: `${44 * k}px`, right: `${44 * k}px`, top: `${186 * k}px`, height: '1px', background: TONE.line });
  Array.from({ length: 13 }, (_, n) => el(sheet, { left: `${44 * k}px`, top: `${(216 + n * 28) * k}px`, width: `${(n % 5 === 4 ? 250 : 432 - (n % 3) * 26) * k}px`, height: `${8 * k}px`, borderRadius: `${4 * k}px`, background: TONE.wash }));
  el(sheet, { right: `${44 * k}px`, bottom: `${34 * k}px`, font: `600 ${20 * k}px ${UI}`, color: TONE.mute }, '9 pages');
  return sheet;
};

/** The J/E/A mark: a square (jurisdiction) holding two circles (entities) joined by a bar (account). */
export const jeaMark = (parent, { x, y, size, color = TONE.ink }) => {
  const node = el(parent, { left: `${x}px`, top: `${y}px`, width: `${size}px`, height: `${size}px`, transform: 'translate(-50%, -50%)' });
  node.innerHTML = `<svg viewBox="0 0 120 120" width="${size}" height="${size}" fill="none" stroke="${color}" stroke-width="5" stroke-linecap="round">
    <rect x="6" y="6" width="108" height="108" rx="6"/>
    <line x1="46" y1="60" x2="74" y2="60"/>
    <circle cx="36" cy="60" r="11"/><circle cx="84" cy="60" r="11"/></svg>`;
  return node;
};
