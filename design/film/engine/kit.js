// Drawing kit. Everything is positioned in 1920x1080 film pixels and redrawn from scratch-free
// state setters, so a scene's `frame` is a list of "this value at this time" statements.

import { W, H, clamp, lerp } from './core.js';
import { NORTH, SOUTH, landCells } from './world.js';

/**
 * Colour carries a money state or names a machine, never decoration. Two machines have a colour of
 * their own: the J-machine and the A-machine; an E-machine is ink. `theme('dark')` swaps the values
 * in place before any scene is mounted, so every module reads the same tokens.
 */
export const COLOR = {
  paper: '#FBFBFA',
  ink: '#0A0B0D',
  j: '#7A40DD',
  a: '#244FF0',
  /** On someone's word: cannot be checked. */
  trust: '#C4382B',
  /** Provable: checked by independent parties or signed by both sides. */
  proof: '#17895A',
  /** Provable but not secured: a risk someone chose. */
  warn: '#D9921A',
  credit: '#2F6F7A',
  collateral: '#E0A02E',
  flight: '#C58A1B',
  dispute: '#B23B2E',
  mute: 'rgba(21,20,15,0.56)',
  faint: 'rgba(21,20,15,0.30)',
  rule: 'rgba(21,20,15,0.14)',
};

const DARK = {
  paper: '#0E1014',
  ink: '#F4F1EA',
  j: '#A583FF',
  a: '#6EA8FF',
  trust: '#FF6B5E',
  proof: '#3DDC84',
  warn: '#F0B13C',
  credit: '#5FB6C2',
  collateral: '#E0A02E',
  flight: '#E0A02E',
  dispute: '#F26D6D',
  mute: 'rgba(244,241,234,0.62)',
  faint: 'rgba(244,241,234,0.34)',
  rule: 'rgba(244,241,234,0.18)',
};

/** Applies a named theme to the tokens and to the page. Call once, before mounting scenes. */
export const theme = name => {
  if (name !== 'dark') return;
  Object.assign(COLOR, DARK);
  const root = document.documentElement.style;
  root.setProperty('--paper', COLOR.paper);
  root.setProperty('--ink', COLOR.ink);
};

const FONT = { text: "'XLN Text'", display: "'XLN Display'", mono: "'JetBrains Mono'" };
const SVG_NS = 'http://www.w3.org/2000/svg';
const ANCHOR = { left: '0%', center: '-50%', right: '-100%' };

/** The typographic minus, so negative figures align with positive ones. */
export const figure = value => (value < 0 ? `−${Math.abs(Math.round(value))}` : String(Math.round(value)));

/** A CSS colour with the given alpha, from a `#RRGGBB` token. */
export const alpha = (hex, a) => {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`;
};

/**
 * A text block. `x` is the left edge, centre or right edge according to `align`; `y` is the top.
 * Pass `w` to wrap. Returned setters are idempotent and chainable.
 */
export const text = (parent, opts) => {
  const { x, y, size = 40, weight = 400, font = 'text', color = COLOR.ink, align = 'left', w, lh, tracking } = opts;
  const el = document.createElement('div');
  el.className = w ? 't wrap' : 't';
  Object.assign(el.style, {
    left: `${x}px`,
    top: `${y}px`,
    fontSize: `${size}px`,
    fontWeight: String(weight),
    fontFamily: FONT[font],
    color,
    textAlign: align,
    ...(w ? { width: `${w}px` } : {}),
    ...(lh ? { lineHeight: String(lh) } : {}),
    ...(tracking ? { letterSpacing: `${tracking}em` } : {}),
  });
  parent.appendChild(el);
  const offset = { dx: 0, dy: 0 };
  const place = () => {
    el.style.transform = `translate(calc(${ANCHOR[align]} + ${offset.dx}px), ${offset.dy}px)`;
  };
  place();
  const api = {
    el,
    /** A string, or `[[text, color], …]` to colour parts of one line by their money meaning. */
    set: value => {
      const key = typeof value === 'string' ? value : value.map(([part, tint]) => `${tint ?? ''}\u0001${part}`).join('\u0002');
      if (el.dataset.key === key) return api;
      el.dataset.key = key;
      if (typeof value === 'string') el.textContent = value;
      else el.replaceChildren(...value.map(([part, tint]) => Object.assign(document.createElement('span'), { textContent: part, style: tint ? `color:${tint}` : '' })));
      return api;
    },
    op: value => {
      el.style.opacity = String(clamp(value));
      return api;
    },
    shift: (dx, dy) => {
      Object.assign(offset, { dx, dy });
      place();
      return api;
    },
    color: value => {
      el.style.color = value;
      return api;
    },
  };
  return api;
};

/**
 * The chapter heading: each beat's on-screen words, top-left, cross-fading when the words change.
 * Beats that share the same words keep them on screen without a flicker; a beat with no words
 * clears the heading. Every chapter uses this so the film reads as one hand.
 */
export const heading = (parent, T, opts = {}) => {
  const ids = T.chapter.beats;
  const runs = ids.reduce((acc, id) => {
    const words = T.beat(id).onscreen;
    const last = acc[acc.length - 1];
    if (last && last.words === words) return acc;
    return [...acc, { words, from: id }];
  }, []);
  const lines = runs.map((run, index) => ({
    ...run,
    until: runs[index + 1]?.from,
    label: text(parent, { x: 260, y: 150, size: 56, weight: 600, font: 'display', ...opts }).set(run.words),
  }));
  return { update: () => lines.forEach(({ label, from, until }) => label.op(T.win(from, until, 0.6, 0.35))) };
};

const shape = el => {
  const api = {
    el,
    attr: attrs => {
      Object.entries(attrs).forEach(([name, value]) => el.setAttribute(name, String(value)));
      return api;
    },
    op: value => api.attr({ opacity: clamp(value) }),
    /** Draws a stroke on from its start: 0 hidden, 1 complete. */
    draw: progress => api.attr({ pathLength: 1, 'stroke-dasharray': 1, 'stroke-dashoffset': 1 - clamp(progress) }),
  };
  return api;
};

const shapes = into => {
  const make = tag => attrs => shape(into.appendChild(document.createElementNS(SVG_NS, tag))).attr(attrs ?? {});
  return {
    line: make('line'),
    rect: make('rect'),
    circle: make('circle'),
    path: make('path'),
    /** A nested group with the same shape makers; move or fade it as one. */
    group: attrs => {
      const g = make('g')(attrs);
      return { ...g, ...shapes(g.el) };
    },
  };
};

/** A full-stage SVG layer. Later layers paint over earlier ones. */
export const svg = parent => {
  const root = document.createElementNS(SVG_NS, 'svg');
  root.setAttribute('class', 'layer');
  root.setAttribute('viewBox', `0 0 ${W} ${H}`);
  parent.appendChild(root);
  return { root, ...shapes(root) };
};

/**
 * The account bar: one bilateral account for one asset, drawn to scale.
 *
 *   −L ............ 0 ............ C ............ C+R
 *   [ left credit ][  collateral  ][ right credit ]      marker = Δ, Left's allocation
 *
 * `L` is leftCreditLimit (how far Left may owe Right), `C` is collateral, `R` is
 * rightCreditLimit (how far Right may owe Left). Unused credit is an outline; drawn credit and
 * collateral are solid. This is docs/core/12_invariant.md, nothing more.
 *
 * `fixedEnds` keeps the party names at the bar's nominal ends while its zones grow in. A small
 * bar inside a network passes `reach: 8, markerWidth: 3` and updates with `figure: 0, ticks: 0`.
 */
export const bar = (parent, { x, y, w, h = 72, fixedEnds = false, reach = 30, markerWidth = 4 }) => {
  const layer = svg(parent);
  const zone = color => layer.rect({ y, height: h, fill: alpha(color, 0.13), stroke: color, 'stroke-width': 2 });
  const solid = color => layer.rect({ y, height: h, fill: color });
  const parts = {
    creditL: zone(COLOR.credit),
    creditR: zone(COLOR.credit),
    usedL: solid(COLOR.credit),
    usedR: solid(COLOR.credit),
    collateral: solid(COLOR.collateral),
    marker: layer.line({ y1: y - reach, y2: y + h + reach, stroke: COLOR.ink, 'stroke-width': markerWidth }),
  };
  const tickY = y + h + 16;
  const tick = () => ({
    mark: layer.line({ y1: y + h + 2, y2: y + h + 12, stroke: COLOR.mute, 'stroke-width': 2 }),
    label: text(parent, { x: 0, y: tickY, size: 24, font: 'mono', color: COLOR.mute, align: 'center' }),
  });
  const ticks = { low: tick(), zero: tick(), mid: tick(), high: tick() };
  const name = color => text(parent, { x: 0, y: tickY + 44, size: 26, color, align: 'center' });
  const names = { creditL: name(COLOR.credit), collateral: name('#9A6A12'), creditR: name(COLOR.credit) };
  const markerLabel = text(parent, { x: 0, y: y - 78, size: 30, font: 'mono', align: 'center' });
  const partyL = text(parent, { x: 0, y: y + h / 2 - 20, size: 30, color: COLOR.mute, align: 'right' });
  const partyR = text(parent, { x: 0, y: y + h / 2 - 20, size: 30, color: COLOR.mute, align: 'left' });
  let geometry = null;

  const span = (rect, from, to, opacity) => rect.attr({ x: Math.min(from, to), width: Math.abs(to - from) }).op(opacity);
  const placeTick = ({ mark, label }, at, value, opacity) => {
    mark.attr({ x1: at, x2: at }).op(opacity);
    label.set(value).op(opacity);
    label.el.style.left = `${at}px`;
  };
  const placeName = (label, from, to, value, opacity) => {
    label.set(value).op(opacity * clamp((to - from - 110) / 60));
    label.el.style.left = `${(from + to) / 2}px`;
  };

  /**
   * @param state.L, state.C, state.R, state.delta  account figures, in any unit
   * @param state.scale    pixels per unit; default fits the full range into the bar's width
   * @param state.op       whole bar
   * @param state.zones    credit and collateral fills (0 leaves only the marker)
   * @param state.marker   the Δ marker
   * @param state.figure   the `Δ = n` figure above the marker
   * @param state.ticks    −L, 0, C, C+R figures under the bar
   * @param state.names    zone names under the figures; needs `labels.creditL/collateral/creditR`
   * @param state.parties  party names at the two ends; needs `labels.left/right`
   * @param state.fmt      figure formatter, normally `T.num`
   */
  const update = state => {
    const { L, C, R, delta, op = 1, zones = 1, marker = 1, figure: figureOp = 1, ticks: tickOp = 1, names: nameOp = 0, parties = 0 } = state;
    const labels = state.labels ?? {};
    const fmt = state.fmt ?? figure;
    const scale = state.scale ?? w / Math.max(L + C + R, 1e-9);
    const x0 = x + (w - (L + C + R) * scale) / 2;
    const zero = x0 + L * scale;
    const cx = zero + C * scale;
    const x1 = cx + R * scale;
    const mx = zero + delta * scale;
    geometry = { x0, zero, cx, x1, mx, y, h, scale };

    span(parts.creditL, x0, zero, op * zones);
    span(parts.creditR, cx, x1, op * zones);
    span(parts.collateral, zero, cx, op * zones);
    span(parts.usedL, Math.min(mx, zero), zero, op * zones);
    span(parts.usedR, cx, Math.max(mx, cx), op * zones);
    parts.marker.attr({ x1: mx, x2: mx }).op(op * marker);
    markerLabel.set(`Δ = ${fmt(Math.round(delta))}`).op(op * marker * figureOp);
    markerLabel.el.style.left = `${mx}px`;

    const shown = op * tickOp;
    placeTick(ticks.low, x0, fmt(Math.round(-L)), shown * clamp(L * scale / 40));
    placeTick(ticks.zero, zero, '0', shown);
    placeTick(ticks.mid, cx, fmt(Math.round(C)), shown * clamp(C * scale / 40));
    placeTick(ticks.high, x1, fmt(Math.round(C + R)), shown * clamp(R * scale / 40));
    placeName(names.creditL, x0, zero, labels.creditL ?? '', op * nameOp);
    placeName(names.collateral, zero, cx, labels.collateral ?? '', op * nameOp);
    placeName(names.creditR, cx, x1, labels.creditR ?? '', op * nameOp);
    partyL.set(labels.left ?? '').op(op * parties);
    partyL.el.style.left = `${(fixedEnds ? x : x0) - 28}px`;
    partyR.set(labels.right ?? '').op(op * parties);
    partyR.el.style.left = `${(fixedEnds ? x + w : x1) + 28}px`;
    return geometry;
  };

  /** Pixel positions of the last drawn state, for annotations a scene adds on top. */
  return { update, geom: () => geometry };
};

const KEYWORDS = new Set(
  (
    'const let var return if else for while function export import from interface type new throw ' +
    'struct mapping memory storage calldata internal external public private view pure returns emit ' +
    'require revert contract unchecked delete true false bool address uint256 int256 bytes32 bytes ' +
    'bigint number string boolean'
  ).split(' '),
);

const tokens = line => {
  const comment = line.indexOf('//');
  const codePart = comment < 0 ? line : line.slice(0, comment);
  const pieces = codePart.split(/([A-Za-z_$][\w$]*)/).map(piece => ({ text: piece, kind: KEYWORDS.has(piece) ? 'k' : '' }));
  return comment < 0 ? pieces : [...pieces, { text: line.slice(comment), kind: 'c' }];
};

/** The build replaces lines the script elides with this mark; it is the only text not from the repository. */
const ELISION = '⋯';

const codeLine = source => {
  const row = document.createElement('div');
  row.className = source.trim() === ELISION ? 'line c' : 'line';
  tokens(source.length ? source : ' ').forEach(({ text: piece, kind }) => {
    const part = document.createElement('span');
    if (kind) part.className = kind;
    part.textContent = piece;
    row.appendChild(part);
  });
  return row;
};

/**
 * A code panel showing an excerpt extracted from the repository at build time.
 * The type size fits the longest line into `w`; a line longer than `clip` characters is cut with
 * an ellipsis, and a line containing an `elide` substring becomes a visible ⋯ (runs collapse). Lines are addressed by a substring of their text, so a mark fails loudly if the
 * source no longer contains it.
 */
export const code = (parent, snippet, { x, y, w, maxSize = 26, minSize = 15, clip = 96, elide = [] }) => {
  if (!snippet) throw new Error('FILM_CODE_PANEL_WITHOUT_SNIPPET');
  elide.forEach(needle => {
    if (!snippet.lines.some(line => line.includes(needle))) throw new Error(`FILM_CODE_ELIDE_NOT_FOUND: "${needle}" in ${snippet.file}:${snippet.start}`);
  });
  const kept = snippet.lines.reduce((lines, line) => {
    if (!elide.some(needle => line.includes(needle))) return [...lines, line];
    const mark = `${line.slice(0, line.length - line.trimStart().length)}${ELISION}`;
    return lines[lines.length - 1]?.trim() === ELISION ? lines : [...lines, mark];
  }, []);
  const shown = kept.map(line => (line.length > clip ? `${line.slice(0, clip - 1)}…` : line));
  const longest = Math.max(...shown.map(line => line.length), snippet.file.length + 12);
  const size = clamp((w - 26) / (longest * 0.6), minSize, maxSize);
  const panel = document.createElement('div');
  panel.className = 'code';
  Object.assign(panel.style, { left: `${x}px`, top: `${y}px`, width: `${w}px`, fontSize: `${size}px`, lineHeight: '1.62' });
  const head = document.createElement('div');
  head.className = 'head';
  head.textContent = `${snippet.file} · ${snippet.start}–${snippet.end}`;
  Object.assign(head.style, { fontSize: `${Math.max(size * 0.72, 14)}px`, marginBottom: `${size * 0.7}px`, paddingLeft: '26px' });
  panel.appendChild(head);
  const rows = shown.map(codeLine);
  rows.forEach(row => panel.appendChild(row));
  parent.appendChild(panel);

  const find = needle => {
    const hits = shown.flatMap((line, index) => (line.includes(needle) ? [index] : []));
    if (!hits.length) throw new Error(`FILM_CODE_MARK_NOT_FOUND: "${needle}" in ${snippet.file}:${snippet.start}`);
    return hits;
  };

  /**
   * @param state.op      whole panel
   * @param state.reveal  0→1 shows lines top to bottom
   * @param state.marks   `[substring, colorKey, strength 0..1]` — tints matching lines and dims the rest
   */
  const update = ({ op = 1, reveal = 1, marks = [] }) => {
    panel.style.opacity = String(clamp(op));
    head.style.opacity = String(clamp(reveal * 3));
    const strength = rows.map(() => ({ value: 0, color: COLOR.ink }));
    marks.forEach(([needle, colorKey, value = 1]) =>
      find(needle).forEach(index => {
        if (value >= strength[index].value) strength[index] = { value, color: COLOR[colorKey] };
      }),
    );
    const focus = Math.max(0, ...strength.map(entry => entry.value));
    rows.forEach((row, index) => {
      const { value, color } = strength[index];
      const visible = clamp(reveal * (rows.length + 1) - index);
      row.style.opacity = String(visible * lerp(1, lerp(0.34, 1, value), focus));
      row.style.borderLeftColor = alpha(color, value);
      row.style.background = alpha(color, 0.1 * value);
    });
  };

  return { update, height: () => panel.offsetHeight, size };
};

/**
 * A coarse dot-grid world map. `at(lon, lat)` gives film pixels for a place, so a scene can stand
 * entities on it. The map is context, never data: keep it faint.
 */
export const worldmap = (parent, { x, y, w, r = 3.4 }) => {
  const layer = svg(parent);
  const h = (w * (NORTH - SOUTH)) / 360;
  const at = (lon, lat) => ({ x: x + ((lon + 180) / 360) * w, y: y + ((NORTH - lat) / (NORTH - SOUTH)) * h });
  const dots = layer.group();
  landCells().forEach(cell => {
    const point = at(cell.lon, cell.lat);
    dots.circle({ cx: point.x.toFixed(1), cy: point.y.toFixed(1), r, fill: COLOR.ink });
  });
  return { at, height: h, update: ({ op = 1, strength = 0.2 }) => dots.op(op * strength) };
};

/**
 * A ledger: ruled monospace rows, no card chrome. `columns` are x offsets of each cell from the
 * ledger's left edge. Rows beyond those passed to `update` stay hidden.
 *
 * `update({ op, title, rows: [{ cells, op, color, outline: [colorKey, strength], strike }] })`
 */
export const ledger = (parent, { x, y, w, rows, columns = [0], size = 26, rowH = 50 }) => {
  const layer = svg(parent);
  const title = text(parent, { x, y: y - 46, size: 26, color: COLOR.mute });
  const rules = Array.from({ length: rows + 1 }, (_, index) =>
    layer.line({ x1: x, x2: x + w, y1: y + index * rowH, y2: y + index * rowH, stroke: COLOR.ink, 'stroke-width': 1.5, opacity: 0 }),
  );
  const lines = Array.from({ length: rows }, (_, index) => ({
    cells: columns.map(offset => text(parent, { x: x + offset + 14, y: y + index * rowH + (rowH - size * 1.2) / 2, size, font: 'mono' })),
    outline: layer.rect({ x: x - 1, y: y + index * rowH, width: w + 2, height: rowH, fill: 'none', 'stroke-width': 3, opacity: 0 }),
    strike: layer.line({ x1: x + 8, x2: x + w - 8, y1: y + (index + 0.5) * rowH, y2: y + (index + 0.5) * rowH, stroke: COLOR.ink, 'stroke-width': 2 }),
  }));
  const update = ({ op = 1, title: words = '', rows: shown = [] }) => {
    title.set(words).op(op);
    const count = shown.reduce((visible, row, index) => ((row.op ?? 1) > 0.02 ? index + 1 : visible), 0);
    rules.forEach((rule, index) => rule.op(index <= Math.max(count, 1) ? op * 0.16 : 0));
    lines.forEach((line, index) => {
      const row = shown[index] ?? { cells: [], op: 0 };
      const rowOp = op * (row.op ?? 1);
      line.cells.forEach((cell, column) => cell.set(row.cells[column] ?? '').op(rowOp).color(row.color ?? COLOR.ink));
      const [tint, strength] = row.outline ?? ['ink', 0];
      line.outline.attr({ stroke: COLOR[tint] }).op(rowOp * strength);
      line.strike.draw(row.strike ?? 0).op(rowOp * ((row.strike ?? 0) > 0 ? 1 : 0));
    });
  };
  return { update, rowY: index => y + index * rowH, height: rows * rowH };
};

/**
 * An entity: an ink circle with its name under it (or over it). Draw accounts as lines on an
 * earlier svg layer so the circle sits on top of them.
 *
 * `update({ x, y, op, r, fill, label, labelOp, above })`
 */
export const entity = (parent, layer, { r = 12, size = 26 } = {}) => {
  const dot = layer.circle({ r, fill: COLOR.ink });
  const name = text(parent, { x: 0, y: 0, size, color: COLOR.mute, align: 'center' });
  const update = ({ x, y, op = 1, r: radius = r, fill = COLOR.ink, label = '', labelOp = 1, above = false }) => {
    dot.attr({ cx: x, cy: y, r: radius, fill }).op(op);
    name.set(label).op(op * labelOp);
    name.el.style.left = `${x}px`;
    name.el.style.top = `${above ? y - radius - 14 - size * 1.2 : y + radius + 12}px`;
  };
  return { update };
};

/**
 * A signature mark: an empty square that fills with ink when the party has signed. Two parties,
 * two seals. `update({ x, y, op, signed })`; `x, y` is the top-left corner.
 */
export const seal = (layer, { size = 20 } = {}) => {
  const fill = layer.rect({ width: size, height: size, fill: COLOR.ink });
  const frame = layer.rect({ width: size, height: size, fill: 'none', stroke: COLOR.ink, 'stroke-width': 2 });
  const update = ({ x, y, op = 1, signed = 0 }) => {
    frame.attr({ x, y }).op(op);
    fill.attr({ x, y }).op(op * signed);
  };
  return { update, size };
};

/**
 * A hairline time axis with up to `ticks` labelled marks.
 * `update({ op, draw, ticks: [{ at: 0..1, label, op }] })`
 */
export const axis = (parent, { x, y, w, ticks = 4 }) => {
  const layer = svg(parent);
  const line = layer.line({ x1: x, x2: x + w, y1: y, y2: y, stroke: COLOR.ink, 'stroke-width': 2 });
  const marks = Array.from({ length: ticks }, () => ({
    mark: layer.line({ y1: y - 9, y2: y + 9, stroke: COLOR.ink, 'stroke-width': 2 }),
    label: text(parent, { x: 0, y: y + 20, size: 24, font: 'mono', color: COLOR.mute, align: 'center' }),
  }));
  const update = ({ op = 1, draw = 1, ticks: shown = [] }) => {
    line.draw(draw).op(op * 0.55);
    marks.forEach(({ mark, label }, index) => {
      const tick = shown[index];
      const at = x + (tick?.at ?? 0) * w;
      const tickOp = tick ? op * (tick.op ?? 1) : 0;
      mark.attr({ x1: at, x2: at }).op(tickOp * 0.8);
      label.set(tick?.label ?? '').op(tickOp);
      label.el.style.left = `${at}px`;
    });
  };
  return { update, at: fraction => x + fraction * w };
};

/**
 * A footnote: a qualification the picture owes the viewer but the narrator does not speak.
 * One at a time, bottom-left of the column. `.set(words).op(value)`
 */
export const footnote = (parent, opts = {}) => text(parent, { x: 260, y: 852, size: 22, font: 'mono', color: COLOR.mute, ...opts });

/**
 * The status line, bottom-right of the column: what the viewer must keep in mind while a scene
 * shows something not yet live ("testnet · no real funds"). `.set(words).op(value)`
 */
export const status = (parent, opts = {}) => text(parent, { x: 1660, y: 852, size: 22, font: 'mono', color: COLOR.faint, align: 'right', ...opts });
