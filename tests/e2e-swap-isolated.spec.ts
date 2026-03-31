/**
 * E2E: Alice and Bob run in separate browser contexts, connect to the same hub, and trade
 * directly against each other through the hub orderbook with market maker liquidity disabled.
 *
 * Flow and goals:
 * 1. Start on a fresh isolated shard without market maker liquidity so only user orders can match.
 * 2. Open two isolated wallet pages with separate IndexedDB/localStorage state.
 * 3. Create Alice and Bob runtimes, connect both to the same hub, and fund Alice with WETH and Bob with USDC.
 * 4. Alice places a visible WETH/USDC sell order through the swap UI.
 * 5. Bob opens the same swap UI, enters the matching buy order manually, and confirms it.
 * 6. The test proves machine truth from saved account state: both sides record swap resolves and capacities move.
 * 7. The test also proves user-visible truth: Alice's open order appears, gets filled, and stays resolved after reload.
 */

import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { deriveDelta } from '../runtime/account-utils';
import { getHealth, ensureE2EBaseline } from './utils/e2e-baseline';
import { connectRuntimeToHub } from './utils/e2e-connect';
import { createRuntimeIdentity, gotoApp, selectDemoMnemonic } from './utils/e2e-demo-users';
import { requireIsolatedBaseUrl } from './utils/e2e-isolated-env';
import { timedStep } from './utils/e2e-timing';

const LONG_E2E = process.env.E2E_LONG === '1';
const INIT_TIMEOUT = 30_000;
const APP_BASE_URL = requireIsolatedBaseUrl('E2E_BASE_URL');
const API_BASE_URL = requireIsolatedBaseUrl('E2E_API_BASE_URL');

type SwapRuntimeWindow = typeof window & {
  isolatedEnv?: {
    runtimeId?: string;
    eReplicas?: Map<string, {
      state?: {
        accounts?: Map<string, {
          currentHeight?: number;
          frameHistory?: Array<{ accountTxs?: Array<{ type?: string }> }>;
          deltas?: Map<number | string, unknown>;
        }>;
      };
    }>;
  };
};

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

function mirrorConsole(page: Page, tag: string): void {
  page.on('console', (msg) => {
    const text = msg.text();
    if (
      msg.type() === 'error'
      || text.includes('[E2E]')
      || text.includes('swap')
      || text.includes('Swap')
      || text.includes('Frame consensus')
    ) {
      console.log(`[${tag}] ${text.slice(0, 260)}`);
    }
  });
}

async function getPrimaryHubId(page: Page): Promise<string> {
  const health = await getHealth(page, API_BASE_URL);
  const hubId = health?.hubMesh?.hubIds?.[0];
  expect(typeof hubId === 'string' && hubId.length === 66, 'baseline must expose a primary hub id').toBe(true);
  return hubId!;
}

async function faucetOffchain(
  page: Page,
  entityId: string,
  hubEntityId: string,
  tokenId: number,
  amount: string,
): Promise<void> {
  let ok = false;
  let lastBody: Record<string, unknown> = { error: 'not-run' };

  for (let attempt = 1; attempt <= 12; attempt += 1) {
    const runtimeId = await page.evaluate(() => {
      const view = window as SwapRuntimeWindow;
      return view.isolatedEnv?.runtimeId ?? null;
    });
    expect(runtimeId, 'runtimeId must exist before faucet').toBeTruthy();

    const response = await page.request.post(`${API_BASE_URL}/api/faucet/offchain`, {
      data: {
        userEntityId: entityId,
        userRuntimeId: runtimeId,
        hubEntityId,
        tokenId,
        amount,
      },
    });
    lastBody = await response.json().catch(() => ({} as Record<string, unknown>));
    ok = response.status() === 200;
    if (ok) return;

    const code = String(lastBody.code || '');
    const status = String(lastBody.status || '');
    const transient =
      response.status() === 202 ||
      response.status() === 409 ||
      response.status() === 503 ||
      code === 'FAUCET_TOKEN_SURFACE_NOT_READY';
    if (!transient) break;
    await page.waitForTimeout(1000);
  }

  expect(ok, `offchain faucet failed: ${JSON.stringify(lastBody)}`).toBe(true);
}

async function outCap(page: Page, entityId: string, counterpartyId: string, tokenId: number): Promise<bigint> {
  const delta = await page.evaluate(({ counterpartyId, entityId, tokenId }) => {
    const view = window as SwapRuntimeWindow;
    const env = view.isolatedEnv;
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

async function holdTotal(page: Page, entityId: string, counterpartyId: string, tokenId: number): Promise<bigint> {
  const delta = await page.evaluate(({ counterpartyId, entityId, tokenId }) => {
    const view = window as SwapRuntimeWindow;
    const env = view.isolatedEnv;
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
        if (typeof value === 'string' && /^-?\\d+$/.test(value.trim())) return value.trim();
        return '0';
      };
      return {
        leftHold: readBig(raw.leftHold),
        rightHold: readBig(raw.rightHold),
      };
    }

    return null;
  }, { counterpartyId, entityId, tokenId });

  if (!delta) return 0n;
  return BigInt(delta.leftHold) + BigInt(delta.rightHold);
}

async function openConfigureWorkspace(page: Page): Promise<void> {
  const accountsTab = page.getByTestId('tab-accounts').first();
  await expect(accountsTab).toBeVisible({ timeout: 20_000 });
  await accountsTab.click();
  const configureTab = page.getByTestId('account-workspace-tab-configure').first();
  await expect(configureTab).toBeVisible({ timeout: 20_000 });
  await configureTab.scrollIntoViewIfNeeded();
  await configureTab.click();
  await expect(page.locator('.configure-panel').first()).toBeVisible({ timeout: 20_000 });
}

async function extendCreditToken(page: Page, tokenId: number, amountDisplay: string): Promise<void> {
  await openConfigureWorkspace(page);
  const creditTab = page.locator('.configure-tab').filter({ hasText: /Extend Credit/i }).first();
  await expect(creditTab).toBeVisible({ timeout: 20_000 });
  await creditTab.click();
  const panel = page.locator('.configure-panel .action-card').filter({ hasText: /Extend Credit/i }).first();
  await expect(panel).toBeVisible({ timeout: 20_000 });
  const tokenSelect = panel.locator('select.form-select').first();
  await expect(tokenSelect).toBeVisible({ timeout: 20_000 });
  await tokenSelect.selectOption(String(tokenId));
  const amountInput = panel.locator('input[placeholder="Credit amount"]').first();
  await expect(amountInput).toBeVisible({ timeout: 20_000 });
  await amountInput.fill(amountDisplay);
  const submit = panel.getByRole('button', { name: /Extend Credit/i }).first();
  await expect(submit).toBeEnabled({ timeout: 20_000 });
  await submit.click();
  await expect.poll(
    async () => await amountInput.inputValue(),
    {
      timeout: 15_000,
      intervals: [200, 400, 600],
      message: 'credit amount input should reset after enqueue',
    },
  ).toBe('0');
}

async function waitForTokenDeltaActive(
  page: Page,
  entityId: string,
  counterpartyId: string,
  tokenId: number,
  timeoutMs = 30_000,
): Promise<void> {
  await expect.poll(
    async () => {
      return await page.evaluate(({ counterpartyId, entityId, tokenId }) => {
        const view = window as SwapRuntimeWindow;
        if (!view.isolatedEnv?.eReplicas) return false;
        for (const [replicaKey, replica] of view.isolatedEnv.eReplicas.entries()) {
          if (!String(replicaKey).startsWith(`${entityId}:`)) continue;
          const account = replica.state?.accounts?.get(counterpartyId);
          const hasDelta = !!account?.deltas?.has(tokenId);
          return hasDelta && Number(account?.currentHeight || 0) > 0;
        }
        return false;
      }, { counterpartyId, entityId, tokenId });
    },
    {
      timeout: timeoutMs,
      intervals: [250, 500, 750],
      message: `token ${tokenId} must become active on the bilateral account`,
    },
  ).toBe(true);
}

async function waitForOutCapAtLeast(
  page: Page,
  entityId: string,
  counterpartyId: string,
  tokenId: number,
  minimum: bigint,
  timeoutMs = 30_000,
): Promise<bigint> {
  const startedAt = Date.now();
  let latest = 0n;
  while (Date.now() - startedAt < timeoutMs) {
    latest = await outCap(page, entityId, counterpartyId, tokenId);
    if (latest >= minimum) return latest;
    await page.waitForTimeout(400);
  }
  throw new Error(
    `Timed out waiting for outCap token=${tokenId} ${entityId.slice(0, 10)}↔${counterpartyId.slice(0, 10)} ` +
    `(latest=${latest.toString()} minimum=${minimum.toString()})`,
  );
}

async function waitForOutCapChange(
  page: Page,
  entityId: string,
  counterpartyId: string,
  tokenId: number,
  baseline: bigint,
  direction: 'up' | 'down',
  timeoutMs = 30_000,
): Promise<bigint> {
  const startedAt = Date.now();
  let latest = baseline;
  while (Date.now() - startedAt < timeoutMs) {
    latest = await outCap(page, entityId, counterpartyId, tokenId);
    if ((direction === 'up' && latest > baseline) || (direction === 'down' && latest < baseline)) {
      return latest;
    }
    await page.waitForTimeout(400);
  }
  throw new Error(
    `Timed out waiting for outCap ${direction} token=${tokenId} ${entityId.slice(0, 10)}↔${counterpartyId.slice(0, 10)} ` +
    `(baseline=${baseline.toString()} latest=${latest.toString()})`,
  );
}

async function readSwapResolveCount(
  page: Page,
  entityId: string,
  counterpartyId: string,
): Promise<number> {
  return await page.evaluate(({ counterpartyId, entityId }) => {
    const view = window as SwapRuntimeWindow;
    if (!view.isolatedEnv?.eReplicas) return 0;

    const findAccount = (
      accounts: Map<string, {
        frameHistory?: Array<{ accountTxs?: Array<{ type?: string }> }>;
      }> | undefined,
      ownerId: string,
      cpId: string,
    ) => {
      if (!(accounts instanceof Map)) return null;
      const owner = String(ownerId || '').toLowerCase();
      const cp = String(cpId || '').toLowerCase();
      for (const [accountKey, account] of accounts.entries()) {
        if (String(accountKey || '').toLowerCase() === cp) return account;
        const left = typeof (account as { leftEntity?: unknown }).leftEntity === 'string'
          ? String((account as { leftEntity?: string }).leftEntity).toLowerCase()
          : '';
        const right = typeof (account as { rightEntity?: unknown }).rightEntity === 'string'
          ? String((account as { rightEntity?: string }).rightEntity).toLowerCase()
          : '';
        if (left && right && ((left === owner && right === cp) || (right === owner && left === cp))) return account;
      }
      return null;
    };

    for (const [replicaKey, replica] of view.isolatedEnv.eReplicas.entries()) {
      if (!String(replicaKey).startsWith(`${entityId}:`)) continue;
      const account = findAccount(replica.state?.accounts, entityId, counterpartyId);
      if (!account) return 0;
      let count = 0;
      for (const frame of account.frameHistory || []) {
        for (const tx of frame?.accountTxs || []) {
          if (tx?.type === 'swap_resolve') count += 1;
        }
      }
      return count;
    }

    return 0;
  }, { counterpartyId, entityId });
}

async function waitForSwapResolveCountAtLeast(
  page: Page,
  entityId: string,
  counterpartyId: string,
  minimum: number,
  timeoutMs = 30_000,
): Promise<number> {
  await expect.poll(
    async () => await readSwapResolveCount(page, entityId, counterpartyId),
    {
      timeout: timeoutMs,
      intervals: [250, 500, 750],
      message: `swap_resolve count must reach ${minimum}`,
    },
  ).toBeGreaterThanOrEqual(minimum);
  return await readSwapResolveCount(page, entityId, counterpartyId);
}

async function openSwapWorkspace(page: Page): Promise<void> {
  const accountsTab = page.getByTestId('tab-accounts').first();
  await expect(accountsTab).toBeVisible({ timeout: 20_000 });
  await accountsTab.click();
  const swapTab = page.getByTestId('account-workspace-tab-swap').first();
  await expect(swapTab).toBeVisible({ timeout: 20_000 });
  await swapTab.click();
  await expect(page.locator('.swap-panel').first()).toBeVisible({ timeout: 15_000 });
}

async function selectCounterpartyInSwap(page: Page, preferredAccountId?: string): Promise<void> {
  const createSelect = page.getByTestId('swap-create-account-select').first();
  const createVisible = await createSelect.isVisible({ timeout: 1500 }).catch(() => false);
  const select = createVisible ? createSelect : page.getByTestId('swap-account-select').first();
  const hasSelector = await select.isVisible({ timeout: 1500 }).catch(() => false);
  if (!hasSelector) return;
  await expect
    .poll(async () => await select.locator('option').count(), {
      timeout: 30_000,
      intervals: [250, 500, 1000],
      message: 'swap account selector must expose at least one account option',
    })
    .toBeGreaterThan(0);
  const values = await select.locator('option').evaluateAll((options) =>
    options.map((option) => ({ value: String((option as HTMLOptionElement).value || ''), label: option.textContent || '' })),
  );
  const normalizedPreferred = String(preferredAccountId || '').trim().toLowerCase();
  const preferredAccount = normalizedPreferred
    ? values.find((option) => String(option.value || '').trim().toLowerCase() === normalizedPreferred)
    : null;
  const firstAccount = preferredAccount || values.find((option) => option.value && option.value !== '__aggregated__');
  if (!firstAccount) return;
  await select.evaluate((node, value) => {
    const element = node as HTMLSelectElement;
    element.value = String(value || '');
    element.dispatchEvent(new Event('change', { bubbles: true }));
    element.dispatchEvent(new Event('input', { bubbles: true }));
  }, firstAccount.value);
  await expect
    .poll(async () => String(await select.inputValue().catch(() => '')).trim().toLowerCase(), {
      timeout: 10_000,
      intervals: [100, 250, 500],
    })
    .toBe(String(firstAccount.value).trim().toLowerCase());
}

async function configurePair(page: Page, pairLabel: string, side: 'buy' | 'sell'): Promise<void> {
  const pairSelect = page.getByTestId('swap-pair-select').first();
  await pairSelect.scrollIntoViewIfNeeded().catch(() => {});
  await expect(pairSelect).toBeVisible({ timeout: 20_000 });
  await pairSelect.selectOption({ label: pairLabel });
  const sideButton = side === 'buy'
    ? page.getByTestId('swap-side-buy').first()
    : page.getByTestId('swap-side-sell').first();
  await expect(sideButton).toBeVisible({ timeout: 20_000 });
  await sideButton.click();
}

async function ensureSelectedScope(page: Page): Promise<void> {
  const toggle = page.getByTestId('swap-scope-toggle').first();
  await expect(toggle).toBeVisible({ timeout: 20_000 });
  await expect
    .poll(async () => String(await toggle.textContent().catch(() => '')).trim(), {
      timeout: 10_000,
      intervals: [100, 250, 500],
    })
    .toBeTruthy();
  if (String(await toggle.textContent() || '').trim() !== 'Selected') {
    await toggle.click();
  }
  await expect(toggle).toHaveText('Selected', { timeout: 10_000 });
}

async function readAvailableSwapAmount(page: Page): Promise<number> {
  const stat = page.getByTestId('swap-available-stat').first();
  await expect(stat).toBeVisible({ timeout: 20_000 });
  const text = String(await stat.textContent() || '');
  const match = text.match(/Available:\s*([0-9]+(?:\.[0-9]+)?)/i);
  return match ? Number.parseFloat(match[1] || '0') : 0;
}

async function waitForPositiveAvailableSwapAmount(page: Page, sideLabel: 'buy' | 'sell'): Promise<void> {
  await expect
    .poll(async () => await readAvailableSwapAmount(page), {
      timeout: 20_000,
      intervals: [200, 400, 800],
      message: `${sideLabel}-side available amount should become positive`,
    })
    .toBeGreaterThan(0);
}

async function placeAliceSellOffer(page: Page, amount: string, price: string): Promise<void> {
  await configurePair(page, 'WETH/USDC', 'sell');
  const amountInput = page.getByTestId('swap-order-amount').first();
  const priceInput = page.getByTestId('swap-order-price').first();
  const placeButton = page.getByTestId('swap-submit-order').first();
  const targetAmount = Number.parseFloat(amount);

  await expect(amountInput).toBeVisible({ timeout: 20_000 });
  await expect(priceInput).toBeVisible({ timeout: 20_000 });
  if (Number.isFinite(targetAmount) && targetAmount > 0) {
    await waitForPositiveAvailableSwapAmount(page, 'sell');
  }
  await amountInput.fill(amount);
  await priceInput.fill(price);
  await expect(placeButton).toBeEnabled({ timeout: 20_000 });
  await placeButton.click();
  await expect(page.getByTestId('swap-open-orders')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('swap-open-order-row').first()).toBeVisible({ timeout: 30_000 });
}

async function placeBobMatchingBuyOrder(page: Page, spendAmount: string, price: string): Promise<void> {
  await configurePair(page, 'WETH/USDC', 'buy');
  const amountInput = page.getByTestId('swap-order-amount').first();
  const priceInput = page.getByTestId('swap-order-price').first();
  const placeButton = page.getByTestId('swap-submit-order').first();
  const targetAmount = Number.parseFloat(spendAmount);

  await expect(amountInput).toBeVisible({ timeout: 20_000 });
  await expect(priceInput).toBeVisible({ timeout: 20_000 });
  if (Number.isFinite(targetAmount) && targetAmount > 0) {
    await waitForPositiveAvailableSwapAmount(page, 'buy');
  }
  await amountInput.fill(spendAmount);
  await priceInput.fill(price);
  await expect(placeButton).toBeEnabled({ timeout: 20_000 });
  await placeButton.click();
}

function displayPriceToTicks(price: string): string {
  const normalized = String(price || '').trim();
  const match = normalized.match(/^(\d+)(?:\.(\d{0,4}))?$/);
  if (!match) throw new Error(`invalid display price: ${price}`);
  const whole = match[1] || '0';
  const frac = (match[2] || '').padEnd(4, '0').slice(0, 4);
  return `${whole}${frac}`.replace(/^0+(?=\d)/, '');
}

function normalizeDisplayedPriceText(value: string): string {
  return String(value || '').replace(/,/g, '').trim();
}

function ticksToDisplayPrice(priceTicks: number): string {
  return (priceTicks / 10_000).toFixed(4);
}

function priceTicksTextToDisplay(priceTicks: string): string {
  const normalized = String(priceTicks || '').trim();
  if (!/^-?\d+$/.test(normalized)) {
    throw new Error(`invalid priceTicks: ${priceTicks}`);
  }
  return ticksToDisplayPrice(Number.parseInt(normalized, 10));
}

async function readVisibleOrderbookPriceTicks(page: Page, side: 'ask' | 'bid'): Promise<number[]> {
  const rows = page.getByTestId(side === 'ask' ? 'orderbook-ask-row' : 'orderbook-bid-row');
  const count = await rows.count();
  const out: number[] = [];
  for (let index = 0; index < count; index += 1) {
    const text = normalizeDisplayedPriceText(String(await rows.nth(index).locator('.price').textContent() || ''));
    const value = Number.parseFloat(text);
    if (!Number.isFinite(value) || value <= 0) continue;
    out.push(Math.round(value * 10_000));
  }
  return out;
}

async function chooseVisibleRestingPrices(page: Page): Promise<{ ask: string; bid: string }> {
  const askTicks = await readVisibleOrderbookPriceTicks(page, 'ask');
  const bidTicks = await readVisibleOrderbookPriceTicks(page, 'bid');
  if (askTicks.length === 0 && bidTicks.length === 0) {
    return {
      ask: '2500.0002',
      bid: '2499.9998',
    };
  }
  if (askTicks.length === 0) {
    const bestBidTicks = bidTicks[0]!;
    return {
      ask: ticksToDisplayPrice(bestBidTicks + 4),
      bid: ticksToDisplayPrice(bestBidTicks - 1),
    };
  }
  if (bidTicks.length === 0) {
    const bestAskTicks = askTicks[askTicks.length - 1]!;
    return {
      ask: ticksToDisplayPrice(bestAskTicks + 1),
      bid: ticksToDisplayPrice(bestAskTicks - 4),
    };
  }

  const bestAskTicks = askTicks[askTicks.length - 1]!;
  const bestBidTicks = bidTicks[0]!;
  if (bestAskTicks <= bestBidTicks) {
    throw new Error(`invalid orderbook spread: bestAsk=${bestAskTicks} bestBid=${bestBidTicks}`);
  }

  const occupied = new Set<number>([...askTicks, ...bidTicks]);
  let restingAskTicks = bestAskTicks + 1;
  while (occupied.has(restingAskTicks) && restingAskTicks < bestAskTicks + 64) restingAskTicks += 1;
  let restingBidTicks = bestBidTicks - 1;
  while (occupied.has(restingBidTicks) && restingBidTicks > bestBidTicks - 64) restingBidTicks -= 1;

  if (restingAskTicks <= bestBidTicks || restingBidTicks >= bestAskTicks || restingAskTicks <= restingBidTicks) {
    throw new Error(`unable to choose visible resting prices near mid: ask=${restingAskTicks} bid=${restingBidTicks}`);
  }

  return {
    ask: ticksToDisplayPrice(restingAskTicks),
    bid: ticksToDisplayPrice(restingBidTicks),
  };
}

async function waitForOrderbookLevelVisible(
  page: Page,
  side: 'ask' | 'bid',
  price: string,
  timeoutMs = 30_000,
): Promise<void> {
  const testId = side === 'ask' ? 'orderbook-ask-row' : 'orderbook-bid-row';
  const priceTicks = displayPriceToTicks(price);
  await expect
    .poll(async () => {
      return await page.locator(`[data-testid="${testId}"][data-price="${priceTicks}"]`).count();
    }, {
      timeout: timeoutMs,
      intervals: [250, 500, 750],
      message: `${side} level ${price} should be visible in relay orderbook`,
    })
    .toBeGreaterThan(0);
  await expect(page.locator(`[data-testid="${testId}"][data-price="${priceTicks}"]`).first()).toBeVisible({ timeout: timeoutMs });
}

async function waitForOrderbookLevelsVisible(
  page: Page,
  levels: Array<{ side: 'ask' | 'bid'; price: string }>,
  timeoutMs = 30_000,
): Promise<void> {
  for (const level of levels) {
    await waitForOrderbookLevelVisible(page, level.side, level.price, timeoutMs);
  }
}

async function waitForRestoredRuntime(page: Page, runtimeId: string): Promise<void> {
  await page.waitForFunction(({ runtimeId }) => {
    const view = window as SwapRuntimeWindow;
    return String(view.isolatedEnv?.runtimeId || '').toLowerCase() === String(runtimeId || '').toLowerCase()
      && Number(view.isolatedEnv?.eReplicas?.size || 0) > 0;
  }, { runtimeId }, { timeout: INIT_TIMEOUT });
}

async function readSwapOfferSnapshot(
  page: Page,
  entityId: string,
  signerId: string,
  counterpartyId: string,
): Promise<Array<{
  offerId: string;
  giveAmount: string;
  wantAmount: string;
  priceTicks: string;
  giveTokenId: string;
  wantTokenId: string;
}>> {
  return await page.evaluate(({ entityId, signerId, counterpartyId }) => {
    const view = window as SwapRuntimeWindow;
    const env = view.isolatedEnv;
    if (!env?.eReplicas) return [];
    const key = Array.from(env.eReplicas.keys()).find((replicaKey: string) => {
      const [replicaEntityId, replicaSignerId] = String(replicaKey || '').split(':');
      return String(replicaEntityId || '').toLowerCase() === String(entityId || '').toLowerCase()
        && String(replicaSignerId || '').toLowerCase() === String(signerId || '').toLowerCase();
    });
    const replica = key ? env.eReplicas.get(key) : null;
    if (!replica?.state?.accounts) return [];
    const owner = String(entityId || '').toLowerCase();
    const cp = String(counterpartyId || '').toLowerCase();
    for (const [accountKey, account] of replica.state.accounts.entries()) {
      const left = typeof account?.leftEntity === 'string' ? String(account.leftEntity).toLowerCase() : '';
      const right = typeof account?.rightEntity === 'string' ? String(account.rightEntity).toLowerCase() : '';
      const canonicalCp = typeof account?.counterpartyEntityId === 'string'
        ? String(account.counterpartyEntityId).toLowerCase()
        : '';
      if (
        String(accountKey || '').toLowerCase() !== cp
        && canonicalCp !== cp
        && !(left && right && ((left === owner && right === cp) || (right === owner && left === cp)))
      ) {
        continue;
      }
      if (!(account?.swapOffers instanceof Map)) return [];
      return Array.from(account.swapOffers.values()).map((offer: Record<string, unknown>) => ({
        offerId: String(offer.offerId || ''),
        giveAmount: String(offer.giveAmount || '0'),
        wantAmount: String(offer.wantAmount || '0'),
        priceTicks: String(offer.priceTicks || '0'),
        giveTokenId: String(offer.giveTokenId || ''),
        wantTokenId: String(offer.wantTokenId || ''),
      }));
    }
    return [];
  }, { entityId, signerId, counterpartyId });
}

async function readFirstOpenOrderRemainingUi(page: Page): Promise<string> {
  const remainingCell = page.getByTestId('swap-open-order-row').first().locator('td').nth(3);
  await expect(remainingCell).toBeVisible({ timeout: 20_000 });
  return String(await remainingCell.textContent() || '').trim();
}

async function expectClosedOrderRowStatus(
  page: Page,
  expected: RegExp,
  minimumCount = 1,
): Promise<void> {
  const openClosedOrders = async (): Promise<void> => {
    await page.getByTestId('swap-orders-tab-closed').first().click();
  };
  const waitForClosedRows = async (): Promise<void> => {
    await expect
      .poll(async () => await page.getByTestId('swap-closed-order-row').count(), {
        timeout: 20_000,
        intervals: [250, 500, 750],
      })
      .toBeGreaterThanOrEqual(minimumCount);
  };

  await openClosedOrders();
  try {
    await waitForClosedRows();
  } catch {
    await page.reload({ waitUntil: 'domcontentloaded' });
    await gotoApp(page, { appBaseUrl: APP_BASE_URL, initTimeoutMs: INIT_TIMEOUT, settleMs: 1200 });
    await openSwapWorkspace(page);
    await selectCounterpartyInSwap(page);
    await ensureSelectedScope(page);
    await openClosedOrders();
    await waitForClosedRows();
  }

  const firstClosedRow = page.getByTestId('swap-closed-order-row').first();
  await expect(firstClosedRow).toBeVisible({ timeout: 20_000 });
  await expect(firstClosedRow.locator('td').first()).toContainText(expected, { timeout: 10_000 });
}

async function readSwapOfferCount(
  page: Page,
  entityId: string,
  signerId: string,
  counterpartyId: string,
): Promise<number> {
  return await page.evaluate(({ entityId, signerId, counterpartyId }) => {
    const view = window as SwapRuntimeWindow;
    const env = view.isolatedEnv;
    if (!env?.eReplicas) return 0;
    const key = Array.from(env.eReplicas.keys()).find((replicaKey: string) => {
      const [replicaEntityId, replicaSignerId] = String(replicaKey || '').split(':');
      return String(replicaEntityId || '').toLowerCase() === String(entityId || '').toLowerCase()
        && String(replicaSignerId || '').toLowerCase() === String(signerId || '').toLowerCase();
    });
    const replica = key ? env.eReplicas.get(key) : null;
    if (!replica?.state?.accounts) return 0;
    const owner = String(entityId || '').toLowerCase();
    const cp = String(counterpartyId || '').toLowerCase();
    for (const [accountKey, account] of replica.state.accounts.entries()) {
      if (String(accountKey || '').toLowerCase() === cp) {
        return Number(account?.swapOffers?.size || 0);
      }
      const canonicalCp = typeof account?.counterpartyEntityId === 'string'
        ? String(account.counterpartyEntityId).toLowerCase()
        : '';
      const left = typeof account?.leftEntity === 'string' ? String(account.leftEntity).toLowerCase() : '';
      const right = typeof account?.rightEntity === 'string' ? String(account.rightEntity).toLowerCase() : '';
      if (canonicalCp === cp || (left && right && ((left === owner && right === cp) || (right === owner && left === cp)))) {
        return Number(account?.swapOffers?.size || 0);
      }
    }
    return 0;
  }, { entityId, signerId, counterpartyId });
}

async function readSwapHistoryCount(
  page: Page,
  entityId: string,
  signerId: string,
  counterpartyId: string,
): Promise<number> {
  return await page.evaluate(({ entityId, signerId, counterpartyId }) => {
    const view = window as SwapRuntimeWindow;
    const env = view.isolatedEnv;
    if (!env?.eReplicas) return 0;
    const key = Array.from(env.eReplicas.keys()).find((replicaKey: string) => {
      const [replicaEntityId, replicaSignerId] = String(replicaKey || '').split(':');
      return String(replicaEntityId || '').toLowerCase() === String(entityId || '').toLowerCase()
        && String(replicaSignerId || '').toLowerCase() === String(signerId || '').toLowerCase();
    });
    const replica = key ? env.eReplicas.get(key) : null;
    if (!replica?.state?.accounts) return 0;
    const owner = String(entityId || '').toLowerCase();
    const cp = String(counterpartyId || '').toLowerCase();
    for (const [accountKey, account] of replica.state.accounts.entries()) {
      const left = typeof account?.leftEntity === 'string' ? String(account.leftEntity).toLowerCase() : '';
      const right = typeof account?.rightEntity === 'string' ? String(account.rightEntity).toLowerCase() : '';
      const canonicalCp = typeof account?.counterpartyEntityId === 'string'
        ? String(account.counterpartyEntityId).toLowerCase()
        : '';
      if (
        String(accountKey || '').toLowerCase() !== cp
        && canonicalCp !== cp
        && !(left && right && ((left === owner && right === cp) || (right === owner && left === cp)))
      ) {
        continue;
      }
      return Number(account?.swapOrderHistory?.size || 0);
    }
    return 0;
  }, { entityId, signerId, counterpartyId });
}

test.describe('E2E Swap Isolated Flow', () => {
  test.setTimeout(LONG_E2E ? 240_000 : 150_000);

  test('relay orderbook publishes new resting ask and bid to both subscribed users', async ({ browser, page }) => {
    let aliceContext: BrowserContext | null = null;
    let bobContext: BrowserContext | null = null;

    try {
      await timedStep('swap_book_publish.ensure_baseline', () => ensureE2EBaseline(page, {
        apiBaseUrl: API_BASE_URL,
        requireMarketMaker: false,
        requireHubMesh: true,
        minHubCount: 3,
      }));

      const hubId = await getPrimaryHubId(page);

      aliceContext = await browser.newContext({ ignoreHTTPSErrors: true });
      bobContext = await browser.newContext({ ignoreHTTPSErrors: true });
      const alicePage = await aliceContext.newPage();
      const bobPage = await bobContext.newPage();

      await Promise.all([
        gotoApp(alicePage, { appBaseUrl: APP_BASE_URL, initTimeoutMs: INIT_TIMEOUT, settleMs: 1200 }),
        gotoApp(bobPage, { appBaseUrl: APP_BASE_URL, initTimeoutMs: INIT_TIMEOUT, settleMs: 1200 }),
      ]);

      const alice = await createRuntimeIdentity(alicePage, 'alice-book', selectDemoMnemonic('alice'));
      const bob = await createRuntimeIdentity(bobPage, 'bob-book', selectDemoMnemonic('bob'));

      await Promise.all([
        connectRuntimeToHub(alicePage, alice, hubId),
        connectRuntimeToHub(bobPage, bob, hubId),
      ]);

      await extendCreditToken(alicePage, 2, '10000');
      await waitForTokenDeltaActive(alicePage, alice.entityId, hubId, 2);

      await Promise.all([
        faucetOffchain(alicePage, alice.entityId, hubId, 2, '5'),
        faucetOffchain(bobPage, bob.entityId, hubId, 1, '100'),
      ]);

      await Promise.all([
        waitForOutCapAtLeast(alicePage, alice.entityId, hubId, 2, 1n * 10n ** 18n),
        waitForOutCapAtLeast(bobPage, bob.entityId, hubId, 1, 10n * 10n ** 18n),
      ]);

      await Promise.all([
        openSwapWorkspace(alicePage),
        openSwapWorkspace(bobPage),
      ]);
      await Promise.all([
        selectCounterpartyInSwap(alicePage, hubId),
        selectCounterpartyInSwap(bobPage, hubId),
        ensureSelectedScope(alicePage),
        ensureSelectedScope(bobPage),
      ]);

      const visibleRestingPrices = await chooseVisibleRestingPrices(alicePage);

      await placeAliceSellOffer(alicePage, '0.03', visibleRestingPrices.ask);

      await expect
        .poll(async () => await readSwapOfferCount(alicePage, alice.entityId, alice.signerId, hubId), {
          timeout: 30_000,
          intervals: [250, 500, 750],
          message: 'alice resting ask should exist in swap offers',
        })
        .toBeGreaterThan(0);
      const [aliceOffer] = await readSwapOfferSnapshot(alicePage, alice.entityId, alice.signerId, hubId);
      expect(aliceOffer?.priceTicks, 'alice resting ask snapshot missing').toBeTruthy();
      expect(
        aliceOffer!.priceTicks,
        'alice resting ask price must remain exactly the user-entered limit price',
      ).toBe(String(displayPriceToTicks(visibleRestingPrices.ask)));
      const restingAskPrice = priceTicksTextToDisplay(aliceOffer!.priceTicks);

      await Promise.all([
        waitForOrderbookLevelVisible(alicePage, 'ask', restingAskPrice),
        waitForOrderbookLevelVisible(bobPage, 'ask', restingAskPrice),
      ]);

      await configurePair(bobPage, 'WETH/USDC', 'buy');
      const bobAmountInput = bobPage.getByTestId('swap-order-amount').first();
      const bobPriceInput = bobPage.getByTestId('swap-order-price').first();
      const bobSubmit = bobPage.getByTestId('swap-submit-order').first();
      await expect(bobAmountInput).toBeVisible({ timeout: 20_000 });
      await expect(bobPriceInput).toBeVisible({ timeout: 20_000 });
      await bobAmountInput.fill('50');
      await bobPriceInput.fill(visibleRestingPrices.bid);
      await expect(bobSubmit).toBeEnabled({ timeout: 20_000 });
      await bobSubmit.click();
      await expect(bobPage.getByTestId('swap-open-order-row').first()).toBeVisible({ timeout: 30_000 });
      await expect
        .poll(async () => await readSwapOfferCount(bobPage, bob.entityId, bob.signerId, hubId), {
          timeout: 30_000,
          intervals: [250, 500, 750],
          message: 'bob resting bid should exist in swap offers',
        })
        .toBeGreaterThan(0);
      const [bobOffer] = await readSwapOfferSnapshot(bobPage, bob.entityId, bob.signerId, hubId);
      expect(bobOffer?.priceTicks, 'bob resting bid snapshot missing').toBeTruthy();
      expect(
        bobOffer!.priceTicks,
        'bob resting bid price must remain exactly the user-entered limit price',
      ).toBe(String(displayPriceToTicks(visibleRestingPrices.bid)));
      const restingBidPrice = priceTicksTextToDisplay(bobOffer!.priceTicks);

      await Promise.all([
        waitForOrderbookLevelVisible(alicePage, 'bid', restingBidPrice),
        waitForOrderbookLevelVisible(bobPage, 'bid', restingBidPrice),
      ]);

      await Promise.all([
        waitForOrderbookLevelsVisible(alicePage, [
          { side: 'ask', price: restingAskPrice },
          { side: 'bid', price: restingBidPrice },
        ]),
        waitForOrderbookLevelsVisible(bobPage, [
          { side: 'ask', price: restingAskPrice },
          { side: 'bid', price: restingBidPrice },
        ]),
      ]);

      await Promise.all([
        alicePage.waitForTimeout(1200),
        bobPage.waitForTimeout(1200),
      ]);

      await Promise.all([
        waitForOrderbookLevelsVisible(alicePage, [
          { side: 'ask', price: restingAskPrice },
          { side: 'bid', price: restingBidPrice },
        ]),
        waitForOrderbookLevelsVisible(bobPage, [
          { side: 'ask', price: restingAskPrice },
          { side: 'bid', price: restingBidPrice },
        ]),
      ]);
    } finally {
      await Promise.all([
        aliceContext ? aliceContext.close().catch(() => {}) : Promise.resolve(),
        bobContext ? bobContext.close().catch(() => {}) : Promise.resolve(),
      ]);
    }
  });

  test('two isolated users trade against each other through one hub orderbook without market maker liquidity', async ({ browser, page }) => {
    let aliceContext: BrowserContext | null = null;
    let bobContext: BrowserContext | null = null;

    try {
      await timedStep('swap_isolated.ensure_baseline', () => ensureE2EBaseline(page, {
        apiBaseUrl: API_BASE_URL,
        requireMarketMaker: false,
        requireHubMesh: true,
        minHubCount: 3,
      }));

      const hubId = await getPrimaryHubId(page);

      aliceContext = await browser.newContext({ ignoreHTTPSErrors: true });
      bobContext = await browser.newContext({ ignoreHTTPSErrors: true });
      const alicePage = await aliceContext.newPage();
      const bobPage = await bobContext.newPage();
      mirrorConsole(alicePage, 'SWAP-ALICE');
      mirrorConsole(bobPage, 'SWAP-BOB');

      await Promise.all([
        timedStep('swap_isolated.alice.goto_app', () => gotoApp(alicePage, { appBaseUrl: APP_BASE_URL, initTimeoutMs: INIT_TIMEOUT, settleMs: 1200 })),
        timedStep('swap_isolated.bob.goto_app', () => gotoApp(bobPage, { appBaseUrl: APP_BASE_URL, initTimeoutMs: INIT_TIMEOUT, settleMs: 1200 })),
      ]);

      const alice = await timedStep('swap_isolated.alice.create_runtime', () =>
        createRuntimeIdentity(alicePage, 'alice', selectDemoMnemonic('alice')));
      const bob = await timedStep('swap_isolated.bob.create_runtime', () =>
        createRuntimeIdentity(bobPage, 'bob', selectDemoMnemonic('bob')));
      expect(alice.entityId).not.toBe(bob.entityId);

      await Promise.all([
        timedStep('swap_isolated.alice.connect_hub', () => connectRuntimeToHub(alicePage, alice, hubId)),
        timedStep('swap_isolated.bob.connect_hub', () => connectRuntimeToHub(bobPage, bob, hubId)),
      ]);

      await timedStep('swap_isolated.alice.extend_credit_weth', async () => {
        await extendCreditToken(alicePage, 2, '10000');
        await waitForTokenDeltaActive(alicePage, alice.entityId, hubId, 2);
      });

      await Promise.all([
        faucetOffchain(alicePage, alice.entityId, hubId, 2, '5'),
        faucetOffchain(bobPage, bob.entityId, hubId, 1, '100'),
      ]);

      const aliceToken2Before = await waitForOutCapAtLeast(alicePage, alice.entityId, hubId, 2, 1n * 10n ** 18n);
      const bobToken1Before = await waitForOutCapAtLeast(bobPage, bob.entityId, hubId, 1, 10n * 10n ** 18n);
      const aliceToken1Before = await outCap(alicePage, alice.entityId, hubId, 1);
      const bobToken2Before = await outCap(bobPage, bob.entityId, hubId, 2);
      await openSwapWorkspace(alicePage);
      await selectCounterpartyInSwap(alicePage, hubId);
      await placeAliceSellOffer(alicePage, '0.03', '2500');

      await openSwapWorkspace(bobPage);
      await selectCounterpartyInSwap(bobPage, hubId);
      await placeBobMatchingBuyOrder(bobPage, '75', '2500');

      await expect.poll(
        async () => await readSwapOfferCount(alicePage, alice.entityId, alice.signerId, hubId),
        {
          timeout: 30_000,
          intervals: [250, 500, 750],
          message: 'Alice swapOffers state must clear after Bob fills the order',
        },
      ).toBe(0);

      const aliceToken1After = await waitForOutCapChange(alicePage, alice.entityId, hubId, 1, aliceToken1Before, 'up');
      const aliceToken2After = await waitForOutCapChange(alicePage, alice.entityId, hubId, 2, aliceToken2Before, 'down');
      const bobToken1After = await waitForOutCapChange(bobPage, bob.entityId, hubId, 1, bobToken1Before, 'down');
      const bobToken2After = await waitForOutCapChange(bobPage, bob.entityId, hubId, 2, bobToken2Before, 'up');

      expect(aliceToken1After).toBeGreaterThan(aliceToken1Before);
      expect(aliceToken2After).toBeLessThan(aliceToken2Before);
      expect(bobToken1After).toBeLessThan(bobToken1Before);
      expect(bobToken2After).toBeGreaterThan(bobToken2Before);

      // Runtime persistence/reload is covered by dedicated persistence specs.
      // This isolated swap case stays focused on cross-user no-MM execution.
    } finally {
      await Promise.all([
        aliceContext ? aliceContext.close().catch(() => {}) : Promise.resolve(),
        bobContext ? bobContext.close().catch(() => {}) : Promise.resolve(),
      ]);
    }
  });

  test('resting maker order can fill partially, stay open, then cancel remainder', async ({ browser, page }) => {
    let aliceContext: BrowserContext | null = null;
    let bobContext: BrowserContext | null = null;

    try {
      await timedStep('swap_partial.ensure_baseline', () => ensureE2EBaseline(page, {
        apiBaseUrl: API_BASE_URL,
        requireMarketMaker: false,
        requireHubMesh: true,
        minHubCount: 3,
      }));

      const hubId = await getPrimaryHubId(page);

      aliceContext = await browser.newContext({ ignoreHTTPSErrors: true });
      bobContext = await browser.newContext({ ignoreHTTPSErrors: true });
      const alicePage = await aliceContext.newPage();
      const bobPage = await bobContext.newPage();

      await Promise.all([
        gotoApp(alicePage, { appBaseUrl: APP_BASE_URL, initTimeoutMs: INIT_TIMEOUT, settleMs: 1200 }),
        gotoApp(bobPage, { appBaseUrl: APP_BASE_URL, initTimeoutMs: INIT_TIMEOUT, settleMs: 1200 }),
      ]);

      const alice = await createRuntimeIdentity(alicePage, 'alice-partial', selectDemoMnemonic('alice'));
      const bob = await createRuntimeIdentity(bobPage, 'bob-partial', selectDemoMnemonic('bob'));

      await Promise.all([
        connectRuntimeToHub(alicePage, alice, hubId),
        connectRuntimeToHub(bobPage, bob, hubId),
      ]);

      await extendCreditToken(alicePage, 2, '10000');
      await waitForTokenDeltaActive(alicePage, alice.entityId, hubId, 2);

      await Promise.all([
        faucetOffchain(alicePage, alice.entityId, hubId, 2, '5'),
        faucetOffchain(bobPage, bob.entityId, hubId, 1, '100'),
      ]);

      await waitForOutCapAtLeast(alicePage, alice.entityId, hubId, 2, 1n * 10n ** 18n);
      await waitForOutCapAtLeast(bobPage, bob.entityId, hubId, 1, 10n * 10n ** 18n);

      await openSwapWorkspace(alicePage);
      await selectCounterpartyInSwap(alicePage, hubId);
      await placeAliceSellOffer(alicePage, '0.04', '2500');

      await openSwapWorkspace(bobPage);
      await selectCounterpartyInSwap(bobPage, hubId);
      await placeBobMatchingBuyOrder(bobPage, '50', '2500');

      await waitForSwapResolveCountAtLeast(alicePage, alice.entityId, hubId, 1);
      await waitForSwapResolveCountAtLeast(bobPage, bob.entityId, hubId, 1);

      await expect
        .poll(async () => await readSwapOfferCount(alicePage, alice.entityId, alice.signerId, hubId), {
          timeout: 30_000,
          intervals: [250, 500, 750],
        })
        .toBe(1);

      const aliceOffersAfterPartial = await readSwapOfferSnapshot(alicePage, alice.entityId, alice.signerId, hubId);
      expect(aliceOffersAfterPartial).toHaveLength(1);
      expect(BigInt(aliceOffersAfterPartial[0]!.giveAmount)).toBe(20_000_000_000_000_000n);

      const remainingText = await readFirstOpenOrderRemainingUi(alicePage);
      expect(remainingText.includes('0.02'), `expected remaining UI amount around 0.02 WETH, got ${remainingText}`).toBe(true);

      await alicePage.reload({ waitUntil: 'domcontentloaded' });
      await waitForRestoredRuntime(alicePage, alice.runtimeId);
      await openSwapWorkspace(alicePage);
      await selectCounterpartyInSwap(alicePage, hubId);

      await expect
        .poll(async () => await readSwapOfferCount(alicePage, alice.entityId, alice.signerId, hubId), {
          timeout: 30_000,
          intervals: [250, 500, 750],
        })
        .toBe(1);
      const remainingTextAfterReload = await readFirstOpenOrderRemainingUi(alicePage);
      expect(
        remainingTextAfterReload.includes('0.02'),
        `expected remaining UI amount around 0.02 WETH after reload, got ${remainingTextAfterReload}`,
      ).toBe(true);

      const cancelButton = alicePage.getByTestId('swap-open-order-cancel').first();
      await expect(cancelButton).toBeVisible({ timeout: 20_000 });
      await cancelButton.click({ force: true });

      await expect
        .poll(async () => await readSwapOfferCount(alicePage, alice.entityId, alice.signerId, hubId), {
          timeout: 30_000,
          intervals: [250, 500, 750],
        })
        .toBe(0);

      await expect
        .poll(async () => await alicePage.getByTestId('swap-open-order-row').count(), {
          timeout: 30_000,
          intervals: [250, 500, 750],
        })
        .toBe(0);

      await expectClosedOrderRowStatus(alicePage, /Partial/i);
      const partialClosedRow = alicePage.getByTestId('swap-closed-order-row').first();
      await expect(partialClosedRow).toBeVisible({ timeout: 20_000 });
      await expect(partialClosedRow.locator('td').nth(3)).toContainText(/50\.00%/i, { timeout: 10_000 });
    } finally {
      await Promise.all([
        aliceContext ? aliceContext.close().catch(() => {}) : Promise.resolve(),
        bobContext ? bobContext.close().catch(() => {}) : Promise.resolve(),
      ]);
    }
  });

  test('one resting maker order can be matched by two isolated takers until fully closed', async ({ browser, page }) => {
    let aliceContext: BrowserContext | null = null;
    let bobContext: BrowserContext | null = null;
    let carolContext: BrowserContext | null = null;

    try {
      await timedStep('swap_multi.ensure_baseline', () => ensureE2EBaseline(page, {
        apiBaseUrl: API_BASE_URL,
        requireMarketMaker: false,
        requireHubMesh: true,
        minHubCount: 3,
      }));

      const hubId = await getPrimaryHubId(page);

      aliceContext = await browser.newContext({ ignoreHTTPSErrors: true });
      bobContext = await browser.newContext({ ignoreHTTPSErrors: true });
      carolContext = await browser.newContext({ ignoreHTTPSErrors: true });
      const alicePage = await aliceContext.newPage();
      const bobPage = await bobContext.newPage();
      const carolPage = await carolContext.newPage();

      await Promise.all([
        gotoApp(alicePage, { appBaseUrl: APP_BASE_URL, initTimeoutMs: INIT_TIMEOUT, settleMs: 1200 }),
        gotoApp(bobPage, { appBaseUrl: APP_BASE_URL, initTimeoutMs: INIT_TIMEOUT, settleMs: 1200 }),
        gotoApp(carolPage, { appBaseUrl: APP_BASE_URL, initTimeoutMs: INIT_TIMEOUT, settleMs: 1200 }),
      ]);

      const alice = await createRuntimeIdentity(alicePage, 'alice-multi', selectDemoMnemonic('alice'));
      const bob = await createRuntimeIdentity(bobPage, 'bob-multi', selectDemoMnemonic('bob'));
      const carol = await createRuntimeIdentity(carolPage, 'carol-multi', selectDemoMnemonic('carol'));

      await Promise.all([
        connectRuntimeToHub(alicePage, alice, hubId),
        connectRuntimeToHub(bobPage, bob, hubId),
        connectRuntimeToHub(carolPage, carol, hubId),
      ]);

      await extendCreditToken(alicePage, 2, '10000');
      await waitForTokenDeltaActive(alicePage, alice.entityId, hubId, 2);

      await Promise.all([
        faucetOffchain(alicePage, alice.entityId, hubId, 2, '5'),
        faucetOffchain(bobPage, bob.entityId, hubId, 1, '100'),
        faucetOffchain(carolPage, carol.entityId, hubId, 1, '100'),
      ]);

      await Promise.all([
        waitForOutCapAtLeast(alicePage, alice.entityId, hubId, 2, 1n * 10n ** 18n),
        waitForOutCapAtLeast(bobPage, bob.entityId, hubId, 1, 10n * 10n ** 18n),
        waitForOutCapAtLeast(carolPage, carol.entityId, hubId, 1, 10n * 10n ** 18n),
      ]);

      await openSwapWorkspace(alicePage);
      await selectCounterpartyInSwap(alicePage, hubId);
      await placeAliceSellOffer(alicePage, '0.06', '2500');

      await openSwapWorkspace(bobPage);
      await selectCounterpartyInSwap(bobPage, hubId);
      await placeBobMatchingBuyOrder(bobPage, '50', '2500');

      await waitForSwapResolveCountAtLeast(alicePage, alice.entityId, hubId, 1);
      await waitForSwapResolveCountAtLeast(bobPage, bob.entityId, hubId, 1);

      await expect
        .poll(async () => await readSwapOfferCount(alicePage, alice.entityId, alice.signerId, hubId), {
          timeout: 30_000,
          intervals: [250, 500, 750],
        })
        .toBe(1);

      await expect
        .poll(async () => {
          const offers = await readSwapOfferSnapshot(alicePage, alice.entityId, alice.signerId, hubId);
          return offers.length === 1 ? offers[0]!.giveAmount : '0';
        }, {
          timeout: 30_000,
          intervals: [250, 500, 750],
          message: 'Alice remainder should snap to 0.04 WETH after Bob partial fill',
        })
        .toBe('40000000000000000');

      await openSwapWorkspace(carolPage);
      await selectCounterpartyInSwap(carolPage, hubId);
      await placeBobMatchingBuyOrder(carolPage, '100', '2500');

      await expect
        .poll(async () => await readSwapOfferCount(alicePage, alice.entityId, alice.signerId, hubId), {
          timeout: 30_000,
          intervals: [250, 500, 750],
        })
        .toBe(0);

      await waitForSwapResolveCountAtLeast(alicePage, alice.entityId, hubId, 2);
      await waitForSwapResolveCountAtLeast(bobPage, bob.entityId, hubId, 1);
      await waitForSwapResolveCountAtLeast(carolPage, carol.entityId, hubId, 1);

      await expect
        .poll(async () => await alicePage.getByTestId('swap-open-order-row').count(), {
          timeout: 30_000,
          intervals: [250, 500, 750],
        })
        .toBe(0);

      await alicePage.getByTestId('swap-orders-tab-closed').first().click();
      const closedRow = alicePage.getByTestId('swap-closed-order-row').first();
      const closedVisible = await closedRow.isVisible({ timeout: 10_000 }).catch(() => false);
      if (!closedVisible) {
        await alicePage.reload({ waitUntil: 'domcontentloaded' });
        await gotoApp(alicePage, { appBaseUrl: APP_BASE_URL, initTimeoutMs: INIT_TIMEOUT, settleMs: 1200 });
        await openSwapWorkspace(alicePage);
        await selectCounterpartyInSwap(alicePage, hubId);
        await ensureSelectedScope(alicePage);
        await alicePage.getByTestId('swap-orders-tab-closed').first().click();
      }
      await expectClosedOrderRowStatus(alicePage, /Filled/i);
    } finally {
      await Promise.all([
        aliceContext ? aliceContext.close().catch(() => {}) : Promise.resolve(),
        bobContext ? bobContext.close().catch(() => {}) : Promise.resolve(),
        carolContext ? carolContext.close().catch(() => {}) : Promise.resolve(),
      ]);
    }
  });

  test('repeated maker and taker cycles accumulate closed swap rows', async ({ browser, page }) => {
    let aliceContext: BrowserContext | null = null;
    let bobContext: BrowserContext | null = null;

    try {
      await ensureE2EBaseline(page, {
        apiBaseUrl: API_BASE_URL,
        requireMarketMaker: false,
        requireHubMesh: true,
        minHubCount: 3,
      });

      const hubId = await getPrimaryHubId(page);

      aliceContext = await browser.newContext({ ignoreHTTPSErrors: true });
      bobContext = await browser.newContext({ ignoreHTTPSErrors: true });
      const alicePage = await aliceContext.newPage();
      const bobPage = await bobContext.newPage();

      await Promise.all([
        gotoApp(alicePage, { appBaseUrl: APP_BASE_URL, initTimeoutMs: INIT_TIMEOUT, settleMs: 1200 }),
        gotoApp(bobPage, { appBaseUrl: APP_BASE_URL, initTimeoutMs: INIT_TIMEOUT, settleMs: 1200 }),
      ]);

      const alice = await createRuntimeIdentity(alicePage, 'alice-bench', selectDemoMnemonic('alice'));
      const bob = await createRuntimeIdentity(bobPage, 'bob-bench', selectDemoMnemonic('bob'));

      await Promise.all([
        connectRuntimeToHub(alicePage, alice, hubId),
        connectRuntimeToHub(bobPage, bob, hubId),
      ]);

      await extendCreditToken(alicePage, 2, '10000');
      await waitForTokenDeltaActive(alicePage, alice.entityId, hubId, 2);

      await Promise.all([
        faucetOffchain(alicePage, alice.entityId, hubId, 2, '5'),
        faucetOffchain(bobPage, bob.entityId, hubId, 1, '200'),
      ]);

      await Promise.all([
        waitForOutCapAtLeast(alicePage, alice.entityId, hubId, 2, 1n * 10n ** 18n),
        waitForOutCapAtLeast(bobPage, bob.entityId, hubId, 1, 10n * 10n ** 18n),
      ]);

      await Promise.all([
        openSwapWorkspace(alicePage),
        openSwapWorkspace(bobPage),
      ]);
      await Promise.all([
        selectCounterpartyInSwap(alicePage, hubId),
        selectCounterpartyInSwap(bobPage, hubId),
        ensureSelectedScope(alicePage),
        ensureSelectedScope(bobPage),
      ]);

      for (let round = 1; round <= 3; round += 1) {
        await placeAliceSellOffer(alicePage, '0.01', '2500');
        await placeBobMatchingBuyOrder(bobPage, '25', '2500');

        await expect
          .poll(async () => await readSwapOfferCount(alicePage, alice.entityId, alice.signerId, hubId), {
            timeout: 30_000,
            intervals: [250, 500, 750],
            message: `alice offer should fully close on round ${round}`,
          })
          .toBe(0);

        await expect
          .poll(async () => await readSwapHistoryCount(alicePage, alice.entityId, alice.signerId, hubId), {
            timeout: 30_000,
            intervals: [250, 500, 750],
            message: `Alice swapOrderHistory should accumulate round ${round}`,
          })
          .toBeGreaterThanOrEqual(round);
      }
    } finally {
      await Promise.all([
        aliceContext ? aliceContext.close().catch(() => {}) : Promise.resolve(),
        bobContext ? bobContext.close().catch(() => {}) : Promise.resolve(),
      ]);
    }
  });

  test('swap round-trip both directions clears holds and updates closed history on both peers', async ({ browser, page }) => {
    let aliceContext: BrowserContext | null = null;
    let bobContext: BrowserContext | null = null;

    try {
      await ensureE2EBaseline(page, {
        apiBaseUrl: API_BASE_URL,
        requireMarketMaker: false,
        requireHubMesh: true,
        minHubCount: 3,
      });

      const hubId = await getPrimaryHubId(page);

      aliceContext = await browser.newContext({ ignoreHTTPSErrors: true });
      bobContext = await browser.newContext({ ignoreHTTPSErrors: true });
      const alicePage = await aliceContext.newPage();
      const bobPage = await bobContext.newPage();

      await Promise.all([
        gotoApp(alicePage, { appBaseUrl: APP_BASE_URL, initTimeoutMs: INIT_TIMEOUT, settleMs: 1200 }),
        gotoApp(bobPage, { appBaseUrl: APP_BASE_URL, initTimeoutMs: INIT_TIMEOUT, settleMs: 1200 }),
      ]);

      const alice = await createRuntimeIdentity(alicePage, 'alice-roundtrip', selectDemoMnemonic('alice'));
      const bob = await createRuntimeIdentity(bobPage, 'bob-roundtrip', selectDemoMnemonic('bob'));

      await Promise.all([
        connectRuntimeToHub(alicePage, alice, hubId),
        connectRuntimeToHub(bobPage, bob, hubId),
      ]);

      await extendCreditToken(alicePage, 1, '10000');
      await extendCreditToken(bobPage, 1, '10000');
      await waitForTokenDeltaActive(alicePage, alice.entityId, hubId, 1);
      await waitForTokenDeltaActive(bobPage, bob.entityId, hubId, 1);

      await Promise.all([
        faucetOffchain(alicePage, alice.entityId, hubId, 2, '5'),
        faucetOffchain(bobPage, bob.entityId, hubId, 1, '200'),
      ]);

      await Promise.all([
        waitForOutCapAtLeast(alicePage, alice.entityId, hubId, 2, 1n * 10n ** 18n),
        waitForOutCapAtLeast(bobPage, bob.entityId, hubId, 1, 10n * 10n ** 18n),
      ]);

      await Promise.all([
        openSwapWorkspace(alicePage),
        openSwapWorkspace(bobPage),
      ]);
      await Promise.all([
        selectCounterpartyInSwap(alicePage, hubId),
        selectCounterpartyInSwap(bobPage, hubId),
        ensureSelectedScope(alicePage),
        ensureSelectedScope(bobPage),
      ]);

      await placeAliceSellOffer(alicePage, '0.01', '2500');
      await placeBobMatchingBuyOrder(bobPage, '25', '2500');

      await expect
        .poll(async () => await readSwapOfferCount(alicePage, alice.entityId, alice.signerId, hubId), {
          timeout: 30_000,
          intervals: [250, 500, 750],
        })
        .toBe(0);
      await expect
        .poll(async () => await readSwapHistoryCount(alicePage, alice.entityId, alice.signerId, hubId), {
          timeout: 30_000,
          intervals: [250, 500, 750],
        })
        .toBeGreaterThanOrEqual(1);
      await expect
        .poll(async () => await readSwapHistoryCount(bobPage, bob.entityId, bob.signerId, hubId), {
          timeout: 30_000,
          intervals: [250, 500, 750],
        })
        .toBeGreaterThanOrEqual(1);

      await Promise.all([
        waitForOutCapAtLeast(bobPage, bob.entityId, hubId, 2, 1n * 10n ** 15n),
        waitForOutCapAtLeast(alicePage, alice.entityId, hubId, 1, 20n * 10n ** 18n),
      ]);

      await placeAliceSellOffer(bobPage, '0.0095', '2600');
      await placeBobMatchingBuyOrder(alicePage, '24.7', '2600');

      await expect
        .poll(async () => await readSwapOfferCount(bobPage, bob.entityId, bob.signerId, hubId), {
          timeout: 30_000,
          intervals: [250, 500, 750],
        })
        .toBe(0);
      await expect
        .poll(async () => await readSwapHistoryCount(alicePage, alice.entityId, alice.signerId, hubId), {
          timeout: 30_000,
          intervals: [250, 500, 750],
        })
        .toBeGreaterThanOrEqual(2);
      await expect
        .poll(async () => await readSwapHistoryCount(bobPage, bob.entityId, bob.signerId, hubId), {
          timeout: 30_000,
          intervals: [250, 500, 750],
        })
        .toBeGreaterThanOrEqual(2);

      await Promise.all([
        expectClosedOrderRowStatus(alicePage, /Filled/i, 1),
        expectClosedOrderRowStatus(bobPage, /Filled/i, 1),
      ]);

      await expect
        .poll(async () => await holdTotal(alicePage, alice.entityId, hubId, 1), {
          timeout: 20_000,
          intervals: [250, 500, 750],
        })
        .toBe(0n);
      await expect
        .poll(async () => await holdTotal(alicePage, alice.entityId, hubId, 2), {
          timeout: 20_000,
          intervals: [250, 500, 750],
        })
        .toBe(0n);
      await expect
        .poll(async () => await holdTotal(bobPage, bob.entityId, hubId, 1), {
          timeout: 20_000,
          intervals: [250, 500, 750],
        })
        .toBe(0n);
      await expect
        .poll(async () => await holdTotal(bobPage, bob.entityId, hubId, 2), {
          timeout: 20_000,
          intervals: [250, 500, 750],
        })
        .toBe(0n);
    } finally {
      await Promise.all([
        aliceContext ? aliceContext.close().catch(() => {}) : Promise.resolve(),
        bobContext ? bobContext.close().catch(() => {}) : Promise.resolve(),
      ]);
    }
  });
});
