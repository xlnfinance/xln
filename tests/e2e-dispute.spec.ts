import { test, expect, type Page } from '@playwright/test';
import { Wallet } from 'ethers';

const APP_BASE_URL = process.env.E2E_BASE_URL ?? 'https://localhost:8080';
const INIT_TIMEOUT = 30_000;
const LONG_E2E = process.env.E2E_LONG === '1';

function randomMnemonic(): string {
  return Wallet.createRandom().mnemonic!.phrase;
}

async function gotoApp(page: Page): Promise<void> {
  await page.goto(`${APP_BASE_URL}/app`);
  const unlock = page.locator('button:has-text("Unlock")');
  if (await unlock.isVisible({ timeout: 1500 }).catch(() => false)) {
    await page.locator('input').first().fill('mml');
    await unlock.click();
    await page.waitForURL('**/app', { timeout: 10_000 });
  }
  await page.waitForFunction(() => !!(window as any).XLN, { timeout: INIT_TIMEOUT });
  await page.waitForTimeout(500);
}

async function dismissOnboardingIfVisible(page: Page): Promise<void> {
  const checkbox = page.locator('text=I understand and accept the risks of using this software').first();
  if (await checkbox.isVisible({ timeout: 1000 }).catch(() => false)) {
    await checkbox.click();
    const continueBtn = page.locator('button:has-text("Continue")').first();
    if (await continueBtn.isVisible({ timeout: 1000 }).catch(() => false)) {
      await continueBtn.click();
      await page.waitForTimeout(300);
    }
  }
}

async function createDemoRuntime(page: Page, label: string, mnemonic: string): Promise<void> {
  const result = await page.evaluate(async ({ label, mnemonic }) => {
    try {
      const vaultOperations = (window as any).vaultOperations;
      if (!vaultOperations) return { ok: false, error: 'window.vaultOperations missing' };
      await vaultOperations.createRuntime(label, mnemonic, {
        loginType: 'demo',
        requiresOnboarding: false,
      });
      return { ok: true };
    } catch (error: any) {
      return { ok: false, error: error?.message || String(error) };
    }
  }, { label, mnemonic });

  expect(result.ok, `createRuntime failed: ${result.error || 'unknown'}`).toBe(true);
  await page.waitForFunction(() => {
    const env = (window as any).isolatedEnv;
    return !!env?.runtimeId && Number(env?.eReplicas?.size || 0) > 0;
  }, { timeout: 20_000 });
}

async function ensureAnyHubAccountOpen(page: Page): Promise<{ entityId: string; signerId: string; counterpartyId: string }> {
  const result = await page.evaluate(async () => {
    const findAccount = (accounts: any, ownerId: string, counterpartyId: string) => {
      if (!(accounts instanceof Map)) return null;
      const owner = String(ownerId || '').toLowerCase();
      const cp = String(counterpartyId || '').toLowerCase();
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
    const XLN = (window as any).XLN;
    if (!env?.eReplicas || !XLN?.enqueueRuntimeInput) return { ok: false, error: 'isolatedEnv/XLN missing' };

    const runtimeSigner = String(env.runtimeId || '').toLowerCase();
    let entityId = '';
    let signerId = '';
    let openedHubId = '';
    for (const [key, rep] of env.eReplicas.entries()) {
      const [eid, sid] = String(key).split(':');
      if (!eid || !sid) continue;
      if (runtimeSigner && String(sid).toLowerCase() !== runtimeSigner) continue;
      entityId = eid;
      signerId = sid;
      if (rep?.state?.accounts instanceof Map && rep.state.accounts.size > 0) {
        for (const [cpId, account] of rep.state.accounts.entries()) {
          const hasDelta = !!account?.deltas?.get?.(1);
          const ready = hasDelta && !account?.pendingFrame && Number(account?.currentHeight || 0) > 0;
          if (ready) {
            return { ok: true, entityId, signerId, counterpartyId: String(cpId) };
          }
          if (!openedHubId) openedHubId = String(cpId || '');
        }
      }
      break;
    }
    if (!entityId || !signerId) return { ok: false, error: 'local entity not found' };

    const profiles = env?.gossip?.getProfiles?.() || [];
    const hub = profiles.find((p: any) =>
      p?.metadata?.isHub === true ||
      (Array.isArray(p?.capabilities) && (p.capabilities.includes('hub') || p.capabilities.includes('routing')))
    );
    const hubId = String(openedHubId || hub?.entityId || '');
    if (!hubId) return { ok: false, error: 'hub not discovered in gossip' };

    const existingAccount = (() => {
      const repKey = Array.from(env.eReplicas.keys()).find((key: string) => {
        const [eid, sid] = String(key).split(':');
        return String(eid || '').toLowerCase() === String(entityId).toLowerCase()
          && String(sid || '').toLowerCase() === String(signerId).toLowerCase();
      });
      if (!repKey) return null;
      const rep = env.eReplicas.get(repKey);
      return findAccount(rep?.state?.accounts, entityId, hubId);
    })();

    if (!existingAccount) {
      XLN.enqueueRuntimeInput(env, {
        runtimeTxs: [],
        entityInputs: [{
          entityId,
          signerId,
          entityTxs: [{
            type: 'openAccount',
            data: { targetEntityId: hubId, creditAmount: 10_000n * 10n ** 18n, tokenId: 1 },
          }],
        }],
      });
    }

    const startedAt = Date.now();
    while (Date.now() - startedAt < 45_000) {
      for (const [key, rep] of env.eReplicas.entries()) {
        const [eid] = String(key).split(':');
        if (String(eid || '').toLowerCase() !== String(entityId).toLowerCase()) continue;
        const account = findAccount(rep?.state?.accounts, entityId, hubId);
        if (!account) continue;
        if (account?.deltas?.get?.(1) && !account?.pendingFrame && Number(account?.currentHeight || 0) > 0) {
          return { ok: true, entityId, signerId, counterpartyId: hubId };
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    return { ok: false, error: 'openAccount timeout (45s)' };
  });

  expect(result.ok, `ensureAnyHubAccountOpen failed: ${result.error || 'unknown'}`).toBe(true);
  if (!result.ok) throw new Error(result.error || 'failed');
  return { entityId: result.entityId, signerId: result.signerId, counterpartyId: result.counterpartyId };
}

async function readReserve(page: Page, entityId: string): Promise<bigint> {
  const value = await page.evaluate(async ({ entityId }) => {
    const env = (window as any).isolatedEnv;
    const XLN = (window as any).XLN;
    const jadapter = XLN?.getActiveJAdapter?.(env) ?? null;
    if (!jadapter?.getReserves) return null;
    const reserve = await jadapter.getReserves(entityId, 1);
    return typeof reserve === 'bigint' ? reserve.toString() : String(reserve ?? '0');
  }, { entityId });
  if (!value) throw new Error('Unable to read reserve');
  return BigInt(value);
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
    const XLN = (window as any).XLN;
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
    const jadapter = XLN?.getActiveJAdapter?.(env) ?? null;
    const block = jadapter?.provider?.getBlockNumber ? Number(await jadapter.provider.getBlockNumber()) : 0;
    return {
      exists: !!account,
      status: String(account?.status || ''),
      activeDispute: !!account?.activeDispute,
      disputeTimeout: Number(account?.activeDispute?.disputeTimeout || 0),
      block,
      jBatchDisputeStarts: Number(batch?.disputeStarts?.length || 0),
      jBatchDisputeFinalizations: Number(batch?.disputeFinalizations?.length || 0),
    };
  }, { entityId, signerId, counterpartyId });
}

async function readAccountMeta(
  page: Page,
  entityId: string,
  signerId: string,
  counterpartyId: string
): Promise<{ frameHeight: number; hasCounterpartyDisputeProof: boolean }> {
  return await page.evaluate(({ entityId, signerId, counterpartyId }) => {
    const env = (window as any).isolatedEnv;
    if (!env?.eReplicas) return { frameHeight: 0, hasCounterpartyDisputeProof: false };
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
    };
  }, { entityId, signerId, counterpartyId });
}

async function readAccountTokenState(
  page: Page,
  entityId: string,
  signerId: string,
  counterpartyId: string,
  tokenId: number,
): Promise<{ exists: boolean; currentHeight: number; pendingFrame: boolean; collateral: bigint }> {
  const result = await page.evaluate(({ entityId, signerId, counterpartyId, tokenId }) => {
    const findAccount = (accounts: any, ownerId: string, cpId: string) => {
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
      return { exists: false, currentHeight: 0, pendingFrame: false, collateral: '0' };
    }

    const key = Array.from(env.eReplicas.keys()).find((k: string) => {
      const [eid, sid] = String(k).split(':');
      return String(eid || '').toLowerCase() === String(entityId).toLowerCase()
        && String(sid || '').toLowerCase() === String(signerId).toLowerCase();
    });
    const rep = key ? env.eReplicas.get(key) : null;
    const account = findAccount(rep?.state?.accounts, entityId, counterpartyId);
    const delta = account?.deltas?.get?.(tokenId);

    return {
      exists: !!account,
      currentHeight: Number(account?.currentHeight || 0),
      pendingFrame: !!account?.pendingFrame,
      collateral: String(delta?.collateral ?? 0n),
    };
  }, { entityId, signerId, counterpartyId, tokenId });

  return {
    exists: !!result.exists,
    currentHeight: Number(result.currentHeight || 0),
    pendingFrame: !!result.pendingFrame,
    collateral: BigInt(result.collateral || '0'),
  };
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

async function readReserveBalanceUi(page: Page, symbol: string = 'USDC'): Promise<number> {
  const reservesTab = page.getByTestId('tab-reserves').first();
  await expect(reservesTab).toBeVisible({ timeout: 20_000 });
  await reservesTab.click();

  const refreshButton = page.locator('.btn-refresh-small').first();
  if (await refreshButton.isVisible({ timeout: 1_500 }).catch(() => false)) {
    await refreshButton.click();
  }

  const balance = page.getByTestId(`reserve-balance-${symbol}`).first();
  await expect(balance).toBeVisible({ timeout: 20_000 });
  const text = (await balance.textContent())?.trim() ?? '0';
  return parseUiAmount(text);
}

async function readReservesCardValueUi(page: Page): Promise<number> {
  const valueNode = page.getByTestId('reserves-card-value').first();
  await expect(valueNode).toBeVisible({ timeout: 20_000 });
  const text = (await valueNode.textContent())?.trim() ?? '0';
  return parseUiAmount(text);
}

async function readAccountsCardOwedUi(page: Page): Promise<number> {
  const owedNode = page.getByTestId('accounts-card-owed').first();
  const visible = await owedNode.isVisible({ timeout: 1_000 }).catch(() => false);
  if (!visible) return 0;
  const text = (await owedNode.textContent())?.trim() ?? '0';
  return parseUiAmount(text);
}

async function openAccountPanelByCounterparty(page: Page, counterpartyId: string): Promise<void> {
  const accountsTab = page.getByTestId('tab-accounts').first();
  await expect(accountsTab).toBeVisible({ timeout: 20_000 });
  await accountsTab.click();

  const accountPreview = page.locator('.account-preview').filter({ hasText: counterpartyId }).first();
  await expect(accountPreview).toBeVisible({ timeout: 20_000 });
  await accountPreview.click();

  const back = page.locator('.account-panel .back-button').first();
  await expect(back).toBeVisible({ timeout: 20_000 });
}

async function readRawCollateralUiFromOpenAccount(page: Page): Promise<number> {
  const detailsToggle = page.locator('.account-panel .delta-card .delta-expand').first();
  await expect(detailsToggle).toBeVisible({ timeout: 20_000 });
  const toggleLabel = ((await detailsToggle.textContent()) || '').toLowerCase();
  if (toggleLabel.includes('details')) {
    await detailsToggle.click();
  }

  const rawCollateralRow = page.locator('.account-panel .detail-grid-three').filter({ hasText: 'Raw collateral' }).first();
  await expect(rawCollateralRow).toBeVisible({ timeout: 20_000 });
  const yourCollateral = rawCollateralRow.locator('.detail-value-cell.coll').first();
  await expect(yourCollateral).toBeVisible({ timeout: 20_000 });
  const text = (await yourCollateral.textContent())?.trim() ?? '0';
  return parseUiAmount(text);
}

async function pickSecondaryHubEntityId(page: Page, excludeCounterpartyId: string): Promise<string> {
  const secondary = await page.evaluate(({ excludeCounterpartyId }) => {
    const env = (window as any).isolatedEnv;
    const profiles = env?.gossip?.getProfiles?.() || [];
    const exclude = String(excludeCounterpartyId || '').toLowerCase();
    const hubs = profiles
      .filter((p: any) => {
        const id = String(p?.entityId || '').toLowerCase();
        if (!id || id === exclude) return false;
        return p?.metadata?.isHub === true ||
          (Array.isArray(p?.capabilities) && (p.capabilities.includes('hub') || p.capabilities.includes('routing')));
      })
      .map((p: any) => String(p.entityId))
      .sort();
    return hubs[0] || '';
  }, { excludeCounterpartyId });

  if (!secondary) throw new Error('No secondary hub discovered in gossip');
  return secondary;
}

async function ensurePrivateAccountOpenViaUi(
  page: Page,
  entityId: string,
  signerId: string,
  counterpartyId: string,
): Promise<void> {
  const already = await readAccountTokenState(page, entityId, signerId, counterpartyId, 1);
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
    const state = await readAccountTokenState(page, entityId, signerId, counterpartyId, 1);
    return state.exists && !state.pendingFrame && state.currentHeight > 0;
  }, { timeout: 60_000, intervals: [500, 1000, 2000] }).toBe(true);
}

async function queueFundR2CViaUi(
  page: Page,
  counterpartyId: string,
  amount: string,
): Promise<void> {
  await openEntitySettleWorkspace(page);

  const fundTab = page.locator('.settlement-panel .action-tabs .tab').filter({ hasText: /^Fund$/ }).first();
  await expect(fundTab).toBeVisible({ timeout: 20_000 });
  await fundTab.click();

  const accountInput = page.locator('.settlement-panel .entity-input input').first();
  await expect(accountInput).toBeVisible({ timeout: 20_000 });
  await accountInput.fill(counterpartyId);
  await accountInput.press('Tab');

  const amountInput = page.locator('.settlement-panel .amount-field input').first();
  await expect(amountInput).toBeVisible({ timeout: 20_000 });
  await amountInput.fill(amount);

  const fundButton = page.getByTestId('settle-queue-action').first();
  await expect(fundButton).toBeEnabled({ timeout: 20_000 });
  await fundButton.click();
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
        const rep = repKey ? env.eReplicas.get(repKey) : null;
        const account = rep?.state?.accounts?.get?.(counterpartyId) ?? null;
        const knownAccount = account
          ? {
              currentHeight: Number(account.currentHeight || 0),
              hasPending: !!account.pendingFrame,
              pendingHeight: account.pendingFrame?.height ?? null,
              currentFrameHash: account.currentFrame?.stateHash || null,
            }
          : null;

        const response = await fetch(`${window.location.origin}/api/faucet/offchain`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            userEntityId: entityId,
            userRuntimeId: runtimeId,
            tokenId: 1,
            amount: '100',
            hubEntityId: counterpartyId,
            ...(knownAccount ? { knownAccount } : {}),
          }),
        });
        const body = await response.json().catch(() => ({}));
        if (!response.ok || !body?.success) {
          throw new Error(body?.error || `offchain faucet failed (${response.status})`);
        }
      }, { entityId, signerId, counterpartyId });

      await expect.poll(async () => {
        const current = await readAccountMeta(page, entityId, signerId, counterpartyId);
        return current.frameHeight > before.frameHeight;
      }, { timeout: 45_000, intervals: [500, 1000, 2000] }).toBe(true);

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

async function broadcastPendingBatchViaUi(page: Page): Promise<void> {
  const signButton = page.getByTestId('settle-sign-broadcast').first();
  await expect(signButton).toBeVisible({ timeout: 30_000 });
  await signButton.click();
  await page.waitForTimeout(500);
}

async function openEntitySettleWorkspace(page: Page): Promise<void> {
  const accountPanelBack = page.locator('.account-panel .back-button').first();
  if (await accountPanelBack.isVisible({ timeout: 1_000 }).catch(() => false)) {
    await accountPanelBack.click();
  }

  const accountsTab = page.getByTestId('tab-accounts').first();
  await expect(accountsTab).toBeVisible({ timeout: 15_000 });
  await accountsTab.click();

  const settleWorkspaceButton = page.locator('.account-workspace-tab').filter({ hasText: /Settle/i }).first();
  await expect(settleWorkspaceButton).toBeVisible({ timeout: 15_000 });
  await settleWorkspaceButton.click();
}

async function startDisputeFromEntitySettle(
  page: Page,
  entityId: string,
  signerId: string,
  counterpartyId: string,
): Promise<void> {
  await openEntitySettleWorkspace(page);

  const disputeTab = page.locator('.settlement-panel .action-tabs .tab').filter({ hasText: /^Dispute$/ }).first();
  await expect(disputeTab).toBeVisible({ timeout: 15_000 });
  await disputeTab.click();

  const disputeInput = page.locator('.dispute-inline .entity-input input').first();
  await expect(disputeInput).toBeVisible({ timeout: 15_000 });
  await disputeInput.fill(counterpartyId);
  await disputeInput.press('Tab');

  const disputeButton = page.getByTestId('settle-dispute-start').first();
  await expect(disputeButton).toBeVisible({ timeout: 15_000 });
  await expect(disputeButton).toBeEnabled({ timeout: 15_000 });

  await page.evaluate(() => {
    window.confirm = () => true;
    window.alert = () => {};
  });
  await disputeButton.click();

  await expect.poll(async () => {
    const state = await readAccountState(page, entityId, signerId, counterpartyId);
    return state.status === 'disputed' || state.jBatchDisputeStarts > 0;
  }, { timeout: 60_000, intervals: [500, 1000, 2000] }).toBe(true);
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
  sentExists: boolean;
  sentDisputeStarts: number;
  sentReserveToCollateral: number;
  batchHistoryCount: number;
  lastBatchTxHash: string;
  lastBatchStatus: string;
  lastBatchOpCount: number;
}> {
  return await page.evaluate(({ entityId, signerId }) => {
    const env = (window as any).isolatedEnv;
    if (!env?.eReplicas) {
      return {
        pendingDisputeStarts: 0,
        pendingReserveToCollateral: 0,
        sentExists: false,
        sentDisputeStarts: 0,
        sentReserveToCollateral: 0,
        batchHistoryCount: 0,
        lastBatchTxHash: '',
        lastBatchStatus: '',
        lastBatchOpCount: 0,
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

    return {
      pendingDisputeStarts: Number(pending?.disputeStarts?.length || 0),
      pendingReserveToCollateral: Number(pending?.reserveToCollateral?.length || 0),
      sentExists: !!rep?.state?.jBatchState?.sentBatch,
      sentDisputeStarts: Number(sent?.disputeStarts?.length || 0),
      sentReserveToCollateral: Number(sent?.reserveToCollateral?.length || 0),
      batchHistoryCount: Number(history.length || 0),
      lastBatchTxHash: String(last?.txHash || ''),
      lastBatchStatus: String(last?.status || ''),
      lastBatchOpCount: Number(last?.opCount || 0),
    };
  }, { entityId, signerId });
}

test.describe('E2E Dispute Flow', () => {
  test('account panel dispute lifecycle returns reserve', async ({ page }) => {
    test.setTimeout(LONG_E2E ? 360_000 : 210_000);
    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        process.stdout.write(`[BROWSER:error] ${msg.text()}\n`);
      }
    });

    await gotoApp(page);
    await dismissOnboardingIfVisible(page);
    await createDemoRuntime(page, `dispute-rt-${Date.now()}`, randomMnemonic());
    const accountRef = await ensureAnyHubAccountOpen(page);
    await seedDisputePreconditions(page, accountRef.entityId, accountRef.signerId, accountRef.counterpartyId);

    const reserveBefore = await readReserve(page, accountRef.entityId);
    const reserveBeforeUi = await readReserveBalanceUi(page, 'USDC');
    const reserveCardBeforeUi = await readReservesCardValueUi(page);
    const batchBeforeDispute = await readJBatchSnapshot(page, accountRef.entityId, accountRef.signerId);

    try {
      await startDisputeFromEntitySettle(page, accountRef.entityId, accountRef.signerId, accountRef.counterpartyId);
    } catch {
      const debug = await readDisputeDebug(page, accountRef.entityId, accountRef.signerId, accountRef.counterpartyId);
      throw new Error(`disputeStart not observed via UI click. debug=${JSON.stringify(debug)}`);
    }
    await expect.poll(async () => {
      const snap = await readJBatchSnapshot(page, accountRef.entityId, accountRef.signerId);
      return snap.pendingDisputeStarts;
    }, { timeout: 60_000, intervals: [500, 1000, 2000] }).toBeGreaterThan(batchBeforeDispute.pendingDisputeStarts);
    const disputeQueued = await readJBatchSnapshot(page, accountRef.entityId, accountRef.signerId);
    const disputeHistoryBeforeBroadcast = disputeQueued.batchHistoryCount;

    await openEntitySettleWorkspace(page);
    await broadcastPendingBatchViaUi(page);
    await expect.poll(async () => {
      const snap = await readJBatchSnapshot(page, accountRef.entityId, accountRef.signerId);
      return snap.sentDisputeStarts > 0 || snap.batchHistoryCount > disputeHistoryBeforeBroadcast;
    }, { timeout: 60_000, intervals: [500, 1000, 2000] }).toBe(true);

    await expect.poll(async () => {
      const state = await readAccountState(page, accountRef.entityId, accountRef.signerId, accountRef.counterpartyId);
      return state.activeDispute;
    }, { timeout: 60_000, intervals: [500, 1000, 2000] }).toBe(true);

    const disputedAccountPreview = page.locator('.account-preview').filter({ hasText: accountRef.counterpartyId }).first();
    await expect(disputedAccountPreview).toBeVisible({ timeout: 20_000 });
    await disputedAccountPreview.click();

    const disputeStatusText = page.locator('.management-card .dispute-status').first();
    await expect(disputeStatusText).toContainText(/Dispute active:\s*\d+\s*block/i, { timeout: 15_000 });

    const accountPanelBack = page.locator('.account-panel .back-button').first();
    if (await accountPanelBack.isVisible({ timeout: 1_000 }).catch(() => false)) {
      await accountPanelBack.click();
    }

    const disputedState = await readAccountState(page, accountRef.entityId, accountRef.signerId, accountRef.counterpartyId);
    expect(disputedState.disputeTimeout, 'disputeTimeout should be set after disputeStart').toBeGreaterThan(disputedState.block);
    const disputeWindowBlocks = disputedState.disputeTimeout - disputedState.block;
    expect(
      disputeWindowBlocks <= 6 && disputeWindowBlocks >= 1,
      `expected local dispute delay around 5 blocks, got ${disputeWindowBlocks}`
    ).toBe(true);

    await expect.poll(async () => {
      const state = await readAccountState(page, accountRef.entityId, accountRef.signerId, accountRef.counterpartyId);
      return !state.activeDispute && state.status === 'disputed';
    }, { timeout: 120_000, intervals: [500, 1000, 2000] }).toBe(true);

    const reserveAfter = await readReserve(page, accountRef.entityId);
    expect(
      reserveAfter > reserveBefore,
      `reserve must increase after dispute finalize (before=${reserveBefore}, after=${reserveAfter})`
    ).toBe(true);
    await expect.poll(async () => {
      return await readReserveBalanceUi(page, 'USDC');
    }, { timeout: 60_000, intervals: [500, 1000, 2000] }).toBeGreaterThan(reserveBeforeUi);
    await expect.poll(async () => {
      return await readReservesCardValueUi(page);
    }, { timeout: 60_000, intervals: [500, 1000, 2000] }).toBeGreaterThan(reserveCardBeforeUi);
    await expect.poll(async () => {
      return await readAccountsCardOwedUi(page);
    }, { timeout: 60_000, intervals: [500, 1000, 2000] }).toBeLessThanOrEqual(0);
    await page.waitForTimeout(1200);

    // Full-cycle continuation:
    // 1) Open account with second hub (UI)
    // 2) Queue R2C fund into that account (UI)
    // 3) Sign & Broadcast (UI)
    // 4) Verify collateral increased on second hub account (state)
    const secondHubId = await pickSecondaryHubEntityId(page, accountRef.counterpartyId);
    await ensurePrivateAccountOpenViaUi(page, accountRef.entityId, accountRef.signerId, secondHubId);
    await openAccountPanelByCounterparty(page, secondHubId);
    const collateralBeforeUi = await readRawCollateralUiFromOpenAccount(page);
    const secondHubPanelBackBefore = page.locator('.account-panel .back-button').first();
    if (await secondHubPanelBackBefore.isVisible({ timeout: 1_000 }).catch(() => false)) {
      await secondHubPanelBackBefore.click();
    }

    const beforeR2C = await readAccountTokenState(page, accountRef.entityId, accountRef.signerId, secondHubId, 1);
    const collateralBefore = beforeR2C.collateral;
    const batchBeforeR2C = await readJBatchSnapshot(page, accountRef.entityId, accountRef.signerId);
    const lastTxHashBeforeR2C = batchBeforeR2C.lastBatchTxHash;

    await queueFundR2CViaUi(page, secondHubId, '100');
    await expect.poll(async () => {
      const snap = await readJBatchSnapshot(page, accountRef.entityId, accountRef.signerId);
      return snap.pendingReserveToCollateral;
    }, { timeout: 60_000, intervals: [500, 1000, 2000] }).toBeGreaterThan(batchBeforeR2C.pendingReserveToCollateral);
    const r2cQueued = await readJBatchSnapshot(page, accountRef.entityId, accountRef.signerId);
    const r2cHistoryBeforeBroadcast = r2cQueued.batchHistoryCount;
    await broadcastPendingBatchViaUi(page);
    await expect.poll(async () => {
      const snap = await readJBatchSnapshot(page, accountRef.entityId, accountRef.signerId);
      return snap.sentReserveToCollateral > 0 || snap.batchHistoryCount > r2cHistoryBeforeBroadcast;
    }, { timeout: 60_000, intervals: [500, 1000, 2000] }).toBe(true);
    await expect.poll(async () => {
      const snap = await readJBatchSnapshot(page, accountRef.entityId, accountRef.signerId);
      return snap.lastBatchTxHash;
    }, { timeout: 60_000, intervals: [500, 1000, 2000] }).not.toEqual(lastTxHashBeforeR2C);

    await expect.poll(async () => {
      const current = await readAccountTokenState(page, accountRef.entityId, accountRef.signerId, secondHubId, 1);
      return current.collateral > collateralBefore;
    }, { timeout: 120_000, intervals: [500, 1000, 2000] }).toBe(true);

    await openAccountPanelByCounterparty(page, secondHubId);
    await expect.poll(async () => {
      return await readRawCollateralUiFromOpenAccount(page);
    }, { timeout: 60_000, intervals: [500, 1000, 2000] }).toBeGreaterThan(collateralBeforeUi);
    await page.waitForTimeout(1500);
  });

  test('entity settle workspace Sign & Broadcast submits dispute batch', async ({ page }) => {
    test.setTimeout(LONG_E2E ? 240_000 : 120_000);
    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        process.stdout.write(`[BROWSER:error] ${msg.text()}\n`);
      }
    });

    await gotoApp(page);
    await dismissOnboardingIfVisible(page);
    await createDemoRuntime(page, `dispute-ui-broadcast-rt-${Date.now()}`, randomMnemonic());
    const accountRef = await ensureAnyHubAccountOpen(page);
    await seedDisputePreconditions(page, accountRef.entityId, accountRef.signerId, accountRef.counterpartyId);

    await startDisputeFromEntitySettle(page, accountRef.entityId, accountRef.signerId, accountRef.counterpartyId);
    await openEntitySettleWorkspace(page);
    await broadcastPendingBatchViaUi(page);

    await expect.poll(async () => {
      const state = await readAccountState(page, accountRef.entityId, accountRef.signerId, accountRef.counterpartyId);
      return state.activeDispute && state.status === 'disputed';
    }, { timeout: 60_000, intervals: [500, 1000, 2000] }).toBe(true);
  });
});
