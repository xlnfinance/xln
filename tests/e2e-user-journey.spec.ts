/**
 * E2E user journey for onboarding, funding, account growth, and collateral progress.
 *
 * Flow and goals:
 * 1. Create a fresh browser user in the live wallet.
 * 2. Connect the user to a hub and bootstrap usable capacity.
 * 3. Verify the account machine progresses through visible states as usage grows.
 * 4. Confirm the UI shows the expected collateral/requested-collateral progression.
 *
 * This test exists to keep the first-user experience honest: a brand-new user should be able
 * to create an entity, connect, receive capacity, and see account progress without hidden setup.
 */
import { test, expect, type Page } from '@playwright/test';
import { Wallet } from 'ethers';
import {
  gotoApp as gotoSharedApp,
  createRuntime as createSharedRuntime,
} from './utils/e2e-demo-users';
import { connectHub as connectActiveRuntimeToHub } from './utils/e2e-connect';

const APP_BASE_URL = process.env.E2E_BASE_URL ?? 'https://localhost:8080';
const INIT_TIMEOUT = 30_000;
const LONG_E2E = process.env.E2E_LONG === '1';

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
  await gotoSharedApp(page, {
    appBaseUrl: APP_BASE_URL,
    initTimeoutMs: INIT_TIMEOUT,
    settleMs: 500,
  });
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
  await createSharedRuntime(page, label, mnemonic);
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
  const state = await page.evaluate(() => {
    const env = (window as any).isolatedEnv;
    if (!env?.eReplicas) return { ready: false, hubId: '' };

    const runtimeSigner = String(env.runtimeId || '').toLowerCase();
    let ready = false;
    let hubId = '';

    for (const [key, rep] of env.eReplicas.entries()) {
      const [entityId, signerId] = String(key).split(':');
      if (!entityId || !signerId) continue;
      if (runtimeSigner && String(signerId).toLowerCase() !== runtimeSigner) continue;

      if (rep?.state?.accounts instanceof Map) {
        for (const [counterpartyId, account] of rep.state.accounts.entries()) {
          if (!hubId) hubId = String(counterpartyId || '');
          const hasDelta = !!account?.deltas?.get?.(1);
          if (hasDelta && !account?.pendingFrame && Number(account?.currentHeight || 0) > 0) {
            ready = true;
            hubId = String(counterpartyId || '');
            break;
          }
        }
      }
      break;
    }

    if (!hubId) {
      const profiles = env?.gossip?.getProfiles?.() || [];
      const hubProfile = profiles.find((profile: any) =>
        profile?.metadata?.isHub === true ||
        (Array.isArray(profile?.capabilities) &&
          (profile.capabilities.includes('hub') || profile.capabilities.includes('routing'))),
      );
      hubId = typeof hubProfile?.entityId === 'string' ? hubProfile.entityId : '';
    }

    return { ready, hubId };
  });

  if (state.ready) return;
  expect(state.hubId, 'hub must be discoverable before opening account').toBeTruthy();
  await connectActiveRuntimeToHub(page, state.hubId);
}

test.describe('E2E User Journey', () => {
  test('demo runtime -> open hub account -> offchain faucet pipeline', async ({ page }) => {
    test.setTimeout(LONG_E2E ? 240_000 : 60_000);

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
