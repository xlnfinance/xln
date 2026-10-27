import { safeStringify } from '../../../core/protocol/serialization';
import { test, expect, type Page } from '../../global-setup.mts';
import { createWalletIdentity, LOCAL_PASSWORD, waitForWalletBoot } from '../../../ui/tests/wallet-ui';
import { gotoApp, selectDemoMnemonic } from '../../utils/e2e-demo-users';
import { connectRuntimeToHubWithCredit } from '../../utils/e2e-connect';
import { APP_BASE_URL, API_BASE_URL, ensureE2EBaseline } from '../../utils/e2e-baseline';
import { getPersistedRuntimeDbMeta } from '../../utils/e2e-runtime-receipts';
import { readFinancialState, readWalProof, setCheckpointPeriod } from '../../utils/runtime/e2e-persistence-proof';

const WAIT = { timeout: 15_000, intervals: [100, 250, 500] };
const FUNDED = 200_000_000n;
type Identity = Awaited<ReturnType<typeof createWalletIdentity>>;

async function fundWallet(page: Page, identity: Identity, hubId: string): Promise<void> {
  expect(await setCheckpointPeriod(page, 5)).toBe(5);
  await connectRuntimeToHubWithCredit(page, identity, hubId, '10000', [1, 2]);
  const before = BigInt((await readFinancialState(page, identity.entityId, hubId)).out);
  for (let index = 1; index <= 2; index++) {
    const response = await page.request.post(`${API_BASE_URL}/api/faucet/offchain`, {
      data: {
        userEntityId: identity.entityId,
        userRuntimeId: identity.runtimeId,
        hubEntityId: hubId,
        tokenId: 1,
        amount: '100',
      },
    });
    expect(response.ok(), await response.text()).toBe(true);
    await expect
      .poll(async () => BigInt((await readFinancialState(page, identity.entityId, hubId)).out), WAIT)
      .toBe(before + BigInt(index) * 100_000_000n);
  }
  expect(BigInt((await readFinancialState(page, identity.entityId, hubId)).out) - before).toBe(FUNDED);
}

async function cancelRealOffer(page: Page, entityId: string, hubId: string): Promise<void> {
  await page.getByTestId('nav-home').locator('visible=true').first().click();
  await page.locator(`[data-testid="account-row"][data-counterparty-id="${hubId}"]`).click();
  await page.getByRole('button', { name: 'Swap', exact: true }).click();
  for (const [field, symbol] of [
    ['swap-give', 'USDC'],
    ['swap-want', 'WETH'],
  ] as const) {
    await page.getByTestId(field).locator('..').locator('button.pill').click();
    await page.getByRole('option', { name: new RegExp(`^${symbol}\\b`) }).click();
  }
  await page.getByTestId('swap-give').fill('100');
  await page.getByTestId('swap-want').fill('0.05');
  await expect(page.getByTestId('swap-submit')).toBeEnabled();
  await page.getByTestId('swap-submit').click();
  await expect.poll(async () => (await readFinancialState(page, entityId, hubId)).offers, WAIT).toBe(1);
  await page.getByTestId('swap-offer-cancel').click();
  await expect.poll(async () => (await readFinancialState(page, entityId, hubId)).offers, WAIT).toBe(0);
  await expect(page.getByTestId('swap-offer-cancel')).toHaveCount(0);
}

async function idle(page: Page, identity: Identity, hubId: string): Promise<void> {
  await expect
    .poll(async () => {
      const state = await readFinancialState(page, identity.entityId, hubId);
      return { pending: state.pending, mempool: state.mempool };
    }, WAIT)
    .toEqual({ pending: false, mempool: 0 });
}

test(
  'reload restores complex runtime from a retained checkpoint plus WAL tail',
  { tag: '@resilience' },
  async ({ page, browser }, testInfo) => {
    test.setTimeout(55_000);
    const health = await ensureE2EBaseline(page, {
      apiBaseUrl: API_BASE_URL,
      requireHubMesh: true,
      requireMarketMaker: false,
      minHubCount: 3,
    });
    const hubId = health.hubMesh?.hubIds?.[0];
    if (!hubId) throw new Error('PERSISTENCE_HUB_UNAVAILABLE');
    const bobContext = await browser.newContext({ ignoreHTTPSErrors: true });
    const bobPage = await bobContext.newPage();
    try {
      await Promise.all([gotoApp(page, { appBaseUrl: APP_BASE_URL }), gotoApp(bobPage, { appBaseUrl: APP_BASE_URL })]);
      const [alice, bob] = await Promise.all([
        createWalletIdentity(page, 'alice', selectDemoMnemonic('alice')),
        createWalletIdentity(bobPage, 'bob', selectDemoMnemonic('bob')),
      ]);
      await Promise.all([fundWallet(page, alice, hubId), fundWallet(bobPage, bob, hubId)]);
      await Promise.all([idle(page, alice, hubId), idle(bobPage, bob, hubId)]);
      await expect.poll(async () => (await getPersistedRuntimeDbMeta(page)).checkpointHeight, WAIT).toBeGreaterThan(1);
      expect(await setCheckpointPeriod(page, 1_000)).toBe(1_000);
      await cancelRealOffer(page, alice.entityId, hubId);
      await idle(page, alice, hubId);
      const before = await readFinancialState(page, alice.entityId, hubId);
      const bobBefore = await readFinancialState(bobPage, bob.entityId, hubId);
      const walBefore = await readWalProof(page);
      expect(before.out).toBe(FUNDED.toString());
      expect(before.offers).toBe(0);
      expect(walBefore.checkpoint).toBeGreaterThan(1);
      expect(walBefore.latest).toBeGreaterThan(walBefore.checkpoint);
      expect(walBefore.frames.length).toBe(walBefore.latest - walBefore.checkpoint);

      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.getByRole('button', { name: 'Continue', exact: true }).click();
      await page.getByLabel('Password', { exact: true }).fill(LOCAL_PASSWORD);
      await page.getByRole('button', { name: 'Unlock', exact: true }).click();
      await waitForWalletBoot(page);
      await expect(page.getByTestId('nav-home').locator('visible=true').first()).toBeVisible();
      await idle(page, alice, hubId);
      const after = await readFinancialState(page, alice.entityId, hubId);
      const walAfter = await readWalProof(page, walBefore.checkpoint, walBefore.latest);
      expect(after).toEqual(before);
      expect(after.runtimeId).toBe(alice.runtimeId);
      expect(after.entityCount).toBeGreaterThan(0);
      expect(after.historyPresent).toBe(false);
      expect(walAfter.frames).toEqual(walBefore.frames);
      expect(walAfter.checkpoints).toContain(walBefore.checkpoint);
      expect(walAfter.latest).toBeGreaterThanOrEqual(walBefore.latest);
      const replay = walAfter.replay;
      if (!replay) throw new Error('PERSISTENCE_REPLAY_EVIDENCE_MISSING');
      // The browser materializes its current graph every frame, so reload
      // restores from the newest durable checkpoint, normally the WAL tip, and
      // replays whatever tail remains (often none). The retained checkpoint and
      // its WAL tail stay byte-exact above; checkpoint-plus-tail replay is
      // proven at hub cadence in browser-wallet-restore-cadence.test.ts.
      expect(replay.checkpointHeight).toBeGreaterThanOrEqual(walBefore.checkpoint);
      expect(replay.label).toBe(`checkpoint:${replay.checkpointHeight}`);
      expect(replay.replayedFrames).toBeGreaterThanOrEqual(0);
      expect(replay.checkpointHeight + replay.replayedFrames).toBe(replay.latestHeight);
      expect(replay.latestHeight).toBeGreaterThanOrEqual(walBefore.latest);
      expect(await readFinancialState(bobPage, bob.entityId, hubId)).toEqual(bobBefore);
      await testInfo.attach('checkpoint-wal-proof', {
        contentType: 'application/json',
        body: safeStringify({ before, after, walBefore, walAfter, bobBefore }),
      });
    } finally {
      await bobContext.close();
    }
  },
);
