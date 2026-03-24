import { expect, test, type Browser, type Page } from '@playwright/test';

import { ensureE2EBaseline, APP_BASE_URL } from './utils/e2e-baseline';
import { createRuntimeIdentity, gotoApp, selectDemoMnemonic } from './utils/e2e-demo-users';
import { connectHub } from './utils/e2e-connect';
import { getRenderedExternalBalance, getRenderedReserveBalance } from './utils/e2e-account-ui';

const TOKEN_ID_USDC = 1;

type RuntimeRef = {
  entityId: string;
  signerId: string;
  runtimeId: string;
};

type DebtSnapshot = {
  debtId: string;
  status: string;
  createdAmount: string;
  paidAmount: string;
  remainingAmount: string;
  forgivenAmount: string;
  updates: string[];
};

async function newRuntimePage(browser: Browser, label: 'alice' | 'bob'): Promise<{ page: Page; runtime: RuntimeRef }> {
  const context = await browser.newContext();
  const page = await context.newPage();
  await gotoApp(page, { appBaseUrl: APP_BASE_URL });
  const runtime = await createRuntimeIdentity(page, label, selectDemoMnemonic(label));
  return { page, runtime };
}

async function readFirstHubId(page: Page): Promise<string> {
  const health = await ensureE2EBaseline(page, { requireMarketMaker: false });
  const hubId = health.hubMesh?.hubIds?.[0];
  expect(typeof hubId === 'string' && hubId.length > 0, 'hub id must exist').toBe(true);
  return hubId!;
}

async function openAccountsWorkspace(page: Page): Promise<void> {
  const backToEntity = page.getByRole('button', { name: /Back to Entity/i }).first();
  if (await backToEntity.isVisible().catch(() => false)) {
    await backToEntity.click();
  }
  const accountsTab = page.getByTestId('tab-accounts').first();
  if (await accountsTab.isVisible().catch(() => false)) {
    await accountsTab.click();
    return;
  }
  const navAccounts = page.getByRole('button', { name: /^Accounts$/i }).first();
  if (await navAccounts.isVisible().catch(() => false)) {
    await navAccounts.click();
    return;
  }
  const accountWorkspaceNav = page.locator('nav[aria-label="Account workspace"]').first();
  await expect(accountWorkspaceNav).toBeVisible({ timeout: 20_000 });
}

async function openWorkspaceTab(page: Page, label: RegExp): Promise<void> {
  await openAccountsWorkspace(page);
  const tab = page.locator('.account-workspace-tab').filter({ hasText: label }).first();
  await expect(tab).toBeVisible({ timeout: 20_000 });
  await tab.click();
}

async function focusWorkspaceAccount(page: Page, counterpartyId: string): Promise<void> {
  await openAccountsWorkspace(page);
  const preview = page.locator(`.account-preview[data-counterparty-id="${counterpartyId}"]`).first();
  await expect(preview).toBeVisible({ timeout: 20_000 });
  const statusIndicator = preview.locator('.status-indicator').first();
  await expect(statusIndicator).toBeVisible({ timeout: 20_000 });
  await statusIndicator.hover();
  const exploreButton = preview.locator('.popover-explore-btn').first();
  await expect(exploreButton).toBeVisible({ timeout: 20_000 });
  await exploreButton.click();
  await expect(page.getByRole('button', { name: /Back to Entity/i }).first()).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('.account-panel .header-identity').filter({ hasText: counterpartyId }).first()).toBeVisible({ timeout: 20_000 });
}

async function readAccountProgress(
  page: Page,
  entityId: string,
  signerId: string,
  counterpartyId: string,
): Promise<{ exists: boolean; pendingFrame: boolean; currentHeight: number }> {
  return page.evaluate(({ entityId, signerId, counterpartyId }) => {
    const env = (window as any).isolatedEnv;
    if (!env?.eReplicas) return { exists: false, pendingFrame: false, currentHeight: 0 };
    const key = Array.from(env.eReplicas.keys()).find((k: string) => {
      const [eid, sid] = String(k).split(':');
      return String(eid || '').toLowerCase() === String(entityId).toLowerCase()
        && String(sid || '').toLowerCase() === String(signerId).toLowerCase();
    });
    const rep = key ? env.eReplicas.get(key) : null;
    const account = rep?.state?.accounts?.get?.(counterpartyId);
    return {
      exists: !!account,
      pendingFrame: !!account?.pendingFrame,
      currentHeight: Number(account?.currentHeight || 0),
    };
  }, { entityId, signerId, counterpartyId });
}

async function ensurePrivateAccountOpenViaUi(
  page: Page,
  entityId: string,
  signerId: string,
  counterpartyId: string,
): Promise<void> {
  const already = await readAccountProgress(page, entityId, signerId, counterpartyId);
  if (already.exists && !already.pendingFrame && already.currentHeight > 0) return;

  await openWorkspaceTab(page, /Open Account/i);
  const privateInput = page.locator('.open-private-form .entity-input input').first();
  await expect(privateInput).toBeVisible({ timeout: 20_000 });
  await privateInput.fill(counterpartyId);
  await privateInput.press('Tab');

  const openButton = page.locator('.open-private-form .btn-add').first();
  await expect(openButton).toBeEnabled({ timeout: 20_000 });
  await openButton.click();

  await expect
    .poll(async () => {
      const state = await readAccountProgress(page, entityId, signerId, counterpartyId);
      return state.exists && !state.pendingFrame && state.currentHeight > 0;
    }, { timeout: 60_000, intervals: [500, 1000, 2000] })
    .toBe(true);
}

async function selectConfigureAccount(page: Page, counterpartyId: string): Promise<void> {
  const selector = page.getByTestId('configure-account-selector').first();
  await expect(selector).toBeVisible({ timeout: 20_000 });
  const closedTrigger = selector.locator('.closed-trigger').first();
  if (await closedTrigger.isVisible().catch(() => false)) {
    const currentText = await closedTrigger.textContent().catch(() => '');
    if (String(currentText || '').toLowerCase().includes(counterpartyId.toLowerCase().slice(0, 10))) return;
    await closedTrigger.click();
  }
  const input = selector.locator('input').first();
  await expect(input).toBeVisible({ timeout: 20_000 });
  await input.click();
  await input.fill(counterpartyId);
  await input.press('Tab');
  await expect
    .poll(async () => {
      const trigger = selector.locator('.closed-trigger').first();
      const text = await trigger.textContent().catch(() => '');
      return String(text || '').toLowerCase();
    }, { timeout: 20_000, intervals: [200, 500, 1000] })
    .toContain(counterpartyId.toLowerCase().slice(0, 12));
}

async function openConfigureWorkspace(page: Page, counterpartyId: string): Promise<void> {
  await openWorkspaceTab(page, /Configure/i);
  await expect(page.locator('.configure-panel').first()).toBeVisible({ timeout: 20_000 });
  await selectConfigureAccount(page, counterpartyId);
}

async function extendCreditToken(page: Page, counterpartyId: string, tokenId: number, amountDisplay: string): Promise<void> {
  await openConfigureWorkspace(page, counterpartyId);
  const creditTab = page.locator('.configure-tab').filter({ hasText: /Extend Credit/i }).first();
  await expect(creditTab).toBeVisible({ timeout: 20_000 });
  await creditTab.click();
  const panel = page.locator('.configure-panel .action-card').filter({ hasText: /Extend Credit/i }).first();
  await expect(panel).toBeVisible({ timeout: 20_000 });
  const tokenSelect = panel.locator('select.form-select').first();
  await tokenSelect.selectOption(String(tokenId));
  const amountInput = panel.locator('input[placeholder="Credit amount"]').first();
  await amountInput.fill(amountDisplay);
  const submit = panel.getByRole('button', { name: /^Extend Credit$/ }).first();
  await expect(submit).toBeEnabled({ timeout: 20_000 });
  await submit.click();
  await expect.poll(async () => amountInput.inputValue(), { timeout: 15_000 }).toBe('0');
}

async function sendDirectPayment(page: Page, recipientId: string, amount: string): Promise<void> {
  await openWorkspaceTab(page, /Pay/i);
  const payPanel = page.locator('.payment-panel').first();
  await expect(payPanel).toBeVisible({ timeout: 20_000 });

  const recipientEntityInput = payPanel.locator('.recipient-picker-row .entity-input').first();
  const recipientTrigger = recipientEntityInput.locator('.closed-trigger').first();
  if (await recipientTrigger.isVisible().catch(() => false)) {
    await recipientTrigger.click();
  } else {
    const recipientInput = recipientEntityInput.locator('input').first();
    await expect(recipientInput).toBeVisible({ timeout: 10_000 });
    await recipientInput.fill(recipientId);
    await recipientInput.press('Tab');
  }
  const recipientOption = page.locator('.dropdown-item').filter({ hasText: recipientId }).first();
  await expect(recipientOption).toBeVisible({ timeout: 10_000 });
  await recipientOption.click();

  const amountInput = page.locator('#payment-amount-input');
  await expect(amountInput).toBeVisible({ timeout: 10_000 });
  await amountInput.fill(amount);

  const findRoutesBtn = page.getByRole('button', { name: 'Find Routes' }).first();
  await expect(findRoutesBtn).toBeEnabled({ timeout: 10_000 });
  await findRoutesBtn.click();

  await expect(page.locator('.route-option').first()).toBeVisible({ timeout: 15_000 });
  const payNow = page.getByRole('button', { name: /Send On Selected Route|Pay Now/i }).first();
  await expect(payNow).toBeEnabled({ timeout: 10_000 });
  await payNow.click();
}

async function queueAndBroadcastDisputeStart(page: Page, counterpartyId: string): Promise<void> {
  await openConfigureWorkspace(page, counterpartyId);
  const disputeTab = page.locator('.configure-tab').filter({ hasText: /^Dispute$/i }).first();
  await expect(disputeTab).toBeVisible({ timeout: 20_000 });
  await disputeTab.click();
  await selectConfigureAccount(page, counterpartyId);
  const startButton = page.getByTestId('configure-dispute-start').first();
  await expect(startButton).toBeVisible({ timeout: 20_000 });
  await startButton.click();
  const broadcast = page.getByTestId('settle-sign-broadcast').first();
  await expect(broadcast).toBeEnabled({ timeout: 20_000 });
  await broadcast.click();
}

async function queueAndBroadcastDisputeFinalize(page: Page, counterpartyId: string): Promise<void> {
  await openConfigureWorkspace(page, counterpartyId);
  const disputeTab = page.locator('.configure-tab').filter({ hasText: /^Dispute$/i }).first();
  await disputeTab.click();
  await selectConfigureAccount(page, counterpartyId);
  const finalizeButton = page.getByTestId('configure-dispute-finalize').first();
  await expect(finalizeButton).toBeVisible({ timeout: 20_000 });
  await finalizeButton.click();
  const broadcast = page.getByTestId('settle-sign-broadcast').first();
  await expect(broadcast).toBeEnabled({ timeout: 20_000 });
  await broadcast.click();
}

async function readAccountState(
  page: Page,
  entityId: string,
  signerId: string,
  counterpartyId: string,
): Promise<{ activeDispute: boolean; disputeTimeout: number }> {
  return page.evaluate(({ entityId, signerId, counterpartyId }) => {
    const env = (window as any).isolatedEnv;
    if (!env?.eReplicas) return { activeDispute: false, disputeTimeout: 0 };
    const key = Array.from(env.eReplicas.keys()).find((k: string) => {
      const [eid, sid] = String(k).split(':');
      return String(eid || '').toLowerCase() === String(entityId).toLowerCase()
        && String(sid || '').toLowerCase() === String(signerId).toLowerCase();
    });
    const rep = key ? env.eReplicas.get(key) : null;
    const account = rep?.state?.accounts?.get?.(counterpartyId);
    return {
      activeDispute: !!account?.activeDispute,
      disputeTimeout: Number(account?.activeDispute?.disputeTimeout || 0),
    };
  }, { entityId, signerId, counterpartyId });
}

async function readCurrentChainBlock(page: Page): Promise<number> {
  const response = await page.request.post(`${APP_BASE_URL}/api/rpc`, {
    data: { jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] },
  });
  expect(response.ok()).toBe(true);
  const body = await response.json() as { result?: string };
  return Number.parseInt(String(body.result || '0x0'), 16);
}

async function mineOneBlock(page: Page): Promise<void> {
  const response = await page.request.post(`${APP_BASE_URL}/api/rpc`, {
    data: { jsonrpc: '2.0', id: 1, method: 'evm_mine', params: [] },
  });
  expect(response.ok(), 'evm_mine RPC must succeed').toBe(true);
}

async function waitForBlock(page: Page, targetBlock: number): Promise<void> {
  const deadline = Date.now() + 45_000;
  for (;;) {
    const current = await readCurrentChainBlock(page);
    if (current >= targetBlock) return;
    await mineOneBlock(page);
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for block ${targetBlock}, current=${current}`);
    }
  }
}

async function readDebtSnapshot(
  page: Page,
  entityId: string,
  signerId: string,
  counterpartyId: string,
  direction: 'out' | 'in',
  tokenId = TOKEN_ID_USDC,
): Promise<DebtSnapshot | null> {
  return page.evaluate(({ entityId, signerId, counterpartyId, direction, tokenId }) => {
    const env = (window as any).isolatedEnv;
    if (!env?.eReplicas) return null;
    const key = Array.from(env.eReplicas.keys()).find((k: string) => {
      const [eid, sid] = String(k).split(':');
      return String(eid || '').toLowerCase() === String(entityId).toLowerCase()
        && String(sid || '').toLowerCase() === String(signerId).toLowerCase();
    });
    const rep = key ? env.eReplicas.get(key) : null;
    const ledger = direction === 'out' ? rep?.state?.outDebtsByToken : rep?.state?.inDebtsByToken;
    const bucket = ledger?.get?.(tokenId);
    if (!bucket) return null;
    const match = Array.from(bucket.values()).find((entry: any) =>
      String(entry?.counterparty || '').toLowerCase() === String(counterpartyId || '').toLowerCase(),
    );
    if (!match) return null;
    return {
      debtId: String(match.debtId || ''),
      status: String(match.status || ''),
      createdAmount: String(match.createdAmount || '0'),
      paidAmount: String(match.paidAmount || '0'),
      remainingAmount: String(match.remainingAmount || '0'),
      forgivenAmount: String(match.forgivenAmount || '0'),
      updates: Array.isArray(match.updates) ? match.updates.map((update: any) => String(update?.eventType || '')) : [],
    };
  }, { entityId, signerId, counterpartyId, direction, tokenId });
}

async function waitForDebtSnapshot(
  page: Page,
  entityId: string,
  signerId: string,
  counterpartyId: string,
  direction: 'out' | 'in',
  expectedRemaining: string,
  expectedPaid: string,
): Promise<DebtSnapshot> {
  let latest: DebtSnapshot | null = null;
  await expect.poll(async () => {
    latest = await readDebtSnapshot(page, entityId, signerId, counterpartyId, direction);
    if (!latest) return 'missing';
    return `${latest.status}:${latest.remainingAmount}:${latest.paidAmount}`;
  }, { timeout: 45_000, intervals: [500, 1000, 1500] }).toBe(`open:${expectedRemaining}:${expectedPaid}`);
  return latest!;
}

async function faucetReserve(page: Page, symbol = 'USDC'): Promise<void> {
  const assetsTab = page.getByTestId('tab-assets').first();
  await assetsTab.click();
  const symbolSelect = page.getByTestId('asset-faucet-symbol').first();
  await expect(symbolSelect).toBeVisible({ timeout: 20_000 });
  await symbolSelect.selectOption(symbol);
  const reserveButton = page.getByTestId(`reserve-faucet-${symbol}`).first();
  await expect(reserveButton).toBeEnabled({ timeout: 20_000 });
  await reserveButton.click();
}

async function openReserveToExternalMove(page: Page, amount: string, recipient: string): Promise<void> {
  const assetsTab = page.getByTestId('tab-assets').first();
  await assetsTab.click();
  await page.getByTestId('asset-tab-move').first().click();
  await page.getByTestId('move-source-reserve').first().click();
  await page.getByTestId('move-target-external').first().click();
  await page.getByTestId('move-external-recipient').first().fill(recipient);
  await page.getByTestId('move-amount').first().fill(amount);
}

test.describe('debt ledger', () => {
  test('mirrors debts on both sides and only explicit enforce repays partial debt', async ({ browser }) => {
    test.setTimeout(240_000);

    const setupContext = await browser.newContext();
    const setupPage = await setupContext.newPage();
    await gotoApp(setupPage, { appBaseUrl: APP_BASE_URL });
    const hubId = await readFirstHubId(setupPage);
    await setupContext.close();

    const aliceRuntime = await newRuntimePage(browser, 'alice');
    const bobRuntime = await newRuntimePage(browser, 'bob');
    const alicePage = aliceRuntime.page;
    const bobPage = bobRuntime.page;
    const alice = aliceRuntime.runtime;
    const bob = bobRuntime.runtime;

    await connectHub(alicePage, hubId);
    await connectHub(bobPage, hubId);

    await ensurePrivateAccountOpenViaUi(alicePage, alice.entityId, alice.signerId, bob.entityId);
    await ensurePrivateAccountOpenViaUi(bobPage, bob.entityId, bob.signerId, alice.entityId);

    await extendCreditToken(alicePage, bob.entityId, TOKEN_ID_USDC, '1000');
    await sendDirectPayment(bobPage, alice.entityId, '150');

    await queueAndBroadcastDisputeStart(alicePage, bob.entityId);
    await expect
      .poll(async () => (await readAccountState(alicePage, alice.entityId, alice.signerId, bob.entityId)).activeDispute, {
        timeout: 45_000,
        intervals: [500, 1000, 1500],
      })
      .toBe(true);

    const activeDispute = await readAccountState(alicePage, alice.entityId, alice.signerId, bob.entityId);
    const currentBlock = await readCurrentChainBlock(alicePage);
    await waitForBlock(alicePage, Math.max(currentBlock, activeDispute.disputeTimeout));
    await queueAndBroadcastDisputeFinalize(alicePage, bob.entityId);

    const aliceIncoming = await waitForDebtSnapshot(alicePage, alice.entityId, alice.signerId, bob.entityId, 'in', '150', '0');
    const bobOutgoing = await waitForDebtSnapshot(bobPage, bob.entityId, bob.signerId, alice.entityId, 'out', '150', '0');

    expect(aliceIncoming.createdAmount).toBe('150');
    expect(aliceIncoming.updates).toEqual(['DebtCreated']);
    expect(bobOutgoing.createdAmount).toBe('150');
    expect(bobOutgoing.updates).toEqual(['DebtCreated']);

    await faucetReserve(bobPage, 'USDC');
    await expect.poll(async () => await getRenderedReserveBalance(bobPage, 'USDC'), {
      timeout: 20_000,
      intervals: [500, 1000],
    }).toBeGreaterThanOrEqual(100);

    await openReserveToExternalMove(bobPage, '10', bob.signerId);
    await expect(bobPage.getByTestId('move-confirm').first()).toBeDisabled({ timeout: 10_000 });

    await openAccountsWorkspace(bobPage);
    const enforceButton = bobPage.getByTestId(`debt-enforce-${TOKEN_ID_USDC}`).first();
    await expect(enforceButton).toBeVisible({ timeout: 20_000 });
    await enforceButton.click();

    await expect
      .poll(async () => {
        const value = await readDebtSnapshot(bobPage, bob.entityId, bob.signerId, alice.entityId, 'out');
        return `${value?.remainingAmount || 'missing'}:${value?.paidAmount || 'missing'}`;
      }, {
        timeout: 45_000,
        intervals: [500, 1000, 1500],
      })
      .toBe('50:100');

    const afterPartial = await readDebtSnapshot(bobPage, bob.entityId, bob.signerId, alice.entityId, 'out');
    expect(afterPartial?.updates).toEqual(['DebtCreated', 'DebtEnforced']);

    await faucetReserve(bobPage, 'USDC');
    await expect.poll(async () => await getRenderedReserveBalance(bobPage, 'USDC'), {
      timeout: 20_000,
      intervals: [500, 1000],
    }).toBeGreaterThanOrEqual(50);
    await bobPage.getByTestId(`debt-enforce-${TOKEN_ID_USDC}`).first().click();

    await expect
      .poll(async () => {
        const value = await readDebtSnapshot(bobPage, bob.entityId, bob.signerId, alice.entityId, 'out');
        return `${value?.status || 'missing'}:${value?.remainingAmount || 'missing'}:${value?.paidAmount || 'missing'}`;
      }, {
        timeout: 45_000,
        intervals: [500, 1000, 1500],
      })
      .toBe('paid:0:150');

    await faucetReserve(bobPage, 'USDC');
    const externalBefore = await getRenderedExternalBalance(bobPage, 'USDC');
    await openReserveToExternalMove(bobPage, '20', bob.signerId);
    const moveConfirm = bobPage.getByTestId('move-confirm').first();
    await expect(moveConfirm).toBeEnabled({ timeout: 20_000 });
    await moveConfirm.click();
    const broadcast = bobPage.getByTestId('settle-sign-broadcast').first();
    await expect(broadcast).toBeEnabled({ timeout: 20_000 });
    await broadcast.click();

    await expect.poll(async () => await getRenderedExternalBalance(bobPage, 'USDC'), {
      timeout: 45_000,
      intervals: [500, 1000, 1500],
    }).toBeGreaterThan(externalBefore);

    await alicePage.context().close();
    await bobPage.context().close();
  });
});
