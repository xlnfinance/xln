/**
 * E2R2E visual coverage for the external wallet reserve path.
 *
 * Flow and goals:
 * 1. Reset to the shared 3-hub baseline and create one fresh browser runtime.
 * 2. Use the visible asset faucet form to mint classic ERC20 funds to the signer EOA.
 * 3. Deposit those external ERC20 funds into Depository.sol through the visible Deposit form.
 * 4. Open one real hub account and move reserve into collateral through the visible Assets flow.
 * 5. Move part of that collateral back to reserve through the same visible Assets flow.
 * 6. Withdraw part of the reserve balance back to the same external EOA through the visible Withdraw form.
 * 7. Verify every step from both saved runtime frame logs and rendered HTML balances.
 *
 * This test exists to prove the user-facing external wallet route is sound end to end:
 * external ERC20 -> entity reserve -> external ERC20 again.
 */

import { expect, test, type Page } from '@playwright/test';
import { ensureE2EBaseline, API_BASE_URL, APP_BASE_URL, waitForNamedHubs } from './utils/e2e-baseline';
import { createRuntimeIdentity, gotoApp, selectDemoMnemonic, switchToRuntimeId } from './utils/e2e-demo-users';
import { connectRuntimeToHub } from './utils/e2e-connect';
import {
  getRenderedAccountSpendableBalance,
  getRenderedExternalBalance,
  getRenderedOutboundForAccount,
  getRenderedReserveBalance,
} from './utils/e2e-account-ui';
import {
  getPersistedReceiptCursor,
  waitForPersistedFrameEventMatch,
} from './utils/e2e-runtime-receipts';
import { timedStep } from './utils/e2e-timing';

const LONG_E2E = process.env.E2E_LONG === '1';
const ROUTE_TIMEOUT_MS = LONG_E2E ? 90_000 : 60_000;

type RelayDebugEvent = {
  event?: string;
  reason?: string;
  from?: string;
  details?: {
    payload?: {
      eventName?: string;
      data?: {
        entityId?: string;
        eventType?: string;
      };
    };
  };
};

async function openAssetsTab(page: Page): Promise<void> {
  const tab = page.getByTestId('tab-assets').first();
  await expect(tab).toBeVisible({ timeout: 20_000 });
  await tab.click();
  await expect(page.getByTestId('asset-ledger-refresh').first()).toBeVisible({ timeout: 20_000 });
}

async function openSettleWorkspace(page: Page): Promise<void> {
  const accountsTab = page.getByTestId('tab-accounts').first();
  await expect(accountsTab).toBeVisible({ timeout: 20_000 });
  await accountsTab.click();

  const settleTab = page.locator('.account-workspace-tab').filter({ hasText: /Settle/i }).first();
  await expect(settleTab).toBeVisible({ timeout: 20_000 });
  await settleTab.click();
}

async function selectSettleAccount(page: Page, counterpartyId: string): Promise<void> {
  await openSettleWorkspace(page);
  const picker = page.locator('.settlement-panel button.closed-trigger, .settlement-panel input[placeholder="Select account..."]').first();
  await expect(picker).toBeVisible({ timeout: 20_000 });
  await picker.click();
  const option = page.locator('.dropdown-item').filter({ hasText: counterpartyId }).first();
  await expect(option).toBeVisible({ timeout: 20_000 });
  await option.click();
}

async function broadcastSettleBatch(page: Page): Promise<void> {
  const button = page.getByTestId('settle-sign-broadcast').first();
  await expect(button).toBeVisible({ timeout: 20_000 });
  await expect(button).toBeEnabled({ timeout: 60_000 });
  await button.click();
}

async function readJBatchSnapshot(
  page: Page,
  entityId: string,
  runtimeId: string,
): Promise<{
  pendingReserveToCollateral: number;
  pendingCollateralToReserve: number;
  sentReserveToCollateral: number;
  sentCollateralToReserve: number;
  batchHistoryCount: number;
}> {
  return await page.evaluate(({ entityId, runtimeId }) => {
    const env = (window as typeof window & {
      isolatedEnv?: {
        eReplicas?: Map<string, {
          state?: {
            jBatchState?: {
              batch?: {
                reserveToCollateral?: unknown[];
                collateralToReserve?: unknown[];
              };
              sentBatch?: {
                batch?: {
                  reserveToCollateral?: unknown[];
                  collateralToReserve?: unknown[];
                };
              };
            };
            batchHistory?: unknown[];
          };
        }>;
      };
    }).isolatedEnv;
    if (!(env?.eReplicas instanceof Map)) {
      return {
        pendingReserveToCollateral: 0,
        pendingCollateralToReserve: 0,
        sentReserveToCollateral: 0,
        sentCollateralToReserve: 0,
        batchHistoryCount: 0,
      };
    }
    const replicaKey = Array.from(env.eReplicas.keys()).find((key) => {
      const [eid, sid] = String(key).split(':');
      return String(eid || '').toLowerCase() === String(entityId).toLowerCase()
        && String(sid || '').toLowerCase() === String(runtimeId).toLowerCase();
    });
    const replica = replicaKey ? env.eReplicas.get(replicaKey) : null;
    const pending = replica?.state?.jBatchState?.batch;
    const sent = replica?.state?.jBatchState?.sentBatch?.batch;
    const history = Array.isArray(replica?.state?.batchHistory) ? replica.state.batchHistory : [];
    return {
      pendingReserveToCollateral: Number(pending?.reserveToCollateral?.length || 0),
      pendingCollateralToReserve: Number(pending?.collateralToReserve?.length || 0),
      sentReserveToCollateral: Number(sent?.reserveToCollateral?.length || 0),
      sentCollateralToReserve: Number(sent?.collateralToReserve?.length || 0),
      batchHistoryCount: Number(history.length || 0),
    };
  }, { entityId, runtimeId });
}

async function refreshExternalBalance(page: Page, symbol: string): Promise<number> {
  await openAssetsTab(page);
  await page.getByTestId('asset-ledger-refresh').first().click();
  return getRenderedExternalBalance(page, symbol);
}

async function refreshReserveBalance(page: Page, symbol: string): Promise<number> {
  await openAssetsTab(page);
  await page.getByTestId('asset-ledger-refresh').first().click();
  return getRenderedReserveBalance(page, symbol);
}

async function refreshAccountSpendableBalance(page: Page, symbol: string): Promise<number> {
  await openAssetsTab(page);
  await page.getByTestId('asset-ledger-refresh').first().click();
  return getRenderedAccountSpendableBalance(page, symbol);
}

async function getActiveRuntimeId(page: Page): Promise<string> {
  const runtimeId = await page.evaluate(() => {
    const runtimeWindow = window as Window & typeof globalThis & {
      isolatedEnv?: {
        runtimeId?: string;
      };
    };
    return String(runtimeWindow.isolatedEnv?.runtimeId || '').trim();
  });
  expect(runtimeId.length, 'Runtime must expose isolatedEnv.runtimeId').toBeGreaterThan(0);
  return runtimeId;
}

async function readRelayDebugEvents(
  page: Page,
  input: { sinceTs: number; runtimeId: string; last?: number },
): Promise<RelayDebugEvent[]> {
  const params = new URLSearchParams();
  params.set('last', String(input.last ?? 400));
  params.set('since', String(Math.max(0, Math.floor(input.sinceTs))));
  params.set('runtimeId', input.runtimeId);
  const response = await page.request.get(`${API_BASE_URL}/api/debug/events?${params.toString()}`);
  if (!response.ok()) return [];
  const body = await response.json().catch(() => ({}));
  return Array.isArray(body?.events) ? body.events as RelayDebugEvent[] : [];
}

async function waitForReserveUpdatedDebugEvent(
  page: Page,
  input: { sinceTs: number; runtimeId: string; entityId: string; timeoutMs?: number },
): Promise<void> {
  const timeoutMs = input.timeoutMs ?? ROUTE_TIMEOUT_MS;
  const entityId = input.entityId.toLowerCase();
  await expect
    .poll(async () => {
      const events = await readRelayDebugEvents(page, input);
      return events.some((event) =>
        event.event === 'debug_event' &&
        event.details?.payload?.eventName === 'JEventReceived' &&
        String(event.details?.payload?.data?.entityId || '').toLowerCase() === entityId &&
        event.details?.payload?.data?.eventType === 'ReserveUpdated'
      );
    }, { timeout: timeoutMs })
    .toBe(true);
}

test.describe('E2R2E External Reserve Route', () => {
  test('external faucet -> reserve deposit -> reserve withdraw back to external', async ({ page }) => {
    test.setTimeout(LONG_E2E ? 180_000 : 120_000);

    page.on('request', (request) => {
      const url = request.url();
      if (!url.includes('/api/faucet/') && !url.includes('/api/tokens')) return;
      console.log(`[E2R2E][request] ${request.method()} ${url}`);
    });
    page.on('response', async (response) => {
      const url = response.url();
      if (!url.includes('/api/faucet/') && !url.includes('/api/tokens')) return;
      console.log(`[E2R2E][response] ${response.status()} ${url} ct=${response.headers()['content-type'] || 'none'}`);
      try {
        console.log(`[E2R2E][response-body] ${await response.text()}`);
      } catch {
        // ignore body read failures
      }
    });
    page.on('console', (message) => {
      const text = message.text();
      if (!text.includes('External faucet') && !text.includes('Deposit failed') && !text.includes('Reserve withdraw failed')) return;
      console.log(`[E2R2E][console] ${text}`);
    });

    await timedStep('e2r2e.baseline', async () => {
      await ensureE2EBaseline(page, {
        timeoutMs: LONG_E2E ? 240_000 : 120_000,
        requireHubMesh: true,
        requireMarketMaker: false,
        minHubCount: 3,
        forceReset: true,
      });
    });

    let entityId = '';
    let identity: { entityId: string; signerId: string; runtimeId: string } | null = null;
    await timedStep('e2r2e.runtime', async () => {
      await gotoApp(page, { appBaseUrl: APP_BASE_URL, initTimeoutMs: 60_000, settleMs: 500 });
      await page.evaluate((apiBaseUrl: string) => {
        (window as typeof window & { __XLN_API_BASE_URL__?: string }).__XLN_API_BASE_URL__ = apiBaseUrl;
        localStorage.setItem('xln-api-base-url', apiBaseUrl);
      }, API_BASE_URL);
      identity = await createRuntimeIdentity(page, 'alice', selectDemoMnemonic('alice'));
      await switchToRuntimeId(page, identity.runtimeId);
      entityId = identity.entityId;
    });

    const symbol = 'USDC';
    let externalBeforeFaucet = 0;
    let externalAfterFaucet = 0;
    let reserveAfterDeposit = 0;
    let externalAfterDeposit = 0;
    let withdrawWhole = 0;
    let runtimeId = '';
    let accountSpendableAfterR2C = 0;

    await timedStep('e2r2e.read-initial-balances', async () => {
      runtimeId = await getActiveRuntimeId(page);
      externalBeforeFaucet = await refreshExternalBalance(page, symbol);
      const reserveBefore = await refreshReserveBalance(page, symbol);
      expect(reserveBefore).toBeGreaterThanOrEqual(0);
    });

    await timedStep('e2r2e.open-account', async () => {
      expect(identity, 'runtime identity must exist').not.toBeNull();
      const hubsByName = await waitForNamedHubs(page, ['H1'], { timeoutMs: ROUTE_TIMEOUT_MS });
      await connectRuntimeToHub(page, { entityId, signerId: identity!.signerId }, hubsByName.h1);
      const spendableBefore = await refreshAccountSpendableBalance(page, symbol);
      expect(spendableBefore).toBeGreaterThanOrEqual(0);
    });

    await timedStep('e2r2e.external-faucet', async () => {
      await openAssetsTab(page);
      await page.getByTestId('asset-faucet-symbol').selectOption(symbol);
      await page.getByTestId(`external-faucet-${symbol}`).first().click();
      await expect
        .poll(async () => refreshExternalBalance(page, symbol), { timeout: ROUTE_TIMEOUT_MS })
        .toBeGreaterThan(externalBeforeFaucet);
      externalAfterFaucet = await refreshExternalBalance(page, symbol);
    });

    await timedStep('e2r2e.deposit-to-reserve', async () => {
      const sinceTs = Date.now();
      const depositWhole = Math.max(1, Math.floor(externalAfterFaucet / 2));
      await openAssetsTab(page);
      await page.getByTestId('asset-tab-deposit').first().click();
      await page.getByTestId('external-to-reserve-symbol').selectOption(symbol);
      await page.getByTestId('external-to-reserve-amount').fill(String(depositWhole));
      await page.getByTestId(`external-deposit-${symbol}`).first().click();

      await waitForReserveUpdatedDebugEvent(page, {
        sinceTs,
        runtimeId,
        entityId,
      });

      await expect
        .poll(async () => refreshReserveBalance(page, symbol), { timeout: ROUTE_TIMEOUT_MS })
        .toBeGreaterThan(0);
      reserveAfterDeposit = await refreshReserveBalance(page, symbol);

      await expect
        .poll(async () => refreshExternalBalance(page, symbol), { timeout: ROUTE_TIMEOUT_MS })
        .toBeLessThan(externalAfterFaucet);
      externalAfterDeposit = await refreshExternalBalance(page, symbol);
    });

    await timedStep('e2r2e.reserve-to-collateral', async () => {
      const cursor = await getPersistedReceiptCursor(page);
      const moveWhole = Math.max(1, Math.floor(reserveAfterDeposit / 2));
      await openAssetsTab(page);
      await page.getByTestId('asset-tab-r2c').first().click();
      await page.getByTestId('reserve-to-collateral-symbol').selectOption(symbol);
      await page.getByTestId('reserve-to-collateral-amount').fill(String(moveWhole));
      await page.getByTestId(`reserve-to-collateral-${symbol}`).first().click();

      await waitForPersistedFrameEventMatch(page, {
        cursor,
        eventName: 'JBatchQueued',
        entityId,
        timeoutMs: ROUTE_TIMEOUT_MS,
        predicate: (event) => Number(event.data?.batchSize || 0) > 0,
      });

      await waitForPersistedFrameEventMatch(page, {
        cursor,
        eventName: 'JEventReceived',
        entityId,
        timeoutMs: ROUTE_TIMEOUT_MS,
        predicate: (event) => String(event.data?.eventType || '') === 'AccountSettled',
      });

      await expect
        .poll(async () => refreshReserveBalance(page, symbol), { timeout: ROUTE_TIMEOUT_MS })
        .toBeLessThan(reserveAfterDeposit);
      const reserveAfterR2C = await refreshReserveBalance(page, symbol);

      await expect
        .poll(async () => refreshAccountSpendableBalance(page, symbol), { timeout: ROUTE_TIMEOUT_MS })
        .toBeGreaterThan(0);
      accountSpendableAfterR2C = await refreshAccountSpendableBalance(page, symbol);

      expect(reserveAfterR2C).toBeLessThan(reserveAfterDeposit);
      expect(accountSpendableAfterR2C).toBeGreaterThan(0);
      reserveAfterDeposit = reserveAfterR2C;
    });

    await timedStep('e2r2e.collateral-to-reserve', async () => {
      const cursor = await getPersistedReceiptCursor(page);
      const moveWhole = Math.max(1, Math.floor(accountSpendableAfterR2C / 2));
      await openAssetsTab(page);
      await page.getByTestId('asset-tab-c2r').first().click();
      await page.getByTestId('collateral-to-reserve-symbol').selectOption(symbol);
      await page.getByTestId('collateral-to-reserve-amount').fill(String(moveWhole));
      await page.getByTestId(`collateral-to-reserve-${symbol}`).first().click();

      await waitForPersistedFrameEventMatch(page, {
        cursor,
        eventName: 'JBatchQueued',
        entityId,
        timeoutMs: ROUTE_TIMEOUT_MS,
        predicate: (event) => Number(event.data?.batchSize || 0) > 0,
      });

      await waitForPersistedFrameEventMatch(page, {
        cursor,
        eventName: 'JEventReceived',
        entityId,
        timeoutMs: ROUTE_TIMEOUT_MS,
        predicate: (event) => String(event.data?.eventType || '') === 'AccountSettled',
      });

      await expect
        .poll(async () => refreshReserveBalance(page, symbol), { timeout: ROUTE_TIMEOUT_MS })
        .toBeGreaterThan(reserveAfterDeposit);
      const reserveAfterC2R = await refreshReserveBalance(page, symbol);

      await expect
        .poll(async () => refreshAccountSpendableBalance(page, symbol), { timeout: ROUTE_TIMEOUT_MS })
        .toBeLessThan(accountSpendableAfterR2C);
      const accountSpendableAfterC2R = await refreshAccountSpendableBalance(page, symbol);

      expect(reserveAfterC2R).toBeGreaterThan(reserveAfterDeposit);
      expect(accountSpendableAfterC2R).toBeLessThan(accountSpendableAfterR2C);
      reserveAfterDeposit = reserveAfterC2R;
    });

    await timedStep('e2r2e.withdraw-to-external', async () => {
      withdrawWhole = Math.max(1, Math.floor(reserveAfterDeposit / 2));
      const cursor = await getPersistedReceiptCursor(page);
      await openAssetsTab(page);
      await page.getByTestId('asset-tab-withdraw').first().click();
      await page.getByTestId('reserve-to-external-symbol').selectOption(symbol);
      const withdrawInput = page.getByTestId(`reserve-withdraw-input-${symbol}`).first();
      await expect(withdrawInput).toBeVisible({ timeout: 20_000 });
      await withdrawInput.fill(String(withdrawWhole));
      await page.getByTestId(`reserve-withdraw-${symbol}`).first().click();

      await waitForPersistedFrameEventMatch(page, {
        cursor,
        eventName: 'JBatchQueued',
        entityId,
        timeoutMs: ROUTE_TIMEOUT_MS,
        predicate: (event) => {
          const batchSize = Number(event.data?.batchSize || 0);
          return batchSize > 0;
        },
      });

      await waitForPersistedFrameEventMatch(page, {
        cursor,
        eventName: 'JEventReceived',
        entityId,
        timeoutMs: ROUTE_TIMEOUT_MS,
        predicate: (event) => String(event.data?.eventType || '') === 'ReserveUpdated',
      });

      await expect
        .poll(async () => refreshReserveBalance(page, symbol), { timeout: ROUTE_TIMEOUT_MS })
        .toBeLessThan(reserveAfterDeposit);
      const reserveAfterWithdraw = await refreshReserveBalance(page, symbol);
      expect(reserveAfterWithdraw).toBeLessThan(reserveAfterDeposit);

      await expect
        .poll(async () => refreshExternalBalance(page, symbol), { timeout: ROUTE_TIMEOUT_MS })
        .toBeGreaterThan(externalAfterDeposit);
      const externalAfterWithdraw = await refreshExternalBalance(page, symbol);
      expect(externalAfterWithdraw).toBeGreaterThan(externalAfterDeposit);
    });
  });

  test('manual settle queues R2C and C2R into local draft batch before broadcast', async ({ page }) => {
    test.setTimeout(LONG_E2E ? 180_000 : 120_000);

    await timedStep('settle-r2c-c2r.baseline', async () => {
      await ensureE2EBaseline(page, {
        timeoutMs: LONG_E2E ? 240_000 : 120_000,
        requireHubMesh: true,
        requireMarketMaker: false,
        minHubCount: 3,
        forceReset: true,
      });
    });

    let identity: { entityId: string; signerId: string; runtimeId: string } | null = null;
    let entityId = '';
    let runtimeId = '';
    await timedStep('settle-r2c-c2r.runtime', async () => {
      await gotoApp(page, { appBaseUrl: APP_BASE_URL, initTimeoutMs: 60_000, settleMs: 500 });
      await page.evaluate((apiBaseUrl: string) => {
        (window as typeof window & { __XLN_API_BASE_URL__?: string }).__XLN_API_BASE_URL__ = apiBaseUrl;
        localStorage.setItem('xln-api-base-url', apiBaseUrl);
      }, API_BASE_URL);
      identity = await createRuntimeIdentity(page, 'alice', selectDemoMnemonic('alice'));
      await switchToRuntimeId(page, identity.runtimeId);
      entityId = identity.entityId;
      runtimeId = identity.runtimeId;
    });

    const hubsByName = await waitForNamedHubs(page, ['H1'], { timeoutMs: ROUTE_TIMEOUT_MS });
    await timedStep('settle-r2c-c2r.open-account', async () => {
      await connectRuntimeToHub(page, { entityId, signerId: identity!.signerId }, hubsByName.h1);
    });

    const symbol = 'USDC';
    let runtimeReceiptCursor = await getPersistedReceiptCursor(page);

    await timedStep('settle-r2c-c2r.seed-reserve', async () => {
      await openAssetsTab(page);
      await page.getByTestId('asset-faucet-symbol').selectOption(symbol);
      await page.getByTestId(`external-faucet-${symbol}`).first().click();
      await expect
        .poll(async () => refreshExternalBalance(page, symbol), { timeout: ROUTE_TIMEOUT_MS })
        .toBeGreaterThan(0);

      await page.getByTestId('asset-tab-deposit').first().click();
      await page.getByTestId('external-to-reserve-symbol').selectOption(symbol);
      await page.getByTestId('external-to-reserve-amount').first().fill('20');
      await page.getByTestId(`external-deposit-${symbol}`).first().click();

      await waitForPersistedFrameEventMatch(page, {
        cursor: runtimeReceiptCursor,
        eventName: 'JEventReceived',
        entityId,
        timeoutMs: ROUTE_TIMEOUT_MS,
        predicate: (event) => String(event.data?.eventType || '') === 'ReserveUpdated',
      });
    });

    const reserveAfterDeposit = await refreshReserveBalance(page, symbol);
    expect(reserveAfterDeposit).toBeGreaterThan(0);

    await timedStep('settle-r2c-c2r.queue-r2c-draft', async () => {
      await selectSettleAccount(page, hubsByName.h1);
      const before = await readJBatchSnapshot(page, entityId, runtimeId);

      const r2cTab = page.locator('.settlement-panel .action-tabs .tab').filter({ hasText: /^Reserve → Collateral$/ }).first();
      await expect(r2cTab).toBeVisible({ timeout: 20_000 });
      await r2cTab.click();

      const amountInput = page.locator('.settlement-panel .settle-amount-shell input').first();
      await expect(amountInput).toBeVisible({ timeout: 20_000 });
      await amountInput.fill('10');

      const queueButton = page.getByTestId('settle-queue-r2c').first();
      await expect(queueButton).toBeEnabled({ timeout: 20_000 });
      await queueButton.click();

      await expect
        .poll(async () => (await readJBatchSnapshot(page, entityId, runtimeId)).pendingReserveToCollateral, {
          timeout: ROUTE_TIMEOUT_MS,
        })
        .toBeGreaterThan(before.pendingReserveToCollateral);
    });

    runtimeReceiptCursor = await getPersistedReceiptCursor(page);
    await timedStep('settle-r2c-c2r.broadcast-r2c', async () => {
      await openSettleWorkspace(page);
      const before = await readJBatchSnapshot(page, entityId, runtimeId);
      await broadcastSettleBatch(page);
      await expect
        .poll(async () => {
          const snap = await readJBatchSnapshot(page, entityId, runtimeId);
          return snap.sentReserveToCollateral > before.sentReserveToCollateral || snap.batchHistoryCount > before.batchHistoryCount;
        }, { timeout: ROUTE_TIMEOUT_MS })
        .toBe(true);
      await waitForPersistedFrameEventMatch(page, {
        cursor: runtimeReceiptCursor,
        eventName: 'JEventReceived',
        entityId,
        timeoutMs: ROUTE_TIMEOUT_MS,
        predicate: (event) => String(event.data?.eventType || '') === 'AccountSettled',
      });
    });

    await expect
      .poll(async () => getRenderedOutboundForAccount(page, hubsByName.h1), {
        timeout: ROUTE_TIMEOUT_MS,
      })
      .toBeGreaterThan(0);
    const outboundAfterR2C = await getRenderedOutboundForAccount(page, hubsByName.h1);
    expect(outboundAfterR2C).toBeGreaterThan(0);

    runtimeReceiptCursor = await getPersistedReceiptCursor(page);
    await timedStep('settle-r2c-c2r.queue-c2r-draft', async () => {
      await selectSettleAccount(page, hubsByName.h1);
      const before = await readJBatchSnapshot(page, entityId, runtimeId);

      const c2rTab = page.locator('.settlement-panel .action-tabs .tab').filter({ hasText: /^Collateral → Reserve$/ }).first();
      await expect(c2rTab).toBeVisible({ timeout: 20_000 });
      await c2rTab.click();

      const amountInput = page.locator('.settlement-panel .settle-amount-shell input').first();
      await expect(amountInput).toBeVisible({ timeout: 20_000 });
      await amountInput.fill('5');

      const queueButton = page.getByTestId('settle-queue-c2r').first();
      await expect(queueButton).toBeEnabled({ timeout: 20_000 });
      await queueButton.click();

      await expect
        .poll(async () => (await readJBatchSnapshot(page, entityId, runtimeId)).pendingCollateralToReserve, {
          timeout: ROUTE_TIMEOUT_MS,
        })
        .toBeGreaterThan(before.pendingCollateralToReserve);
    });

    await timedStep('settle-r2c-c2r.broadcast-c2r', async () => {
      await openSettleWorkspace(page);
      const before = await readJBatchSnapshot(page, entityId, runtimeId);
      await broadcastSettleBatch(page);
      await expect
        .poll(async () => {
          const snap = await readJBatchSnapshot(page, entityId, runtimeId);
          return snap.sentCollateralToReserve > before.sentCollateralToReserve || snap.batchHistoryCount > before.batchHistoryCount;
        }, { timeout: ROUTE_TIMEOUT_MS })
        .toBe(true);
      await waitForPersistedFrameEventMatch(page, {
        cursor: runtimeReceiptCursor,
        eventName: 'JEventReceived',
        entityId,
        timeoutMs: ROUTE_TIMEOUT_MS,
        predicate: (event) => String(event.data?.eventType || '') === 'AccountSettled',
      });
    });

    await expect
      .poll(async () => refreshReserveBalance(page, symbol), {
        timeout: ROUTE_TIMEOUT_MS,
      })
      .toBeGreaterThan(0);
    const reserveAfterC2R = await refreshReserveBalance(page, symbol);
    expect(reserveAfterC2R).toBeGreaterThan(0);
  });
});
