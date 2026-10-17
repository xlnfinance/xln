import { expect, type Page } from '@playwright/test';

/** Compare rendered lengths to money on the live wallet, including nested account bars. */
export async function expectDollarScale(page: Page) {
  await expect
    .poll(() =>
      page.locator('.wallet-home [data-bar-usd]').evaluateAll(bars => {
        const failures: string[] = [];
        for (const bar of bars) {
          const usd = Number((bar as HTMLElement).dataset['barUsd']);
          const ppu = Number(getComputedStyle(bar).getPropertyValue('--ppu'));
          const drawing = bar.querySelector('.bar')!;
          const width = drawing.getBoundingClientRect().width;
          if (Math.abs(width - usd * ppu) > 0.15) failures.push(`Wrong scale: $${usd}, ${width}px, ${ppu}px/USD`);
          if (width > bar.getBoundingClientRect().width + 0.15) failures.push(`Clipped: $${usd}`);
          // Home fits its scale to the widths, so no bar may fade out at its edge (the fade is a mask).
          const style = getComputedStyle(bar);
          const mask = style.maskImage || style.getPropertyValue('-webkit-mask-image');
          if (mask && mask !== 'none') failures.push('Fading edge');
        }
        for (const label of document.querySelectorAll<HTMLElement>('.wallet-account .rt .t')) {
          if (label.scrollWidth > label.clientWidth + 1) failures.push('Clipped account identity');
        }
        return failures;
      }),
    )
    .toEqual([]);
}
