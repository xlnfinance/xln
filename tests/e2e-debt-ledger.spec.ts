import { expect, test, type Browser, type Page } from '@playwright/test';

import { ensureE2EBaseline, APP_BASE_URL } from './utils/e2e-baseline';
import { createRuntimeIdentity, gotoApp, selectDemoMnemonic } from './utils/e2e-demo-users';
import { connectHub } from './utils/e2e-connect';
import { getRenderedExternalBalance, getRenderedReserveBalance } from './utils/e2e-account-ui';

const TOKEN_ID_USDC = 1;
const TOKEN_SCALE = 10n ** 18n;
const USD_150 = (150n * TOKEN_SCALE).toString();
const USD_100 = (100n * TOKEN_SCALE).toString();
const USD_50 = (50n * TOKEN_SCALE).toString();

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
      pendingDisputeStarts: Number(pending?.disputeStarts?.length || 0),
      pendingDisputeFinalizations: Number(pending?.disputeFinalizations?.length || 0),
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
): Promise<{ consoleMessages: string[]; afterClickSnapshot: Awaited<ReturnType<typeof readJBatchSnapshot>> }> {
  const broadcast = page.locator('.workspace-pending-banner').getByTestId('settle-sign-broadcast').first();
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
  const broadcastDebug = await broadcastDraftBatch(page, entityId, signerId);
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
  const broadcastDebug = await broadcastDraftBatch(page, entityId, signerId);
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
      createdAmount: String(match.createdAmount || '0'),
      paidAmount: String(match.paidAmount || '0'),
      remainingAmount: String(match.remainingAmount || '0'),
      forgivenAmount: String(match.forgivenAmount || '0'),
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
    return `${latest.status}:${latest.remainingAmount}:${latest.paidAmount}`;
  }, { timeout: 45_000, intervals: [500, 1000, 1500] }).toBe(`open:${expectedRemaining}:${expectedPaid}`);
  return latest!;
}

async function faucetReserve(page: Page, entityId: string, symbol = 'USDC'): Promise<void> {
  await page.getByTestId('tab-assets').first().click();
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

async function openReserveToExternalMove(page: Page, amount: string, recipient: string): Promise<void> {
  const assetsTab = page.getByTestId('tab-assets').first();
  await assetsTab.click();
  await page.getByTestId('asset-tab-move').first().click();
  await page.getByTestId('move-source-reserve').first().click();
  await page.getByTestId('move-target-external').first().click();
  await page.getByTestId('move-external-recipient').first().fill(recipient);
  await page.getByTestId('move-amount').first().fill(amount);
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

    expect(aliceIncoming.createdAmount).toBe(USD_150);
    expect(aliceIncoming.updates).toEqual(['DebtCreated']);
    expect(bobOutgoing.createdAmount).toBe(USD_150);
    expect(bobOutgoing.updates).toEqual(['DebtCreated']);

    step('underfunded-r2e-block');
    await faucetReserve(bobPage, bob.entityId, 'USDC');
    await expect.poll(async () => await getRenderedReserveBalance(bobPage, 'USDC'), {
      timeout: 20_000,
      intervals: [500, 1000],
    }).toBeGreaterThanOrEqual(100);

    await openReserveToExternalMove(bobPage, '10', bob.signerId);
    await expect(bobPage.getByTestId('move-confirm').first()).toBeDisabled({ timeout: 10_000 });

    step('partial-enforce');
    await openOutstandingDebtToken(bobPage, 'USDC');
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
      .toBe(`${USD_50}:${USD_100}`);

    const afterPartial = await readDebtSnapshot(bobPage, bob.entityId, bob.signerId, alice.entityId, 'out');
    expect(afterPartial?.updates).toEqual(['DebtCreated', 'DebtEnforced']);

    step('full-enforce');
    await faucetReserve(bobPage, bob.entityId, 'USDC');
    await expect.poll(async () => await getRenderedReserveBalance(bobPage, 'USDC'), {
      timeout: 20_000,
      intervals: [500, 1000],
    }).toBeGreaterThanOrEqual(50);
    await openOutstandingDebtToken(bobPage, 'USDC');
    await bobPage.getByTestId(`debt-enforce-${TOKEN_ID_USDC}`).first().click();

    await expect
      .poll(async () => {
        const value = await readDebtSnapshot(bobPage, bob.entityId, bob.signerId, alice.entityId, 'out');
        return `${value?.status || 'missing'}:${value?.remainingAmount || 'missing'}:${value?.paidAmount || 'missing'}`;
      }, {
        timeout: 45_000,
        intervals: [500, 1000, 1500],
      })
      .toBe(`paid:0:${USD_150}`);

    step('overfunded-r2e');
    await faucetReserve(bobPage, bob.entityId, 'USDC');
    const externalBefore = await getRenderedExternalBalance(bobPage, 'USDC');
    await openReserveToExternalMove(bobPage, '20', bob.signerId);
    const moveConfirm = bobPage.getByTestId('move-confirm').first();
    await expect(moveConfirm).toBeEnabled({ timeout: 20_000 });
    await moveConfirm.click();
    await broadcastDraftBatch(bobPage, bob.entityId, bob.signerId);

    await expect.poll(async () => await getRenderedExternalBalance(bobPage, 'USDC'), {
      timeout: 45_000,
      intervals: [500, 1000, 1500],
    }).toBeGreaterThan(externalBefore);
    step('done');

    await alicePage.context().close();
    await bobPage.context().close();
  });
});
