// Part 2 · three machines, drawn from traditional finance alone. First the account (a bar), then the
// two entities at its ends (circles), then the jurisdiction above them (a square). Real systems are
// stamped through the same picture; the picture is the mark.

import { clamp } from '../engine/core.js';
import { DISPLAY, GEO, TONE, UI, backdrop, diagram, el, glide, pick, rise, spring } from './sleek.js';

const BOOKS = ['Fedwire', 'T2'];
const PARTIES = ['a bank', 'a broker', 'a card network'];
const ACCOUNTS = ['a deposit', 'a brokerage balance', 'a card balance'];
const KINDS = ['the app', 'a company', 'a bank', 'a broker'];
const GLYPH = {
  account: '<line x1="6" y1="20" x2="34" y2="20" stroke-width="5" stroke-linecap="round"/>',
  entity: '<circle cx="20" cy="20" r="13" fill="none" stroke-width="5"/>',
  jurisdiction: '<rect x="6" y="6" width="28" height="28" rx="3" fill="none" stroke-width="5"/>',
};

export default {
  strings: {
    you: 'you',
    owes: 'the app says it owes you',
    written: 'written by one side · held by one side',
    theirRecord: 'their record',
    yourCopy: 'your copy',
    none: 'none',
    account: 'account',
    entity: 'entity',
    jurisdiction: 'jurisdiction',
    accountName: 'Account · what two owe each other',
    fed: 'Federal Reserve',
    book: 'the book with the last word',
    oneKeeper: '1 keeper',
    jName: 'Jurisdiction',
    c1: 'An account: a record of what two parties owe each other.',
    c2: 'An entity: anyone who acts in their own name.',
    c3: 'A jurisdiction: the book with the last word.',
    c4: 'Three machines.',
    every: 'Every financial system you have used: these three, arranged.',
    letters: 'J · E · A',
  },

  setup(stage, kit, T) {
    backdrop(stage);
    const d = diagram(stage);
    // The three symbols, each arriving with its machine.
    const legend = ['account', 'entity', 'jurisdiction'].map((key, index) => {
      const item = el(stage, { left: `${640 + index * 230}px`, top: '44px', height: '48px', display: 'flex', alignItems: 'center', gap: '12px', font: `700 28px ${UI}`, letterSpacing: '-0.02em', whiteSpace: 'pre' });
      item.innerHTML = `<svg viewBox="0 0 40 40" width="40" height="40" stroke="${TONE.ink}">${GLYPH[key]}</svg>`;
      item.append(T.s(key));
      return item;
    });
    const mark = el(stage, { inset: '0' });
    mark.innerHTML = `<svg viewBox="0 0 1920 1080" width="1920" height="1080" fill="none" stroke="${TONE.ink}" stroke-linecap="round"><rect/><line/><circle/><circle/></svg>`;
    const shapes = [...mark.firstChild.children];
    const letters = el(stage, { left: '0', width: '1920px', top: '690px', textAlign: 'center', font: `800 72px ${DISPLAY}`, letterSpacing: '0.04em', whiteSpace: 'pre' }, T.s('letters'));
    return { d, legend, mark, shapes, letters };
  },

  frame(h, T) {
    const { d } = h;
    const m = (id, phrase, dur = 0.5) => T.p(id, T.frac(id, T.mark(id, phrase)), dur, 'linear');
    const turn = (list, from, until) => {
      const [a, b] = [T.frac('2.4', from), T.frac('2.4', until)];
      const p = (T.since('2.4') - a) / (b - a);
      return p < 0 || p >= 1 ? -1 : Math.min(list.length - 1, Math.floor(p * list.length));
    };
    const money = `$${T.num(12000, 2)}`;
    const general = T.p('2.4', 0.1, 0.5, 'linear');
    const marked = m('2.4', 'arranged', 2.2);

    // 2.1 · the account, alone.
    const drawn = m('2.1', 'Twelve thousand dollars', 0.9);
    const account = turn(ACCOUNTS, 0.62, 0.9);
    d.bar({
      op: drawn,
      parts: [{ w: 680 * glide(drawn), tone: general > 0.5 ? 'ink' : 'red', label: general > 0.5 ? (account >= 0 ? ACCOUNTS[account] : '') : `$${T.num(12000)} · ${T.s('owes')}`, name: general > 0.5 ? '' : T.s('written') }],
      name: m('2.1', 'That is an account') > 0.5 ? T.s('accountName') : '',
    });
    const specific = 1 - general;
    d.copy('them', { op: m('2.1', 'one of them writes it') * specific, title: T.s('theirRecord'), figure: `${T.s('you')}  ${money}`, state: 'plain' });
    d.copy('you', { op: m('2.1', 'one of them holds it') * specific, title: T.s('yourCopy'), figure: T.s('none'), state: 'none' });

    // 2.2 · the two entities at its ends.
    const ends = m('2.2', 'you, and the app', 0.6);
    const [a, b] = [T.frac('2.2', T.mark('2.2', 'A person, a company')), T.beat('2.2').end - T.beat('2.2').start];
    const kind = T.since('2.2') > a && T.since('2.3') < 0 ? Math.min(KINDS.length - 1, Math.floor(((T.since('2.2') - a) / (b - a)) * KINDS.length)) : 0;
    const party = turn(PARTIES, 0.34, 0.62);
    d.you({ op: ends, name: T.s('you'), note: m('2.2', 'Each is an entity') > 0.5 ? T.s('entity') : '' });
    d.them({ op: ends, kind: kind >= 2 || (party >= 0 && party < 2) ? 'bank' : 'exchange', name: party >= 0 ? PARTIES[party] : KINDS[kind], note: m('2.2', 'Each is an entity') > 0.5 ? T.s('entity') : '', tone: 'ink' });
    d.figure(money, ends * specific);

    // 2.3 · the jurisdiction above them.
    const above = m('2.3', 'a book with the last word', 0.8);
    const book = turn(BOOKS, 0.08, 0.34);
    d.ledger({
      op: above,
      title: general > 0.5 ? (book >= 0 ? BOOKS[book] : T.s('jName')) : T.s('fed'),
      note: T.s('book'),
      tone: general > 0.5 ? 'ink' : 'red',
      alone: general > 0.5 ? 0 : spring(m('2.3', 'One keeper', 0.6)),
      keepers: general <= 0.5 && m('2.3', 'One keeper') > 0.5 ? T.s('oneKeeper') : '',
    });

    h.legend[0].style.opacity = String(m('2.1', 'That is an account'));
    h.legend[1].style.opacity = String(m('2.2', 'Each is an entity'));
    h.legend[2].style.opacity = String(m('2.3', 'That is a jurisdiction'));

    // 2.4 · the picture is the mark: the outline is drawn on the diagram, then closes into the sign.
    const outlined = clamp(marked / 0.3);
    const q = glide(clamp((marked - 0.35) / 0.65));
    const mix = (a, b) => (a + (b - a) * q).toFixed(2);
    d.dim(1 - 0.92 * q, q * 9);
    h.mark.style.opacity = String(outlined);
    const [rect, span, left, right] = h.shapes;
    const set = (node, values) => Object.entries(values).forEach(([key, value]) => node.setAttribute(key, value));
    set(rect, { x: mix(GEO.ledger.x, 771), y: mix(GEO.ledger.y, 231), width: mix(GEO.ledger.w, 378), height: mix(650, 378), rx: mix(40, 21) });
    set(span, { x1: mix(GEO.you.x + GEO.avatar, 914.5), x2: mix(GEO.them.x - GEO.avatar, 1005.5), y1: mix(GEO.you.y, 420), y2: mix(GEO.you.y, 420) });
    set(left, { cx: mix(GEO.you.x, 876), cy: mix(GEO.you.y, 420), r: mix(GEO.avatar, 38.5) });
    set(right, { cx: mix(GEO.them.x, 1044), cy: mix(GEO.them.y, 420), r: mix(GEO.avatar, 38.5) });
    h.mark.firstChild.setAttribute('stroke-width', mix(5, 17.5));
    rise(h.letters, clamp(q * 3 - 2), 20);

    const live = (id, next) => T.win(id, next, 0.01, 0.3);
    const line = pick([
      [live('2.1', '2.2') * m('2.1', 'That is an account'), T.s('c1')],
      [live('2.2', '2.3') * m('2.2', 'Each is an entity'), T.s('c2')],
      [live('2.3', '2.4') * m('2.3', 'That is a jurisdiction'), T.s('c3')],
      [live('2.4') * T.p('2.4', 0.3, 0.4) * (1 - marked), T.s('c4')],
      [marked, T.s('every')],
    ]);
    d.caption(line[1], line[0]);
  },
};
