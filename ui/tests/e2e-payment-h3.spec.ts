import { expect, test } from '@playwright/test';
import { formatUnits } from 'ethers';
import type { RuntimeReplica } from '../../core/api/public/runtime-module';
import { enterStack, readWalletCheckpoint } from './stack';
import { readCommittedPayment } from './payment-evidence';

test('a funded wallet pays H3 twice without leaving held funds', { tag: '@functional' }, async ({ page }) => {
  test.setTimeout(150_000);
  page.setDefaultTimeout(10_000);
  page.on('console', message => {
    if (message.type() === 'error' || message.type() === 'warning') console.log(message.text());
  });
  const wallet = await enterStack(page);
  await page.getByTestId('home-faucet').click();
  await expect(page.getByTestId('test-money-status')).toContainText('100 USDC received', { timeout: 20_000 });
  console.log(
    'BEFORE',
    await page.evaluate(() => {
      const env = (window as Window & { __xln?: { env(): RuntimeReplica | null } }).__xln?.env();
      return [...(env?.state.eReplicas.values() ?? [])].map(r => ({
        entity: r.entityId,
        finalized: r.state.lastFinalizedJHeight,
        scanned: r.jHistory?.scannedThroughHeight,
      }));
    }),
  );
  let expectedOwned = 100_000_000n;
  for (let i = 0; i < 2; i++) {
    if (i === 1) {
      console.log('IDLE: waiting 90 seconds before the repeat payment');
      await page.waitForTimeout(90_000);
    }
    await page.getByTestId('home-pay').click();
    await page.getByTestId('pay-to').fill('H');
    console.log('recipient suggestions', await page.locator('.picker-option').allTextContents());
    await page.locator('[data-testid^=pay-suggestion-H3]').first().click();
    await page.getByTestId('pay-amount').fill('25');
    await expect(page.getByTestId('pay-submit')).toBeEnabled();
    const quote = page.getByTestId('pay-quote');
    const sender = await quote.getAttribute('data-sender-amount');
    const recipient = await quote.getAttribute('data-recipient-amount');
    const fee = await quote.getAttribute('data-fee-amount');
    if (!sender || !recipient || !fee) throw new Error('Exact payment quote unavailable');
    expect(BigInt(recipient)).toBe(25_000_000n);
    expect(BigInt(sender)).toBe(25_000_000n + BigInt(fee));
    const before = await readWalletCheckpoint(page);
    await page.getByTestId('pay-submit').click();
    await page.getByTestId('receipt-open').click();
    await expect(page.getByTestId('receipt-kicker')).toHaveText('Paid', { timeout: 15_000 });
    const payment = await readCommittedPayment(page, wallet.entityId, before.latestHeight + 1);
    expect(payment.amount).toBe(recipient);
    expect(BigInt(payment.senderAmount)).toBe(25_000_000n + BigInt(payment.fee));
    // The displayed quote authorizes a maximum; admission commits the exact debit.
    expect(BigInt(payment.senderAmount)).toBeLessThanOrEqual(BigInt(sender));
    expectedOwned -= BigInt(payment.senderAmount);
    await page.getByTestId('receipt-done').click();
    await page.getByTestId('nav-home').locator('visible=true').first().click();
    await expect(page.getByTestId('home-balance-asset')).toHaveValue('1');
    await expect(page.getByTestId('home-total')).toHaveText(formatUnits(expectedOwned, 6).replace(/\.0$/, ''));
  }
  await expect
    .poll(() =>
      page.evaluate(() => {
        const env = (window as Window & { __xln?: { env(): RuntimeReplica | null } }).__xln?.env();
        if (!env) throw new Error('Test wallet runtime is unavailable');
        return [...env.state.eReplicas.values()].reduce(
          (total, replica) =>
            total +
            [...replica.state.accounts.values()].reduce((count, account) => count + account.state.locks.size, 0),
          0,
        );
      }),
    )
    .toBe(0);
});
