import type { DerivedDelta } from '../runtime-types';
import type { BarStyle } from './settings';
import { colorizeBar, colorizeTwinSegment } from './theme';

export type BarRenderOptions = {
  style: BarStyle;
  width?: number;
  color?: boolean;
};

const clampWidth = (width: number): number => Math.max(8, Math.min(80, Math.floor(width)));

const repeat = (ch: string, n: number): string => (n > 0 ? ch.repeat(n) : '');

const segmentWidths = (parts: bigint[], totalWidth: number): number[] => {
  const sum = parts.reduce((a, b) => a + b, 0n);
  if (sum <= 0n || totalWidth <= 0) return parts.map(() => 0);
  const raw = parts.map(part => Number((part * BigInt(totalWidth)) / sum));
  let used = raw.reduce((a, b) => a + b, 0);
  // Distribute remainder to largest fractional parts by bumping non-zero buckets.
  let i = 0;
  while (used < totalWidth && i < raw.length * 2) {
    const idx = i % raw.length;
    if (parts[idx]! > 0n) {
      raw[idx]! += 1;
      used += 1;
    }
    i += 1;
  }
  return raw;
};

const buildSide = (
  credit: bigint,
  collateral: bigint,
  debt: bigint,
  width: number,
): { text: string; kinds: Array<'credit' | 'collateral' | 'debt' | 'pad'> } => {
  const [cW, collW, dW] = segmentWidths([credit, collateral, debt], width);
  const chars: string[] = [];
  const kinds: Array<'credit' | 'collateral' | 'debt' | 'pad'> = [];
  for (let i = 0; i < cW; i++) {
    chars.push('-');
    kinds.push('credit');
  }
  for (let i = 0; i < collW; i++) {
    chars.push('=');
    kinds.push('collateral');
  }
  for (let i = 0; i < dW; i++) {
    chars.push('-');
    kinds.push('debt');
  }
  while (chars.length < width) {
    chars.push(' ');
    kinds.push('pad');
  }
  return { text: chars.join(''), kinds };
};

/** Closed bar: prefer runtime deriveDelta().ascii (canonical), optionally recolor. */
export const renderClosedBar = (derived: DerivedDelta, color = true): string => {
  const ascii = derived.ascii || '[|]';
  return color ? colorizeBar(ascii) : ascii;
};

/**
 * Twin bars mirror DeltaCapacityBar out/in shells:
 * out: ownCredit(-) collateral(=) peerCredit/debt(-)
 * in:  ownCredit/debt(-) collateral(=) peerCredit(-)
 */
export const renderTwinBars = (derived: DerivedDelta, width = 24, color = true): string => {
  const half = clampWidth(Math.floor(width / 2));
  const out = buildSide(derived.outOwnCredit, derived.outCollateral, derived.outPeerCredit, half);
  const inn = buildSide(derived.inOwnCredit, derived.inCollateral, derived.inPeerCredit, half);
  const paintSide = (side: typeof out): string => {
    if (!color) return side.text;
    return side.text
      .split('')
      .map((ch, i) => {
        const kind = side.kinds[i]!;
        if (kind === 'pad') return ' ';
        return colorizeTwinSegment(ch, kind);
      })
      .join('');
  };
  return `out[${paintSide(out)}] in[${paintSide(inn)}]`;
};

export const renderCapacityBar = (derived: DerivedDelta, options: BarRenderOptions): string => {
  if (options.style === 'twin') {
    return renderTwinBars(derived, options.width ?? 48, options.color !== false);
  }
  return renderClosedBar(derived, options.color !== false);
};

export const formatBarLegend = (style: BarStyle): string =>
  style === 'twin'
    ? 'legend: - credit/debt  = collateral  | twin out/in shells'
    : 'legend: - credit  = collateral  | delta position';

/** Pure helper for tests: build a closed ascii bar from numeric capacities. */
export const buildClosedAscii = (
  leftCredit: bigint,
  collateral: bigint,
  rightCredit: bigint,
  delta: bigint,
  width = 50,
): string => {
  const total = leftCredit + collateral + rightCredit;
  const w = total > 0n ? total : 1n;
  const leftW = Number((leftCredit * BigInt(width)) / w);
  const collW = Number((collateral * BigInt(width)) / w);
  const rightW = Math.max(0, width - leftW - collW);
  const bar = repeat('-', leftW) + repeat('=', collW) + repeat('-', rightW);
  const marker = Number(((delta + leftCredit) * BigInt(width)) / w);
  const pos = Math.max(0, Math.min(marker, bar.length));
  return `[${bar.slice(0, pos)}|${bar.slice(pos)}]`;
};
