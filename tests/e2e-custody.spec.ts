/**
 * E2E: a separate custody daemon and custody web app run outside the wallet stack.
 *
 * Flow and goals:
 * 1. Load the custody page and prove withdraw is rejected before any credited balance exists.
 * 2. Deposit cycle A validates the canonical public wallet link and pays its invoice locally.
 * 3. Deposit cycle B copies the invoice and pastes it into the wallet pay screen.
 * 4. Both invoices must credit custody balance from persisted receipts.
 * 5. Later withdrawals still spend only from already credited custody balance.
 *
 * The same scenario then proves the custody backend refuses withdrawals before credit exists
 * and spends only from already credited offchain funds after the deposit lands.
 */

import { test, expect, type Page } from './global-setup.mts';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { DaemonRpcClient } from '../custody/daemon-client';
import type { RuntimeAdapterViewFrame, XLNModule } from '../core/api/public/runtime-module';
import type { RuntimeAdapter } from '../core/api/runtime-adapter/types';
import { startCustodySupport, stopManagedChild, type ManagedChild } from '../core/orchestrator/bootstrap/custody-bootstrap';
import { selectPrimaryHubJurisdiction } from '../core/orchestrator/j-select/jurisdiction-select';
import { APP_BASE_URL, API_BASE_URL, ensureE2EBaseline } from './utils/e2e-baseline';
import {
  getRenderedOutboundForAccount,
  waitForRenderedOutboundForAccountDelta,
} from './utils/runtime/e2e-account-ui';
import {
  connectRuntimeToHubWithCredit,
  ensureRuntimeOnline,
  waitForReceiveReadyGossipProfiles,
} from './utils/e2e-connect';
import { openPayWorkspace, chooseVisibleRoute } from './utils/runtime/e2e-pay-ui';
import { gotoApp, selectDemoMnemonic } from './utils/e2e-demo-users';
import { createWalletIdentity } from '../ui/tests/wallet-ui';
import { timedStep } from './utils/e2e-timing.mts';
import { closeRuntimeContext } from './utils/runtime/e2e-runtime-shutdown.mts';

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const LONG_E2E = process.env.E2E_LONG === '1';
const ISOLATED_BASELINE_READY = process.env.E2E_ISOLATED_BASELINE_READY === '1';
const TEST_TIMEOUT_MS = LONG_E2E ? 420_000 : 360_000;
type CustodyDashboardPayload = {
  headlineBalance?: {
    amountDisplay?: string;
    amountMinor?: string;
  };
  tokens?: Array<{
    tokenId?: number;
    symbol?: string;
    amountDisplay?: string;
    amountMinor?: string;
  }>;
  custody?: {
    lastSyncError?: string | null;
    lastSyncOkAt?: number | null;
  };
  activity?: Array<{
    id?: string;
    kind?: string;
    tokenId?: number;
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

type WalletRuntimeView = Window & {
  __xln?: { adapter(): RuntimeAdapter | null; xln(): Promise<XLNModule> };
};

type ApiTokenEntry = {
  symbol?: string;
  tokenId?: number;
  decimals?: number;
};

type ApiToken = {
  symbol: string;
  tokenId: number;
  decimals: number;
  scale: bigint;
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

const resolvePrimaryCustodyJurisdictionId = async (): Promise<string> => {
  const response = await fetch(apiUrl('/api/jurisdictions'), { cache: 'no-store' });
  if (!response.ok) throw new Error(`E2E_CUSTODY_JURISDICTIONS_HTTP_${response.status}`);
  const primary = selectPrimaryHubJurisdiction(await response.json(), {
    rpc2Url: process.env.E2E_ANVIL_RPC2 ?? process.env.RPC_TRON ?? '',
  });
  if (!primary?.key) throw new Error('E2E_CUSTODY_PRIMARY_JURISDICTION_MISSING');
  return primary.key;
};

async function getApiToken(page: Page, symbol: string): Promise<ApiToken> {
  const response = await page.request.get(`${API_BASE_URL}/api/tokens`);
  expect(response.ok(), 'tokens endpoint must be available').toBe(true);
  const body: { tokens?: ApiTokenEntry[] } = await response.json();
  const tokens = Array.isArray(body.tokens) ? body.tokens : [];
  const match = tokens.find((token) => String(token.symbol || '').toUpperCase() === symbol.toUpperCase());
  expect(typeof match?.tokenId === 'number', `Missing ${symbol} tokenId`).toBe(true);
  const tokenId = Number(match!.tokenId);
  const decimals = Number(match!.decimals);
  expect(Number.isSafeInteger(decimals) && decimals >= 0 && decimals <= 255, `Invalid ${symbol} decimals`).toBe(true);
  return { symbol: symbol.toUpperCase(), tokenId, decimals, scale: 10n ** BigInt(decimals) };
}

const toWsUrl = (baseUrl: string, pathname: string): string => {
  const url = new URL(pathname, baseUrl);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.toString();
};

async function faucetOffchain(
  page: Page,
  entityId: string,
  hubEntityId: string,
  amount = '100',
  tokenId = 1,
): Promise<void> {
  let result: FaucetAttemptResult = { ok: false, status: 0, data: { error: 'not-run' } };

  for (let attempt = 1; attempt <= 15; attempt += 1) {
    const runtimeId = await page.evaluate(() => {
      const view = window as WalletRuntimeView;
      return view.__xln?.adapter()?.runtimeId ?? null;
    });
    if (!runtimeId) {
      result = { ok: false, status: 0, data: { error: 'current wallet adapter runtimeId missing' } };
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
        return { ok: response.status === 200, status: response.status, data: body };
      }, {
        userEntityId: entityId,
        userRuntimeId: runtimeId,
        hubEntityId,
        tokenId,
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
    const transient =
      result.status === 202 ||
      result.status === 409 ||
      code === 'FAUCET_TOKEN_SURFACE_NOT_READY';
    if (!transient || attempt === 15) break;
    await page.waitForTimeout(1000);
  }

  expect(result.ok, `offchain faucet failed: ${JSON.stringify(result.data)}`).toBe(true);
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
      eventNames: ['HtlcReceived', 'HtlcFinalized', 'HtlcFailed'],
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

  const diagnosticResponse = await daemonClient.getFrameReceipts({
    fromHeight: Math.max(1, fromHeight - 8),
    limit: 32,
  }).catch(() => null);
  const diagnosticRecent = (diagnosticResponse?.receipts || [])
    .flatMap((receipt) =>
      receipt.logs.map((log) => {
        const data = log.data || {};
        const entityHint =
          typeof log.entityId === 'string'
            ? log.entityId
            : typeof data.entityId === 'string'
              ? data.entityId
              : '';
        return `${receipt.height}:${log.message}${entityHint ? `@${entityHint.slice(0, 12)}` : ''}`;
      }),
    )
    .slice(-24);

  throw new Error(
    `Timed out waiting for daemon receipt ${options.eventName} on ${targetEntityId.slice(0, 12)} ` +
    `(recent=${recent.join(',') || 'none'}, diagnostic=${diagnosticRecent.join(',') || 'none'})`,
  );
}

async function readOffchainOutboundCapacity(
  page: Page,
  ownerEntityId: string,
  counterpartyEntityId: string,
  tokenId: number,
) {
  return page.evaluate(
    async ({ ownerEntityId, counterpartyEntityId, tokenId }) => {
      const debug = (window as WalletRuntimeView).__xln;
      const adapter = debug?.adapter();
      if (!debug || !adapter) throw new Error('CUSTODY_WALLET_ADAPTER_MISSING');
      const frame = await adapter.read<RuntimeAdapterViewFrame>('view-frame', {
        entityId: ownerEntityId,
        accountsLimit: 100,
      });
      const entity = frame.activeEntity;
      if (!entity || frame.activeEntityId !== ownerEntityId || entity.accounts.nextCursor !== null)
        throw new Error('CUSTODY_WALLET_ACCOUNT_VIEW_INCOMPLETE');
      const accounts = entity.accounts.items.filter(
        account =>
          account.state.leftEntity === counterpartyEntityId || account.state.rightEntity === counterpartyEntityId,
      );
      const [account] = accounts;
      if (accounts.length !== 1 || !account) throw new Error(`CUSTODY_WALLET_ACCOUNT_NOT_UNIQUE:${accounts.length}`);
      const delta = account.state.deltas.get(tokenId);
      if (!delta) throw new Error(`CUSTODY_WALLET_TOKEN_MISSING:${tokenId}`);
      const xln = await debug.xln();
      return {
        height: frame.height,
        accountHeight: account.currentHeight,
        accountRoot: account.currentFrame.accountStateRoot,
        capacity: xln.deriveDelta(delta, xln.isLeftEntity(ownerEntityId, counterpartyEntityId)).outCapacity.toString(),
      };
    },
    { ownerEntityId, counterpartyEntityId, tokenId },
  );
}

async function waitForOffchainOutboundCapacity(
  page: Page,
  ownerEntityId: string,
  counterpartyEntityId: string,
  tokenId: number,
  minimum: bigint,
  timeoutMs = 30_000,
): Promise<void> {
  let lastDebug = '';
  await expect
    .poll(
      async () => {
        const current = await readOffchainOutboundCapacity(page, ownerEntityId, counterpartyEntityId, tokenId);
        lastDebug = JSON.stringify(current);
        return current.capacity;
      },
      {
        timeout: timeoutMs,
        intervals: [500, 750, 1000],
        message: `outbound capacity token=${tokenId} must reach ${minimum.toString()}`,
      },
    )
    .toBe(minimum.toString())
    .catch(error => {
      throw new Error(`${String(error)} committedAccount=${lastDebug}`);
    });
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
    eventNames: ['HtlcReceived', 'HtlcFinalized', 'HtlcFailed'],
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


const readCustodyTokenMinor = (dashboard: CustodyDashboardPayload, tokenId: number): bigint => {
  const row = (dashboard.tokens ?? []).find((token) => Number(token.tokenId || 0) === tokenId);
  return BigInt(String(row?.amountMinor || '0'));
};

async function waitForCustodyTokenBalance(
  page: Page,
  custodyBaseUrl: string,
  tokenId: number,
  expectedMinor: bigint,
): Promise<CustodyDashboardPayload> {
  await expect.poll(
    async () => {
      const dashboard = await readCustodyDashboard(page, custodyBaseUrl);
      const token = dashboard.tokens?.find(row => row.tokenId === tokenId);
      if (!token?.symbol || typeof token.amountDisplay !== 'string') {
        throw new Error(`custody token ${tokenId} display metadata missing`);
      }
      // The browser preflight reads its displayed state, not this independent API read.
      const displayed = await page
        .locator('.token-card')
        .filter({
          has: page.locator('.token-name', { hasText: new RegExp(`^${token.symbol}$`) }),
        })
        .locator('.token-balance')
        .allTextContents();
      return {
        amountMinor: readCustodyTokenMinor(dashboard, tokenId).toString(),
        rendered: displayed.length === 1 && displayed[0]?.trim() === token.amountDisplay,
      };
    },
    {
      timeout: 30_000,
      intervals: [500, 750, 1000],
      message: `custody token ${tokenId} balance must converge to ${expectedMinor.toString()}`,
    },
  ).toEqual({ amountMinor: expectedMinor.toString(), rendered: true });

  return await readCustodyDashboard(page, custodyBaseUrl);
}

async function waitForNewActivity(
  page: Page,
  custodyBaseUrl: string,
  knownIds: Set<string>,
  kind: 'deposit' | 'withdrawal',
  status?: string,
  timeoutMs = 30_000,
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
            tokenId: Number(item.tokenId || 0),
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
      timeout: timeoutMs,
      intervals: [500, 750, 1000],
      message: `custody must record a new ${kind} activity`,
    },
  ).toBe(true);
  return found!;
}

async function waitForActivityStatus(
  page: Page,
  custodyBaseUrl: string,
  activityId: string,
  status: string,
  timeoutMs = 60_000,
): Promise<Required<NonNullable<CustodyDashboardPayload['activity']>[number]>> {
  let found: Required<NonNullable<CustodyDashboardPayload['activity']>[number]> | null = null;
  await expect.poll(
    async () => {
      const dashboard = await readCustodyDashboard(page, custodyBaseUrl);
      const activity = Array.isArray(dashboard.activity) ? dashboard.activity : [];
      const item = activity.find((entry) => String(entry.id || '') === activityId);
      found = item
        ? {
            id: String(item.id || ''),
            kind: String(item.kind || ''),
            tokenId: Number(item.tokenId || 0),
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
      return found?.status || '';
    },
    {
      timeout: timeoutMs,
      intervals: [500, 750, 1000],
      message: `custody activity ${activityId} must reach ${status}`,
    },
  ).toBe(status);
  return found!;
}

test.describe('E2E Custody Flow', () => {
  // Scenario: a new custody daemon joins the existing 3-hub mesh as a separate runtime, receives
  // a journal-backed deposit from a browser wallet, refuses to withdraw before funds exist, and
  // then sends a real HTLC withdrawal using only the custody service's locally credited balance.
  test('separate custody daemon credits deposits and withdraws only from credited offchain balance', { tag: '@functional' }, async ({ browser }) => {
    test.setTimeout(TEST_TIMEOUT_MS);

    const tempRoot = await mkdtemp(join(tmpdir(), 'xln-custody-e2e-'));
    const daemonPort = await getFreePort();
    const custodyPort = await getFreePort();
    let custodyBaseUrl = '';
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
      if (ISOLATED_BASELINE_READY) {
        console.log('[E2E-TIMING] custody.ensure_baseline.skip 0ms');
      } else {
        await timedStep('custody.ensure_baseline', () => ensureE2EBaseline(walletPage, {
          apiBaseUrl: API_BASE_URL,
          timeoutMs: TEST_TIMEOUT_MS,
          requireHubMesh: true,
          requireMarketMaker: false,
          minHubCount: 3,
        }));
      }

      const custodyJurisdictionId = await timedStep(
        'custody.resolve_jurisdiction',
        resolvePrimaryCustodyJurisdictionId,
      );
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
        jurisdictionId: custodyJurisdictionId,
      }));
      daemonChild = custodySupport.daemonChild;
      custodyChild = custodySupport.custodyChild;
      custodyBaseUrl = custodySupport.custodyBaseUrl;
      daemonClient = new DaemonRpcClient(`ws://127.0.0.1:${daemonPort}/rpc`, custodySupport.daemonAuthKey);
      const custodyIdentity = custodySupport.identity;
      const senderHubIds = custodySupport.hubIds.slice(0, 2);
      const fundingHubId = senderHubIds[1] ?? senderHubIds[0]!;

      await timedStep('custody.wallet.goto_app', () => gotoApp(walletPage));
      const alice = await timedStep('custody.wallet.create_runtime', () =>
        createWalletIdentity(walletPage, 'alice', selectDemoMnemonic('alice')),
      );
      const usdcToken = await timedStep('custody.wallet.read_usdc_token', () => getApiToken(walletPage, 'USDC'));
      const usdtToken = await timedStep('custody.wallet.read_usdt_token', () => getApiToken(walletPage, 'USDT'));
      const usdtTokenId = usdtToken.tokenId;
      for (const [index, hubId] of senderHubIds.entries()) {
        await timedStep(
          `custody.wallet.connect_hub_${index + 1}`,
          () => connectRuntimeToHubWithCredit(walletPage, alice, hubId, '10000', [1, usdtTokenId]),
        );
      }
      const walletRenderedBeforeFunding = await timedStep(
        'custody.wallet.read_rendered_out_before_faucet',
        () => getRenderedOutboundForAccount(walletPage, fundingHubId),
      );
      await timedStep('custody.wallet.faucet.usdc', () => faucetOffchain(walletPage, alice.entityId, fundingHubId, '100', 1));
      await timedStep('custody.wallet.faucet.usdt', () => faucetOffchain(walletPage, alice.entityId, fundingHubId, '30', usdtTokenId));
      await timedStep(
        'custody.wallet.wait_rendered_out_after_faucet',
        () => waitForRenderedOutboundForAccountDelta(
          walletPage,
          fundingHubId,
          walletRenderedBeforeFunding,
          100,
          { timeoutMs: 20_000 },
        ),
      );
      await timedStep(
        'custody.wallet.wait_usdt_out_after_faucet',
        () => waitForOffchainOutboundCapacity(walletPage, alice.entityId, fundingHubId, usdtTokenId, 30n * usdtToken.scale, 20_000),
      );
      await timedStep('custody.open_dashboard', () => custodyPage.goto(custodyBaseUrl));
      await expect(custodyPage.getByRole('heading', { name: 'Deposit' })).toBeVisible({ timeout: 15_000 });
      await expect(custodyPage.locator('.deposit-qr-image').first()).toBeVisible({ timeout: 60_000 });
      await expect(custodyPage.getByRole('button', { name: /^Local Wallet$/i })).toBeVisible({ timeout: 60_000 });
      await custodyPage.screenshot({ path: test.info().outputPath('custody-dashboard-initial.png'), fullPage: true });

      let browserWithdrawalRequests = 0;
      custodyPage.on('request', (request) => {
        if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/withdraw') {
          browserWithdrawalRequests += 1;
        }
      });
      await custodyPage.locator('input[name="amount"]').fill('1');
      await custodyPage.locator('input[name="targetEntityId"]').fill(alice.entityId);
      await custodyPage.getByRole('button', { name: /^Withdraw$/i }).click();
      await expect(custodyPage.getByText('Insufficient custody balance')).toBeVisible({ timeout: 15_000 });
      expect(browserWithdrawalRequests, 'displayed zero balance must reject before browser POST').toBe(0);

      // Send this the way the dashboard would. Without same-origin headers the
      // custody CSRF guard rejects the mutation before any balance check, and
      // the assertion below would pass on the wrong gate.
      const directWithdrawal = await context.request.post(`${custodyBaseUrl}/api/withdraw`, {
        headers: {
          origin: new URL(custodyBaseUrl).origin,
          'sec-fetch-site': 'same-origin',
          'content-type': 'application/json',
        },
        data: {
          tokenId: usdcToken.tokenId,
          amount: '1',
          targetEntityId: alice.entityId,
        },
      });
      expect(directWithdrawal.status(), 'server remains the authoritative fail-closed balance gate').toBe(400);
      expect(await directWithdrawal.json()).toMatchObject({
        ok: false,
        error: 'Insufficient custody balance',
      });

      let dashboard = await readCustodyDashboard(custodyPage, custodyBaseUrl);
      const custodyBalances = new Map<number, bigint>();
      for (const token of dashboard.tokens ?? []) {
        const tokenId = Number(token.tokenId || 0);
        if (tokenId > 0) {
          custodyBalances.set(tokenId, BigInt(String(token.amountMinor || '0')));
        }
      }
      const financialProof: Array<Record<string, string | number>> = [];
      const depositCycles = [
        { whole: 3n, tokenId: usdcToken.tokenId, scale: usdcToken.scale },
        { whole: 10n, tokenId: usdtTokenId, scale: usdtToken.scale },
      ];

      for (const [cycleIndex, cycle] of depositCycles.entries()) {
        const knownBeforeDeposit = new Set(
          (dashboard.activity ?? [])
            .map(item => String(item.id || ''))
            .filter(Boolean),
        );
        const daemonReceiptCursorBeforeDeposit = daemonClient
          ? await getDaemonReceiptCursor(daemonClient, custodyIdentity.entityId)
          : 1;

        await timedStep(`custody.deposit_cycle_${cycleIndex + 1}`, async () => {
          await custodyPage.locator('select[name="depositTokenId"]').selectOption(String(cycle.tokenId));
          await custodyPage.locator('input[name="depositAmount"]').fill(cycle.whole.toString());
          const invoice = (await custodyPage.locator('.deposit-invoice-string').first().textContent())?.trim() || '';
          const walletHref = (await custodyPage.locator('[data-open-wallet-href]').first().getAttribute('data-open-wallet-href'))?.trim() || '';
          expect(invoice).toMatch(/^0x[0-9a-f]{64}(?:\?|$)/i);
          expect(walletHref).toContain('/app#pay/');
          const params = new URLSearchParams(invoice.slice(invoice.indexOf('?') + 1));
          expect(invoice.startsWith(custodyIdentity.entityId)).toBe(true);
          expect(params.get('token')).toBe(String(cycle.tokenId));
          expect(params.get('amount')).toBe(cycle.whole.toString());
          // The public link intentionally targets xln.finance. The isolated chain's
          // funds stay in its local wallet; exercise the original invoice-paste flow.
          const publicWallet = new URL(walletHref);
          expect(publicWallet.origin).toBe('https://xln.finance');
          expect(publicWallet.pathname).toBe('/app');
          expect(decodeURIComponent(publicWallet.hash.slice('#pay/'.length))).toBe(invoice);
          if (cycleIndex === 1) {
            const copyButton = custodyPage.locator('[data-copy-invoice]').first();
            await copyButton.click();
            await expect(copyButton).toHaveText(/^Copied$/i, { timeout: 5_000 });
          }
          await walletPage.bringToFront();
          await openPayWorkspace(walletPage);
          await walletPage.getByTestId('pay-to').fill(invoice);
          await expect(walletPage.getByTestId('pay-to')).toHaveValue(custodyIdentity.entityId);
          const restoredId = await walletPage.evaluate(() => (window as WalletRuntimeView).__xln?.adapter()?.runtimeId);
          expect(restoredId).toBe(alice.runtimeId);
          await expect(walletPage.getByTestId('pay-amount')).toHaveValue(cycle.whole.toString());
          await waitForReceiveReadyGossipProfiles(
            walletPage,
            [alice.entityId, fundingHubId, custodyIdentity.entityId],
            fundingHubId,
          );
          await chooseVisibleRoute(walletPage, [fundingHubId, custodyIdentity.entityId]);
          await expect(walletPage.getByTestId('pay-quote')).toHaveAttribute(
            'data-recipient-amount',
            (cycle.whole * cycle.scale).toString(),
          );
          await expect(walletPage.getByTestId('pay-submit')).toBeEnabled();
          await walletPage.getByTestId('pay-submit').click();
        });
        if (daemonClient) {
          const receiptClient = daemonClient;
          await timedStep(`custody.deposit_cycle_${cycleIndex + 1}.wait_receipt`, () =>
            waitForDaemonReceiptEvent(receiptClient, {
              entityId: custodyIdentity.entityId,
              eventName: 'HtlcReceived',
              fromHeight: daemonReceiptCursorBeforeDeposit,
            }),
          );
        }

        const depositMinor = cycle.whole * cycle.scale;
        const currentTokenBalance = custodyBalances.get(cycle.tokenId) ?? 0n;
        custodyBalances.set(cycle.tokenId, currentTokenBalance + depositMinor);
        await custodyPage.bringToFront();
        const depositActivity = await timedStep(`custody.deposit_cycle_${cycleIndex + 1}.wait_credit`, async () => {
          dashboard = await waitForCustodyTokenBalance(
            custodyPage,
            custodyBaseUrl,
            cycle.tokenId,
            custodyBalances.get(cycle.tokenId) ?? 0n,
          );
          return waitForNewActivity(custodyPage, custodyBaseUrl, knownBeforeDeposit, 'deposit');
        });
        expect(BigInt(depositActivity.amountMinor)).toBe(depositMinor);
        expect(Number(depositActivity.tokenId)).toBe(cycle.tokenId);
        expect(dashboard.custody?.lastSyncError ?? null).toBeNull();
        financialProof.push({
          kind: 'deposit',
          tokenId: cycle.tokenId,
          amountMinor: depositActivity.amountMinor,
          creditedBalanceMinor: readCustodyTokenMinor(dashboard, cycle.tokenId).toString(),
        });
      }

      const withdrawCycles = [
        { whole: 2n, tokenId: usdcToken.tokenId, scale: usdcToken.scale },
        { whole: 4n, tokenId: usdtTokenId, scale: usdtToken.scale },
      ];
      for (const [cycleIndex, cycle] of withdrawCycles.entries()) {
        await walletPage.bringToFront();
        await ensureRuntimeOnline(walletPage, `alice-before-withdraw-cycle-${cycleIndex + 1}`);

        const knownBeforeWithdraw = new Set(
          (dashboard.activity ?? [])
            .map(item => String(item.id || ''))
            .filter(Boolean),
        );
        await custodyPage.locator('select[name="tokenId"]').selectOption(String(cycle.tokenId));
        await custodyPage.locator('input[name="amount"]').fill(cycle.whole.toString());
        await custodyPage.locator('input[name="targetEntityId"]').fill(alice.entityId);

        const withdrawalActivity = await timedStep(`custody.withdraw_cycle_${cycleIndex + 1}`, async () => {
          await custodyPage.getByRole('button', { name: /^Withdraw$/i }).click();
          await custodyPage.bringToFront();
          return waitForNewActivity(
            custodyPage,
            custodyBaseUrl,
            knownBeforeWithdraw,
            'withdrawal',
            undefined,
            20_000,
          );
        });
        expect(browserWithdrawalRequests, 'each funded withdrawal submits exactly once').toBe(cycleIndex + 1);
        const finalizedWithdrawal = await timedStep(
          `custody.withdraw_cycle_${cycleIndex + 1}.wait_finalized`,
          () => waitForActivityStatus(custodyPage, custodyBaseUrl, withdrawalActivity.id, 'finalized', 90_000),
        );
        expect(BigInt(finalizedWithdrawal.requestedAmountMinor)).toBe(cycle.whole * cycle.scale);
        expect(Number(finalizedWithdrawal.tokenId)).toBe(cycle.tokenId);
        expect(BigInt(finalizedWithdrawal.feeMinor)).toBeGreaterThan(0n);

        const senderSpentMinor = BigInt(finalizedWithdrawal.amountMinor);
        custodyBalances.set(cycle.tokenId, (custodyBalances.get(cycle.tokenId) ?? 0n) - senderSpentMinor);
        dashboard = await timedStep(
          `custody.withdraw_cycle_${cycleIndex + 1}.wait_debit`,
          () => waitForCustodyTokenBalance(
            custodyPage,
            custodyBaseUrl,
            cycle.tokenId,
            custodyBalances.get(cycle.tokenId) ?? 0n,
          ),
        );
        financialProof.push({
          kind: 'withdrawal',
          tokenId: cycle.tokenId,
          requestedAmountMinor: finalizedWithdrawal.requestedAmountMinor,
          senderSpentMinor: finalizedWithdrawal.amountMinor,
          feeMinor: finalizedWithdrawal.feeMinor,
          creditedBalanceMinor: readCustodyTokenMinor(dashboard, cycle.tokenId).toString(),
        });
      }
      await test.info().attach('custody-financial-proof', {
        body: JSON.stringify(financialProof, null, 2),
        contentType: 'application/json',
      });
    } finally {
      await closeRuntimeContext(context);
      await daemonClient?.close();
      await stopManagedChild(custodyChild);
      await stopManagedChild(daemonChild);
      await rm(tempRoot, { recursive: true, force: true });
    }
  });
});
