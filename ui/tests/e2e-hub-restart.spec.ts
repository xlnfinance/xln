import { expect, test } from '@playwright/test';
import { formatUnits } from 'ethers';
import type { E2EHealthResponse } from '../../tests/utils/e2e-baseline';
import { LOCAL_TEST_STACK_BASES } from '../../core/scripts/e2e/harness/local-test-port-lease';
import { enterStack, readWalletCheckpoint } from './stack';
import { readCommittedPayment } from './payment-evidence';

// Run the private stand with NODE_ENV=production: dev intentionally halts on
// transport loss, while production retires the peer session and reconnects.
test('payments survive recipient hub process replacement without duplicate debits', { tag: '@resilience' }, async ({ page, baseURL }) => {
  test.setTimeout(120_000);
  const origin = process.env['XLN_UI_DISPUTE_PRIVATE_ORIGIN'];
  if (!origin || baseURL !== origin) throw new Error('HUB_RESTART_PRIVATE_STAND_REQUIRED');
  const url = new URL(origin);
  if (url.hostname !== '127.0.0.1' || !LOCAL_TEST_STACK_BASES.some(port => Number(url.port) === port + 2))
    throw new Error('HUB_RESTART_PRIVATE_ORIGIN_INVALID');
  const health = async (): Promise<E2EHealthResponse> => {
    const response = await page.request.get('/api/health?full=1');
    expect(response.ok()).toBe(true);
    return response.json();
  };
  const wallet = await enterStack(page);
  await page.getByTestId('home-faucet').click();
  await expect(page.getByTestId('test-money-status')).toContainText('100 USDC received', { timeout: 20_000 });
  let expectedOwned = 100_000_000n;
  const pay = async () => {
    const before = await readWalletCheckpoint(page);
    await page.getByTestId('home-pay').click();
    await page.getByTestId('pay-to').fill('H2');
    await page.getByTestId('pay-amount').fill('25');
    await expect(page.getByTestId('pay-submit')).toBeEnabled();
    const quote = page.getByTestId('pay-quote');
    const sender = await quote.getAttribute('data-sender-amount');
    const recipient = await quote.getAttribute('data-recipient-amount');
    const fee = await quote.getAttribute('data-fee-amount');
    if (!sender || !recipient || !fee) throw new Error('Exact payment quote unavailable');
    expect(BigInt(recipient)).toBe(25_000_000n);
    expect(BigInt(sender)).toBe(25_000_000n + BigInt(fee));
    await page.getByTestId('pay-submit').click();
    await page.getByTestId('receipt-open').click();
    await expect(page.getByTestId('receipt-kicker')).toHaveText('Paid', { timeout: 15_000 });
    const payment = await readCommittedPayment(page, wallet.entityId, before.latestHeight + 1);
    expect(payment.amount).toBe(recipient);
    expect(BigInt(payment.senderAmount)).toBe(25_000_000n + BigInt(payment.fee));
    // Admission may improve the displayed maximum debit; the signed receipt
    // owns the exact debit, including intermediary fees, before and after restart.
    expect(BigInt(payment.senderAmount)).toBeLessThanOrEqual(BigInt(sender));
    expectedOwned -= BigInt(payment.senderAmount);
    await page.getByTestId('receipt-done').click();
    await expect(page.getByTestId('home-total')).toHaveText(formatUnits(expectedOwned, 6).replace(/\.0$/, ''));
    return payment;
  };
  const first = await pay();
  const paid = await readWalletCheckpoint(page);
  const before = await health();
  const child = before.process?.children?.find(row => row.role === 'hub' && row.name === 'H2');
  const hub = before.hubs?.find(row => row.name === 'H2');
  if (!child?.online || !child.pid || !hub?.entityId) throw new Error('HUB_RESTART_H2_MISSING');
  const pid = child.pid;
  process.kill(pid, 'SIGKILL');
  await expect.poll(async () => {
    const restored = await health();
    const next = restored.process?.children?.find(row => row.role === 'hub' && row.name === 'H2');
    return Boolean(next?.online && next.pid !== pid && Number(next.restartCount) > Number(child.restartCount ?? 0)
      && restored.hubs?.some(row => row.name === 'H2' && row.entityId === hub.entityId && row.online) && restored.systemOk);
  }, { timeout: 60_000, intervals: [250, 500, 1000] }).toBe(true);
  const recovered = await readWalletCheckpoint(page);
  expect(recovered.runtimeId).toBe(paid.runtimeId);
  expect(recovered.entityId).toBe(paid.entityId);
  expect(recovered.accounts).toEqual(paid.accounts);
  const second = await pay();
  expect(second.hashlock).not.toBe(first.hashlock);
  const final = await readWalletCheckpoint(page);
  expect(final.accounts.every(account => !account.pending && account.mempool === 0)).toBe(true);
  await test.info().attach('hub-restart-payments', {
    body: JSON.stringify({ pid, hub: hub.entityId, first, second, paid, recovered, final }), contentType: 'application/json',
  });
});
