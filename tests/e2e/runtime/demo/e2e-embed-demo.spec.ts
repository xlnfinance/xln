import { expect, test } from '../../../global-setup.mts';
import type { Page } from '@playwright/test';
import { timedStep } from '../../../utils/e2e-timing.mts';
import { capturePageScreenshot } from '../../../utils/e2e-screenshots';

/**
 * Presenter demo: the shipped trails play offline in presentation mode, step by step, with
 * narration, a rendered stage and keyboard control; the lobby opens each of them. Any console
 * error or page error fails the test through the global browser-issue guard.
 */

const TRAILS = ['ahb', 'lock-ahb', 'swap', 'settle', 'dispute-lifecycle', 'bank-default'] as const;

const narration = (page: Page) => page.getByTestId('presentation-narration');

const currentStep = async (page: Page): Promise<number> => {
  const text = (await page.getByTestId('presentation-step').textContent()) ?? '';
  const match = text.match(/Step (\d+) of (\d+)/);
  if (!match) throw new Error(`EMBED_DEMO_STEP_UNREADABLE:${text}`);
  return Number(match[1]);
};

const narrationTitle = async (page: Page): Promise<string> =>
  ((await narration(page).locator('h1').textContent()) ?? '').trim();

/**
 * Share of stage pixels brighter than the navy background. The WebGL canvas is read from a
 * composited screenshot, so it does not depend on preserveDrawingBuffer.
 */
const litStageShare = async (page: Page): Promise<number> => {
  const png = await page.locator('.graph3d-panel canvas').first().screenshot();
  return page.evaluate(async (base64) => {
    // Decoded from bytes, not fetched: the page's CSP rightly refuses data: connections.
    const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
    const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext('2d');
    if (!context) throw new Error('EMBED_DEMO_SAMPLE_CONTEXT_UNAVAILABLE');
    context.drawImage(bitmap, 0, 0);
    const { data } = context.getImageData(0, 0, bitmap.width, bitmap.height);
    let lit = 0;
    let sampled = 0;
    for (let index = 0; index < data.length; index += 4 * 53) {
      sampled += 1;
      if (data[index]! + data[index + 1]! + data[index + 2]! > 150) lit += 1;
    }
    return lit / sampled;
  }, png.toString('base64'));
};

const openPresentation = async (page: Page, trail: string): Promise<void> => {
  await page.goto(`/embed?trail=${trail}&present=1`);
  await expect(narration(page)).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('presentation-step')).toContainText(/Step 1 of \d+/, { timeout: 30_000 });
};

test.describe('presenter demo', () => {
  for (const trail of TRAILS) {
    test(`${trail} trail narrates, renders and responds to the presenter keys`, { tag: '@functional' }, async ({ page }) => {
      test.setTimeout(120_000);
      await timedStep(`embed_demo.${trail}.open`, async () => openPresentation(page, trail));
      await capturePageScreenshot(page, test.info(), `${trail}-1-open.png`, { fullPage: false });
      await expect(page.getByTestId('presentation-part')).toContainText(`Part ${TRAILS.indexOf(trail) + 1} of ${TRAILS.length}`);
      // The Depository's own balances are on stage from the first step.
      await expect(page.getByTestId('depository-ledger')).toBeVisible({ timeout: 15_000 });
      // The duplicate dock strip is not drawn in a presentation; the card carries the controls.
      await expect(page.getByTestId('network-machine-scrubber')).toBeHidden();

      // → advances one step at a time, and the narration moves on to the next cue.
      const firstTitle = await narrationTitle(page);
      expect(firstTitle.length).toBeGreaterThan(0);
      let title = firstTitle;
      for (let press = 1; press <= 12 && title === firstTitle; press += 1) {
        await page.keyboard.press('ArrowRight');
        await expect.poll(() => currentStep(page), { timeout: 10_000 }).toBe(press + 1);
        title = await narrationTitle(page);
      }
      expect(title, 'narration title should change within the first steps').not.toBe(firstTitle);
      await capturePageScreenshot(page, test.info(), `${trail}-2-step-${await currentStep(page)}.png`, { fullPage: false });

      // The stage is drawn, not a blank canvas.
      await expect
        .poll(() => litStageShare(page), { timeout: 15_000, message: 'stage should render banks and bars' })
        .toBeGreaterThan(0.004);

      // Space plays, Space again pauses.
      const beforePlay = await currentStep(page);
      await page.keyboard.press(' ');
      await expect.poll(() => currentStep(page), { timeout: 10_000 }).toBeGreaterThan(beforePlay);
      await page.keyboard.press(' ');
      const paused = await currentStep(page);
      await page.waitForTimeout(2_500);
      expect(await currentStep(page)).toBeLessThanOrEqual(paused + 1);

      // The last step offers what comes next in the story, with a legend for what is drawn.
      await page.keyboard.press('End');
      await expect(page.getByTestId('presentation-legend').locator('li').first()).toBeVisible({ timeout: 10_000 });
      const next = page.getByTestId('presentation-next');
      await expect(next).toBeVisible({ timeout: 10_000 });
      const expectedNext = TRAILS[TRAILS.indexOf(trail) + 1];
      await expect(next).toHaveAttribute('href', expectedNext ? `/embed?trail=${expectedNext}&present=1` : '/demo');
      await capturePageScreenshot(page, test.info(), `${trail}-3-end.png`, { fullPage: false });
    });
  }

  test('a failed bank\'s debts stand in a first-come queue on the Depository ledger', { tag: '@functional' }, async ({ page }) => {
    test.setTimeout(120_000);
    await timedStep('embed_demo.bank_default_queue.open', async () => openPresentation(page, 'bank-default'));
    const ledger = page.getByTestId('depository-ledger');
    const advanceTo = async (pattern: RegExp): Promise<void> => {
      for (let press = 0; press < 60 && !pattern.test(await narrationTitle(page)); press += 1) {
        const step = await currentStep(page);
        await page.keyboard.press('ArrowRight');
        await expect.poll(() => currentStep(page), { timeout: 10_000 }).toBe(step + 1);
      }
      expect(await narrationTitle(page)).toMatch(pattern);
    };
    // Two unsecured claims queue oldest-first while Hub's reserve is empty.
    await advanceTo(/^Bob's claim becomes Hub's debt/);
    await expect(ledger).toContainText('Debts, first-come queue');
    const debts = ledger.locator('li[data-ledger-row^="debt:"]');
    await expect(debts).toHaveCount(2);
    await expect(debts.nth(0)).toContainText('Hub owes Alice');
    await expect(debts.nth(1)).toContainText('Hub owes Bob');
    await capturePageScreenshot(page, test.info(), 'bank-default-queue.png', { fullPage: false });
    // Enforcement pays the head of the queue in full before the next claim.
    await advanceTo(/^The queue is paid first-come/);
    await expect(debts).toHaveCount(1);
    await expect(debts.first()).toContainText('Hub owes Bob');
    await capturePageScreenshot(page, test.info(), 'bank-default-enforced.png', { fullPage: false });
    // The time machine scrubs back: the queue and the narration return to the starting point.
    await page.getByTestId('presentation-scrubber').fill('0');
    await expect.poll(() => currentStep(page), { timeout: 10_000 }).toBe(1);
    await expect(narration(page).locator('h1')).toHaveText(/^Starting point/);
    await expect(debts).toHaveCount(0);
  });

  test('payments narrate their three layers of finality as a step of their own', { tag: '@functional' }, async ({ page }) => {
    test.setTimeout(120_000);
    await timedStep('embed_demo.ahb_finality.open', async () => openPresentation(page, 'ahb'));
    // The setup is condensed: the presentation opens on the starting point it summarises.
    await expect(narration(page).locator('h1')).toHaveText(/^Starting point/);
    let found = false;
    for (let press = 0; press < 40 && !found; press += 1) {
      await page.keyboard.press('ArrowRight');
      await expect.poll(() => currentStep(page), { timeout: 10_000 }).toBe(press + 2);
      found = await page.getByTestId('presentation-badges').isVisible();
    }
    expect(found, 'a finality ladder should appear within the first payment').toBe(true);
    await expect(page.getByTestId('presentation-badges').locator('li')).toHaveText([/^.?Bilateral/, /^.?On-chain/, /^.?Legal/]);
    // The narration speaks for itself: no per-frame runtime line under an authored step.
    await expect(page.getByTestId('presentation-observed')).toHaveCount(0);
  });

  test('lobby lists every chapter and its links open the presentation', { tag: '@functional' }, async ({ page }) => {
    test.setTimeout(120_000);
    await timedStep('embed_demo.lobby.open', async () => page.goto('/demo'));
    await expect(page.getByTestId('demo-lobby')).toBeVisible({ timeout: 30_000 });
    const cards = page.getByTestId('demo-card');
    await expect(cards).toHaveCount(TRAILS.length);
    for (const [index, trail] of TRAILS.entries()) {
      await expect(cards.nth(index)).toHaveAttribute('href', `/embed?trail=${trail}&present=1`);
      await expect(cards.nth(index).getByTestId('demo-card-meta')).toContainText(/\d+ steps · .+ at 1×/, { timeout: 30_000 });
    }
    await expect(page.getByTestId('demo-start-story')).toHaveAttribute('href', '/embed?trail=ahb&present=1');

    await cards.nth(TRAILS.indexOf('settle')).click();
    await expect(page).toHaveURL(/\/embed\?trail=settle&present=1$/);
    await expect(narration(page)).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('presentation-step')).toContainText(/Step 1 of \d+/, { timeout: 30_000 });

    await page.goto('/demo');
    await page.getByTestId('demo-start-story').click();
    await expect(page).toHaveURL(/\/embed\?trail=ahb&present=1$/);
    await expect(page.getByTestId('presentation-part')).toContainText(`Part 1 of ${TRAILS.length}`, { timeout: 30_000 });
  });
});
