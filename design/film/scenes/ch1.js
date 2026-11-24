// Part 1 · not only FTX. The wall goes up fast: twelve keepers, each with what happened after. Then
// the official answer, deposit insurance, drawn to scale and measured both ways. A promise behind a
// promise; the other way is a locked dollar and a signed number.
// Every figure comes from output/film/v10/failures.md; change it there first.

import { clamp, lerp } from '../engine/core.js';
import { DISPLAY, SHADOW, TONE, UI, backdrop, chip, el, glide, phone, rise, spring } from './sleek.js';

/** `big` cards carry the three kinds of keeper; the rest are the same event in small type. */
const WALL = [
  { name: 'Synapse', year: '2024', amount: '$219 m of app users’ funds frozen', after: '87% returned in 8 months', big: true },
  { name: 'MF Global', year: '2011', amount: '$1.2 bn of customer funds short', after: 'repaid in full after 2.5 years', big: true },
  { name: 'Madoff', year: '2008', amount: '$64.8 bn on statements', after: 'about 89% of principal recovered', big: true },
  { name: 'Bank of Cyprus', year: '2013', amount: '47.5% above €100,000 converted', after: 'turned into bank shares', big: true },
  { name: 'Lebanon', year: 'since 2019', amount: '$72 bn+ of estimated losses', after: 'withdrawals restricted', big: true },
  { name: 'SVB', year: '2023', amount: '$40 bn+ withdrawn in a day', after: 'uninsured: rescued by exception', big: true },
];
const BAR = { x: 160, y: 300, w: 1600, h: 110 };
/** FDIC, second quarter of 2026: fund $161.1 bn; domestic deposits about $17.8 tn (our estimate). */
const FUND_SHARE = 161.1 / 17800;

export default {
  strings: {
    event: 'The causes differ. The customer’s position does not.',
    deposits: 'Deposits in American banks',
    trillion: 'trillion',
    fundName: 'The insurance fund · $161 billion',
    insuredCents: '1.5¢',
    insuredSays: 'for every insured dollar · the government behind it',
    cents: '≈40%',
    behind: 'of deposits sit above the insurance limit',
    source: 'FDIC, Q2 2026 · St. Louis Fed, 2026',
    insurance: 'Insurance',
    insuranceSays: 'covers eligible bank deposits, up to a limit',
    cent: '1.5¢ per insured dollar',
    collateral: 'The other way',
    collateralSays: 'not a bigger promise',
    dollar: '?',
    patch: 'Insurance answers who absorbs a loss.',
    fix: 'The other way is not a bigger promise.',
    brand: 'Your app',
    checking: 'Checking',
    savings: 'Savings',
    card: 'Card',
    total: 'Total balance',
    available: 'USD · available',
    assets: 'ACCOUNTS',
    withdraw: 'Transfer',
    deposit: 'Statements',
    busy: 'Processing',
    paused: 'Transfer',
    disabled: '',
    same: 'A number in their records. Nothing in your hands.',
    unsigned: 'Signed by: nobody',
  },

  setup(stage, kit, T) {
    backdrop(stage);
    const wall = el(stage, { inset: '0' });
    let small = 0;
    const tiles = WALL.map((item, index) => {
      const slot = item.big ? index : small++;
      const [x, y, w, h] = item.big ? [150 + (slot % 3) * 548, 130 + Math.floor(slot / 3) * 260, 520, 220] : [150 + (slot % 3) * 548, 360 + Math.floor(slot / 3) * 150, 520, 128];
      const card = el(wall, { left: `${x}px`, top: `${y}px`, width: `${w}px`, height: `${h}px`, borderRadius: '28px', background: TONE.card, border: `1px solid ${TONE.line}`, boxShadow: item.big ? SHADOW.lift : SHADOW.card, fontFamily: UI });
      el(card, { left: '28px', top: item.big ? '28px' : '20px', font: `800 ${item.big ? 52 : 30}px ${DISPLAY}`, letterSpacing: '-0.04em', whiteSpace: 'pre' }, item.name);
      el(card, { left: item.big ? '30px' : 'auto', right: item.big ? 'auto' : '28px', top: item.big ? '100px' : '26px', font: `700 ${item.big ? 27 : 23}px ${UI}`, letterSpacing: '-0.025em', color: TONE.red, whiteSpace: 'pre', fontVariantNumeric: 'tabular-nums' }, item.amount);
      el(card, { left: '30px', top: item.big ? '154px' : '74px', font: `500 ${item.big ? 25 : 21}px ${UI}`, color: TONE.mute, whiteSpace: 'pre' }, `${item.year} · ${item.after}`);
      return card;
    });
    const event = el(stage, { left: '0', width: '1920px', top: '872px', textAlign: 'center', font: `800 50px ${DISPLAY}`, letterSpacing: '-0.04em', whiteSpace: 'pre' }, T.s('event'));

    // Deposit insurance, to scale: all deposits as one bar, the fund as the sliver at its left end.
    const scale = el(stage, { inset: '0' });
    const depositsName = el(scale, { left: `${BAR.x}px`, top: `${BAR.y - 62}px`, font: `600 34px ${UI}`, letterSpacing: '-0.02em', whiteSpace: 'pre' }, T.s('deposits'));
    const depositsFigure = el(scale, { left: `${BAR.x}px`, width: `${BAR.w}px`, top: `${BAR.y - 70}px`, textAlign: 'right', font: `800 46px ${DISPLAY}`, letterSpacing: '-0.04em', fontVariantNumeric: 'tabular-nums', whiteSpace: 'pre' });
    const deposits = el(scale, { left: `${BAR.x}px`, top: `${BAR.y}px`, width: `${BAR.w}px`, height: `${BAR.h}px`, borderRadius: '26px', background: '#E3E6EB', transformOrigin: '0 50%' });
    const above = el(scale, { left: `${BAR.x + BAR.w * 0.6}px`, top: `${BAR.y}px`, width: `${BAR.w * 0.4}px`, height: `${BAR.h}px`, borderRadius: '0 26px 26px 0', background: TONE.redWash, border: `2px dashed ${TONE.red}` });
    const fund = el(scale, { left: `${BAR.x}px`, top: `${BAR.y - 16}px`, width: `${(BAR.w * FUND_SHARE).toFixed(1)}px`, height: `${BAR.h + 32}px`, borderRadius: '5px', background: TONE.red, transformOrigin: '50% 100%' });
    const leader = el(scale, { left: `${BAR.x + 6}px`, top: `${BAR.y + BAR.h + 16}px`, width: '3px', height: '70px', background: TONE.red, transformOrigin: '50% 0' });
    const fundName = el(scale, { left: `${BAR.x}px`, top: `${BAR.y + BAR.h + 96}px`, font: `700 34px ${UI}`, letterSpacing: '-0.02em', color: TONE.red, whiteSpace: 'pre' }, T.s('fundName'));
    const cents = el(scale, { left: '0', width: '1920px', top: '560px', textAlign: 'center', font: `800 190px ${DISPLAY}`, letterSpacing: '-0.06em', lineHeight: '1', whiteSpace: 'pre' });
    const behind = el(scale, { left: '0', width: '1920px', top: '770px', textAlign: 'center', font: `500 38px ${UI}`, letterSpacing: '-0.02em', color: TONE.mute, whiteSpace: 'pre' });
    const source = chip(scale, { x: 960, y: 846, words: T.s('source'), tone: 'mute', size: 22 });

    // A promise against a locked dollar: two rows.
    const versus = el(stage, { inset: '0' });
    const rows = [
      ['insurance', 'insuranceSays', FUND_SHARE, TONE.red, TONE.redWash, 'cent'],
      ['collateral', 'collateralSays', 1, TONE.mute, TONE.wash, 'dollar'],
    ].map(([name, says, share, tint, wash, each], index) => {
      const row = el(versus, { left: '160px', top: `${230 + index * 280}px`, width: '1600px', height: '240px' });
      el(row, { left: '0', top: '0', font: `800 54px ${DISPLAY}`, letterSpacing: '-0.045em', whiteSpace: 'pre' }, T.s(name));
      el(row, { left: '2px', top: '70px', font: `500 28px ${UI}`, color: TONE.mute, whiteSpace: 'pre' }, T.s(says));
      el(row, { right: '0', top: '26px', font: `800 44px ${DISPLAY}`, letterSpacing: '-0.04em', color: tint, whiteSpace: 'pre' }, T.s(each));
      const track = el(row, { left: '0', top: '128px', width: '1600px', height: '84px', borderRadius: '22px', background: wash, overflow: 'hidden' });
      const fill = el(track, { left: '0', top: '0', height: '84px', width: `${(1600 * share).toFixed(1)}px`, background: tint, transformOrigin: '0 50%' });
      if (index === 1) {
        Object.assign(track.style, { background: 'transparent', border: `3px dashed ${TONE.faint}` });
        fill.style.display = 'none';
      }
      return { row, fill };
    });

    const labels = Object.fromEntries(['total', 'available', 'assets', 'withdraw', 'deposit', 'busy', 'paused', 'disabled'].map(key => [key, T.s(key)]));
    const device = phone(stage, { x: 960, y: 440, brand: T.s('brand'), balance: `$${T.num(12000, 2)}`, labels, rows: [['$', T.s('checking'), `$${T.num(12000, 2)}`, TONE.accent], ['%', T.s('savings'), '$0.00', TONE.faint], ['▭', T.s('card'), '$0.00', TONE.faint]] });
    const line = el(stage, { left: '0', width: '1920px', top: '872px', textAlign: 'center', font: `800 50px ${DISPLAY}`, letterSpacing: '-0.04em', whiteSpace: 'pre' });
    const unsigned = chip(stage, { x: 960, y: 784, words: T.s('unsigned'), tone: 'red', size: 30 });
    return { above, wall, tiles, event, scale, depositsName, depositsFigure, deposits, fund, leader, fundName, cents, behind, source, versus, rows, device, line, unsigned };
  },

  frame(h, T) {
    const m = (id, phrase, dur = 0.6) => T.p(id, T.frac(id, T.mark(id, phrase)), dur, 'linear');

    // 1.1 · the wall goes up in one breath; nobody is asked to read it name by name.
    const [from, until] = [T.frac('1.1', T.mark('1.1', 'A broker')), T.frac('1.1', T.mark('1.1', 'The causes differ'))];
    const up = T.p('1.1', from, until - from, 'linear');
    h.tiles.forEach((card, index) => {
      const p = clamp(up * (h.tiles.length + 2) - index);
      card.style.opacity = String(clamp(p * 2));
      card.style.transform = `translateY(${(1 - spring(p)) * 34}px) scale(${0.94 + 0.06 * spring(p)})`;
    });
    const scaled = T.win('1.2', '1.3', 0.7, 0.5);
    const versus = T.win('1.3', '1.4', 0.6, 0.5);
    const closing = T.p('1.4', 0.3, 0.9, 'linear');
    const back = Math.max(scaled, versus, T.since('1.4') > 0 ? 1 : 0);
    h.wall.style.opacity = String(1 - 0.96 * back);
    h.wall.style.filter = back > 0.02 ? `blur(${(back * 9).toFixed(1)}px)` : 'none';
    rise(h.event, m('1.1', 'The causes differ') * (1 - T.p('1.2', 0, 0.4)), 24);

    // 1.2 · the fund, to scale, measured both ways.
    h.scale.style.opacity = String(scaled);
    const grown = glide(m('1.2', 'the American fund', 1.4));
    h.deposits.style.transform = `scaleX(${grown})`;
    h.depositsName.style.opacity = String(m('1.2', 'the American fund', 0.5));
    h.depositsFigure.textContent = '';
    h.above.style.opacity = String(m('1.2', 'about four dollars in ten'));
    h.depositsFigure.style.opacity = String(m('1.2', 'the American fund', 0.5));
    const funded = m('1.2', 'the American fund');
    h.fund.style.opacity = String(clamp(funded * 2));
    h.fund.style.transform = `scaleY(${spring(funded)})`;
    h.leader.style.transform = `scaleY(${glide(m('1.2', 'a hundred and sixty-one', 0.5))})`;
    rise(h.fundName, m('1.2', 'a hundred and sixty-one', 0.5), 16);
    const insured = m('1.2', 'about a cent and a half');
    const all = m('1.2', 'about four dollars in ten');
    h.cents.textContent = T.s(all > 0.5 ? 'cents' : 'insuredCents');
    h.cents.style.opacity = String(insured * Math.abs(2 * all - 1));
    h.cents.style.transform = `scale(${0.94 + 0.06 * spring(all > 0.5 ? all : insured)})`;
    h.behind.textContent = T.s(all > 0.5 ? 'behind' : 'insuredSays');
    rise(h.behind, insured * Math.abs(2 * all - 1), 18);
    h.source.style.opacity = String(insured);

    // 1.3 · a promise behind a promise, against a dollar that is locked.
    h.versus.style.opacity = String(versus);
    [['Insurance answers', 0], ['The other way', 1]].forEach(([phrase, index]) => {
      const p = m('1.3', phrase, 0.8);
      rise(h.rows[index].row, glide(p), 30);
      h.rows[index].fill.style.transform = `scaleX(${glide(clamp(p * 1.6 - 0.4))})`;
    });

    // 1.4 · your own bank app.
    const arrived = spring(closing);
    h.device.root.style.opacity = String(clamp(closing * 2));
    h.device.root.style.transform = `translateY(${(1 - arrived) * 90}px) scale(${lerp(0.7, 0.78, arrived)})`;
    h.device.update({});
    const stamped = T.p('1.4', 1.6, 0.5, 'linear');
    h.unsigned.style.opacity = String(stamped);
    h.unsigned.style.transform = `translateX(-50%) scale(${0.9 + 0.1 * spring(stamped)})`;
    const fixing = m('1.3', 'The other way', 0.5);
    const words = T.since('1.4') > 0 ? 'same' : fixing > 0.5 ? 'fix' : 'patch';
    h.line.textContent = T.s(words);
    h.line.style.color = TONE.ink;
    rise(h.line, T.since('1.4') > 0 ? m('1.4', 'a number in their records', 0.7) : m('1.3', 'Insurance answers', 0.5) * Math.abs(2 * fixing - 1) * (1 - T.p('1.4', 0, 0.3)), 24);
  },
};
