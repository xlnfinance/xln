import { LOCAL_PASSWORD, waitForWalletBoot } from '../../../ui/tests/wallet-ui';
import { expect, type Page } from '@playwright/test';
import { settledTourState, tourToken } from './committed';
import { getHealth } from '../e2e-baseline';

export async function next(page: Page, id: string): Promise<void> {
  await expect(page.getByTestId('tour')).toHaveAttribute('data-step', id, { timeout: 45_000 });
}

export async function skip(page: Page, expected: RegExp, skipped: Record<string, string>): Promise<void> {
  const reason = page.getByTestId('tour-skip-reason');
  await expect(reason).toContainText(expected);
  const id = await page.getByTestId('tour').getAttribute('data-step');
  if (!id) throw new Error('TUTORIAL_CHAPTER_MISSING');
  skipped[id] = await reason.innerText();
  await page.getByTestId('tour-advance').click();
}

export async function prepareCredit(page: Page): Promise<void> {
  const spectrum = page.getByTestId('receive-spectrum');
  await expect
    .poll(
      async () =>
        (await page.locator('[data-testid=swap-submit]:enabled, [data-testid=lend-submit]:enabled').count()) > 0 ||
        (await spectrum.count()) > 0,
      { timeout: 20_000 },
    )
    .toBe(true);
  if ((await spectrum.count()) === 0) return;
  await spectrum.getByRole('button', { name: 'Accept it as credit instead', exact: true }).click();
  await expect(page.getByTestId('receive-spectrum-confirm')).toHaveText('Extend credit limit');
  await page.getByTestId('receive-spectrum-confirm').click();
  await expect(spectrum).toHaveCount(0, { timeout: 20_000 });
}

/** Prerequisite funding through the guide's visible Assets link. No financial API commands. */
export async function fundReserve(page: Page, hubId: string): Promise<void> {
  await page.getByTestId('tour-company-gas').click();
  await page.getByTestId('faucet-amount').fill('0.1');
  await page.getByTestId('faucet-gas').click();
  await expect(page.getByTestId('faucet-gas')).toBeEnabled({ timeout: 20_000 });
  await page.getByTestId('faucet-amount').fill('20');
  await page.getByTestId('faucet-reserve').click();
  await expect(page.getByTestId('faucet-reserve')).toBeEnabled({ timeout: 20_000 });
  await expect.poll(async () => tourToken(await settledTourState(page, hubId, 'funding'), 1).reserve).toBe(20_000_000n);
  // Re-entering the chapter captures the funded committed starting point.
  await page.getByTestId('tour-chapter').selectOption('balance');
  await page.getByTestId('tour-chapter').selectOption('move');
}

export async function openSecondHub(page: Page): Promise<void> {
  const health = await getHealth(page);
  const hub = health?.hubs?.find(row => row.name === 'H2' && row.online);
  if (!hub?.entityId) throw new Error('TUTORIAL_SECOND_HUB_UNAVAILABLE');
  await page.getByTestId('home-open-account').click();
  const sheet = page.getByRole('dialog', { name: 'Open account', exact: true });
  await sheet.getByTestId('open-account-target').fill(hub.entityId);
  await sheet.getByTestId('open-account-credit').fill('0');
  await sheet.getByRole('button', { name: 'Propose account', exact: true }).click();
}

export async function cancelCrossOrder(page: Page) {
  await page.getByTestId('swap-cross-mode').click();
  await page.getByTestId('swap-give').fill('1');
  await page.getByTestId('swap-want').fill('1');
  const here = (await page.locator('.hop.me').innerText()).trim();
  const hub = page.locator('.kv').filter({ hasText: 'Hub there' }).locator('select');
  await hub.selectOption({ label: here });
  await page.getByTestId('swap-give').fill('1');
  await page.getByTestId('swap-want').fill('1'); // Deliberately unmatched USDC → WETH limit.
  await prepareCredit(page);
  await expect(page.getByTestId('swap-submit')).toBeEnabled({ timeout: 20_000 });
  await page.getByTestId('swap-submit').click();
  await expect(page.getByTestId('cross-order-row')).toHaveCount(1, { timeout: 20_000 });
  const targetEntityId = await page.locator('.kv').filter({ hasText: 'Your other account' }).locator('select').inputValue();
  const targetHubId = await hub.inputValue();
  await page.getByTestId('cross-order-cancel-clear').click();
  return { targetEntityId, targetHubId };
}

/** A restored signing key must spend recovered money and retain the debit after another unlock. */
export async function proveRecoveredPayment(page: Page, hubId: string): Promise<void> {
  await page.getByTestId('nav-home').locator('visible=true').first().click();
  const before = await settledTourState(page, hubId, 'recovered-before-payment');
  await page.getByTestId('home-pay').click();
  await page.getByTestId('pay-to').fill('H');
  await page.locator('[data-testid^="pay-suggestion-H2"]').first().click();
  await page.getByTestId('pay-amount').fill('1');
  await expect(page.getByTestId('pay-submit')).toBeEnabled();
  const quoted = await page.getByTestId('pay-quote').getAttribute('data-sender-amount');
  if (!quoted) throw new Error('TUTORIAL_RECOVERED_PAYMENT_QUOTE_MISSING');
  await page.getByTestId('pay-submit').click();
  await page.getByTestId('receipt-open').click();
  await expect(page.getByTestId('receipt-kicker')).toHaveText('Paid', { timeout: 20_000 });
  await page.getByTestId('receipt-done').click();
  const after = await settledTourState(page, hubId, 'recovered-after-payment');
  expect(tourToken(after, 1).ownValue).toBe(tourToken(before, 1).ownValue - BigInt(quoted));
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.getByLabel('Password', { exact: true }).fill(LOCAL_PASSWORD);
  await page.getByRole('button', { name: 'Unlock', exact: true }).click();
  await waitForWalletBoot(page);
  expect((await settledTourState(page, hubId, 'recovered-after-reload')).tokens).toEqual(after.tokens);
  await page.getByTestId('wallet-tutorial').click();
}
