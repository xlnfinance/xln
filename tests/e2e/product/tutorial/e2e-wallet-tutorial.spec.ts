import { gotoApp } from '../../../utils/e2e-demo-users';
import { test, expect } from '../../../global-setup.mts';
import { enterStack, readWalletCheckpoint, readTourState, settledTourState, tourToken } from '../../../utils/tour/committed';
import { startWatchtower, stopWatchtower, type WatchtowerChild } from '../../../utils/watchtower-daemon';
import { readWalletIdentity, waitForWalletBoot, LOCAL_PASSWORD } from '../../../../ui/tests/wallet-ui';
import {
  next,
  skip,
  prepareCredit,
  fundReserve,
  openSecondHub,
  cancelCrossOrder,
  proveRecoveredPayment,
} from '../../../utils/tour/exercises';

/** Every chapter is exercised or reports its exact unsupported prerequisite; skipped is never verified. */
test(
  'whole React wallet tutorial uses committed outcomes and explicit unsupported chapters',
  { tag: '@functional' },
  async ({ page: initial, browser }, info) => {
    test.setTimeout(600_000);
    const requirements = { requireMarketMaker: true };
    const health = await initial.request.get('/api/health');
    expect(health.ok()).toBe(true);
    expect((await health.json()).marketMaker).toMatchObject({ enabled: requirements.requireMarketMaker, ok: true });
    const skipped: Record<string, string> = {};
    let towerDaemon: WatchtowerChild | null = null;
    let page = initial;
    const wallet = await enterStack(page);
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.getByTestId('wallet-tutorial').click();
    const chapters = await page
      .getByTestId('tour-chapter')
      .locator('option')
      .evaluateAll(options => options.map(option => (option as HTMLOptionElement).value));
    expect(new Set(chapters).size).toBe(chapters.length);
    const visited: string[] = [];
    const visit = async (id: string) => {
      await next(page, id);
      visited.push(id);
    };

    await visit('faucet');
    await page.getByTestId('home-faucet').click();
    await visit('pay');
    await page.getByTestId('home-pay').click();
    await page.getByTestId('pay-to').fill('H');
    await page.locator('[data-testid^="pay-suggestion-H2"]').first().click();
    await page.getByTestId('pay-amount').fill('25');
    await page.getByTestId('pay-submit').click();
    await page.getByTestId('receipt-open').click();
    await expect(page.getByTestId('receipt-kicker')).toHaveText('Paid', { timeout: 20_000 });
    await visit('trade');
    await page.getByTestId('receipt-done').click();
    await page.getByTestId('nav-home').locator('visible=true').first().click();
    await page.getByTestId('account-row').first().click();
    const hubId = new URL(page.url()).pathname.split('/accounts/')[1];
    if (!hubId) throw new Error('TUTORIAL_HUB_MISSING');
    await page.getByTestId('nav-home').locator('visible=true').first().click();
    await page.getByTestId('home-swap').click();
    await expect(page.getByTestId('orderbook').locator('visible=true').first()).toHaveAttribute('data-status', 'live', { timeout: 30_000 });
    await page.getByTestId('swap-give').fill('25');
    await page.getByTestId('swap-submit').click();
    await visit('history');
    await page.getByTestId('back').click();
    await page.getByTestId('nav-activity').locator('visible=true').first().click();
    await page.getByTestId('activity-row').first().click();
    await page.getByTestId('tour-advance').click();
    await visit('jurisdiction');
    await page.getByTestId('jurisdiction-stack').locator('summary').click();
    await expect(page.getByTestId('jurisdiction-stack').locator('code')).toHaveCount(2);
    await page.getByTestId('tour-advance').click();
    await visit('cross');
    const beforeCross = await settledTourState(page, hubId, 'before-cross');
    const target = await cancelCrossOrder(page);
    await visit('receive');
    const afterCross = await settledTourState(page, hubId, 'after-cross-cancel');
    expect(tourToken(afterCross, 1).ownValue).toBe(tourToken(beforeCross, 1).ownValue);
    expect(tourToken(afterCross, 2).ownValue).toBeGreaterThan(0n);
    await expect
      .poll(
        async () => {
          const state = await readTourState(page, target.targetHubId, target.targetEntityId);
          return { balance: tourToken(state, 2).ownValue, locks: state.locks, pulls: state.pulls, pending: state.pending };
        },
        { timeout: 30_000 },
      )
      .toEqual({ balance: 0n, locks: 0, pulls: 0, pending: false });
    await page.getByTestId('receive-amount').fill('5');
    await page.getByTestId('receive-note').fill('Tutorial invoice');
    await page.getByTestId('receive-copy-link').click();
    const link = new URL(await page.evaluate(() => navigator.clipboard.readText()));
    const payerContext = await browser.newContext({ baseURL: new URL(page.url()).origin });
    try {
      const payer = await payerContext.newPage();
      await enterStack(payer);
      await payer.getByTestId('home-faucet').click();
      await expect(payer.getByTestId('test-money-status')).toContainText('100 USDC received', { timeout: 20_000 });
      await payer.goto(`${new URL(payer.url()).origin}${new URL(payer.url()).pathname}${link.hash}`);
      await expect(payer.getByTestId('pay-amount')).toHaveValue('5');
      await expect(payer.getByTestId('pay-note')).toHaveValue('Tutorial invoice');
      await payer.getByTestId('pay-submit').click();
      await visit('hubs');
    } finally {
      await payerContext.close();
    }
    const received = await settledTourState(page, hubId, 'invoice-paid');
    expect(tourToken(received, 1).ownValue).toBe(tourToken(afterCross, 1).ownValue + 5_000_000n);
    await openSecondHub(page);
    await visit('limits');
    const limitsBefore = await settledTourState(page, hubId, 'before-limit');
    await page.getByTestId('account-extend-credit').click();
    const credit = page.getByRole('dialog', { name: 'Extend credit', exact: true });
    await credit.locator('input').fill('10001');
    await credit.getByRole('button', { name: 'Extend credit', exact: true }).click();
    await visit('move');
    expect(tourToken(await readTourState(page, hubId), 1).peerCreditLimit).toBe(tourToken(limitsBefore, 1).peerCreditLimit + 1_000_000n);
    await fundReserve(page, hubId);
    const moveBefore = await settledTourState(page, hubId, 'reserve-funded');
    expect(tourToken(moveBefore, 1).reserve).toBe(20_000_000n);
    await page.getByTestId('move-from-reserve').click();
    await page.getByTestId('move-to-account').click();
    await page.getByTestId('move-target-hub').selectOption(hubId);
    await page.getByTestId('move-amount').fill('5');
    await page.getByTestId('move-now').click();
    await visit('withdraw');
    const moved = await settledTourState(page, hubId, 'moved');
    expect(tourToken(moved, 1).reserve).toBe(15_000_000n);
    expect(tourToken(moved, 1).collateral).toBe(tourToken(moveBefore, 1).collateral + 5_000_000n);
    await page.getByTestId('move-from-reserve').click();
    await page.getByTestId('move-to-external').click();
    await page.getByTestId('move-external-recipient').fill((await readWalletIdentity(page)).signerId);
    await page.getByTestId('move-amount').fill('5');
    await page.getByTestId('move-now').click();
    await visit('lending');
    expect(tourToken(await readTourState(page, hubId), 1).reserve).toBe(10_000_000n);
    await expect(page.getByTestId('lending-state')).toHaveAttribute('data-ready', 'yes', { timeout: 20_000 });
    if (await page.getByTestId('lending-bank-terms').count()) {
      await skip(page, /Bank unavailable:/, skipped);
    } else {
      await expect(page.getByTestId('lend-rate')).not.toHaveValue('');
      await page.getByTestId('lend-amount').fill('5');
      const consent = page.getByTestId('lending-risk-consent');
      if (await consent.count()) await consent.getByRole('button').click();
      await page.getByTestId('lend-submit').click();
    }
    await visit('borrow');
    await page.getByTestId('lend-side-borrow').click();
    await expect(page.getByTestId('lending-bank-approval')).toBeVisible();
    if (await page.getByTestId('lending-no-facility').count()) {
      await skip(page, /approved no borrowing facility/, skipped);
    } else {
      await page.getByTestId('lend-amount').fill('2');
      await prepareCredit(page);
      await page.getByTestId('lend-submit').click();
    }
    await visit('repay');
    if (skipped.borrow) await skip(page, /No funded loan/, skipped);
    else await page.getByTestId('lending-repay').click();
    await visit('savings-withdraw');
    if (skipped.lending) await skip(page, /No signed savings position/, skipped);
    else await page.getByTestId('lending-close').click();
    await visit('protection');
    // Recovery needs a real tower: start the standalone daemon on this shard's leased port.
    towerDaemon = await startWatchtower();
    const tower = towerDaemon.baseUrl;
    await page.getByTestId('watchtower-url').fill(tower);
    await page.getByTestId('watchtower-add').click();
    await expect(page.getByTestId('sovereignty-watchtower')).toHaveAttribute('data-covered', 'yes', { timeout: 30_000 });
    await visit('recovery');
    const coverage = await page.getByTestId('watchtower-coverage-backup').innerText();
    const backupHeight = coverage.match(/#([\d,]+)/)?.[1];
    if (!backupHeight) throw new Error('TUTORIAL_BACKUP_RECEIPT_HEIGHT_MISSING');
    const backed = await readWalletCheckpoint(page, Number(backupHeight.replaceAll(',', '')));
    // Stop the source runtime before restoring the same identity on a clean device.
    await page.close();
    const restoredContext = await browser.newContext({ baseURL: new URL(initial.url()).origin });
    try {
      page = await restoredContext.newPage();
      await gotoApp(page, { settleMs: 0 });
      await page.getByRole('button', { name: /Restore a wallet/ }).click();
      await page.locator('textarea').fill(wallet.phrase);
      await page.getByTestId('restore-from-tower').check();
      await page.getByTestId('restore-tower-url').fill(tower);
      await page.getByRole('button', { name: 'Restore wallet', exact: true }).click();
      await page.getByLabel('Password', { exact: true }).fill(LOCAL_PASSWORD);
      await page.getByLabel('Confirm password', { exact: true }).fill(LOCAL_PASSWORD);
      await page.getByRole('button', { name: 'Save and open', exact: true }).click();
      await waitForWalletBoot(page);
      expect((await readWalletCheckpoint(page, backed.frame.height)).frame).toEqual(backed.frame);
      await page.getByTestId('wallet-tutorial').click();
      await page.getByTestId('tour-chapter').selectOption('recovery');
      await next(page, 'company');
      await proveRecoveredPayment(page, hubId);
      await visit('company');
      await page.getByTestId('entity-formation').locator('summary').click();
      await page.getByTestId('formation-name').fill('Tutorial company');
      await page.getByTestId('formation-submit').click();
      await expect(page.getByTestId('formation-result')).toContainText('Entity created', { timeout: 30_000 });
      await page.getByTestId('nav-home').locator('visible=true').first().click();
      await page.getByTestId('entity-switcher-trigger').click();
      await page.getByTestId('entity-switcher-entity').filter({ hasText: 'Tutorial company' }).click();
      await visit('shares');
      await page.getByTestId('release-shares').click();
      await visit('governance');
      await expect(page.getByTestId('shares-control')).toHaveText('100,000,000,000');
      await expect(page.getByTestId('shares-dividend')).toHaveText('100,000,000,000');
      await skip(page, /separate disposable registered target/, skipped);
      await visit('balance');
      await page.getByTestId('entity-switcher-trigger').click();
      await page.locator(`[data-testid="entity-switcher-entity"][data-entity-id="${wallet.entityId}"]`).click();
      await page.getByTestId('tour-advance').click();
      await visit('cover');
      await page.getByTestId('account-cover').click();
      await page.getByTestId('collateral-amount').fill('5');
      await page.getByTestId('collateral-request').click();
      await visit('evidence');
      const download = page.waitForEvent('download');
      await page.getByTestId('evidence-export').click();
      await (await download).saveAs(info.outputPath('recovery.json'));
      await visit('dispute');
      await skip(page, /signed challenge windows total/, skipped);
      await visit('finish');
      await page.getByTestId('tour-next').click();
      await expect(page.getByTestId('tour')).toHaveCount(0);
      const final = await settledTourState(page, hubId, 'finished');
      expect(tourToken(final, 1).reserve).toBe(10_000_000n);
      expect(tourToken(final, 2).ownValue).toBeGreaterThan(0n);
      expect(final.tokens.get(1)!.collateral).toBeGreaterThan(tourToken(moved, 1).collateral);
      expect(final.claims).toEqual([]);
      expect(visited).toEqual(chapters);
      await info.attach('tutorial-chapters', {
        body: JSON.stringify(
          {
            visited,
            verified: visited.filter(id => !skipped[id] && !['history', 'jurisdiction', 'balance', 'finish'].includes(id)),
            skipped,
          },
          null,
          2,
        ),
        contentType: 'application/json',
      });
    } finally {
      await restoredContext.close();
      await stopWatchtower(towerDaemon);
    }
  },
);
