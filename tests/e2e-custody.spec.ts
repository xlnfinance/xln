/**
 * E2E: a separate custody daemon and custody web app run outside the wallet stack.
 *
 * Flow and goals:
 * 1. Load the custody page and prove withdraw is rejected before any credited balance exists.
 * 2. Deposit cycle A opens the full wallet via `Find Routes` and lets the user choose a route.
 * 3. Deposit cycle B uses the embedded `Pay` button for one-click payment.
 * 5. Both deposit modes must credit custody balance from persisted receipts.
 * 6. Later withdrawals still spend only from already credited custody balance.
 *
 * The same scenario then proves the custody backend refuses withdrawals before credit exists
 * and spends only from already credited offchain funds after the deposit lands.
 */

import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { DaemonRpcClient, type DaemonFrameLog } from '../custody/daemon-client';
import { startCustodySupport, stopManagedChild, type ManagedChild } from '../runtime/orchestrator/custody-bootstrap';
import { APP_BASE_URL, API_BASE_URL, ensureE2EBaseline, resetProdServer } from './utils/e2e-baseline';
import {
  getRenderedOutboundForAccount,
  getRenderedPrimaryOutbound,
  waitForRenderedPrimaryOutboundDelta,
  waitForRenderedOutboundForAccountDelta,
} from './utils/e2e-account-ui';
import { connectRuntimeToHub } from './utils/e2e-connect';
import { createRuntimeIdentity, gotoApp, selectDemoMnemonic, switchToRuntimeId } from './utils/e2e-demo-users';
import {
  getPersistedReceiptCursor,
  waitForPersistedFrameEvent,
} from './utils/e2e-runtime-receipts';
import { timedStep } from './utils/e2e-timing';

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const LONG_E2E = process.env.E2E_LONG === '1';
const TEST_TIMEOUT_MS = LONG_E2E ? 240_000 : 150_000;
const TOKEN_SCALE = 10n ** 18n;

type CustodyDashboardPayload = {
  headlineBalance?: {
    amountDisplay?: string;
    amountMinor?: string;
  };
  custody?: {
    lastSyncError?: string | null;
    lastSyncOkAt?: number | null;
  };
  activity?: Array<{
    id?: string;
    kind?: string;
    amountMinor?: string;
    amountDisplay?: string;
    requestedAmountMinor?: string;
    requestedAmountDisplay?: string;
    feeMinor?: string;
    feeDisplay?: string;
    status?: string;
    description?: string;
  }>;
};

type FaucetAttemptResult = {
  ok: boolean;
  status: number;
  data: Record<string, unknown>;
};

type WalletRuntimeView = typeof window & {
  isolatedEnv?: {
    runtimeId?: string;
  };
};

const getFreePort = async (): Promise<number> => {
  return await new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        reject(new Error('Failed to allocate dynamic port'));
        return;
      }
      const port = address.port;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(port);
      });
    });
  });
};

const apiUrl = (pathname: string): string => new URL(pathname, API_BASE_URL).toString();

const toWsUrl = (baseUrl: string, pathname: string): string => {
  const url = new URL(pathname, baseUrl);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.toString();
};

async function ensureRuntimeProfileDownloaded(page: Page, entityId: string): Promise<void> {
  const ok = await page.evaluate(async (targetEntityId: string) => {
    const maybeWindow = window as typeof window & {
      isolatedEnv?: {
        gossip?: {
          getProfiles?: () => Array<{ entityId?: string }>;
        };
        runtimeState?: {
          p2p?: {
            ensureProfiles?: (entityIds: string[]) => Promise<boolean>;
            refreshGossip?: () => Promise<void> | void;
          };
        };
      };
    };
    const env = maybeWindow.isolatedEnv;
    const p2p = env?.runtimeState?.p2p;
    const target = String(targetEntityId || '').toLowerCase();
    const hasProfile = (): boolean =>
      (env?.gossip?.getProfiles?.() ?? []).some(profile => String(profile.entityId || '').toLowerCase() === target);

    if (hasProfile()) return true;
    const startedAt = Date.now();
    while (Date.now() - startedAt < 15_000) {
      if (typeof p2p?.ensureProfiles === 'function') {
        try {
          const found = await p2p.ensureProfiles([target]);
          if (found && hasProfile()) return true;
        } catch {
          // best effort
        }
      }
      if (typeof p2p?.refreshGossip === 'function') {
        try {
          await p2p.refreshGossip();
        } catch {
          // best effort
        }
      }
      if (hasProfile()) return true;
      await new Promise(resolve => setTimeout(resolve, 300));
    }
    return hasProfile();
  }, entityId);

  expect(ok, `runtime must download gossip profile for ${entityId.slice(0, 12)}`).toBe(true);
}

async function submitEmbeddedPayAction(page: Page): Promise<void> {
  const button = page.frameLocator('.paybutton-controller-frame').locator('button.paybutton').first();
  await expect(button).toBeVisible({ timeout: 60_000 });
  await expect.poll(
    async () => {
      try {
        return await button.evaluate((node) => {
          const buttonEl = node as HTMLButtonElement;
          return {
            detached: false,
            disabled: buttonEl.disabled,
            text: buttonEl.textContent?.trim() || '',
          };
        });
      } catch (error) {
        return {
          detached: true,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
    {
      timeout: 60_000,
      intervals: [250, 500, 1_000],
      message: 'embedded pay button must become enabled',
    },
  ).toMatchObject({ detached: false, disabled: false });
  await button.click();
}

async function submitPopupFindRoutesAction(page: Page, targetEntityId: string): Promise<Page> {
  const popupPromise = page.waitForEvent('popup');
  await page.getByRole('button', { name: /^Find Routes$/i }).click();
  const popup = await popupPromise;
  await popup.waitForLoadState('domcontentloaded');
  const findRoutesButton = popup.getByRole('button', { name: /^Find Routes$/i });
  const firstRoute = popup.locator('.route-option').first();
  const routeError = popup.locator('.profile-preflight-error');
  await expect(findRoutesButton).toBeVisible({ timeout: 60_000 });
  await popup.waitForTimeout(1_000);
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    await findRoutesButton.click();
    try {
      await expect(firstRoute).toBeVisible({ timeout: 4_000 });
      break;
    } catch {
      const errorText = (await routeError.textContent().catch(() => '') || '').trim();
      if (errorText) {
        console.log(`[custody:popup] route retry after error: ${errorText}`);
      }
      await ensureRuntimeProfileDownloaded(popup, targetEntityId).catch(() => undefined);
      await popup.waitForTimeout(1_000);
    }
  }
  await expect(firstRoute).toBeVisible({ timeout: 1_000 });
  await popup.locator('.route-option').first().click();
  await popup.getByRole('button', { name: /Send On Selected Route/i }).click();
  return popup;
}

async function waitForEmbeddedPaySuccess(page: Page): Promise<void> {
  const frameButton = page.frameLocator('.paybutton-controller-frame').locator('button.paybutton').first();
  await expect.poll(
    async () => {
      const parentConfirmed = await page.getByText('Payment confirmed', { exact: false }).isVisible().catch(() => false);
      if (parentConfirmed) return 'confirmed';
      const framePaid = await frameButton.textContent().catch(() => '');
      if ((framePaid || '').match(/Paid in .* ms/i)) return 'paid';
      return 'pending';
    },
    {
      timeout: 45_000,
      intervals: [250, 500, 750],
      message: 'embedded pay button must confirm payment',
    },
  ).not.toBe('pending');
}

async function openRestoredWalletPage(
  context: BrowserContext,
  runtimeId: string,
): Promise<Page> {
  const page = await context.newPage();
  await gotoApp(page);
  await switchToRuntimeId(page, runtimeId);
  await ensureRuntimeOnline(page, `restored-${runtimeId.slice(0, 8)}`);
  return page;
}

async function faucetOffchain(
  page: Page,
  entityId: string,
  hubEntityId: string,
  amount = '100',
): Promise<void> {
  let result: FaucetAttemptResult = { ok: false, status: 0, data: { error: 'not-run' } };

  for (let attempt = 1; attempt <= 15; attempt += 1) {
    const runtimeId = await page.evaluate(() => {
      const view = window as WalletRuntimeView;
      return view.isolatedEnv?.runtimeId ?? null;
    });
    if (!runtimeId) {
      result = { ok: false, status: 0, data: { error: 'missing runtimeId in isolatedEnv' } };
      break;
    }

    try {
      result = await page.evaluate(async (payload) => {
        const response = await fetch('/api/faucet/offchain', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        const body = await response.json().catch(() => ({} as Record<string, unknown>));
        return { ok: response.ok, status: response.status, data: body };
      }, {
        userEntityId: entityId,
        userRuntimeId: runtimeId,
        hubEntityId,
        tokenId: 1,
        amount,
      });
    } catch (error) {
      result = {
        ok: false,
        status: 0,
        data: { error: error instanceof Error ? error.message : String(error) },
      };
    }

    if (result.ok) break;

    const code = String(result.data.code || '');
    const status = String(result.data.status || '');
    const transient =
      result.status === 202 ||
      result.status === 409 ||
      code === 'FAUCET_CHANNEL_NOT_READY' ||
      status === 'channel_opening' ||
      status === 'channel_not_ready';
    if (!transient || attempt === 15) break;
    await page.waitForTimeout(1000);
  }

  expect(result.ok, `offchain faucet failed: ${JSON.stringify(result.data)}`).toBe(true);
}

async function ensureRuntimeOnline(page: Page, tag: string): Promise<void> {
  const ok = await page.evaluate(async () => {
    const maybeWindow = window as typeof window & {
      isolatedEnv?: {
        runtimeState?: {
          p2p?: {
            isConnected?: () => boolean;
            connect?: () => void;
            reconnect?: () => void;
          };
        };
      };
    };
    const env = maybeWindow.isolatedEnv;
    const p2p = env?.runtimeState?.p2p;
    if (!env || !p2p) return false;

    const startedAt = Date.now();
    while (Date.now() - startedAt < 20_000) {
      if (typeof p2p.isConnected === 'function' && p2p.isConnected()) return true;
      if (typeof p2p.connect === 'function') {
        try {
          p2p.connect();
        } catch {
          // best effort
        }
      } else if (typeof p2p.reconnect === 'function') {
        try {
          p2p.reconnect();
        } catch {
          // best effort
        }
      }
      await new Promise(resolve => setTimeout(resolve, 500));
    }

    return typeof p2p.isConnected === 'function' && p2p.isConnected();
  });

  expect(ok, `[${tag}] runtime must be online`).toBe(true);
}

async function waitForDaemonReceiptEvent(
  daemonClient: DaemonRpcClient,
  options: {
    entityId: string;
    eventName: string;
    fromHeight?: number;
    timeoutMs?: number;
  },
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const startedAt = Date.now();
  const targetEntityId = options.entityId.toLowerCase();
  const recent: string[] = [];
  let fromHeight = Math.max(1, options.fromHeight ?? 1);

  while (Date.now() - startedAt < timeoutMs) {
    const response = await daemonClient.getFrameReceipts({
      fromHeight,
      limit: 250,
      entityId: targetEntityId,
      eventNames: ['HtlcReceived', 'PaymentFinalized', 'PaymentFailed'],
    });

    for (const receipt of response.receipts) {
      for (const log of receipt.logs) {
        recent.push(`${receipt.height}:${log.message}`);
        if (recent.length > 16) recent.shift();
        if (log.message === options.eventName) return;
      }
      fromHeight = Math.max(fromHeight, receipt.height + 1);
    }

    await delay(500);
  }

  throw new Error(
    `Timed out waiting for daemon receipt ${options.eventName} on ${targetEntityId.slice(0, 12)} ` +
    `(recent=${recent.join(',') || 'none'})`,
  );
}

async function getDaemonReceiptCursor(
  daemonClient: DaemonRpcClient,
  entityId: string,
): Promise<number> {
  const targetEntityId = entityId.toLowerCase();
  const response = await daemonClient.getFrameReceipts({
    fromHeight: 1,
    limit: 250,
    entityId: targetEntityId,
    eventNames: ['HtlcReceived', 'PaymentFinalized', 'PaymentFailed'],
  });
  let nextHeight = 1;
  for (const receipt of response.receipts) {
    nextHeight = Math.max(nextHeight, receipt.height + 1);
  }
  return nextHeight;
}

async function readCustodyDashboard(
  page: Page,
  custodyBaseUrl: string,
): Promise<CustodyDashboardPayload> {
  const currentUrl = page.url();
  if (!currentUrl.startsWith(custodyBaseUrl)) {
    throw new Error(`custody page navigated away from dashboard origin: ${currentUrl}`);
  }

  return await page.evaluate(async (baseUrl) => {
    const response = await fetch(new URL('/api/me', baseUrl).toString(), {
      headers: {
        accept: 'application/json',
        'cache-control': 'no-store',
      },
      credentials: 'same-origin',
      cache: 'no-store',
    });
    if (!response.ok) {
      throw new Error(`dashboard fetch failed (${response.status})`);
    }
    return await response.json();
  }, custodyBaseUrl) as CustodyDashboardPayload;
}

async function waitForCustodyBalance(
  page: Page,
  custodyBaseUrl: string,
  expectedMinor: bigint,
): Promise<CustodyDashboardPayload> {
  await expect.poll(
    async () => {
      const dashboard = await readCustodyDashboard(page, custodyBaseUrl);
      return String(dashboard.headlineBalance?.amountMinor || '0');
    },
    {
      timeout: 30_000,
      intervals: [500, 750, 1000],
      message: `custody balance must converge to ${expectedMinor.toString()}`,
    },
  ).toBe(expectedMinor.toString());

  return await readCustodyDashboard(page, custodyBaseUrl);
}

async function waitForNewActivity(
  page: Page,
  custodyBaseUrl: string,
  knownIds: Set<string>,
  kind: 'deposit' | 'withdrawal',
  status?: string,
): Promise<Required<NonNullable<CustodyDashboardPayload['activity']>[number]>> {
  let found: Required<NonNullable<CustodyDashboardPayload['activity']>[number]> | null = null;
  await expect.poll(
    async () => {
      const dashboard = await readCustodyDashboard(page, custodyBaseUrl);
      const activity = Array.isArray(dashboard.activity) ? dashboard.activity : [];
      const item = activity.find((entry) => {
        const id = String(entry.id || '');
        if (entry.kind !== kind || id.length === 0 || knownIds.has(id)) return false;
        if (status && String(entry.status || '') !== status) return false;
        return true;
      });
      found = item
        ? {
            id: String(item.id || ''),
            kind: String(item.kind || ''),
            amountMinor: String(item.amountMinor || '0'),
            amountDisplay: String(item.amountDisplay || ''),
            requestedAmountMinor: String(item.requestedAmountMinor || '0'),
            requestedAmountDisplay: String(item.requestedAmountDisplay || ''),
            feeMinor: String(item.feeMinor || '0'),
            feeDisplay: String(item.feeDisplay || ''),
            status: String(item.status || ''),
            description: String(item.description || ''),
          }
        : null;
      return found !== null;
    },
    {
      timeout: 30_000,
      intervals: [500, 750, 1000],
      message: `custody must record a new ${kind} activity`,
    },
  ).toBe(true);
  return found!;
}

test.describe('E2E Custody Flow', () => {
  // Scenario: a new custody daemon joins the existing 3-hub mesh as a separate runtime, receives
  // a journal-backed deposit from a browser wallet, refuses to withdraw before funds exist, and
  // then sends a real HTLC withdrawal using only the custody service's locally credited balance.
  test('separate custody daemon credits deposits and withdraws only from credited offchain balance', async ({ browser }) => {
    test.setTimeout(TEST_TIMEOUT_MS);

    const tempRoot = await mkdtemp(join(tmpdir(), 'xln-custody-e2e-'));
    const daemonPort = await getFreePort();
    const custodyPort = await getFreePort();
    const custodyBaseUrl = `https://localhost:${custodyPort}`;
    const relayUrl = toWsUrl(API_BASE_URL, '/relay');
    const rpcProxyUrl = process.env.E2E_ANVIL_RPC ?? 'http://localhost:8545';

    let daemonChild: ManagedChild | null = null;
    let custodyChild: ManagedChild | null = null;
    let daemonClient: DaemonRpcClient | null = null;

    const context = await timedStep('custody.browser_context', () => browser.newContext({ ignoreHTTPSErrors: true }));
    let walletPage = await context.newPage();
    const custodyPage = await context.newPage();
    custodyPage.on('console', (message) => {
      console.log(`[custody:console] ${message.type()}: ${message.text()}`);
    });

    try {
      await timedStep('custody.reset_server', () => resetProdServer(walletPage, {
        apiBaseUrl: API_BASE_URL,
        timeoutMs: TEST_TIMEOUT_MS,
        softPreserveHubs: false,
      }));
      await timedStep('custody.ensure_baseline', () => ensureE2EBaseline(walletPage, {
        apiBaseUrl: API_BASE_URL,
        timeoutMs: TEST_TIMEOUT_MS,
        requireHubMesh: true,
        requireMarketMaker: false,
        minHubCount: 3,
        forceReset: true,
      }));

      const custodySupport = await timedStep('custody.start_support', () => startCustodySupport({
        apiBaseUrl: API_BASE_URL,
        daemonPort,
        custodyPort,
        relayUrl,
        rpcUrl: rpcProxyUrl,
        walletUrl: new URL('/app', APP_BASE_URL).toString(),
        dbRoot: tempRoot,
        seed: 'xln-e2e-custody-seed',
        signerLabel: 'custody-e2e-1',
        profileName: 'Custody',
      }));
      daemonChild = custodySupport.daemonChild;
      custodyChild = custodySupport.custodyChild;
      daemonClient = new DaemonRpcClient(`ws://127.0.0.1:${daemonPort}/rpc`);
      const custodyIdentity = custodySupport.identity;
      const hubId = custodySupport.hubIds[0]!;

      if (!walletPage.isClosed()) {
        await walletPage.close();
      }
      walletPage = await context.newPage();

      await timedStep('custody.wallet.goto_app', () => gotoApp(walletPage));
      const alice = await timedStep(
        'custody.wallet.create_runtime',
        () => createRuntimeIdentity(walletPage, 'alice', selectDemoMnemonic('alice')),
      );
      await timedStep('custody.wallet.connect_hub', () => connectRuntimeToHub(walletPage, alice, hubId));
      const walletRenderedBeforeFunding = await timedStep(
        'custody.wallet.read_rendered_out_before_faucet',
        () => getRenderedPrimaryOutbound(walletPage),
      );
      await timedStep('custody.wallet.faucet', () => faucetOffchain(walletPage, alice.entityId, hubId));
      await timedStep(
        'custody.wallet.wait_rendered_out_after_faucet',
        () => waitForRenderedPrimaryOutboundDelta(
          walletPage,
          walletRenderedBeforeFunding,
          100,
          { timeoutMs: 20_000 },
        ),
      );
      await timedStep(
        'custody.wallet.ensure_custody_profile',
        () => ensureRuntimeProfileDownloaded(walletPage, custodyIdentity.entityId),
      );
      if (!walletPage.isClosed()) {
        await walletPage.close();
      }

      await timedStep('custody.open_dashboard', () => custodyPage.goto(custodyBaseUrl));
      await expect(custodyPage.getByRole('heading', { name: 'Deposit' })).toBeVisible({ timeout: 15_000 });
      await expect(custodyPage.locator('.paybutton-controller-frame').first()).toBeVisible({ timeout: 60_000 });
      await expect(custodyPage.getByRole('button', { name: /^Find Routes$/i })).toBeVisible({ timeout: 60_000 });
      await custodyPage.screenshot({ path: test.info().outputPath('custody-dashboard-initial.png'), fullPage: true });

      await custodyPage.locator('input[name="amount"]').fill('1');
      await custodyPage.locator('input[name="targetEntityId"]').fill(alice.entityId);
      await custodyPage.getByRole('button', { name: 'Withdraw via XLN' }).click();
      await expect(custodyPage.getByText('Insufficient custody balance')).toBeVisible({ timeout: 15_000 });

      let dashboard = await readCustodyDashboard(custodyPage, custodyBaseUrl);
      let currentBalanceMinor = BigInt(dashboard.headlineBalance?.amountMinor || '0');
      const depositCycles = [
        { whole: 3n, action: 'pay' as const },
        { whole: 10n, action: 'findroutes' as const },
      ];

      for (const [cycleIndex, cycle] of depositCycles.entries()) {
        const knownBeforeDeposit = new Set(
          (dashboard.activity ?? [])
            .map(item => String(item.id || ''))
            .filter(Boolean),
        );
        const daemonReceiptCursor = await getDaemonReceiptCursor(daemonClient, custodyIdentity.entityId);

        await timedStep(`custody.deposit_cycle_${cycleIndex + 1}`, async () => {
          await custodyPage.locator('input[name="depositAmount"]').fill(cycle.whole.toString());
          if (cycle.action === 'findroutes') {
            const popup = await submitPopupFindRoutesAction(custodyPage, custodyIdentity.entityId);
            await waitForDaemonReceiptEvent(daemonClient, {
              entityId: custodyIdentity.entityId,
              eventName: 'HtlcReceived',
              fromHeight: daemonReceiptCursor,
              timeoutMs: 30_000,
            });
            await popup.close().catch(() => undefined);
          } else {
            await submitEmbeddedPayAction(custodyPage);
            await waitForDaemonReceiptEvent(daemonClient, {
              entityId: custodyIdentity.entityId,
              eventName: 'HtlcReceived',
              fromHeight: daemonReceiptCursor,
              timeoutMs: 30_000,
            });
            await waitForEmbeddedPaySuccess(custodyPage).catch(() => undefined);
          }
        });

        const depositMinor = cycle.whole * TOKEN_SCALE;
        currentBalanceMinor += depositMinor;
        await custodyPage.bringToFront();
        const depositActivity = await timedStep(`custody.deposit_cycle_${cycleIndex + 1}.wait_credit`, async () => {
          dashboard = await waitForCustodyBalance(custodyPage, custodyBaseUrl, currentBalanceMinor);
          return waitForNewActivity(custodyPage, custodyBaseUrl, knownBeforeDeposit, 'deposit');
        });
        expect(BigInt(depositActivity.amountMinor)).toBe(depositMinor);
        expect(dashboard.custody?.lastSyncError ?? null).toBeNull();
        await expect(custodyPage.locator('.token-balance').first()).toContainText(
          String(dashboard.headlineBalance?.amountDisplay || ''),
        );
      }

      const withdrawCycles = [5n, 2n];
      for (const [cycleIndex, withdrawWhole] of withdrawCycles.entries()) {
        const embeddedFrame = custodyPage.locator('.paybutton-controller-frame').first();
        if (await embeddedFrame.isVisible().catch(() => false)) {
          await embeddedFrame.evaluate((node) => {
            const frame = node as HTMLIFrameElement;
            frame.src = 'about:blank';
          }).catch(() => undefined);
        }
        if (!walletPage.isClosed()) {
          await walletPage.close();
        }
        walletPage = await openRestoredWalletPage(context, alice.runtimeId);
        await ensureRuntimeOnline(walletPage, `alice-before-withdraw-cycle-${cycleIndex + 1}`);

        const knownBeforeWithdraw = new Set(
          (dashboard.activity ?? [])
            .map(item => String(item.id || ''))
            .filter(Boolean),
        );
        await custodyPage.locator('input[name="amount"]').fill(withdrawWhole.toString());
        await custodyPage.locator('input[name="targetEntityId"]').fill(alice.entityId);

        const walletRenderedBeforeWithdraw = await getRenderedOutboundForAccount(walletPage, hubId);
        const withdrawCursor = await getPersistedReceiptCursor(walletPage);
        const withdrawalActivity = await timedStep(`custody.withdraw_cycle_${cycleIndex + 1}`, async () => {
          await custodyPage.getByRole('button', { name: 'Withdraw via XLN' }).click();
          await expect(custodyPage.getByText(/Queued withdrawal/i)).toBeVisible({ timeout: 15_000 });
          await walletPage.bringToFront();
          await waitForPersistedFrameEvent(walletPage, {
            cursor: withdrawCursor,
            eventName: 'HtlcReceived',
            entityId: alice.entityId,
            timeoutMs: 30_000,
          });
          await waitForRenderedOutboundForAccountDelta(
            walletPage,
            hubId,
            walletRenderedBeforeWithdraw,
            Number(withdrawWhole),
            { timeoutMs: 30_000, tolerance: 0.000001 },
          );
          await custodyPage.bringToFront();
          return waitForNewActivity(
            custodyPage,
            custodyBaseUrl,
            knownBeforeWithdraw,
            'withdrawal',
            'finalized',
          );
        });
        expect(BigInt(withdrawalActivity.requestedAmountMinor)).toBe(withdrawWhole * TOKEN_SCALE);
        expect(BigInt(withdrawalActivity.feeMinor)).toBeGreaterThan(0n);

        const senderSpentMinor = BigInt(withdrawalActivity.amountMinor);
        currentBalanceMinor -= senderSpentMinor;
        dashboard = await timedStep(
          `custody.withdraw_cycle_${cycleIndex + 1}.wait_debit`,
          () => waitForCustodyBalance(custodyPage, custodyBaseUrl, currentBalanceMinor),
        );
        await expect(custodyPage.locator('.token-balance').first()).toContainText(
          String(dashboard.headlineBalance?.amountDisplay || ''),
        );
      }
    } finally {
      await context.close();
      await daemonClient?.close();
      await stopManagedChild(custodyChild);
      await stopManagedChild(daemonChild);
      await rm(tempRoot, { recursive: true, force: true });
    }
  });
});
