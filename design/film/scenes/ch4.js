// Part 3 · the stick and the channel. The tally stick gave both sides a matching piece nine hundred
// years ago, and could not pay. A payment channel locks money and signs every balance, and stops at
// the edge of what was locked. Two half accounts; the whole one is missing.

import { lerp } from '../engine/core.js';
import { DISPLAY, GEO, TONE, UI, backdrop, chip, diagram, el, glide, paper, phone, pick, rise, spring, tally } from './sleek.js';

const STICK = { x: 360, y: 300, w: 1200, h: 170, shaved: 6 };
const ROWS = [300, 470, 640];

export default {
  strings: {
    tally: 'England · about 1100 · the tally stick',
    yours: 'your piece',
    theirs: 'their piece',
    mismatch: 'shave your piece: it no longer matches theirs',
    held: 'Both sides walked home holding the debt.',
    shot: 'In 2024, you walked home with a screenshot.',
    cannot: 'A stick proves a debt.\nIt cannot pay one.',
    brand: 'Savings',
    total: 'Total balance',
    available: 'USD · available',
    assets: 'ASSETS',
    withdraw: 'Withdraw',
    deposit: 'Deposit',
    paused: 'Withdrawals paused',
    disabled: 'Withdrawals are temporarily disabled',
    you: 'you',
    exchange: 'exchange',
    chain: 'A programmable blockchain',
    chainNote: 'a book that also runs contracts',
    checkers: 'thousands of computers check every line',
    locked: 'locked',
    collateral: 'collateral · the exchange cannot move it alone',
    c1: 'To pay, money must sit where the debtor cannot reach it alone.',
    c2: 'Both of you sign every new balance. Each keeps a copy.',
    channel: 'Payment channel',
    yourCopy: 'your copy',
    theirCopy: 'their copy',
    payday: 'salary',
    c3: 'Every locked dollar is already yours. The exchange locked nothing.',
    c4: 'Every dollar you receive must be locked in advance by someone.',
    bankRow: 'Bank account',
    bankSays: 'pays at once · signs nothing',
    channelRow: 'Payment channel',
    channelSays: 'signs everything · stops at the edge',
    wholeRow: 'The whole account',
    wholeSays: 'almost nobody holds it',
    creditOnly: 'credit only',
    collateralOnly: 'collateral only',
    c5: 'Your money has always lived in half an account.',
  },

  setup(stage, kit, T) {
    backdrop(stage);
    const d = diagram(stage);
    const old = el(stage, { inset: '0' });
    chip(old, { x: 960, y: 170, words: T.s('tally'), tone: 'mute', size: 24 });
    const stick = tally(old, { ...STICK, shaved: STICK.shaved });
    const names = [el(old, { left: `${STICK.x - 30}px`, top: `${STICK.y + 22}px`, transform: 'translateX(-100%)', font: `600 26px ${UI}`, whiteSpace: 'pre' }, T.s('yours')), el(old, { left: `${STICK.x + STICK.w * 0.82 + 30}px`, top: `${STICK.y + STICK.h / 2 + 24}px`, font: `600 26px ${UI}`, whiteSpace: 'pre' }, T.s('theirs'))];
    const ring = el(old, { left: `${stick.notchX(STICK.shaved) - 30}px`, top: `${STICK.y - 14}px`, width: '70px', height: `${STICK.h + 28}px`, borderRadius: '22px', border: `4px solid ${TONE.red}` });
    const mismatch = chip(old, { x: stick.notchX(STICK.shaved) + 4, y: STICK.y + STICK.h + 40, words: T.s('mismatch'), tone: 'red', size: 24 });
    const labels = Object.fromEntries(['total', 'available', 'assets', 'withdraw', 'deposit'].map(key => [key, T.s(key)]));
    const device = phone(old, { x: 960, y: 742, brand: T.s('brand'), balance: `$${T.num(12000, 2)}`, labels: { ...labels, busy: '', paused: T.s('paused'), disabled: T.s('disabled') } });
    const cannot = el(stage, { left: '0', width: '1920px', top: '400px', textAlign: 'center', font: `800 96px ${DISPLAY}`, letterSpacing: '-0.05em', lineHeight: '1.12', whiteSpace: 'pre' }, T.s('cannot'));

    // The payment and the two pieces of the stick live inside the diagram, so the camera carries them.
    const pay = chip(d.root, { x: 0, y: GEO.bar.y - 110, words: `+$${T.num(2000)} ${T.s('payday')}`, tone: 'ink', size: 24 });
    const tag = chip(d.root, { x: GEO.bar.x + GEO.bar.w / 2 + 210, y: 404, words: T.s('channel'), tone: 'green', size: 26 });
    const pieces = [tally(d.root, { x: 830, y: 380, w: 260, h: 60, notches: 6 }), tally(d.root, { x: 830, y: 380, w: 260, h: 60, notches: 6 })];

    const table = el(stage, { inset: '0' });
    const rows = [
      ['bankRow', 'bankSays', 'red', 'creditOnly'],
      ['channelRow', 'channelSays', 'green', 'collateralOnly'],
      ['wholeRow', 'wholeSays', 'empty', ''],
    ].map(([name, says, tone, inside], index) => {
      const row = el(table, { left: '0', top: `${ROWS[index]}px`, width: '1920px', height: '110px' });
      el(row, { left: '250px', top: '4px', font: `800 40px ${DISPLAY}`, letterSpacing: '-0.035em', whiteSpace: 'pre' }, T.s(name));
      el(row, { left: '252px', top: '60px', font: `500 26px ${UI}`, color: tone === 'empty' ? TONE.red : TONE.mute, whiteSpace: 'pre' }, T.s(says));
      const fill = { red: { background: TONE.redWash, border: `2px solid ${TONE.red}`, color: TONE.red }, green: { background: TONE.green, border: `2px solid ${TONE.green}`, color: '#fff' }, empty: { background: 'transparent', border: `3px dashed ${TONE.faint}`, color: TONE.faint } }[tone];
      el(row, { left: '860px', top: '14px', width: '810px', height: '72px', borderRadius: '20px', display: 'flex', alignItems: 'center', justifyContent: 'center', font: `700 26px ${UI}`, ...fill }, inside ? T.s(inside) : '?');
      return row;
    });
    const pages = paper(d.root, { x: 960, y: 300, w: 124 });
    return { d, old, stick, names, ring, mismatch, device, cannot, pay, tag, pieces, pages, table, rows };
  },

  frame(h, T) {
    const { d } = h;
    const m = (id, phrase, dur = 0.5) => T.p(id, T.frac(id, T.mark(id, phrase)), dur, 'linear');
    const money = `$${T.num(12000, 2)}`;

    // 3.1 · the stick: cut, split, shaved, held by both.
    h.old.style.opacity = String(T.win('4.1', '4.2', 0.6, 0.5));
    const split = glide(m('4.1', 'split it lengthwise', 0.9));
    const shaved = m('4.1', 'Shave your piece') * (1 - m('4.1', 'Both sides walked', 0.4));
    const refit = glide(m('4.1', 'no longer matches')) * (1 - m('4.1', 'Both sides walked', 0.4));
    const apart = 56 * split * (1 - refit);
    h.stick.update({ cut: m('4.1', 'cut a debt as notches', 1.6), apart, shave: shaved });
    h.names.forEach((name, index) => {
      name.style.opacity = String(split);
      name.style.transform = `${index ? '' : 'translateX(-100%) '}translateY(${(index ? 1 : -1) * apart}px)`;
    });
    h.ring.style.opacity = String(refit);
    h.mismatch.style.opacity = String(refit);
    const phoned = m('4.1', 'In 2024', 0.6);
    h.device.root.style.opacity = String(phoned);
    h.device.root.style.transform = `translateY(${(1 - spring(phoned)) * 60}px) scale(0.34)`;
    h.device.update({ paused: 1 });

    // 3.2 · nothing on screen but the sentence.
    const bare = T.win('4.2', '4.3', 0.5, 0.4);
    h.cannot.style.opacity = String(bare);
    h.cannot.style.transform = `scale(${0.96 + 0.04 * glide(T.p('4.2', 0, 1.6, 'linear'))})`;

    // 3.3–3.5 · the channel: lock, sign, and the payment that stops at the edge.
    const live = T.win('4.3', '4.6', 0.6, 0.5);
    const zoom = glide(m('4.5', 'The payment hits', 0.7)) * (1 - glide(m('4.5', 'Every dollar you receive', 0.8)));
    d.dim(live);
    d.root.style.transformOrigin = `${GEO.bar.x + GEO.bar.w}px ${GEO.bar.y}px`;
    d.root.style.transform = `scale(${1 + 0.55 * zoom})`;
    d.ledger({ op: T.p('4.3', 0.1, 0.7), title: T.s('chain'), note: T.s('chainNote'), tone: 'green', crowd: 1 });
    d.you({ op: T.p('4.3', 0, 0.5), name: T.s('you') });
    d.them({ op: T.p('4.3', 0.15, 0.5), name: T.s('exchange') });
    d.figure(money, T.p('4.3', 0, 0.5));
    const locked = glide(m('4.3', 'you lock twelve thousand', 1.1));
    d.tether(m('4.3', 'on a blockchain', 0.8));
    // The nine pages are what locks it: the sheet drops into the bar as it turns green.
    const dropped = glide(m('4.3', 'Crypto can do that', 1.1));
    h.pages.style.opacity = '0';
    h.pages.style.transform = `translateY(${(GEO.bar.y - 330) * dropped}px) scale(${1 - 0.5 * dropped})`;
    const hit = m('4.5', 'and stops');
    d.bar({
      op: T.p('4.3', 0.3, 0.5),
      parts: locked > 0.01 ? [{ w: 680 * locked, tone: 'green', label: `$${T.num(12000)} ${T.s('locked')}`, name: T.s('collateral') }] : [{ w: 680, tone: 'empty' }],
      marker: T.since('4.5') > 0 ? 680 : undefined,
      shake: hit > 0 && hit < 1 ? Math.sin(hit * 38) * 10 * (1 - hit) : 0,
    });
    d.seals({ op: m('4.3', 'on a blockchain', 0.4), you: T.p('4.4', 0.2, 0.5, 'linear'), them: T.p('4.4', 0.6, 0.5, 'linear') });
    // The two pieces of the stick fly out and become the two copies.
    const flown = glide(m('4.4', 'like the two halves', 0.9));
    const kept = m('4.4', 'each keeps a copy');
    d.copy('you', { op: Math.max(kept * (1 - m('4.4', 'like the two halves', 0.2)), flown > 0.7 ? (flown - 0.7) / 0.3 : 0), title: T.s('yourCopy'), figure: money, state: 'signed' });
    d.copy('them', { op: Math.max(kept * (1 - m('4.4', 'like the two halves', 0.2)), flown > 0.7 ? (flown - 0.7) / 0.3 : 0), title: T.s('theirCopy'), figure: money, state: 'signed' });
    h.pieces.forEach((piece, index) => {
      const target = index ? GEO.them.x : GEO.you.x;
      piece.root.style.transform = `translate(${(target - 960) * flown}px, ${390 * flown}px)`;
      piece.update({ op: m('4.4', 'like the two halves', 0.25) * (flown < 0.7 ? 1 : 1 - (flown - 0.7) / 0.3), apart: 0 });
    });
    const tagged = m('4.4', 'This is a payment channel') * live;
    h.tag.style.opacity = String(tagged * (1 - T.p('4.5', 0, 0.4)));
    h.tag.style.transform = `translateX(-50%) scale(${0.9 + 0.1 * spring(tagged)})`;

    // Payday: the payment leaves the exchange, reaches the edge of the locked money and stays outside.
    const [from, until] = [T.frac('4.5', T.mark('4.5', 'two thousand of salary')), T.frac('4.5', T.mark('4.5', 'and stops'))];
    const sent = glide(T.p('4.5', from, until - from, 'linear'));
    h.pay.style.left = `${lerp(GEO.them.x, GEO.bar.x + GEO.bar.w + 6, sent)}px`;
    h.pay.style.opacity = String(T.p('4.5', from - 0.2, 0.3, 'linear') * (1 - T.p('4.6', 0, 0.4)));
    h.pay.style.background = hit > 0.5 ? TONE.red : TONE.ink;

    const line = pick([
      [T.win('4.1', '4.2', 0.01, 0.3) * m('4.1', 'Both sides walked') * (1 - m('4.1', 'In 2024')), T.s('held')],
      [T.win('4.1', '4.2', 0.01, 0.3) * m('4.1', 'In 2024'), T.s('shot'), TONE.red],
      [T.win('4.3', '4.4', 0.4, 0.3), T.s('c1')],
      [T.win('4.4', '4.5', 0.4, 0.3), T.s('c2')],
      [T.win('4.5', '4.6', 0.01, 0.3) * m('4.5', 'But every locked dollar') * (1 - m('4.5', 'Every dollar you receive')), T.s('c3')],
      [T.win('4.5', '4.6', 0.01, 0.3) * m('4.5', 'Every dollar you receive'), T.s('c4'), TONE.red],
      [T.win('4.6', undefined, 0.6) * T.p('4.6', 0.2, 0.4), T.s('c5')],
    ]);
    d.caption(line[1], line[0], line[2] ?? TONE.ink);

    // 3.6 · two half accounts, and the row that is missing.
    h.table.style.opacity = String(T.p('4.6', 0.2, 0.5));
    ['The bank pays at once', 'The channel signs everything', 'Almost nobody holds'].forEach((phrase, index) => rise(h.rows[index], glide(m('4.6', phrase, 0.7)), 30));
  },
};
