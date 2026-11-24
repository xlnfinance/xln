// Part 3 · what Bitcoin changed. One sheet with two sides: traditional finance on the front, crypto
// on the back. The sheet turns, and the shapes stay where they were: Bitcoin is the first replicated
// jurisdiction machine, and still a jurisdiction machine. The entities and the account did not move.

import { clamp } from '../engine/core.js';
import { DISPLAY, GEO, SHADOW, TONE, UI, backdrop, chip, diagram, el, glide, paper, pick, rise, spring } from './sleek.js';

const CASES = [
  ['FTX', '$8.7 bn misused', 'November 2022, FTX'],
  ['Mt. Gox', '850,000 BTC missing', 'Mt. Gox before it'],
  ['Celsius', '$4.7 bn owed', 'Celsius beside it'],
];

export default {
  strings: {
    mail: 'A mailing list · 31 October 2008',
    you: 'you',
    app: 'the app',
    exchange: 'exchange',
    fed: 'Federal Reserve',
    book: 'the book with the last word',
    oneKeeper: '1 keeper',
    bitcoin: 'Bitcoin',
    bitcoinNote: 'the book with the last word · no keeper',
    checkers: 'thousands of computers check every line',
    owes: 'the app says it owes you',
    table: 'one line in their own table',
    written: 'written by one side · held by one side',
    c1: 'The first replicated jurisdiction machine.',
    c2: 'Still a jurisdiction machine.',
    c3: 'The book is new. The entities are not. Nor the account.',
    halfA: 'no signature',
    halfB: 'no proof',
    c4: 'Crypto rebuilt the book.',
    c5: 'It left almost every account exactly as it was.',
    c6: 'Your money lives in the account.',
    c7: 'The machine nobody finished.',
  },

  setup(stage, kit, T) {
    backdrop(stage);
    stage.style.perspective = '2600px';
    const sheet = el(stage, { inset: '0', transformStyle: 'preserve-3d' });
    const face = back => el(sheet, { inset: '0', backfaceVisibility: 'hidden', WebkitBackfaceVisibility: 'hidden', transform: back ? 'rotateY(180deg)' : 'none' });
    const front = diagram(face(false));
    const back = diagram(face(true));
    const caption = el(stage, { left: '0', width: '1920px', top: `${GEO.caption}px`, textAlign: 'center', font: `800 46px ${DISPLAY}`, letterSpacing: '-0.035em', whiteSpace: 'pre' });
    const cases = CASES.map(([name, amount], index) => {
      const card = el(stage, { left: `${560 + index * 280}px`, top: '738px', width: '250px', height: '104px', borderRadius: '22px', background: TONE.card, border: `1px solid ${TONE.line}`, boxShadow: SHADOW.card, fontFamily: UI });
      el(card, { left: '20px', top: '14px', font: `800 28px ${DISPLAY}`, letterSpacing: '-0.035em', whiteSpace: 'pre' }, name);
      el(card, { left: '20px', top: '58px', font: `700 20px ${UI}`, color: TONE.red, whiteSpace: 'pre' }, amount);
      return card;
    });
    const night = el(stage, { inset: '0', background: '#0A0B0D' });
    paper(night, { x: 960, y: 190, w: 560 });
    chip(night, { x: 960, y: 110, words: T.s('mail'), tone: 'ink', size: 26 });
    return { sheet, front, back, caption, cases, night };
  },

  frame(h, T) {
    const m = (id, phrase, dur = 0.5) => T.p(id, T.frac(id, T.mark(id, phrase)), dur, 'linear');
    const money = `$${T.num(12000, 2)}`;

    // The nine pages, alone on a dark frame.
    h.night.style.opacity = String(T.p('3.1', 0.15, 0.3, 'linear') * (1 - m('3.1', 'It launched in 2009', 0.35)));

    // Three half-turns: to Bitcoin, back to the Fed, and round again to the exchanges.
    const angle = 180 * (glide(m('3.1', 'It launched in 2009', 1.4)) + glide(m('3.1', 'But turn the picture around', 1.4)) + glide(T.p('3.2', 0.2, 1.4, 'linear')));
    h.sheet.style.transform = `rotateY(${angle.toFixed(2)}deg)`;

    const broke = m('3.3', 'That is the machine');
    const bar = (label, name) => ({
      op: 1,
      parts: broke > 0 ? [{ w: 340 - 22 * glide(broke), tone: 'red', label: T.s('halfA') }, { w: 340 - 22 * glide(broke), tone: 'red', label: T.s('halfB') }] : [{ w: 680, tone: 'red', label, name }],
      gap: 6 + 38 * glide(broke),
      shake: broke > 0 && broke < 1 ? Math.sin(broke * 40) * 8 * (1 - broke) : 0,
    });
    // Front: traditional finance, as part 2 left it.
    h.front.ledger({ op: 1, title: T.s('fed'), note: T.s('book'), tone: 'red', alone: 1, keepers: T.s('oneKeeper') });
    h.front.you({ op: 1, name: T.s('you') });
    h.front.them({ op: 1, kind: 'bank', name: T.s('app'), tone: 'ink' });
    h.front.figure(money, 1);
    h.front.bar({ op: 1, parts: [{ w: 680, tone: 'red', label: `$${T.num(12000)} · ${T.s('owes')}`, name: T.s('written') }] });
    // Back: the same places, a different book.
    const named = m('3.2', 'November 2022, FTX');
    h.back.ledger({ op: 1, title: T.s('bitcoin'), note: T.s('bitcoinNote'), tone: 'green', crowd: glide(m('3.1', 'Thousands of computers', 1.6)), keepers: m('3.1', 'Thousands of computers') > 0.5 ? T.s('checkers') : '' });
    h.back.you({ op: 1, name: T.s('you') });
    h.back.them({ op: 1, kind: 'exchange', name: named > 0.5 ? 'FTX' : T.s('exchange'), tone: 'ink' });
    h.back.figure(money, 1);
    h.back.bar(bar(`$${T.num(12000)} · ${T.s('table')}`, T.s('written')));

    h.cases.forEach((card, index) => {
      const p = T.p('3.2', T.frac('3.2', T.mark('3.2', 'November 2022, FTX')) + index * 0.5, 0.5, 'linear') * (1 - T.p('3.3', 0, 0.4));
      card.style.opacity = String(clamp(p * 2));
      card.style.transform = `translateY(${(1 - spring(p)) * 26}px)`;
    });

    const live = (id, next) => T.win(id, next, 0.01, 0.3);
    const line = pick([
      [live('3.1', '3.2') * m('3.1', 'It is the first replicated') * (1 - m('3.1', 'But turn the picture around')), T.s('c1')],
      [live('3.1', '3.2') * m('3.1', 'it is still a jurisdiction'), T.s('c2')],
      [live('3.2', '3.3') * m('3.2', 'The jurisdiction was new') * (1 - m('3.2', 'November 2022, FTX')), T.s('c3')],
      [live('3.3') * T.p('3.3', 0.2, 0.4) * (1 - m('3.3', 'It left almost every')), T.s('c4')],
      [live('3.3') * m('3.3', 'It left almost every') * (1 - m('3.3', 'And your money')), T.s('c5')],
      [live('3.3') * m('3.3', 'And your money') * (1 - broke), T.s('c6')],
      [broke, T.s('c7'), TONE.red],
    ]);
    h.caption.textContent = line[1];
    h.caption.style.color = line[2] ?? TONE.ink;
    rise(h.caption, clamp(line[0]), 18);
  },
};
