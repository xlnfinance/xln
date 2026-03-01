import { test, expect, type Page } from '@playwright/test';
import { Wallet } from 'ethers';
import { timedStep } from './utils/e2e-timing';

const APP_BASE_URL = process.env.E2E_BASE_URL ?? 'https://localhost:8080';
const INIT_TIMEOUT = 30_000;

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

async function readSwapState(
  page: Page,
  entityId: string,
  signerId: string,
  counterpartyId: string,
): Promise<{
  swapBookSize: number;
  accountSwapOffersSize: number;
  accountHasSwapOfferInMempool: boolean;
  accountHasSwapOfferInPendingFrame: boolean;
  accountHasSwapCancelRequestInMempool: boolean;
  accountHasSwapCancelRequestInPendingFrame: boolean;
}> {
  return await page.evaluate(({ entityId, signerId, counterpartyId }) => {
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
      return {
        swapBookSize: 0,
        accountSwapOffersSize: 0,
        accountHasSwapOfferInMempool: false,
        accountHasSwapOfferInPendingFrame: false,
        accountHasSwapCancelRequestInMempool: false,
        accountHasSwapCancelRequestInPendingFrame: false,
      };
    }
    const key = Array.from(env.eReplicas.keys()).find((k: string) => {
      const [eid, sid] = String(k).split(':');
      return String(eid || '').toLowerCase() === String(entityId).toLowerCase()
        && String(sid || '').toLowerCase() === String(signerId).toLowerCase();
    });
    const rep = key ? env.eReplicas.get(key) : null;
    const account = findAccount(rep?.state?.accounts, entityId, counterpartyId);
    return {
      swapBookSize: Number(rep?.state?.swapBook?.size || 0),
      accountSwapOffersSize: Number(account?.swapOffers?.size || 0),
      accountHasSwapOfferInMempool: !!(account?.mempool || []).find((tx: any) => tx?.type === 'swap_offer'),
      accountHasSwapOfferInPendingFrame: !!(account?.pendingFrame?.accountTxs || []).find((tx: any) => tx?.type === 'swap_offer'),
      accountHasSwapCancelRequestInMempool: !!(account?.mempool || []).find(
        (tx: any) => tx?.type === 'swap_cancel_request' || tx?.type === 'swap_cancel'
      ),
      accountHasSwapCancelRequestInPendingFrame: !!(account?.pendingFrame?.accountTxs || []).find(
        (tx: any) => tx?.type === 'swap_cancel_request' || tx?.type === 'swap_cancel'
      ),
    };
  }, { entityId, signerId, counterpartyId });
}

async function openSwapWorkspace(page: Page): Promise<void> {
  const accountsTab = page.getByTestId('tab-accounts').first();
  await expect(accountsTab).toBeVisible({ timeout: 20_000 });
  await accountsTab.click();
  const swapTab = page.locator('.account-workspace-tab').filter({ hasText: /Swap/i }).first();
  await expect(swapTab).toBeVisible({ timeout: 20_000 });
  await swapTab.click();
  await expect(page.locator('.swap-panel h3').first()).toContainText(/Swap Trading/i, { timeout: 15_000 });
}

async function selectCounterpartyInSwap(page: Page): Promise<void> {
  const trigger = page.locator('.swap-panel .entity-select .es-trigger').first();
  const hasSelector = await trigger.isVisible({ timeout: 1500 }).catch(() => false);
  if (!hasSelector) return;
  await trigger.click();
  const firstOption = page.locator('.swap-panel .entity-select .es-option').first();
  await expect(firstOption).toBeVisible({ timeout: 20_000 });
  await firstOption.click();
}

test.describe('E2E Swap Flow', () => {
  test('swap place and cancel from UI updates state machine', async ({ page }) => {
    test.setTimeout(150_000);

    await timedStep('swap.goto_app', () => gotoApp(page));
    await timedStep('swap.dismiss_onboarding', () => dismissOnboardingIfVisible(page));
    await timedStep('swap.create_runtime', () => createDemoRuntime(page, `swap-rt-${Date.now()}`, randomMnemonic()));
    const accountRef = await timedStep('swap.ensure_hub_account', () => ensureAnyHubAccountOpen(page));

    await timedStep('swap.open_workspace', () => openSwapWorkspace(page));
    await timedStep('swap.select_counterparty', () => selectCounterpartyInSwap(page));

    const giveInput = page.locator('.swap-panel input[placeholder="Amount to sell"]').first();
    const wantInput = page.locator('.swap-panel input[placeholder="Amount to receive"]').first();
    await expect(giveInput).toBeVisible({ timeout: 20_000 });
    await expect(wantInput).toBeVisible({ timeout: 20_000 });
    await giveInput.fill('1');
    await wantInput.fill('2');

    const placeButton = page.locator('.swap-panel .primary-btn').filter({ hasText: /Place Swap Offer/i }).first();
    await expect(placeButton).toBeEnabled({ timeout: 20_000 });
    await timedStep('swap.place_offer', async () => {
      await placeButton.click();
      await expect(page.locator('.swap-panel .offer-card').first()).toBeVisible({ timeout: 60_000 });
    });

    const cancelButton = page.locator('.swap-panel .cancel-btn').first();
    await expect(cancelButton).toBeVisible({ timeout: 20_000 });
    await timedStep('swap.cancel_offer', async () => {
      await cancelButton.click();
      await expect
        .poll(async () => {
          const state = await readSwapState(page, accountRef.entityId, accountRef.signerId, accountRef.counterpartyId);
          return (
            state.accountSwapOffersSize === 0 ||
            state.accountHasSwapCancelRequestInMempool ||
            state.accountHasSwapCancelRequestInPendingFrame
          );
        }, { timeout: 60_000 })
        .toBe(true);
    });
  });

  test('browser e2e scenario swap includes partial fills', async ({ page }) => {
    test.setTimeout(240_000);

    await timedStep('swap_scn.goto_app', () => gotoApp(page));
    await timedStep('swap_scn.dismiss_onboarding', () => dismissOnboardingIfVisible(page));
    await timedStep('swap_scn.create_runtime', () => createDemoRuntime(page, `swap-scn-${Date.now()}`, randomMnemonic()));

    const result = await timedStep('swap_scn.run_swap', async () => {
      return await page.evaluate(async () => {
        const XLN = (window as any).XLN;
        const env = (window as any).isolatedEnv;
        if (!XLN?.scenarios?.swap || !env) return { ok: false, error: 'XLN.scenarios.swap or isolatedEnv missing' };
        try {
          await XLN.scenarios.swap(env);
          let partialFillCount = 0;
          for (const rep of env.eReplicas.values()) {
            for (const account of rep?.state?.accounts?.values?.() || []) {
              for (const frame of account?.frameHistory || []) {
                for (const tx of frame?.accountTxs || []) {
                  if (tx?.type !== 'swap_resolve') continue;
                  const ratio = Number(tx?.data?.fillRatio ?? 0);
                  if (ratio > 0 && ratio < 65535) partialFillCount += 1;
                }
              }
            }
          }
          return { ok: true, partialFillCount };
        } catch (error: any) {
          return { ok: false, error: error?.message || String(error) };
        }
      });
    });

    expect(result.ok, `scenario swap failed: ${result.error || 'unknown'}`).toBe(true);
    expect(Number(result.partialFillCount || 0), 'expected at least one partial fill in scenario swap').toBeGreaterThan(0);
  });

  test('browser e2e scenario swapMarket includes partial fills', async ({ page }) => {
    test.setTimeout(480_000);

    await timedStep('swap_market.goto_app', () => gotoApp(page));
    await timedStep('swap_market.dismiss_onboarding', () => dismissOnboardingIfVisible(page));
    await timedStep('swap_market.create_runtime', () => createDemoRuntime(page, `swap-market-${Date.now()}`, randomMnemonic()));

    const result = await timedStep('swap_market.run_scenario', async () => {
      return await page.evaluate(async () => {
        const XLN = (window as any).XLN;
        const env = (window as any).isolatedEnv;
        if (!XLN?.scenarios?.swapMarket || !env) return { ok: false, error: 'XLN.scenarios.swapMarket or isolatedEnv missing' };
        try {
          await XLN.scenarios.swapMarket(env);
          let partialFillCount = 0;
          for (const rep of env.eReplicas.values()) {
            for (const account of rep?.state?.accounts?.values?.() || []) {
              for (const frame of account?.frameHistory || []) {
                for (const tx of frame?.accountTxs || []) {
                  if (tx?.type !== 'swap_resolve') continue;
                  const ratio = Number(tx?.data?.fillRatio ?? 0);
                  if (ratio > 0 && ratio < 65535) partialFillCount += 1;
                }
              }
            }
          }
          return { ok: true, partialFillCount };
        } catch (error: any) {
          return { ok: false, error: error?.message || String(error) };
        }
      });
    });

    expect(result.ok, `scenario swapMarket failed: ${result.error || 'unknown'}`).toBe(true);
    expect(Number(result.partialFillCount || 0), 'expected at least one partial fill in scenario swapMarket').toBeGreaterThan(0);
  });
});
