/**
 * E2E: a separate custody daemon and custody web app run outside the wallet stack.
 *
 * Flow and goals:
 * 1. Load the custody page, enter a deposit amount, and click `Deposit with XLN`.
 * 2. The custody app opens the wallet in dedicated `#pay` mode inside a new page.
 * 3. The wallet auto-opens the pay form, scrolls the hosted checkout into view, and pre-finds routes.
 * 4. The user only confirms with `Pay Now`.
 * 5. A clear success state appears and the wallet page auto-closes after persisted confirmation.
 * 6. The custody page keeps polling persisted receipts and updates the hero balance after deposit finalization.
 * 7. The wallet can reload from persisted state and still receive later custody withdrawals back to the same user.
 * 8. Repeated deposit and withdrawal cycles stay deterministic: custody credits from persisted events only,
 *    debits the true sender amount including fees, and never drifts from the saved dashboard state.
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
import { connectRuntimeToHub } from './utils/e2e-connect';
import { createRuntimeIdentity, gotoApp, selectDemoMnemonic, switchToRuntimeId } from './utils/e2e-demo-users';
import { getPersistedReceiptCursor, waitForPersistedFrameEvent } from './utils/e2e-runtime-receipts';

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
    eReplicas?: Map<string, {
      state?: {
        accounts?: Map<string, {
          deltas?: Map<number, unknown>;
        }>;
      };
    }>;
  };
  XLN?: {
    deriveDelta?: (delta: unknown, leftSide: boolean) => {
      outCapacity?: { toString?: () => string } | bigint | string | number;
    };
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

async function submitHostedCheckoutPayment(page: Page): Promise<void> {
  await expect(page.getByText('Hosted Checkout')).toBeVisible({ timeout: 15_000 });
  const hashlockModeButton = page.getByRole('button', { name: 'Hashlock', exact: true });
  await expect(hashlockModeButton).toBeVisible({ timeout: 15_000 });
  await expect(hashlockModeButton).toHaveAttribute('aria-pressed', 'true');
  const payNowButton = page.getByRole('button', { name: 'Pay Now', exact: true });
  await expect(payNowButton).toBeEnabled({ timeout: 30_000 });
  await payNowButton.click();
}

async function waitForHostedCheckoutSuccess(page: Page): Promise<void> {
  await expect.poll(
    async () => {
      if (page.isClosed()) return 'closed';
      const confirmed = await page.getByText('Confirmed', { exact: true }).isVisible().catch(() => false);
      if (confirmed) return 'confirmed';
      const confirmedBody = await page.getByText('Confirmed. Closing checkout...').isVisible().catch(() => false);
      if (confirmedBody) return 'confirmed';
      const toastConfirmed = await page.getByText('Payment confirmed').isVisible().catch(() => false);
      if (toastConfirmed) return 'confirmed';
      return 'pending';
    },
    {
      timeout: 30_000,
      intervals: [250, 500, 750],
      message: 'wallet checkout must show confirmation or auto-close after persisted confirmation',
    },
  ).not.toBe('pending');

  if (!page.isClosed()) {
    await expect.poll(() => page.isClosed(), {
      timeout: 10_000,
      intervals: [250, 500, 750],
      message: 'wallet checkout page must auto-close after persisted confirmation',
    }).toBe(true);
  }
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

async function outCap(page: Page, entityId: string, counterpartyId: string): Promise<bigint> {
  const value = await page.evaluate(({ entityId, counterpartyId }) => {
    const view = window as WalletRuntimeView;
    const env = view.isolatedEnv;
    const deriveDelta = view.XLN?.deriveDelta;
    if (!env?.eReplicas || typeof deriveDelta !== 'function') return '0';

    for (const [replicaKey, replica] of env.eReplicas.entries()) {
      if (!String(replicaKey).startsWith(`${entityId}:`)) continue;
      const account = replica.state?.accounts?.get(counterpartyId);
      if (!account) return '0';
      const delta = account.deltas?.get(1);
      if (!delta) return '0';
      const derived = deriveDelta(delta, String(entityId).toLowerCase() < String(counterpartyId).toLowerCase());
      const outCapacity = derived?.outCapacity;
      if (typeof outCapacity === 'bigint') return outCapacity.toString();
      if (typeof outCapacity === 'number') return String(outCapacity);
      if (typeof outCapacity === 'string') return outCapacity;
      return typeof outCapacity?.toString === 'function' ? outCapacity.toString() : '0';
    }

    return '0';
  }, { entityId, counterpartyId });

  return BigInt(value);
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
      const response = await page.request.post(apiUrl('/api/faucet/offchain'), {
        data: {
          userEntityId: entityId,
          userRuntimeId: runtimeId,
          hubEntityId,
          tokenId: 1,
          amount,
        },
      });
      const body = await response.json().catch(() => ({} as Record<string, unknown>));
      result = { ok: response.ok(), status: response.status(), data: body };
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

async function waitForOutCapAtLeast(
  page: Page,
  entityId: string,
  counterpartyId: string,
  minOut: bigint,
  timeoutMs = 15_000,
): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const current = await outCap(page, entityId, counterpartyId);
    if (current >= minOut) return;
    await page.waitForTimeout(400);
  }

  const current = await outCap(page, entityId, counterpartyId);
  throw new Error(
    `waitForOutCapAtLeast timeout: entity=${entityId.slice(0, 10)} cp=${counterpartyId.slice(0, 10)} ` +
    `current=${current.toString()} min=${minOut.toString()}`,
  );
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

async function reannounceRuntimeProfile(page: Page, entityId: string): Promise<void> {
  const ok = await page.evaluate(async (entityId) => {
    const maybeWindow = window as typeof window & {
      isolatedEnv?: {
        runtimeState?: {
          p2p?: {
            announceLocalProfiles?: () => Promise<void> | void;
            announceProfilesForEntities?: (entityIds: string[], reason?: string) => void;
            refreshGossip?: () => Promise<void> | void;
          };
        };
      };
    };
    const p2p = maybeWindow.isolatedEnv?.runtimeState?.p2p;
    if (!p2p) return false;

    try {
      if (typeof p2p.announceProfilesForEntities === 'function') {
        p2p.announceProfilesForEntities([entityId], 'e2e-wallet-rebind');
      } else if (typeof p2p.announceLocalProfiles === 'function') {
        await p2p.announceLocalProfiles();
      }
      if (typeof p2p.refreshGossip === 'function') {
        await p2p.refreshGossip();
      }
      return true;
    } catch {
      return false;
    }
  }, entityId);

  expect(ok, 'wallet runtime must re-announce its current profile').toBe(true);
}

async function waitForDaemonReceiptEvent(
  daemonClient: DaemonRpcClient,
  options: {
    entityId: string;
    eventName: string;
    timeoutMs?: number;
  },
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const startedAt = Date.now();
  const targetEntityId = options.entityId.toLowerCase();
  const recent: string[] = [];

  while (Date.now() - startedAt < timeoutMs) {
    const response = await daemonClient.getFrameReceipts({
      fromHeight: 1,
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
    }

    await delay(500);
  }

  throw new Error(
    `Timed out waiting for daemon receipt ${options.eventName} on ${targetEntityId.slice(0, 12)} ` +
    `(recent=${recent.join(',') || 'none'})`,
  );
}

async function readCustodyDashboard(
  page: Page,
  custodyBaseUrl: string,
): Promise<CustodyDashboardPayload> {
  const currentUrl = page.url();
  if (!currentUrl.startsWith(custodyBaseUrl)) {
    throw new Error(`custody page navigated away from dashboard origin: ${currentUrl}`);
  }

  return await page.evaluate(async () => {
    const response = await fetch('/api/me', {
      cache: 'no-store',
      credentials: 'same-origin',
      headers: {
        accept: 'application/json',
        'cache-control': 'no-store',
      },
    });
    if (!response.ok) {
      throw new Error(`dashboard fetch failed (${response.status})`);
    }
    return await response.json() as CustodyDashboardPayload;
  });
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
    const custodyBaseUrl = `http://127.0.0.1:${custodyPort}`;
    const relayUrl = toWsUrl(API_BASE_URL, '/relay');
    const rpcProxyUrl = apiUrl('/rpc');

    let daemonChild: ManagedChild | null = null;
    let custodyChild: ManagedChild | null = null;
    let daemonClient: DaemonRpcClient | null = null;

    const context = await browser.newContext({ ignoreHTTPSErrors: true });
    let walletPage = await context.newPage();
    const custodyPage = await context.newPage();

    try {
      await resetProdServer(walletPage, {
        apiBaseUrl: API_BASE_URL,
        timeoutMs: TEST_TIMEOUT_MS,
        softPreserveHubs: false,
      });
      await ensureE2EBaseline(walletPage, {
        apiBaseUrl: API_BASE_URL,
        timeoutMs: TEST_TIMEOUT_MS,
        requireHubMesh: true,
        requireMarketMaker: false,
        minHubCount: 3,
        forceReset: true,
      });

      const custodySupport = await startCustodySupport({
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
      });
      daemonChild = custodySupport.daemonChild;
      custodyChild = custodySupport.custodyChild;
      daemonClient = new DaemonRpcClient(`ws://127.0.0.1:${daemonPort}/rpc`);
      const custodyIdentity = custodySupport.identity;
      const hubId = custodySupport.hubIds[0]!;

      await gotoApp(walletPage);
      const alice = await createRuntimeIdentity(walletPage, 'alice', selectDemoMnemonic('alice'));
      await connectRuntimeToHub(walletPage, alice, hubId);
      const aliceOutBeforeFunding = await outCap(walletPage, alice.entityId, hubId);
      await faucetOffchain(walletPage, alice.entityId, hubId);
      await waitForOutCapAtLeast(
        walletPage,
        alice.entityId,
        hubId,
        aliceOutBeforeFunding + (10n * 10n ** 18n),
      );
      await ensureRuntimeProfileDownloaded(walletPage, custodyIdentity.entityId);
      await delay(1000);

      await custodyPage.goto(custodyBaseUrl);
      await expect(custodyPage.getByText('How To Integrate XLN')).toBeVisible({ timeout: 15_000 });
      await expect(custodyPage.getByText('journal-backed custody')).toBeVisible({ timeout: 15_000 });

      await custodyPage.locator('input[name="amount"]').fill('1');
      await custodyPage.locator('input[name="targetEntityId"]').fill(alice.entityId);
      await custodyPage.getByRole('button', { name: 'Withdraw via XLN' }).click();
      await expect(custodyPage.getByText('Insufficient custody balance')).toBeVisible({ timeout: 15_000 });

      let dashboard = await readCustodyDashboard(custodyPage, custodyBaseUrl);
      let currentBalanceMinor = BigInt(dashboard.headlineBalance?.amountMinor || '0');
      const cycles = [
        { depositWhole: 10n, withdrawWhole: 5n },
        { depositWhole: 3n, withdrawWhole: 2n },
        { depositWhole: 2n, withdrawWhole: 1n },
      ];

      for (const [cycleIndex, cycle] of cycles.entries()) {
        await walletPage.close();
        const knownBeforeDeposit = new Set(
          (dashboard.activity ?? [])
            .map(item => String(item.id || ''))
            .filter(Boolean),
        );

        await custodyPage.locator('input[name="depositAmount"]').fill(cycle.depositWhole.toString());
        const [checkoutPage] = await Promise.all([
          context.waitForEvent('page'),
          custodyPage.getByRole('button', { name: 'Deposit with XLN' }).click(),
        ]);
        await checkoutPage.waitForLoadState('domcontentloaded');
        await submitHostedCheckoutPayment(checkoutPage);
        await waitForDaemonReceiptEvent(daemonClient, {
          entityId: custodyIdentity.entityId,
          eventName: 'HtlcReceived',
          timeoutMs: 30_000,
        });
        await waitForHostedCheckoutSuccess(checkoutPage);
        walletPage = await openRestoredWalletPage(context, alice.runtimeId);

        const depositMinor = cycle.depositWhole * TOKEN_SCALE;
        currentBalanceMinor += depositMinor;
        await custodyPage.bringToFront();
        dashboard = await waitForCustodyBalance(custodyPage, custodyBaseUrl, currentBalanceMinor);
        const depositActivity = await waitForNewActivity(custodyPage, custodyBaseUrl, knownBeforeDeposit, 'deposit');
        expect(BigInt(depositActivity.amountMinor)).toBe(depositMinor);
        expect(dashboard.custody?.lastSyncError ?? null).toBeNull();
        await expect(custodyPage.locator('.balance-amount').first()).toContainText(
          String(dashboard.headlineBalance?.amountDisplay || ''),
        );

        await switchToRuntimeId(walletPage, alice.runtimeId);
        await ensureRuntimeOnline(walletPage, `alice-before-withdraw-cycle-${cycleIndex + 1}`);
        await reannounceRuntimeProfile(walletPage, alice.entityId);
        await ensureRuntimeProfileDownloaded(walletPage, custodyIdentity.entityId);
        await delay(750);

        const knownBeforeWithdraw = new Set(
          (dashboard.activity ?? [])
            .map(item => String(item.id || ''))
            .filter(Boolean),
        );
        await custodyPage.locator('input[name="amount"]').fill(cycle.withdrawWhole.toString());
        await custodyPage.locator('input[name="targetEntityId"]').fill(alice.entityId);

        const withdrawCursor = await getPersistedReceiptCursor(walletPage);
        await custodyPage.getByRole('button', { name: 'Withdraw via XLN' }).click();
        await expect(custodyPage.getByText(/Queued withdrawal/i)).toBeVisible({ timeout: 15_000 });
        await walletPage.bringToFront();
        await waitForPersistedFrameEvent(walletPage, {
          cursor: withdrawCursor,
          eventName: 'HtlcReceived',
          entityId: alice.entityId,
          timeoutMs: 30_000,
        });
        await custodyPage.bringToFront();

        const withdrawalActivity = await waitForNewActivity(
          custodyPage,
          custodyBaseUrl,
          knownBeforeWithdraw,
          'withdrawal',
          'finalized',
        );
        expect(BigInt(withdrawalActivity.requestedAmountMinor)).toBe(cycle.withdrawWhole * TOKEN_SCALE);
        expect(BigInt(withdrawalActivity.feeMinor)).toBeGreaterThan(0n);

        const senderSpentMinor = BigInt(withdrawalActivity.amountMinor);
        currentBalanceMinor -= senderSpentMinor;
        dashboard = await waitForCustodyBalance(custodyPage, custodyBaseUrl, currentBalanceMinor);
        await expect(custodyPage.locator('.balance-amount').first()).toContainText(
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
