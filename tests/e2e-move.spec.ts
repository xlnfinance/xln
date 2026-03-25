import { expect, test, type Page } from '@playwright/test';
import { Interface, Wallet, formatUnits, parseUnits } from 'ethers';
import { ensureE2EBaseline, API_BASE_URL, APP_BASE_URL, waitForNamedHubs } from './utils/e2e-baseline';
import { createRuntimeIdentity, gotoApp, selectDemoMnemonic, switchToRuntimeId } from './utils/e2e-demo-users';
import { connectRuntimeToHub } from './utils/e2e-connect';
import {
  getRenderedAccountSpendableBalance,
  getRenderedExternalBalance,
  getRenderedReserveBalance,
} from './utils/e2e-account-ui';
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

async function selectAssetFaucetToken(page: Page, symbol: string): Promise<void> {
  await openAssetsTab(page);
  const select = page.getByTestId('asset-faucet-symbol').first();
  await expect(select).toBeVisible({ timeout: 20_000 });
  await select.selectOption(symbol);
  await expect(select).toHaveValue(symbol, { timeout: 20_000 });
}

async function expectFaucetModes(
  page: Page,
  symbol: string,
  expected: {
    reserveVisible: boolean;
    reserveEnabled: boolean;
    accountVisible: boolean;
  },
): Promise<void> {
  await selectAssetFaucetToken(page, symbol);
  const externalButton = page.getByTestId(`external-faucet-${symbol}`).first();
  const reserveButton = page.getByTestId(`reserve-faucet-${symbol}`).first();
  const accountButton = page.getByTestId(`account-faucet-${symbol}`).first();

  await expect(externalButton).toBeVisible({ timeout: 20_000 });
  await expect(externalButton).toBeEnabled({ timeout: 20_000 });
  if (expected.reserveVisible) {
    await expect(reserveButton).toBeVisible({ timeout: 20_000 });
  } else {
    await expect(reserveButton).toHaveCount(0);
  }
  if (expected.reserveVisible && expected.reserveEnabled) {
    await expect(reserveButton).toBeEnabled({ timeout: 20_000 });
  } else if (expected.reserveVisible) {
    await expect(reserveButton).toBeDisabled({ timeout: 20_000 });
  }

  if (expected.accountVisible) {
    await expect(accountButton).toBeVisible({ timeout: 20_000 });
    await expect(accountButton).toBeEnabled({ timeout: 20_000 });
  } else {
    await expect(accountButton).toHaveCount(0);
  }
}

async function clickExternalFaucet(page: Page, symbol: string): Promise<void> {
  await selectAssetFaucetToken(page, symbol);
  await page.getByTestId(`external-faucet-${symbol}`).first().click();
}

async function clickReserveFaucet(page: Page, symbol: string): Promise<void> {
  await selectAssetFaucetToken(page, symbol);
  const button = page.getByTestId(`reserve-faucet-${symbol}`).first();
  await expect(button).toBeEnabled({ timeout: 20_000 });
  await button.click();
}

async function clickAccountFaucet(page: Page, symbol: string): Promise<void> {
  await selectAssetFaucetToken(page, symbol);
  const button = page.getByTestId(`account-faucet-${symbol}`).first();
  await expect(button).toBeVisible({ timeout: 20_000 });
  await expect(button).toBeEnabled({ timeout: 20_000 });
  await button.click();
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
      const error = await page.locator('.move-summary-progress.error').first().textContent().catch(() => '');
      return String(error || 'disabled').trim() || 'disabled';
    }, { timeout: 10_000 })
    .toBe('enabled');
}

async function broadcastDraftBatch(page: Page): Promise<void> {
  const broadcast = page.getByTestId('settle-sign-broadcast').first();
  await expect(broadcast).toBeVisible({ timeout: 20_000 });
  await expect(broadcast).toBeEnabled({ timeout: 20_000 });
  await broadcast.click();
}

async function chooseMoveRoute(
  page: Page,
  from: 'external' | 'reserve' | 'account',
  to: 'external' | 'reserve' | 'account',
  order: 'source-first' | 'target-first' = 'source-first',
): Promise<void> {
  const source = page.getByTestId(`move-source-${from}`).first();
  const target = page.getByTestId(`move-target-${to}`).first();
  if (order === 'target-first') {
    await target.click();
    await source.click();
    return;
  }
  await source.click();
  await target.click();
}

async function selectMoveEntityField(page: Page, testId: string, optionText: string): Promise<void> {
  const field = page.getByTestId(testId).first();
  await expect(field).toBeVisible({ timeout: 20_000 });
  const picker = field.locator('[data-testid$="-picker"], .entity-input').first();
  const trigger = picker.locator('.closed-trigger, input').first();
  await trigger.click();
  const option = picker.getByTestId(/-option-/).filter({ hasText: optionText }).first();
  await expect(option).toBeVisible({ timeout: 20_000 });
  await option.dispatchEvent('mousedown');
}

async function waitForRecipientCounterpartyProfile(
  page: Page,
  recipientEntityId: string,
  counterpartyEntityId: string,
): Promise<void> {
  const recipient = recipientEntityId.toLowerCase();
  const counterparty = counterpartyEntityId.toLowerCase();
  await expect
    .poll(async () => page.evaluate(({ recipient, counterparty }) => {
      const env = (window as typeof window & {
        isolatedEnv?: {
          gossip?: {
            getProfiles?: () => Array<{
              entityId?: string;
              accounts?: Array<{ counterpartyId?: string }>;
            }>;
          };
        };
      }).isolatedEnv;
      const profiles = env?.gossip?.getProfiles?.() || [];
      const profile = profiles.find((item) => String(item?.entityId || '').toLowerCase() === recipient);
      return Array.isArray(profile?.accounts)
        && profile.accounts.some((account) => String(account?.counterpartyId || '').toLowerCase() === counterparty);
    }, { recipient, counterparty }), { timeout: ROUTE_TIMEOUT_MS })
    .toBe(true);
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

async function waitForRpcReceipt(page: Page, txHash: string, timeoutMs = ROUTE_TIMEOUT_MS): Promise<void> {
  await expect
    .poll(async () => {
      const receipt = await rpcCall<Record<string, unknown> | null>(page, 'eth_getTransactionReceipt', [txHash]);
      return receipt !== null;
    }, { timeout: timeoutMs })
    .toBe(true);
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

async function getVisibleEoaAddress(page: Page): Promise<string> {
  await openAssetsTab(page);
  return await page.evaluate(() => {
    const labels = Array.from(document.querySelectorAll('.wallet-label'));
    const eoaLabel = labels.find((node) => {
      const text = String(node.textContent || '').trim();
      return text === 'EOA' || text === 'External';
    });
    const card = eoaLabel?.parentElement;
    const paragraphs = card ? Array.from(card.querySelectorAll('p')) : [];
    const value = paragraphs
      .map((node) => String(node.textContent || '').trim())
      .find((text) => /^0x[a-fA-F0-9]{40}$/.test(text));
    return String(value || '');
  });
}

async function getRpcExternalBalance(page: Page, symbol: string, holder: string): Promise<number> {
  const tokens = await getApiTokens(page);
  const token = tokens.find((entry) => String(entry.symbol || '').toUpperCase() === symbol.toUpperCase());
  expect(token?.address, `Missing ${symbol} token address`).toBeTruthy();
  const decimals = typeof token?.decimals === 'number' ? token.decimals : 18;
  return Number(formatUnits(await getRpcExternalBalanceRaw(page, symbol, holder), decimals));
}

test('asset faucet exposes correct modes and funds every supported token', async ({ page }) => {
  test.setTimeout(LONG_E2E ? 240_000 : 180_000);

  await timedStep('faucet.baseline', async () => {
    await ensureE2EBaseline(page, {
      timeoutMs: LONG_E2E ? 240_000 : 120_000,
      requireHubMesh: true,
      requireMarketMaker: false,
      minHubCount: 3,
      forceReset: true,
    });
  });

  let alice: { entityId: string; signerId: string; runtimeId: string } | null = null;
  await timedStep('faucet.runtime', async () => {
    await gotoApp(page, { appBaseUrl: APP_BASE_URL, initTimeoutMs: 60_000, settleMs: 500 });
    await page.evaluate((apiBaseUrl: string) => {
      (window as typeof window & { __XLN_API_BASE_URL__?: string }).__XLN_API_BASE_URL__ = apiBaseUrl;
      localStorage.setItem('xln-api-base-url', apiBaseUrl);
    }, API_BASE_URL);
    alice = await createRuntimeIdentity(page, 'alice', selectDemoMnemonic('alice'));
    await switchToRuntimeId(page, alice.runtimeId);
  });

  const hubs = await waitForNamedHubs(page, ['H1'], { timeoutMs: ROUTE_TIMEOUT_MS });
  await timedStep('faucet.open-account', async () => {
    await connectRuntimeToHub(page, { entityId: alice!.entityId, signerId: alice!.signerId }, hubs.h1);
  });

  await timedStep('faucet.mode-matrix', async () => {
    await openAssetsTab(page);
    const selectorOptions = await page.getByTestId('asset-faucet-symbol').first().locator('option').evaluateAll(
      (nodes) => nodes.map((node) => String((node as HTMLOptionElement).value || '').trim()).filter((value) => value.length > 0),
    );
    expect(selectorOptions).toEqual(expect.arrayContaining(['ETH', 'WETH', 'USDT', 'USDC']));

    for (const symbol of selectorOptions) {
      if (symbol === 'ETH') {
        await expectFaucetModes(page, symbol, { reserveVisible: false, reserveEnabled: false, accountVisible: false });
        continue;
      }
      await expectFaucetModes(page, symbol, { reserveVisible: true, reserveEnabled: true, accountVisible: true });
    }
  });

  await timedStep('faucet.eth.external', async () => {
    const beforeExternal = await refreshExternalBalance(page, 'ETH');
    await clickExternalFaucet(page, 'ETH');
    await expect.poll(async () => refreshExternalBalance(page, 'ETH'), { timeout: ROUTE_TIMEOUT_MS }).toBeGreaterThan(beforeExternal);
  });

  for (const symbol of ['WETH', 'USDT', 'USDC'] as const) {
    await timedStep(`faucet.${symbol}.external`, async () => {
      const beforeExternal = await refreshExternalBalance(page, symbol);
      await clickExternalFaucet(page, symbol);
      await expect.poll(async () => refreshExternalBalance(page, symbol), { timeout: ROUTE_TIMEOUT_MS }).toBeGreaterThan(beforeExternal);
    });

    await timedStep(`faucet.${symbol}.reserve`, async () => {
      const beforeReserve = await refreshReserveBalance(page, symbol);
      await clickReserveFaucet(page, symbol);
      await expect.poll(async () => refreshReserveBalance(page, symbol), { timeout: ROUTE_TIMEOUT_MS }).toBeGreaterThan(beforeReserve);
    });

    await timedStep(`faucet.${symbol}.account`, async () => {
      const beforeAccount = await refreshAccountSpendableBalance(page, symbol);
      await clickAccountFaucet(page, symbol);
      await expect.poll(async () => refreshAccountSpendableBalance(page, symbol), { timeout: ROUTE_TIMEOUT_MS }).toBeGreaterThan(beforeAccount);
    });
  }
});

test('move tab covers all routed paths on isolated runtimes', async ({ page, browser }) => {
  test.setTimeout(LONG_E2E ? 360_000 : 240_000);

  await timedStep('move.baseline', async () => {
    await ensureE2EBaseline(page, {
      timeoutMs: LONG_E2E ? 240_000 : 120_000,
      requireHubMesh: true,
      requireMarketMaker: false,
      minHubCount: 3,
      forceReset: true,
    });
  });

  const bobContext = await browser.newContext({ ignoreHTTPSErrors: true });
  const bobPage = await bobContext.newPage();
  try {
    let alice: { entityId: string; signerId: string; runtimeId: string } | null = null;
    let bob: { entityId: string; signerId: string; runtimeId: string } | null = null;

    await timedStep('move.runtimes', async () => {
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

    const hubs = await waitForNamedHubs(page, ['H1', 'H2'], { timeoutMs: ROUTE_TIMEOUT_MS });
    await timedStep('move.open-accounts', async () => {
      await connectRuntimeToHub(page, { entityId: alice!.entityId, signerId: alice!.signerId }, hubs.h1);
      await connectRuntimeToHub(bobPage, { entityId: bob!.entityId, signerId: bob!.signerId }, hubs.h2);
    });

    const symbol = 'USDC';
    const aliceEoa = String(alice!.signerId || '').trim();
    expect(aliceEoa).toMatch(/^0x[a-fA-F0-9]{40}$/);

    await timedStep('move.seed-wallet', async () => {
      await seedExternalWallet(page, aliceEoa, symbol, '120');
      await expect
        .poll(async () => refreshExternalBalance(page, symbol), { timeout: ROUTE_TIMEOUT_MS })
        .toBeGreaterThan(0);
    });

    await timedStep('move.wait-bob-profile-on-alice', async () => {
      await waitForRecipientCounterpartyProfile(page, bob!.entityId, hubs.h2);
    });

    await timedStep('move.e2r', async () => {
      const beforeReserve = await refreshReserveBalance(page, symbol);
      await timedMillis('move.e2r', async () => {
        await openMoveTab(page);
        await page.getByTestId('move-asset-symbol').selectOption(symbol);
        await page.getByTestId('move-amount').fill('20');
        await chooseMoveRoute(page, 'external', 'reserve');
        await waitForMoveReady(page);
        await expect(page.getByTestId('move-route-summary')).toContainText('1 external-signer batch');
        await expect(page.getByTestId('move-route-summary')).toContainText('Submit external deposit batch into your reserve');
        await expect(page.getByTestId('move-confirm').first()).toHaveText(/Submit External Batch/i);
        await page.getByTestId('move-confirm').first().click();
        await expect.poll(async () => refreshReserveBalance(page, symbol), { timeout: ROUTE_TIMEOUT_MS }).toBeGreaterThan(beforeReserve);
      });
      const afterReserve = await refreshReserveBalance(page, symbol);
      logBalanceDelta('move.e2r', { beforeRecipient: beforeReserve, afterRecipient: afterReserve });
    });

    await timedStep('move.r2a-self', async () => {
      const beforeAccount = await refreshAccountSpendableBalance(page, symbol);
      await timedMillis('move.r2a-self', async () => {
        await openMoveTab(page);
        await page.getByTestId('move-asset-symbol').selectOption(symbol);
        await page.getByTestId('move-amount').fill('8');
        await chooseMoveRoute(page, 'reserve', 'account');
        await waitForMoveReady(page);
        await page.getByTestId('move-confirm').first().click();
        await broadcastDraftBatch(page);
        await expect.poll(async () => refreshAccountSpendableBalance(page, symbol), { timeout: ROUTE_TIMEOUT_MS }).toBeGreaterThan(beforeAccount);
      });
      const afterAccount = await refreshAccountSpendableBalance(page, symbol);
      logBalanceDelta('move.r2a-self', { beforeRecipient: beforeAccount, afterRecipient: afterAccount });
    });

    await timedStep('move.a2r-self', async () => {
      const beforeReserve = await refreshReserveBalance(page, symbol);
      const beforeAccount = await refreshAccountSpendableBalance(page, symbol);
      await timedMillis('move.a2r-self', async () => {
        await openMoveTab(page);
        await page.getByTestId('move-asset-symbol').selectOption(symbol);
        await page.getByTestId('move-amount').fill('3');
        await chooseMoveRoute(page, 'account', 'reserve');
        await waitForMoveReady(page);
        await page.getByTestId('move-confirm').first().click();
        await broadcastDraftBatch(page);
        await expect.poll(async () => refreshReserveBalance(page, symbol), { timeout: ROUTE_TIMEOUT_MS }).toBeGreaterThan(beforeReserve);
        await expect.poll(async () => refreshAccountSpendableBalance(page, symbol), { timeout: ROUTE_TIMEOUT_MS }).toBeLessThan(beforeAccount);
      });
      const afterReserve = await refreshReserveBalance(page, symbol);
      const afterAccount = await refreshAccountSpendableBalance(page, symbol);
      logBalanceDelta('move.a2r-self', { beforeSender: beforeAccount, afterSender: afterAccount, beforeRecipient: beforeReserve, afterRecipient: afterReserve });
    });

    await timedStep('move.r2e', async () => {
      const beforeReserve = await refreshReserveBalance(page, symbol);
      const beforeExternalRaw = await getRpcExternalBalanceRaw(page, symbol, aliceEoa);
      await timedMillis('move.r2e', async () => {
        await openMoveTab(page);
        await page.getByTestId('move-asset-symbol').selectOption(symbol);
        await page.getByTestId('move-amount').fill('2');
        await chooseMoveRoute(page, 'reserve', 'external');
        await page.getByTestId('move-external-recipient').fill(aliceEoa);
        await waitForMoveReady(page);
        await expect(page.getByTestId('move-route-summary')).toContainText('1 reserve batch');
        await expect(page.getByTestId('move-route-summary')).toContainText('Broadcast reserve withdrawal batch to recipient EOA');
        await expect(page.getByTestId('move-confirm').first()).toHaveText(/Add to Batch/i);
        await page.getByTestId('move-confirm').first().click();
        await broadcastDraftBatch(page);
        await expect.poll(async () => refreshReserveBalance(page, symbol), { timeout: ROUTE_TIMEOUT_MS }).toBeLessThan(beforeReserve);
        await expect.poll(async () => getRpcExternalBalanceRaw(page, symbol, aliceEoa), { timeout: ROUTE_TIMEOUT_MS }).toBeGreaterThan(beforeExternalRaw);
      });
      const afterReserve = await refreshReserveBalance(page, symbol);
      const afterExternal = await getRpcExternalBalance(page, symbol, aliceEoa);
      logBalanceDelta('move.r2e', { beforeSender: beforeReserve, afterSender: afterReserve, beforeRecipient: Number(formatUnits(beforeExternalRaw, 6)), afterRecipient: afterExternal });
    });

    await timedStep('move.r2r-remote', async () => {
      const beforeAliceReserve = await refreshReserveBalance(page, symbol);
      const beforeBobReserve = await refreshReserveBalance(bobPage, symbol);
      await timedMillis('move.r2r-remote', async () => {
        await openMoveTab(page);
        await page.getByTestId('move-asset-symbol').selectOption(symbol);
        await page.getByTestId('move-amount').fill('4');
        await chooseMoveRoute(page, 'reserve', 'reserve');
        await selectMoveEntityField(page, 'move-reserve-recipient-field', bob!.entityId);
        await waitForMoveReady(page);
        await page.getByTestId('move-confirm').first().click();
        await broadcastDraftBatch(page);
        await expect.poll(async () => refreshReserveBalance(page, symbol), { timeout: ROUTE_TIMEOUT_MS }).toBeLessThan(beforeAliceReserve);
        await expect.poll(async () => refreshReserveBalance(bobPage, symbol), { timeout: ROUTE_TIMEOUT_MS }).toBeGreaterThan(beforeBobReserve);
      });
      const afterAliceReserve = await refreshReserveBalance(page, symbol);
      const afterBobReserve = await refreshReserveBalance(bobPage, symbol);
      logBalanceDelta('move.r2r-remote', { beforeSender: beforeAliceReserve, afterSender: afterAliceReserve, beforeRecipient: beforeBobReserve, afterRecipient: afterBobReserve });
    });

    await timedStep('move.e2a-remote', async () => {
      const beforeBobAccount = await refreshAccountSpendableBalance(bobPage, symbol);
      await timedMillis('move.e2a-remote', async () => {
        await openMoveTab(page);
        await page.getByTestId('move-asset-symbol').selectOption(symbol);
        await page.getByTestId('move-amount').fill('5');
        await chooseMoveRoute(page, 'external', 'account');
        await selectMoveEntityField(page, 'move-target-entity-field', bob!.entityId);
        await selectMoveEntityField(page, 'move-target-counterparty-field', hubs.h2);
        await waitForMoveReady(page);
        await page.getByTestId('move-confirm').first().click();
        await expect.poll(async () => refreshAccountSpendableBalance(bobPage, symbol), { timeout: ROUTE_TIMEOUT_MS }).toBeGreaterThan(beforeBobAccount);
      });
      const afterBobAccount = await refreshAccountSpendableBalance(bobPage, symbol);
      logBalanceDelta('move.e2a-remote', { beforeRecipient: beforeBobAccount, afterRecipient: afterBobAccount });
    });

    await timedStep('move.a2e', async () => {
      const beforeAccount = await refreshAccountSpendableBalance(page, symbol);
      const beforeExternalRaw = await getRpcExternalBalanceRaw(page, symbol, aliceEoa);
      await timedMillis('move.a2e', async () => {
        await openMoveTab(page);
        await page.getByTestId('move-asset-symbol').selectOption(symbol);
        await page.getByTestId('move-amount').fill('1');
        await chooseMoveRoute(page, 'account', 'external');
        await page.getByTestId('move-external-recipient').fill(aliceEoa);
        await waitForMoveReady(page);
        await page.getByTestId('move-confirm').first().click();
        await broadcastDraftBatch(page);
        await expect.poll(async () => refreshAccountSpendableBalance(page, symbol), { timeout: ROUTE_TIMEOUT_MS }).toBeLessThan(beforeAccount);
        await expect.poll(async () => getRpcExternalBalanceRaw(page, symbol, aliceEoa), { timeout: ROUTE_TIMEOUT_MS }).toBeGreaterThan(beforeExternalRaw);
      });
      const afterAccount = await refreshAccountSpendableBalance(page, symbol);
      const afterExternal = await getRpcExternalBalance(page, symbol, aliceEoa);
      logBalanceDelta('move.a2e', { beforeSender: beforeAccount, afterSender: afterAccount, beforeRecipient: Number(formatUnits(beforeExternalRaw, 6)), afterRecipient: afterExternal });
    });

    await timedStep('move.a2a-remote', async () => {
      const beforeAliceAccount = await refreshAccountSpendableBalance(page, symbol);
      const beforeBobAccount = await refreshAccountSpendableBalance(bobPage, symbol);
      await timedMillis('move.a2a-remote', async () => {
        await openMoveTab(page);
        await page.getByTestId('move-asset-symbol').selectOption(symbol);
        await page.getByTestId('move-amount').fill('2');
        await chooseMoveRoute(page, 'account', 'account');
        await selectMoveEntityField(page, 'move-target-entity-field', bob!.entityId);
        await selectMoveEntityField(page, 'move-target-counterparty-field', hubs.h2);
        await waitForMoveReady(page);
        await page.getByTestId('move-confirm').first().click();
        await broadcastDraftBatch(page);
        await expect.poll(async () => refreshAccountSpendableBalance(page, symbol), { timeout: ROUTE_TIMEOUT_MS }).toBeLessThan(beforeAliceAccount);
        await expect.poll(async () => refreshAccountSpendableBalance(bobPage, symbol), { timeout: ROUTE_TIMEOUT_MS }).toBeGreaterThan(beforeBobAccount);
      });
      const afterAliceAccount = await refreshAccountSpendableBalance(page, symbol);
      const afterBobAccount = await refreshAccountSpendableBalance(bobPage, symbol);
      logBalanceDelta('move.a2a-remote', { beforeSender: beforeAliceAccount, afterSender: afterAliceAccount, beforeRecipient: beforeBobAccount, afterRecipient: afterBobAccount });
    });

    await timedStep('move.roundtrip-a2e-e2a-remote-target-first', async () => {
      const beforeAliceAccount = await refreshAccountSpendableBalance(page, symbol);
      const beforeAliceExternalRaw = await getRpcExternalBalanceRaw(page, symbol, aliceEoa);
      const beforeBobAccount = await refreshAccountSpendableBalance(bobPage, symbol);

      await timedMillis('move.roundtrip.a2e-self', async () => {
        await openMoveTab(page);
        await page.getByTestId('move-asset-symbol').selectOption(symbol);
        await page.getByTestId('move-amount').fill('0.5');
        await chooseMoveRoute(page, 'account', 'external', 'target-first');
        await page.getByTestId('move-external-recipient').fill(aliceEoa);
        await waitForMoveReady(page);
        await page.getByTestId('move-confirm').first().click();
        await broadcastDraftBatch(page);
        await expect.poll(async () => refreshAccountSpendableBalance(page, symbol), { timeout: ROUTE_TIMEOUT_MS }).toBeLessThan(beforeAliceAccount);
        await expect.poll(async () => getRpcExternalBalanceRaw(page, symbol, aliceEoa), { timeout: ROUTE_TIMEOUT_MS }).toBeGreaterThan(beforeAliceExternalRaw);
      });

      const midAliceExternalRaw = await getRpcExternalBalanceRaw(page, symbol, aliceEoa);
      const midAliceAccount = await refreshAccountSpendableBalance(page, symbol);

      await timedMillis('move.roundtrip.e2a-remote', async () => {
        await openMoveTab(page);
        await page.getByTestId('move-asset-symbol').selectOption(symbol);
        await page.getByTestId('move-amount').fill('1.25');
        await chooseMoveRoute(page, 'external', 'account', 'target-first');
        await selectMoveEntityField(page, 'move-target-entity-field', bob!.entityId);
        await selectMoveEntityField(page, 'move-target-counterparty-field', hubs.h2);
        await waitForMoveReady(page);
        await page.getByTestId('move-confirm').first().click();
        await expect.poll(async () => getRpcExternalBalanceRaw(page, symbol, aliceEoa), { timeout: ROUTE_TIMEOUT_MS }).toBeLessThan(midAliceExternalRaw);
        await expect.poll(async () => refreshAccountSpendableBalance(bobPage, symbol), { timeout: ROUTE_TIMEOUT_MS }).toBeGreaterThan(beforeBobAccount);
      });

      const afterAliceExternalRaw = await getRpcExternalBalanceRaw(page, symbol, aliceEoa);
      const afterAliceAccount = await refreshAccountSpendableBalance(page, symbol);
      const afterBobAccount = await refreshAccountSpendableBalance(bobPage, symbol);
      expect(afterAliceAccount).toBeLessThan(beforeAliceAccount);
      expect(afterAliceExternalRaw).toBeLessThan(midAliceExternalRaw);
      expect(afterBobAccount).toBeGreaterThan(beforeBobAccount);
      logBalanceDelta('move.roundtrip-a2e-e2a-remote-target-first', {
        beforeSender: midAliceAccount,
        afterSender: afterAliceAccount,
        beforeRecipient: beforeBobAccount,
        afterRecipient: afterBobAccount,
      });
    });
  } finally {
    await bobContext.close();
  }
});
