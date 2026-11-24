// Part 4 · the whole account. Three moments arrive in one bar: from the stick, two signatures and a
// copy each; from the nine pages, the lock; from the bank, credit. A week of ordinary payments moves
// one mark. Then the film goes back to the button, and this time the copy goes to the chain.

import { clamp, lerp } from '../engine/core.js';
import { DISPLAY, GEO, SHADOW, TONE, UI, backdrop, chip, diagram, el, glide, jeaMark, paper, phone, pick, rise, spring, tally } from './sleek.js';

const W = { stub: 70, wide: 528, collateral: 404, limit: 194 };
const ORIGIN = { y: 330 };

export default {
  strings: {
    you: 'you',
    exchange: 'exchange · or your bank',
    silent: 'silent',
    chain: 'Test blockchain',
    chainNote: 'the book with the last word',
    oneKeeper: 'today: our test chain · built for public ones',
    account: 'xln account',
    locked: 'locked',
    collateral: 'collateral',
    credit: 'credit',
    limit: 'limit',
    owed: 'owed to you',
    owedShort: 'owed',
    unused: 'unused limit',
    yourCopy: 'your signed copy',
    theirCopy: 'their signed copy',
    debtCopy: 'signed debt',
    stickTag: 'about 1100',
    pagesTag: '2008',
    bankTag: 'your bank',
    bankWord: 'credit',
    c0: 'xln builds that machine.',
    cA: 'Three moments, in one place.',
    c2: 'From the stick: two signatures, and a copy in each hand.',
    c1: 'From the nine pages: money locked where no one moves it alone.',
    cC: 'From the bank: credit at each end. It starts at zero.',
    c3: 'The parts are old. New: one account that holds all three.',
    theory: 'Unified Financial Theory',
    range: '−Lₗ ≤ Δ ≤ C + Lᵣ',
    vocab: 'jurisdiction · entity · account',
    salary: 'salary',
    rent: 'rent',
    ftx: 'the app: $12,000 · no limit · no signature',
    here: 'here: $2,000 · your limit · signed',
    c5: 'Past the locked money, into credit. It lands.',
    c6: 'The exchange signed the debt.',
    c6b: 'Each payment only moves the mark.',
    c6c: 'You settle on the blockchain when you choose to.',
    c6d: 'Day to day, nothing changes. A signature, and a limit you chose.',
    bank: '= your bank account, with the bank’s signature',
    channel: '= a payment channel',
    c7: 'Almost every account you have held: this one, with a part switched off.',
    c7b: 'After 2008, big banks must deal with each other this way.',
    c7c: 'xln gives that contract to everyone.',
    design: 'design simulation · audit findings open · not shown on a public chain',
    c8: 'Back to the button. Same button, same nothing.',
    c9: 'This time your signed copy goes to the blockchain.',
    wait: 'today’s code: 25 hours to answer · the design: 1 hour',
    signedBy: '✓ you   ✓ the exchange',
    walletAssets: 'ACCOUNT · EXCHANGE',
    copies: 'Signed copies',
    lockedRow: 'Locked on-chain',
    limitRow: 'They may owe you, up to',
    owedRow: 'Owed to you',
    salaryToast: 'Salary +$2,000 · exchange signed ✓',
    rentToast: 'Rent −$1,500 · you signed ✓',
    p1: 'You set the limit.',
    p2: 'Friday: salary, signed.',
    p3: 'Saturday: rent, received.\nThe debt shrinks to $500.',
    p4: 'Day to day, nothing changes.\nA signature, and a limit you chose.',
    quiet: 'a day, not eight months',
    before: '8 months',
    beforeSays: 'last time: until most of it came back',
    c10: 'The contract settles. Your locked $12,000 comes back.',
    back: 'back in your hands',
    returned: 'returned',
    c11: 'Only the collateral is protected.',
    c12: 'The $2,000 stays a signed debt: paid later, or never.',
    risk: 'the app: $12,000 at risk · nobody asked you',
    choice: 'here: at most $2,000 · your choice',
    c13: 'What you keep: the number, with the debtor’s signature under it.',
    brand: 'Exchange',
    total: 'Total balance',
    walletTotal: 'Locked + owed to you',
    available: 'USD · available',
    assets: 'ASSETS',
    withdraw: 'Withdraw',
    deposit: 'Deposit',
    busy: 'Processing',
    paused: 'Withdrawals paused',
    disabled: 'Withdrawals are temporarily disabled',
  },

  setup(stage, kit, T) {
    backdrop(stage);
    const d = diagram(stage);
    // The three moments, each with its date, waiting above the bar.
    const origins = el(stage, { inset: '0' });
    const pieces = [tally(origins, { x: 430, y: ORIGIN.y, w: 260, h: 60, notches: 6 }), tally(origins, { x: 430, y: ORIGIN.y, w: 260, h: 60, notches: 6 })];
    const pages = paper(origins, { x: 960, y: ORIGIN.y - 50, w: 124 });
    const bankTile = el(origins, { left: '1250px', top: `${ORIGIN.y - 14}px`, width: '220px', height: '88px', borderRadius: '22px', background: TONE.card, border: `2px solid #F5A524`, boxShadow: SHADOW.card, display: 'flex', alignItems: 'center', justifyContent: 'center', font: `700 28px ${UI}`, color: '#9A6200' }, T.s('bankWord'));
    const tags = [chip(origins, { x: 560, y: ORIGIN.y - 72, words: T.s('stickTag'), tone: 'mute', size: 22 }), chip(origins, { x: 960, y: ORIGIN.y - 112, words: T.s('pagesTag'), tone: 'mute', size: 22 }), chip(origins, { x: 1360, y: ORIGIN.y - 72, words: T.s('bankTag'), tone: 'mute', size: 22 })];

    const pay = chip(stage, { x: 0, y: GEO.bar.y - 118, words: ' ', tone: 'ink', size: 24 });
    const ftx = chip(stage, { x: 960, y: 322, words: T.s('ftx'), tone: 'red', size: 26 });
    const here = chip(stage, { x: 960, y: 392, words: T.s('here'), tone: 'green', size: 26 });
    const equals = el(stage, { left: `${GEO.bar.x}px`, width: `${GEO.bar.w}px`, top: '712px', textAlign: 'center', font: `700 34px ${UI}`, letterSpacing: '-0.025em', whiteSpace: 'pre' });
    const design = chip(stage, { x: 960, y: 60, words: T.s('design'), tone: 'mute', size: 22 });
    const refund = chip(stage, { x: GEO.you.x, y: GEO.you.y - GEO.avatar - 150, words: ' ', tone: 'green', size: 26 });
    const labels = Object.fromEntries(['total', 'available', 'assets', 'withdraw', 'deposit', 'busy', 'paused', 'disabled'].map(key => [key, T.s(key)]));
    const device = phone(stage, { x: 960, y: 480, brand: T.s('brand'), balance: `$${T.num(14000, 2)}`, labels });
    const risk = chip(stage, { x: 1240, y: 318, words: T.s('risk'), tone: 'red', size: 26 });
    const choice = chip(stage, { x: 1240, y: 384, words: T.s('choice'), tone: 'green', size: 26 });
    // An ordinary week, on the phone: the limit, the salary, the rent.
    const wallet = phone(stage, { x: 620, y: 520, brand: 'xln', balance: `$${T.num(12000, 2)}`, proof: true, rows: [], labels: { total: T.s('walletTotal'), available: T.s('signedBy'), assets: T.s('walletAssets'), withdraw: T.s('withdraw'), deposit: T.s('copies'), busy: '', paused: '', disabled: '', done: '' } });
    const ws = wallet.screen;
    const row = (top, name) => {
      el(ws, { left: '24px', top: `${top}px`, font: `600 16px ${UI}`, whiteSpace: 'pre' }, name);
      return el(ws, { right: '24px', top: `${top}px`, font: `600 16px ${UI}`, fontVariantNumeric: 'tabular-nums', whiteSpace: 'pre' });
    };
    const lockedValue = row(380, T.s('lockedRow'));
    lockedValue.textContent = `$${T.num(12000, 2)}`;
    lockedValue.style.color = TONE.green;
    const limitValue = row(426, T.s('limitRow'));
    const track = el(ws, { left: '24px', top: '462px', width: '308px', height: '8px', borderRadius: '4px', background: TONE.wash });
    const limitFill = el(track, { left: '0', top: '0', height: '8px', borderRadius: '4px', background: '#F5A524' });
    const knob = el(ws, { top: '452px', width: '28px', height: '28px', borderRadius: '50%', background: '#fff', border: '2px solid #F5A524', boxShadow: SHADOW.card });
    const owedValue = row(506, T.s('owedRow'));
    const toast = el(ws, { left: '14px', top: '50px', width: '328px', padding: '14px 16px', borderRadius: '18px', background: TONE.card, boxShadow: SHADOW.lift, border: `1px solid ${TONE.line}`, font: `600 15px ${UI}`, whiteSpace: 'pre' });
    const points = ['p1', 'p2', 'p4'].map((key, index) => el(stage, { left: '940px', top: `${[250, 380, 540][index]}px`, width: '900px', font: `800 ${index === 2 ? 46 : 58}px ${DISPLAY}`, letterSpacing: '-0.045em', lineHeight: '1.15', whiteSpace: 'pre', color: index === 2 ? TONE.green : TONE.ink }, T.s(key)));
    // The name, earned: the mark, the vocabulary, the range, then the three words.
    const monument = el(stage, { inset: '0', background: TONE.bg });
    jeaMark(monument, { x: 960, y: 300, size: 300 });
    el(monument, { left: '0', width: '1920px', top: '480px', textAlign: 'center', font: `500 40px ${UI}`, letterSpacing: '-0.015em', color: TONE.mute, whiteSpace: 'pre' }, T.s('vocab'));
    const range = el(monument, { left: '0', width: '1920px', top: '548px', textAlign: 'center', font: `400 34px 'JetBrains Mono', monospace`, color: TONE.mute, whiteSpace: 'pre' }, T.s('range'));
    const theoryName = el(monument, { left: '0', width: '1920px', top: '590px', textAlign: 'center', font: `800 124px ${DISPLAY}`, letterSpacing: '-0.055em', whiteSpace: 'pre' }, T.s('theory'));
    // One hour, and nothing else on screen.
    const night = el(stage, { inset: '0', background: '#0A0B0D' });
    const clock = el(night, { left: '0', width: '1920px', top: '330px', textAlign: 'center', font: `800 220px ${DISPLAY}`, letterSpacing: '-0.06em', lineHeight: '1', color: '#FFFFFF', fontVariantNumeric: 'tabular-nums' });
    const waitName = el(night, { left: '0', width: '1920px', top: '680px', textAlign: 'center', font: `500 40px ${UI}`, letterSpacing: '-0.02em', color: 'rgba(255,255,255,.6)', whiteSpace: 'pre' });
    const match = tally(night, { x: 360, y: 440, w: 1200, h: 170 });
    const join = el(night, { left: '360px', top: '523px', width: '984px', height: '4px', background: TONE.green, boxShadow: `0 0 24px ${TONE.green}`, transformOrigin: '0 50%' });
    return { monument, range, theoryName, d, origins, pieces, pages, bankTile, tags, pay, ftx, here, risk, choice, equals, design, refund, device, night, clock, waitName, match, join, wallet, limitValue, limitFill, knob, owedValue, toast, points };
  },

  frame(h, T) {
    const { d } = h;
    const m = (id, phrase, dur = 0.5) => T.p(id, T.frac(id, T.mark(id, phrase)), dur, 'linear');
    const beat = T.active();
    const dollars = value => `$${T.num(value, 2)}`;

    d.ledger({ op: T.p('5.1', 0.2, 0.7), title: T.s('chain'), note: T.s('chainNote'), tone: 'ink', crowd: 1, alone: 1, keepers: T.s('oneKeeper') });
    const silent = m('5.4', 'the exchange goes silent', 0.6);
    d.you({ op: T.p('5.1', 0, 0.5), name: T.s('you') });
    d.them({ op: T.p('5.1', 0.1, 0.5), name: T.s('exchange'), note: silent > 0.5 ? T.s('silent') : '', tone: silent > 0.5 ? 'mute' : 'ink' });

    // 4.1 · three moments fall into one bar.
    const arrived = m('5.1', 'Three moments', 0.6);
    const fromStick = glide(m('5.1', 'From the stick', 1.1));
    const fromPages = glide(m('5.1', 'From the nine pages', 1.1));
    const fromBank = glide(m('5.1', 'From the bank', 1.1));
    h.origins.style.opacity = String(beat === '5.1' ? 1 : 0);
    const fade = p => (p < 0.7 ? 1 : 1 - (p - 0.7) / 0.3);
    h.pieces.forEach((piece, index) => {
      const target = index ? GEO.them.x : GEO.you.x;
      piece.root.style.transform = `translate(${(target - 560) * fromStick}px, ${(GEO.you.y + 190 - ORIGIN.y) * fromStick}px)`;
      piece.update({ op: arrived * fade(fromStick), apart: 0 });
    });
    h.pages.style.opacity = String(arrived * fade(fromPages));
    h.pages.style.transform = `translateY(${(GEO.bar.y - 60 - ORIGIN.y) * fromPages}px) scale(${1 - 0.5 * fromPages})`;
    h.bankTile.style.opacity = String(arrived * fade(fromBank));
    h.bankTile.style.transform = `translate(${(GEO.bar.x + GEO.bar.w - 130 - 1360) * fromBank}px, ${(GEO.bar.y - 30 - ORIGIN.y) * fromBank}px) scale(${1 - 0.4 * fromBank})`;
    [fromStick, fromPages, fromBank].forEach((p, index) => (h.tags[index].style.opacity = String(arrived * (1 - clamp(p * 3)))));

    // The bar: what is locked, what the exchange may owe, and how much of that is drawn.
    const locked = fromPages > 0.7 ? glide((fromPages - 0.7) / 0.3) : 0;
    const ends = fromBank > 0.7 ? glide((fromBank - 0.7) / 0.3) : 0;
    const limit = glide(m('5.2', 'Here you set the limit', 0.9));
    const [reach, land] = [T.frac('5.2', T.mark('5.2', 'The payment reaches')), T.frac('5.2', T.mark('5.2', 'It lands'))];
    const landed = glide(T.p('5.2', reach, land - reach, 'linear'));
    const week = 0;
    const swing = 1;
    const noCollateral = glide(m('5.3', 'Set the collateral to zero', 0.7)) * (1 - glide(m('5.3', 'Set the credit to zero', 0.6)));
    const noCredit = glide(m('5.3', 'Set the credit to zero', 0.9)) * (1 - glide(m('5.3', 'Almost every account', 0.6)));
    const home = glide(m('5.4', 'The contract settles', 1.2));
    const used = T.since('5.2') > 0 ? landed * swing : 0;
    const owed = Math.round(used * 200) * 10;
    const debt = owed;
    const early = beat === '5.1';
    const empty = beat === '5.1' && locked < 0.01;
    // Your own side's credit stays at zero and leaves the picture once the exchange's limit is set.
    const stub = W.stub * (early ? ends : 1 - limit);
    const zone = early ? W.stub * ends : lerp(W.stub, W.limit, limit);
    const drawn = noCollateral > 0.5 ? 1 : used;
    const split = stub <= 0.5 && drawn > 0.02 && drawn < 0.98;
    const full = 680 - stub - zone - (stub > 0.5 ? 6 : 0) - 6 - (split ? 6 : 0);
    const collateralW = (early ? full * locked : full) * (1 - noCollateral) + noCredit * (zone + 6);
    const creditW = zone * (1 - noCredit) + noCollateral * (full + 6);
    const left = stub;
    d.tether((early ? locked : 1) * (1 - noCollateral) * (1 - home));
    d.bar({
      op: m('5.1', 'It runs today'),
      name: T.s('account'),
      parts: stub > 0.5
        ? [
            { w: stub, tone: 'amberEmpty', name: `${T.s('credit')} 0` },
            { w: collateralW, tone: 'green', label: `$${T.num(12000)} ${T.s('locked')}`, name: T.s('collateral') },
            { w: creditW, tone: 'amberEmpty', label: limit > 0.5 ? `${T.s('limit')} $${T.num(2000)}` : '', name: limit > 0.5 ? T.s('credit') : `${T.s('credit')} 0` },
          ]
        : [
            { w: empty ? 680 : collateralW, tone: home > 0.5 || empty ? 'empty' : 'green', label: home > 0.5 ? T.s('returned') : empty ? '' : `$${T.num(12000)} ${T.s('locked')}`, name: empty ? '' : T.s('collateral') },
            { w: creditW * drawn, tone: 'amber', label: noCollateral > 0.5 ? T.s('credit') : `$${T.num(debt)}`, name: noCollateral > 0.5 ? T.s('owed') : drawn > 0.6 ? `$${T.num(debt)} ${T.s('owedShort')}` : '' },
            { w: creditW * (1 - drawn), tone: 'amberEmpty', label: drawn < 0.05 ? `${T.s('limit')} $${T.num(2000)}` : '', name: drawn < 0.05 ? T.s('credit') : `$${T.num(debt)} ${T.s('owedShort')} of $${T.num(2000)}` },
          ],
      marker: T.since('5.2') > 0 && noCollateral + noCredit < 0.02 ? (stub > 0.5 ? stub + 6 : 0) + collateralW + (used > 0.02 ? 6 + creditW * used : 0) : undefined,
    });
    const signed = fromStick > 0.7 ? 1 : 0;
    d.seals({ op: m('5.1', 'It runs today'), you: signed, them: signed });
    const hold = home > 0.5 ? 12000 : 12000 + debt;
    d.figure(home > 0.5 ? `${dollars(12000)} + $${T.num(owed)} owed` : dollars(12000 + owed), T.p('5.1', 0, 0.5));
    const carried = glide(m('5.4', 'carries your signed copy', 1.0)) * (1 - T.p('5.5', 0, 0.5));
    const copies = fromStick > 0.7 ? (fromStick - 0.7) / 0.3 : 0;
    d.copy('you', { op: beat === '5.1' ? copies : 1, title: T.s(T.since('5.5') > 0 ? 'debtCopy' : 'yourCopy'), figure: dollars(T.since('5.5') > 0 ? owed : 12000 + owed), state: 'signed', dx: carried * 960, dy: carried * -616, scale: 1 - 0.08 * carried });
    d.copy('them', { op: (beat === '5.1' ? copies : 1) * (1 - silent), title: T.s('theirCopy'), figure: dollars(12000 + owed), state: 'signed' });

    // 4.2 · Friday the salary lands in credit; Saturday the rent goes the other way.
    const friday = T.frac('5.2', T.mark('5.2', 'Your salary arrives'));
    const paying = false;
    h.pay.lastChild.textContent = paying ? `−$${T.num(1500)} ${T.s('rent')}` : `+$${T.num(2000)} ${T.s('salary')}`;
    const sent = paying ? glide(clamp(week / 1.2)) : glide(T.p('5.2', reach - 0.6, land - reach + 0.6, 'linear'));
    h.pay.style.left = `${paying ? lerp(GEO.you.x + 120, GEO.them.x - 120, sent) : lerp(GEO.them.x, GEO.bar.x + GEO.bar.w - 100, sent)}px`;
    h.pay.style.opacity = String(beat === '5.2' ? (paying ? clamp(week * 3) * (1 - clamp((week - 1.6) * 2)) : T.p('5.2', friday, 0.3, 'linear') * (1 - m('5.2', 'The exchange signed', 0.4))) : 0);
    const compared = 0;
    h.ftx.style.opacity = String(compared);
    h.ftx.style.transform = `translateX(-50%) scale(1)`;
    const mine = m('5.2', 'Here you set the limit') * (1 - m('5.2', 'The payment reaches', 0.4));
    h.here.style.opacity = String(mine);
    h.here.style.transform = `translateX(-50%) scale(${0.9 + 0.1 * spring(m('5.2', 'Here you set the limit'))})`;

    const half = noCollateral > 0.5 ? 'bank' : noCredit > 0.5 ? 'channel' : '';
    h.equals.textContent = half ? T.s(half) : '';
    h.equals.style.color = half === 'bank' ? '#9A6200' : TONE.green;
    h.equals.style.opacity = String(Math.max(noCollateral, noCredit) > 0.5 ? clamp(Math.max(noCollateral, noCredit) * 2 - 1) : 0);

    // 4.4 · the first scene again: the same phone, the same press, the same nothing.
    const replay = T.p('5.4', 0.2, 0.6, 'linear') * (1 - m('5.4', 'This time', 0.6));
    const tap = T.frac('5.4', T.mark('5.4', 'Same button'));
    h.device.root.style.opacity = String(clamp(replay * 2));
    h.device.root.style.transform = `translateY(${(1 - spring(replay)) * 80}px) scale(0.8)`;
    h.device.update({ touching: T.p('5.4', tap - 0.5, 0.3, 'out') * (1 - T.p('5.4', tap + 0.35, 0.3)), press: T.p('5.4', tap, 0.14, 'out') * (1 - T.p('5.4', tap + 0.2, 0.3, 'out')), wave: T.p('5.4', tap, 0.6, 'out'), busy: T.since('5.4') > tap + 0.15 ? 1 : 0, paused: m('5.4', 'same nothing', 0.7), spin: T.t });
    // 4.2b · the same week, as the one screen you would actually hold.
    const day = T.win('5.2b', '5.3', 0.6, 0.5);
    d.dim((1 - 0.9 * replay) * (1 - day), replay * 9 + day * 9);
    h.wallet.root.style.opacity = String(clamp(day * 2));
    h.wallet.root.style.transform = `translateY(${(1 - spring(day)) * 70}px) scale(1.04)`;
    h.wallet.update({});
    const set = glide(T.p('5.2b', 0.5, 1.0, 'linear'));
    h.limitValue.textContent = dollars(Math.round(set * 20) * 100);
    h.limitFill.style.width = `${(set * 100).toFixed(1)}%`;
    h.knob.style.left = `${24 + 280 * set}px`;
    const [fri, sat] = [T.since('5.2b') - 1.7, -1];
    const owes = sat > 0.4 ? 500 : fri > 0.4 ? 2000 : 0;
    h.owedValue.textContent = dollars(owes);
    h.owedValue.style.color = owes ? '#9A6200' : TONE.faint;
    h.wallet.figure.textContent = owes ? `$${T.num(12000)} + $${T.num(owes)}` : dollars(12000);
    h.wallet.figure.style.fontSize = owes ? '32px' : '';
    h.wallet.figure.style.whiteSpace = 'nowrap';
    const pop = since => clamp(since * 3) * (1 - clamp((since - 2.6) * 3));
    const shown = Math.max(pop(fri), pop(sat));
    h.toast.textContent = T.s(sat > 0 ? 'rentToast' : 'salaryToast');
    h.toast.style.opacity = String(shown);
    h.toast.style.transform = `translateY(${(spring(shown) - 1) * 70}px)`;
    [T.p('5.2b', 0.5, 0.5, 'linear'), T.p('5.2b', 1.7, 0.5, 'linear'), m('5.2b', 'Day to day', 0.5)].forEach((shown, index) => rise(h.points[index], glide(shown) * day, 22));
    h.design.style.opacity = String(T.win('5.4', '5.5', 0.5, 0.4));
    // One hour on a dark screen, then the answer that does not come.
    const [asked, settled] = [T.frac('5.4', T.mark('5.4', 'The exchange gets a fixed window')), T.frac('5.4', T.mark('5.4', 'The contract settles'))];
    const waiting = T.p('5.4', asked, 0.35, 'linear') * (1 - T.p('5.4', settled - 0.2, 0.35, 'linear'));
    h.night.style.opacity = String(waiting);
    // First the stick: two pieces close, the notches meet, the join turns green. Then the hour.
    const closing = T.p('5.4', asked + 0.2, 0.9, 'linear');
    const sticked = 1 - T.p('5.4', asked + 1.5, 0.3, 'linear');
    h.match.update({ op: sticked, apart: 34 * (1 - glide(closing)) });
    h.join.style.opacity = String(sticked * clamp(closing * 3 - 2));
    h.join.style.transform = `scaleX(${glide(clamp(closing * 3 - 2))})`;
    h.clock.style.opacity = String(1 - sticked);
    h.waitName.style.opacity = String(1 - sticked);
    const left60 = Math.round(90000 * (1 - glide(T.p('5.4', asked + 2.6, Math.max(1.6, settled - asked - 3.4), 'linear'))));
    // The same frame as the opening's "2 years", then the hour that replaces it.
    const last = T.since('5.4') < asked + 2.6;
    h.clock.textContent = last ? T.s('before') : `${Math.floor(left60 / 3600)}:${String(Math.floor(left60 / 60) % 60).padStart(2, "0")}:${String(left60 % 60).padStart(2, "0")}`;
    h.waitName.textContent = T.s(last ? 'beforeSays' : left60 === 0 ? 'quiet' : 'wait');
    h.refund.lastChild.textContent = `+$${T.num(12000)} ${T.s('back')}`;
    const refunded = home * (1 - T.p('5.5', 0.6, 0.6));
    h.refund.style.opacity = String(refunded);
    h.refund.style.transform = `translateX(-50%) scale(${0.9 + 0.1 * spring(refunded)})`;

    // 5.3 · the name arrives after the picture has earned it.
    const named = m('5.3', 'One vocabulary', 0.7) * (1 - T.p('5.4', 0, 0.5));
    h.monument.style.opacity = String(named);
    h.range.style.opacity = '0';
    rise(h.theoryName, m('5.3', 'We call it', 0.7), 30);
    const live = (id, next) => T.win(id, next, 0.01, 0.3);
    const line = pick([
      [T.win('5.1', '5.2', 0.4, 0.3) * (1 - m('5.1', 'Three moments')), T.s('c0')],
      [live('5.1', '5.2') * m('5.1', 'Three moments') * (1 - m('5.1', 'From the stick')), T.s('cA')],
      [live('5.1', '5.2') * m('5.1', 'From the stick') * (1 - m('5.1', 'From the nine pages')), T.s('c2')],
      [live('5.1', '5.2') * m('5.1', 'From the nine pages') * (1 - m('5.1', 'From the bank')), T.s('c1')],
      [live('5.1', '5.2') * m('5.1', 'From the bank') * (1 - m('5.1', 'The parts are old')), T.s('cC')],
      [live('5.1', '5.2') * m('5.1', 'The parts are old'), T.s('c3')],
      [live('5.2', '5.3') * m('5.2', 'The payment reaches') * (1 - m('5.2', 'The exchange signed')), T.s('c5')],
      [live('5.2', '5.2b') * m('5.2', 'The exchange signed'), T.s('c6')],
      [live('5.3', '5.4') * m('5.3', 'Almost every account') * (1 - m('5.3', 'One vocabulary')), T.s('c7')],
      [live('5.4', '5.5') * T.p('5.4', 0.4, 0.4) * (1 - m('5.4', 'This time')), T.s('c8')],
      [live('5.4', '5.5') * m('5.4', 'This time') * (1 - waiting) * (1 - home), T.s('c9')],
      [live('5.4', '5.5') * home, T.s('c10'), TONE.green],
      [live('5.5') * (1 - m('5.5', 'The two thousand beyond')), T.s('c11')],
      [live('5.5') * m('5.5', 'The two thousand beyond') * (1 - m('5.5', 'In the app you risked')), T.s('c12'), '#9A6200'],
      [m('5.5', 'with its signature'), T.s('c13')],
    ]);
    d.caption(line[1], line[0] * (1 - waiting), line[2] ?? TONE.ink);
    // 4.5 · the loss you could not choose, against the one you did.
    ['In the app you risked', 'Here the exchange can cost'].forEach((phrase, index) => {
      const p = m('5.5', phrase) * (1 - m('5.5', 'with its signature', 0.4));
      const node = index ? h.choice : h.risk;
      node.style.opacity = String(p);
      node.style.transform = `translateX(-50%) scale(${0.9 + 0.1 * spring(m('5.5', phrase))})`;
    });
  },
};
