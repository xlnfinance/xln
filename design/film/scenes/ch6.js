// Part 5 · today. What xln is and is not, row by row. Then the claim: the three moments were one
// account; one signed account among unsigned ones; the field turns. Then your own app, the place
// where a signature should be, and the same phone with the signature there.

import { clamp, lerp } from '../engine/core.js';
import { DISPLAY, SHADOW, TONE, UI, backdrop, chip, el, glide, lockup, noise, paper, phone, rise, spring, tally } from './sleek.js';

const STATUS = [
  ['network', 'testNetwork', 'amber', 'a test network'],
  ['money', 'noMoney', 'amber', 'no real money'],
  ['runs', 'project', 'amber', 'run by us'],
  ['audit', 'findings', 'red', 'Our own audit'],
  ['dispute', 'notShown', 'red', 'they close before'],
];
/** The opening wall of screens, same grid and the same amounts; yours is the one in the middle. */
const FIELD = { cols: 17, rows: 5, w: 96, h: 170, px: 112, py: 200, mine: { col: 8, row: 2 } };
const DEVICE = { x: 620, y: 520, s: 1.04 };

export default {
  strings: {
    today: 'xln today',
    network: 'Network',
    testNetwork: 'a test network',
    money: 'Money',
    noMoney: 'no real money',
    runs: 'Who runs it',
    project: 'the project itself · one keeper',
    audit: 'Our own audit',
    findings: 'findings still open',
    dispute: 'A dispute on a public blockchain',
    notShown: 'not shown yet',
    bankWord: 'credit',
    never: 'Never three stories.',
    one: 'One account, waiting to be assembled.',
    odd: 'A keeper who knows what it owes can sign it.',
    inevitable: '',
    ends: '',
    first: 'It can still lend what you leave as credit. It signs how much.',
    then: 'One who will not sign has told you something too.',
    spread: 'One account at a time.',
    first: 'Start with yours.',
    clear: 'Large clearing systems already sit between the two.',
    rival: 'After FTX, exchanges began to prove what they hold.',
    proof: 'The other half: what they owe you, signed.',
    where: 'The open questions: who, and when.',
    brand: 'Your app',
    total: 'Total balance',
    available: 'USD · available',
    assets: 'ACCOUNTS',
    withdraw: 'Transfer',
    deposit: 'Statements',
    checking: 'Checking',
    savings: 'Savings',
    card: 'Card',
    find: 'Find the number.',
    sign: 'Now find the signature.',
    xln: 'xln',
    signedBy: '✓ you   ✓ the exchange',
    lockedRow: 'Locked on-chain',
    limitRow: 'They may owe you, up to',
    owedRow: 'Owed to you',
    send: 'Open signed copies',
    statements: 'Signed copies',
    sending: 'Opening',
    sent: 'Two copies · the same number',
    same: 'Same number.',
    two: 'Two signatures.',
    lockedSays: '$12,000 locked where neither\nof you can move it alone.',
    sketch: 'interface sketch · test network · no real money',
    cta: 'Open a test wallet. Get paid. Pay someone. Try to break it.',
    theory: 'the map behind it: Unified Financial Theory',
    status: 'A test network. No real money.',
  },

  setup(stage, kit, T) {
    backdrop(stage);
    const money = `$${T.num(12000, 2)}`;

    // 5.1 · the honest list.
    const sheet = el(stage, { left: '360px', top: '150px', width: '1200px', height: '690px', borderRadius: '36px', background: TONE.card, border: `1px solid ${TONE.line}`, boxShadow: SHADOW.lift, fontFamily: UI });
    el(sheet, { left: '56px', top: '44px', font: `800 56px ${DISPLAY}`, letterSpacing: '-0.045em' }, T.s('today'));
    const rows = STATUS.map(([name, value, tone], index) => {
      const row = el(sheet, { left: '56px', right: '56px', top: `${150 + index * 102}px`, height: '102px', borderTop: `1px solid ${TONE.line}` });
      el(row, { left: '0', top: '34px', font: `500 27px ${UI}`, letterSpacing: '-0.015em', color: TONE.mute, whiteSpace: 'pre' }, T.s(name));
      el(row, { right: '0', top: '26px', padding: '9px 18px', borderRadius: '999px', font: `700 25px ${UI}`, letterSpacing: '-0.015em', whiteSpace: 'pre', background: tone === 'red' ? TONE.redWash : 'rgba(245,165,36,.14)', color: tone === 'red' ? TONE.red : '#9A6200' }, T.s(value));
      return row;
    });

    // 5.2 · every tile an account; yours is the first one signed.
    const field = el(stage, { inset: '0' });
    const [x0, y0] = [960 - FIELD.mine.col * FIELD.px, 525 - FIELD.mine.row * FIELD.py];
    const centre = { x: 960, y: 525 };
    field.style.transformOrigin = `${centre.x}px ${centre.y}px`;
    const random = noise(2022);
    const tiles = [];
    for (let row = 0; row < FIELD.rows; row += 1)
      for (let col = 0; col < FIELD.cols; col += 1) {
        const mine = col === FIELD.mine.col && row === FIELD.mine.row;
        const tile = el(field, { left: `${x0 + col * FIELD.px - FIELD.w / 2}px`, top: `${y0 + row * FIELD.py - FIELD.h / 2}px`, width: `${FIELD.w}px`, height: `${FIELD.h}px`, borderRadius: '20px', background: TONE.card, boxShadow: SHADOW.card });
        const amount = mine ? 12000 : Math.round(Math.pow(random(), 2.4) * 900 + 2) * 50;
        el(tile, { left: '12px', top: '26px', width: '34px', height: '5px', borderRadius: '3px', background: TONE.line });
        el(tile, { left: '12px', top: '40px', font: `700 15px ${UI}`, letterSpacing: '-0.02em', color: mine ? TONE.ink : TONE.mute }, `$${T.num(amount)}`);
        const badge = el(tile, { left: '12px', top: '74px', width: '30px', height: '30px', borderRadius: '50%', background: TONE.green, color: '#fff', font: `800 18px ${UI}`, display: 'flex', alignItems: 'center', justifyContent: 'center' }, '✓');
        el(tile, { left: '12px', right: '12px', bottom: '16px', height: '20px', borderRadius: '7px', background: TONE.wash });
        tiles.push({ tile, badge, far: Math.hypot(col - FIELD.mine.col, (row - FIELD.mine.row) * 1.5) });
      }
    // Tiles turn in order of their distance from yours.
    [...tiles].sort((a, b) => a.far - b.far).forEach((item, rank) => (item.rank = rank));
    const three = el(stage, { inset: '0' });
    const stick = tally(three, { x: 300, y: 250, w: 300, h: 70, notches: 6 });
    const pages = paper(three, { x: 960, y: 170, w: 170 });
    const bankTile = el(three, { left: '1380px', top: '240px', width: '240px', height: '96px', borderRadius: '24px', background: TONE.card, border: '2px solid #F5A524', boxShadow: SHADOW.card, display: 'flex', alignItems: 'center', justifyContent: 'center', font: `700 30px ${UI}`, color: '#9A6200' }, T.s('bankWord'));
    const veil = el(stage, { left: '0', right: '0', top: '596px', bottom: '0', background: `linear-gradient(0deg, ${TONE.bg} 78%, rgba(251,251,250,0))` });
    const held = el(stage, { left: '0', width: '1920px', top: '700px', textAlign: 'center', font: `800 60px ${DISPLAY}`, letterSpacing: '-0.045em', whiteSpace: 'pre' });
    const big = el(stage, { left: '0', width: '1920px', top: '628px', textAlign: 'center', font: `800 190px ${DISPLAY}`, letterSpacing: '-0.06em', lineHeight: '1', whiteSpace: 'pre' }, T.s('inevitable'));
    const ends = el(stage, { left: '0', width: '1920px', top: '840px', textAlign: 'center', font: `500 34px ${UI}`, letterSpacing: '-0.015em', color: TONE.mute, whiteSpace: 'pre' }, T.s('ends'));

    // 5.3 · your bank's app, then the same phone with the signature where it belongs.
    const base = Object.fromEntries(['total', 'available', 'assets', 'withdraw', 'deposit'].map(key => [key, T.s(key)]));
    const bank = phone(stage, { ...DEVICE, brand: T.s('brand'), balance: money, labels: { ...base, busy: '', paused: '', disabled: '', done: '' }, rows: [['$', T.s('checking'), money, TONE.accent], ['%', T.s('savings'), '$0.00', TONE.faint], ['▭', T.s('card'), '$0.00', TONE.faint]] });
    const wallet = phone(stage, {
      ...DEVICE, brand: T.s('xln'), balance: money, proof: true,
      labels: { total: T.s('total'), available: T.s('signedBy'), assets: 'ACCOUNT · EXCHANGE', withdraw: T.s('send'), deposit: T.s('statements'), busy: T.s('sending'), paused: '', disabled: '', done: T.s('sent') },
      rows: [['$', T.s('lockedRow'), money, TONE.green], ['±', T.s('limitRow'), `$${T.num(2000, 2)}`, '#F5A524'], ['→', T.s('owedRow'), '$0.00', TONE.faint]],
    });
    const ring = el(stage, { left: '0', top: '0', width: '300px', height: '70px', borderRadius: '22px', border: `4px solid ${TONE.accent}`, boxShadow: '0 0 0 8px rgba(31,79,255,.12)' });
    const words = el(stage, { left: '920px', top: '300px', width: '900px', font: `800 64px ${DISPLAY}`, letterSpacing: '-0.045em', whiteSpace: 'pre' });
    const points = ['same', 'two', 'lockedSays'].map((key, index) => el(stage, { left: '920px', top: `${250 + index * 120}px`, width: '900px', font: `800 ${index === 2 ? 46 : 64}px ${DISPLAY}`, letterSpacing: '-0.045em', lineHeight: '1.15', whiteSpace: 'pre', color: index === 2 ? TONE.green : TONE.ink }, T.s(key)));
    const sketch = chip(stage, { x: 1230, y: 700, words: T.s('sketch'), tone: 'mute', size: 22 });
    const end = lockup(stage, T.s('status'));
    const cta = el(stage, { left: '0', width: '1920px', top: '744px', textAlign: 'center', font: `600 36px ${UI}`, letterSpacing: '-0.02em', whiteSpace: 'pre' }, T.s('cta'));
    const theory = el(stage, { left: '0', width: '1920px', top: '820px', textAlign: 'center', font: `500 28px ${UI}`, letterSpacing: '-0.01em', color: TONE.mute, whiteSpace: 'pre' }, T.s('theory'));
    return { theory, sheet, rows, field, tiles, centre, three, stick, pages, bankTile, veil, held, big, ends, bank, wallet, ring, words, points, sketch, end, cta };
  },

  frame(h, T) {
    const m = (id, phrase, dur = 0.5) => T.p(id, T.frac(id, T.mark(id, phrase)), dur, 'linear');


    // 5.2 · three objects become one signed account; the camera pulls back; the field turns.
    const shown = T.win('6.2', '6.3', 0.6, 0.5);
    const three = m('6.2', 'The stick, the nine pages', 0.6);
    const merged = glide(m('6.2', 'They were one account', 1.0));
    const pulled = glide(m('6.2', 'After FTX', 1.8));
    const turned = glide(T.p('6.2', T.frac('6.2', T.mark('6.2', 'That is how it spreads')), 4.4, 'linear'));
    h.three.style.opacity = String(shown * three * (1 - clamp(merged * 1.6 - 0.6)));
    const to = (x, y) => `translate(${(960 - x) * merged}px, ${(420 - y) * merged}px) scale(${1 - 0.5 * merged})`;
    h.stick.root.style.transform = to(450, 285);
    h.stick.update({ apart: 0 });
    h.pages.style.transform = to(960, 275);
    h.bankTile.style.transform = to(1500, 288);
    h.field.style.opacity = String(shown * clamp(merged * 2.5 - 1.5));
    const zoom = lerp(2.3, 1, pulled);
    h.field.style.transform = `translate(${(960 - h.centre.x) * (1 - pulled)}px, ${(420 - h.centre.y) * (1 - pulled)}px) scale(${zoom})`;
    const count = h.tiles.length;
    const telling = m('6.2', 'One who will not sign', 1.2);
    h.tiles.forEach(({ tile, badge, far, rank }) => {
      const signed = rank === 0 ? 1 : clamp(turned * 0.8 * count - rank);
      tile.style.opacity = String(rank === 0 ? 1 : clamp(pulled * 3 - far / 6));
      tile.style.border = signed > 0.5 ? `3px solid ${TONE.green}` : `2px dashed ${TONE.red}`;
      badge.style.opacity = String(signed > 0.5 ? 1 : 0);
      // The keeper who will not sign: the unsigned screens flinch.
      tile.style.transform = signed > 0.5 ? 'none' : `translateX(${Math.sin(telling * 30 + rank) * 3 * telling * (1 - telling) * 4}px)`;
    });
    h.veil.style.opacity = String(shown * pulled);
    const lines = [['never', 'The stick, the nine pages', 'They were one account'], ['one', 'They were one account', 'After FTX'], ['rival', 'After FTX', 'The other half'], ['proof', 'The other half', 'One who will not sign'], ['then', 'One who will not sign', 'That is how it spreads'], ['spread', 'That is how it spreads', 'Start with yours'], ['first', 'Start with yours', '']];
    const now = lines.find(([, from, until]) => m('6.2', from, 0.01) > 0.5 && (until ? m('6.2', until, 0.01) : 0) < 0.5) ?? lines[0];
    h.held.textContent = T.s(now[0]);
    h.held.style.top = now[0] === 'never' || now[0] === 'one' ? '640px' : '700px';
    rise(h.held, m('6.2', now[1], 0.4) * (now[2] ? 1 - T.p('6.2', T.frac('6.2', T.mark('6.2', now[2])) - 0.3, 0.3, 'linear') : 1) * shown, 20);
    h.big.style.opacity = '0';
    h.ends.style.opacity = '0';

    // 5.3 · the number, the missing signature, and the phone that has it.
    const ending = m('6.3', 'Until then', 0.7);
    const gone = glide(m('6.3', 'Today this is a test network', 0.6));
    const honest = gone * (1 - ending);
    rise(h.sheet, honest, 40);
    STATUS.forEach(([, , , phrase], index) => rise(h.rows[index], glide(m('6.3', phrase, 0.6)), 22));
    const opened = T.p('6.3', 0.1, 0.8, 'linear') * (1 - ending);
    const there = m('6.3', 'This is what it looks like', 0.7);
    const place = `translateY(${(1 - spring(opened)) * 70}px) scale(${DEVICE.s})`;
    h.bank.root.style.opacity = String(clamp(opened * 2) * (1 - there));
    h.bank.root.style.transform = place;
    h.bank.update({});
    h.wallet.root.style.opacity = String(clamp(opened * 2) * there * (1 - gone));
    h.wallet.root.style.transform = `${place} rotateY(${(1 - glide(there)) * 12}deg)`;
    const tap = T.frac('6.3', T.mark('6.3', 'Twelve thousand locked')) + 0.5;
    h.wallet.update({ touching: T.p('6.3', tap, 0.3, 'out') * (1 - T.p('6.3', tap + 0.8, 0.3)), press: T.p('6.3', tap + 0.45, 0.14, 'out') * (1 - T.p('6.3', tap + 0.65, 0.3, 'out')), wave: T.p('6.3', tap + 0.45, 0.6, 'out'), busy: T.since('6.3') > tap + 0.6 ? 1 : 0, done: T.since('6.3') > tap + 1.0 ? 1 : 0, spin: T.t });
    const number = m('6.3', 'Find the number', 0.4);
    const hunt = glide(m('6.3', 'Now find the signature', 0.9));
    // The ring sits on the balance, then drops to the line under it, where a signature would be.
    h.ring.style.opacity = String(number * (1 - there) * (1 - ending));
    h.ring.style.transform = `translate(${DEVICE.x - 170 + 6}px, ${DEVICE.y - DEVICE.s * 390 + DEVICE.s * 150 + hunt * DEVICE.s * 58}px) scaleY(${1 - 0.4 * hunt})`;
    h.ring.style.borderColor = hunt > 0.6 ? TONE.red : TONE.accent;
    h.ring.style.borderStyle = hunt > 0.6 ? 'dashed' : 'solid';
    h.words.textContent = T.s(m('6.3', 'Now find the signature', 0.2) > 0.5 ? 'sign' : 'find');
    rise(h.words, number * (1 - there) * (1 - ending), 24);
    ['Same number', 'Two signatures', 'Twelve thousand locked'].forEach((phrase, index) => rise(h.points[index], glide(m('6.3', phrase, 0.5)) * (1 - ending) * (1 - gone), 22));
    h.sketch.style.opacity = String(there * (1 - ending) * (1 - gone));
    h.end(ending);
    rise(h.cta, m('6.3', 'try to break it', 0.6) * ending, 18);
    rise(h.theory, m('6.3', 'xln dot finance', 0.6), 14);
  },
};
