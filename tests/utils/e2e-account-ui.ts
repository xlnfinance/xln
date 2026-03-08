import { type Page } from '@playwright/test';

export async function getRenderedPrimaryOutbound(page: Page): Promise<number> {
  return page.evaluate(() => {
    const selectedCard =
      document.querySelector('.account-preview.selected')
      || document.querySelector('.account-preview');
    if (!selectedCard) return 0;

    const outEl = selectedCard.querySelector(
      '.delta-row .compact-out-value, .compact-out-value, .cap.out .cap-value',
    );
    if (!outEl) return 0;

    const raw = String(outEl.textContent || '').replace(/,/g, '').trim();
    const numeric = Number(raw.replace(/[^0-9.-]/g, ''));
    return Number.isFinite(numeric) ? numeric : 0;
  });
}

export async function waitForRenderedPrimaryOutboundDelta(
  page: Page,
  baseline: number,
  expectedDelta: number,
  options?: {
    timeoutMs?: number;
    tolerance?: number;
  },
): Promise<number> {
  const timeoutMs = options?.timeoutMs ?? 20_000;
  const tolerance = options?.tolerance ?? 0.000001;
  const startedAt = Date.now();
  let latest = baseline;

  while (Date.now() - startedAt < timeoutMs) {
    latest = await getRenderedPrimaryOutbound(page);
    if (Math.abs((latest - baseline) - expectedDelta) <= tolerance) return latest;
    await page.waitForTimeout(250);
  }

  throw new Error(
    `Timed out waiting for rendered outbound delta baseline=${baseline} latest=${latest} expectedDelta=${expectedDelta}`,
  );
}
