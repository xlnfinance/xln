/**
 * E2E: Alice and Bob run in separate browser contexts on the same origin, connect to one hub,
 * exchange HTLC payments in both directions, and survive reload with the same persisted state.
 *
 * This test exists to prove the honest user-facing topology: two isolated pages with separate
 * IndexedDB/localStorage state, not two runtimes multiplexed inside one browser page.
 */

import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { ethers } from 'ethers';
import { resetProdServer } from './utils/e2e-baseline';
import {
  getRenderedOutboundForAccount,
  waitForRenderedOutboundForAccountDelta,
} from './utils/e2e-account-ui';
import { connectRuntimeToHub } from './utils/e2e-connect';
import { createRuntimeIdentity, gotoApp, selectDemoMnemonic } from './utils/e2e-demo-users';
import {
  getPersistedReceiptCursor,
  getPersistedRuntimeDbMeta,
  waitForPersistedFrameEvent,
  waitForPersistedFrameEventMatch,
} from './utils/e2e-runtime-receipts';

import { requireIsolatedBaseUrl } from './utils/e2e-isolated-env';
const APP_BASE_URL = requireIsolatedBaseUrl('E2E_BASE_URL');
const API_BASE_URL = requireIsolatedBaseUrl('E2E_API_BASE_URL');
const LONG_E2E = process.env.E2E_LONG === '1';
const INIT_TIMEOUT = 30_000;
const SETTLE_MS = 10_000;
const FEE_DENOM = 1_000_000n;

type HubFeeConfig = {
  feePPM: bigint;
  baseFee: bigint;
};

type GossipProfile = {
  entityId: string;
  runtimeId?: string;
  metadata?: {
    runtimeId?: string;
    isHub?: boolean;
    routingFeePPM?: number;
    baseFee?: string | number | bigint;
  };
};

type AccountView = {
  deltas?: Map<number, unknown>;
  pendingFrame?: { height?: number };
  currentHeight?: number;
  mempool?: unknown[];
};

type EntityReplicaView = {
  state?: {
    accounts?: Map<string, AccountView>;
  };
};

type FrameLogEntryView = {
  id?: number;
  message?: string;
  entityId?: string;
  data?: Record<string, unknown>;
};

type TestWindow = typeof window & {
  isolatedEnv?: {
    runtimeId?: string;
    height?: number;
    frameLogs?: FrameLogEntryView[];
    eReplicas?: Map<string, EntityReplicaView>;
    gossip?: {
      getProfiles?: () => GossipProfile[];
    };
    runtimeState?: {
      p2p?: {
        relayUrls?: string[];
      };
    };
  };
};

const calcFee = (amount: bigint, feePPM: bigint, baseFee: bigint): bigint =>
  (amount * feePPM / FEE_DENOM) + baseFee;

const afterFee = (amount: bigint, feePPM: bigint, baseFee: bigint): bigint =>
  amount - calcFee(amount, feePPM, baseFee);

function toWei(n: number): bigint {
  return BigInt(n) * 10n ** 18n;
}

function requiredInbound(desiredForward: bigint, feePPM: bigint, baseFee: bigint): bigint {
  let low = desiredForward;
  let high = desiredForward;
  while (afterFee(high, feePPM, baseFee) < desiredForward) high *= 2n;
  while (low < high) {
    const mid = (low + high) / 2n;
    if (afterFee(mid, feePPM, baseFee) >= desiredForward) high = mid;
    else low = mid + 1n;
  }
  return low;
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

function mirrorConsole(page: Page, tag: string): void {
  page.on('console', (msg) => {
    const text = msg.text();
    if (
      msg.type() === 'error' ||
      text.includes('[E2E]') ||
      text.includes('HTLC') ||
      text.includes('Payment') ||
      text.includes('Frame consensus')
    ) {
      console.log(`[${tag}] ${text.slice(0, 260)}`);
    }
  });
}

async function getActiveApiBase(page: Page): Promise<string> {
  if (process.env.E2E_API_BASE_URL) return API_BASE_URL;
  const runtimeApi = await page.evaluate(() => {
    const view = window as TestWindow;
    const relay = view.isolatedEnv?.runtimeState?.p2p?.relayUrls?.[0] ?? null;
    return typeof relay === 'string' ? relay : null;
  });
  return relayToApiBase(runtimeApi) ?? APP_BASE_URL;
}

async function waitForEntityAdvertised(page: Page, entityId: string, timeoutMs = 30_000): Promise<void> {
  const apiBaseUrl = await getActiveApiBase(page);
  const advertised = await page.evaluate(async ({ apiBaseUrl, entityId, timeoutMs }) => {
    const target = String(entityId).toLowerCase();
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      try {
        const response = await fetch(`${apiBaseUrl}/api/debug/entities?limit=5000&q=${encodeURIComponent(entityId)}`);
        if (response.ok) {
          const body = await response.json() as { entities?: Array<{ entityId?: string; runtimeId?: string }> };
          const entities = Array.isArray(body.entities) ? body.entities : [];
          const hit = entities.find((entry) => String(entry.entityId || '').toLowerCase() === target);
          if (hit?.runtimeId) return true;
        }
      } catch {
        // Best effort only.
      }

      try {
        const view = window as TestWindow;
        const profiles = view.isolatedEnv?.gossip?.getProfiles?.() ?? [];
        const hit = profiles.find((profile) => String(profile.entityId || '').toLowerCase() === target);
        if (hit?.runtimeId || hit?.metadata?.runtimeId) return true;
      } catch {
        // Retry.
      }

      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    return false;
  }, { apiBaseUrl, entityId, timeoutMs });

  expect(advertised, `entity ${entityId.slice(0, 12)} must be visible in relay directory or gossip`).toBe(true);
}

async function discoverHubs(page: Page): Promise<string[]> {
  const apiBaseUrl = await getActiveApiBase(page);
  for (let attempt = 0; attempt < 45; attempt += 1) {
    const fromGossip = await page.evaluate(() => {
      const view = window as TestWindow;
      try {
        view.XLN?.refreshGossip?.(view.isolatedEnv);
      } catch {
        // Best effort.
      }
      const profiles = view.isolatedEnv?.gossip?.getProfiles?.() ?? [];
      const ids = profiles
        .filter((profile) => profile.metadata?.isHub === true)
        .map((profile) => profile.entityId)
        .filter((entityId): entityId is string => typeof entityId === 'string');
      return Array.from(new Set(ids));
    });
    if (fromGossip.length > 0) return fromGossip;

    try {
      const response = await page.request.get(`${apiBaseUrl}/api/debug/entities`);
      if (response.ok()) {
        const body = await response.json() as {
          entities?: Array<{ entityId?: string; isHub?: boolean }>;
        };
        const ids = (Array.isArray(body.entities) ? body.entities : [])
          .filter((entry) => entry.isHub === true)
          .map((entry) => entry.entityId)
          .filter((entityId): entityId is string => typeof entityId === 'string');
        const unique = Array.from(new Set(ids));
        if (unique.length > 0) return unique;
      }
    } catch {
      // Retry.
    }

    await page.waitForTimeout(500);
  }

  return [];
}

async function getHubFeeConfig(page: Page, hubId: string): Promise<HubFeeConfig> {
  const fee = await page.evaluate((targetHubId) => {
    const view = window as TestWindow;
    const profiles = view.isolatedEnv?.gossip?.getProfiles?.() ?? [];
    const profile = profiles.find((entry) =>
      String(entry.entityId || '').toLowerCase() === String(targetHubId || '').toLowerCase(),
    );
    const rawPPM = Number(profile?.metadata?.routingFeePPM ?? 0);
    const feePPM = Number.isFinite(rawPPM) && rawPPM >= 0 ? Math.floor(rawPPM) : 0;
    const rawBase = profile?.metadata?.baseFee;
    if (typeof rawBase === 'bigint') {
      return { feePPM: String(feePPM), baseFee: rawBase.toString() };
    }
    if (typeof rawBase === 'number' && Number.isFinite(rawBase)) {
      return { feePPM: String(feePPM), baseFee: String(Math.max(0, Math.floor(rawBase))) };
    }
    if (typeof rawBase === 'string') {
      return { feePPM: String(feePPM), baseFee: rawBase };
    }
    return { feePPM: String(feePPM), baseFee: '0' };
  }, hubId);

  return {
    feePPM: BigInt(String(fee.feePPM || '0')),
    baseFee: BigInt(String(fee.baseFee || '0')),
  };
}

async function waitForSenderSpend(
  page: Page,
  counterpartyId: string,
  baseline: number,
  minSpend: number,
  timeoutMs = 30_000,
): Promise<{ latest: number; spent: number }> {
  const startedAt = Date.now();
  let latest = baseline;
  let spent = 0;
  while (Date.now() - startedAt < timeoutMs) {
    latest = await getRenderedOutboundForAccount(page, counterpartyId);
    spent = baseline - latest;
    if (spent >= minSpend) return { latest, spent };
    await page.waitForTimeout(250);
  }
  throw new Error(
    `Timed out waiting for sender spend on ${counterpartyId.slice(0, 10)} ` +
    `(baseline=${baseline} latest=${latest} spent=${spent} minSpend=${minSpend})`,
  );
}

async function waitForAccountIdle(
  page: Page,
  entityId: string,
  counterpartyId: string,
  timeoutMs = 12_000,
): Promise<void> {
  const startedAt = Date.now();
  let last = { hasAccount: false, height: 0, pendingHeight: null as number | null, mempoolLen: 0 };

  while (Date.now() - startedAt < timeoutMs) {
    last = await page.evaluate(({ counterpartyId, entityId }) => {
      const view = window as TestWindow;
      if (!view.isolatedEnv?.eReplicas) {
        return { hasAccount: false, height: 0, pendingHeight: null, mempoolLen: 0 };
      }
      for (const [replicaKey, replica] of view.isolatedEnv.eReplicas.entries()) {
        if (!String(replicaKey).startsWith(`${entityId}:`)) continue;
        const account = replica.state?.accounts?.get(counterpartyId);
        if (!account) return { hasAccount: false, height: 0, pendingHeight: null, mempoolLen: 0 };
        return {
          hasAccount: true,
          height: Number(account.currentHeight || 0),
          pendingHeight: account.pendingFrame ? Number(account.pendingFrame.height || 0) : null,
          mempoolLen: Number(account.mempool?.length || 0),
        };
      }
      return { hasAccount: false, height: 0, pendingHeight: null, mempoolLen: 0 };
    }, { counterpartyId, entityId });

    if (last.hasAccount && last.pendingHeight === null) return;
    await page.waitForTimeout(250);
  }

  throw new Error(
    `Account not idle for ${entityId.slice(0, 10)}↔${counterpartyId.slice(0, 10)} ` +
    `(hasAccount=${last.hasAccount} height=${last.height} pending=${last.pendingHeight} mempool=${last.mempoolLen})`,
  );
}

async function faucet(page: Page, entityId: string, hubEntityId: string): Promise<void> {
  let result: { ok: boolean; status: number; data: Record<string, unknown> } = {
    ok: false,
    status: 0,
    data: { error: 'not-run' },
  };

  for (let attempt = 1; attempt <= 6; attempt += 1) {
    const runtimeId = await page.evaluate(() => {
      const view = window as TestWindow;
      return view.isolatedEnv?.runtimeId ?? null;
    });
    const apiBaseUrl = await getActiveApiBase(page);
    if (!runtimeId) {
      result = { ok: false, status: 0, data: { error: 'missing runtimeId in isolatedEnv' } };
      break;
    }

    try {
      const response = await page.request.post(`${apiBaseUrl}/api/faucet/offchain`, {
        data: {
          userEntityId: entityId,
          userRuntimeId: runtimeId,
          tokenId: 1,
          amount: '100',
          hubEntityId,
        },
      });
      const body = await response.json().catch(() => ({} as Record<string, unknown>));
      result = { ok: response.ok(), status: response.status(), data: body };
    } catch (error) {
      result = {
        ok: false,
        status: 0,
        data: { error: error instanceof Error ? error.message : String(error) },
      };
    }

    console.log(`[E2E] faucet attempt=${attempt} status=${result.status} body=${JSON.stringify(result.data)}`);
    if (result.ok) break;

    const message = String(result.data.error || '');
    const code = String(result.data.code || '');
    const status = String(result.data.status || '');
    const transient =
      result.status === 202 ||
      result.status === 409 ||
      message.includes('SIGNER_RESOLUTION_FAILED') ||
      message.includes('AWAITING') ||
      message.includes('pending') ||
      message.includes('FAUCET_ACCOUNT_MISSING') ||
      message.includes('No hub account with target entity') ||
      code === 'FAUCET_CHANNEL_NOT_READY' ||
      status === 'channel_opening' ||
      status === 'channel_not_ready';
    if (!transient || attempt === 6) break;
    await page.waitForTimeout(1500);
  }

  expect(result.ok, `faucet failed: ${JSON.stringify(result.data)}`).toBe(true);
  await page.waitForTimeout(SETTLE_MS);
}

function toDisplayed(amount: bigint): number {
  return Number(ethers.formatUnits(amount, 18));
}

function expectRenderedDeltaClose(actualDelta: number, expectedDelta: number, label: string): void {
  const drift = Math.abs(actualDelta - expectedDelta);
  expect(
    drift,
    `${label} drift must stay within rendered-number tolerance (actual=${actualDelta}, expected=${expectedDelta}, drift=${drift})`,
  ).toBeLessThanOrEqual(0.000000001);
}

async function openPayWorkspace(page: Page): Promise<void> {
  const accountsTab = page.getByTestId('tab-accounts').first();
  if (!await accountsTab.isVisible().catch(() => false)) {
    const backButton = page.locator('.account-panel .back-button').first();
    if (await backButton.isVisible().catch(() => false)) {
      await backButton.click();
    }
  }
  await expect(accountsTab).toBeVisible({ timeout: 20_000 });
  await accountsTab.click();
  const workspaceTabs = page.locator('.account-workspace-tabs').first();
  await expect(workspaceTabs).toBeVisible({ timeout: 20_000 });
  const payTab = workspaceTabs.locator('.account-workspace-tab').filter({ hasText: /Pay/i }).first();
  await expect(payTab).toBeVisible({ timeout: 20_000 });
  await payTab.click();
}

async function selectPayRecipient(page: Page, targetEntityId: string): Promise<void> {
  const recipientPicker = page.locator('button.closed-trigger').first();
  await expect(recipientPicker).toBeVisible({ timeout: 10_000 });
  await recipientPicker.click();
  const recipientOption = page.locator('.dropdown-item').filter({ hasText: targetEntityId }).first();
  await expect(recipientOption).toBeVisible({ timeout: 10_000 });
  await recipientOption.click();
}

async function pay(
  page: Page,
  from: string,
  signerId: string,
  to: string,
  route: string[],
  amount: bigint,
): Promise<void> {
  void from;
  void signerId;
  void route;

  await openPayWorkspace(page);

  await selectPayRecipient(page, to);

  const amountInput = page.locator('#payment-amount-input');
  await expect(amountInput).toBeVisible({ timeout: 10_000 });
  await amountInput.click();
  await amountInput.fill(ethers.formatUnits(amount, 18));

  const findRoutesBtn = page.getByRole('button', { name: 'Find Routes' }).first();
  await expect(findRoutesBtn).toBeEnabled({ timeout: 10_000 });
  await findRoutesBtn.click();
  await expect(page.locator('text=/1 hop|route/i').first()).toBeVisible({ timeout: 15_000 });

  const payNowBtn = page.getByRole('button', { name: 'Pay Now' }).first();
  await expect(payNowBtn).toBeEnabled({ timeout: 10_000 });
  await payNowBtn.click();
  await page.waitForTimeout(200);
}

async function runtimeDbMeta(page: Page): Promise<{
  checkpointHeight: number;
  hasLatestFrame: boolean;
  latestHeight: number;
  runtimeHeight: number;
}> {
  const meta = await getPersistedRuntimeDbMeta(page);
  return {
    checkpointHeight: meta.checkpointHeight,
    hasLatestFrame: meta.hasLatestFrame,
    latestHeight: meta.latestHeight,
    runtimeHeight: meta.runtimeHeight,
  };
}

async function waitForRestoredRuntime(page: Page, runtimeId: string): Promise<void> {
  await page.waitForFunction(({ targetRuntimeId }) => {
    const view = window as TestWindow;
    return String(view.isolatedEnv?.runtimeId || '').toLowerCase() === String(targetRuntimeId || '').toLowerCase()
      && Number(view.isolatedEnv?.eReplicas?.size || 0) > 0;
  }, { targetRuntimeId: runtimeId }, { timeout: INIT_TIMEOUT });
}

async function waitForDurableRuntimeState(page: Page, label: string): Promise<void> {
  await expect
    .poll(async () => {
      const meta = await runtimeDbMeta(page);
      return meta.hasLatestFrame && meta.latestHeight >= meta.runtimeHeight;
    }, {
      timeout: 30_000,
      message: `${label} durable persisted height must catch up to runtime height`,
    })
    .toBe(true);
}

async function waitForRuntimeInputDrain(page: Page, label: string, timeoutMs = 15_000): Promise<void> {
  await expect
    .poll(async () => {
      return await page.evaluate(() => {
        const view = window as TestWindow & {
          isolatedEnv?: {
            runtimeInput?: { runtimeTxs?: unknown[]; entityInputs?: unknown[]; jInputs?: unknown[] };
            runtimeMempool?: { runtimeTxs?: unknown[]; entityInputs?: unknown[]; jInputs?: unknown[] };
          };
        };
        const input = view.isolatedEnv?.runtimeInput;
        const mempool = view.isolatedEnv?.runtimeMempool;
        const inputCount =
          Number(input?.runtimeTxs?.length || 0) +
          Number(input?.entityInputs?.length || 0) +
          Number(input?.jInputs?.length || 0);
        const mempoolCount =
          Number(mempool?.runtimeTxs?.length || 0) +
          Number(mempool?.entityInputs?.length || 0) +
          Number(mempool?.jInputs?.length || 0);
        return inputCount === 0 && mempoolCount === 0;
      });
    }, {
      timeout: timeoutMs,
      message: `${label} runtime input queues must be empty before reload`,
    })
    .toBe(true);
}

test.describe('E2E: Alice ↔ Hub ↔ Bob across isolated pages', () => {
  test.setTimeout(LONG_E2E ? 240_000 : 120_000);

  test('bidirectional payments survive across two isolated browser contexts', async ({ browser, page }) => {
    let aliceContext: BrowserContext | null = null;
    let bobContext: BrowserContext | null = null;

    try {
      await resetProdServer(page);

      aliceContext = await browser.newContext({ ignoreHTTPSErrors: true });
      bobContext = await browser.newContext({ ignoreHTTPSErrors: true });
      const alicePage = await aliceContext.newPage();
      const bobPage = await bobContext.newPage();
      mirrorConsole(alicePage, 'ALICE');
      mirrorConsole(bobPage, 'BOB');

      await Promise.all([
        gotoApp(alicePage, { appBaseUrl: APP_BASE_URL, initTimeoutMs: INIT_TIMEOUT, settleMs: 1500 }),
        gotoApp(bobPage, { appBaseUrl: APP_BASE_URL, initTimeoutMs: INIT_TIMEOUT, settleMs: 1500 }),
      ]);

      console.log('[E2E] create isolated runtimes');
      const alice = await createRuntimeIdentity(alicePage, 'alice', selectDemoMnemonic('alice'));
      const bob = await createRuntimeIdentity(bobPage, 'bob', selectDemoMnemonic('bob'));
      expect(alice.entityId).not.toBe(bob.entityId);

      await Promise.all([
        waitForEntityAdvertised(alicePage, alice.entityId),
        waitForEntityAdvertised(alicePage, bob.entityId),
        waitForEntityAdvertised(bobPage, alice.entityId),
        waitForEntityAdvertised(bobPage, bob.entityId),
      ]);

      console.log(`[E2E] Alice entity=${alice.entityId.slice(0, 16)} runtime=${alice.runtimeId.slice(0, 12)}`);
      console.log(`[E2E] Bob entity=${bob.entityId.slice(0, 16)} runtime=${bob.runtimeId.slice(0, 12)}`);

      const aliceHubs = await discoverHubs(alicePage);
      const bobHubs = await discoverHubs(bobPage);
      expect(aliceHubs.length, 'alice must discover at least one hub').toBeGreaterThan(0);
      const hubId = aliceHubs[0]!;
      expect(bobHubs.includes(hubId), 'bob must discover the same primary hub').toBe(true);

      console.log(`[E2E] connect both runtimes to hub ${hubId.slice(0, 16)}`);
      await connectRuntimeToHub(alicePage, alice, hubId);
      await connectRuntimeToHub(bobPage, bob, hubId);

      console.log('[E2E] fund Alice through the selected hub');
      const aliceBeforeFaucet = await getRenderedOutboundForAccount(alicePage, hubId);
      const aliceFaucetCursor = await getPersistedReceiptCursor(alicePage);
      await faucet(alicePage, alice.entityId, hubId);
      await waitForPersistedFrameEvent(alicePage, {
        eventName: 'BilateralFrameCommitted',
        cursor: aliceFaucetCursor,
        timeoutMs: 30_000,
      });
      const aliceAfterFaucet = await waitForRenderedOutboundForAccountDelta(alicePage, hubId, aliceBeforeFaucet, 100);
      expect(aliceAfterFaucet).toBeGreaterThan(aliceBeforeFaucet);

      const hubFee = await getHubFeeConfig(alicePage, hubId);

      console.log('[E2E] forward HTLC Alice -> Hub -> Bob');
      const forwardAmount = toWei(10);
      const expectedForwardSpend = toDisplayed(requiredInbound(forwardAmount, hubFee.feePPM, hubFee.baseFee));
      const bobBeforeForward = await getRenderedOutboundForAccount(bobPage, hubId);
      const bobForwardCursor = await getPersistedReceiptCursor(bobPage);
      const aliceForwardFinalizeCursor = await getPersistedReceiptCursor(alicePage);
      await pay(alicePage, alice.entityId, alice.signerId, bob.entityId, [alice.entityId, hubId, bob.entityId], forwardAmount);

      const forwardSpend = await waitForSenderSpend(alicePage, hubId, aliceAfterFaucet, expectedForwardSpend);
      await waitForPersistedFrameEventMatch(alicePage, {
        eventName: 'HtlcFinalized',
        entityId: alice.entityId,
        cursor: aliceForwardFinalizeCursor,
        timeoutMs: 30_000,
        predicate: (event) => String(event.data?.amount || '') === forwardAmount.toString(),
      });
      await waitForPersistedFrameEvent(bobPage, {
        eventName: 'HtlcReceived',
        entityId: bob.entityId,
        cursor: bobForwardCursor,
      });
      const bobAfterForward = await waitForRenderedOutboundForAccountDelta(
        bobPage,
        hubId,
        bobBeforeForward,
        toDisplayed(forwardAmount),
      );
      expect(forwardSpend.spent).toBeGreaterThanOrEqual(expectedForwardSpend);
      expectRenderedDeltaClose(
        bobAfterForward - bobBeforeForward,
        toDisplayed(forwardAmount),
        'bob forward receive',
      );

      console.log('[E2E] reverse HTLC Bob -> Hub -> Alice');
      await waitForAccountIdle(bobPage, bob.entityId, hubId);
      await waitForAccountIdle(alicePage, alice.entityId, hubId);
      const reverseAmount = toWei(5);
      const expectedReverseSpend = toDisplayed(requiredInbound(reverseAmount, hubFee.feePPM, hubFee.baseFee));
      const aliceBeforeReverse = await getRenderedOutboundForAccount(alicePage, hubId);
      const bobBeforeReverse = await getRenderedOutboundForAccount(bobPage, hubId);
      const aliceReverseCursor = await getPersistedReceiptCursor(alicePage);
      const bobReverseFinalizeCursor = await getPersistedReceiptCursor(bobPage);
      await pay(bobPage, bob.entityId, bob.signerId, alice.entityId, [bob.entityId, hubId, alice.entityId], reverseAmount);

      const reverseSpend = await waitForSenderSpend(bobPage, hubId, bobAfterForward, expectedReverseSpend);
      await waitForPersistedFrameEventMatch(bobPage, {
        eventName: 'HtlcFinalized',
        entityId: bob.entityId,
        cursor: bobReverseFinalizeCursor,
        timeoutMs: 30_000,
        predicate: (event) => String(event.data?.amount || '') === reverseAmount.toString(),
      });
      await waitForPersistedFrameEvent(alicePage, {
        eventName: 'HtlcReceived',
        entityId: alice.entityId,
        cursor: aliceReverseCursor,
      });
      const aliceAfterReverse = await waitForRenderedOutboundForAccountDelta(
        alicePage,
        hubId,
        aliceBeforeReverse,
        toDisplayed(reverseAmount),
      );
      const bobAfterReverse = await getRenderedOutboundForAccount(bobPage, hubId);
      expect(reverseSpend.spent).toBeGreaterThanOrEqual(expectedReverseSpend);
      expectRenderedDeltaClose(
        aliceAfterReverse - aliceBeforeReverse,
        toDisplayed(reverseAmount),
        'alice reverse receive',
      );
      expect(bobBeforeReverse - bobAfterReverse).toBeGreaterThanOrEqual(expectedReverseSpend);
      await waitForAccountIdle(alicePage, alice.entityId, hubId);
      await waitForAccountIdle(bobPage, bob.entityId, hubId);
      await waitForRuntimeInputDrain(alicePage, 'alice');
      await waitForRuntimeInputDrain(bobPage, 'bob');
      await waitForDurableRuntimeState(alicePage, 'alice');
      await waitForDurableRuntimeState(bobPage, 'bob');

      console.log('[E2E] capture persistence state before reload');
      const aliceDbBefore = await runtimeDbMeta(alicePage);
      const bobDbBefore = await runtimeDbMeta(bobPage);
      expect(aliceDbBefore.latestHeight, 'alice WAL height must advance').toBeGreaterThan(0);
      expect(bobDbBefore.latestHeight, 'bob WAL height must advance').toBeGreaterThan(0);
      expect(aliceDbBefore.hasLatestFrame, 'alice latest WAL frame must exist').toBe(true);
      expect(bobDbBefore.hasLatestFrame, 'bob latest WAL frame must exist').toBe(true);

      await Promise.all([
        alicePage.reload({ waitUntil: 'domcontentloaded' }),
        bobPage.reload({ waitUntil: 'domcontentloaded' }),
      ]);
      await Promise.all([
        gotoApp(alicePage, { appBaseUrl: APP_BASE_URL, initTimeoutMs: INIT_TIMEOUT, settleMs: 1000 }),
        gotoApp(bobPage, { appBaseUrl: APP_BASE_URL, initTimeoutMs: INIT_TIMEOUT, settleMs: 1000 }),
      ]);
      await Promise.all([
        waitForRestoredRuntime(alicePage, alice.runtimeId),
        waitForRestoredRuntime(bobPage, bob.runtimeId),
      ]);

      const aliceAfterReload = await getRenderedOutboundForAccount(alicePage, hubId);
      const bobAfterReload = await getRenderedOutboundForAccount(bobPage, hubId);
      const aliceDbAfter = await runtimeDbMeta(alicePage);
      const bobDbAfter = await runtimeDbMeta(bobPage);

      expect(aliceAfterReload, 'alice balance must survive reload').toBe(aliceAfterReverse);
      expect(bobAfterReload, 'bob balance must survive reload').toBe(bobAfterReverse);
      expect(aliceDbAfter.latestHeight, 'alice replay height must survive reload').toBeGreaterThanOrEqual(aliceDbBefore.latestHeight);
      expect(bobDbAfter.latestHeight, 'bob replay height must survive reload').toBeGreaterThanOrEqual(bobDbBefore.latestHeight);
    } finally {
      await Promise.all([
        aliceContext ? aliceContext.close().catch(() => {}) : Promise.resolve(),
        bobContext ? bobContext.close().catch(() => {}) : Promise.resolve(),
      ]);
    }
  });
});
