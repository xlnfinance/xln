import { expect, test, type Page } from '@playwright/test';
import { Interface, MaxUint256, formatUnits, parseUnits } from 'ethers';
import { deriveDelta } from '../runtime/account-utils';
import { ensureE2EBaseline, API_BASE_URL, APP_BASE_URL, waitForNamedHubs } from './utils/e2e-baseline';
import { createRuntimeIdentity, gotoApp, selectDemoMnemonic, switchToRuntimeId } from './utils/e2e-demo-users';
import { connectRuntimeToHub } from './utils/e2e-connect';
import {
  getRenderedAccountSpendableBalance,
  getRenderedExternalBalance,
  getRenderedReserveBalance,
} from './utils/e2e-account-ui';
import { timedStep } from './utils/e2e-timing';
import { capturePageScreenshot } from './utils/e2e-screenshots';

const LONG_E2E = process.env.E2E_LONG === '1';
const ROUTE_TIMEOUT_MS = LONG_E2E ? 90_000 : 60_000;
const EXTERNAL_BATCH_TIMEOUT_MS = LONG_E2E ? 150_000 : 90_000;

type ApiTokenEntry = {
  address?: string;
  symbol?: string;
  decimals?: number;
  tokenId?: number;
};

const ERC20_BALANCE_OF = new Interface([
  'function balanceOf(address owner) view returns (uint256)',
]);
const ERC20_TRANSFER = new Interface([
  'function transfer(address to, uint256 amount) returns (bool)',
]);
const ERC20_ALLOWANCE = new Interface([
  'function allowance(address owner, address spender) view returns (uint256)',
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

type LocalEntityRef = {
  entityId: string;
  signerId: string;
};

type MoveBatchSnapshot = {
  pendingExternalToReserve: number;
  pendingReserveToCollateral: number;
  pendingCollateralToReserve: number;
  pendingReserveToReserve: number;
  pendingReserveToExternal: number;
  sentExternalToReserve: number;
  sentReserveToCollateral: number;
  sentCollateralToReserve: number;
  sentReserveToReserve: number;
  sentReserveToExternal: number;
  sentExists: boolean;
  batchHistoryCount: number;
  recentMessages: string[];
};

async function getLocalEntity(page: Page): Promise<LocalEntityRef> {
  const entity = await page.evaluate(() => {
    const env = (window as typeof window & {
      isolatedEnv?: {
        eReplicas?: Map<string, unknown>;
      };
    }).isolatedEnv;
    if (!env?.eReplicas) return null;
    for (const [replicaKey] of env.eReplicas.entries()) {
      const [entityId, signerId] = String(replicaKey).split(':');
      if (!entityId || !signerId) continue;
      return { entityId, signerId };
    }
    return null;
  });
  if (!entity) throw new Error('No local entity in isolatedEnv');
  return entity;
}

function asLocalEntityRef(ref: { entityId: string; signerId: string }): LocalEntityRef {
  return {
    entityId: String(ref.entityId || '').trim(),
    signerId: String(ref.signerId || '').trim(),
  };
}

async function readMoveBatchSnapshot(
  page: Page,
  entityId: string,
  signerId: string,
): Promise<MoveBatchSnapshot> {
  return page.evaluate(({ entityId, signerId }) => {
    const env = (window as typeof window & {
      isolatedEnv?: {
        eReplicas?: Map<string, unknown>;
      };
    }).isolatedEnv;
    if (!env?.eReplicas) {
      return {
        pendingExternalToReserve: 0,
        pendingReserveToCollateral: 0,
        pendingCollateralToReserve: 0,
        pendingReserveToReserve: 0,
        pendingReserveToExternal: 0,
        sentExternalToReserve: 0,
        sentReserveToCollateral: 0,
        sentCollateralToReserve: 0,
        sentReserveToReserve: 0,
        sentReserveToExternal: 0,
        sentExists: false,
        batchHistoryCount: 0,
        recentMessages: [],
      };
    }
    const key = Array.from(env.eReplicas.keys()).find((candidateKey: string) => {
      const [candidateEntityId, candidateSignerId] = String(candidateKey).split(':');
      return String(candidateEntityId || '').toLowerCase() === String(entityId).toLowerCase()
        && String(candidateSignerId || '').toLowerCase() === String(signerId).toLowerCase();
    });
    const replica = key ? env.eReplicas.get(key) as {
      state?: {
        jBatchState?: {
          batch?: Record<string, unknown>;
          sentBatch?: { batch?: Record<string, unknown> };
        };
        batchHistory?: unknown[];
        messages?: unknown[];
      };
    } | undefined : undefined;
    const pending = replica?.state?.jBatchState?.batch as Record<string, unknown> | undefined;
    const sent = replica?.state?.jBatchState?.sentBatch?.batch as Record<string, unknown> | undefined;
    const history = Array.isArray(replica?.state?.batchHistory) ? replica.state.batchHistory : [];
    const recentMessages = Array.isArray(replica?.state?.messages)
      ? replica.state.messages.slice(-8).map((message) => String(message || ''))
      : [];
    const count = (batch: Record<string, unknown> | undefined, key: string): number => {
      const value = batch?.[key];
      return Array.isArray(value) ? value.length : 0;
    };
    return {
      pendingExternalToReserve: count(pending, 'externalTokenToReserve'),
      pendingReserveToCollateral: count(pending, 'reserveToCollateral'),
      pendingCollateralToReserve: count(pending, 'collateralToReserve'),
      pendingReserveToReserve: count(pending, 'reserveToReserve'),
      pendingReserveToExternal: count(pending, 'reserveToExternalToken'),
      sentExternalToReserve: count(sent, 'externalTokenToReserve'),
      sentReserveToCollateral: count(sent, 'reserveToCollateral'),
      sentCollateralToReserve: count(sent, 'collateralToReserve'),
      sentReserveToReserve: count(sent, 'reserveToReserve'),
      sentReserveToExternal: count(sent, 'reserveToExternalToken'),
      sentExists: Boolean(replica?.state?.jBatchState?.sentBatch),
      batchHistoryCount: Number(history.length || 0),
      recentMessages,
    };
  }, { entityId, signerId });
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

async function broadcastDraftBatch(
  page: Page,
  entity?: LocalEntityRef,
  timeoutMs = ROUTE_TIMEOUT_MS,
): Promise<void> {
  const localEntity = entity ?? await getLocalEntity(page);
  await expect
    .poll(async () => {
      const snapshot = await readMoveBatchSnapshot(page, localEntity.entityId, localEntity.signerId);
      return (
        snapshot.pendingExternalToReserve +
        snapshot.pendingReserveToCollateral +
        snapshot.pendingCollateralToReserve +
        snapshot.pendingReserveToReserve +
        snapshot.pendingReserveToExternal
      );
    }, { timeout: timeoutMs })
    .toBeGreaterThan(0);
  await expect(page.getByTestId('workspace-pending-banner').first()).toBeVisible({ timeout: 20_000 });
  const broadcast = page.getByTestId('settle-sign-broadcast').first();
  await expect(broadcast).toBeVisible({ timeout: 20_000 });
  await expect(broadcast).toBeEnabled({ timeout: 20_000 });
  const before = await readMoveBatchSnapshot(page, localEntity.entityId, localEntity.signerId);
  await broadcast.click();
  const deadline = Date.now() + 20_000;
  let lastSnapshot = before;

  while (Date.now() < deadline) {
    lastSnapshot = await readMoveBatchSnapshot(page, localEntity.entityId, localEntity.signerId);
    const recentMessageText = lastSnapshot.recentMessages.join(' | ');
    if (recentMessageText.includes('submit_failed:') || recentMessageText.includes('🛑 Aborted sentBatch')) {
      throw new Error(`Batch broadcast failed: ${recentMessageText}`);
    }
    if (lastSnapshot.sentExists || lastSnapshot.batchHistoryCount > before.batchHistoryCount) {
      return;
    }
    await page.waitForTimeout(250);
  }

  throw new Error(
    `Batch broadcast did not advance within 20s: ${JSON.stringify(lastSnapshot)}`,
  );
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

async function getApiToken(page: Page, symbol: string): Promise<Required<Pick<ApiTokenEntry, 'address' | 'symbol' | 'decimals' | 'tokenId'>>> {
  const tokens = await getApiTokens(page);
  const token = tokens.find((entry) => String(entry.symbol || '').toUpperCase() === symbol.toUpperCase());
  expect(token?.address, `Missing ${symbol} token address`).toBeTruthy();
  expect(typeof token?.tokenId === 'number', `Missing ${symbol} tokenId`).toBe(true);
  return {
    address: String(token!.address),
    symbol: String(token!.symbol || symbol).toUpperCase(),
    decimals: typeof token!.decimals === 'number' ? token!.decimals : 18,
    tokenId: Number(token!.tokenId),
  };
}

async function getDepositoryAddress(page: Page): Promise<string> {
  const response = await page.request.get(`${API_BASE_URL}/api/jurisdictions?ts=${Date.now()}`);
  expect(response.ok()).toBe(true);
  const body = await response.json().catch(() => ({} as Record<string, unknown>));
  const root = (body?.jurisdictions && typeof body.jurisdictions === 'object')
    ? body.jurisdictions as Record<string, unknown>
    : body;
  const jurisdictions = Object.values(root || {}) as Array<Record<string, unknown>>;
  const depository = jurisdictions
    .map((entry) => String((entry?.contracts as Record<string, unknown> | undefined)?.depository || entry?.depository || '').trim())
    .find((value) => /^0x[a-fA-F0-9]{40}$/.test(value));
  expect(depository, 'Missing depository address in jurisdictions response').toBeTruthy();
  return depository!;
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
  const token = await getApiToken(page, symbol);
  const raw = await rpcCall<string>(page, 'eth_call', [
    {
      to: token.address,
      data: ERC20_BALANCE_OF.encodeFunctionData('balanceOf', [holder]),
    },
    'latest',
  ]);
  return BigInt(raw || '0x0');
}

async function getRpcAllowanceRaw(page: Page, symbol: string, owner: string, spender: string): Promise<bigint> {
  const token = await getApiToken(page, symbol);
  const raw = await rpcCall<string>(page, 'eth_call', [
    {
      to: token.address,
      data: ERC20_ALLOWANCE.encodeFunctionData('allowance', [owner, spender]),
    },
    'latest',
  ]);
  return BigInt(raw || '0x0');
}

async function assertInfiniteDepositoryAllowance(page: Page, owner: string): Promise<void> {
  const depository = await getDepositoryAddress(page);
  const requiredSymbols = ['USDC', 'USDT', 'WETH'] as const;
  for (const symbol of requiredSymbols) {
    await expect
      .poll(async () => await getRpcAllowanceRaw(page, symbol, owner, depository), { timeout: ROUTE_TIMEOUT_MS })
      .toBe(MaxUint256);
  }
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
  const token = await getApiToken(page, symbol);
  return Number(formatUnits(await getRpcExternalBalanceRaw(page, symbol, holder), token.decimals));
}

async function readOnchainReserveBalanceRaw(page: Page, entityId: string, symbol: string): Promise<bigint> {
  const token = await getApiToken(page, symbol);
  const response = await page.request.get(
    `${API_BASE_URL}/api/debug/reserve?entityId=${encodeURIComponent(entityId)}&tokenId=${encodeURIComponent(String(token.tokenId))}`,
  );
  expect(response.ok(), `debug reserve request must succeed for ${symbol}`).toBe(true);
  const body = await response.json().catch(() => ({})) as { reserve?: string };
  expect(typeof body.reserve === 'string', `debug reserve body must include reserve for ${symbol}`).toBe(true);
  return BigInt(body.reserve || '0');
}

async function readOnchainReserveBalance(page: Page, entityId: string, symbol: string): Promise<number> {
  const token = await getApiToken(page, symbol);
  return Number(formatUnits(await readOnchainReserveBalanceRaw(page, entityId, symbol), token.decimals));
}

type DeltaSnapshot = {
  ondelta: string;
  offdelta: string;
  collateral: string;
  leftCreditLimit: string;
  rightCreditLimit: string;
  leftAllowance: string;
  rightAllowance: string;
  leftHold: string;
  rightHold: string;
};

async function readAccountOutCapacityRaw(
  page: Page,
  entityId: string,
  counterpartyId: string,
  tokenId: number,
): Promise<bigint> {
  const delta = await page.evaluate(({ counterpartyId, entityId, tokenId }) => {
    const env = (window as typeof window & {
      isolatedEnv?: {
        eReplicas?: Map<string, {
          state?: {
            accounts?: Map<string, {
              deltas?: Map<number | string, unknown>;
            }>;
          };
        }>;
      };
    }).isolatedEnv;
    if (!env?.eReplicas) return null;
    for (const [replicaKey, replica] of env.eReplicas.entries()) {
      if (!String(replicaKey).startsWith(`${entityId}:`)) continue;
      const account = replica.state?.accounts?.get(counterpartyId);
      const delta = account?.deltas?.get(tokenId);
      if (!delta || typeof delta !== 'object') return null;
      const raw = delta as Record<string, unknown>;
      const readBig = (value: unknown): string => {
        if (typeof value === 'bigint') return value.toString();
        if (typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value)) return String(value);
        if (typeof value === 'string' && /^-?\d+$/.test(value.trim())) return value.trim();
        return '0';
      };
      return {
        ondelta: readBig(raw.ondelta),
        offdelta: readBig(raw.offdelta),
        collateral: readBig(raw.collateral),
        leftCreditLimit: readBig(raw.leftCreditLimit),
        rightCreditLimit: readBig(raw.rightCreditLimit),
        leftAllowance: readBig(raw.leftAllowance),
        rightAllowance: readBig(raw.rightAllowance),
        leftHold: readBig(raw.leftHold),
        rightHold: readBig(raw.rightHold),
      } satisfies DeltaSnapshot;
    }
    return null;
  }, { counterpartyId, entityId, tokenId });

  if (!delta) return 0n;
  return deriveDelta({
    tokenId,
    ondelta: BigInt(delta.ondelta),
    offdelta: BigInt(delta.offdelta),
    collateral: BigInt(delta.collateral),
    leftCreditLimit: BigInt(delta.leftCreditLimit),
    rightCreditLimit: BigInt(delta.rightCreditLimit),
    leftAllowance: BigInt(delta.leftAllowance),
    rightAllowance: BigInt(delta.rightAllowance),
    leftHold: BigInt(delta.leftHold),
    rightHold: BigInt(delta.rightHold),
  }, String(entityId).toLowerCase() < String(counterpartyId).toLowerCase()).outCapacity;
}

async function waitForExactBigInt(
  probe: () => Promise<bigint>,
  expected: bigint,
  timeoutMs = ROUTE_TIMEOUT_MS,
): Promise<void> {
  await expect.poll(probe, { timeout: timeoutMs }).toBe(expected);
}

function expectExactDelta(
  label: string,
  beforeSender: bigint | null,
  afterSender: bigint | null,
  beforeRecipient: bigint | null,
  afterRecipient: bigint | null,
  amount: bigint,
): void {
  if (beforeSender !== null && afterSender !== null) {
    expect(afterSender, `${label}: sender exact delta`).toBe(beforeSender - amount);
  }
  if (beforeRecipient !== null && afterRecipient !== null) {
    expect(afterRecipient, `${label}: recipient exact delta`).toBe(beforeRecipient + amount);
  }
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

test('move tab covers all routed paths on isolated runtimes', async ({ page, browser }, testInfo) => {
  test.setTimeout(LONG_E2E ? 420_000 : 300_000);

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
    const token = await getApiToken(page, symbol);
    const amountRaw = (amount: string): bigint => parseUnits(amount, token.decimals);
    const aliceEoa = String(alice!.signerId || '').trim();
    const bobEoa = String(bob!.signerId || '').trim();
    expect(aliceEoa).toMatch(/^0x[a-fA-F0-9]{40}$/);
    expect(bobEoa).toMatch(/^0x[a-fA-F0-9]{40}$/);

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
      const amount = amountRaw('20');
      const beforeExternalRaw = await getRpcExternalBalanceRaw(page, symbol, aliceEoa);
      const beforeReserveRaw = await readOnchainReserveBalanceRaw(page, alice!.entityId, symbol);
      const depository = await getDepositoryAddress(page);
      for (const requiredSymbol of ['USDC', 'USDT', 'WETH'] as const) {
        const beforeAllowance = await getRpcAllowanceRaw(page, requiredSymbol, aliceEoa, depository);
        expect(beforeAllowance, `${requiredSymbol} allowance should start at zero in fresh wallet`).toBe(0n);
      }
      await timedMillis('move.e2r', async () => {
        await openMoveTab(page);
        await page.getByTestId('move-asset-symbol').selectOption(symbol);
        await chooseMoveRoute(page, 'external', 'reserve');
        await page.getByTestId('move-amount').fill('20');
        await waitForMoveReady(page);
        await expect(page.getByTestId('move-route-summary')).toContainText('Deposit into reserve');
        await expect(page.getByTestId('move-route-summary')).toContainText('Deposit from your wallet into reserve');
        await expect(page.getByTestId('move-confirm').first()).toHaveText(/Add to Batch/i);
        await capturePageScreenshot(page, testInfo, 'move-batch-route-summary-desktop.png');
        await page.getByTestId('move-confirm').first().click();
        await capturePageScreenshot(page, testInfo, 'move-batch-queued-desktop.png');
        await broadcastDraftBatch(page, asLocalEntityRef(alice!), EXTERNAL_BATCH_TIMEOUT_MS);
        await waitForExactBigInt(
          async () => await readOnchainReserveBalanceRaw(page, alice!.entityId, symbol),
          beforeReserveRaw + amount,
          EXTERNAL_BATCH_TIMEOUT_MS,
        );
        await waitForExactBigInt(
          async () => await getRpcExternalBalanceRaw(page, symbol, aliceEoa),
          beforeExternalRaw - amount,
          EXTERNAL_BATCH_TIMEOUT_MS,
        );
      });
      const afterExternalRaw = await getRpcExternalBalanceRaw(page, symbol, aliceEoa);
      const afterReserveRaw = await readOnchainReserveBalanceRaw(page, alice!.entityId, symbol);
      expectExactDelta('move.e2r', beforeExternalRaw, afterExternalRaw, beforeReserveRaw, afterReserveRaw, amount);
    });

    await timedStep('move.r2a-self', async () => {
      const amount = amountRaw('8');
      const beforeReserveRaw = await readOnchainReserveBalanceRaw(page, alice!.entityId, symbol);
      const beforeAccountRaw = await readAccountOutCapacityRaw(page, alice!.entityId, hubs.h1, token.tokenId);
      await timedMillis('move.r2a-self', async () => {
        await openMoveTab(page);
        await page.getByTestId('move-asset-symbol').selectOption(symbol);
        await chooseMoveRoute(page, 'reserve', 'account');
        await page.getByTestId('move-amount').fill('8');
        await waitForMoveReady(page);
        await page.getByTestId('move-confirm').first().click();
        await broadcastDraftBatch(page, asLocalEntityRef(alice!));
        await waitForExactBigInt(
          async () => await readOnchainReserveBalanceRaw(page, alice!.entityId, symbol),
          beforeReserveRaw - amount,
        );
        await waitForExactBigInt(
          async () => await readAccountOutCapacityRaw(page, alice!.entityId, hubs.h1, token.tokenId),
          beforeAccountRaw + amount,
        );
      });
      const afterReserveRaw = await readOnchainReserveBalanceRaw(page, alice!.entityId, symbol);
      const afterAccountRaw = await readAccountOutCapacityRaw(page, alice!.entityId, hubs.h1, token.tokenId);
      expectExactDelta('move.r2a-self', beforeReserveRaw, afterReserveRaw, beforeAccountRaw, afterAccountRaw, amount);
    });

    await timedStep('move.a2r-self', async () => {
      const amount = amountRaw('3');
      const beforeReserveRaw = await readOnchainReserveBalanceRaw(page, alice!.entityId, symbol);
      const beforeAccountRaw = await readAccountOutCapacityRaw(page, alice!.entityId, hubs.h1, token.tokenId);
      await timedMillis('move.a2r-self', async () => {
        await openMoveTab(page);
        await page.getByTestId('move-asset-symbol').selectOption(symbol);
        await chooseMoveRoute(page, 'account', 'reserve');
        await page.getByTestId('move-amount').fill('3');
        await waitForMoveReady(page);
        await page.getByTestId('move-confirm').first().click();
        await broadcastDraftBatch(page, asLocalEntityRef(alice!));
        await waitForExactBigInt(
          async () => await readOnchainReserveBalanceRaw(page, alice!.entityId, symbol),
          beforeReserveRaw + amount,
        );
        await waitForExactBigInt(
          async () => await readAccountOutCapacityRaw(page, alice!.entityId, hubs.h1, token.tokenId),
          beforeAccountRaw - amount,
        );
      });
      const afterReserveRaw = await readOnchainReserveBalanceRaw(page, alice!.entityId, symbol);
      const afterAccountRaw = await readAccountOutCapacityRaw(page, alice!.entityId, hubs.h1, token.tokenId);
      expectExactDelta('move.a2r-self', beforeAccountRaw, afterAccountRaw, beforeReserveRaw, afterReserveRaw, amount);
    });

    await timedStep('move.r2e', async () => {
      const amount = amountRaw('2');
      const beforeReserveRaw = await readOnchainReserveBalanceRaw(page, alice!.entityId, symbol);
      const beforeExternalRaw = await getRpcExternalBalanceRaw(page, symbol, aliceEoa);
      await timedMillis('move.r2e', async () => {
        await openMoveTab(page);
        await page.getByTestId('move-asset-symbol').selectOption(symbol);
        await chooseMoveRoute(page, 'reserve', 'external');
        await page.getByTestId('move-amount').fill('2');
        await page.getByTestId('move-external-recipient').fill(aliceEoa);
        await waitForMoveReady(page);
        await expect(page.getByTestId('move-route-summary')).toContainText('Withdraw to wallet');
        await expect(page.getByTestId('move-route-summary')).toContainText('Withdraw reserve to recipient wallet');
        await expect(page.getByTestId('move-confirm').first()).toHaveText(/Add to Batch/i);
        await page.getByTestId('move-confirm').first().click();
        await broadcastDraftBatch(page, asLocalEntityRef(alice!));
        await waitForExactBigInt(
          async () => await readOnchainReserveBalanceRaw(page, alice!.entityId, symbol),
          beforeReserveRaw - amount,
        );
        await waitForExactBigInt(
          async () => await getRpcExternalBalanceRaw(page, symbol, aliceEoa),
          beforeExternalRaw + amount,
        );
      });
      const afterReserveRaw = await readOnchainReserveBalanceRaw(page, alice!.entityId, symbol);
      const afterExternalRaw = await getRpcExternalBalanceRaw(page, symbol, aliceEoa);
      expectExactDelta('move.r2e', beforeReserveRaw, afterReserveRaw, beforeExternalRaw, afterExternalRaw, amount);
    });

    await timedStep('move.r2r-remote', async () => {
      const amount = amountRaw('4');
      const beforeAliceReserveRaw = await readOnchainReserveBalanceRaw(page, alice!.entityId, symbol);
      const beforeBobReserveRaw = await readOnchainReserveBalanceRaw(bobPage, bob!.entityId, symbol);
      await timedMillis('move.r2r-remote', async () => {
        await openMoveTab(page);
        await page.getByTestId('move-asset-symbol').selectOption(symbol);
        await chooseMoveRoute(page, 'reserve', 'reserve');
        await page.getByTestId('move-amount').fill('4');
        await selectMoveEntityField(page, 'move-reserve-recipient-field', bob!.entityId);
        await waitForMoveReady(page);
        await page.getByTestId('move-confirm').first().click();
        await broadcastDraftBatch(page, asLocalEntityRef(alice!));
        await waitForExactBigInt(
          async () => await readOnchainReserveBalanceRaw(page, alice!.entityId, symbol),
          beforeAliceReserveRaw - amount,
        );
        await waitForExactBigInt(
          async () => await readOnchainReserveBalanceRaw(bobPage, bob!.entityId, symbol),
          beforeBobReserveRaw + amount,
        );
      });
      const afterAliceReserveRaw = await readOnchainReserveBalanceRaw(page, alice!.entityId, symbol);
      const afterBobReserveRaw = await readOnchainReserveBalanceRaw(bobPage, bob!.entityId, symbol);
      expectExactDelta('move.r2r-remote', beforeAliceReserveRaw, afterAliceReserveRaw, beforeBobReserveRaw, afterBobReserveRaw, amount);
    });

    await timedStep('move.e2a-remote', async () => {
      const amount = amountRaw('5');
      const beforeExternalRaw = await getRpcExternalBalanceRaw(page, symbol, aliceEoa);
      const beforeBobAccountRaw = await readAccountOutCapacityRaw(bobPage, bob!.entityId, hubs.h2, token.tokenId);
      await timedMillis('move.e2a-remote', async () => {
        await openMoveTab(page);
        await page.getByTestId('move-asset-symbol').selectOption(symbol);
        await chooseMoveRoute(page, 'external', 'account');
        await page.getByTestId('move-amount').fill('5');
        await selectMoveEntityField(page, 'move-target-entity-field', bob!.entityId);
        await selectMoveEntityField(page, 'move-target-counterparty-field', hubs.h2);
        await waitForMoveReady(page);
        await expect(page.getByTestId('move-confirm').first()).toHaveText(/Add to Batch/i);
        await page.getByTestId('move-confirm').first().click();
        await broadcastDraftBatch(page, asLocalEntityRef(alice!));
        await waitForExactBigInt(
          async () => await getRpcExternalBalanceRaw(page, symbol, aliceEoa),
          beforeExternalRaw - amount,
          EXTERNAL_BATCH_TIMEOUT_MS,
        );
        await waitForExactBigInt(
          async () => await readAccountOutCapacityRaw(bobPage, bob!.entityId, hubs.h2, token.tokenId),
          beforeBobAccountRaw + amount,
          EXTERNAL_BATCH_TIMEOUT_MS,
        );
      });
      const afterExternalRaw = await getRpcExternalBalanceRaw(page, symbol, aliceEoa);
      const afterBobAccountRaw = await readAccountOutCapacityRaw(bobPage, bob!.entityId, hubs.h2, token.tokenId);
      expectExactDelta('move.e2a-remote', beforeExternalRaw, afterExternalRaw, beforeBobAccountRaw, afterBobAccountRaw, amount);
    });

    await timedStep('move.a2e', async () => {
      const amount = amountRaw('1');
      const beforeAccountRaw = await readAccountOutCapacityRaw(page, alice!.entityId, hubs.h1, token.tokenId);
      const beforeExternalRaw = await getRpcExternalBalanceRaw(page, symbol, aliceEoa);
      await timedMillis('move.a2e', async () => {
        await openMoveTab(page);
        await page.getByTestId('move-asset-symbol').selectOption(symbol);
        await chooseMoveRoute(page, 'account', 'external');
        await page.getByTestId('move-amount').fill('1');
        await page.getByTestId('move-external-recipient').fill(aliceEoa);
        await waitForMoveReady(page);
        await page.getByTestId('move-confirm').first().click();
        await broadcastDraftBatch(page, asLocalEntityRef(alice!));
        await waitForExactBigInt(
          async () => await readAccountOutCapacityRaw(page, alice!.entityId, hubs.h1, token.tokenId),
          beforeAccountRaw - amount,
        );
        await waitForExactBigInt(
          async () => await getRpcExternalBalanceRaw(page, symbol, aliceEoa),
          beforeExternalRaw + amount,
        );
      });
      const afterAccountRaw = await readAccountOutCapacityRaw(page, alice!.entityId, hubs.h1, token.tokenId);
      const afterExternalRaw = await getRpcExternalBalanceRaw(page, symbol, aliceEoa);
      expectExactDelta('move.a2e', beforeAccountRaw, afterAccountRaw, beforeExternalRaw, afterExternalRaw, amount);
    });

    await timedStep('move.a2a-remote', async () => {
      const amount = amountRaw('2');
      const beforeAliceAccountRaw = await readAccountOutCapacityRaw(page, alice!.entityId, hubs.h1, token.tokenId);
      const beforeBobAccountRaw = await readAccountOutCapacityRaw(bobPage, bob!.entityId, hubs.h2, token.tokenId);
      await timedMillis('move.a2a-remote', async () => {
        await openMoveTab(page);
        await page.getByTestId('move-asset-symbol').selectOption(symbol);
        await chooseMoveRoute(page, 'account', 'account');
        await page.getByTestId('move-amount').fill('2');
        await selectMoveEntityField(page, 'move-target-entity-field', bob!.entityId);
        await selectMoveEntityField(page, 'move-target-counterparty-field', hubs.h2);
        await waitForMoveReady(page);
        await page.getByTestId('move-confirm').first().click();
        await broadcastDraftBatch(page, asLocalEntityRef(alice!));
        await waitForExactBigInt(
          async () => await readAccountOutCapacityRaw(page, alice!.entityId, hubs.h1, token.tokenId),
          beforeAliceAccountRaw - amount,
        );
        await waitForExactBigInt(
          async () => await readAccountOutCapacityRaw(bobPage, bob!.entityId, hubs.h2, token.tokenId),
          beforeBobAccountRaw + amount,
        );
      });
      const afterAliceAccountRaw = await readAccountOutCapacityRaw(page, alice!.entityId, hubs.h1, token.tokenId);
      const afterBobAccountRaw = await readAccountOutCapacityRaw(bobPage, bob!.entityId, hubs.h2, token.tokenId);
      expectExactDelta('move.a2a-remote', beforeAliceAccountRaw, afterAliceAccountRaw, beforeBobAccountRaw, afterBobAccountRaw, amount);
    });

    await timedStep('move.e2e', async () => {
      const amount = amountRaw('7');
      const beforeAliceExternalRaw = await getRpcExternalBalanceRaw(page, symbol, aliceEoa);
      const beforeBobExternalRaw = await getRpcExternalBalanceRaw(page, symbol, bobEoa);
      await timedMillis('move.e2e', async () => {
        await openMoveTab(page);
        await page.getByTestId('move-asset-symbol').selectOption(symbol);
        await chooseMoveRoute(page, 'external', 'external');
        await page.getByTestId('move-amount').fill('7');
        await page.getByTestId('move-external-recipient').fill(bobEoa);
        await waitForMoveReady(page);
        await page.getByTestId('move-confirm').first().click();
        await waitForExactBigInt(
          async () => await getRpcExternalBalanceRaw(page, symbol, aliceEoa),
          beforeAliceExternalRaw - amount,
        );
        await waitForExactBigInt(
          async () => await getRpcExternalBalanceRaw(page, symbol, bobEoa),
          beforeBobExternalRaw + amount,
        );
      });
      const afterAliceExternalRaw = await getRpcExternalBalanceRaw(page, symbol, aliceEoa);
      const afterBobExternalRaw = await getRpcExternalBalanceRaw(page, symbol, bobEoa);
      expectExactDelta('move.e2e', beforeAliceExternalRaw, afterAliceExternalRaw, beforeBobExternalRaw, afterBobExternalRaw, amount);
    });

    await timedStep('move.roundtrip-r2e-e2a', async () => {
      const amount = amountRaw('1.25');
      const reserveBefore = await readOnchainReserveBalanceRaw(page, alice!.entityId, symbol);
      const externalBefore = await getRpcExternalBalanceRaw(page, symbol, aliceEoa);
      const bobAccountBefore = await readAccountOutCapacityRaw(bobPage, bob!.entityId, hubs.h2, token.tokenId);

      await timedMillis('move.roundtrip.r2e', async () => {
        await openMoveTab(page);
        await page.getByTestId('move-asset-symbol').selectOption(symbol);
        await chooseMoveRoute(page, 'reserve', 'external', 'target-first');
        await page.getByTestId('move-amount').fill('1.25');
        await page.getByTestId('move-external-recipient').fill(aliceEoa);
        await waitForMoveReady(page);
        await page.getByTestId('move-confirm').first().click();
        await broadcastDraftBatch(page, asLocalEntityRef(bob!));
        await waitForExactBigInt(
          async () => await readOnchainReserveBalanceRaw(page, alice!.entityId, symbol),
          reserveBefore - amount,
        );
        await waitForExactBigInt(
          async () => await getRpcExternalBalanceRaw(page, symbol, aliceEoa),
          externalBefore + amount,
        );
      });

      const externalMid = await getRpcExternalBalanceRaw(page, symbol, aliceEoa);
      await timedMillis('move.roundtrip.e2a', async () => {
        await openMoveTab(page);
        await page.getByTestId('move-asset-symbol').selectOption(symbol);
        await chooseMoveRoute(page, 'external', 'account', 'target-first');
        await page.getByTestId('move-amount').fill('1.25');
        await selectMoveEntityField(page, 'move-target-entity-field', bob!.entityId);
        await selectMoveEntityField(page, 'move-target-counterparty-field', hubs.h2);
        await waitForMoveReady(page);
        await page.getByTestId('move-confirm').first().click();
        await broadcastDraftBatch(page, asLocalEntityRef(alice!));
        await waitForExactBigInt(
          async () => await getRpcExternalBalanceRaw(page, symbol, aliceEoa),
          externalMid - amount,
          EXTERNAL_BATCH_TIMEOUT_MS,
        );
        await waitForExactBigInt(
          async () => await readAccountOutCapacityRaw(bobPage, bob!.entityId, hubs.h2, token.tokenId),
          bobAccountBefore + amount,
          EXTERNAL_BATCH_TIMEOUT_MS,
        );
      });

      const afterAliceExternalRaw = await getRpcExternalBalanceRaw(page, symbol, aliceEoa);
      const afterBobAccountRaw = await readAccountOutCapacityRaw(bobPage, bob!.entityId, hubs.h2, token.tokenId);
      expect(afterAliceExternalRaw, 'move.roundtrip-r2e-e2a external net zero').toBe(externalBefore);
      expect(afterBobAccountRaw, 'move.roundtrip-r2e-e2a bob account exact').toBe(bobAccountBefore + amount);
    });

    await timedStep('move.roundtrip-a2r-r2e', async () => {
      const amount = amountRaw('0.5');
      const accountBefore = await readAccountOutCapacityRaw(page, alice!.entityId, hubs.h1, token.tokenId);
      const reserveBefore = await readOnchainReserveBalanceRaw(page, alice!.entityId, symbol);
      const externalBefore = await getRpcExternalBalanceRaw(page, symbol, aliceEoa);

      await timedMillis('move.roundtrip.a2r', async () => {
        await openMoveTab(page);
        await page.getByTestId('move-asset-symbol').selectOption(symbol);
        await chooseMoveRoute(page, 'account', 'reserve', 'target-first');
        await page.getByTestId('move-amount').fill('0.5');
        await waitForMoveReady(page);
        await page.getByTestId('move-confirm').first().click();
        await broadcastDraftBatch(page, asLocalEntityRef(alice!));
        await waitForExactBigInt(
          async () => await readAccountOutCapacityRaw(page, alice!.entityId, hubs.h1, token.tokenId),
          accountBefore - amount,
        );
        await waitForExactBigInt(
          async () => await readOnchainReserveBalanceRaw(page, alice!.entityId, symbol),
          reserveBefore + amount,
        );
      });

      const reserveMid = await readOnchainReserveBalanceRaw(page, alice!.entityId, symbol);
      await timedMillis('move.roundtrip.r2e', async () => {
        await openMoveTab(page);
        await page.getByTestId('move-asset-symbol').selectOption(symbol);
        await chooseMoveRoute(page, 'reserve', 'external', 'target-first');
        await page.getByTestId('move-amount').fill('0.5');
        await page.getByTestId('move-external-recipient').fill(aliceEoa);
        await waitForMoveReady(page);
        await page.getByTestId('move-confirm').first().click();
        await broadcastDraftBatch(page, asLocalEntityRef(alice!));
        await waitForExactBigInt(
          async () => await readOnchainReserveBalanceRaw(page, alice!.entityId, symbol),
          reserveMid - amount,
        );
        await waitForExactBigInt(
          async () => await getRpcExternalBalanceRaw(page, symbol, aliceEoa),
          externalBefore + amount,
        );
      });

      const afterAccountRaw = await readAccountOutCapacityRaw(page, alice!.entityId, hubs.h1, token.tokenId);
      const afterReserveRaw = await readOnchainReserveBalanceRaw(page, alice!.entityId, symbol);
      const afterExternalRaw = await getRpcExternalBalanceRaw(page, symbol, aliceEoa);
      expect(afterAccountRaw, 'move.roundtrip-a2r-r2e account exact').toBe(accountBefore - amount);
      expect(afterReserveRaw, 'move.roundtrip-a2r-r2e reserve net zero').toBe(reserveBefore);
      expect(afterExternalRaw, 'move.roundtrip-a2r-r2e external exact').toBe(externalBefore + amount);
    });
  } finally {
    await bobContext.close();
  }
});
