import { test, expect, type Page } from '@playwright/test';
import { Wallet } from 'ethers';

const APP_BASE_URL = process.env.E2E_BASE_URL ?? 'https://localhost:8080';
const INIT_TIMEOUT = 30_000;

type AccountProgress = {
  entityId: string;
  signerId: string;
  counterpartyId: string;
  frameHeight: number;
  collateralWei: string;
  pendingRequestedWei: string;
  hasRequestCollateralTx: boolean;
  hasJEventClaimTx: boolean;
};

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

async function readPrimaryAccountProgress(page: Page): Promise<AccountProgress | null> {
  return page.evaluate(() => {
    const env = (window as any).isolatedEnv;
    if (!env?.eReplicas) return null;

    const runtimeSigner = String(env.runtimeId || '').toLowerCase();
    for (const [key, replica] of env.eReplicas.entries()) {
      const [entityId, signerId] = String(key).split(':');
      if (!entityId || !signerId) continue;
      if (runtimeSigner && String(signerId).toLowerCase() !== runtimeSigner) continue;

      const accounts = replica?.state?.accounts;
      if (!accounts || accounts.size === 0) continue;

      for (const [counterpartyId, account] of accounts.entries()) {
        const delta = account?.deltas?.get?.(1);
        if (!delta) continue;
        const isLeft = String(entityId).toLowerCase() < String(counterpartyId).toLowerCase();
        const XLN = (window as any).XLN;
        const derived = typeof XLN?.deriveDelta === 'function' ? XLN.deriveDelta(delta, isLeft) : null;
        const pendingRequested = account?.requestedRebalance?.get?.(1) || 0n;
        const history = Array.isArray(account?.frameHistory) ? account.frameHistory : [];
        let hasRequestCollateralTx = false;
        let hasJEventClaimTx = false;
        for (const frame of history) {
          const txs = Array.isArray(frame?.accountTxs) ? frame.accountTxs : [];
          for (const tx of txs) {
            if (tx?.type === 'request_collateral') hasRequestCollateralTx = true;
            if (tx?.type === 'j_event_claim') hasJEventClaimTx = true;
          }
        }

        return {
          entityId,
          signerId,
          counterpartyId: String(counterpartyId),
          frameHeight: Number(account?.currentHeight || 0),
          collateralWei: String(derived?.outCollateral ?? 0n),
          pendingRequestedWei: String(pendingRequested),
          hasRequestCollateralTx,
          hasJEventClaimTx,
        };
      }
    }
    return null;
  });
}

async function ensureAnyHubAccountOpen(page: Page): Promise<void> {
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
            return { ok: true };
          }
          if (!openedHubId) {
            openedHubId = String(cpId || '');
          }
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
          return { ok: true };
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    return { ok: false, error: 'openAccount timeout (45s)' };
  });

  expect(result.ok, `ensureAnyHubAccountOpen failed: ${result.error || 'unknown'}`).toBe(true);
}

test.describe('E2E User Journey', () => {
  test('demo runtime -> open hub account -> offchain faucet pipeline', async ({ page }) => {
    test.setTimeout(240_000);

    await gotoApp(page);
    await dismissOnboardingIfVisible(page);
    await createDemoRuntime(page, 'journey-rt1', randomMnemonic());
    await ensureAnyHubAccountOpen(page);

    const initial = await readPrimaryAccountProgress(page);
    expect(initial, 'expected at least one opened hub account').not.toBeNull();
    if (!initial) return;

    // User flow action: request one offchain faucet payment through the opened account.
    await page.evaluate(async ({ entityId, signerId, counterpartyId }) => {
      const env = (window as any).isolatedEnv;
      const XLN = (window as any).XLN;
      if (!env || !XLN) return;
      const runtimeId = String(env.runtimeId || '').toLowerCase();
      const requestApiBase = window.location.origin;
      const localAccount = env?.eReplicas
        ? (() => {
            for (const [key, rep] of env.eReplicas.entries()) {
              const [eid, sid] = String(key).split(':');
              if (String(eid || '').toLowerCase() !== String(entityId).toLowerCase()) continue;
              if (String(sid || '').toLowerCase() !== String(signerId).toLowerCase()) continue;
              return rep?.state?.accounts?.get?.(counterpartyId) ?? null;
            }
            return null;
          })()
        : null;
      const knownAccount = localAccount
        ? {
            currentHeight: Number(localAccount.currentHeight || 0),
            hasPending: !!localAccount.pendingFrame,
            pendingHeight: localAccount.pendingFrame?.height ?? null,
            currentFrameHash: localAccount.currentFrame?.stateHash || null,
          }
        : null;
      const res = await fetch(`${requestApiBase}/api/faucet/offchain`, {
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
      const body = await res.json().catch(() => ({}));
      if (!res.ok || !body?.success) {
        throw new Error(body?.error || `offchain faucet failed (${res.status})`);
      }
    }, {
      entityId: initial.entityId,
      signerId: initial.signerId,
      counterpartyId: initial.counterpartyId,
    });

    await expect.poll(async () => {
      const state = await readPrimaryAccountProgress(page);
      if (!state) return false;
      return state.frameHeight > initial.frameHeight;
    }, { timeout: 60_000, intervals: [500, 1000, 2000] }).toBe(true);

    const finalState = (await readPrimaryAccountProgress(page))!;
    expect(finalState.frameHeight, 'account frame must advance after offchain faucet').toBeGreaterThan(initial.frameHeight);
  });
});
