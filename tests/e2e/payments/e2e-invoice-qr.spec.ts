import { expect, test } from '../../global-setup.mts';
import { safeStringify } from '../../../core/protocol/serialization';
import { createWalletIdentity } from '../../../ui/tests/wallet-ui';
import { readCommittedPayment } from '../../../ui/tests/payment-evidence';
import { APP_BASE_URL, API_BASE_URL, ensureE2EBaseline, waitForNamedHubs } from '../../utils/e2e-baseline';
import { connectRuntimeToHub, waitForReceiveReadyGossipProfiles } from '../../utils/e2e-connect';
import { gotoApp, selectDemoMnemonic } from '../../utils/e2e-demo-users';
import { getPersistedReceiptCursor, waitForPersistedFrameEventMatch } from '../../utils/e2e-runtime-receipts';
import { chooseVisibleRoute } from '../../utils/runtime/e2e-pay-ui';
import { readFinancialState } from '../../utils/runtime/e2e-persistence-proof';

const WAIT = { timeout: 15_000, intervals: [100, 250, 500] };

test('creates QR in Receive and scans it into Pay', { tag: '@functional' }, async ({ page, browser }, testInfo) => {
  test.setTimeout(55_000);
  await ensureE2EBaseline(page, { requireHubMesh: true, requireMarketMaker: false, minHubCount: 3 });
  const { h1: hubId } = await waitForNamedHubs(page, ['H1']);
  if (!hubId) throw new Error('QR_PAYMENT_H1_UNAVAILABLE');
  const bobContext = await browser.newContext({ ignoreHTTPSErrors: true });
  const bobPage = await bobContext.newPage();
  try {
    await Promise.all([gotoApp(page, { appBaseUrl: APP_BASE_URL }), gotoApp(bobPage, { appBaseUrl: APP_BASE_URL })]);
    const [alice, bob] = await Promise.all([
      createWalletIdentity(page, 'alice', selectDemoMnemonic('alice')),
      createWalletIdentity(bobPage, 'bob', selectDemoMnemonic('bob')),
    ]);
    await Promise.all([connectRuntimeToHub(page, alice, hubId), connectRuntimeToHub(bobPage, bob, hubId)]);
    const initial = await readFinancialState(page, alice.entityId, hubId);
    const response = await page.request.post(`${API_BASE_URL}/api/faucet/offchain`, {
      data: {
        userEntityId: alice.entityId,
        userRuntimeId: alice.runtimeId,
        hubEntityId: hubId,
        tokenId: 1,
        amount: '100',
      },
    });
    expect(response.ok(), await response.text()).toBe(true);
    await expect
      .poll(async () => BigInt((await readFinancialState(page, alice.entityId, hubId)).out), WAIT)
      .toBe(BigInt(initial.out) + 100_000_000n);
    const [beforeAlice, beforeBob] = await Promise.all([
      readFinancialState(page, alice.entityId, hubId),
      readFinancialState(bobPage, bob.entityId, hubId),
    ]);

    await bobPage.getByTestId('nav-home').locator('visible=true').first().click();
    await bobPage.getByTestId('home-receive').click();
    await bobPage.getByTestId('receive-amount').fill('7');
    const qr = bobPage.getByRole('img', { name: 'Invoice QR', exact: true });
    await expect(qr).toBeVisible();
    const previousQr = await qr.getAttribute('src');
    await bobPage.getByTestId('receive-note').fill('QR settle');
    await expect(qr).not.toHaveAttribute('src', previousQr ?? '');
    // Capture the actual displayed code; the payer's real image decoder reads its pixels.
    const qrPath = testInfo.outputPath('invoice-qr.png');
    await qr.screenshot({ path: qrPath });
    await testInfo.attach('invoice-qr', { path: qrPath, contentType: 'image/png' });
    await page.getByTestId('nav-home').locator('visible=true').first().click();
    await page.getByTestId('home-pay').click();
    await page.getByTestId('pay-scan').click();
    await page.getByTestId('scan-upload').locator('input[type=file]').setInputFiles(qrPath);
    await expect(page.getByTestId('scan-upload')).toHaveCount(0);
    await expect(page.getByTestId('pay-to')).toHaveValue(bob.entityId);
    await expect(page.getByTestId('pay-amount')).toHaveValue('7');
    await expect(page.getByTestId('pay-note')).toHaveValue('QR settle');
    await waitForReceiveReadyGossipProfiles(page, [alice.entityId, hubId, bob.entityId], hubId);
    await chooseVisibleRoute(page, [hubId, bob.entityId]);
    const quote = page.getByTestId('pay-quote');
    const ceiling = BigInt((await quote.getAttribute('data-sender-amount')) ?? '');
    expect(await quote.getAttribute('data-recipient-amount')).toBe('7000000');
    const [senderCursor, recipientCursor] = await Promise.all([
      getPersistedReceiptCursor(page),
      getPersistedReceiptCursor(bobPage),
    ]);
    await expect(page.getByTestId('pay-submit')).toBeEnabled();
    await page.getByTestId('pay-submit').click();
    const [sent, received] = await Promise.all([
      waitForPersistedFrameEventMatch(page, {
        cursor: senderCursor,
        eventName: 'HtlcFinalized',
        entityId: alice.entityId,
        predicate: event => String(event.data?.amount) === '7000000',
        timeoutMs: 15_000,
      }),
      waitForPersistedFrameEventMatch(bobPage, {
        cursor: recipientCursor,
        eventName: 'HtlcReceived',
        entityId: bob.entityId,
        predicate: event => String(event.data?.amount) === '7000000',
        timeoutMs: 15_000,
      }),
    ]);
    const payment = await readCommittedPayment(page, alice.entityId, senderCursor.nextHeight);
    expect(payment.amount).toBe('7000000');
    expect(BigInt(payment.senderAmount)).toBe(7_000_000n + BigInt(payment.fee));
    expect(BigInt(payment.senderAmount)).toBeLessThanOrEqual(ceiling);
    expect(String(sent.data?.toEntity).toLowerCase()).toBe(hubId.toLowerCase());
    expect(String(received.data?.fromEntity).toLowerCase()).toBe(hubId.toLowerCase());
    await Promise.all([
      expect
        .poll(async () => {
          const state = await readFinancialState(page, alice.entityId, hubId);
          return { out: BigInt(state.out), pending: state.pending, mempool: state.mempool };
        }, WAIT)
        .toEqual({ out: BigInt(beforeAlice.out) - BigInt(payment.senderAmount), pending: false, mempool: 0 }),
      expect
        .poll(async () => {
          const state = await readFinancialState(bobPage, bob.entityId, hubId);
          return { out: BigInt(state.out), pending: state.pending, mempool: state.mempool };
        }, WAIT)
        .toEqual({ out: BigInt(beforeBob.out) + 7_000_000n, pending: false, mempool: 0 }),
    ]);
    await testInfo.attach('qr-payment', {
      contentType: 'application/json',
      body: safeStringify({ payment, ceiling, sent, received }),
    });
  } finally {
    await bobContext.close();
  }
});
