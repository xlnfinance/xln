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
import { test, expect, type Page } from './global-setup.mts';
import { Wallet } from 'ethers';
import { APP_BASE_URL } from './utils/e2e-baseline';
import {
  gotoApp as gotoSharedApp,
  createRuntime as createSharedRuntime,
} from './utils/e2e-demo-users';
import { connectHub as connectActiveRuntimeToHub } from './utils/e2e-connect';
import { getRenderedPrimaryOutbound, waitForRenderedPrimaryOutboundDelta } from './utils/e2e-account-ui';
import { getPersistedReceiptCursor } from './utils/e2e-runtime-receipts';
import { openAccountWorkspaceTab } from './utils/e2e-account-workspace';

const INIT_TIMEOUT = 30_000;
const LONG_E2E = process.env.E2E_LONG === '1';
const USER_JOURNEY_TIMEOUT = Math.max(
  Number(process.env.PW_TEST_TIMEOUT || 0) || 0,
  LONG_E2E ? 240_000 : 180_000,
);

type AccountProgress = {
  entityId: string;
  signerId: string;
  counterpartyId: string;
  frameHeight: number;
};

type EntityIdleSnapshot = {
  quiescent: boolean;
  runtimeHeight: number;
  entityHeight: number;
  projectedJHeight: number;
  watcherScannedJHeight: number;
  finalizedJHeight: number;
  pendingWorkCount: number;
  pendingSemanticJEventCount: number;
  recentInputs: Array<{
    runtimeHeight: number;
    txTypes: string[];
    jPrefixAttestations: number;
    proposalHeight: number;
    precommits: number;
  }>;
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

async function createDemoRuntime(
  page: Page,
  label: string,
  mnemonic: string,
  options: { requiresOnboarding?: boolean } = {},
): Promise<void> {
  await createSharedRuntime(page, label, mnemonic, options);
}

async function readHubAccountSummary(page: Page): Promise<{
  ready: boolean;
  committed: number;
  pending: number;
  entitiesWithCommitted: number;
  entityCount: number;
  accounts: Array<{ entityId: string; counterpartyId: string; height: number; pending: boolean }>;
}> {
  return page.evaluate(() => {
    const env = (window as typeof window & {
      isolatedEnv?: {
        eReplicas?: Map<string, {
          entityId?: string;
          state?: {
            entityId?: string;
            accounts?: Map<string, {
              currentHeight?: number;
              pendingFrame?: unknown;
            }>;
          };
        }>;
        runtimeMempool?: {
          runtimeTxs?: unknown[];
          entityInputs?: Array<{
            entityId?: string;
            entityTxs?: Array<{ type?: string }>;
            jPrefixAttestations?: Map<string, unknown>;
            proposedFrame?: { height?: number };
            hashPrecommits?: Map<string, unknown>;
          }>;
          jInputs?: unknown[];
          reliableReceipts?: unknown[];
        };
        pendingOutputs?: unknown[];
        networkInbox?: unknown[];
        pendingNetworkOutputs?: unknown[];
        runtimeState?: {
          processingPromise?: Promise<void> | null;
          inFlightEntityInputs?: number;
          pendingReliableIngress?: Map<string, unknown>;
          reliableIngressCommitting?: Set<string>;
          pendingCommittedJOutbox?: unknown[];
        };
        history?: Array<{
          height?: number;
          runtimeInput?: {
            entityInputs?: Array<{
              entityId?: string;
              entityTxs?: Array<{ type?: string }>;
              jPrefixAttestations?: Map<string, unknown>;
              proposedFrame?: { height?: number };
              hashPrecommits?: Map<string, unknown>;
            }>;
          };
        }>;
      };
    }).isolatedEnv;
    const accounts: Array<{ entityId: string; counterpartyId: string; height: number; pending: boolean }> = [];
    const entityIds = new Set<string>();
    const committedEntityIds = new Set<string>();
    for (const [key, rep] of env?.eReplicas?.entries?.() ?? []) {
      const entityId = String(rep?.entityId || rep?.state?.entityId || String(key).split(':')[0] || '').toLowerCase();
      if (entityId) entityIds.add(entityId);
      for (const [counterpartyId, account] of rep.state?.accounts?.entries?.() ?? []) {
        const height = Number(account?.currentHeight || 0);
        const pending = Boolean(account?.pendingFrame);
        if (entityId && height > 0) committedEntityIds.add(entityId);
        accounts.push({
          entityId,
          counterpartyId: String(counterpartyId || ''),
          height,
          pending,
        });
      }
    }
    const pending = accounts.filter((account) => account.pending).length;
    return {
      ready: entityIds.size >= 2 && committedEntityIds.size === entityIds.size,
      committed: accounts.filter((account) => account.height > 0).length,
      pending,
      entitiesWithCommitted: committedEntityIds.size,
      entityCount: entityIds.size,
      accounts,
    };
  });
}

async function readPrimaryAccountProgress(page: Page): Promise<AccountProgress | null> {
  return page.evaluate(() => {
    const env = (window as typeof window & {
      isolatedEnv?: {
        eReplicas?: Map<string, {
          state?: {
            accounts?: Map<string, {
              currentHeight?: number;
              deltas?: Map<number | string, unknown>;
            }>;
          };
        }>;
      };
    }).isolatedEnv;
    if (!env?.eReplicas) return null;

    for (const [key, replica] of env.eReplicas.entries()) {
      const [entityId, signerId] = String(key).split(':');
      if (!entityId || !signerId) continue;

      const accounts = replica?.state?.accounts;
      if (!accounts || accounts.size === 0) continue;

      for (const [counterpartyId, account] of accounts.entries()) {
        const delta = account?.deltas?.get?.(1) ?? account?.deltas?.get?.('1');
        if (!delta) continue;
        return {
          entityId,
          signerId,
          counterpartyId: String(counterpartyId),
          frameHeight: Number(account?.currentHeight || 0),
        };
      }
    }
    return null;
  });
}

async function readEntityIdleSnapshot(
  page: Page,
  entityId: string,
  signerId: string,
): Promise<EntityIdleSnapshot> {
  return await page.evaluate(({ targetEntityId, targetSignerId }) => {
    const env = (window as typeof window & {
      isolatedEnv?: {
        height?: number;
        jReplicas?: Map<string, {
          chainId?: number;
          depositoryAddress?: string;
          contracts?: { depository?: string };
          jadapter?: {
            chainId?: number;
            addresses?: { depository?: string };
            getWatcherScanProgress?: () => { scannedThroughHeight?: number };
          };
        }>;
        eReplicas?: Map<string, {
          signerId?: string;
          entityId?: string;
          mempool?: unknown[];
          proposal?: unknown;
          lockedFrame?: unknown;
          jHistory?: {
            scannedThroughHeight?: number;
            eventBlocks?: Map<number, unknown>;
          };
          state?: {
            entityId?: string;
            height?: number;
            lastFinalizedJHeight?: number;
            config?: {
              jurisdiction?: { chainId?: number; depositoryAddress?: string };
            };
            accounts?: Map<string, { mempool?: unknown[]; pendingFrame?: unknown }>;
          };
        }>;
      };
    }).isolatedEnv;
    if (!env?.eReplicas) throw new Error('E2E_IDLE_RUNTIME_MISSING');
    const entity = targetEntityId.toLowerCase();
    const signer = targetSignerId.toLowerCase();
    const replica = Array.from(env.eReplicas.values()).find((candidate) =>
      String(candidate.entityId || candidate.state?.entityId || '').toLowerCase() === entity &&
      String(candidate.signerId || '').toLowerCase() === signer,
    );
    if (!replica?.state) throw new Error(`E2E_IDLE_REPLICA_MISSING:${entity}:${signer}`);
    const jurisdiction = replica.state.config?.jurisdiction;
    const jurisdictionChainId = Number(jurisdiction?.chainId ?? 0);
    const jurisdictionDepository = String(jurisdiction?.depositoryAddress ?? '').toLowerCase();
    const watcherMatches = Array.from(env.jReplicas?.values() ?? []).filter((candidate) => {
      const chainId = Number(candidate.chainId ?? candidate.jadapter?.chainId ?? 0);
      const depository = String(
        candidate.depositoryAddress ??
        candidate.contracts?.depository ??
        candidate.jadapter?.addresses?.depository ??
        '',
      ).toLowerCase();
      return chainId === jurisdictionChainId && depository === jurisdictionDepository;
    });
    if (watcherMatches.length !== 1) {
      throw new Error(
        `E2E_IDLE_WATCHER_RESOLUTION_FAILED:${jurisdictionChainId}:${jurisdictionDepository}:` +
        `matches=${watcherMatches.length}`,
      );
    }
    const watcherScannedJHeight = Number(
      watcherMatches[0].jadapter?.getWatcherScanProgress?.().scannedThroughHeight ?? 0,
    );
    const accounts = Array.from(replica.state.accounts?.values() ?? []);
    const runtimeMempool = env.runtimeMempool;
    const finalizedJHeight = Number(replica.state.lastFinalizedJHeight ?? 0);
    const projectedJHeight = Number(replica.jHistory?.scannedThroughHeight ?? 0);
    const pendingSemanticJEventCount = Array.from(replica.jHistory?.eventBlocks?.keys?.() ?? [])
      .filter(height => Number(height) > finalizedJHeight && Number(height) <= projectedJHeight)
      .length;
    const pendingWorkCount =
      (runtimeMempool?.runtimeTxs?.length ?? 0) +
      (runtimeMempool?.entityInputs?.length ?? 0) +
      (runtimeMempool?.jInputs?.length ?? 0) +
      (runtimeMempool?.reliableReceipts?.length ?? 0) +
      (env.pendingOutputs?.length ?? 0) +
      (env.networkInbox?.length ?? 0) +
      (env.pendingNetworkOutputs?.length ?? 0) +
      (env.runtimeState?.inFlightEntityInputs ?? 0) +
      (env.runtimeState?.pendingReliableIngress?.size ?? 0) +
      (env.runtimeState?.reliableIngressCommitting?.size ?? 0) +
      (env.runtimeState?.pendingCommittedJOutbox?.length ?? 0) +
      (env.runtimeState?.processingPromise ? 1 : 0);
    const recentInputs = (env.history ?? []).slice(-24).flatMap(frame =>
      (frame.runtimeInput?.entityInputs ?? [])
        .filter(input => String(input.entityId ?? '').toLowerCase() === entity)
        .map(input => ({
          runtimeHeight: Number(frame.height ?? 0),
          txTypes: (input.entityTxs ?? []).map(tx => String(tx.type ?? 'unknown')),
          jPrefixAttestations: input.jPrefixAttestations?.size ?? 0,
          proposalHeight: Number(input.proposedFrame?.height ?? 0),
          precommits: input.hashPrecommits?.size ?? 0,
        })),
    );
    return {
      quiescent:
        pendingWorkCount === 0 &&
        pendingSemanticJEventCount === 0 &&
        (replica.mempool?.length ?? 0) === 0 &&
        !replica.proposal &&
        !replica.lockedFrame &&
        accounts.every((account) => (account.mempool?.length ?? 0) === 0 && !account.pendingFrame),
      runtimeHeight: Number(env.height ?? 0),
      entityHeight: Number(replica.state.height ?? 0),
      projectedJHeight,
      watcherScannedJHeight,
      finalizedJHeight,
      pendingWorkCount,
      pendingSemanticJEventCount,
      recentInputs,
    };
  }, { targetEntityId: entityId, targetSignerId: signerId });
}

async function mineEmptyJurisdictionBlock(page: Page): Promise<void> {
  const response = await page.request.post(`${APP_BASE_URL}/api/rpc`, {
    data: { jsonrpc: '2.0', id: 1, method: 'evm_mine', params: [] },
  });
  const body = await response.json().catch(async () => ({ error: (await response.text()).slice(0, 500) }));
  if (!response.ok() || body?.error) {
    throw new Error(`E2E_EMPTY_BLOCK_MINE_FAILED:${response.status()}:${JSON.stringify(body?.error ?? body)}`);
  }
}

async function expectSwapBuilderLabels(page: Page): Promise<void> {
  await openAccountWorkspaceTab(page, 'swap');
  await expect(page.getByTestId('swap-from-token-label')).toHaveText(/^(USDC|USDT|WETH) \(Testnet\)$/);
  await expect(page.getByTestId('swap-to-token-label')).toHaveText(/^(USDC|USDT|WETH) \(Testnet\)$/);

  const routeLabels = await page.getByTestId('swap-route-select').locator('option').evaluateAll((options) =>
    options.map((option) => String((option as HTMLOptionElement).label || option.textContent || '').trim()),
  );
  expect(routeLabels.filter((label) => label === 'Same account')).toHaveLength(1);
  expect(new Set(routeLabels).size, `route options should not duplicate recipient lanes: ${routeLabels.join(' | ')}`)
    .toBe(routeLabels.length);
  expect(routeLabels.join(' | '), 'recipient dropdown must not expose internal hub names').not.toMatch(/\bH\d\b/);
}

async function ensureAnyHubAccountOpen(page: Page): Promise<void> {
  const state = await page.evaluate(() => {
    const env = (window as typeof window & {
      isolatedEnv?: {
        eReplicas?: Map<string, {
          state?: {
            accounts?: Map<string, {
              deltas?: Map<number | string, unknown>;
              pendingFrame?: unknown;
              currentHeight?: number;
            }>;
          };
        }>;
        gossip?: {
          getProfiles?: () => Array<{
            entityId?: string;
            metadata?: { isHub?: boolean };
          }>;
        };
      };
    }).isolatedEnv;
    if (!env?.eReplicas) return { ready: false, hubId: '' };

    let ready = false;
    let hubId = '';

    for (const [key, rep] of env.eReplicas.entries()) {
      const [entityId] = String(key).split(':');
      if (!entityId) continue;
      if (rep?.state?.accounts instanceof Map) {
        for (const [counterpartyId, account] of rep.state.accounts.entries()) {
          if (!hubId) hubId = String(counterpartyId || '');
          const hasDelta = !!(account?.deltas?.get?.(1) || account?.deltas?.get?.('1'));
          if (hasDelta && !account?.pendingFrame && Number(account?.currentHeight || 0) > 0) {
            ready = true;
            hubId = String(counterpartyId || '');
            break;
          }
        }
      }
      if (ready) break;
    }

    return { ready, hubId };
  });

  if (state.ready) return;
  if (!state.hubId) {
    await page.getByTestId('tab-accounts').click({ timeout: 10_000 }).catch(() => null);
    await expect(page.locator('.hub-card[data-hub-entity-id]').first()).toBeVisible({ timeout: 30_000 });
  }
  const visibleHubId = state.hubId
    ? ''
    : await page.locator('.hub-card[data-hub-entity-id]').first().getAttribute('data-hub-entity-id').catch(() => null);
  const hubId = String(state.hubId || visibleHubId || '').trim();
  expect(hubId, 'same-jurisdiction hub must be visible before opening account').toMatch(/^0x[0-9a-f]{64}$/i);
  await connectActiveRuntimeToHub(page, hubId);
}

test.describe('E2E User Journey', () => {
  test('profile onboarding auto-joins three hubs without stale pending frames', { tag: '@functional' }, async ({ page }) => {
    test.setTimeout(USER_JOURNEY_TIMEOUT);

    await page.addInitScript(() => {
      localStorage.setItem('xln-hub-join-preference', '3');
    });
    await gotoApp(page);
    await dismissOnboardingIfVisible(page);
    await createDemoRuntime(page, 'journey-auto3', randomMnemonic(), { requiresOnboarding: true });

    await expect
      .poll(async () => await readHubAccountSummary(page), {
        timeout: USER_JOURNEY_TIMEOUT,
        intervals: [500, 1000, 1500],
        message: 'auto-join should commit at least one hub account per runtime entity lane and leave no pending frames',
      })
      .toMatchObject({ ready: true, pending: 0 });

    await expectSwapBuilderLabels(page);
  });

  test('demo runtime -> open hub account -> offchain faucet pipeline', { tag: '@functional' }, async ({ page }) => {
    test.setTimeout(USER_JOURNEY_TIMEOUT);

    await gotoApp(page);
    await dismissOnboardingIfVisible(page);
    await createDemoRuntime(page, 'journey-rt1', randomMnemonic());
    await ensureAnyHubAccountOpen(page);

    const initial = await readPrimaryAccountProgress(page);
    expect(initial, 'expected at least one opened hub account').not.toBeNull();
    if (!initial) return;
    const renderedBefore = await getRenderedPrimaryOutbound(page);
    const persistedBefore = await getPersistedReceiptCursor(page);

    // User flow action: request one offchain faucet payment through the opened account.
    const faucetResult = await page.evaluate(async ({ entityId, signerId, counterpartyId }) => {
      const env = (window as typeof window & { isolatedEnv?: { runtimeId?: string } }).isolatedEnv;
      if (!env) return;
      const runtimeId = String(env.runtimeId || '').toLowerCase();
      const requestApiBase = window.location.origin;
      const res = await fetch(`${requestApiBase}/api/faucet/offchain`, {
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
      const body = await res.json().catch(() => ({}));
      if (!res.ok || !body?.success) {
        throw new Error(body?.error || `offchain faucet failed (${res.status})`);
      }
      return {
        status: String(body?.status || ''),
        requestId: String(body?.requestId || ''),
        statusUrl: String(body?.statusUrl || ''),
        accountReady: Boolean(body?.accountReady),
      };
    }, {
      entityId: initial.entityId,
      signerId: initial.signerId,
      counterpartyId: initial.counterpartyId,
    });
    expect(faucetResult, 'offchain faucet should queue a runtime input from the browser path').toMatchObject({
      status: 'queued',
      accountReady: true,
    });
    expect(faucetResult?.requestId, 'queued faucet must expose a receipt id').toMatch(/^offchain_/);
    expect(faucetResult?.statusUrl, 'queued faucet must expose receipt polling URL').toContain(faucetResult!.requestId);

    await expect.poll(
      async () => (await getPersistedReceiptCursor(page)).nextHeight,
      { timeout: 20_000, intervals: [100, 250, 500] },
    ).toBeGreaterThan(persistedBefore.nextHeight);

    await waitForRenderedPrimaryOutboundDelta(page, renderedBefore, 100, { timeoutMs: 20_000, tolerance: 0.001 });

    const finalState = (await readPrimaryAccountProgress(page))!;
    expect(finalState.frameHeight, 'account frame must stay live after offchain faucet').toBeGreaterThanOrEqual(initial.frameHeight);

    await expect.poll(
      async () => (await readEntityIdleSnapshot(page, initial.entityId, initial.signerId)).quiescent,
      { timeout: 20_000, intervals: [100, 250, 500], message: 'Entity must become idle after faucet ACK' },
    ).toBe(true);
    const beforeInitialJCatchup = await readEntityIdleSnapshot(page, initial.entityId, initial.signerId);
    await mineEmptyJurisdictionBlock(page);
    await expect.poll(
      async () => (await readEntityIdleSnapshot(page, initial.entityId, initial.signerId)).finalizedJHeight,
      {
        timeout: 10_000,
        intervals: [100, 250, 500, 1000],
        message: 'the new Entity must certify pre-existing jurisdiction bootstrap evidence before the idle check',
      },
    ).toBeGreaterThan(beforeInitialJCatchup.finalizedJHeight);
    await expect.poll(
      async () => (await readEntityIdleSnapshot(page, initial.entityId, initial.signerId)).quiescent,
      { timeout: 10_000, intervals: [100, 250, 500], message: 'Entity must settle after initial J catch-up' },
    ).toBe(true);

    const idleBefore = await readEntityIdleSnapshot(page, initial.entityId, initial.signerId);
    await mineEmptyJurisdictionBlock(page);
    await expect.poll(
      async () => (await readEntityIdleSnapshot(page, initial.entityId, initial.signerId)).watcherScannedJHeight,
      {
        timeout: 10_000,
        intervals: [100, 250, 500, 1000],
        message: 'the internal watcher must authenticate the newly mined empty J block',
      },
    ).toBeGreaterThan(idleBefore.watcherScannedJHeight);
    const idleAfter = await readEntityIdleSnapshot(page, initial.entityId, initial.signerId);
    expect(idleAfter.quiescent, 'idle watcher polling must not create new Entity work').toBe(true);
    expect(
      idleAfter.entityHeight,
      `authenticated empty J headers must not create empty Entity frames: ${JSON.stringify({ idleBefore, idleAfter })}`,
    )
      .toBe(idleBefore.entityHeight);
    expect(idleAfter.finalizedJHeight, 'empty J headers stay watcher-local until real Entity work')
      .toBe(idleBefore.finalizedJHeight);
    expect(idleAfter.projectedJHeight, 'empty J headers must not mutate the durable Entity projection')
      .toBe(idleBefore.projectedJHeight);
    expect(idleAfter.watcherScannedJHeight, 'the internal watcher must keep scanning while Entity height stays idle')
      .toBeGreaterThan(idleBefore.watcherScannedJHeight);
  });
});
