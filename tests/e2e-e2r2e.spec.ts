/**
 * E2R2E visual coverage for the external wallet reserve path.
 *
 * Flow and goals:
 * 1. Reset to the shared 3-hub baseline and create one fresh browser runtime.
 * 2. Use the visible External tab faucet to mint classic ERC20 funds to the signer EOA.
 * 3. Deposit those external ERC20 funds into Depository.sol through the visible External tab.
 * 4. Verify the reserve credit from both saved runtime frame logs and rendered HTML balances.
 * 5. Withdraw part of the reserve balance back to the same external EOA through the visible Reserves tab.
 * 6. Verify the reserve decrease and external balance recovery from both saved frame logs and rendered HTML.
 *
 * This test exists to prove the user-facing external wallet route is sound end to end:
 * external ERC20 -> entity reserve -> external ERC20 again.
 */

import { expect, test, type Page } from '@playwright/test';
import { ensureE2EBaseline, API_BASE_URL, APP_BASE_URL } from './utils/e2e-baseline';
import { createRuntimeIdentity, gotoApp, selectDemoMnemonic } from './utils/e2e-demo-users';
import { getRenderedExternalBalance, getRenderedReserveBalance } from './utils/e2e-account-ui';
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

async function openExternalTab(page: Page): Promise<void> {
  const tab = page.getByTestId('tab-external').first();
  await expect(tab).toBeVisible({ timeout: 20_000 });
  await tab.click();
  await expect(page.getByTestId('external-refresh').first()).toBeVisible({ timeout: 20_000 });
}

async function openReservesTab(page: Page): Promise<void> {
  const tab = page.getByTestId('tab-reserves').first();
  await expect(tab).toBeVisible({ timeout: 20_000 });
  await tab.click();
  await expect(page.getByTestId('reserves-refresh').first()).toBeVisible({ timeout: 20_000 });
}

async function refreshExternalBalance(page: Page, symbol: string): Promise<number> {
  await openExternalTab(page);
  await page.getByTestId('external-refresh').first().click();
  return getRenderedExternalBalance(page, symbol);
}

async function refreshReserveBalance(page: Page, symbol: string): Promise<number> {
  await openReservesTab(page);
  await page.getByTestId('reserves-refresh').first().click();
  return getRenderedReserveBalance(page, symbol);
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
    await timedStep('e2r2e.runtime', async () => {
      await gotoApp(page, { appBaseUrl: APP_BASE_URL, initTimeoutMs: 60_000, settleMs: 500 });
      await page.evaluate((apiBaseUrl: string) => {
        (window as typeof window & { __XLN_API_BASE_URL__?: string }).__XLN_API_BASE_URL__ = apiBaseUrl;
        localStorage.setItem('xln-api-base-url', apiBaseUrl);
      }, API_BASE_URL);
      const user = await createRuntimeIdentity(page, 'alice', selectDemoMnemonic('alice'));
      entityId = user.entityId;
    });

    const symbol = 'USDC';
    let externalBeforeFaucet = 0;
    let externalAfterFaucet = 0;
    let reserveAfterDeposit = 0;
    let externalAfterDeposit = 0;
    let withdrawWhole = 0;
    let runtimeId = '';

    await timedStep('e2r2e.read-initial-balances', async () => {
      runtimeId = await getActiveRuntimeId(page);
      externalBeforeFaucet = await refreshExternalBalance(page, symbol);
      const reserveBefore = await refreshReserveBalance(page, symbol);
      expect(reserveBefore).toBeGreaterThanOrEqual(0);
    });

    await timedStep('e2r2e.external-faucet', async () => {
      await openExternalTab(page);
      await page.getByTestId(`external-faucet-${symbol}`).first().click();
      await expect
        .poll(async () => refreshExternalBalance(page, symbol), { timeout: ROUTE_TIMEOUT_MS })
        .toBeGreaterThan(externalBeforeFaucet);
      externalAfterFaucet = await refreshExternalBalance(page, symbol);
    });

    await timedStep('e2r2e.deposit-to-reserve', async () => {
      const sinceTs = Date.now();
      await openExternalTab(page);
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

    await timedStep('e2r2e.withdraw-to-external', async () => {
      withdrawWhole = Math.max(1, Math.floor(reserveAfterDeposit / 2));
      const cursor = await getPersistedReceiptCursor(page);
      await openReservesTab(page);
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
});
