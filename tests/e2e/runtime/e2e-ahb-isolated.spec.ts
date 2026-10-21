import { formatMoney } from '../../../ui/src/runtime/format';
/**
 * E2E: Alice and Bob run in separate browser contexts on the same origin, connect to one hub,
 * exchange HTLC payments in both directions, validate persisted HTLC receipts, reject overspend,
 * and survive reload with the same persisted state.
 *
 * This test exists to prove the honest user-facing topology: two isolated pages with separate
 * IndexedDB/localStorage state, not two runtimes multiplexed inside one browser page.
 */

import { test, expect, allowBrowserIssue, type BrowserContext, type Page } from '../../global-setup.mts';
import { ethers } from 'ethers';
import type { RuntimeReplica, XLNModule } from '../../../core/api/public/runtime-module';
import { createWalletIdentity, LOCAL_PASSWORD } from '../../../ui/tests/wallet-ui';
import { prepareUiPayment, openPayWorkspace, fillUiPaymentIntent } from '../../utils/runtime/e2e-pay-ui';
import { ensureE2EBaseline } from '../../utils/e2e-baseline';
import {
  getRenderedOutboundForAccount,
  waitForRenderedOutboundForAccountDelta,
} from '../../utils/runtime/e2e-account-ui';
import { connectRuntimeToHub, waitForReceiveReadyGossipProfiles } from '../../utils/e2e-connect';
import { gotoApp, selectDemoMnemonic } from '../../utils/e2e-demo-users';
import {
  getPersistedReceiptCursor,
  getPersistedRuntimeDbMeta,
  waitForPersistedFrameEventMatch,
} from '../../utils/e2e-runtime-receipts';

import { requireIsolatedBaseUrl } from '../../utils/runtime/e2e-isolated-env';
const APP_BASE_URL = requireIsolatedBaseUrl('E2E_BASE_URL');
const API_BASE_URL = requireIsolatedBaseUrl('E2E_API_BASE_URL');
const LONG_E2E = process.env.E2E_LONG === '1';
const INIT_TIMEOUT = 30_000;
// The full gate runs eight complete browser+Anvil stacks. Durable event
// delivery normally finishes well inside this in isolation; the larger wait
// prevents host contention from being misreported as a consensus failure.
const DURABLE_EVENT_TIMEOUT_MS = 60_000;
const FEE_DENOM = 1_000_000n;

type HubFeeConfig = {
  feePPM: bigint;
  baseFee: bigint;
};

type TestWindow = Window & {
  __xln?: {
    env(): RuntimeReplica | null;
    xln(): Promise<XLNModule>;
    store: { getState(): { activeEntityId: string | null } };
  };
};

const calcFee = (amount: bigint, feePPM: bigint, baseFee: bigint): bigint => (amount * feePPM) / FEE_DENOM + baseFee;

const afterFee = (amount: bigint, feePPM: bigint, baseFee: bigint): bigint => amount - calcFee(amount, feePPM, baseFee);

function assertHtlcReceivedPayload(
  event: { data?: Record<string, unknown> },
  recipientEntityId: string,
  expectedFromEntity: string,
  expectedAmount: bigint,
): void {
  expect(String(event.data?.amount || ''), 'receive event should include amount').toBe(expectedAmount.toString());
  expect(String(event.data?.entityId || '').toLowerCase(), 'receive event should include entityId').toBe(
    recipientEntityId.toLowerCase(),
  );
  expect(String(event.data?.toEntity || '').toLowerCase(), 'receive event should include toEntity').toBe(
    recipientEntityId.toLowerCase(),
  );
  expect(String(event.data?.fromEntity || '').toLowerCase(), 'receive event should include fromEntity').toBe(
    expectedFromEntity.toLowerCase(),
  );
  expect(String(event.data?.hashlock || ''), 'receive event should include hashlock').toMatch(/^0x[0-9a-f]{64}$/i);
  expect(String(event.data?.lockId || '').length, 'receive event should include lockId').toBeGreaterThan(0);
  expect(
    String(event.data?.jurisdictionId || '').length,
    'receive event should include jurisdictionId',
  ).toBeGreaterThan(0);
  expect(Number(event.data?.startedAtMs || 0), 'receive event should include startedAtMs').toBeGreaterThan(0);
  expect(Number(event.data?.receivedAtMs || 0), 'receive event should include receivedAtMs').toBeGreaterThan(0);
  expect(Number(event.data?.elapsedMs || 0), 'receive event should include elapsedMs').toBeGreaterThan(0);
}

function assertHtlcFinalizedPayload(
  event: { data?: Record<string, unknown> },
  senderEntityId: string,
  expectedToEntity: string,
  expectedAmount: bigint,
): void {
  expect(String(event.data?.amount || ''), 'finalized event should include amount').toBe(expectedAmount.toString());
  expect(String(event.data?.entityId || '').toLowerCase(), 'finalized event should include entityId').toBe(
    senderEntityId.toLowerCase(),
  );
  expect(String(event.data?.fromEntity || '').toLowerCase(), 'finalized event should include fromEntity').toBe(
    senderEntityId.toLowerCase(),
  );
  expect(String(event.data?.toEntity || '').toLowerCase(), 'finalized event should include toEntity').toBe(
    expectedToEntity.toLowerCase(),
  );
  expect(String(event.data?.hashlock || ''), 'finalized event should include hashlock').toMatch(/^0x[0-9a-f]{64}$/i);
  expect(String(event.data?.lockId || '').length, 'finalized event should include lockId').toBeGreaterThan(0);
  expect(
    String(event.data?.jurisdictionId || '').length,
    'finalized event should include jurisdictionId',
  ).toBeGreaterThan(0);
  expect(Number(event.data?.startedAtMs || 0), 'finalized event should include startedAtMs').toBeGreaterThan(0);
  expect(Number(event.data?.finalizedAtMs || 0), 'finalized event should include finalizedAtMs').toBeGreaterThan(0);
  expect(Number(event.data?.elapsedMs || 0), 'finalized event should include elapsedMs').toBeGreaterThan(0);
  expect(Number(event.data?.finalizedInMs || 0), 'finalized event should include finalizedInMs').toBeGreaterThan(0);
}

const USDC_DECIMALS = 6;

function toUsdcUnits(n: number): bigint {
  return BigInt(n) * 10n ** BigInt(USDC_DECIMALS);
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

function mirrorConsole(page: Page, tag: string): void {
  page.on('console', msg => {
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

async function waitForEntityAdvertised(page: Page, entityId: string, timeoutMs = 30_000): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate(async target => {
          const debug = (window as TestWindow).__xln;
          const env = debug?.env();
          if (!debug || !env) throw new Error('CURRENT_WALLET_RUNTIME_MISSING');
          await (await debug.xln()).ensureGossipProfiles(env, [target]);
          return env.gossip
            .getProfiles()
            .some(
              profile =>
                profile.entityId.toLowerCase() === target.toLowerCase() &&
                Boolean(profile.runtimeId || profile.metadata?.runtimeId),
            );
        }, entityId),
      { timeout: timeoutMs },
    )
    .toBe(true);
}

async function discoverHubs(page: Page): Promise<string[]> {
  let hubs: string[] = [];
  await expect
    .poll(
      async () => {
        hubs = await page.evaluate(async () => {
          const debug = (window as TestWindow).__xln;
          const env = debug?.env();
          const entityId = debug?.store.getState().activeEntityId;
          if (!debug || !env || !entityId) throw new Error('CURRENT_WALLET_RUNTIME_MISSING');
          const entity = [...env.state.eReplicas.values()].find(replica => replica.entityId === entityId);
          const jurisdiction = entity?.state.config.jurisdiction;
          if (!jurisdiction) throw new Error('CURRENT_WALLET_JURISDICTION_MISSING');
          (await debug.xln()).refreshGossip(env);
          return env.gossip
            .getProfiles()
            .filter(
              profile =>
                profile.metadata?.isHub === true &&
                profile.metadata.jurisdiction?.chainId === jurisdiction.chainId &&
                profile.metadata.jurisdiction?.depositoryAddress.toLowerCase() ===
                  jurisdiction.depositoryAddress.toLowerCase(),
            )
            .map(profile => profile.entityId);
        });
        return hubs.length;
      },
      { timeout: 15_000 },
    )
    .toBeGreaterThan(0);
  return hubs;
}

async function getHubFeeConfig(page: Page, hubId: string): Promise<HubFeeConfig> {
  const fee = await page.evaluate(targetHubId => {
    const view = window as TestWindow;
    const profiles = view.__xln?.env()?.gossip?.getProfiles?.() ?? [];
    const profile = profiles.find(
      entry => String(entry.entityId || '').toLowerCase() === String(targetHubId || '').toLowerCase(),
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

async function outCapRaw(page: Page, entityId: string, cpId: string): Promise<bigint> {
  const value = await page.evaluate(
    async ({ cpId, entityId }) => {
      const debug = (window as TestWindow).__xln;
      const env = debug?.env();
      if (!debug || !env) throw new Error('CURRENT_WALLET_RUNTIME_MISSING');
      const replica = [...env.state.eReplicas.values()].find(entry => entry.entityId === entityId);
      const account = replica?.state.accounts.get(cpId);
      const delta = account?.state.deltas.get(1);
      if (!account || !delta) throw new Error('CURRENT_WALLET_ACCOUNT_DELTA_MISSING');
      return (await debug.xln()).deriveDelta(delta, account.state.leftEntity === entityId).outCapacity.toString();
    },
    { entityId, cpId },
  );
  return BigInt(value);
}

async function waitForSenderSpendRaw(
  page: Page,
  entityId: string,
  cpId: string,
  baseline: bigint,
  minSpend: bigint,
  timeoutMs = 30_000,
): Promise<{ latest: bigint; spent: bigint }> {
  const startedAt = Date.now();
  let latest = baseline;
  let spent = 0n;
  while (Date.now() - startedAt < timeoutMs) {
    latest = await outCapRaw(page, entityId, cpId);
    spent = baseline - latest;
    if (spent >= minSpend) return { latest, spent };
    await page.waitForTimeout(250);
  }
  throw new Error(
    `Timed out waiting raw sender spend on ${entityId.slice(0, 10)}↔${cpId.slice(0, 10)} ` +
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
    last = await page.evaluate(
      ({ counterpartyId, entityId }) => {
        const view = window as TestWindow;
        if (!view.__xln?.env()?.state?.eReplicas) {
          return { hasAccount: false, height: 0, pendingHeight: null, mempoolLen: 0 };
        }
        for (const [replicaKey, replica] of view.__xln?.env().state.eReplicas.entries()) {
          if (!String(replicaKey).startsWith(`${entityId}:`)) continue;
          const account = replica.state?.accounts?.get(counterpartyId);
          if (!account) return { hasAccount: false, height: 0, pendingHeight: null, mempoolLen: 0 };
          return {
            hasAccount: true,
            height: Number(account.currentHeight),
            pendingHeight: account.pendingFrame ? Number(account.pendingFrame.height || 0) : null,
            mempoolLen: Number(account.mempool?.length || 0),
          };
        }
        return { hasAccount: false, height: 0, pendingHeight: null, mempoolLen: 0 };
      },
      { counterpartyId, entityId },
    );

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
      return view.__xln?.env()?.runtimeId ?? null;
    });
    const apiBaseUrl = API_BASE_URL;
    if (!runtimeId) {
      result = { ok: false, status: 0, data: { error: 'CURRENT_WALLET_RUNTIME_ID_MISSING' } };
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
      const body = await response.json().catch(() => ({}) as Record<string, unknown>);
      result = { ok: response.status() === 200, status: response.status(), data: body };
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
      code === 'FAUCET_TOKEN_SURFACE_NOT_READY';
    if (!transient || attempt === 6) break;
    await page.waitForTimeout(1500);
  }

  expect(result.ok, `faucet failed: ${JSON.stringify(result.data)}`).toBe(true);
}

function toDisplayed(amount: bigint): number {
  return Number(ethers.formatUnits(amount, USDC_DECIMALS));
}

function expectRenderedDeltaClose(actualDelta: number, expectedDelta: number, label: string): void {
  const drift = Math.abs(actualDelta - expectedDelta);
  expect(
    drift,
    `${label} drift must stay within rendered-number tolerance (actual=${actualDelta}, expected=${expectedDelta}, drift=${drift})`,
  ).toBeLessThanOrEqual(0.000000001);
}

async function reloadAppForProject(page: Page, appBaseUrl: string, projectName: string): Promise<void> {
  if (projectName === 'webkit-mobile') {
    await page.goto(`${appBaseUrl}/app`, { waitUntil: 'domcontentloaded' });
  } else {
    await page.reload({ waitUntil: 'domcontentloaded' });
  }
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.getByLabel('Password', { exact: true }).fill(LOCAL_PASSWORD);
  await page.evaluate(() => {
    const started = performance.now();
    const stages: Array<{ elapsedMs: number; stage: string }> = [];
    const capture = () => {
      const stage =
        document.querySelector('button[type=submit]')?.textContent ??
        document.querySelector('main [role=status]')?.textContent ??
        (document.querySelector('[data-testid=nav-home]') ? 'Home' : 'Opening');
      if (stages.at(-1)?.stage !== stage) stages.push({ elapsedMs: Math.round(performance.now() - started), stage });
    };
    new MutationObserver(capture).observe(document.body, { childList: true, subtree: true, characterData: true });
    (window as Window & { __reloadStages?: typeof stages }).__reloadStages = stages;
    capture();
  });
  await page.getByRole('button', { name: 'Unlock', exact: true }).click();
  try {
    await expect(page.getByTestId('nav-home').locator('visible=true').first()).toBeVisible();
  } finally {
    const state = await page.evaluate(async () => {
      const debug = (window as TestWindow).__xln;
      const env = debug?.env();
      const xln = await debug?.xln();
      return {
        stages: (window as Window & { __reloadStages?: Array<{ elapsedMs: number; stage: string }> }).__reloadStages,
        runtimeId: env?.runtimeId,
        height: env?.state.height,
        halted: env?.infrastructure?.halted ?? false,
        relayConnected: env?.infrastructure?.p2p?.isConnected() ?? false,
        queuedRuntimeTxs: env?.runtimeMempool.runtimeTxs.map(tx => tx.type),
        queuedEntityInputs: env?.runtimeMempool.entityInputs.map(input => input.entityTxs?.map(tx => tx.type)),
        entities:
          env && xln
            ? [...env.state.eReplicas.values()].map(replica => ({
                entityId: replica.entityId,
                height: replica.state.height,
                pending: replica.mempool.map(tx => tx.type),
                proposalHeight: replica.proposal?.height ?? null,
                scan: xln.getEntityJAdapter(env, replica.entityId, replica.signerId)?.getWatcherScanProgress?.(),
                accounts: [...replica.state.accounts.values()].map(account => ({
                  height: account.currentHeight,
                  pendingHeight: account.pendingFrame?.height ?? null,
                })),
              }))
            : [],
      };
    });
    await test
      .info()
      .attach('isolated-reload-boundary', { body: JSON.stringify(state), contentType: 'application/json' });
    console.log('[E2E] isolated reload boundary', JSON.stringify(state));
  }
}

async function pay(
  page: Page,
  from: string,
  signerId: string,
  to: string,
  route: string[],
  amount: bigint,
): Promise<void> {
  expect(route[0]).toBe(from);
  expect(signerId).toMatch(/^0x[0-9a-f]{40}$/i);
  await prepareUiPayment(page, { recipientEntityId: to, amount, tokenId: 1, routeEntityIds: route });
  const hub = route[1];
  if (!hub) throw new Error('PAYMENT_TEST_ROUTE_MISSING_HUB');
  // Quote must refresh the actual sender graph before admission; a test must not prefill its cache.
  await waitForReceiveReadyGossipProfiles(page, [from, hub, to], hub);
  await page.getByTestId('pay-submit').click();
}

async function attemptOverspend(page: Page, from: string, to: string, amount: bigint): Promise<void> {
  await openPayWorkspace(page);
  // Deliberately exceeding capacity must miss routing, never submit financial work.
  // Require this exact negative-case diagnostic; unrelated route misses still fail.
  const expectedMiss = `[network] GOSSIP_ROUTE_MISS {source: ${from}, target: ${to}, tokenId: 1, retries: 3}`;
  allowBrowserIssue({
    type: 'console',
    severity: 'warning',
    message: new RegExp(`^${expectedMiss.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`),
  });
  const routeMiss = page.waitForEvent(
    'console',
    message => message.type() === 'warning' && message.text() === expectedMiss,
  );
  await fillUiPaymentIntent(page, to, amount, 1);
  const quoting = page.getByText('Quoting routes…', { exact: true });
  await expect(quoting).toBeVisible();
  await expect(quoting).toBeHidden();
  await expect(page.getByTestId('pay-submit')).toBeDisabled();
  await expect(page.getByTestId('pay-quote')).toHaveCount(0);
  await routeMiss;
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
  await page.waitForFunction(
    ({ targetRuntimeId }) => {
      const view = window as TestWindow;
      return (
        String(view.__xln?.env()?.runtimeId || '').toLowerCase() === String(targetRuntimeId || '').toLowerCase() &&
        Number(view.__xln?.env()?.state?.eReplicas?.size || 0) > 0
      );
    },
    { targetRuntimeId: runtimeId },
    { timeout: INIT_TIMEOUT },
  );
}

async function waitForDurableRuntimeState(page: Page, label: string): Promise<void> {
  await expect
    .poll(
      async () => {
        const meta = await runtimeDbMeta(page);
        return meta.hasLatestFrame && meta.latestHeight >= meta.runtimeHeight;
      },
      {
        timeout: 30_000,
        message: `${label} durable persisted height must catch up to runtime height`,
      },
    )
    .toBe(true);
}

async function waitForRuntimeInputDrain(page: Page, label: string, timeoutMs = 15_000): Promise<void> {
  await expect
    .poll(
      async () => {
        return await page.evaluate(() => {
          const env = (window as TestWindow).__xln?.env();
          if (!env) throw new Error('CURRENT_WALLET_RUNTIME_MISSING');
          const mempool = env.runtimeMempool;
          return (
            mempool.runtimeTxs.length === 0 &&
            mempool.entityInputs.length === 0 &&
            (mempool.jInputs?.length ?? 0) === 0 &&
            (env.pendingOutputs?.length ?? 0) === 0 &&
            (env.pendingNetworkOutputs?.length ?? 0) === 0 &&
            (env.networkInbox?.length ?? 0) === 0
          );
        });
      },
      {
        timeout: timeoutMs,
        message: `${label} runtime input queues must be empty before reload`,
      },
    )
    .toBe(true);
}

test.describe('E2E: Alice ↔ Hub ↔ Bob across isolated pages', () => {
  test.setTimeout(LONG_E2E ? 300_000 : 210_000);

  test(
    'bidirectional payments survive across two isolated browser contexts',
    { tag: '@functional' },
    async ({ browser, page }, testInfo) => {
      if (testInfo.project.name === 'webkit-mobile') {
        testInfo.setTimeout(LONG_E2E ? 300_000 : 210_000);
      }
      let aliceContext: BrowserContext | null = null;
      let bobContext: BrowserContext | null = null;

      try {
        await ensureE2EBaseline(page, {
          requireHubMesh: true,
          requireMarketMaker: false,
          minHubCount: 3,
        });

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
        const alice = await createWalletIdentity(alicePage, 'alice', selectDemoMnemonic('alice'));
        const bob = await createWalletIdentity(bobPage, 'bob', selectDemoMnemonic('bob'));
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
        await faucet(alicePage, alice.entityId, hubId);
        const aliceAfterFaucet = await waitForRenderedOutboundForAccountDelta(alicePage, hubId, aliceBeforeFaucet, 100);
        expect(aliceAfterFaucet).toBeGreaterThan(aliceBeforeFaucet);

        const hubFee = await getHubFeeConfig(alicePage, hubId);

        console.log('[E2E] forward HTLC Alice -> Hub -> Bob');
        const forwardAmount = toUsdcUnits(10);
        const expectedForwardSpend = requiredInbound(forwardAmount, hubFee.feePPM, hubFee.baseFee);
        const aliceBeforeForwardRaw = await outCapRaw(alicePage, alice.entityId, hubId);
        const bobBeforeForward = await getRenderedOutboundForAccount(bobPage, hubId);
        const bobForwardCursor = await getPersistedReceiptCursor(bobPage);
        const aliceForwardFinalizeCursor = await getPersistedReceiptCursor(alicePage);
        const readiness = await Promise.all(
          [alicePage, bobPage].map(walletPage =>
            walletPage.evaluate(
              ({ recipient, hub }) => {
                const env = (window as TestWindow).__xln?.env();
                if (!env) throw new Error('CURRENT_WALLET_RUNTIME_MISSING');
                return {
                  runtimeId: env.runtimeId,
                  recipientProfile: env.gossip.getProfiles().find(profile => profile.entityId === recipient),
                  localAccounts: [...env.state.eReplicas.values()].map(replica => ({
                    entityId: replica.entityId,
                    height: replica.state.height,
                    accounts: [...replica.state.accounts].map(([id, account]) => ({
                      id,
                      height: account.currentHeight,
                      pending: account.pendingFrame?.height,
                    })),
                  })),
                  hub,
                };
              },
              { recipient: bob.entityId, hub: hubId },
            ),
          ),
        );
        expect(
          readiness[0]?.recipientProfile?.accounts.some(account => account.counterpartyId === hubId),
          'sender starts with the genuinely stale recipient profile',
        ).toBe(false);
        expect(
          readiness[1]?.recipientProfile?.accounts.some(account => account.counterpartyId === hubId),
          'recipient has already published its committed Hub account',
        ).toBe(true);
        console.log(
          '[E2E] stale-profile regression',
          readiness.map(entry => ({
            runtimeId: entry.runtimeId,
            accounts: entry.recipientProfile?.accounts.map(account => account.counterpartyId),
            updatedAt: entry.recipientProfile?.lastUpdated,
          })),
        );

        await pay(
          alicePage,
          alice.entityId,
          alice.signerId,
          bob.entityId,
          [alice.entityId, hubId, bob.entityId],
          forwardAmount,
        );

        const forwardSpend = await waitForSenderSpendRaw(
          alicePage,
          alice.entityId,
          hubId,
          aliceBeforeForwardRaw,
          expectedForwardSpend,
        );
        const aliceForwardFinalizeEvent = await waitForPersistedFrameEventMatch(alicePage, {
          eventName: 'HtlcFinalized',
          entityId: alice.entityId,
          cursor: aliceForwardFinalizeCursor,
          timeoutMs: DURABLE_EVENT_TIMEOUT_MS,
          predicate: event => String(event.data?.amount || '') === forwardAmount.toString(),
        });
        assertHtlcFinalizedPayload(aliceForwardFinalizeEvent, alice.entityId, hubId, forwardAmount);
        const bobForwardReceiveEvent = await waitForPersistedFrameEventMatch(bobPage, {
          eventName: 'HtlcReceived',
          entityId: bob.entityId,
          cursor: bobForwardCursor,
          timeoutMs: DURABLE_EVENT_TIMEOUT_MS,
          predicate: event => String(event.data?.amount || '') === forwardAmount.toString(),
        });
        assertHtlcReceivedPayload(bobForwardReceiveEvent, bob.entityId, hubId, forwardAmount);
        const bobAfterForward = await waitForRenderedOutboundForAccountDelta(
          bobPage,
          hubId,
          bobBeforeForward,
          toDisplayed(forwardAmount),
        );
        expect(forwardSpend.spent).toBeGreaterThanOrEqual(expectedForwardSpend);
        expectRenderedDeltaClose(bobAfterForward - bobBeforeForward, toDisplayed(forwardAmount), 'bob forward receive');

        console.log('[E2E] reverse HTLC Bob -> Hub -> Alice');
        await waitForAccountIdle(bobPage, bob.entityId, hubId);
        await waitForAccountIdle(alicePage, alice.entityId, hubId);
        const reverseAmount = toUsdcUnits(5);
        const expectedReverseSpend = requiredInbound(reverseAmount, hubFee.feePPM, hubFee.baseFee);
        const bobBeforeReverseRaw = await outCapRaw(bobPage, bob.entityId, hubId);
        const aliceBeforeReverse = await getRenderedOutboundForAccount(alicePage, hubId);
        const aliceReverseCursor = await getPersistedReceiptCursor(alicePage);
        const bobReverseFinalizeCursor = await getPersistedReceiptCursor(bobPage);
        await pay(
          bobPage,
          bob.entityId,
          bob.signerId,
          alice.entityId,
          [bob.entityId, hubId, alice.entityId],
          reverseAmount,
        );

        const reverseSpend = await waitForSenderSpendRaw(
          bobPage,
          bob.entityId,
          hubId,
          bobBeforeReverseRaw,
          expectedReverseSpend,
        );
        const bobReverseFinalizeEvent = await waitForPersistedFrameEventMatch(bobPage, {
          eventName: 'HtlcFinalized',
          entityId: bob.entityId,
          cursor: bobReverseFinalizeCursor,
          timeoutMs: DURABLE_EVENT_TIMEOUT_MS,
          predicate: event => String(event.data?.amount || '') === reverseAmount.toString(),
        });
        assertHtlcFinalizedPayload(bobReverseFinalizeEvent, bob.entityId, hubId, reverseAmount);
        const aliceReverseReceiveEvent = await waitForPersistedFrameEventMatch(alicePage, {
          eventName: 'HtlcReceived',
          entityId: alice.entityId,
          cursor: aliceReverseCursor,
          timeoutMs: DURABLE_EVENT_TIMEOUT_MS,
          predicate: event => String(event.data?.amount || '') === reverseAmount.toString(),
        });
        assertHtlcReceivedPayload(aliceReverseReceiveEvent, alice.entityId, hubId, reverseAmount);
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
        // Rendered capacities deliberately round to two decimals; fee/debit authority uses exact base units above.
        expect(bobAfterReverse).toBe(Number(formatMoney(reverseSpend.latest, USDC_DECIMALS).replaceAll(',', '')));
        console.log('[E2E] exact debits', {
          forward: forwardSpend.spent.toString(),
          reverse: reverseSpend.spent.toString(),
        });
        await waitForAccountIdle(alicePage, alice.entityId, hubId);
        await waitForAccountIdle(bobPage, bob.entityId, hubId);
        await waitForRuntimeInputDrain(alicePage, 'alice');
        await waitForRuntimeInputDrain(bobPage, 'bob');
        await waitForDurableRuntimeState(alicePage, 'alice');
        await waitForDurableRuntimeState(bobPage, 'bob');

        let expectedAliceAfterReload = aliceAfterReverse;
        let expectedBobAfterReload = bobAfterReverse;

        if (LONG_E2E) {
          console.log('[E2E] restore both isolated pages before extended payment checks');
          if (testInfo.project.name === 'webkit-mobile') {
            await reloadAppForProject(alicePage, APP_BASE_URL, testInfo.project.name);
            await reloadAppForProject(bobPage, APP_BASE_URL, testInfo.project.name);
          } else {
            await Promise.all([
              reloadAppForProject(alicePage, APP_BASE_URL, testInfo.project.name),
              reloadAppForProject(bobPage, APP_BASE_URL, testInfo.project.name),
            ]);
          }
          await Promise.all([
            gotoApp(alicePage, { appBaseUrl: APP_BASE_URL, initTimeoutMs: INIT_TIMEOUT, settleMs: 1000 }),
            gotoApp(bobPage, { appBaseUrl: APP_BASE_URL, initTimeoutMs: INIT_TIMEOUT, settleMs: 1000 }),
          ]);
          await Promise.all([
            waitForRestoredRuntime(alicePage, alice.runtimeId),
            waitForRestoredRuntime(bobPage, bob.runtimeId),
          ]);
          await waitForAccountIdle(alicePage, alice.entityId, hubId);
          await waitForAccountIdle(bobPage, bob.entityId, hubId);

          console.log('[E2E] second forward HTLC Alice -> Hub -> Bob');

          const secondForwardAmount = toUsdcUnits(3);
          const expectedSecondForwardSpend = requiredInbound(secondForwardAmount, hubFee.feePPM, hubFee.baseFee);
          const aliceBeforeSecondForward = await getRenderedOutboundForAccount(alicePage, hubId);
          const aliceBeforeSecondForwardRaw = await outCapRaw(alicePage, alice.entityId, hubId);
          const bobBeforeSecondForward = await getRenderedOutboundForAccount(bobPage, hubId);
          const bobSecondForwardCursor = await getPersistedReceiptCursor(bobPage);
          const aliceSecondForwardFinalizeCursor = await getPersistedReceiptCursor(alicePage);

          await pay(
            alicePage,
            alice.entityId,
            alice.signerId,
            bob.entityId,
            [alice.entityId, hubId, bob.entityId],
            secondForwardAmount,
          );

          const secondForwardSpend = await waitForSenderSpendRaw(
            alicePage,
            alice.entityId,
            hubId,
            aliceBeforeSecondForwardRaw,
            expectedSecondForwardSpend,
          );
          const aliceSecondFinalizeEvent = await waitForPersistedFrameEventMatch(alicePage, {
            eventName: 'HtlcFinalized',
            entityId: alice.entityId,
            cursor: aliceSecondForwardFinalizeCursor,
            timeoutMs: DURABLE_EVENT_TIMEOUT_MS,
            predicate: event => String(event.data?.amount || '') === secondForwardAmount.toString(),
          });
          assertHtlcFinalizedPayload(aliceSecondFinalizeEvent, alice.entityId, hubId, secondForwardAmount);
          const bobSecondReceiveEvent = await waitForPersistedFrameEventMatch(bobPage, {
            eventName: 'HtlcReceived',
            entityId: bob.entityId,
            cursor: bobSecondForwardCursor,
            timeoutMs: DURABLE_EVENT_TIMEOUT_MS,
            predicate: event => String(event.data?.amount || '') === secondForwardAmount.toString(),
          });
          assertHtlcReceivedPayload(bobSecondReceiveEvent, bob.entityId, hubId, secondForwardAmount);

          const bobAfterSecondForward = await waitForRenderedOutboundForAccountDelta(
            bobPage,
            hubId,
            bobBeforeSecondForward,
            toDisplayed(secondForwardAmount),
          );
          const aliceAfterSecondForward = await getRenderedOutboundForAccount(alicePage, hubId);
          expect(secondForwardSpend.spent).toBeGreaterThanOrEqual(expectedSecondForwardSpend);
          expectRenderedDeltaClose(
            bobAfterSecondForward - bobBeforeSecondForward,
            toDisplayed(secondForwardAmount),
            'bob second forward receive',
          );

          console.log('[E2E] overspend rejection');
          if (testInfo.project.name === 'webkit-mobile') {
            await reloadAppForProject(alicePage, APP_BASE_URL, testInfo.project.name);
            await reloadAppForProject(bobPage, APP_BASE_URL, testInfo.project.name);
          } else {
            await Promise.all([
              reloadAppForProject(alicePage, APP_BASE_URL, testInfo.project.name),
              reloadAppForProject(bobPage, APP_BASE_URL, testInfo.project.name),
            ]);
          }
          await Promise.all([
            gotoApp(alicePage, { appBaseUrl: APP_BASE_URL, initTimeoutMs: INIT_TIMEOUT, settleMs: 1000 }),
            gotoApp(bobPage, { appBaseUrl: APP_BASE_URL, initTimeoutMs: INIT_TIMEOUT, settleMs: 1000 }),
          ]);
          await Promise.all([
            waitForRestoredRuntime(alicePage, alice.runtimeId),
            waitForRestoredRuntime(bobPage, bob.runtimeId),
          ]);
          await waitForAccountIdle(alicePage, alice.entityId, hubId);
          await waitForAccountIdle(bobPage, bob.entityId, hubId);
          const aliceBeforeOverspend = aliceAfterSecondForward;
          const overspendUnits = Math.max(1, Math.ceil(aliceBeforeOverspend) + 1);
          await attemptOverspend(alicePage, alice.entityId, bob.entityId, toUsdcUnits(overspendUnits));
          const aliceAfterOverspend = await getRenderedOutboundForAccount(alicePage, hubId);
          expect(aliceAfterOverspend, 'overspend should not change alice balance').toBe(aliceBeforeOverspend);

          expectedAliceAfterReload = aliceAfterSecondForward;
          expectedBobAfterReload = bobAfterSecondForward;

          await waitForRuntimeInputDrain(alicePage, 'alice-post-overspend');
          await waitForRuntimeInputDrain(bobPage, 'bob-post-overspend');
          await waitForDurableRuntimeState(alicePage, 'alice-post-overspend');
          await waitForDurableRuntimeState(bobPage, 'bob-post-overspend');
        }

        console.log('[E2E] capture persistence state before reload');
        const aliceRawBeforeReload = await outCapRaw(alicePage, alice.entityId, hubId);
        const bobRawBeforeReload = await outCapRaw(bobPage, bob.entityId, hubId);
        const aliceDbBefore = await runtimeDbMeta(alicePage);
        const bobDbBefore = await runtimeDbMeta(bobPage);
        expect(aliceDbBefore.latestHeight, 'alice WAL height must advance').toBeGreaterThan(0);
        expect(bobDbBefore.latestHeight, 'bob WAL height must advance').toBeGreaterThan(0);
        expect(aliceDbBefore.hasLatestFrame, 'alice latest WAL frame must exist').toBe(true);
        expect(bobDbBefore.hasLatestFrame, 'bob latest WAL frame must exist').toBe(true);

        if (testInfo.project.name === 'webkit-mobile') {
          await reloadAppForProject(alicePage, APP_BASE_URL, testInfo.project.name);
          await reloadAppForProject(bobPage, APP_BASE_URL, testInfo.project.name);
        } else {
          await Promise.all([
            reloadAppForProject(alicePage, APP_BASE_URL, testInfo.project.name),
            reloadAppForProject(bobPage, APP_BASE_URL, testInfo.project.name),
          ]);
        }
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

        expect(await outCapRaw(alicePage, alice.entityId, hubId), 'alice exact base units survive reload').toBe(
          aliceRawBeforeReload,
        );
        expect(await outCapRaw(bobPage, bob.entityId, hubId), 'bob exact base units survive reload').toBe(
          bobRawBeforeReload,
        );
        expect(aliceAfterReload, 'alice balance must survive reload').toBe(expectedAliceAfterReload);
        expect(bobAfterReload, 'bob balance must survive reload').toBe(expectedBobAfterReload);
        expect(aliceDbAfter.latestHeight, 'alice replay height must survive reload').toBeGreaterThanOrEqual(
          aliceDbBefore.latestHeight,
        );
        expect(bobDbAfter.latestHeight, 'bob replay height must survive reload').toBeGreaterThanOrEqual(
          bobDbBefore.latestHeight,
        );
      } finally {
        await Promise.all([
          aliceContext ? aliceContext.close().catch(() => {}) : Promise.resolve(),
          bobContext ? bobContext.close().catch(() => {}) : Promise.resolve(),
        ]);
      }
    },
  );
});
