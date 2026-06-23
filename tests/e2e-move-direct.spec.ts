import { expect, test, type Page } from '@playwright/test';
import { Interface, formatUnits, parseUnits } from 'ethers';
import { ensureE2EBaseline, API_BASE_URL, APP_BASE_URL } from './utils/e2e-baseline';
import {
  createRuntimeIdentity,
  deriveSignerAddressFromMnemonic,
  gotoApp,
  selectDemoMnemonic,
  switchToRuntimeId,
} from './utils/e2e-demo-users';
import { getRenderedExternalBalance } from './utils/e2e-account-ui';
import { timedStep } from './utils/e2e-timing';

const LONG_E2E = process.env.E2E_LONG === '1';
const ROUTE_TIMEOUT_MS = LONG_E2E ? 90_000 : 60_000;

type ApiTokenEntry = {
  address?: string;
  symbol?: string;
  decimals?: number;
};

const ERC20_BALANCE_OF = new Interface([
  'function balanceOf(address owner) view returns (uint256)',
]);
async function timedMillis<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const started = process.hrtime.bigint();
  try {
    return await fn();
  } finally {
    const elapsedMillis = Number(process.hrtime.bigint() - started) / 1_000_000;
    console.log(`[E2E-TIMING-MS] ${label} ${elapsedMillis.toFixed(3)}ms`);
  }
}

function logBalanceDelta(
  label: string,
  input: {
    beforeSender?: number;
    afterSender?: number;
    beforeRecipient?: number;
    afterRecipient?: number;
  },
): void {
  console.log(
    `[E2E-BALANCE] ${label} ` +
      `sender=${input.beforeSender ?? 'n/a'}->${input.afterSender ?? 'n/a'} ` +
      `recipient=${input.beforeRecipient ?? 'n/a'}->${input.afterRecipient ?? 'n/a'}`
  );
}

async function openAssetsTab(page: Page): Promise<void> {
  const tab = page.getByTestId('tab-assets').first();
  await expect(tab).toBeVisible({ timeout: 20_000 });
  await tab.click();
  await expect(page.getByTestId('asset-ledger-refresh').first()).toBeVisible({ timeout: 20_000 });
}

async function openMoveTab(page: Page): Promise<void> {
  await openAssetsTab(page);
  await page.getByTestId('asset-tab-move').first().click();
  await expect(page.getByTestId('move-route-summary').first()).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId('move-committed-line').first()).toBeVisible({ timeout: 20_000 });
}

async function waitForMoveReady(page: Page): Promise<void> {
  const confirm = page.getByTestId('move-confirm').first();
  await expect
    .poll(async () => {
      if (!(await confirm.isDisabled())) return 'enabled';
      const statuses = await page.getByTestId('move-status').allTextContents().catch(() => []);
      const text = statuses.map((entry) => String(entry || '').trim()).filter(Boolean).join(' | ');
      return text || 'disabled';
    }, { timeout: 10_000 })
    .toBe('enabled');
}

async function chooseMoveRoute(
  page: Page,
  from: 'external' | 'reserve' | 'account',
  to: 'external' | 'reserve' | 'account',
): Promise<void> {
  await page.getByTestId(`move-source-${from}`).first().click();
  await page.getByTestId(`move-target-${to}`).first().click();
}

async function getApiTokens(page: Page): Promise<ApiTokenEntry[]> {
  const tokensResponse = await page.request.get(`${API_BASE_URL}/api/tokens`);
  expect(tokensResponse.ok()).toBe(true);
  const body = await tokensResponse.json().catch(() => ({}));
  return Array.isArray(body?.tokens) ? body.tokens as ApiTokenEntry[] : [];
}

async function rpcCall<T>(page: Page, method: string, params: unknown[]): Promise<T> {
  const response = await page.request.post(`${API_BASE_URL}/rpc`, {
    data: {
      jsonrpc: '2.0',
      id: 1,
      method,
      params,
    },
  });
  expect(response.ok()).toBe(true);
  const body = await response.json().catch(() => ({}));
  if (body?.error) throw new Error(`${method} failed: ${JSON.stringify(body.error)}`);
  return body?.result as T;
}

async function getRpcExternalBalanceRaw(page: Page, symbol: string, holder: string): Promise<bigint> {
  const tokens = await getApiTokens(page);
  const token = tokens.find((entry) => String(entry.symbol || '').toUpperCase() === symbol.toUpperCase());
  expect(token?.address, `Missing ${symbol} token address`).toBeTruthy();
  const raw = await rpcCall<string>(page, 'eth_call', [
    {
      to: token!.address,
      data: ERC20_BALANCE_OF.encodeFunctionData('balanceOf', [holder]),
    },
    'latest',
  ]);
  return BigInt(raw || '0x0');
}

async function getRpcExternalBalance(page: Page, symbol: string, holder: string): Promise<number> {
  const tokens = await getApiTokens(page);
  const token = tokens.find((entry) => String(entry.symbol || '').toUpperCase() === symbol.toUpperCase());
  expect(token?.address, `Missing ${symbol} token address`).toBeTruthy();
  const decimals = typeof token?.decimals === 'number' ? token.decimals : 18;
  return Number(formatUnits(await getRpcExternalBalanceRaw(page, symbol, holder), decimals));
}

async function readBrowserExternalWalletDebug(page: Page, symbol: string, holder: string): Promise<Record<string, unknown>> {
  const tokens = await getApiTokens(page);
  const token = tokens.find((entry) => String(entry.symbol || '').toUpperCase() === symbol.toUpperCase());
  const tokenAddress = String(token?.address || '').trim().toLowerCase();
  const owner = String(holder || '').trim().toLowerCase();
  return page.evaluate(({ owner, tokenAddress }) => {
    const env = (window as typeof window & { __xln_env?: any }).__xln_env;
    const mapEntries = (value: unknown): Array<[unknown, unknown]> => {
      if (value instanceof Map) return [...value.entries()];
      if (value && typeof value === 'object') return Object.entries(value as Record<string, unknown>);
      return [];
    };
    const replicas = mapEntries(env?.eReplicas).map(([key, replica]: [unknown, any]) => {
      const wallet = replica?.state?.externalWallet;
      const balances = wallet?.balances instanceof Map ? wallet.balances.get(owner) : undefined;
      const tokenRecord = balances instanceof Map ? balances.get(tokenAddress) : undefined;
      const nativeRecord = balances instanceof Map ? balances.get('0x0000000000000000000000000000000000000000') : undefined;
      return {
        key: String(key),
        entityId: String(replica?.state?.entityId || replica?.entityId || ''),
        tokenBalance: tokenRecord ? String(tokenRecord.balance) : null,
        tokenHeight: tokenRecord ? Number(tokenRecord.jHeight || 0) : null,
        nativeBalance: nativeRecord ? String(nativeRecord.balance) : null,
      };
    });
    const watchOwners = mapEntries(env?.runtimeState?.externalWalletWatchOwners).map(([entityId, owners]) => ({
      entityId: String(entityId),
      owners: mapEntries(owners).map(([trackedOwner, block]) => ({
        owner: String(trackedOwner),
        block: Number(block || 0),
      })),
    }));
    const jReplicas = mapEntries(env?.jReplicas).map(([key, replica]: [unknown, any]) => ({
      key: String(key),
      blockNumber: Number(replica?.blockNumber || 0),
      hasAdapter: Boolean(replica?.jAdapter),
      adapterMode: String(replica?.jAdapter?.mode || ''),
    }));
    return {
      runtimeId: String(env?.runtimeId || ''),
      height: Number(env?.height || 0),
      loopActive: Boolean(env?.runtimeState?.loopActive),
      queuedEntityInputs: Number(env?.runtimeMempool?.entityInputs?.length || 0),
      processing: Boolean(env?.runtimeState?.processingPromise),
      watchOwners,
      jReplicas,
      replicas,
    };
  }, { owner, tokenAddress });
}

async function seedExternalWallet(page: Page, recipient: string, symbol: string, amount: string): Promise<void> {
  const tokens = await getApiTokens(page);
  const token = tokens.find((entry) => String(entry.symbol || '').toUpperCase() === symbol.toUpperCase());
  expect(token?.address, `Missing ${symbol} token address`).toBeTruthy();
  const decimals = typeof token?.decimals === 'number' ? token.decimals : 18;
  const beforeRaw = await getRpcExternalBalanceRaw(page, symbol, recipient);
  const faucetResponse = await page.request.post(`${API_BASE_URL}/api/faucet/erc20`, {
    data: { userAddress: recipient, tokenSymbol: symbol, amount },
  });
  const body = await faucetResponse.json().catch(() => ({}));
  expect(faucetResponse.ok(), `ERC20 faucet failed: ${JSON.stringify(body)}`).toBe(true);
  expect(body?.success, `ERC20 faucet failed: ${JSON.stringify(body)}`).toBe(true);
  const expectedRaw = beforeRaw + parseUnits(amount, decimals);
  await expect.poll(async () => getRpcExternalBalanceRaw(page, symbol, recipient), {
    timeout: ROUTE_TIMEOUT_MS,
  })
    .toBeGreaterThanOrEqual(expectedRaw);
}

async function refreshExternalBalance(page: Page, symbol: string): Promise<number> {
  await openAssetsTab(page);
  await page.getByTestId('asset-ledger-refresh').first().click();
  return getRenderedExternalBalance(page, symbol);
}

test('move external to external sends directly from signer wallet', async ({ page }) => {
  test.setTimeout(LONG_E2E ? 180_000 : 180_000);

  await timedStep('move-direct.baseline', async () => {
    await ensureE2EBaseline(page, {
      timeoutMs: LONG_E2E ? 240_000 : 180_000,
      requireHubMesh: true,
      requireMarketMaker: false,
      minHubCount: 3,
    });
  });

  let alice: { entityId: string; signerId: string; runtimeId: string } | null = null;
  let bob: { entityId: string; signerId: string; runtimeId: string } | null = null;
  const browser = page.context().browser();
  expect(browser, 'browser must be available for isolated Bob context').toBeTruthy();
  const bobContext = await browser!.newContext();
  const bobPage = await bobContext.newPage();
  await timedStep('move-direct.runtime', async () => {
    await gotoApp(page, { appBaseUrl: APP_BASE_URL, initTimeoutMs: 60_000, settleMs: 500 });
    await page.evaluate((apiBaseUrl: string) => {
      (window as typeof window & { __XLN_API_BASE_URL__?: string }).__XLN_API_BASE_URL__ = apiBaseUrl;
      localStorage.setItem('xln-api-base-url', apiBaseUrl);
    }, API_BASE_URL);
    alice = await createRuntimeIdentity(page, 'alice', selectDemoMnemonic('alice'));
    await switchToRuntimeId(page, alice.runtimeId);

    await gotoApp(bobPage, { appBaseUrl: APP_BASE_URL, initTimeoutMs: 60_000, settleMs: 500 });
    await bobPage.evaluate((apiBaseUrl: string) => {
      (window as typeof window & { __XLN_API_BASE_URL__?: string }).__XLN_API_BASE_URL__ = apiBaseUrl;
      localStorage.setItem('xln-api-base-url', apiBaseUrl);
    }, API_BASE_URL);
    bob = await createRuntimeIdentity(bobPage, 'bob', selectDemoMnemonic('bob'));
    await switchToRuntimeId(bobPage, bob.runtimeId);
  });

  const symbol = 'USDC';
  const aliceEoa = String(alice!.signerId || '').trim();
  const bobSignerId = String(bob!.signerId || deriveSignerAddressFromMnemonic(selectDemoMnemonic('bob'))).trim();
  await openAssetsTab(page);
  await page.getByTestId('asset-ledger-refresh').first().click();
  const aliceSeedBaseline = await getRenderedExternalBalance(page, symbol);
  await seedExternalWallet(page, aliceEoa, symbol, '20');
  try {
    await expect.poll(async () => getRenderedExternalBalance(page, symbol), { timeout: ROUTE_TIMEOUT_MS }).toBeGreaterThan(aliceSeedBaseline);
  } catch (error) {
    console.log('[move-direct external-wallet debug]', JSON.stringify(await readBrowserExternalWalletDebug(page, symbol, aliceEoa), null, 2));
    throw error;
  }
  await openAssetsTab(bobPage);
  await bobPage.getByTestId('asset-ledger-refresh').first().click();

  const aliceBeforeRaw = await getRpcExternalBalanceRaw(page, symbol, aliceEoa);
  const bobBeforeRaw = await getRpcExternalBalanceRaw(page, symbol, bobSignerId);
  const aliceBefore = await getRpcExternalBalance(page, symbol, aliceEoa);
  const bobBefore = await getRpcExternalBalance(page, symbol, bobSignerId);
  const aliceBeforeRendered = await getRenderedExternalBalance(page, symbol);
  const bobBeforeRendered = await getRenderedExternalBalance(bobPage, symbol);

  await timedMillis('move.direct-e2e', async () => {
    await openMoveTab(page);
    await page.getByTestId('move-asset-symbol').selectOption(symbol);
    await page.getByTestId('move-amount').fill('1');
    await chooseMoveRoute(page, 'external', 'external');
    await page.getByTestId('move-external-recipient').fill(bobSignerId);
    await waitForMoveReady(page);
    await page.getByTestId('move-confirm').first().click();

    await expect.poll(async () => getRpcExternalBalanceRaw(page, symbol, aliceEoa), { timeout: ROUTE_TIMEOUT_MS }).toBeLessThan(aliceBeforeRaw);
    await expect.poll(async () => getRpcExternalBalanceRaw(page, symbol, bobSignerId), { timeout: ROUTE_TIMEOUT_MS }).toBeGreaterThan(bobBeforeRaw);
    await expect.poll(async () => getRenderedExternalBalance(page, symbol), { timeout: ROUTE_TIMEOUT_MS }).toBeLessThan(aliceBeforeRendered);
    await expect.poll(async () => getRenderedExternalBalance(bobPage, symbol), { timeout: ROUTE_TIMEOUT_MS }).toBeGreaterThan(bobBeforeRendered);
  });
  const aliceAfter = await getRpcExternalBalance(page, symbol, aliceEoa);
  const bobAfter = await getRpcExternalBalance(page, symbol, bobSignerId);
  logBalanceDelta('move.direct-e2e', { beforeSender: aliceBefore, afterSender: aliceAfter, beforeRecipient: bobBefore, afterRecipient: bobAfter });
  await bobContext.close();
});
