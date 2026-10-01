import { expect, test, type Page } from '@playwright/test';
import { formatUnits } from 'ethers';
import type { RuntimeAdapterViewFrame, XLNModule } from '../../core/api/public/runtime-module';
import type { RuntimeAdapter, RuntimeAdapterActivityPage } from '../../core/api/runtime-adapter/types';
import { enterStack } from './stack';

type DebugWindow = Window & {
  __xln?: {
    adapter: () => RuntimeAdapter | null;
    xln: () => Promise<XLNModule>;
    store: { getState: () => { activeEntityId: string | null } };
  };
};

const readCredit = (page: Page, hubId: string) =>
  page.evaluate(async counterpartyId => {
    const debug = (window as DebugWindow).__xln;
    if (!debug) throw new Error('Wallet diagnostics unavailable');
    const adapter = debug.adapter();
    const entityId = debug.store.getState().activeEntityId;
    if (!adapter || !entityId) throw new Error('Wallet Account owner unavailable');
    const account = await adapter.read<NonNullable<RuntimeAdapterViewFrame['activeEntity']>['accounts']['items'][number]>(`entity/${entityId}/account/${counterpartyId}`);
    const xln = await debug.xln();
    const capacity = xln.readAccountCapacity({
      account: account.state,
      ownerEntityId: entityId,
      counterpartyEntityId: counterpartyId,
      tokenId: 1,
    });
    return {
      credit: capacity.peerCreditLimit.toString(),
      capacity: capacity.inCapacity.toString(),
      root: account.currentFrame.accountStateRoot,
      height: account.currentHeight,
    };
  }, hubId);

/** One committed frame supplies ownership, reserve, pending work and the Account's exact delta. */
const readFundingState = (page: Page, hubId: string) =>
  page.evaluate(async counterpartyId => {
    const debug = (window as DebugWindow).__xln;
    if (!debug) throw new Error('Wallet diagnostics unavailable');
    const adapter = debug.adapter();
    const entityId = debug.store.getState().activeEntityId;
    if (!adapter || !entityId) throw new Error('Wallet owner unavailable');
    const frame = await adapter.read<RuntimeAdapterViewFrame>('view-frame', { entityId, accountId: counterpartyId });
    const active = frame.activeEntity;
    if (!active || frame.activeEntityId !== entityId) throw new Error('Funding snapshot owner unavailable');
    const account = active.accounts.items.find(
      item => item.state.leftEntity === counterpartyId || item.state.rightEntity === counterpartyId,
    );
    if (!account) throw new Error('Funding Account unavailable');
    const delta = account.state.deltas.get(1);
    if (!delta) throw new Error('Funding USDC delta unavailable');
    const xln = await debug.xln();
    const derived = xln.deriveDelta(delta, xln.isLeftEntity(entityId, counterpartyId));
    const ownValue = derived.outCollateral + derived.outPeerCredit - derived.inOwnCredit;
    const reserve = active.core.reserves.get(1) ?? 0n;
    const batch = active.core.jBatchState;
    return {
      height: frame.height,
      reserve: reserve.toString(),
      collateral: delta.collateral.toString(),
      offdelta: delta.offdelta.toString(),
      ownValue: ownValue.toString(),
      combinedOwned: (reserve + ownValue).toString(),
      locks: account.state.locks.size,
      paybookOpen: active.core.paybookOpen,
      pending: Boolean(account.pendingFrame),
      mempool: account.mempoolCount,
      batch: {
        draftOperations: batch
          ? Object.values(batch.batch)
              .filter(Array.isArray)
              .reduce((sum, rows) => sum + rows.length, 0)
          : 0,
        sent: Boolean(batch?.sentBatch),
      },
    };
  }, hubId);

/** Inspect persisted payment/HTLC activity, so a hidden or dismissed receipt cannot conceal an automatic send. */
const readPaymentActivity = (page: Page) =>
  page.evaluate(async () => {
    const debug = (window as DebugWindow).__xln;
    if (!debug) throw new Error('Wallet diagnostics unavailable');
    const adapter = debug.adapter();
    const entityId = debug.store.getState().activeEntityId;
    if (!adapter || !entityId) throw new Error('Payment Activity owner unavailable');
    const activity = await adapter.read<RuntimeAdapterActivityPage>('activity', {
      entityId,
      types: ['payment', 'htlc'],
      limit: 100,
      scanLimit: 500,
    });
    if (activity.nextBeforeHeight !== null) throw new Error('Fresh payment fixture exceeds one Activity page');
    return { height: activity.latestHeight, events: activity.events };
  });

test(
  'receive spectrum is explicit; payment top-up returns to review without sending',
  { tag: '@functional' },
  async ({ page }) => {
    test.setTimeout(60_000);
    const errors: string[] = [];
    const authErrors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => {
      if (message.type() !== 'error' && message.type() !== 'warning') return;
      console.log(`BROWSER_${message.type()}: ${message.text().slice(0, 500)}`);
      if (/MAC.*(?:INVALID|FAIL|MISMATCH)|(?:INVALID|FAIL|MISMATCH).*MAC|WS_MESSAGE_AUTH/i.test(message.text()))
        authErrors.push(message.text());
    });
    await enterStack(page);
    await page.getByTestId('account-row').first().click();
    const hubId = new URL(page.url()).pathname.split('/accounts/')[1];
    if (!hubId || !/^0x[0-9a-f]{64}$/.test(hubId)) throw new Error('Expected the fresh wallet hub Account');
    await page.getByTestId('back').click();
    await page.getByTestId('home-receive').click();
    const initial = await readCredit(page, hubId);
    await page.getByTestId('receive-amount').fill(formatUnits(BigInt(initial.capacity) + 25_000_000n, 6));
    const spectrum = page.getByTestId('receive-spectrum');
    await expect(spectrum).toBeVisible();
    await expect(page.getByTestId('receive-spectrum-slider')).toHaveValue('0');
    await expect(spectrum.getByRole('button', { name: '100% collateral', exact: true })).toHaveClass(/active/);
    await expect(spectrum.getByRole('button', { name: 'Accept it as credit instead', exact: true })).toBeEnabled();
    expect(await readCredit(page, hubId)).toEqual(initial);
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
    await page.screenshot({ path: '/tmp/xln-receive-spectrum-mobile.png', fullPage: true });
    await spectrum.getByRole('button', { name: '0% collateral', exact: true }).click();
    await expect(page.getByTestId('receive-spectrum-slider')).toHaveValue('100');
    await expect(spectrum.getByRole('checkbox')).toBeChecked();
    await expect(page.getByTestId('receive-spectrum-confirm')).toHaveText('Extend credit limit');
    await expect(page.getByTestId('receive-spectrum-confirm')).toBeEnabled();
    await page.getByTestId('receive-spectrum-confirm').click();
    await expect(spectrum).toHaveCount(0, { timeout: 15_000 });
    // A second explicit request starts from a nonzero committed grant, so this
    // distinguishes total-limit buffering from buffering only the new 25 USDC.
    const before = await readCredit(page, hubId);
    expect(BigInt(before.credit)).toBeGreaterThan(0n);
    const requiredLimit = BigInt(before.credit) + 25_000_000n;
    const totalBuffer = (requiredLimit + 9n) / 10n;
    const amount = formatUnits(BigInt(before.capacity) + 25_000_000n, 6);
    await page.getByTestId('receive-amount').fill(amount);
    await expect(page.getByTestId('receive-spectrum-slider')).toHaveValue('0');
    await expect(spectrum.getByRole('button', { name: '100% collateral', exact: true })).toHaveClass(/active/);
    await expect(spectrum.getByRole('button', { name: 'Accept it as credit instead', exact: true })).toBeEnabled();
    expect(await readCredit(page, hubId)).toEqual(before);
    await spectrum.getByRole('button', { name: '0% collateral', exact: true }).click();
    const buffer = spectrum.getByRole('checkbox', { name: /Add 10% buffer to the entire credit limit/ });
    await expect(buffer).toBeChecked();
    const bufferedAmounts = await spectrum.locator('.spectrum-amounts').innerText();
    await buffer.uncheck();
    await expect(buffer).not.toBeChecked();
    await expect(spectrum.locator('.spectrum-amounts')).toContainText('25.00 USDC');
    await buffer.check();
    await expect(spectrum.locator('.spectrum-amounts')).toHaveText(bufferedAmounts, { useInnerText: true });
    await page.getByPlaceholder('What is this for?').fill('No credit change until confirmation');
    expect(await readCredit(page, hubId)).toEqual(before);
    await page.screenshot({ path: '/tmp/xln-receive-total-limit-buffer.png', fullPage: true });
    await page.getByTestId('receive-spectrum-confirm').click();
    await expect(spectrum).toHaveCount(0, { timeout: 15_000 });
    const after = await readCredit(page, hubId);
    expect(after.credit).toBe((requiredLimit + totalBuffer).toString());
    expect(after.height).toBeGreaterThan(before.height);
    await page.getByPlaceholder('What is this for?').fill('Refresh leaves the confirmed limit unchanged');
    expect(await readCredit(page, hubId)).toEqual(after);
    await page.setViewportSize({ width: 1280, height: 860 });
    await page.getByTestId('nav-manage').locator('visible=true').first().click();
    await page.getByTestId('manage-assets').click();
    await page.getByTestId('faucet-amount').fill('100');
    const reserveResponse = page.waitForResponse(
      response => new URL(response.url()).pathname === '/api/faucet/reserve' && response.request().method() === 'POST',
    );
    await page.getByTestId('faucet-reserve').click();
    const reserve = await reserveResponse;
    expect(reserve.ok(), await reserve.text()).toBe(true);
    await expect(page.getByTestId('faucet-reserve')).toBeEnabled({ timeout: 15_000 });
    await expect.poll(async () => (await readFundingState(page, hubId)).reserve, { timeout: 15_000 }).toBe('100000000');
    await page.getByTestId('faucet-amount').fill('0.1');
    const gasResponse = page.waitForResponse(
      response => new URL(response.url()).pathname === '/api/faucet/gas' && response.request().method() === 'POST',
    );
    await page.getByTestId('faucet-gas').click();
    const gas = await gasResponse;
    expect(gas.ok(), await gas.text()).toBe(true);
    await expect(page.getByTestId('faucet-gas')).toBeEnabled({ timeout: 15_000 });
    const beforeFunding = await readFundingState(page, hubId);
    const paymentsBefore = await readPaymentActivity(page);
    expect(beforeFunding.ownValue).toBe('0');
    expect(beforeFunding.locks).toBe(0);
    expect(beforeFunding.paybookOpen).toBe(0);
    expect(beforeFunding.batch).toEqual({ draftOperations: 0, sent: false });
    expect(paymentsBefore.events).toEqual([]);
    await page.getByTestId('nav-home').locator('visible=true').first().click();
    await page.getByTestId('home-pay').click();
    await page.getByTestId('pay-to').fill(hubId);
    const maxText = await page.getByRole('button', { name: /Up to .* instantly/ }).textContent();
    const payAmount = Number(maxText!.match(/Up to ([\d,.]+) instantly/)![1]!.replace(/,/g, '')) + 25;
    expect(payAmount).toBe(25);
    await page.getByTestId('pay-amount').fill(String(payAmount));
    await page.getByRole('button', { name: 'Add a note' }).click();
    await page.getByPlaceholder('What is this for?').fill('saved payment after top-up');
    await expect(page.getByTestId('pay-submit')).toBeDisabled();
    await expect(page.getByTestId('receive-spectrum-slider')).toHaveCount(0);
    await page.getByTestId('pay-topup-move').click();
    await expect(page.getByTestId('move-to-account')).toHaveClass(/active/);
    await expect(page.getByTestId('move-from-reserve')).toHaveClass(/active/);
    await expect(page.getByTestId('move-target-hub')).toHaveValue(hubId);
    // The recipient is this Account's hub: there is no intermediary to earn
    // a routing fee. Fund exactly the principal, then verify its live quote.
    await expect(page.getByTestId('move-amount')).toHaveValue('25');
    await expect(page.getByTestId('move-now')).toBeEnabled({ timeout: 10_000 });
    await page.getByTestId('move-draft').click();
    await expect(page.getByTestId('pending-batch')).toHaveAttribute('data-mode', 'draft');
    await page.getByTestId('move-return-payment').click();
    await page.getByTestId('pay-topup-move').click();
    await expect(page.getByTestId('move-draft')).toBeDisabled();
    await expect(page.getByTestId('move-now')).toBeDisabled();
    await expect(page.getByTestId('pending-batch')).toContainText('On-chain batch · 1');
    await page.getByTestId('batch-broadcast').click();
    await expect(page.getByTestId('payment-receipt')).toHaveCount(0);
    await expect(page.getByTestId('pay-to')).toHaveValue(hubId, { timeout: 20_000 });
    await expect(page.getByTestId('pay-amount')).toHaveValue(String(payAmount));
    await expect(page.getByPlaceholder('What is this for?')).toHaveValue('saved payment after top-up');
    await expect(page.getByTestId('pay-submit')).toBeEnabled({ timeout: 10_000 });
    await expect(page.getByTestId('pay-quote')).toHaveAttribute('data-sender-amount', '25000000');
    await expect(page.getByTestId('pay-quote')).toHaveAttribute('data-recipient-amount', '25000000');
    await expect(page.getByTestId('pay-quote')).toHaveAttribute('data-fee-amount', '0');
    await expect(page.getByTestId('payment-receipt')).toHaveCount(0);
    await expect
      .poll(
        async () => {
          const state = await readFundingState(page, hubId);
          return {
            reserve: state.reserve,
            collateral: state.collateral,
            ownValue: state.ownValue,
            pending: state.pending,
            mempool: state.mempool,
            locks: state.locks,
            paybookOpen: state.paybookOpen,
            batch: state.batch,
          };
        },
        { timeout: 15_000 },
      )
      .toEqual({
        reserve: (BigInt(beforeFunding.reserve) - 25_000_000n).toString(),
        collateral: (BigInt(beforeFunding.collateral) + 25_000_000n).toString(),
        ownValue: (BigInt(beforeFunding.ownValue) + 25_000_000n).toString(),
        pending: false,
        mempool: 0,
        locks: 0,
        paybookOpen: 0,
        batch: { draftOperations: 0, sent: false },
      });
    const funded = await readFundingState(page, hubId);
    expect(funded.combinedOwned).toBe(beforeFunding.combinedOwned);
    expect(funded.offdelta).toBe(beforeFunding.offdelta);
    expect(funded.height).toBeGreaterThan(beforeFunding.height);
    const paymentsAfter = await readPaymentActivity(page);
    expect(paymentsAfter.height).toBeGreaterThanOrEqual(funded.height);
    expect(paymentsAfter.events).toEqual(paymentsBefore.events);
    console.log(
      `PAYMENT_PREFUND_COMMITTED reserve=${funded.reserve} collateral=${funded.collateral} ownValue=${funded.ownValue} paymentEvents=${paymentsAfter.events.length}`,
    );
    expect(errors).toEqual([]);
    expect(authErrors).toEqual([]);
  },
);
