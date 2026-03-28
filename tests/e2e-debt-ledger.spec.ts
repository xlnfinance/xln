import { expect, test, type Browser, type Page } from '@playwright/test';
import { Interface } from 'ethers';

import { ensureE2EBaseline, APP_BASE_URL } from './utils/e2e-baseline';
import { createRuntimeIdentity, gotoApp, selectDemoMnemonic } from './utils/e2e-demo-users';
import { connectHub } from './utils/e2e-connect';
import { getRenderedExternalBalance, getRenderedReserveBalance } from './utils/e2e-account-ui';

const TOKEN_ID_USDC = 1;
const TOKEN_SCALE = 10n ** 18n;
const USD_150 = (150n * TOKEN_SCALE).toString();
const USD_100 = (100n * TOKEN_SCALE).toString();
const USD_50 = (50n * TOKEN_SCALE).toString();
const ERC20_BALANCE_OF = new Interface(['function balanceOf(address) view returns (uint256)']);

type RuntimeRef = {
  entityId: string;
  signerId: string;
  runtimeId: string;
};

type DebtSnapshot = {
  debtId: string;
  status: string;
  createdAmount: bigint;
  paidAmount: bigint;
  remainingAmount: bigint;
  forgivenAmount: bigint;
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

async function getApiToken(page: Page, symbol: string): Promise<{ address: string; tokenId: number }> {
  const response = await page.request.get(`${APP_BASE_URL}/api/tokens`);
  expect(response.ok(), 'token catalog request must succeed').toBe(true);
  const body = await response.json().catch(() => ({})) as {
    tokens?: Array<{ symbol?: string; address?: string; tokenId?: number }>;
  };
  const match = Array.isArray(body.tokens)
    ? body.tokens.find((entry) => String(entry.symbol || '').toUpperCase() === symbol.toUpperCase())
    : null;
  expect(match?.address, `token ${symbol} must exist`).toBeTruthy();
  expect(typeof match?.tokenId === 'number', `token ${symbol} must have tokenId`).toBe(true);
  return { address: String(match!.address), tokenId: Number(match!.tokenId) };
}

async function rpcCall<T>(page: Page, method: string, params: unknown[]): Promise<T> {
  const response = await page.request.post(`${APP_BASE_URL}/api/rpc`, {
    data: { jsonrpc: '2.0', id: 1, method, params },
  });
  expect(response.ok(), `${method} RPC must succeed`).toBe(true);
  const body = await response.json().catch(() => ({})) as { error?: unknown; result?: T };
  expect(body.error, `${method} RPC must not return error: ${JSON.stringify(body.error || null)}`).toBeUndefined();
  return body.result as T;
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

async function readOnchainReserveBalanceRaw(page: Page, entityId: string, symbol: string): Promise<bigint> {
  const token = await getApiToken(page, symbol);
  const response = await page.request.get(
    `${APP_BASE_URL}/api/debug/reserve?entityId=${encodeURIComponent(entityId)}&tokenId=${encodeURIComponent(String(token.tokenId))}`,
  );
  expect(response.ok(), `debug reserve request must succeed for ${symbol}`).toBe(true);
  const body = await response.json().catch(() => ({})) as { reserve?: string };
  expect(typeof body.reserve === 'string', `debug reserve body must include reserve for ${symbol}`).toBe(true);
  return BigInt(body.reserve || '0');
}

async function openAccountsWorkspace(page: Page): Promise<void> {
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

async function openAssetsTab(page: Page): Promise<void> {
  const tab = page.getByTestId('tab-assets').first();
  await expect(tab).toBeVisible({ timeout: 20_000 });
  await tab.click();
  await expect(page.getByTestId('asset-ledger-refresh').first()).toBeVisible({ timeout: 20_000 });
}

async function ensureSelfEntitySelected(page: Page, entityId: string): Promise<void> {
  const headerEntity = page.locator('.wallet-meta-value').first();
  const current = String((await headerEntity.textContent().catch(() => '')) || '').trim().toLowerCase();
  if (current === entityId.toLowerCase()) return;

  const trigger = page.locator('.context-switcher .dropdown-trigger, .context-switcher .pill-trigger').first();
  await expect(trigger).toBeVisible({ timeout: 15_000 });
  await trigger.click();

  const runtimeMain = page.locator('.context-switcher .runtime-main').first();
  await expect(runtimeMain).toBeVisible({ timeout: 10_000 });
  await runtimeMain.click();

  await expect
    .poll(async () => String((await headerEntity.textContent().catch(() => '')) || '').trim().toLowerCase(), {
      timeout: 15_000,
      intervals: [200, 400, 800],
      message: 'self entity must be active before move flow',
    })
    .toBe(entityId.toLowerCase());
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

async function enqueueEntityTxs(
  page: Page,
  entityId: string,
  signerId: string,
  entityTxs: Array<{ type: string; data: Record<string, unknown> }>,
): Promise<void> {
  const result = await page.evaluate(async ({ entityId, signerId, entityTxs }) => {
    const view = window as typeof window & {
      isolatedEnv?: unknown;
      __xln_env?: unknown;
      XLN?: {
        enqueueRuntimeInput?: (env: unknown, input: unknown) => void;
      };
      __xln_instance?: {
        enqueueRuntimeInput?: (env: unknown, input: unknown) => void;
      };
    };
    const env = view.isolatedEnv ?? view.__xln_env;
    const XLN = view.XLN
      ?? view.__xln_instance
      ?? await import(/* @vite-ignore */ new URL(`/runtime.js?v=${Date.now()}`, window.location.origin).href);
    if (!env || !XLN?.enqueueRuntimeInput) {
      return { ok: false, error: 'isolatedEnv/XLN missing' };
    }
    XLN.enqueueRuntimeInput(env, {
      runtimeTxs: [],
      entityInputs: [{ entityId, signerId, entityTxs }],
    });
    return { ok: true };
  }, { entityId, signerId, entityTxs });
  expect(result.ok, result.error || 'failed to enqueue entity txs').toBe(true);
}

async function readJBatchSnapshot(
  page: Page,
  entityId: string,
  signerId: string,
): Promise<{
  pendingDisputeStarts: number;
  pendingDisputeFinalizations: number;
  sentDisputeStarts: number;
  sentDisputeFinalizations: number;
  sentExists: boolean;
  batchHistoryCount: number;
  mempoolTxTypes: string[];
  hasProposal: boolean;
  hasLockedFrame: boolean;
  recentMessages: string[];
}> {
  return page.evaluate(({ entityId, signerId }) => {
    const env = (window as any).isolatedEnv;
    if (!env?.eReplicas) {
      return {
        pendingDisputeStarts: 0,
        pendingDisputeFinalizations: 0,
        sentDisputeStarts: 0,
        sentDisputeFinalizations: 0,
        sentExists: false,
        batchHistoryCount: 0,
        mempoolTxTypes: [],
        hasProposal: false,
        hasLockedFrame: false,
        recentMessages: [],
      };
    }
    const key = Array.from(env.eReplicas.keys()).find((k: string) => {
      const [eid, sid] = String(k).split(':');
      return String(eid || '').toLowerCase() === String(entityId).toLowerCase()
        && String(sid || '').toLowerCase() === String(signerId).toLowerCase();
    });
    const rep = key ? env.eReplicas.get(key) : null;
    const pending = rep?.state?.jBatchState?.batch;
    const sent = rep?.state?.jBatchState?.sentBatch?.batch;
    const history = Array.isArray(rep?.state?.batchHistory) ? rep.state.batchHistory : [];
    const messages = Array.isArray(rep?.state?.messages) ? rep.state.messages.slice(-6) : [];
    const mempool = Array.isArray(rep?.mempool) ? rep.mempool : [];
    return {
      pendingExternalToReserve: Number(pending?.externalTokenToReserve?.length || 0),
      pendingReserveToCollateral: Number(pending?.reserveToCollateral?.length || 0),
      pendingCollateralToReserve: Number(pending?.collateralToReserve?.length || 0),
      pendingReserveToReserve: Number(pending?.reserveToReserve?.length || 0),
      pendingReserveToExternal: Number(pending?.reserveToExternalToken?.length || 0),
      pendingDisputeStarts: Number(pending?.disputeStarts?.length || 0),
      pendingDisputeFinalizations: Number(pending?.disputeFinalizations?.length || 0),
      sentExternalToReserve: Number(sent?.externalTokenToReserve?.length || 0),
      sentReserveToCollateral: Number(sent?.reserveToCollateral?.length || 0),
      sentCollateralToReserve: Number(sent?.collateralToReserve?.length || 0),
      sentReserveToReserve: Number(sent?.reserveToReserve?.length || 0),
      sentReserveToExternal: Number(sent?.reserveToExternalToken?.length || 0),
      sentDisputeStarts: Number(sent?.disputeStarts?.length || 0),
      sentDisputeFinalizations: Number(sent?.disputeFinalizations?.length || 0),
      sentExists: !!rep?.state?.jBatchState?.sentBatch,
      batchHistoryCount: Number(history.length || 0),
      mempoolTxTypes: mempool.map((tx: { type?: unknown }) => String(tx?.type || '')),
      hasProposal: !!rep?.proposal,
      hasLockedFrame: !!rep?.lockedFrame,
      recentMessages: messages.map((message: unknown) => String(message || '')),
    };
  }, { entityId, signerId });
}

async function readAllBatchSnapshots(page: Page): Promise<Array<{
  key: string;
  pendingCount: number;
  sentCount: number;
  historyCount: number;
}>> {
  return page.evaluate(() => {
    const env = (window as any).isolatedEnv;
    if (!env?.eReplicas) return [];
    const rows: Array<{ key: string; pendingCount: number; sentCount: number; historyCount: number }> = [];
    for (const [key, replica] of env.eReplicas.entries()) {
      const batch = replica?.state?.jBatchState?.batch;
      const sent = replica?.state?.jBatchState?.sentBatch?.batch;
      const history = Array.isArray(replica?.state?.batchHistory) ? replica.state.batchHistory : [];
      const pendingCount =
        Number(batch?.externalTokenToReserve?.length || 0) +
        Number(batch?.reserveToCollateral?.length || 0) +
        Number(batch?.collateralToReserve?.length || 0) +
        Number(batch?.reserveToReserve?.length || 0) +
        Number(batch?.reserveToExternalToken?.length || 0) +
        Number(batch?.disputeStarts?.length || 0) +
        Number(batch?.disputeFinalizations?.length || 0);
      const sentCount =
        Number(sent?.externalTokenToReserve?.length || 0) +
        Number(sent?.reserveToCollateral?.length || 0) +
        Number(sent?.collateralToReserve?.length || 0) +
        Number(sent?.reserveToReserve?.length || 0) +
        Number(sent?.reserveToExternalToken?.length || 0) +
        Number(sent?.disputeStarts?.length || 0) +
        Number(sent?.disputeFinalizations?.length || 0);
      rows.push({
        key: String(key),
        pendingCount,
        sentCount,
        historyCount: Number(history.length || 0),
      });
    }
    return rows;
  });
}

async function readMoveUiDebug(page: Page): Promise<{
  amount: string;
  confirmDisabled: boolean | null;
  status: string;
  sourceReserveRaw: string;
  sourceExternalRaw: string;
  sourceAccountRaw: string;
  headerEntityId: string;
  href: string;
  readyState: string;
  hasIsolatedEnv: boolean;
  replicaCount: number;
}> {
  return page.evaluate(() => {
    const amountInput = document.querySelector('[data-testid="move-amount"]') as HTMLInputElement | null;
    const confirm = document.querySelector('[data-testid="move-confirm"]') as HTMLButtonElement | null;
    const status = Array.from(document.querySelectorAll('[data-testid="move-status"]'))
      .map((node) => String(node.textContent || '').trim())
      .filter(Boolean)
      .join(' | ');
    const sourceReserve = document.querySelector('[data-testid="move-source-balance-reserve"]');
    const sourceExternal = document.querySelector('[data-testid="move-source-balance-external"]');
    const sourceAccount = document.querySelector('[data-testid="move-source-balance-account"]');
    const headerEntity = document.querySelector('.wallet-meta-value');
    const env = (window as typeof window & {
      isolatedEnv?: {
        eReplicas?: Map<string, unknown>;
      };
    }).isolatedEnv;
    return {
      amount: String(amountInput?.value || '').trim(),
      confirmDisabled: confirm ? !!confirm.disabled : null,
      status,
      sourceReserveRaw: String(sourceReserve?.getAttribute('data-raw-amount') || ''),
      sourceExternalRaw: String(sourceExternal?.getAttribute('data-raw-amount') || ''),
      sourceAccountRaw: String(sourceAccount?.getAttribute('data-raw-amount') || ''),
      headerEntityId: String(headerEntity?.textContent || '').trim(),
      href: String(window.location.href || ''),
      readyState: String(document.readyState || ''),
      hasIsolatedEnv: !!env,
      replicaCount: env?.eReplicas instanceof Map ? env.eReplicas.size : 0,
    };
  });
}

async function extendCreditDirect(
  page: Page,
  entityId: string,
  signerId: string,
  counterpartyId: string,
  tokenId: number,
  amount: bigint,
): Promise<void> {
  const before = await readAccountProgress(page, entityId, signerId, counterpartyId);
  await enqueueEntityTxs(page, entityId, signerId, [{
    type: 'extendCredit',
    data: {
      counterpartyEntityId: counterpartyId,
      tokenId,
      amount,
    },
  }]);
  await expect
    .poll(async () => (await readAccountProgress(page, entityId, signerId, counterpartyId)).currentHeight, {
      timeout: 45_000,
      intervals: [500, 1000, 1500],
    })
    .toBeGreaterThan(before.currentHeight);
}

async function sendDirectPayment(
  senderPage: Page,
  senderEntityId: string,
  senderSignerId: string,
  recipientPage: Page,
  recipientEntityId: string,
  recipientSignerId: string,
  recipientId: string,
  amount: string,
): Promise<void> {
  const senderBefore = await readAccountProgress(senderPage, senderEntityId, senderSignerId, recipientId);
  const recipientBefore = await readAccountProgress(recipientPage, recipientEntityId, recipientSignerId, senderEntityId);

  await enqueueEntityTxs(senderPage, senderEntityId, senderSignerId, [{
    type: 'directPayment',
    data: {
      targetEntityId: recipientId,
      tokenId: TOKEN_ID_USDC,
      amount: BigInt(amount) * TOKEN_SCALE,
      route: [senderEntityId, recipientId],
      description: 'debt-e2e-direct-bilateral',
    },
  }]);
  await expect
    .poll(async () => (await readAccountProgress(senderPage, senderEntityId, senderSignerId, recipientId)).currentHeight, {
      timeout: 45_000,
      intervals: [500, 1000, 1500],
    })
    .toBeGreaterThan(senderBefore.currentHeight);
  await expect
    .poll(async () => (await readAccountProgress(recipientPage, recipientEntityId, recipientSignerId, senderEntityId)).currentHeight, {
      timeout: 45_000,
      intervals: [500, 1000, 1500],
    })
    .toBeGreaterThan(recipientBefore.currentHeight);
}

async function queueAndBroadcastDisputeStart(page: Page, counterpartyId: string): Promise<void> {
  throw new Error('use queueAndBroadcastDisputeStartDirect');
}

async function broadcastDraftBatch(
  page: Page,
  entityId: string,
  signerId: string,
  expectedPendingKinds: Array<
    | 'externalToReserve'
    | 'reserveToCollateral'
    | 'collateralToReserve'
    | 'reserveToReserve'
    | 'reserveToExternal'
    | 'disputeStarts'
    | 'disputeFinalizations'
  > = [],
  debugStepLabel = '',
): Promise<{ consoleMessages: string[]; afterClickSnapshot: Awaited<ReturnType<typeof readJBatchSnapshot>> }> {
  const readExpectedPendingCount = (snapshot: Awaited<ReturnType<typeof readJBatchSnapshot>>): number => {
    if (expectedPendingKinds.length === 0) {
      return (
        snapshot.pendingExternalToReserve +
        snapshot.pendingReserveToCollateral +
        snapshot.pendingCollateralToReserve +
        snapshot.pendingReserveToReserve +
        snapshot.pendingReserveToExternal +
        snapshot.pendingDisputeStarts +
        snapshot.pendingDisputeFinalizations
      );
    }
    return expectedPendingKinds.reduce((total, kind) => {
      switch (kind) {
        case 'externalToReserve':
          return total + snapshot.pendingExternalToReserve;
        case 'reserveToCollateral':
          return total + snapshot.pendingReserveToCollateral;
        case 'collateralToReserve':
          return total + snapshot.pendingCollateralToReserve;
        case 'reserveToReserve':
          return total + snapshot.pendingReserveToReserve;
        case 'reserveToExternal':
          return total + snapshot.pendingReserveToExternal;
        case 'disputeStarts':
          return total + snapshot.pendingDisputeStarts;
        case 'disputeFinalizations':
          return total + snapshot.pendingDisputeFinalizations;
      }
    }, 0);
  };
  try {
    await expect
      .poll(async () => {
        const snapshot = await readJBatchSnapshot(page, entityId, signerId);
        return readExpectedPendingCount(snapshot);
      }, {
        timeout: 30_000,
        intervals: [250, 500, 1000],
      })
      .toBeGreaterThan(0);
    if (debugStepLabel) console.log(`[debt-e2e] ${debugStepLabel}-draft-observed`);
  } catch {
    const snapshot = await readJBatchSnapshot(page, entityId, signerId).catch(() => null);
    const toastMessage = await page.locator('.toast.error .message').last().textContent().catch(() => '');
    const moveStatus = (await page.getByTestId('move-status').allTextContents().catch(() => []))
      .map((entry) => String(entry || '').trim())
      .filter(Boolean)
      .join(' | ');
    const moveUi = await readMoveUiDebug(page).catch(() => ({
      amount: '',
      confirmDisabled: null,
      status: '',
      sourceReserveRaw: '',
      sourceExternalRaw: '',
      sourceAccountRaw: '',
      headerEntityId: '',
      href: '',
      readyState: '',
      hasIsolatedEnv: false,
      replicaCount: 0,
    }));
    const allBatches = await readAllBatchSnapshots(page).catch(() => []);
    const foreignPending = allBatches.filter((entry) => entry.pendingCount > 0 && !entry.key.toLowerCase().startsWith(`${entityId.toLowerCase()}:`));
    const activeRoot = await page.evaluate(() => ({
      assetsVisible: !!document.querySelector('[data-testid="move-workspace-assets"]'),
      accountsVisible: !!document.querySelector('nav[aria-label="Account workspace"]'),
      activeAssetTab: document.querySelector('[data-testid="asset-tab-move"].active, [data-testid="asset-tab-history"].active')?.textContent?.trim() || '',
      activeAccountTab: document.querySelector('.account-workspace-tab.active')?.textContent?.trim() || '',
    })).catch(() => ({
      assetsVisible: false,
      accountsVisible: false,
      activeAssetTab: '',
      activeAccountTab: '',
    }));
    throw new Error(
      `batch draft did not appear within 30s:` +
      ` expectedKinds=${expectedPendingKinds.join(',') || 'any'}` +
      ` toast=${String(toastMessage || '').trim()}` +
      ` snapshot=${JSON.stringify(snapshot)}` +
      ` moveStatus=${moveStatus}` +
      ` moveUi=${JSON.stringify(moveUi)}` +
      ` activeRoot=${JSON.stringify(activeRoot)}` +
      ` foreignPending=${JSON.stringify(foreignPending)}` +
      ` allBatches=${JSON.stringify(allBatches)}`,
    );
  }

  await openAssetsTab(page);
  const moveTab = page.getByTestId('asset-tab-move').first();
  if (await moveTab.isVisible().catch(() => false)) {
    await moveTab.click();
  }

  const broadcast = page.getByTestId('settle-sign-broadcast').first();
  await expect(broadcast).toBeVisible({ timeout: 30_000 });
  await expect(broadcast).toBeEnabled({ timeout: 120_000 });
  let dialogMessage = '';
  const consoleMessages: string[] = [];
  const onDialog = async (dialog: any) => {
    dialogMessage = dialog?.message?.() || '';
    await dialog.accept();
  };
  const onConsole = (message: any) => {
    const text = typeof message?.text === 'function' ? message.text() : '';
    if (text) consoleMessages.push(String(text));
  };
  page.on('dialog', onDialog);
  page.on('console', onConsole);
  try {
    await broadcast.click();
    if (debugStepLabel) console.log(`[debt-e2e] ${debugStepLabel}-broadcast-clicked`);
  } finally {
    page.off('dialog', onDialog);
    page.off('console', onConsole);
  }
  await page.waitForTimeout(500);
  const afterClickSnapshot = await readJBatchSnapshot(page, entityId, signerId);
  const toastLocator = page.locator('.toast.error .message').last();
  const toastVisible = await toastLocator.isVisible({ timeout: 200 }).catch(() => false);
  const toastMessage = toastVisible
    ? await toastLocator.textContent().catch(() => '')
    : '';
  if (dialogMessage || String(toastMessage || '').trim()) {
    throw new Error(
      `settle-sign-broadcast failed: ${dialogMessage || String(toastMessage || '').trim()}` +
      ` snapshot=${JSON.stringify(afterClickSnapshot)}` +
      ` console=${JSON.stringify(consoleMessages)}`,
    );
  }
  if (debugStepLabel) console.log(`[debt-e2e] ${debugStepLabel}-broadcasted`);
  return { consoleMessages, afterClickSnapshot };
}

async function queueAndBroadcastDisputeStartDirect(
  page: Page,
  entityId: string,
  signerId: string,
  counterpartyId: string,
): Promise<void> {
  const before = await readJBatchSnapshot(page, entityId, signerId);
  await enqueueEntityTxs(page, entityId, signerId, [{
    type: 'disputeStart',
    data: { counterpartyEntityId: counterpartyId, description: 'debt-e2e-dispute-start' },
  }]);
  await expect
    .poll(async () => (await readJBatchSnapshot(page, entityId, signerId)).pendingDisputeStarts, {
      timeout: 45_000,
      intervals: [500, 1000, 1500],
    })
    .toBeGreaterThan(before.pendingDisputeStarts);
  await openWorkspaceTab(page, /History/i);
  const broadcastDebug = await broadcastDraftBatch(page, entityId, signerId, ['disputeStarts']);
  try {
    await expect
      .poll(async () => {
        const snapshot = await readJBatchSnapshot(page, entityId, signerId);
        return snapshot.sentDisputeStarts > 0 || snapshot.batchHistoryCount > before.batchHistoryCount;
      }, {
        timeout: 60_000,
        intervals: [500, 1000, 1500],
      })
      .toBe(true);
  } catch {
    const snapshot = await readJBatchSnapshot(page, entityId, signerId);
    throw new Error(
      `dispute-start broadcast not observed.` +
      ` before=${JSON.stringify(before)}` +
      ` afterClick=${JSON.stringify(broadcastDebug.afterClickSnapshot)}` +
      ` final=${JSON.stringify(snapshot)}` +
      ` console=${JSON.stringify(broadcastDebug.consoleMessages)}`,
    );
  }
}

async function queueAndBroadcastDisputeFinalizeDirect(
  page: Page,
  entityId: string,
  signerId: string,
  counterpartyId: string,
): Promise<void> {
  const before = await readJBatchSnapshot(page, entityId, signerId);
  await enqueueEntityTxs(page, entityId, signerId, [{
    type: 'disputeFinalize',
    data: { counterpartyEntityId: counterpartyId, description: 'debt-e2e-dispute-finalize' },
  }]);
  await expect
    .poll(async () => {
      const snapshot = await readJBatchSnapshot(page, entityId, signerId);
      if (snapshot.pendingDisputeFinalizations > before.pendingDisputeFinalizations) return 'pending';
      if (snapshot.sentDisputeFinalizations > before.sentDisputeFinalizations) return 'sent';
      if (snapshot.batchHistoryCount > before.batchHistoryCount) return 'history';
      return 'waiting';
    }, {
      timeout: 45_000,
      intervals: [500, 1000, 1500],
    })
    .not.toBe('waiting');
  await openWorkspaceTab(page, /History/i);
  const afterQueueSnapshot = await readJBatchSnapshot(page, entityId, signerId);
  if (
    afterQueueSnapshot.sentDisputeFinalizations > before.sentDisputeFinalizations ||
    afterQueueSnapshot.batchHistoryCount > before.batchHistoryCount
  ) {
    return;
  }
  const broadcastDebug = await broadcastDraftBatch(page, entityId, signerId, ['disputeFinalizations']);
  try {
    await expect
      .poll(async () => {
        const snapshot = await readJBatchSnapshot(page, entityId, signerId);
        return snapshot.sentDisputeFinalizations > 0 || snapshot.batchHistoryCount > before.batchHistoryCount;
      }, {
        timeout: 60_000,
        intervals: [500, 1000, 1500],
      })
      .toBe(true);
  } catch {
    const snapshot = await readJBatchSnapshot(page, entityId, signerId);
    throw new Error(
      `dispute-finalize broadcast not observed.` +
      ` before=${JSON.stringify(before)}` +
      ` afterClick=${JSON.stringify(broadcastDebug.afterClickSnapshot)}` +
      ` final=${JSON.stringify(snapshot)}` +
      ` console=${JSON.stringify(broadcastDebug.consoleMessages)}`,
    );
  }
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
  await page.evaluate(async () => {
    const env = (window as typeof window & { isolatedEnv?: any }).isolatedEnv;
    const activeJurisdiction = String(env?.activeJurisdiction || '');
    const jReplica = activeJurisdiction ? env?.jReplicas?.get?.(activeJurisdiction) : null;
    const jadapter = jReplica?.jadapter;
    if (jadapter && typeof jadapter.pollNow === 'function') {
      await jadapter.pollNow();
    }
  });
}

async function readRuntimeJurisdictionHeight(page: Page): Promise<number> {
  return page.evaluate(() => {
    const env = (window as typeof window & { isolatedEnv?: any }).isolatedEnv;
    const activeJurisdiction = String(env?.activeJurisdiction || '');
    const jReplica = activeJurisdiction ? env?.jReplicas?.get?.(activeJurisdiction) : null;
    return Number(jReplica?.blockNumber || 0n);
  });
}

async function waitForBlock(page: Page, targetBlock: number): Promise<void> {
  const deadline = Date.now() + 45_000;
  for (;;) {
    const current = await readCurrentChainBlock(page);
    const runtimeVisible = await readRuntimeJurisdictionHeight(page);
    if (current >= targetBlock && runtimeVisible >= targetBlock) return;
    await mineOneBlock(page);
    if (Date.now() > deadline) {
      throw new Error(
        `Timed out waiting for block ${targetBlock}, current=${current}, runtimeVisible=${runtimeVisible}`,
      );
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
      createdAmount: BigInt(match.createdAmount || 0n),
      paidAmount: BigInt(match.paidAmount || 0n),
      remainingAmount: BigInt(match.remainingAmount || 0n),
      forgivenAmount: BigInt(match.forgivenAmount || 0n),
      updates: Array.isArray(match.updates) ? match.updates.map((update: any) => String(update?.eventType || '')) : [],
    };
  }, { entityId, signerId, counterpartyId, direction, tokenId });
}

async function readAccountDeltaSnapshot(
  page: Page,
  entityId: string,
  signerId: string,
  counterpartyId: string,
  tokenId = TOKEN_ID_USDC,
): Promise<{ ondelta: string; offdelta: string; total: string } | null> {
  return page.evaluate(({ entityId, signerId, counterpartyId, tokenId }) => {
    const env = (window as any).isolatedEnv;
    if (!env?.eReplicas) return null;
    const key = Array.from(env.eReplicas.keys()).find((k: string) => {
      const [eid, sid] = String(k).split(':');
      return String(eid || '').toLowerCase() === String(entityId).toLowerCase()
        && String(sid || '').toLowerCase() === String(signerId).toLowerCase();
    });
    const rep = key ? env.eReplicas.get(key) : null;
    const account = rep?.state?.accounts?.get?.(counterpartyId);
    const delta = account?.deltas?.get?.(tokenId);
    if (!delta) return null;
    const ondelta = BigInt(delta.ondelta || 0n);
    const offdelta = BigInt(delta.offdelta || 0n);
    return {
      ondelta: ondelta.toString(),
      offdelta: offdelta.toString(),
      total: (ondelta + offdelta).toString(),
    };
  }, { entityId, signerId, counterpartyId, tokenId });
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
    return `${latest.status}:${latest.remainingAmount.toString()}:${latest.paidAmount.toString()}`;
  }, { timeout: 45_000, intervals: [500, 1000, 1500] }).toBe(`open:${expectedRemaining}:${expectedPaid}`);
  return latest!;
}

async function faucetReserve(page: Page, entityId: string, symbol = 'USDC'): Promise<void> {
  await openAssetsTab(page);
  const response = await page.request.post(`${APP_BASE_URL}/api/faucet/reserve`, {
    data: {
      userEntityId: entityId,
      tokenId: TOKEN_ID_USDC,
      tokenSymbol: symbol,
      amount: '100',
    },
  });
  expect(response.ok(), 'reserve faucet api must succeed').toBe(true);
  const body = await response.json() as { success?: boolean; error?: string };
  expect(body.success, body.error || 'reserve faucet api failed').toBe(true);
}

async function enforceDebtDirect(page: Page, entityId: string, tokenId: number): Promise<void> {
  const result = await page.evaluate(async ({ entityId, tokenId }) => {
    const view = window as typeof window & {
      isolatedEnv?: unknown;
      __xln_env?: unknown;
      XLN?: {
        submitDebtEnforcement?: (env: unknown, entityIdValue: string, tokenIdValue: number) => Promise<void>;
      };
      __xln_instance?: {
        submitDebtEnforcement?: (env: unknown, entityIdValue: string, tokenIdValue: number) => Promise<void>;
      };
    };
    const env = view.isolatedEnv ?? view.__xln_env;
    const XLN = view.XLN
      ?? view.__xln_instance
      ?? await import(/* @vite-ignore */ new URL(`/runtime.js?v=${Date.now()}`, window.location.origin).href);
    if (!env || !XLN?.submitDebtEnforcement) {
      return { ok: false, error: 'isolatedEnv/XLN missing' };
    }
    await XLN.submitDebtEnforcement(env, entityId, tokenId);
    return { ok: true };
  }, { entityId, tokenId });
  expect(result.ok, result.error || 'failed to enforce debt').toBe(true);
}

async function enforceDebtUntilSettled(
  page: Page,
  entityId: string,
  debtorEntityId: string,
  debtorSignerId: string,
  creditorEntityId: string,
  tokenId: number,
  expectedSnapshot: string,
): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await enforceDebtDirect(page, entityId, tokenId);
    const settled = await expect
      .poll(async () => {
        const value = await readDebtSnapshot(page, debtorEntityId, debtorSignerId, creditorEntityId, 'out');
        return value
          ? `${value.status}:${value.remainingAmount.toString()}:${value.paidAmount.toString()}`
          : 'missing';
      }, {
        timeout: 15_000,
        intervals: [500, 1000, 1500],
      })
      .toBe(expectedSnapshot)
      .then(() => true)
      .catch(() => false);
    if (settled) return;
  }
  const value = await readDebtSnapshot(page, debtorEntityId, debtorSignerId, creditorEntityId, 'out');
  throw new Error(
    `debt enforce did not settle as expected: got=${
      value ? `${value.status}:${value.remainingAmount.toString()}:${value.paidAmount.toString()}` : 'missing'
    } expected=${expectedSnapshot}`,
  );
}

async function openReserveToExternalMove(
  page: Page,
  entityId: string,
  amount: string,
  recipient: string,
  expectedState: 'ready' | 'blocked' = 'ready',
): Promise<void> {
  await ensureSelfEntitySelected(page, entityId);
  await openAssetsTab(page);
  const moveTab = page.getByTestId('asset-tab-move').first();
  await expect(moveTab).toBeVisible({ timeout: 20_000 });
  await moveTab.click();
  const workspace = page.getByTestId('move-workspace-assets').first();
  await expect(workspace).toBeVisible({ timeout: 20_000 });
  await expect(workspace.getByTestId('move-route-summary').first()).toBeVisible({ timeout: 20_000 });
  await workspace.getByTestId('move-asset-symbol').first().selectOption('USDC');
  await workspace.getByTestId('move-source-reserve').first().click();
  await workspace.getByTestId('move-target-external').first().click();
  await workspace.getByTestId('move-external-recipient').first().fill(recipient);
  const amountInput = workspace.getByTestId('move-amount').first();
  await amountInput.fill(amount);
  await expect
    .poll(async () => (await amountInput.inputValue()).trim(), {
      timeout: 10_000,
      intervals: [100, 250, 500],
      message: 'move amount input must retain the typed value',
    })
    .toBe(amount);
  const confirm = workspace.getByTestId('move-confirm').first();
  await expect(workspace.getByTestId('move-route-summary').first()).toContainText('Reserve → External');
  await expect(workspace.getByTestId('move-route-summary').first()).toContainText(`${amount} USDC`);
  if (expectedState === 'blocked') {
    await expect
      .poll(async () => {
        if (!(await confirm.isDisabled())) return 'enabled';
        const statuses = await page.getByTestId('move-status').allTextContents().catch(() => []);
        const text = statuses.map((entry) => String(entry || '').trim()).filter(Boolean).join(' | ');
        return text || 'disabled';
      }, { timeout: 10_000, intervals: [200, 400, 800] })
      .toBe('Amount exceeds available balance');
    return;
  }
  await expect
    .poll(async () => {
      if (!(await confirm.isDisabled())) return 'enabled';
      const statuses = await page.getByTestId('move-status').allTextContents().catch(() => []);
      const text = statuses.map((entry) => String(entry || '').trim()).filter(Boolean).join(' | ');
      return text || 'disabled';
    }, { timeout: 10_000, intervals: [200, 400, 800] })
    .toBe('enabled');
  await expect(confirm).toHaveText(/Add to Batch/i);
}

async function openOutstandingDebtToken(page: Page, symbol = 'USDC'): Promise<void> {
  await page.getByTestId('tab-accounts').first().click();
  const debtPanel = page.getByTestId('debt-panel').first();
  await expect(debtPanel).toBeVisible({ timeout: 20_000 });
  if (!(await debtPanel.evaluate((node) => node.hasAttribute('open')))) {
    await debtPanel.locator('summary').first().click();
  }
  const tokenGroup = page.locator('.debt-token-group').filter({ hasText: symbol }).first();
  await expect(tokenGroup).toBeVisible({ timeout: 20_000 });
  if (!(await tokenGroup.evaluate((node) => node.hasAttribute('open')))) {
    await tokenGroup.locator('.debt-token-summary').first().click();
  }
}

test.describe('debt ledger', () => {
  test('mirrors debts on both sides and only explicit enforce repays partial debt', async ({ browser }) => {
    test.setTimeout(240_000);
    const step = (label: string) => console.log(`[debt-e2e] ${label}`);

    step('bootstrap');
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

    step('open-accounts');
    await ensurePrivateAccountOpenViaUi(alicePage, alice.entityId, alice.signerId, bob.entityId);
    await ensurePrivateAccountOpenViaUi(bobPage, bob.entityId, bob.signerId, alice.entityId);

    step('extend-credit');
    await extendCreditDirect(alicePage, alice.entityId, alice.signerId, bob.entityId, TOKEN_ID_USDC, 1000n * TOKEN_SCALE);
    step('direct-payment');
    await sendDirectPayment(
      bobPage,
      bob.entityId,
      bob.signerId,
      alicePage,
      alice.entityId,
      alice.signerId,
      alice.entityId,
      '150',
    );
    await expect
      .poll(async () => (await readAccountDeltaSnapshot(alicePage, alice.entityId, alice.signerId, bob.entityId))?.total || '0', {
        timeout: 45_000,
        intervals: [500, 1000, 1500],
      })
      .not.toBe('0');
    await expect
      .poll(async () => (await readAccountDeltaSnapshot(bobPage, bob.entityId, bob.signerId, alice.entityId))?.total || '0', {
        timeout: 45_000,
        intervals: [500, 1000, 1500],
      })
      .not.toBe('0');

    step('dispute-start');
    await queueAndBroadcastDisputeStartDirect(alicePage, alice.entityId, alice.signerId, bob.entityId);
    await expect
      .poll(async () => (await readAccountState(alicePage, alice.entityId, alice.signerId, bob.entityId)).activeDispute, {
        timeout: 45_000,
        intervals: [500, 1000, 1500],
      })
      .toBe(true);

    let disputeState = await readAccountState(alicePage, alice.entityId, alice.signerId, bob.entityId);
    await expect
      .poll(async () => {
        disputeState = await readAccountState(alicePage, alice.entityId, alice.signerId, bob.entityId);
        return disputeState.activeDispute && disputeState.disputeTimeout > 0 ? 'ready' : 'pending';
      }, {
        timeout: 45_000,
        intervals: [500, 1000, 1500],
      })
      .toBe('ready');

    const timeoutBlock = disputeState.disputeTimeout;
    await waitForBlock(alicePage, timeoutBlock);

    step('dispute-finalize');
    await queueAndBroadcastDisputeFinalizeDirect(alicePage, alice.entityId, alice.signerId, bob.entityId);
    await expect
      .poll(async () => (await readAccountState(alicePage, alice.entityId, alice.signerId, bob.entityId)).activeDispute, {
        timeout: 60_000,
        intervals: [500, 1000, 1500],
      })
      .toBe(false);

    step('wait-debt-mirror');
    const aliceIncoming = await waitForDebtSnapshot(alicePage, alice.entityId, alice.signerId, bob.entityId, 'in', USD_150, '0');
    const bobOutgoing = await waitForDebtSnapshot(bobPage, bob.entityId, bob.signerId, alice.entityId, 'out', USD_150, '0');

    expect(aliceIncoming.createdAmount).toBe(BigInt(USD_150));
    expect(aliceIncoming.remainingAmount).toBe(BigInt(USD_150));
    expect(aliceIncoming.paidAmount).toBe(0n);
    expect(aliceIncoming.updates).toEqual(['DebtCreated']);
    expect(bobOutgoing.createdAmount).toBe(BigInt(USD_150));
    expect(bobOutgoing.remainingAmount).toBe(BigInt(USD_150));
    expect(bobOutgoing.paidAmount).toBe(0n);
    expect(bobOutgoing.updates).toEqual(['DebtCreated']);

    step('underfunded-r2e-block');
    await faucetReserve(bobPage, bob.entityId, 'USDC');
    await expect.poll(async () => await getRenderedReserveBalance(bobPage, 'USDC'), {
      timeout: 20_000,
      intervals: [500, 1000],
    }).toBeGreaterThanOrEqual(100);

    await openReserveToExternalMove(bobPage, bob.entityId, '10', bob.signerId, 'blocked');
    await expect(
      bobPage.getByTestId('move-workspace-assets').first().getByTestId('move-confirm').first(),
    ).toBeDisabled({ timeout: 10_000 });

    step('partial-enforce');
    await openOutstandingDebtToken(bobPage, 'USDC');
    const enforceButton = bobPage.getByTestId(`debt-enforce-${TOKEN_ID_USDC}`).first();
    await expect(enforceButton).toBeVisible({ timeout: 20_000 });
    await enforceButton.click();

    await expect
      .poll(async () => {
        const value = await readDebtSnapshot(bobPage, bob.entityId, bob.signerId, alice.entityId, 'out');
        return value
          ? `${value.remainingAmount.toString()}:${value.paidAmount.toString()}`
          : 'missing';
      }, {
        timeout: 45_000,
        intervals: [500, 1000, 1500],
      })
      .toBe(`${USD_50}:${USD_100}`);

    const afterPartial = await readDebtSnapshot(bobPage, bob.entityId, bob.signerId, alice.entityId, 'out');
    expect(afterPartial?.updates).toEqual(['DebtCreated', 'DebtEnforced']);

    step('full-enforce');
    await faucetReserve(bobPage, bob.entityId, 'USDC');
    await expect.poll(async () => await getRenderedReserveBalance(bobPage, 'USDC'), {
      timeout: 20_000,
      intervals: [500, 1000],
    }).toBeGreaterThanOrEqual(50);
    await enforceDebtUntilSettled(
      bobPage,
      bob.entityId,
      bob.entityId,
      bob.signerId,
      alice.entityId,
      TOKEN_ID_USDC,
      `paid:0:${USD_150}`,
    );

    step('overfunded-r2e');
    const cleanBatchSnapshot = await readJBatchSnapshot(bobPage, bob.entityId, bob.signerId);
    const cleanPendingCount =
      cleanBatchSnapshot.pendingExternalToReserve +
      cleanBatchSnapshot.pendingReserveToCollateral +
      cleanBatchSnapshot.pendingCollateralToReserve +
      cleanBatchSnapshot.pendingReserveToReserve +
      cleanBatchSnapshot.pendingReserveToExternal +
      cleanBatchSnapshot.pendingDisputeStarts +
      cleanBatchSnapshot.pendingDisputeFinalizations;
    expect(
      {
        pendingCount: cleanPendingCount,
        sentExists: cleanBatchSnapshot.sentExists,
        recentMessages: cleanBatchSnapshot.recentMessages,
      },
      'debt flow must leave a clean batch state before overfunded reserve->external move',
    ).toMatchObject({
      pendingCount: 0,
      sentExists: false,
    });
    await faucetReserve(bobPage, bob.entityId, 'USDC');
    const externalBefore = await getRenderedExternalBalance(bobPage, 'USDC');
    const externalBeforeRaw = await getRpcExternalBalanceRaw(bobPage, 'USDC', bob.signerId);
    const reserveBeforeRaw = await readOnchainReserveBalanceRaw(bobPage, bob.entityId, 'USDC');
    await openReserveToExternalMove(bobPage, bob.entityId, '20', bob.signerId, 'ready');
    const moveConfirm = bobPage.getByTestId('move-workspace-assets').first().getByTestId('move-confirm').first();
    await expect(moveConfirm).toBeEnabled({ timeout: 20_000 });
    await moveConfirm.click();
    step('overfunded-r2e-draft-clicked');
    await broadcastDraftBatch(bobPage, bob.entityId, bob.signerId, ['reserveToExternal'], 'overfunded-r2e');
    step('overfunded-r2e-broadcasted');

    await expect.poll(async () => await getRpcExternalBalanceRaw(bobPage, 'USDC', bob.signerId), {
      timeout: 45_000,
      intervals: [500, 1000, 1500],
    }).toBe(externalBeforeRaw + (20n * TOKEN_SCALE));
    await expect.poll(async () => await readOnchainReserveBalanceRaw(bobPage, bob.entityId, 'USDC'), {
      timeout: 45_000,
      intervals: [500, 1000, 1500],
    }).toBe(reserveBeforeRaw - (20n * TOKEN_SCALE));
    step('overfunded-r2e-raw-deltas');
    await expect.poll(async () => await getRenderedExternalBalance(bobPage, 'USDC'), {
      timeout: 45_000,
      intervals: [500, 1000, 1500],
    }).toBeGreaterThan(externalBefore);
    step('done');

    await alicePage.context().close();
    await bobPage.context().close();
  });
});
