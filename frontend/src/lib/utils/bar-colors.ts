import type { BarColorMode } from '$lib/types/ui';

interface BarColors {
  credit: string;
  collateral: string;
  debt: string;
}

const RGY: BarColors = { credit: '#eab308', collateral: '#10b981', debt: '#ef4444' };

export function getBarColors(mode: BarColorMode, tokenColor: string): BarColors {
  if (mode === 'token') return { credit: tokenColor, collateral: tokenColor, debt: tokenColor };
  if (mode === 'theme') return { credit: 'var(--accent-gold, #eab308)', collateral: 'var(--accent-green, #10b981)', debt: 'var(--accent-red, #ef4444)' };
  return RGY;
}
