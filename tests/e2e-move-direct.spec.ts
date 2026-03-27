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
const ERC20_TRANSFER = new Interface([
  'function transfer(address to, uint256 amount) returns (bool)',
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

async function waitForRpcReceipt(page: Page, txHash: string, timeoutMs = ROUTE_TIMEOUT_MS): Promise<void> {
  await expect
    .poll(async () => {
      const receipt = await rpcCall<Record<string, unknown> | null>(page, 'eth_getTransactionReceipt', [txHash]);
      return receipt !== null;
    }, { timeout: timeoutMs })
    .toBe(true);
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

async function seedExternalWallet(page: Page, recipient: string, symbol: string, amount: string): Promise<void> {
  const tokens = await getApiTokens(page);
  const token = tokens.find((entry) => String(entry.symbol || '').toUpperCase() === symbol.toUpperCase());
  expect(token?.address, `Missing ${symbol} token address`).toBeTruthy();
  const decimals = typeof token?.decimals === 'number' ? token.decimals : 18;
  const accounts = await rpcCall<string[]>(page, 'eth_accounts', []);
  const source = String(accounts[0] || '').trim();
  expect(source.length, 'Missing unlocked RPC source account').toBeGreaterThan(0);

  const gasTopupTx = await rpcCall<string>(page, 'eth_sendTransaction', [{
    from: source,
    to: recipient,
    value: `0x${parseUnits('0.1', 18).toString(16)}`,
  }]);
  await waitForRpcReceipt(page, gasTopupTx);

  const tokenTx = await rpcCall<string>(page, 'eth_sendTransaction', [{
    from: source,
    to: token!.address,
    data: ERC20_TRANSFER.encodeFunctionData('transfer', [recipient, parseUnits(amount, decimals)]),
  }]);
  await waitForRpcReceipt(page, tokenTx);
}

async function refreshExternalBalance(page: Page, symbol: string): Promise<number> {
  await openAssetsTab(page);
  await page.getByTestId('asset-ledger-refresh').first().click();
  return getRenderedExternalBalance(page, symbol);
}

test('move external to external sends directly from signer wallet', async ({ page }) => {
  test.setTimeout(LONG_E2E ? 180_000 : 120_000);

  await timedStep('move-direct.baseline', async () => {
    await ensureE2EBaseline(page, {
      timeoutMs: LONG_E2E ? 240_000 : 120_000,
      requireHubMesh: true,
      requireMarketMaker: false,
      minHubCount: 3,
      forceReset: true,
    });
  });

  let alice: { entityId: string; signerId: string; runtimeId: string } | null = null;
  await timedStep('move-direct.runtime', async () => {
    await gotoApp(page, { appBaseUrl: APP_BASE_URL, initTimeoutMs: 60_000, settleMs: 500 });
    await page.evaluate((apiBaseUrl: string) => {
      (window as typeof window & { __XLN_API_BASE_URL__?: string }).__XLN_API_BASE_URL__ = apiBaseUrl;
      localStorage.setItem('xln-api-base-url', apiBaseUrl);
    }, API_BASE_URL);
    alice = await createRuntimeIdentity(page, 'alice', selectDemoMnemonic('alice'));
    await switchToRuntimeId(page, alice.runtimeId);
  });

  const symbol = 'USDC';
  const aliceEoa = String(alice!.signerId || '').trim();
  const bobSignerId = deriveSignerAddressFromMnemonic(selectDemoMnemonic('bob'));
  await seedExternalWallet(page, aliceEoa, symbol, '20');
  await expect.poll(async () => refreshExternalBalance(page, symbol), { timeout: ROUTE_TIMEOUT_MS }).toBeGreaterThan(0);

  const aliceBeforeRaw = await getRpcExternalBalanceRaw(page, symbol, aliceEoa);
  const bobBeforeRaw = await getRpcExternalBalanceRaw(page, symbol, bobSignerId);
  const aliceBefore = await getRpcExternalBalance(page, symbol, aliceEoa);
  const bobBefore = await getRpcExternalBalance(page, symbol, bobSignerId);

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
  });
  const aliceAfter = await getRpcExternalBalance(page, symbol, aliceEoa);
  const bobAfter = await getRpcExternalBalance(page, symbol, bobSignerId);
  logBalanceDelta('move.direct-e2e', { beforeSender: aliceBefore, afterSender: aliceAfter, beforeRecipient: bobBefore, afterRecipient: bobAfter });
});
