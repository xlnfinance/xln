// Part 0 · twelve thousand. The app, the button that does nothing, the million other screens, the
// blockchain that ran fine without your money on it, and the screenshot nobody signed.

import { clamp, lerp } from '../engine/core.js';
import { DISPLAY, MONO, SHADOW, TONE, UI, chip, el, glide, noise, paper, phone, rise, spring, tally } from './sleek.js';

const WALL = { cols: 17, rows: 5, w: 96, h: 170, px: 112, py: 200, you: { col: 8, row: 2 } };
const CHAIN = { size: 116, pitch: 172, y: 250, speed: 46, count: 14 };
const TABLE = { x: 500, y: 520, w: 920, row: 62, you: 2 };

const wall = (parent, T) => {
  const root = el(parent, { inset: '0' });
  const random = noise(2022);
  const x0 = 960 - ((WALL.cols - 1) * WALL.px) / 2;
  const y0 = 525 - WALL.you.row * WALL.py;
  const cells = [];
  for (let row = 0; row < WALL.rows; row += 1)
    for (let col = 0; col < WALL.cols; col += 1) {
      const mine = col === WALL.you.col && row === WALL.you.row;
      const [cx, cy] = [x0 + col * WALL.px, y0 + row * WALL.py];
      const card = el(root, {
        left: `${cx - WALL.w / 2}px`, top: `${cy - WALL.h / 2}px`, width: `${WALL.w}px`, height: `${WALL.h}px`, borderRadius: '20px', background: TONE.card,
        border: mine ? `3px solid ${TONE.accent}` : `1px solid ${TONE.line}`, boxShadow: mine ? SHADOW.lift : SHADOW.card,
      });
      const amount = mine ? 12000 : Math.round(Math.pow(random(), 2.4) * 900 + 2) * 50;
      el(card, { left: '12px', top: '26px', width: '34px', height: '5px', borderRadius: '3px', background: TONE.line });
      el(card, { left: '12px', top: '40px', font: `700 15px ${UI}`, letterSpacing: '-0.02em', color: mine ? TONE.ink : TONE.mute }, `$${T.num(amount)}`);
      el(card, { left: '12px', right: '12px', top: '72px', height: '30px', borderRadius: '8px', background: `linear-gradient(180deg, ${TONE.wash}, rgba(243,244,246,0))` });
      el(card, { left: '12px', right: '12px', bottom: '16px', height: '20px', borderRadius: '7px', background: TONE.wash });
      cells.push({ card, mine, far: Math.hypot(col - WALL.you.col, (row - WALL.you.row) * 1.5) });
    }
  const reach = Math.max(...cells.map(cell => cell.far));
  /** `spread` 0..1 lets the screens arrive outward from yours; `op` fades the whole wall. */
  return (spread, op, yours) => {
    root.style.opacity = String(op);
    cells.forEach(({ card, mine, far }) => {
      const p = mine ? yours : spring(clamp(spread * 1.9 - (far / reach) * 0.9));
      card.style.opacity = String(clamp(p * 1.4));
      card.style.transform = `scale(${0.82 + 0.18 * p})`;
    });
  };
};

const chain = (parent, T) => {
  const root = el(parent, { left: '0', top: `${CHAIN.y - 30}px`, width: '1920px', height: `${CHAIN.size + 60}px`, WebkitMaskImage: 'linear-gradient(90deg, transparent 4%, #000 22%, #000 78%, transparent 96%)' });
  el(root, { left: '0', right: '0', top: `${30 + CHAIN.size / 2 - 1}px`, height: '2px', background: TONE.line });
  const blocks = Array.from({ length: CHAIN.count }, () => {
    const card = el(root, { top: '30px', width: `${CHAIN.size}px`, height: `${CHAIN.size}px`, borderRadius: '28px', background: TONE.card, border: `1px solid ${TONE.line}`, boxShadow: SHADOW.card });
    const tick = el(card, { left: '38px', top: '22px', width: '40px', height: '40px', borderRadius: '50%', background: TONE.greenWash, color: TONE.green, font: `800 22px ${UI}`, display: 'flex', alignItems: 'center', justifyContent: 'center' }, '✓');
    const height = el(card, { left: '0', right: '0', top: '76px', textAlign: 'center', font: `400 15px ${MONO}`, color: TONE.mute });
    return { card, tick, height };
  });
  /** Blocks slide left at a steady pace; the newest lands on the right and gets its check. */
  return (seconds, op) => {
    root.style.opacity = String(op);
    const travelled = Math.max(seconds, 0) * CHAIN.speed;
    const first = Math.floor(travelled / CHAIN.pitch);
    blocks.forEach(({ card, tick, height }, index) => {
      const x = 1920 - 250 - (travelled - (first + index - (CHAIN.count - 3)) * CHAIN.pitch);
      const born = clamp((1920 - 250 - x) / 60);
      card.style.left = `${x.toFixed(1)}px`;
      card.style.opacity = String(born);
      card.style.transform = `scale(${0.86 + 0.14 * spring(born)})`;
      tick.style.opacity = String(clamp((1920 - 330 - x) / 50));
      height.textContent = `#${T.num(15933100 + first + index)}`;
    });
  };
};

const table = (parent, T) => {
  const random = noise(48213);
  const rows = 5;
  const root = el(parent, { left: `${TABLE.x}px`, top: `${TABLE.y}px`, width: `${TABLE.w}px`, height: `${86 + rows * TABLE.row + 18}px`, borderRadius: '28px', background: TONE.card, border: `1px solid ${TONE.line}`, boxShadow: SHADOW.lift, fontFamily: UI, color: TONE.ink });
  el(root, { left: '36px', top: '28px', font: `700 24px ${UI}`, letterSpacing: '-0.02em' }, T.s('table'));
  el(root, { right: '36px', top: '26px', padding: '7px 14px', borderRadius: '999px', background: TONE.wash, font: `600 16px ${UI}`, color: TONE.mute }, T.s('private'));
  const glow = el(root, { left: '14px', right: '14px', top: `${86 + TABLE.you * TABLE.row}px`, height: `${TABLE.row}px`, borderRadius: '16px', background: 'rgba(31,79,255,.08)', border: `2px solid ${TONE.accent}` });
  const lines = Array.from({ length: rows }, (_, index) => {
    const mine = index === TABLE.you;
    const top = 86 + index * TABLE.row;
    const line = el(root, { left: '0', right: '0', top: `${top}px`, height: `${TABLE.row}px` });
    if (index) el(line, { left: '36px', right: '36px', top: '0', height: '1px', background: TONE.line, opacity: mine || index === TABLE.you + 1 ? '0' : '1' });
    el(line, { left: '36px', top: '19px', font: `400 19px ${MONO}`, color: mine ? TONE.accent : TONE.faint }, mine ? T.s('yourRow') : `user_${String(Math.floor(random() * 900000 + 100000))}`);
    el(line, { right: '36px', top: '17px', font: `${mine ? 700 : 500} 21px ${UI}`, fontVariantNumeric: 'tabular-nums', color: mine ? TONE.ink : TONE.faint }, `$${T.num(mine ? 12000 : Math.round(Math.pow(random(), 2) * 80000 + 40), 2)}`);
    return line;
  });
  return (shown, found) => {
    rise(root, glide(shown), 46);
    lines.forEach((line, index) => (line.style.opacity = String(clamp(shown * 2.4 - index * 0.28) * (index === TABLE.you ? 1 : 1 - 0.45 * found))));
    glow.style.opacity = String(found);
    glow.style.transform = `scale(${1.04 - 0.04 * spring(found)})`;
  };
};

export default {
  strings: {
    date: 'May 2024',
    total: 'Total balance',
    available: 'USD · available',
    assets: 'ASSETS',
    withdraw: 'Withdraw',
    deposit: 'Deposit',
    busy: 'Processing',
    paused: 'Withdrawals paused',
    disabled: 'Withdrawals are temporarily disabled',
    people: 'people looking at a number like yours',
    missing: 'frozen behind those numbers',
    court: '8 months',
    courtSays: 'until most of it came back',
    chain: 'Blockchain',
    live: 'no bank failed · deposit insurance did not apply',
    never: 'its list did not match the bank’s',
    table: 'the company in between · its list',
    private: 'not the bank’s records',
    yourRow: 'you',
    shot: 'Screenshot',
    proof: 'What you can prove',
    amount: 'A number on a screen',
    theirs: 'Where it is written',
    yours: 'Who can give it back',
    nobody: 'their books',
    none: 'them, or a judge',
    promise: "A screenshot is a picture of someone else's promise.",
    unsigned: 'Signed by: nobody',
    england: 'England · about 1100',
    pages: 'A mailing list · 31 October 2008',
    both: 'Both are about your $12,000.',
  },

  setup(stage, kit, T) {
    const s = key => T.s(key);
    const money = `$${T.num(12000, 2)}`;
    el(stage, { inset: '0', background: `radial-gradient(1200px 700px at 50% 38%, #FFFFFF 0%, ${TONE.bg} 60%), ${TONE.bg}` });
    const glow = el(stage, { left: '460px', top: '120px', width: '1000px', height: '840px', background: 'radial-gradient(closest-side, rgba(31,79,255,.10), rgba(31,79,255,0))' });
    const cam = el(stage, { inset: '0', transformOrigin: '0 0' });
    const screens = wall(cam, T);
    const blocks = chain(cam, T);
    const chainName = el(cam, { left: '500px', top: '128px', font: `800 44px ${DISPLAY}`, letterSpacing: '-0.035em', color: TONE.ink }, s('chain'));
    const live = chip(cam, { x: 960, y: 372, words: s('live'), tone: 'red', size: 24 });
    const never = chip(cam, { x: 960, y: 436, words: s('never'), tone: 'red', size: 24 });
    const rows = table(cam, T);
    const device = phone(cam, { x: 960, y: 540, brand: 'Savings', balance: money, rows: [['$', 'Savings', money, TONE.green], ['%', 'Interest', '$0.00', TONE.faint], ['▭', 'Card', '$0.00', TONE.faint]], labels: { total: s('total'), available: s('available'), assets: s('assets'), withdraw: s('withdraw'), deposit: s('deposit'), busy: s('busy'), paused: s('paused'), disabled: s('disabled') } });
    const date = chip(stage, { x: 960, y: 56, words: s('date'), tone: 'mute', size: 22 });

    // The numbers behind the wall of screens.
    const veil = el(stage, { left: '0', right: '0', bottom: '0', height: '520px', background: `linear-gradient(0deg, ${TONE.bg} 46%, rgba(251,251,250,0))` });
    const stat = el(stage, { left: '0', width: '1920px', top: '700px', textAlign: 'center', font: `800 148px ${DISPLAY}`, letterSpacing: '-0.05em', fontVariantNumeric: 'tabular-nums', color: TONE.ink });
    const statName = el(stage, { left: '0', width: '1920px', top: '892px', textAlign: 'center', font: `500 34px ${UI}`, letterSpacing: '-0.015em', color: TONE.mute });

    // The screenshot: the same screen, detached, and the short list of what it proves.
    const shot = el(stage, { left: '0', top: '0', width: '356px', height: '756px', borderRadius: '52px', overflow: 'hidden', boxShadow: SHADOW.lift, border: `1px solid ${TONE.line}`, transformOrigin: '0 0', background: TONE.card });
    device.update({ paused: 1 });
    shot.appendChild(device.copy());
    device.update({});
    Object.assign(shot.firstChild.style, { inset: '0', borderRadius: '0' });
    const shotName = el(stage, { font: `600 22px ${UI}`, color: TONE.mute, transform: 'translateX(-50%)', whiteSpace: 'pre' }, `${s('shot')} · IMG_4127.PNG`);
    const panel = el(stage, { left: '1210px', top: '330px', width: '560px', fontFamily: UI, color: TONE.ink });
    el(panel, { position: 'relative', font: `800 40px ${DISPLAY}`, letterSpacing: '-0.035em', marginBottom: '26px' }, s('proof'));
    const checks = [[s('amount'), money, 'mute'], [s('theirs'), s('nobody'), 'red'], [s('yours'), s('none'), 'red']].map(([name, value, tone]) => {
      const row = el(panel, { position: 'relative', height: '78px', borderTop: `1px solid ${TONE.line}`, display: 'flex', alignItems: 'center', justifyContent: 'space-between', font: `500 26px ${UI}`, letterSpacing: '-0.015em' });
      row.append(name);
      const mark = document.createElement('span');
      Object.assign(mark.style, { padding: '7px 16px', borderRadius: '999px', font: `700 22px ${UI}`, background: tone === 'red' ? TONE.redWash : TONE.wash, color: tone === 'red' ? TONE.red : TONE.mute, fontVariantNumeric: 'tabular-nums' });
      mark.textContent = value;
      row.appendChild(mark);
      return row;
    });
    const promise = el(stage, { left: '0', width: '1920px', top: '868px', textAlign: 'center', font: `800 54px ${DISPLAY}`, letterSpacing: '-0.04em', color: TONE.ink }, s('promise'));
    const unsigned = chip(stage, { x: 960, y: 838, words: s('unsigned'), tone: 'red', size: 32 });
    // Two other moments, each a frame of its own: dark, one object, nothing else.
    const night = el(stage, { inset: '0', background: '#0A0B0D' });
    const stick = tally(night, { x: 360, y: 440, w: 1200, h: 170 });
    const stickName = chip(night, { x: 960, y: 300, words: s('england'), tone: 'ink', size: 26 });
    const page = paper(night, { x: 960, y: 190, w: 560 });
    const pageName = chip(night, { x: 960, y: 110, words: s('pages'), tone: 'ink', size: 26 });
    const both = el(stage, { left: '0', width: '1920px', top: '852px', textAlign: 'center', font: `800 50px ${DISPLAY}`, letterSpacing: '-0.04em', whiteSpace: 'pre' }, s('both'));
    return { night, stick, stickName, page, pageName, both, T, glow, cam, screens, blocks, chainName, live, never, rows, device, date, veil, stat, statName, shot, shotName, panel, checks, promise, unsigned };
  },

  frame(h, T) {
    const at = (id, fraction, dur = 0.6, kind = 'out') => T.p(id, T.frac(id, fraction), dur, kind);
    const gone = (id, dur = 0.45) => 1 - T.p(id, 0, dur);

    // 0.1 · close on the number, back to the whole phone, the press that changes nothing.
    const pull = glide(T.p('0.1', T.frac('0.1', 0.3), 2.6, 'linear'));
    const z = lerp(2.25, 1, pull);
    const [cx, cy] = [960, lerp(346, 540, pull)];
    const tap = T.frac('0.1', 0.62);
    const touching = T.p('0.1', tap - 0.5, 0.3, 'out') * (1 - T.p('0.1', tap + 0.35, 0.3));
    const press = T.p('0.1', tap, 0.14, 'out') * (1 - T.p('0.1', tap + 0.2, 0.3, 'out'));
    const busy = T.since('0.1') > tap + 0.15 ? 1 : 0;
    const paused = T.p('0.1', T.frac('0.1', 0.86), 0.7, 'linear');

    // 0.2 · your phone becomes one screen among a million.
    const shrink = glide(T.p('0.2', 0.1, 1.5, 'linear'));
    const spread = T.p('0.2', 0.5, 3.2, 'linear');
    const settle = T.p('0.2', 1.1, 0.5);
    const wallOp = T.p('0.2', 0.2, 0.4) * gone('0.3', 0.6);
    const drift = 1.07 - 0.07 * T.p('0.2', 0, T.beat('0.2').end - T.beat('0.2').start, 'linear');
    h.cam.style.transform = T.since('0.2') < 0 ? `translate(${960 - cx * z}px, ${540 - cy * z}px) scale(${z})` : `translate(${960 * (1 - drift)}px, ${525 * (1 - drift)}px) scale(${wallOp > 0 ? drift : 1})`;
    h.screens(spread, wallOp, settle);

    // 0.4 · the phone returns, the screen is captured, and the capture is all you hold.
    const back = at('0.4', 0.02, 0.9);
    const snap = T.frac('0.4', 0.03);
    const flash = T.p('0.4', snap, 0.08, 'linear') * (1 - T.p('0.4', snap + 0.08, 0.45, 'out'));
    const fly = spring(T.p('0.4', snap + 0.1, 1.1, 'linear'));
    const keep = glide(T.p('0.4', T.frac('0.4', T.mark('0.4', 'Nine hundred years ago')) - 0.9, 1.2, 'linear'));
    const scale = T.since('0.2') < 0 ? 1 : T.since('0.4') < 0 ? lerp(1, 0.218, shrink) : 0.76;
    const [px, py] = T.since('0.4') < 0 ? [0, lerp(0, -15, shrink)] : [lerp(-400, -470, fly), -20];
    h.device.root.style.transform = `translate(${px}px, ${py}px) scale(${scale})`;
    h.device.root.style.opacity = String(T.since('0.4') < 0 ? 1 - settle : back * (1 - keep));
    h.device.update({ touching, press, wave: T.p('0.1', tap, 0.6, 'out'), busy, paused, spin: T.t, flash });
    h.glow.style.opacity = String(gone('0.2') + back);
    h.date.style.opacity = String(T.p('0.1', 0.1, 0.5) * gone('0.2'));

    const said2 = phrase => T.p('0.2', T.frac('0.2', T.mark('0.2', phrase)), 0.5, 'linear');
    const frozen = said2('two hundred and nineteen');
    const later = said2('Eight months later');
    const statOp = frozen * gone('0.3', 0.4);
    h.veil.style.opacity = String(statOp);
    const grown = Math.round(219 * glide(T.p('0.2', T.frac('0.2', T.mark('0.2', 'two hundred and nineteen')) + 0.1, 1.2, 'linear')));
    h.stat.textContent = later > 0.5 ? T.s('court') : `$${T.num(grown * 1e6)}`;
    h.stat.style.color = later > 0.5 ? TONE.ink : TONE.red;
    h.stat.style.opacity = String(statOp * Math.abs(2 * later - 1));
    h.statName.textContent = T.s(later > 0.5 ? 'courtSays' : 'missing');
    h.statName.style.opacity = String(statOp * Math.abs(2 * later - 1));

    // 0.3 · the chain above runs; your money is a row in a table below it.
    const chainOp = 0;
    h.blocks(T.since('0.3') + 6, chainOp);
    rise(h.chainName, chainOp, 18);
    h.live.style.opacity = String(at('0.3', 0.8) * gone('0.4'));
    h.rows(at('0.3', 0.18, 0.9, 'linear') * gone('0.4'), at('0.3', 0.36, 0.7, 'linear') * gone('0.4'));
    const never = at('0.3', 0.56, 0.6, 'linear') * gone('0.4');
    h.never.style.opacity = String(never);
    h.never.style.transform = `translateX(-50%) scale(${0.9 + 0.1 * spring(never)})`;

    // The capture leaves the phone, lands beside it, and at the end stands alone.
    const from = { x: 960 - 400 - 0.76 * 178, y: 520 - 0.76 * 378, s: 0.76 };
    const land = { x: 850, y: 256, s: 0.6 };
    const alone = { x: 960 - 0.9 * 178, y: 110, s: 0.9 };
    const mix = (a, b, p) => ({ x: lerp(a.x, b.x, p), y: lerp(a.y, b.y, p), s: lerp(a.s, b.s, p) });
    const spot = mix(mix(from, land, fly), alone, keep);
    const tilt = -4 * fly * (1 - keep);
    h.shot.style.opacity = String(T.since('0.4') > snap + 0.08 ? 1 : 0);
    h.shot.style.transform = `translate(${spot.x}px, ${spot.y}px) scale(${spot.s}) rotate(${tilt}deg)`;
    h.shotName.style.left = `${spot.x + spot.s * 178}px`;
    h.shotName.style.top = `${spot.y - 44}px`;
    h.shotName.style.opacity = String(clamp(fly) * (1 - keep));
    const listed = T.since('0.4') - T.frac('0.4', T.mark('0.4', 'A screenshot is a picture'));
    h.panel.style.opacity = String(clamp(listed / 0.4) * (1 - keep));
    h.checks.forEach((row, index) => rise(row, glide(clamp((listed - 0.25 - index * 0.55) / 0.5)), 20));
    rise(h.promise, at('0.4', T.mark('0.4', 'A screenshot is a picture'), 0.7, 'linear') * (1 - keep), 26);
    // Two cuts to black: the stick, then the nine pages; then back to the screenshot.
    const m4 = (phrase, dur = 0.35) => T.p('0.4', T.frac('0.4', T.mark('0.4', phrase)), dur, 'linear');
    const [sticked, paged, home] = [m4('Nine hundred years ago'), 0, 0];
    h.night.style.opacity = String(sticked * (1 - home));
    h.stick.update({ op: 1 - paged, cut: 1, apart: 34 * glide(m4('walked home', 0.9)) });
    h.stickName.style.opacity = String(1 - paged);
    h.page.style.opacity = String(paged);
    h.page.style.transform = `translateY(${(1 - glide(paged)) * 40}px)`;
    h.pageName.style.opacity = String(paged);
    h.both.style.opacity = '0';
    h.unsigned.style.opacity = String(keep);
    h.unsigned.style.transform = `translateX(-50%) scale(${0.9 + 0.1 * spring(keep)})`;
  },
};
