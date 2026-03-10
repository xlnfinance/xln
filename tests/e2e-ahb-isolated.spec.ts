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
import { getPersistedReceiptCursor, waitForPersistedFrameEvent } from './utils/e2e-runtime-receipts';

const APP_BASE_URL = process.env.E2E_BASE_URL ?? 'https://localhost:8080';
const API_BASE_URL = process.env.E2E_API_BASE_URL ?? APP_BASE_URL;
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

type XlnView = {
  refreshGossip?: (env: unknown) => void;
  enqueueRuntimeInput?: (env: unknown, input: unknown) => void;
};

type TestWindow = typeof window & {
  XLN?: XlnView;
  vaultOperations?: {
    enqueueEntityInputs?: (
      env: unknown,
      inputs: Array<{
        entityId: string;
        signerId: string;
        entityTxs: Array<{
          type: 'htlcPayment';
          data: {
            amount: bigint;
            hashlock: string;
            route: string[];
            secret: string;
            targetEntityId: string;
            tokenId: number;
          };
        }>;
      }>,
    ) => Promise<unknown>;
    getPersistedLatestHeight?: (env: unknown) => Promise<number>;
    readPersistedFrameJournal?: (
      env: unknown,
      height: number,
    ) => Promise<{ logs?: FrameLogEntryView[] } | null>;
  };
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

function generateHtlc(): { secret: string; hashlock: string } {
  const secret = ethers.hexlify(ethers.randomBytes(32));
  const abiCoder = ethers.AbiCoder.defaultAbiCoder();
  const hashlock = ethers.keccak256(abiCoder.encode(['bytes32'], [secret]));
  return { secret, hashlock };
}

function toDisplayed(amount: bigint): number {
  return Number(ethers.formatUnits(amount, 18));
}

async function pay(
  page: Page,
  from: string,
  signerId: string,
  to: string,
  route: string[],
  amount: bigint,
): Promise<void> {
  const { hashlock, secret } = generateHtlc();

  const result = await page.evaluate(async ({ amount, from, hashlock, route, secret, signerId, to }) => {
    try {
      const view = window as TestWindow;
      const env = view.isolatedEnv;
      const vaultOperations = view.vaultOperations;
      if (!env || !vaultOperations?.enqueueEntityInputs) {
        return { ok: false, error: 'runtime env missing' };
      }

      let liveSignerId = signerId;
      for (const replicaKey of env.eReplicas?.keys?.() ?? []) {
        const [entityId, replicaSignerId] = String(replicaKey).split(':');
        if (String(entityId).toLowerCase() === String(from).toLowerCase() && replicaSignerId) {
          liveSignerId = replicaSignerId;
          break;
        }
      }

      await vaultOperations.enqueueEntityInputs(env, [{
          entityId: from,
          signerId: liveSignerId,
          entityTxs: [{
            type: 'htlcPayment',
            data: {
              amount: BigInt(amount),
              hashlock,
              route,
              secret,
              targetEntityId: to,
              tokenId: 1,
            },
          }],
        }]);

      return { ok: true };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }, { amount: amount.toString(), from, hashlock, route, secret, signerId, to });

  expect(result.ok, `htlcPayment failed: ${result.error ?? 'unknown'}`).toBe(true);
  await page.waitForTimeout(200);
}

async function runtimeDbMeta(page: Page): Promise<{
  checkpointHeight: number;
  hasLatestFrame: boolean;
  latestHeight: number;
}> {
  return page.evaluate(async () => {
    const view = window as TestWindow;
    const env = view.isolatedEnv;
    const getPersistedLatestHeight = view.vaultOperations?.getPersistedLatestHeight;
    const readPersistedFrameJournal = view.vaultOperations?.readPersistedFrameJournal;
    if (
      !env ||
      typeof getPersistedLatestHeight !== 'function' ||
      typeof readPersistedFrameJournal !== 'function'
    ) {
      return { checkpointHeight: 0, hasLatestFrame: false, latestHeight: 0 };
    }

    const latestHeight = Number(await getPersistedLatestHeight(env) || 0);
    const latestFrame = latestHeight > 0 ? await readPersistedFrameJournal(env, latestHeight) : null;
    const hasLatestFrame = latestFrame !== null;
    const checkpointHeight = hasLatestFrame ? latestHeight : 0;

    return { checkpointHeight, hasLatestFrame, latestHeight };
  });
}

async function waitForRestoredRuntime(page: Page, runtimeId: string): Promise<void> {
  await page.waitForFunction(({ targetRuntimeId }) => {
    const view = window as TestWindow;
    return String(view.isolatedEnv?.runtimeId || '').toLowerCase() === String(targetRuntimeId || '').toLowerCase()
      && Number(view.isolatedEnv?.eReplicas?.size || 0) > 0;
  }, { targetRuntimeId: runtimeId }, { timeout: INIT_TIMEOUT });
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
      await pay(alicePage, alice.entityId, alice.signerId, bob.entityId, [alice.entityId, hubId, bob.entityId], forwardAmount);

      const forwardSpend = await waitForSenderSpend(alicePage, hubId, aliceAfterFaucet, expectedForwardSpend);
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
      expect(bobAfterForward - bobBeforeForward).toBe(toDisplayed(forwardAmount));

      console.log('[E2E] reverse HTLC Bob -> Hub -> Alice');
      await waitForAccountIdle(bobPage, bob.entityId, hubId);
      await waitForAccountIdle(alicePage, alice.entityId, hubId);
      const reverseAmount = toWei(5);
      const expectedReverseSpend = toDisplayed(requiredInbound(reverseAmount, hubFee.feePPM, hubFee.baseFee));
      const aliceBeforeReverse = await getRenderedOutboundForAccount(alicePage, hubId);
      const bobBeforeReverse = await getRenderedOutboundForAccount(bobPage, hubId);
      const aliceReverseCursor = await getPersistedReceiptCursor(alicePage);
      await pay(bobPage, bob.entityId, bob.signerId, alice.entityId, [bob.entityId, hubId, alice.entityId], reverseAmount);

      const reverseSpend = await waitForSenderSpend(bobPage, hubId, bobAfterForward, expectedReverseSpend);
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
      expect(aliceAfterReverse - aliceBeforeReverse).toBe(toDisplayed(reverseAmount));
      expect(bobBeforeReverse - bobAfterReverse).toBeGreaterThanOrEqual(expectedReverseSpend);

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
