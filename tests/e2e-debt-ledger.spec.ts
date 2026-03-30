import { expect, test, type Browser, type Page } from '@playwright/test';
import { Interface } from 'ethers';

import { ensureE2EBaseline, APP_BASE_URL } from './utils/e2e-baseline';
import { createRuntimeIdentity, gotoApp, selectDemoMnemonic } from './utils/e2e-demo-users';
import { connectHub } from './utils/e2e-connect';
import { getRenderedExternalBalance, getRenderedReserveBalance } from './utils/e2e-account-ui';
import { startDisputeFromManageUi } from './utils/e2e-account-workspace';
import { deriveDelta } from '../runtime/account-utils';

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
  direction: 'out' | 'in';
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
  const backButton = page.getByTestId('account-panel-back').first();
  if (await backButton.isVisible().catch(() => false)) {
    await backButton.click();
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

async function openAccountWorkspaceTab(
  page: Page,
  tabId: 'open' | 'history' | 'configure' | 'pay' | 'receive' | 'swap' | 'move' | 'activity' | 'appearance',
): Promise<void> {
  await openAccountsWorkspace(page);
  const navs = page.locator('nav[aria-label="Account workspace"]');
  const navCount = await navs.count();
  let tab: ReturnType<Page['getByTestId']> | null = null;
  for (let i = 0; i < navCount; i += 1) {
    const nav = navs.nth(i);
    if (!(await nav.isVisible().catch(() => false))) continue;
    const candidate = nav.getByTestId(`account-workspace-tab-${tabId}`).first();
    if (await candidate.isVisible().catch(() => false)) {
      tab = candidate;
      break;
    }
  }
  if (!tab) {
    tab = page.getByTestId(`account-workspace-tab-${tabId}`).first();
  }
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

  await openAccountWorkspaceTab(page, 'open');
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

async function queueAndBroadcastDisputeStart(
  page: Page,
  entityId: string,
  signerId: string,
  counterpartyId: string,
): Promise<void> {
  const before = await readJBatchSnapshot(page, entityId, signerId);
  await startDisputeFromManageUi(page, counterpartyId, async () =>
    (await readJBatchSnapshot(page, entityId, signerId)).pendingDisputeStarts > before.pendingDisputeStarts,
  );
  await expect
    .poll(async () => (await readJBatchSnapshot(page, entityId, signerId)).pendingDisputeStarts, {
      timeout: 45_000,
      intervals: [500, 1000, 1500],
    })
    .toBeGreaterThan(before.pendingDisputeStarts);
  await openAccountWorkspaceTab(page, 'history');
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

async function readDebtSnapshotsForCounterparty(
  page: Page,
  entityId: string,
  signerId: string,
  counterpartyId: string,
  tokenId = TOKEN_ID_USDC,
): Promise<DebtSnapshot[]> {
  return page.evaluate(({ entityId, signerId, counterpartyId, tokenId }) => {
    const env = (window as any).isolatedEnv;
    if (!env?.eReplicas) return [];
    const key = Array.from(env.eReplicas.keys()).find((k: string) => {
      const [eid, sid] = String(k).split(':');
      return String(eid || '').toLowerCase() === String(entityId).toLowerCase()
        && String(sid || '').toLowerCase() === String(signerId).toLowerCase();
    });
    const rep = key ? env.eReplicas.get(key) : null;
    const ledgers = [
      ['out', rep?.state?.outDebtsByToken],
      ['in', rep?.state?.inDebtsByToken],
    ] as const;
    const rows: DebtSnapshot[] = [];
    for (const [direction, ledger] of ledgers) {
      const bucket = ledger?.get?.(tokenId);
      if (!bucket) continue;
      for (const entry of bucket.values()) {
        if (String(entry?.counterparty || '').toLowerCase() !== String(counterpartyId || '').toLowerCase()) continue;
        rows.push({
          debtId: String(entry?.debtId || ''),
          direction,
          status: String(entry?.status || ''),
          createdAmount: BigInt(entry?.createdAmount || 0n),
          paidAmount: BigInt(entry?.paidAmount || 0n),
          remainingAmount: BigInt(entry?.remainingAmount || 0n),
          forgivenAmount: BigInt(entry?.forgivenAmount || 0n),
          updates: Array.isArray(entry?.updates) ? entry.updates.map((update: any) => String(update?.eventType || '')) : [],
        });
      }
    }
    return rows;
  }, { entityId, signerId, counterpartyId, tokenId });
}

async function readAccountDeltaSnapshot(
  page: Page,
  entityId: string,
  signerId: string,
  counterpartyId: string,
  tokenId = TOKEN_ID_USDC,
): Promise<{ ondelta: string; offdelta: string; total: string } | null> {
  const raw = await page.evaluate(({ entityId, signerId, counterpartyId, tokenId }) => {
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
    return {
      ondelta: String(delta.ondelta || 0n),
      offdelta: String(delta.offdelta || 0n),
      collateral: String(delta.collateral || 0n),
      leftCreditLimit: String(delta.leftCreditLimit || 0n),
      rightCreditLimit: String(delta.rightCreditLimit || 0n),
      leftAllowance: String(delta.leftAllowance || 0n),
      rightAllowance: String(delta.rightAllowance || 0n),
      leftHold: String(delta.leftHold || 0n),
      rightHold: String(delta.rightHold || 0n),
    };
  }, { entityId, signerId, counterpartyId, tokenId });

  if (!raw) return null;
  const derived = deriveDelta({
    tokenId,
    ondelta: BigInt(raw.ondelta),
    offdelta: BigInt(raw.offdelta),
    collateral: BigInt(raw.collateral),
    leftCreditLimit: BigInt(raw.leftCreditLimit),
    rightCreditLimit: BigInt(raw.rightCreditLimit),
    leftAllowance: BigInt(raw.leftAllowance),
    rightAllowance: BigInt(raw.rightAllowance),
    leftHold: BigInt(raw.leftHold),
    rightHold: BigInt(raw.rightHold),
  }, String(entityId).toLowerCase() < String(counterpartyId).toLowerCase());

  return {
    ondelta: raw.ondelta,
    offdelta: raw.offdelta,
    total: derived.delta.toString(),
  };
}

async function waitForMirroredDebtSnapshots(
  leftPage: Page,
  leftEntityId: string,
  leftSignerId: string,
  rightPage: Page,
  rightEntityId: string,
  rightSignerId: string,
  expectedRemaining: string,
): Promise<{ left: DebtSnapshot; right: DebtSnapshot }> {
  let latest: { left: DebtSnapshot | null; right: DebtSnapshot | null } = { left: null, right: null };
  const readUiDebtRow = async (page: Page): Promise<DebtSnapshot | null> =>
    page.evaluate(() => {
      const panel = document.querySelector('[data-testid="debt-panel"]');
      if (!panel) return null;
      const row = document.querySelector('[data-testid="debt-row-out-1"], [data-testid="debt-row-in-1"]') as HTMLElement | null;
      if (!row) return null;
      const testId = String(row.dataset.testid || '');
      const text = String(row.textContent || '').replace(/\s+/g, ' ').trim();
      const created = /Opened\s+([0-9.,]+)/i.exec(text)?.[1] || '0';
      const paid = /Paid\s+([0-9.,]+)/i.exec(text)?.[1] || '0';
      const left = /Left\s+([0-9.,]+)/i.exec(text)?.[1] || '0';
      const normalize = (value: string): bigint => {
        const digits = value.replace(/,/g, '');
        const [wholePartRaw, fractionalPartRaw = ''] = digits.split('.');
        const wholePart = wholePartRaw.trim() || '0';
        const fractionalPart = fractionalPartRaw.trim().replace(/\D/g, '').slice(0, 18).padEnd(18, '0');
        return BigInt(wholePart) * 10n ** 18n + BigInt(fractionalPart || '0');
      };
      return {
        debtId: testId,
        direction: testId.includes('-out-') ? 'out' : 'in',
        status: text.includes('Open') ? 'open' : 'unknown',
        createdAmount: normalize(created),
        paidAmount: normalize(paid),
        remainingAmount: normalize(left),
        forgivenAmount: 0n,
        updates: text.includes('Open') ? ['DebtCreated'] : [],
      };
    });
  await expect.poll(async () => {
    const [leftRow, rightRow, leftSummary, rightSummary] = await Promise.all([
      readUiDebtRow(leftPage),
      readUiDebtRow(rightPage),
      leftPage.getByTestId('debt-panel').first().textContent().catch(() => ''),
      rightPage.getByTestId('debt-panel').first().textContent().catch(() => ''),
    ]);
    latest = {
      left: leftRow,
      right: rightRow,
    };
    if (!latest.left || !latest.right) return false;
    return (
      latest.left.status === 'open' &&
      latest.right.status === 'open' &&
      latest.left.remainingAmount.toString() === expectedRemaining &&
      latest.right.remainingAmount.toString() === expectedRemaining &&
      latest.left.paidAmount === 0n &&
      latest.right.paidAmount === 0n &&
      latest.left.direction !== latest.right.direction &&
      String(leftSummary || '').includes('$150') &&
      String(rightSummary || '').includes('$150')
    );
  }, { timeout: 45_000, intervals: [500, 1000, 1500] }).toBe(true);
  if (!latest.left || !latest.right) {
    throw new Error('mirrored debt snapshots missing');
  }
  return { left: latest.left, right: latest.right };
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
  test('creates one mirrored debt on both sides after dispute finalize', async ({ browser }) => {
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
    await queueAndBroadcastDisputeStart(alicePage, alice.entityId, alice.signerId, bob.entityId);
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

    step('dispute-finalize-auto');
    await expect
      .poll(async () => (await readAccountState(alicePage, alice.entityId, alice.signerId, bob.entityId)).activeDispute, {
        timeout: 90_000,
        intervals: [500, 1000, 1500],
      })
      .toBe(false);

    step('wait-debt-mirror');
    const mirrored = await waitForMirroredDebtSnapshots(
      alicePage,
      alice.entityId,
      alice.signerId,
      bobPage,
      bob.entityId,
      bob.signerId,
      USD_150,
    );

    expect(mirrored.left.createdAmount).toBe(BigInt(USD_150));
    expect(mirrored.left.remainingAmount).toBe(BigInt(USD_150));
    expect(mirrored.left.paidAmount).toBe(0n);
    expect(mirrored.left.updates).toEqual(['DebtCreated']);
    expect(mirrored.right.createdAmount).toBe(BigInt(USD_150));
    expect(mirrored.right.remainingAmount).toBe(BigInt(USD_150));
    expect(mirrored.right.paidAmount).toBe(0n);
    expect(mirrored.right.updates).toEqual(['DebtCreated']);
    expect(mirrored.left.direction).not.toBe(mirrored.right.direction);

    await alicePage.context().close();
    await bobPage.context().close();
  });
});
