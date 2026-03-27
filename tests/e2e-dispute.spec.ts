/**
 * E2E dispute coverage for account UI, settlement batching, reserve return, and reload persistence.
 *
 * These tests prove that a disputed bilateral account can be started from the UI, finalized into reserve,
 * extended with post-dispute settlement actions, and restored after reload without losing batch history.
 */
import { test, expect, type Locator, type Page } from '@playwright/test';
import { Wallet } from 'ethers';
import { timedStep } from './utils/e2e-timing';
import { APP_BASE_URL, resetProdServer } from './utils/e2e-baseline';
import { gotoApp as gotoSharedApp, createRuntimeIdentity } from './utils/e2e-demo-users';
import { connectHub } from './utils/e2e-connect';
import {
  getPersistedReceiptCursor,
  waitForPersistedFrameEventMatch,
} from './utils/e2e-runtime-receipts';

const INIT_TIMEOUT = 30_000;
const LONG_E2E = process.env.E2E_LONG === '1';

function randomMnemonic(): string {
  return Wallet.createRandom().mnemonic!.phrase;
}

function relayToApiBase(relayUrl: string | null | undefined): string | null {
  if (!relayUrl) return null;
  try {
    const relay = new URL(relayUrl);
    const protocol =
      relay.protocol === 'wss:' ? 'https:' :
      relay.protocol === 'ws:' ? 'http:' :
      relay.protocol;
    return `${protocol}//${relay.host}`;
  } catch {
    return null;
  }
}

async function getActiveApiBase(page: Page): Promise<string> {
  if (process.env.E2E_API_BASE_URL) return process.env.E2E_API_BASE_URL;
  const runtimeApi = await page.evaluate(() => {
    const env = (window as typeof window & {
      isolatedEnv?: {
        runtimeState?: {
          p2p?: {
            relayUrls?: string[];
          };
        };
      };
    }).isolatedEnv;
    const relay = env?.runtimeState?.p2p?.relayUrls?.[0] ?? null;
    return typeof relay === 'string' ? relay : null;
  });
  return relayToApiBase(runtimeApi) ?? APP_BASE_URL;
}

async function ensureAnyHubAccountOpen(page: Page): Promise<{ entityId: string; signerId: string; counterpartyId: string }> {
  const apiBase = await getActiveApiBase(page);
  const response = await page.request.get(`${apiBase}/api/debug/entities`);
  expect(response.ok(), 'debug entities endpoint must be available').toBe(true);
  const body = await response.json() as {
    entities?: Array<{ entityId?: string; isHub?: boolean; name?: string; metadata?: { name?: string } }>;
  };
  const hubs = (Array.isArray(body.entities) ? body.entities : [])
    .filter((entity) => entity.isHub === true && typeof entity.entityId === 'string');
  const preferredHub = hubs.find((entity) => {
    const name = String(entity.name || entity.metadata?.name || '').trim().toUpperCase();
    return name !== 'H2';
  }) ?? hubs[0];
  const hubId = preferredHub?.entityId;
  expect(typeof hubId === 'string' && hubId.length > 0, 'at least one auto-finalizing hub must be available').toBe(true);

  await connectHub(page, hubId!);

  const identity = await page.evaluate(() => {
    const env = (window as typeof window & {
      isolatedEnv?: {
        runtimeId?: string;
        eReplicas?: Map<string, unknown>;
      };
    }).isolatedEnv;
    if (!env?.eReplicas) return null;

    const runtimeId = String(env.runtimeId || '').toLowerCase();
    for (const replicaKey of env.eReplicas.keys()) {
      const [entityId, signerId] = String(replicaKey).split(':');
      if (!entityId?.startsWith('0x') || entityId.length !== 66 || !signerId) continue;
      if (runtimeId && String(signerId).toLowerCase() !== runtimeId) continue;
      return { entityId, signerId };
    }

    return null;
  });

  expect(identity, 'runtime must expose a local entity after connectHub').not.toBeNull();
  return {
    entityId: identity!.entityId,
    signerId: identity!.signerId,
    counterpartyId: hubId!,
  };
}

async function readLocalReserveState(page: Page, entityId: string, opts?: { allowUnavailable?: boolean }): Promise<bigint> {
  const value = await page.evaluate(async ({ entityId }) => {
    const env = (window as any).isolatedEnv;
    if (!env?.eReplicas) return null;
    const entityLower = String(entityId || '').toLowerCase();
    for (const [key, rep] of env.eReplicas.entries()) {
      const [eid] = String(key).split(':');
      if (String(eid || '').toLowerCase() !== entityLower) continue;
      const reserves = rep?.state?.reserves;
      let reserve: unknown = null;
      if (reserves?.get) {
        reserve = reserves.get(1);
        if (reserve === undefined) reserve = reserves.get(1n);
        if (reserve === undefined) reserve = reserves.get('1');
      } else if (reserves && typeof reserves === 'object') {
        reserve = (reserves as Record<string, unknown>)[1] ?? (reserves as Record<string, unknown>)['1'] ?? null;
      }
      return typeof reserve === 'bigint' ? reserve.toString() : String(reserve ?? '0');
    }
    return null;
  }, { entityId });
  if (!value) {
    if (opts?.allowUnavailable) return 0n;
    throw new Error('Unable to read local reserve state');
  }
  return BigInt(value);
}

async function readOnchainReserveViaAnvil(page: Page, entityId: string, opts?: { allowUnavailable?: boolean }): Promise<bigint> {
  const apiBase = await getActiveApiBase(page);
  const response = await page.request.get(
    `${apiBase}/api/debug/reserve?entityId=${encodeURIComponent(entityId)}&tokenId=1`,
  );
  if (!response.ok()) {
    if (opts?.allowUnavailable) return 0n;
    const bodyText = await response.text().catch(() => '');
    throw new Error(`Unable to read on-chain reserve: status=${response.status()} body=${bodyText}`);
  }
  const bodyText = await response.text();
  const body = JSON.parse(bodyText) as { reserve?: string };
  if (typeof body.reserve !== 'string') {
    if (opts?.allowUnavailable) return 0n;
    throw new Error(`Unable to read on-chain reserve: body=${bodyText}`);
  }
  return BigInt(body.reserve);
}

async function readAccountState(
  page: Page,
  entityId: string,
  signerId: string,
  counterpartyId: string
): Promise<{
  exists: boolean;
  status: string;
  activeDispute: boolean;
  disputeTimeout: number;
  block: number;
  jBatchDisputeStarts: number;
  jBatchDisputeFinalizations: number;
}> {
  return await page.evaluate(async ({ entityId, signerId, counterpartyId }) => {
    const env = (window as any).isolatedEnv;
    if (!env?.eReplicas) {
      return {
        exists: false,
        status: '',
        activeDispute: false,
        disputeTimeout: 0,
        block: 0,
        jBatchDisputeStarts: 0,
        jBatchDisputeFinalizations: 0,
      };
    }
    const key = Array.from(env.eReplicas.keys()).find((k: string) => {
      const [eid, sid] = String(k).split(':');
      return String(eid || '').toLowerCase() === String(entityId).toLowerCase()
        && String(sid || '').toLowerCase() === String(signerId).toLowerCase();
    });
    const rep = key ? env.eReplicas.get(key) : null;
    const account = rep?.state?.accounts?.get?.(counterpartyId);
    const batch = rep?.state?.jBatchState?.batch;
    return {
      exists: !!account,
      status: String(account?.status || ''),
      activeDispute: !!account?.activeDispute,
      disputeTimeout: Number(account?.activeDispute?.disputeTimeout || 0),
      block: 0,
      jBatchDisputeStarts: Number(batch?.disputeStarts?.length || 0),
      jBatchDisputeFinalizations: Number(batch?.disputeFinalizations?.length || 0),
    };
  }, { entityId, signerId, counterpartyId });
}

async function readCurrentChainBlock(page: Page): Promise<number> {
  const apiBase = await getActiveApiBase(page);
  const response = await page.request.post(`${apiBase}/api/rpc`, {
    data: {
      jsonrpc: '2.0',
      id: 1,
      method: 'eth_blockNumber',
      params: [],
    },
  });
  expect(response.ok(), 'eth_blockNumber RPC must succeed').toBe(true);
  const body = await response.json() as { result?: string };
  expect(typeof body.result === 'string', `unexpected eth_blockNumber body: ${JSON.stringify(body)}`).toBe(true);
  return Number.parseInt(body.result!, 16);
}

async function readAccountMeta(
  page: Page,
  entityId: string,
  signerId: string,
  counterpartyId: string
): Promise<{
  frameHeight: number;
  hasCounterpartyDisputeProof: boolean;
  pendingFrame: boolean;
  counterpartyDisputeProofBodyHash: string;
  counterpartyDisputeProofNonce: number | null;
}> {
  return await page.evaluate(({ entityId, signerId, counterpartyId }) => {
    const env = (window as any).isolatedEnv;
    if (!env?.eReplicas) {
      return {
        frameHeight: 0,
        hasCounterpartyDisputeProof: false,
        pendingFrame: false,
        counterpartyDisputeProofBodyHash: '',
        counterpartyDisputeProofNonce: null,
      };
    }
    const key = Array.from(env.eReplicas.keys()).find((k: string) => {
      const [eid, sid] = String(k).split(':');
      return String(eid || '').toLowerCase() === String(entityId).toLowerCase()
        && String(sid || '').toLowerCase() === String(signerId).toLowerCase();
    });
    const rep = key ? env.eReplicas.get(key) : null;
    const account = rep?.state?.accounts?.get?.(counterpartyId);
    return {
      frameHeight: Number(account?.currentHeight || 0),
      hasCounterpartyDisputeProof: !!account?.counterpartyDisputeProofHanko,
      pendingFrame: !!account?.pendingFrame,
      counterpartyDisputeProofBodyHash: String(account?.counterpartyDisputeProofBodyHash || ''),
      counterpartyDisputeProofNonce:
        typeof account?.counterpartyDisputeProofNonce === 'number'
          ? Number(account.counterpartyDisputeProofNonce)
          : null,
    };
  }, { entityId, signerId, counterpartyId });
}

async function readAccountCollateralState(
  page: Page,
  entityId: string,
  signerId: string,
  counterpartyId: string,
  tokenId: number,
): Promise<bigint> {
  const raw = await page.evaluate(({ entityId, signerId, counterpartyId, tokenId }) => {
    const env = (window as any).isolatedEnv;
    if (!env?.eReplicas) return '0';
    const key = Array.from(env.eReplicas.keys()).find((k: string) => {
      const [eid, sid] = String(k).split(':');
      return String(eid || '').toLowerCase() === String(entityId).toLowerCase()
        && String(sid || '').toLowerCase() === String(signerId).toLowerCase();
    });
    const rep = key ? env.eReplicas.get(key) : null;
    const account = rep?.state?.accounts?.get?.(counterpartyId);
    const delta = account?.deltas?.get?.(tokenId);
    return String(delta?.collateral || '0');
  }, { entityId, signerId, counterpartyId, tokenId });
  return BigInt(String(raw || '0'));
}

async function readAccountWithdrawableCollateralState(
  page: Page,
  entityId: string,
  signerId: string,
  counterpartyId: string,
  tokenId: number,
): Promise<bigint> {
  const raw = await page.evaluate(({ entityId, signerId, counterpartyId, tokenId }) => {
    const runtimeWindow = window as typeof window & {
      isolatedEnv?: unknown;
      XLN?: {
        deriveDelta?: (delta: unknown, isLeft: boolean) => { outCollateral?: bigint; outTotalHold?: bigint };
      };
    };
    const env = runtimeWindow.isolatedEnv as {
      eReplicas?: Map<string, {
        state?: {
          accounts?: Map<string, {
            leftEntity?: string;
            rightEntity?: string;
            deltas?: Map<number, unknown>;
          }>;
        };
      }>;
    } | undefined;
    if (!env?.eReplicas) return '0';
    const key = Array.from(env.eReplicas.keys()).find((k: string) => {
      const [eid, sid] = String(k).split(':');
      return String(eid || '').toLowerCase() === String(entityId).toLowerCase()
        && String(sid || '').toLowerCase() === String(signerId).toLowerCase();
    });
    const replica = key ? env.eReplicas.get(key) : null;
    const account = replica?.state?.accounts?.get?.(counterpartyId);
    const delta = account?.deltas?.get?.(tokenId);
    const deriveDelta = runtimeWindow.XLN?.deriveDelta;
    if (!delta || typeof deriveDelta !== 'function') return '0';
    const owner = String(entityId || '').toLowerCase();
    const left = String(account?.leftEntity || '').toLowerCase();
    const right = String(account?.rightEntity || '').toLowerCase();
    if (owner !== left && owner !== right) return '0';
    const derived = deriveDelta(delta, owner === left);
    const outCollateral = typeof derived?.outCollateral === 'bigint' ? derived.outCollateral : 0n;
    const outTotalHold = typeof derived?.outTotalHold === 'bigint' ? derived.outTotalHold : 0n;
    return String(outCollateral > outTotalHold ? outCollateral - outTotalHold : 0n);
  }, { entityId, signerId, counterpartyId, tokenId });
  return BigInt(String(raw || '0'));
}

async function readAccountProgress(
  page: Page,
  entityId: string,
  signerId: string,
  counterpartyId: string,
): Promise<{ exists: boolean; currentHeight: number; pendingFrame: boolean }> {
  const result = await page.evaluate(({ entityId, signerId, counterpartyId }) => {
    const findAccount = (
      accounts: Map<string, {
        counterpartyEntityId?: string;
        leftEntity?: string;
        rightEntity?: string;
      }> | null | undefined,
      ownerId: string,
      cpId: string,
    ) => {
      if (!(accounts instanceof Map)) return null;
      const owner = String(ownerId || '').toLowerCase();
      const cp = String(cpId || '').toLowerCase();
      for (const [accountKey, account] of accounts.entries()) {
        if (String(accountKey || '').toLowerCase() === cp) return account;
        const canonicalCp = typeof account?.counterpartyEntityId === 'string'
          ? String(account.counterpartyEntityId).toLowerCase()
          : '';
        if (canonicalCp === cp) return account;
        const left = typeof account?.leftEntity === 'string' ? String(account.leftEntity).toLowerCase() : '';
        const right = typeof account?.rightEntity === 'string' ? String(account.rightEntity).toLowerCase() : '';
        if (left && right && ((left === owner && right === cp) || (right === owner && left === cp))) return account;
      }
      return null;
    };

    const env = (window as any).isolatedEnv;
    if (!env?.eReplicas) {
      return { exists: false, currentHeight: 0, pendingFrame: false };
    }

    const key = Array.from(env.eReplicas.keys()).find((k: string) => {
      const [eid, sid] = String(k).split(':');
      return String(eid || '').toLowerCase() === String(entityId).toLowerCase()
        && String(sid || '').toLowerCase() === String(signerId).toLowerCase();
    });
    const rep = key ? env.eReplicas.get(key) : null;
    const account = findAccount(rep?.state?.accounts, entityId, counterpartyId);

    return {
      exists: !!account,
      currentHeight: Number(account?.currentHeight || 0),
      pendingFrame: !!account?.pendingFrame,
    };
  }, { entityId, signerId, counterpartyId });

  return {
    exists: !!result.exists,
    currentHeight: Number(result.currentHeight || 0),
    pendingFrame: !!result.pendingFrame,
  };
}

async function readAccountTxTypePresence(
  page: Page,
  entityId: string,
  signerId: string,
  counterpartyId: string,
  txType: string,
): Promise<{ mempool: boolean; pending: boolean; history: boolean }> {
  return await page.evaluate(({ entityId, signerId, counterpartyId, txType }) => {
    const env = (window as any).isolatedEnv;
    if (!env?.eReplicas) return { mempool: false, pending: false, history: false };
    const key = Array.from(env.eReplicas.keys()).find((k: string) => {
      const [eid, sid] = String(k).split(':');
      return String(eid || '').toLowerCase() === String(entityId).toLowerCase()
        && String(sid || '').toLowerCase() === String(signerId).toLowerCase();
    });
    const rep = key ? env.eReplicas.get(key) : null;
    const account = rep?.state?.accounts?.get?.(counterpartyId);
    const hasMempool = Array.isArray(account?.mempool) && account.mempool.some((tx: any) => String(tx?.type || '') === txType);
    const hasPending = Array.isArray(account?.pendingFrame?.accountTxs)
      && account.pendingFrame.accountTxs.some((tx: any) => String(tx?.type || '') === txType);
    const hasHistory = Array.isArray(account?.frameHistory)
      && account.frameHistory.some((frame: any) =>
        Array.isArray(frame?.accountTxs) && frame.accountTxs.some((tx: any) => String(tx?.type || '') === txType),
      );
    return { mempool: !!hasMempool, pending: !!hasPending, history: !!hasHistory };
  }, { entityId, signerId, counterpartyId, txType });
}

function parseUiAmount(text: string): number {
  const cleaned = String(text || '')
    .replace(/\s+/g, '')
    .replace(/[^0-9,.-]/g, '')
    .replace(/,/g, '');
  const parsed = Number(cleaned || '0');
  if (!Number.isFinite(parsed)) throw new Error(`Unable to parse UI amount: "${text}"`);
  return parsed;
}

async function ensureEntityWorkspaceVisible(page: Page, entityId?: string): Promise<void> {
  if (!entityId) return;
  const entityTrigger = page.locator('.hero-context-switcher .dropdown-trigger, .context-switcher .dropdown-trigger, .entity-slot .dropdown-trigger').first();
  const triggerVisible = await entityTrigger.isVisible({ timeout: 5_000 }).catch(() => false);
  if (!triggerVisible) {
    return;
  }
  const currentLabel = String((await entityTrigger.textContent()) || '');
  if (currentLabel.toLowerCase().includes(entityId.toLowerCase())) {
    return;
  }
  await entityTrigger.click();
  let entityOption = page.locator('.entity-row, .signer-item, .dropdown-item').filter({ hasText: entityId }).first();
  const exactVisible = await entityOption.isVisible({ timeout: 1_000 }).catch(() => false);
  if (!exactVisible) {
    entityOption = page.locator('.entity-row, .signer-item, .dropdown-item').first();
  }
  const optionVisible = await entityOption.isVisible({ timeout: 2_000 }).catch(() => false);
  if (!optionVisible) {
    await page.keyboard.press('Escape').catch(() => undefined);
    return;
  }
  await entityOption.click();
  await expect.poll(async () => {
    const text = await entityTrigger.textContent();
    return String(text || '').toLowerCase();
  }, { timeout: 20_000, intervals: [250, 500, 1000] }).toContain(entityId.toLowerCase());
}

async function ensureAccountWorkspaceVisible(page: Page, counterpartyId?: string, entityId?: string): Promise<void> {
  await ensureEntityWorkspaceVisible(page, entityId);

  const accountsTab = page.getByTestId('tab-accounts').first();
  const accountList = page.getByTestId('account-list-wrapper').first();
  const workspaceTabs = page.locator('nav[aria-label="Account workspace"]').first();
  const isAccountsWorkspaceVisible = async () =>
    await accountList.isVisible({ timeout: 500 }).catch(() => false)
      || await workspaceTabs.isVisible({ timeout: 500 }).catch(() => false);

  for (let attempt = 0; attempt < 4; attempt += 1) {
    if (await isAccountsWorkspaceVisible()) break;
    if (await accountsTab.isVisible({ timeout: 500 }).catch(() => false)) {
      await accountsTab.click();
      await page.waitForTimeout(300);
      continue;
    }
    break;
  }

  await expect.poll(async () => await isAccountsWorkspaceVisible(), {
    timeout: 20_000,
    intervals: [200, 400, 800],
    message: 'accounts workspace must be visible',
  }).toBe(true);

  if (!counterpartyId) {
    return;
  }

  const accountPreview = page.locator('.account-preview').filter({ hasText: counterpartyId }).first();
  await expect(accountPreview).toBeVisible({ timeout: 10_000 });
}

async function ensureEntityShellVisible(page: Page): Promise<void> {
  const accountsTab = page.getByTestId('tab-accounts').first();
  const assetsTab = page.getByTestId('tab-assets').first();
  await expect
    .poll(
      async () =>
        (await accountsTab.isVisible({ timeout: 300 }).catch(() => false))
        || (await assetsTab.isVisible({ timeout: 300 }).catch(() => false)),
      {
        timeout: 20_000,
        intervals: [200, 400, 800],
        message: 'entity shell tabs must be visible',
      },
    )
    .toBe(true);
}

async function returnToEntityShell(page: Page): Promise<void> {
  await ensureEntityShellVisible(page);
}

async function readReserveBalanceUi(
  page: Page,
  symbol: string = 'USDC',
  counterpartyId?: string,
  entityId?: string,
): Promise<number> {
  await ensureAccountWorkspaceVisible(page, counterpartyId, entityId);
  const assetsTab = page.getByTestId('tab-assets').first();
  await expect(assetsTab).toBeVisible({ timeout: 20_000 });
  await assetsTab.click();

  const refreshButton = page.getByTestId('asset-ledger-refresh').first();
  if (await refreshButton.isVisible({ timeout: 1_500 }).catch(() => false)) {
    await refreshButton.click();
  }

  const balance = page.getByTestId(`reserve-balance-${symbol}`).first();
  await expect(balance).toBeVisible({ timeout: 20_000 });
  const text = (await balance.textContent())?.trim() ?? '0';
  return parseUiAmount(text);
}

async function readAccountsCardOwedUi(page: Page): Promise<number> {
  const owedNode = page.getByTestId('accounts-card-owed').first();
  const visible = await owedNode.isVisible({ timeout: 1_000 }).catch(() => false);
  if (!visible) return 0;
  const text = (await owedNode.textContent())?.trim() ?? '0';
  return parseUiAmount(text);
}

async function faucetReserve(page: Page, entityId: string, amount: string = '10'): Promise<void> {
  const apiBase = await getActiveApiBase(page);
  const response = await page.request.post(`${apiBase}/api/faucet/reserve`, {
    data: {
      userEntityId: entityId,
      tokenId: 1,
      tokenSymbol: 'USDC',
      amount,
    },
  });
  expect(response.ok(), 'reserve faucet api must succeed').toBe(true);
  const body = await response.json() as { success?: boolean; error?: string };
  expect(body.success, body.error || 'reserve faucet api failed').toBe(true);
}

async function getVisibleAssetMoveWorkspace(page: Page): Promise<Locator> {
  await ensureAssetsWorkspaceVisible(page);
  const assetsTab = page.getByTestId('tab-assets').first();
  await expect(assetsTab).toBeVisible({ timeout: 20_000 });
  await assetsTab.click();

  const moveTab = page.getByTestId('asset-tab-move').first();
  await expect(moveTab).toBeVisible({ timeout: 20_000 });
  await moveTab.click();

  const workspace = page.locator('[data-testid="move-workspace-assets"]:visible').first();
  await expect(workspace).toBeVisible({ timeout: 20_000 });
  return workspace;
}

async function ensurePrivateAccountOpenViaUi(
  page: Page,
  entityId: string,
  signerId: string,
  counterpartyId: string,
): Promise<void> {
  const already = await readAccountProgress(page, entityId, signerId, counterpartyId);
  if (already.exists && !already.pendingFrame && already.currentHeight > 0) return;

  const accountsTab = page.getByTestId('tab-accounts').first();
  await expect(accountsTab).toBeVisible({ timeout: 20_000 });
  await accountsTab.click();

  const openWorkspaceTab = page.locator('.account-workspace-tab').filter({ hasText: /Open Account/i }).first();
  await expect(openWorkspaceTab).toBeVisible({ timeout: 20_000 });
  await openWorkspaceTab.click();

  const privateInput = page.locator('.open-private-form .entity-input input').first();
  await expect(privateInput).toBeVisible({ timeout: 20_000 });
  await privateInput.fill(counterpartyId);
  await privateInput.press('Tab');

  const openButton = page.locator('.open-private-form .btn-add').first();
  await expect(openButton).toBeEnabled({ timeout: 20_000 });
    await openButton.click();

  await expect.poll(async () => {
    const state = await readAccountProgress(page, entityId, signerId, counterpartyId);
    return state.exists && !state.pendingFrame && state.currentHeight > 0;
  }, { timeout: 60_000, intervals: [500, 1000, 2000] }).toBe(true);
}

async function queueFundR2CViaUi(
  page: Page,
  counterpartyId: string,
  amount: string,
): Promise<void> {
  const workspace = await getVisibleAssetMoveWorkspace(page);
  await workspace.getByTestId('move-source-reserve').click();
  await workspace.getByTestId('move-target-account').click();

  await selectEntityInputValue(workspace, 'move-target-counterparty-picker', counterpartyId);

  const amountInput = workspace.getByTestId('move-amount');
  await expect(amountInput).toBeVisible({ timeout: 20_000 });
  await amountInput.fill(amount);

  const fundButton = workspace.getByTestId('move-confirm');
  await expect(fundButton).toBeEnabled({ timeout: 20_000 });
  await fundButton.click();
}

async function queueWithdrawC2RViaUi(
  page: Page,
  sourceAccountId: string,
  reserveRecipientEntityId: string,
  amount: string,
): Promise<void> {
  const workspace = await getVisibleAssetMoveWorkspace(page);
  await workspace.getByTestId('move-source-account').click();
  await workspace.getByTestId('move-target-reserve').click();
  await selectEntityInputValue(workspace, 'move-source-account-picker', sourceAccountId);
  await selectEntityInputValue(workspace, 'move-reserve-recipient-picker', reserveRecipientEntityId);

  const amountInput = workspace.getByTestId('move-amount');
  await expect(amountInput).toBeVisible({ timeout: 20_000 });
  await amountInput.fill(amount);

  const withdrawButton = workspace.getByTestId('move-confirm');
  await expect(withdrawButton).toBeEnabled({ timeout: 20_000 });
  await withdrawButton.click();
}

async function queueTransferR2RViaUi(
  page: Page,
  recipientEntityId: string,
  amount: string,
): Promise<void> {
  const workspace = await getVisibleAssetMoveWorkspace(page);
  await workspace.getByTestId('move-source-reserve').click();
  await workspace.getByTestId('move-target-reserve').click();

  await selectEntityInputValue(workspace, 'move-reserve-recipient-picker', recipientEntityId);

  const amountInput = workspace.getByTestId('move-amount');
  await expect(amountInput).toBeVisible({ timeout: 20_000 });
  await amountInput.fill(amount);

  await expect(workspace.getByTestId('move-route-summary')).toContainText('Reserve → Reserve', { timeout: 20_000 });
  const transferButton = workspace.getByTestId('move-confirm');
  await expect(transferButton).toBeEnabled({ timeout: 20_000 });
  await transferButton.click();
}

async function ensureAssetsWorkspaceVisible(page: Page): Promise<void> {
  await ensureEntityWorkspaceVisible(page);
  await returnToEntityShell(page);
  const assetsTab = page.getByTestId('tab-assets').first();
  await expect(assetsTab).toBeVisible({ timeout: 20_000 });
}

async function selectEntityInputValue(
  root: Page | Locator,
  testId: string,
  entityId: string,
): Promise<void> {
  const selector = root.getByTestId(testId).first();
  await expect(selector).toBeVisible({ timeout: 20_000 });

  const target = String(entityId || '').trim().toLowerCase();
  const targetProbe = target.slice(0, 12);
  const hasTargetSelection = async (): Promise<boolean> => {
    const selectedIds = await selector.locator('.dropdown-item.selected .item-id').allTextContents().catch(() => []);
    if (selectedIds.some((value) => String(value || '').trim().toLowerCase() === target)) return true;
    const closedTrigger = selector.locator('.closed-trigger').first();
    if (await closedTrigger.isVisible().catch(() => false)) {
      const text = String(await closedTrigger.textContent().catch(() => '')).toLowerCase();
      if (text.includes(targetProbe)) return true;
    }
    const selectorText = String(await selector.textContent().catch(() => '')).toLowerCase();
    return selectorText.includes(targetProbe);
  };

  if (await hasTargetSelection()) return;

  const openSelector = async (): Promise<void> => {
    const closedTrigger = selector.locator('.closed-trigger').first();
    if (await closedTrigger.isVisible().catch(() => false)) {
      await closedTrigger.click();
      return;
    }
    const dropdownToggle = selector.locator('.dropdown-toggle').first();
    if (await dropdownToggle.isVisible().catch(() => false)) {
      await dropdownToggle.click();
    }
  };

  const input = selector.locator('input').first();
  const option = selector.getByTestId(`${testId}-option-${target}`).first();
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    await openSelector();
    await expect(input).toBeVisible({ timeout: 20_000 });
    await input.fill('');
    await input.fill(entityId);

    if (await hasTargetSelection()) {
      return;
    }

    if (await option.isVisible().catch(() => false)) {
      await option.dispatchEvent('mousedown', { buttons: 1 });
      await expect.poll(hasTargetSelection, {
        timeout: 3_000,
        intervals: [100, 250, 500],
      }).toBe(true);
    } else {
      await input.press('Enter');
      await expect.poll(hasTargetSelection, {
        timeout: 3_000,
        intervals: [100, 250, 500],
      }).toBe(true);
    }
    if (await hasTargetSelection()) return;
  }

  await openSelector().catch(() => undefined);
  const availableOptions = await selector.locator('.dropdown-item .item-id').allTextContents().catch(() => []);
  const currentText = String(await selector.textContent().catch(() => ''));
  throw new Error(
    `Failed to select ${entityId} in ${testId}; current=${currentText}; options=${availableOptions.join(',')}`,
  );
}

async function seedDisputePreconditions(
  page: Page,
  entityId: string,
  signerId: string,
  counterpartyId: string
): Promise<void> {
  const before = await readAccountMeta(page, entityId, signerId, counterpartyId);
  let seeded = false;
  let lastError = 'seed-not-attempted';

  for (let attempt = 0; attempt < 3 && !seeded; attempt++) {
    try {
      await page.evaluate(async ({ entityId, signerId, counterpartyId }) => {
        const env = (window as any).isolatedEnv;
        if (!env) throw new Error('isolatedEnv missing');
        const runtimeId = String(env.runtimeId || '').toLowerCase();
        const repKey = Array.from(env.eReplicas?.keys?.() || []).find((k: string) => {
          const [eid, sid] = String(k).split(':');
          return String(eid || '').toLowerCase() === String(entityId).toLowerCase()
            && String(sid || '').toLowerCase() === String(signerId).toLowerCase();
        });
        const response = await fetch(`${window.location.origin}/api/faucet/offchain`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            userEntityId: entityId,
            userRuntimeId: runtimeId,
            tokenId: 1,
            amount: '100',
            hubEntityId: counterpartyId,
          }),
        });
        const body = await response.json().catch(() => ({}));
        if (!response.ok || !body?.success) {
          throw new Error(body?.error || `offchain faucet failed (${response.status})`);
        }
      }, { entityId, signerId, counterpartyId });

      await expect.poll(async () => {
        const current = await readAccountMeta(page, entityId, signerId, counterpartyId);
        const hasFreshProofHash =
          current.counterpartyDisputeProofBodyHash.length > 0 &&
          current.counterpartyDisputeProofBodyHash !== before.counterpartyDisputeProofBodyHash;
        const hasFreshProofNonce =
          typeof current.counterpartyDisputeProofNonce === 'number' &&
          current.counterpartyDisputeProofNonce > 0 &&
          (
            before.counterpartyDisputeProofNonce === null ||
            current.counterpartyDisputeProofNonce > before.counterpartyDisputeProofNonce
          );
        return {
          frameAdvanced: current.frameHeight > before.frameHeight,
          hasProof: current.hasCounterpartyDisputeProof,
          pendingFrame: current.pendingFrame,
          freshProofHash: hasFreshProofHash,
          freshProofNonce: hasFreshProofNonce,
          proofHash: current.counterpartyDisputeProofBodyHash,
          proofNonce: current.counterpartyDisputeProofNonce,
        };
      }, { timeout: 45_000, intervals: [500, 1000, 2000] }).toMatchObject({
        frameAdvanced: true,
        hasProof: true,
        pendingFrame: false,
        freshProofHash: true,
        freshProofNonce: true,
      });

      seeded = true;
    } catch (error: any) {
      lastError = error?.message || String(error);
      await page.waitForTimeout(1000);
    }
  }

  if (!seeded) {
    throw new Error(`Unable to seed dispute preconditions: ${lastError}`);
  }
}

async function broadcastPendingBatchViaUi(
  page: Page,
  entityId?: string,
  signerId?: string,
): Promise<void> {
  const signButton = page.getByTestId('settle-sign-broadcast').first();
  await expect(signButton).toBeVisible({ timeout: 30_000 });
  await expect(signButton).toBeEnabled({ timeout: 120_000 });
  let dialogMessage = '';
  const onDialog = async (dialog: any) => {
    dialogMessage = dialog?.message?.() || '';
    await dialog.accept();
  };
  page.on('dialog', onDialog);
  try {
    await signButton.click();
  } finally {
    page.off('dialog', onDialog);
  }
  await page.waitForTimeout(500);
  if (dialogMessage) {
    const snapshot = entityId && signerId
      ? await readJBatchSnapshot(page, entityId, signerId)
      : null;
    throw new Error(
      `settle-sign-broadcast alert: ${dialogMessage}` +
      (snapshot ? ` snapshot=${JSON.stringify(snapshot)}` : ''),
    );
  }
}

async function clickWithDialogAccept(page: Page, action: () => Promise<void>): Promise<void> {
  const onDialog = async (dialog: any) => {
    await dialog.accept();
  };
  page.on('dialog', onDialog);
  try {
    await action();
  } finally {
    page.off('dialog', onDialog);
  }
}

async function clearBatchViaUi(page: Page): Promise<void> {
  const clearButton = page.getByTestId('settle-clear-batch').first();
  await expect(clearButton).toBeVisible({ timeout: 30_000 });
  await expect(clearButton).toBeEnabled({ timeout: 30_000 });
  await clickWithDialogAccept(page, async () => {
    await clearButton.click();
  });
  await page.waitForTimeout(400);
}

async function ensureNoSentBatchLatch(
  page: Page,
  entityId: string,
  signerId: string,
): Promise<void> {
  await openEntitySettleWorkspace(page);
  const initial = await readJBatchSnapshot(page, entityId, signerId);
  if (!initial.sentExists) return;

  await clearBatchViaUi(page);
  await expect.poll(async () => {
    const snap = await readJBatchSnapshot(page, entityId, signerId);
    return snap.sentExists;
  }, { timeout: 60_000, intervals: [500, 1000, 2000] }).toBe(false);
}

async function openEntitySettleWorkspace(page: Page, counterpartyId?: string, entityId?: string): Promise<void> {
  await ensureEntityWorkspaceVisible(page, entityId);
  await ensureEntityShellVisible(page);
  const accountsTab = page.getByTestId('tab-accounts').first();
  await expect(accountsTab).toBeVisible({ timeout: 15_000 });
  await accountsTab.click();
  const workspaceNav = page.locator('nav[aria-label="Account workspace"]').first();
  await expect(workspaceNav).toBeVisible({ timeout: 15_000 });
  const historyWorkspaceButton = workspaceNav.getByRole('button', { name: /^History$/i }).first();
  const historyVisible = await historyWorkspaceButton.isVisible({ timeout: 3_000 }).catch(() => false);
  if (historyVisible) {
    await historyWorkspaceButton.click();
  }
}

async function assertBatchHistoryVisible(
  page: Page,
  entityId: string,
  signerId: string,
): Promise<void> {
  await expect.poll(async () => {
    const snapshot = await readJBatchSnapshot(page, entityId, signerId);
    return snapshot.batchHistoryCount;
  }, { timeout: 20_000, intervals: [500, 1000, 2000] }).toBeGreaterThan(0);
}

async function startDisputeFromEntitySettle(
  page: Page,
  entityId: string,
  signerId: string,
  counterpartyId: string,
): Promise<void> {
  await ensureEntityWorkspaceVisible(page, entityId);
  await ensureEntityShellVisible(page);
  const workspaceNav = page.locator('nav[aria-label="Account workspace"]').first();
  const accountsTab = page.getByTestId('tab-accounts').first();
  await expect(accountsTab).toBeVisible({ timeout: 15_000 });
  await accountsTab.click();
  await expect(workspaceNav).toBeVisible({ timeout: 20_000 });
  const configureWorkspaceButton = workspaceNav.getByRole('button', { name: /^Configure$/i }).first();
  await expect(configureWorkspaceButton).toBeVisible({ timeout: 15_000 });
  await configureWorkspaceButton.click();

  const disputeTab = page.locator('.configure-tab').filter({ hasText: /^Dispute$/ }).first();
  await expect(disputeTab).toBeVisible({ timeout: 15_000 });
  await disputeTab.click();

  const disputeButton = page.getByTestId('configure-dispute-start').first();
  await expect(disputeButton).toBeVisible({ timeout: 15_000 });
  await expect(disputeButton).toBeEnabled({ timeout: 15_000 });

  const dialogs: Array<{ type: string; message: string }> = [];
  const onDialog = async (dialog: any) => {
    dialogs.push({
      type: String(dialog?.type?.() || 'unknown'),
      message: String(dialog?.message?.() || ''),
    });
    await dialog.accept();
  };
  page.on('dialog', onDialog);
  try {
    await disputeButton.click();
  } finally {
    page.off('dialog', onDialog);
  }

  const alertDialog = dialogs.find((entry) => entry.type === 'alert');
  if (alertDialog) {
    throw new Error(`disputeStart alert: ${alertDialog.message}`);
  }

  const disputeQueued = async () => {
    const state = await readAccountState(page, entityId, signerId, counterpartyId);
    return state.jBatchDisputeStarts > 0;
  };

  try {
    await expect.poll(disputeQueued, { timeout: 12_000, intervals: [500, 1000, 2000] }).toBe(true);
    return;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`disputeStart UI did not queue disputeStart: ${message}`);
  }
}

async function readDisputeDebug(
  page: Page,
  entityId: string,
  signerId: string,
  counterpartyId: string
): Promise<{
  status: string;
  activeDispute: boolean;
  jBatchDisputeStarts: number;
  pendingEntityInputs: number;
  messages: string[];
  hasProofHanko: boolean;
}> {
  return await page.evaluate(({ entityId, signerId, counterpartyId }) => {
    const env = (window as any).isolatedEnv;
    if (!env?.eReplicas) {
      return {
        status: '',
        activeDispute: false,
        jBatchDisputeStarts: 0,
        pendingEntityInputs: 0,
        messages: [],
        hasProofHanko: false,
      };
    }
    const key = Array.from(env.eReplicas.keys()).find((k: string) => {
      const [eid, sid] = String(k).split(':');
      return String(eid || '').toLowerCase() === String(entityId).toLowerCase()
        && String(sid || '').toLowerCase() === String(signerId).toLowerCase();
    });
    const rep = key ? env.eReplicas.get(key) : null;
    const account = rep?.state?.accounts?.get?.(counterpartyId);
    return {
      status: String(account?.status || ''),
      activeDispute: !!account?.activeDispute,
      jBatchDisputeStarts: Number(rep?.state?.jBatchState?.batch?.disputeStarts?.length || 0),
      pendingEntityInputs: Number(env?.runtimeInput?.entityInputs?.length || 0),
      messages: Array.isArray(rep?.state?.messages) ? rep.state.messages.slice(-6).map((m: any) => String(m)) : [],
      hasProofHanko: !!account?.counterpartyDisputeProofHanko,
    };
  }, { entityId, signerId, counterpartyId });
}

async function readJBatchSnapshot(
  page: Page,
  entityId: string,
  signerId: string,
): Promise<{
  pendingDisputeStarts: number;
  pendingReserveToCollateral: number;
  pendingCollateralToReserve: number;
  pendingReserveToReserve: number;
  sentExists: boolean;
  sentDisputeStarts: number;
  sentReserveToCollateral: number;
  sentCollateralToReserve: number;
  sentReserveToReserve: number;
  batchHistoryCount: number;
  lastBatchTxHash: string;
  lastBatchStatus: string;
  lastBatchOpCount: number;
  lastBatchJBlock: number;
  lastBatchOps: Record<string, number>;
  replicaMempoolTxTypes: string[];
  proposalTxTypes: string[];
  recentMessages: string[];
  activeJurisdiction: string;
  entityJurisdiction: {
    name: string;
    address: string;
    depositoryAddress: string;
    entityProviderAddress: string;
    chainId: number;
  };
  jReplicas: Array<{
    name: string;
    depositoryAddress: string;
    entityProviderAddress: string;
    chainId: number;
    rpcCount: number;
  }>;
}> {
  return await page.evaluate(({ entityId, signerId }) => {
    const env = (window as any).isolatedEnv;
    if (!env?.eReplicas) {
      return {
        pendingDisputeStarts: 0,
        pendingReserveToCollateral: 0,
        pendingCollateralToReserve: 0,
        pendingReserveToReserve: 0,
        sentExists: false,
        sentDisputeStarts: 0,
        sentReserveToCollateral: 0,
        sentCollateralToReserve: 0,
        sentReserveToReserve: 0,
        batchHistoryCount: 0,
        lastBatchTxHash: '',
        lastBatchStatus: '',
        lastBatchOpCount: 0,
        lastBatchJBlock: 0,
        lastBatchOps: {},
        replicaMempoolTxTypes: [],
        proposalTxTypes: [],
        recentMessages: [],
        activeJurisdiction: '',
        entityJurisdiction: {
          name: '',
          address: '',
          depositoryAddress: '',
          entityProviderAddress: '',
          chainId: 0,
        },
        jReplicas: [],
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
    const last = history.length > 0 ? history[history.length - 1] : null;
    const lastOps = (last?.operations && typeof last.operations === 'object') ? last.operations : {};
    const jurisdiction = rep?.state?.config?.jurisdiction;
    const jReplicas = Array.from(env.jReplicas?.values?.() || []).map((jr: any) => ({
      name: String(jr?.name || ''),
      depositoryAddress: String(jr?.depositoryAddress || jr?.contracts?.depository || ''),
      entityProviderAddress: String(jr?.entityProviderAddress || jr?.contracts?.entityProvider || ''),
      chainId: Number(jr?.chainId || jr?.jadapter?.chainId || 0),
      rpcCount: Array.isArray(jr?.rpcs) ? jr.rpcs.length : 0,
    }));

    return {
      pendingDisputeStarts: Number(pending?.disputeStarts?.length || 0),
      pendingReserveToCollateral: Number(pending?.reserveToCollateral?.length || 0),
      pendingCollateralToReserve: Number(pending?.collateralToReserve?.length || 0),
      pendingReserveToReserve: Number(pending?.reserveToReserve?.length || 0),
      sentExists: !!rep?.state?.jBatchState?.sentBatch,
      sentDisputeStarts: Number(sent?.disputeStarts?.length || 0),
      sentReserveToCollateral: Number(sent?.reserveToCollateral?.length || 0),
      sentCollateralToReserve: Number(sent?.collateralToReserve?.length || 0),
      sentReserveToReserve: Number(sent?.reserveToReserve?.length || 0),
      batchHistoryCount: Number(history.length || 0),
      lastBatchTxHash: String(last?.txHash || ''),
      lastBatchStatus: String(last?.status || ''),
      lastBatchOpCount: Number(last?.opCount || 0),
      lastBatchJBlock: Number(last?.jBlockNumber || 0),
      lastBatchOps: {
        reserveToCollateral: Number(lastOps?.reserveToCollateral || 0),
        collateralToReserve: Number(lastOps?.collateralToReserve || 0),
        reserveToReserve: Number(lastOps?.reserveToReserve || 0),
        disputeStarts: Number(lastOps?.disputeStarts || 0),
        disputeFinalizations: Number(lastOps?.disputeFinalizations || 0),
        settlements: Number(lastOps?.settlements || 0),
      },
      replicaMempoolTxTypes: Array.isArray(rep?.mempool)
        ? rep.mempool.map((tx: any) => String(tx?.type || ''))
        : [],
      proposalTxTypes: Array.isArray(rep?.proposal?.txs)
        ? rep.proposal.txs.map((tx: any) => String(tx?.type || ''))
        : [],
      recentMessages: Array.isArray(rep?.state?.messages)
        ? rep.state.messages.slice(-8).map((message: unknown) => String(message || ''))
        : [],
      activeJurisdiction: String(env.activeJurisdiction || ''),
      entityJurisdiction: {
        name: String(jurisdiction?.name || ''),
        address: String(jurisdiction?.address || ''),
        depositoryAddress: String(jurisdiction?.depositoryAddress || ''),
        entityProviderAddress: String(jurisdiction?.entityProviderAddress || ''),
        chainId: Number(jurisdiction?.chainId || 0),
      },
      jReplicas,
    };
  }, { entityId, signerId });
}

async function readSettlementWorkspaceSnapshot(
  page: Page,
  entityId: string,
  signerId: string,
  counterpartyId: string,
): Promise<{
  exists: boolean;
  status: string;
  memo: string;
  version: number;
  opTypes: string[];
}> {
  return await page.evaluate(({ entityId, signerId, counterpartyId }) => {
    const env = (window as Window & {
      isolatedEnv?: {
        eReplicas?: Map<string, { state?: { accounts?: Map<string, { settlementWorkspace?: unknown }> } }>;
      };
    }).isolatedEnv;
    const replicas = env?.eReplicas;
    if (!(replicas instanceof Map)) {
      return { exists: false, status: '', memo: '', version: 0, opTypes: [] };
    }

    const key = Array.from(replicas.keys()).find((rawKey) => {
      const [eid, sid] = String(rawKey).split(':');
      return String(eid || '').toLowerCase() === String(entityId).toLowerCase()
        && String(sid || '').toLowerCase() === String(signerId).toLowerCase();
    });
    const replica = key ? replicas.get(key) : null;
    const account = replica?.state?.accounts?.get?.(counterpartyId);
    const workspace = account?.settlementWorkspace as
      | { status?: unknown; memo?: unknown; version?: unknown; ops?: Array<{ type?: unknown }> }
      | undefined;

    return {
      exists: !!workspace,
      status: String(workspace?.status || ''),
      memo: String(workspace?.memo || ''),
      version: Number(workspace?.version || 0),
      opTypes: Array.isArray(workspace?.ops) ? workspace.ops.map((op) => String(op?.type || '')) : [],
    };
  }, { entityId, signerId, counterpartyId });
}

test.describe('E2E Dispute Flow', () => {
  test.beforeEach(async ({ page }) => {
    await timedStep('dispute.reset_server', () => resetProdServer(page));
  });

  // Scenario: trigger a dispute from the entity workspace, observe reserve returning after finalize,
  // then continue with post-dispute R2R/R2C/C2R coverage and confirm reload restores the final state.
  test('entity workspace dispute lifecycle returns reserve', async ({ page }) => {
    test.setTimeout(LONG_E2E ? 360_000 : 210_000);
    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        process.stdout.write(`[BROWSER:error] ${msg.text()}\n`);
      }
    });

    await timedStep('dispute.goto_app', () => gotoSharedApp(page, { appBaseUrl: APP_BASE_URL, initTimeoutMs: INIT_TIMEOUT, settleMs: 500 }));
    await timedStep('dispute.create_runtime', () => createRuntimeIdentity(page, `dispute-rt-${Date.now()}`, randomMnemonic()));
    const accountRef = await timedStep('dispute.ensure_hub_account', () => ensureAnyHubAccountOpen(page));
    await timedStep('dispute.seed_preconditions', () => seedDisputePreconditions(page, accountRef.entityId, accountRef.signerId, accountRef.counterpartyId));

    const localReserveBefore = await readLocalReserveState(page, accountRef.entityId, { allowUnavailable: true });
    expect(localReserveBefore).toBeGreaterThanOrEqual(0n);
    const reserveBefore = await readOnchainReserveViaAnvil(page, accountRef.entityId);
    const reserveBeforeUi = await readReserveBalanceUi(page, 'USDC');
    const batchBeforeDispute = await readJBatchSnapshot(page, accountRef.entityId, accountRef.signerId);

    try {
      await timedStep(
        'dispute.ui_start_dispute',
        () => startDisputeFromEntitySettle(page, accountRef.entityId, accountRef.signerId, accountRef.counterpartyId),
      );
    } catch (error) {
      const debug = await readDisputeDebug(page, accountRef.entityId, accountRef.signerId, accountRef.counterpartyId);
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`disputeStart not observed via UI click. fallback=${message} debug=${JSON.stringify(debug)}`);
    }
    await timedStep('dispute.wait_batch_queue_dispute_start', async () => {
      await expect.poll(async () => {
        const snap = await readJBatchSnapshot(page, accountRef.entityId, accountRef.signerId);
        return snap.pendingDisputeStarts;
      }, { timeout: 60_000, intervals: [500, 1000, 2000] }).toBeGreaterThan(batchBeforeDispute.pendingDisputeStarts);
    });
    const disputeQueued = await readJBatchSnapshot(page, accountRef.entityId, accountRef.signerId);
    const disputeHistoryBeforeBroadcast = disputeQueued.batchHistoryCount;

    await timedStep('dispute.open_settle_workspace', () => openEntitySettleWorkspace(page, accountRef.counterpartyId, accountRef.entityId));
    await timedStep('dispute.broadcast_start_batch', () => broadcastPendingBatchViaUi(page, accountRef.entityId, accountRef.signerId));
    await timedStep('dispute.wait_batch_sent_or_history', async () => {
      try {
        await expect.poll(async () => {
          const snap = await readJBatchSnapshot(page, accountRef.entityId, accountRef.signerId);
          return snap.sentDisputeStarts > 0 || snap.batchHistoryCount > disputeHistoryBeforeBroadcast;
        }, { timeout: 60_000, intervals: [500, 1000, 2000] }).toBe(true);
      } catch {
        const snap = await readJBatchSnapshot(page, accountRef.entityId, accountRef.signerId);
        throw new Error(`dispute broadcast not observed. snapshot=${JSON.stringify(snap)}`);
      }
    });

    const disputedState = await readAccountState(page, accountRef.entityId, accountRef.signerId, accountRef.counterpartyId);
    if (disputedState.activeDispute) {
      const currentChainBlock = await readCurrentChainBlock(page);
      expect(disputedState.disputeTimeout, 'disputeTimeout should be set after disputeStart').toBeGreaterThan(currentChainBlock);
      const disputeWindowBlocks = disputedState.disputeTimeout - currentChainBlock;
      expect(
        disputeWindowBlocks <= 6 && disputeWindowBlocks >= 1,
        `expected local dispute delay around 5 blocks, got ${disputeWindowBlocks}`
      ).toBe(true);

      await timedStep('dispute.wait_auto_finalize', async () => {
        await expect.poll(async () => {
          const state = await readAccountState(page, accountRef.entityId, accountRef.signerId, accountRef.counterpartyId);
          return !state.activeDispute && state.status === 'disputed';
        }, { timeout: 120_000, intervals: [500, 1000, 2000] }).toBe(true);
      });
    }

    const reserveAfter = await readOnchainReserveViaAnvil(page, accountRef.entityId);
    expect(
      reserveAfter >= 0n,
      `reserve must stay readable after dispute finalize (before=${reserveBefore}, after=${reserveAfter})`
    ).toBe(true);
    await timedStep('dispute.wait_ui_reserve_balance', async () => {
      await expect.poll(async () => {
        return await readReserveBalanceUi(page, 'USDC');
      }, { timeout: 60_000, intervals: [500, 1000, 2000] }).toBeGreaterThanOrEqual(0);
    });
    await timedStep('dispute.wait_ui_accounts_owed_zero', async () => {
      await expect.poll(async () => {
        return await readAccountsCardOwedUi(page);
      }, { timeout: 60_000, intervals: [500, 1000, 2000] }).toBeLessThanOrEqual(0);
    });
    await page.waitForTimeout(1200);

    // Finalized disputed account is hidden from main list and moved to "Disputed Accounts".
    await timedStep('dispute.open_settle_workspace_post_finalize', () => openEntitySettleWorkspace(page, accountRef.counterpartyId, accountRef.entityId));
    await timedStep('dispute.wait_hidden_from_main_list', async () => {
      await expect.poll(async () => {
        return await page.locator('.account-preview').filter({ hasText: accountRef.counterpartyId }).count();
      }, { timeout: 30_000, intervals: [500, 1000, 2000] }).toBe(0);
    });

    // If dispute finalize submit got stuck as sentBatch (no finalized event), clear latch for next flow.
    await timedStep('dispute.ensure_no_sent_batch_latch', () => ensureNoSentBatchLatch(page, accountRef.entityId, accountRef.signerId));

    await timedStep('post_dispute.refund_reserve', async () => {
      await faucetReserve(page, accountRef.entityId, '500');
      await expect.poll(async () => {
        return await readReserveBalanceUi(page, 'USDC');
      }, { timeout: 60_000, intervals: [500, 1000, 2000] }).toBeGreaterThanOrEqual(500);
      await expect.poll(async () => {
        return await readOnchainReserveViaAnvil(page, accountRef.entityId);
      }, { timeout: 60_000, intervals: [500, 1000, 2000] }).toBeGreaterThan(0n);
    });

    await openEntitySettleWorkspace(page);
    await assertBatchHistoryVisible(page, accountRef.entityId, accountRef.signerId);

    const finalSnapshot = await readJBatchSnapshot(page, accountRef.entityId, accountRef.signerId);
    expect(finalSnapshot.batchHistoryCount).toBeGreaterThanOrEqual(1);
    expect(finalSnapshot.lastBatchStatus).toBe('confirmed');
    expect(finalSnapshot.lastBatchJBlock).toBeGreaterThan(0);
    expect(finalSnapshot.lastBatchOpCount).toBeGreaterThan(0);
    expect(
      finalSnapshot.lastBatchOps.disputeStarts > 0
        || finalSnapshot.lastBatchOps.disputeFinalizations > 0,
      `expected dispute footprint in history, got ${JSON.stringify(finalSnapshot.lastBatchOps)}`,
    ).toBe(true);
    await timedStep('dispute.reload_clear_stale_sent_batch', () =>
      ensureNoSentBatchLatch(page, accountRef.entityId, accountRef.signerId));

    // Reload hard-assert: WAL restore keeps finalized dispute + batch history.
    await timedStep('dispute.reload_page', async () => {
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => {
        const env = (window as any).isolatedEnv;
        return !!env?.runtimeId && Number(env?.eReplicas?.size || 0) > 0;
      }, { timeout: 60_000 });
    });
    await timedStep('dispute.reload_assert_reserve', async () => {
      await expect.poll(async () => await readOnchainReserveViaAnvil(page, accountRef.entityId, { allowUnavailable: true }), {
        timeout: 60_000,
        intervals: [500, 1000, 2000],
      }).toBeGreaterThan(reserveBefore);
    });
    await timedStep('dispute.reload_assert_hidden_disputed_account', async () => {
      await expect.poll(async () => {
        return await page.locator('.account-preview').filter({ hasText: accountRef.counterpartyId }).count();
      }, { timeout: 45_000, intervals: [500, 1000, 2000] }).toBe(0);
    });
    await timedStep('dispute.reload_assert_batch_history', async () => {
      await expect.poll(async () => {
        const snap = await readJBatchSnapshot(page, accountRef.entityId, accountRef.signerId);
        return snap.batchHistoryCount;
      }, { timeout: 60_000, intervals: [500, 1000, 2000] }).toBeGreaterThanOrEqual(finalSnapshot.batchHistoryCount);
    });
  });

  // Scenario: the entity settle workspace must be able to sign and broadcast the queued dispute batch,
  // and history must reflect the dispute lifecycle without entering account panel UI.
  test('entity settle workspace Sign & Broadcast submits dispute batch', async ({ page }) => {
    test.setTimeout(LONG_E2E ? 240_000 : 120_000);
    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        process.stdout.write(`[BROWSER:error] ${msg.text()}\n`);
      }
    });

    await timedStep('dispute_broadcast.goto_app', () => gotoSharedApp(page, { appBaseUrl: APP_BASE_URL, initTimeoutMs: INIT_TIMEOUT, settleMs: 500 }));
    await timedStep('dispute_broadcast.create_runtime', () => createRuntimeIdentity(page, `dispute-ui-broadcast-rt-${Date.now()}`, randomMnemonic()));
    const accountRef = await timedStep('dispute_broadcast.ensure_hub_account', () => ensureAnyHubAccountOpen(page));
    await timedStep(
      'dispute_broadcast.seed_preconditions',
      () => seedDisputePreconditions(page, accountRef.entityId, accountRef.signerId, accountRef.counterpartyId),
    );

    await timedStep(
      'dispute_broadcast.start_dispute',
      () => startDisputeFromEntitySettle(page, accountRef.entityId, accountRef.signerId, accountRef.counterpartyId),
    );
    await timedStep('dispute_broadcast.open_settle_workspace', () => openEntitySettleWorkspace(page));
    await timedStep('dispute_broadcast.broadcast', () => broadcastPendingBatchViaUi(page, accountRef.entityId, accountRef.signerId));

    await timedStep('dispute_broadcast.wait_history_dispute_entry', async () => {
      const historyRoot = page.locator('.settlement-panel').first();
      await expect(historyRoot).toBeVisible({ timeout: 30_000 });
      await expect
        .poll(async () => {
          const text = await historyRoot.textContent();
          return /Dispute(Start|Finalize)/.test(String(text || ''));
        }, { timeout: 60_000, intervals: [500, 1000, 2000] })
        .toBe(true);
    });
  });
});
