import { test, expect, type Page } from '../../global-setup.mts';
import { Wallet } from 'ethers';
import { API_BASE_URL, APP_BASE_URL, getHealth } from '../../utils/e2e-baseline';
import { gotoApp as gotoSharedApp } from '../../utils/e2e-demo-users';
import { getPersistedReceiptCursor } from '../../utils/e2e-runtime-receipts';
import { createWalletIdentity } from '../../../ui/tests/wallet-ui';
import { readAccount, expectDeliveryDrained } from '../../../ui/tests/swap-evidence';
import { safeStringify } from '../../../core/protocol/serialization';
import type { RuntimeReplica } from '../../../core/runtime/types';

function randomMnemonic(): string {
  const phrase = Wallet.createRandom().mnemonic?.phrase;
  if (!phrase) throw new Error('JOURNEY_MNEMONIC_UNAVAILABLE');
  return phrase;
}

async function gotoApp(page: Page): Promise<void> {
  await gotoSharedApp(page, { appBaseUrl: APP_BASE_URL, initTimeoutMs: 30_000, settleMs: 0 });
}

/** Observe current live machinery; no synthetic drain or mutation of committed state. */
async function readEntityIdleSnapshot(page: Page, entityId: string, signerId: string) {
  return page.evaluate(
    ({ entityId, signerId }) => {
      const debug = (window as Window & { __xln?: { env(): RuntimeReplica | null } }).__xln;
      const env = debug?.env();
      if (!env) throw new Error('JOURNEY_RUNTIME_UNAVAILABLE');
      const replicas = [...env.state.eReplicas.values()].filter(
        replica => replica.entityId === entityId && replica.signerId === signerId,
      );
      const [replica] = replicas;
      if (replicas.length !== 1 || !replica) throw new Error('JOURNEY_REPLICA_NOT_UNIQUE');
      const jurisdiction = replica.state.config.jurisdiction;
      if (!jurisdiction || !replica.jHistory) throw new Error('JOURNEY_JURISDICTION_UNAVAILABLE');
      const adapters = [...(env.infrastructure?.liveJAdapters?.values() ?? [])].filter(
        adapter =>
          adapter.chainId === jurisdiction.chainId &&
          adapter.addresses.depository.toLowerCase() === jurisdiction.depositoryAddress.toLowerCase(),
      );
      const [adapter] = adapters;
      if (adapters.length !== 1 || !adapter?.getWatcherScanProgress) throw new Error('JOURNEY_WATCHER_NOT_UNIQUE');
      const watcherScannedJHeight = adapter.getWatcherScanProgress().scannedThroughHeight;
      const finalizedJHeight = replica.state.lastFinalizedJHeight;
      const projectedJHeight = replica.jHistory.scannedThroughHeight;
      const pendingSemanticJEventCount = [...replica.jHistory.eventBlocks.keys()].filter(
        height => height > finalizedJHeight && height <= projectedJHeight,
      ).length;
      const pendingWorkCount =
        env.runtimeMempool.runtimeTxs.length +
        env.runtimeMempool.entityInputs.length +
        (env.runtimeMempool.jInputs?.length ?? 0) +
        (env.pendingOutputs?.length ?? 0) +
        (env.networkInbox?.length ?? 0) +
        (env.pendingNetworkOutputs?.length ?? 0) +
        (env.infrastructure?.pendingCommittedJOutbox?.length ?? 0);
      const runtimeIdle = !env.infrastructure?.processingPromise && !env.infrastructure?.inFlightEntityInputs;
      const accounts = [...replica.state.accounts.values()];
      return {
        runtimeHeight: env.state.height,
        entityHeight: replica.state.height,
        watcherScannedJHeight,
        projectedJHeight,
        finalizedJHeight,
        pendingSemanticJEventCount,
        pendingWorkCount,
        runtimeIdle,
        quiescent:
          runtimeIdle &&
          pendingWorkCount === 0 &&
          pendingSemanticJEventCount === 0 &&
          replica.mempool.length === 0 &&
          !replica.proposal &&
          !replica.lockedFrame &&
          accounts.every(
            account => account.mempool.length === 0 && !account.pendingFrame && !account.pendingAccountInput,
          ),
      };
    },
    { entityId, signerId },
  );
}

async function mineEmptyJurisdictionBlock(page: Page): Promise<void> {
  const response = await page.request.post(`${API_BASE_URL}/rpc`, {
    data: { jsonrpc: '2.0', id: 1, method: 'evm_mine', params: [] },
  });
  expect(response.ok()).toBe(true);
  const body = await response.json();
  expect(body.error).toBeUndefined();
}

test.describe('E2E User Journey', () => {
  test(
    'onboarding and explicit hub joins commit three accounts without stale pending frames',
    { tag: '@functional' },
    async ({ page }, info) => {
      await gotoApp(page);
      const wallet = await createWalletIdentity(page, 'journey-three-hubs', randomMnemonic());
      const health = await getHealth(page);
      const hubs = ['H1', 'H2', 'H3'].map(name => {
        const id = health?.hubs?.find(hub => hub.name === name && hub.online)?.entityId;
        if (!id || !/^0x[0-9a-f]{64}$/.test(id)) throw new Error(`ONBOARDING_HUB_UNAVAILABLE:${name}`);
        return { name, id };
      });
      // Current React opens one discovered account. Additional counterparties require
      // explicit user intent; the retired Svelte auto-join preference is not restored.
      await expect(page.getByTestId('account-row')).toHaveCount(1);
      for (const [index, hub] of hubs.slice(1).entries()) {
        await page.getByRole('button', { name: 'Connect another account', exact: true }).click();
        const sheet = page.getByRole('dialog', { name: 'Open account', exact: true });
        await sheet.getByTestId('open-account-target').fill(hub.id);
        await sheet.getByTestId('open-account-credit').fill('0');
        await sheet.getByRole('button', { name: 'Propose account', exact: true }).click();
        await expect(page.getByTestId('account-row')).toHaveCount(index + 2);
      }
      await expectDeliveryDrained(page, expect);
      const accounts = await Promise.all(hubs.map(async hub => ({ hub, account: await readAccount(page, hub.id) })));
      for (const { account } of accounts) {
        expect(account.height).toBeGreaterThan(0);
        expect(account.root).toMatch(/^0x[0-9a-f]{64}$/);
        expect(account.pending).toBe(false);
        expect(account.mempool).toBe(0);
        expect(account.usdc).toBe('0');
        expect(account.weth).toBe('0');
        expect(account.offers).toBe(0);
        for (const hold of account.holds) expect(hold).toMatchObject({ outgoing: '0', incoming: '0' });
      }
      await page.getByTestId('home-swap').click();
      await expect(page.getByRole('button', { name: 'Same network', exact: true })).toHaveClass('active');
      await expect(page.getByTestId('swap-cross-mode')).toHaveAttribute('aria-pressed', 'false');
      await expect(page.getByTestId('swap-give')).toBeVisible();
      await expect(page.getByTestId('swap-want')).toBeVisible();
      await expect(page.getByTestId('swap-submit')).toBeDisabled();
      await info.attach('current-three-hub-onboarding', {
        body: safeStringify({ wallet, accounts }),
        contentType: 'application/json',
      });
    },
  );

  test(
    'new wallet -> hub account -> offchain faucet commits funds and stays idle after an empty block',
    { tag: '@functional' },
    async ({ page }, info) => {
      await gotoApp(page);
      const wallet = await createWalletIdentity(page, 'journey-faucet', randomMnemonic());
      await expect(page.getByTestId('account-row')).toHaveCount(1);
      await page.getByTestId('account-row').click();
      const hubId = new URL(page.url()).pathname.split('/accounts/')[1];
      if (!hubId || !/^0x[0-9a-f]{64}$/.test(hubId)) throw new Error('JOURNEY_HUB_ACCOUNT_UNAVAILABLE');
      await expectDeliveryDrained(page, expect);
      const before = await readAccount(page, hubId);
      const persistedBefore = await getPersistedReceiptCursor(page);
      await page.getByTestId('back').click();
      const responsePromise = page.waitForResponse(
        response =>
          response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/faucet/offchain',
      );
      await page.getByTestId('home-faucet').click();
      const response = await responsePromise;
      expect(response.ok()).toBe(true);
      const receipt = await response.json();
      expect(receipt).toMatchObject({ success: true, status: 'queued', accountReady: true });
      expect(receipt.requestId).toMatch(/^offchain_/);
      await expect(page.getByTestId('test-money-status')).toHaveText('100 USDC received');
      await expect(page.getByTestId('home-total')).toHaveText('$100.00');
      await expectDeliveryDrained(page, expect);
      const funded = await readAccount(page, hubId);
      expect(BigInt(funded.usdc) - BigInt(before.usdc)).toBe(100_000_000n);
      expect(BigInt(funded.usdcSpendable) - BigInt(before.usdcSpendable)).toBe(100_000_000n);
      expect(funded.height).toBeGreaterThan(before.height);
      expect(funded.root).not.toBe(before.root);
      const persistedAfter = await getPersistedReceiptCursor(page);
      expect(persistedAfter.nextHeight).toBeGreaterThan(persistedBefore.nextHeight);
      await expect
        .poll(async () => (await readEntityIdleSnapshot(page, wallet.entityId, wallet.signerId)).quiescent)
        .toBe(true);
      const idleBefore = await readEntityIdleSnapshot(page, wallet.entityId, wallet.signerId);
      await mineEmptyJurisdictionBlock(page);
      await expect
        .poll(
          async () => (await readEntityIdleSnapshot(page, wallet.entityId, wallet.signerId)).watcherScannedJHeight,
          { timeout: 20_000, message: 'The real watcher must scan the new empty block' },
        )
        .toBeGreaterThan(idleBefore.watcherScannedJHeight);
      await expect
        .poll(async () => (await readEntityIdleSnapshot(page, wallet.entityId, wallet.signerId)).quiescent, {
          timeout: 20_000,
          message: 'Empty-block catch-up must leave no financial work pending',
        })
        .toBe(true);
      const idleAfter = await readEntityIdleSnapshot(page, wallet.entityId, wallet.signerId);
      expect(idleAfter.finalizedJHeight).toBe(idleBefore.finalizedJHeight);
      expect(await readAccount(page, hubId)).toEqual(funded);
      await info.attach('current-faucet-and-empty-block', {
        body: safeStringify({
          wallet,
          hubId,
          before,
          funded,
          receipt,
          persistedBefore,
          persistedAfter,
          idleBefore,
          idleAfter,
        }),
        contentType: 'application/json',
      });
    },
  );
});
