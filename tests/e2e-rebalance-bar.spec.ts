import { test, expect, type Page } from '@playwright/test';
import { Wallet } from 'ethers';

const APP_BASE_URL = process.env.E2E_BASE_URL ?? 'https://localhost:8080';
const API_BASE_URL = process.env.E2E_API_BASE_URL ?? APP_BASE_URL;
const RESET_BASE_URL = process.env.E2E_RESET_BASE_URL ?? APP_BASE_URL;
const INIT_TIMEOUT = 45_000;

function randomMnemonic(): string {
  return Wallet.createRandom().mnemonic!.phrase;
}

async function gotoApp(page: Page) {
  await page.goto(`${APP_BASE_URL}/app`);
  const unlock = page.locator('button:has-text("Unlock")');
  if (await unlock.isVisible({ timeout: 1500 }).catch(() => false)) {
    const input = page.locator('input').first();
    await input.fill('mml');
    await unlock.click();
    await page.waitForURL('**/app', { timeout: 10_000 });
  }
  await page.waitForFunction(() => (window as any).XLN, { timeout: INIT_TIMEOUT });
  await page.waitForTimeout(2000);

  // Dismiss onboarding if visible.
  const onboardingCheckbox = page.locator('text=I understand and accept the risks of using this software').first();
  if (await onboardingCheckbox.isVisible({ timeout: 1000 }).catch(() => false)) {
    await onboardingCheckbox.click();
    const continueBtn = page.locator('button:has-text("Continue")').first();
    if (await continueBtn.isVisible({ timeout: 1000 }).catch(() => false)) {
      await continueBtn.click();
      await page.waitForTimeout(1000);
    }
  }
}

async function createRuntime(page: Page, label: string, mnemonic: string) {
  const result = await page.evaluate(async ({ label, mnemonic }) => {
    try {
      const vaultOperations = (window as any).vaultOperations;
      if (!vaultOperations) return { ok: false, error: 'window.vaultOperations missing' };
      await vaultOperations.createRuntime(label, mnemonic, {
        loginType: 'demo',
        requiresOnboarding: false,
      });
      return { ok: true };
    } catch (e: any) {
      return { ok: false, error: e?.message || String(e) };
    }
  }, { label, mnemonic });
  expect(result.ok, `createRuntime failed: ${result.error || 'unknown'}`).toBe(true);
  await page.waitForTimeout(5000);
}

async function ensureRuntimeOnline(page: Page, tag: string) {
  const ok = await page.evaluate(async () => {
    const env = (window as any).isolatedEnv;
    const p2p = env?.runtimeState?.p2p as any;
    if (!env || !p2p) return false;
    const start = Date.now();
    while (Date.now() - start < 30_000) {
      if (typeof p2p.isConnected === 'function' && p2p.isConnected()) return true;
      if (typeof p2p.connect === 'function') {
        try { p2p.connect(); } catch {}
      } else if (typeof p2p.reconnect === 'function') {
        try { p2p.reconnect(); } catch {}
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    return false;
  });
  expect(ok, `[${tag}] runtime must be online`).toBe(true);
}

async function discoverHub(page: Page): Promise<string> {
  for (let i = 0; i < 60; i++) {
    const fromGossip = await page.evaluate(() => {
      const env = (window as any).isolatedEnv;
      const XLN = (window as any).XLN;
      XLN?.refreshGossip?.(env);
      const profiles = env?.gossip?.getProfiles?.() || [];
      const hub = profiles.find((p: any) =>
        p?.metadata?.isHub === true || (Array.isArray(p?.capabilities) && p.capabilities.includes('hub')));
      return typeof hub?.entityId === 'string' ? hub.entityId : null;
    });
    if (fromGossip) return fromGossip;
    await page.waitForTimeout(1000);
  }
  throw new Error('Hub not discovered within 60s');
}

async function waitForHubProfile(page: Page, hubId: string) {
  const ok = await page.evaluate(async ({ hubId }) => {
    const env = (window as any).isolatedEnv;
    const XLN = (window as any).XLN;
    const target = String(hubId).toLowerCase();
    const start = Date.now();
    while (Date.now() - start < 60_000) {
      XLN?.refreshGossip?.(env);
      const profiles = env?.gossip?.getProfiles?.() || [];
      const profile = profiles.find((p: any) => String(p?.entityId || '').toLowerCase() === target);
      if (profile?.metadata?.isHub === true || (Array.isArray(profile?.capabilities) && profile.capabilities.includes('hub'))) {
        return true;
      }
      await new Promise((resolve) => setTimeout(resolve, 800));
    }
    return false;
  }, { hubId });
  expect(ok, `hub profile not visible in local gossip for ${hubId.slice(0, 12)}`).toBe(true);
}

async function getLocalEntity(page: Page): Promise<{ entityId: string; signerId: string }> {
  const entity = await page.evaluate(() => {
    const env = (window as any).isolatedEnv;
    if (!env?.eReplicas) return null;
    const runtimeSigner = String(env.runtimeId || '').toLowerCase();
    for (const [key] of env.eReplicas.entries()) {
      const [entityId, signerId] = String(key).split(':');
      if (!entityId || !signerId) continue;
      if (runtimeSigner && String(signerId).toLowerCase() !== runtimeSigner) continue;
      return { entityId, signerId };
    }
    return null;
  });
  if (!entity) throw new Error('No local entity in isolatedEnv');
  return entity;
}

async function connectHub(page: Page, entityId: string, signerId: string, hubId: string) {
  const opened = await page.evaluate(async ({ entityId, signerId, hubId }) => {
    const env = (window as any).isolatedEnv;
    const XLN = (window as any).XLN;
    if (!env || !XLN) return false;

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

    const start = Date.now();
    while (Date.now() - start < 45_000) {
      for (const [k, rep] of env.eReplicas.entries()) {
        if (!String(k).startsWith(entityId + ':')) continue;
        const acc = rep.state?.accounts?.get(hubId);
        if (!acc) continue;
        const hasDelta = !!acc.deltas?.get?.(1);
        const noPending = !acc.pendingFrame;
        const hasFrames = Number(acc.currentHeight || 0) > 0;
        if (hasDelta && noPending && hasFrames) return true;
      }
      await new Promise((resolve) => setTimeout(resolve, 750));
    }
    return false;
  }, { entityId, signerId, hubId });

  expect(opened, 'openAccount -> bilateral account ready').toBe(true);
  await page.waitForTimeout(5000);
}

async function faucet(page: Page, userEntityId: string, hubEntityId: string) {
  const runtimeId = await page.evaluate(() => (window as any).isolatedEnv?.runtimeId || null);
  expect(runtimeId, 'runtimeId must exist before faucet').toBeTruthy();
  const resp = await page.request.post(`${API_BASE_URL}/api/faucet/offchain`, {
    data: { userEntityId, userRuntimeId: runtimeId, hubEntityId, tokenId: 1, amount: '100' },
  });
  const body = await resp.json().catch(() => ({}));
  expect(resp.ok(), `faucet failed: ${JSON.stringify(body)}`).toBe(true);
}

async function readRebalanceState(page: Page, hubId: string) {
  return page.evaluate(({ hubId }) => {
    const env = (window as any).isolatedEnv;
    if (!env?.eReplicas) return null;
    for (const [, rep] of env.eReplicas.entries()) {
      const acc = rep.state?.accounts?.get(hubId);
      if (!acc) continue;
      const delta = acc.deltas?.get?.(1);
      if (!delta) continue;
      const total = (delta.ondelta || 0n) + (delta.offdelta || 0n);
      const isLeft = String(rep.entityId || '').toLowerCase() < String(hubId).toLowerCase();
      const hubDebt = isLeft ? (total > 0n ? total : 0n) : (total < 0n ? -total : 0n);
      const collateral = delta.collateral || 0n;
      const uncollateralized = hubDebt > collateral ? hubDebt - collateral : 0n;
      const requested = acc.requestedRebalance?.get?.(1) || 0n;
      const policy = acc.rebalancePolicy?.get?.(1) || null;
      return {
        entityId: String(rep.entityId || ''),
        requested: requested.toString(),
        collateral: collateral.toString(),
        ondelta: String(delta.ondelta || 0n),
        offdelta: String(delta.offdelta || 0n),
        hubDebt: hubDebt.toString(),
        uncollateralized: uncollateralized.toString(),
        lastFinalizedJHeight: Number(acc.lastFinalizedJHeight || 0),
        currentHeight: Number(acc.currentHeight || 0),
        hasPolicy: !!policy,
      };
    }
    return null;
  }, { hubId });
}

async function readRebalanceDiagnostics(page: Page, hubId: string) {
  return page.evaluate(({ hubId }) => {
    const env = (window as any).isolatedEnv;
    if (!env?.eReplicas) return null;
    let profile: any = null;
    const target = String(hubId || '').toLowerCase();
    const profiles = env?.gossip?.getProfiles?.() || [];
    profile = profiles.find((p: any) => String(p?.entityId || '').toLowerCase() === target) || null;
    for (const [, rep] of env.eReplicas.entries()) {
      const acc = rep.state?.accounts?.get(hubId);
      if (!acc) continue;
      return {
        accountEntityId: String(rep.entityId || ''),
        counterpartyRebalanceFeePolicy: acc.counterpartyRebalanceFeePolicy || null,
        profileFound: !!profile,
        profileIsHub: profile?.metadata?.isHub === true,
        profileCapabilities: Array.isArray(profile?.capabilities) ? profile.capabilities : [],
        profileFeeFields: {
          rebalanceBaseFee: profile?.metadata?.rebalanceBaseFee ?? null,
          rebalanceLiquidityFeeBps: profile?.metadata?.rebalanceLiquidityFeeBps ?? null,
          rebalanceGasFee: profile?.metadata?.rebalanceGasFee ?? null,
          policyVersion: profile?.metadata?.policyVersion ?? null,
        },
      };
    }
    return null;
  }, { hubId });
}

async function readRebalanceStepEvents(page: Page, sinceTs: number): Promise<any[]> {
  const response = await page.request.get(`${API_BASE_URL}/api/debug/events?last=5000&since=${sinceTs}`);
  if (!response.ok()) return [];
  const body = await response.json().catch(() => ({}));
  const events = Array.isArray(body?.events) ? body.events : [];
  return events
    .filter((e: any) => e?.event === 'debug_event' && e?.details?.payload?.code === 'REB_STEP')
    .map((e: any) => ({ ts: e.ts, ...e.details.payload }));
}

function buildRebalanceFailureDump(input: {
  entityId: string;
  hubId: string;
  snapshot: any;
  diagnostics: any;
  rebalanceSteps: any[];
  stateTimeline: any[];
  rebalanceConsole: string[];
}) {
  const stepCounts = input.rebalanceSteps.reduce((acc: Record<string, number>, step: any) => {
    const key = String(step?.event || 'unknown');
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
  return JSON.stringify(
    {
      entityId: input.entityId,
      hubId: input.hubId,
      snapshot: input.snapshot,
      diagnostics: input.diagnostics,
      stepCounts,
      recentSteps: input.rebalanceSteps.slice(-120),
      stateTimeline: input.stateTimeline.slice(-60),
      console: input.rebalanceConsole.slice(-120),
    },
    null,
    2,
  );
}

async function waitForServerHealthy(page: Page, timeoutMs = 180_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const res = await page.request.get(`${RESET_BASE_URL}/api/health`);
      if (res.ok()) {
        const body = await res.json().catch(() => ({}));
        const resetDone = body?.reset?.inProgress !== true;
        const meshReady = body?.hubMesh?.ok === true;
        if (typeof body?.timestamp === 'number' && resetDone && meshReady) return;
      }
    } catch {
      // retry
    }
    await page.waitForTimeout(1000);
  }
  throw new Error('Server did not become healthy in time after reset');
}

async function resetProdServer(page: Page) {
  let resetDone = false;
  let lastError = '';
  for (let attempt = 1; attempt <= 10; attempt++) {
    try {
      const coldResponse = await page.request.post(`${RESET_BASE_URL}/reset?rpc=1&db=1`);
      if (coldResponse.ok()) {
        resetDone = true;
        break;
      }
      const softResponse = await page.request.post(`${RESET_BASE_URL}/api/debug/reset`, {
        data: { preserveHubs: false },
        headers: { 'Content-Type': 'application/json' },
      });
      if (softResponse.ok()) {
        resetDone = true;
        break;
      }
      const coldData = await coldResponse.json().catch(() => ({}));
      const softData = await softResponse.json().catch(() => ({}));
      lastError = `cold=${JSON.stringify(coldData)} soft=${JSON.stringify(softData)}`;
    } catch (error: any) {
      lastError = error?.message || String(error);
    }
    await page.waitForTimeout(1000);
  }
  expect(resetDone, `reset failed after retries: ${lastError}`).toBe(true);
  await waitForServerHealthy(page);
}

test.describe('Rebalance E2E', () => {
  test.setTimeout(300_000);

  test('faucet -> request_collateral -> secured bar', async ({ page }) => {
    const scenarioStartedAt = Date.now();
    const rebalanceConsole: string[] = [];
    const criticalConsole: string[] = [];
    page.on('console', (msg) => {
      const text = msg.text();
      if (/AUTO-REBALANCE|Auto-rebalance|request_collateral|counterparty-not-hub|missing-hub-fee-policy/.test(text)) {
        rebalanceConsole.push(text);
      }
      if (/FRAME_CONSENSUS_FAILED|Frame hash verification failed|Runtime loop error|RUNTIME_LOOP_HALTED/.test(text)) {
        criticalConsole.push(text);
      }
    });

    await resetProdServer(page);
    await page.addInitScript(() => {
      try {
        localStorage.clear();
        localStorage.setItem('xln-app-mode', 'user');
        localStorage.setItem('xln-onboarding-complete', 'true');
      } catch {
        // no-op
      }
    });
    await gotoApp(page);
    await createRuntime(page, `rebalance-${Date.now()}`, randomMnemonic());
    await ensureRuntimeOnline(page, 'post-create');

    const { entityId, signerId } = await getLocalEntity(page);
    const hubId = await discoverHub(page);
    await waitForHubProfile(page, hubId);
    await connectHub(page, entityId, signerId, hubId);

    // 6x faucet => cross soft limit ($500) deterministically without adding
    // post-request debt that can make final collateral assertions flaky.
    for (let i = 0; i < 6; i++) {
      await faucet(page, entityId, hubId);
      await page.waitForTimeout(1300);
    }

    // Wait until bilateral j-event finalized and account becomes secured.
    const start = Date.now();
    let snapshot: any = null;
    const stateTimeline: any[] = [];
    while (Date.now() - start < 180_000) {
      snapshot = await readRebalanceState(page, hubId);
      if (snapshot) {
        stateTimeline.push({
          atMs: Date.now() - start,
          requested: snapshot.requested,
          uncollateralized: snapshot.uncollateralized,
          collateral: snapshot.collateral,
          hubDebt: snapshot.hubDebt,
          jHeight: snapshot.lastFinalizedJHeight,
          frame: snapshot.currentHeight,
        });
      }
      if (
        snapshot &&
        BigInt(snapshot.requested) === 0n &&
        BigInt(snapshot.uncollateralized) === 0n &&
        BigInt(snapshot.collateral) > 0n &&
        snapshot.lastFinalizedJHeight > 0
      ) {
        break;
      }
      await page.waitForTimeout(1500);
    }

    const diagnostics = await readRebalanceDiagnostics(page, hubId);
    const rebalanceSteps = await readRebalanceStepEvents(page, scenarioStartedAt);
    const debugDump = buildRebalanceFailureDump({
      entityId,
      hubId,
      snapshot,
      diagnostics,
      rebalanceSteps,
      stateTimeline,
      rebalanceConsole,
    });
    const userIdLower = entityId.toLowerCase();
    const hubIdLower = hubId.toLowerCase();
    const indexOfStep = (event: string, predicate?: (step: any) => boolean): number =>
      rebalanceSteps.findIndex((step) => step?.event === event && (!predicate || predicate(step)));

    expect(snapshot, 'account snapshot must exist').toBeTruthy();
    const step1Idx = indexOfStep('request_collateral_committed');
    const step2Idx = indexOfStep('batch_add', (s) => String(s.counterpartyId || '').toLowerCase() === userIdLower);
    const step3Idx = indexOfStep('j_broadcast_queued');
    const step4UserIdx = indexOfStep('j_event_claim_queued', (s) => String(s.entityId || '').toLowerCase() === userIdLower);
    const step4HubIdx = indexOfStep('j_event_claim_queued', (s) => String(s.entityId || '').toLowerCase() === hubIdLower);
    const step5Idx = indexOfStep('account_settled_finalized_bilateral');

    expect(step1Idx >= 0, `step1 missing: request_collateral_committed\n${debugDump}`).toBe(true);
    expect(step2Idx >= 0, `step2 missing: batch_add for user\n${debugDump}`).toBe(true);
    expect(step3Idx >= 0, `step3 missing: j_broadcast_queued\n${debugDump}`).toBe(true);
    expect(step4UserIdx >= 0, `step4 missing: user j_event_claim_queued\n${debugDump}`).toBe(true);
    expect(step4HubIdx >= 0, `step4 missing: hub j_event_claim_queued\n${debugDump}`).toBe(true);
    expect(step5Idx >= 0, `step5 missing: account_settled_finalized_bilateral\n${debugDump}`).toBe(true);
    expect(step2Idx > step1Idx, `invalid order: step2 must be after step1\n${debugDump}`).toBe(true);
    expect(step3Idx > step2Idx, `invalid order: step3 must be after step2\n${debugDump}`).toBe(true);
    expect(step4UserIdx > step3Idx || step4HubIdx > step3Idx, `invalid order: step4 must be after step3\n${debugDump}`).toBe(true);

    const blockedForUser = rebalanceSteps.filter((s) => {
      const event = String(s?.event || '');
      const cp = String(s?.counterpartyId || '').toLowerCase();
      return (
        cp === userIdLower &&
        (event === 'policy_mismatch_manual' ||
          event === 'prepaid_fee_too_low_manual' ||
          event === 'hub_reserve_zero')
      );
    });
    expect(blockedForUser.length, `unexpected step2 blocked state for user\n${debugDump}`).toBe(0);

    expect(BigInt(snapshot.requested), `request_collateral must be cleared\n${debugDump}`).toBe(0n);
    expect(BigInt(snapshot.uncollateralized), `uncollateralized debt must be zero\n${debugDump}`).toBe(0n);
    expect(BigInt(snapshot.collateral), `collateral must be positive\n${debugDump}`).toBeGreaterThan(0n);
    expect(BigInt(snapshot.hubDebt) <= BigInt(snapshot.collateral), `hubDebt must be fully collateralized\n${debugDump}`).toBe(true);
    expect(snapshot.lastFinalizedJHeight, `jHeight must finalize (>0)\n${debugDump}`).toBeGreaterThan(0);

    // UI assertion + final screenshot artifact
    const securedIndicator = page.locator('.rebalance-indicator.secured', { hasText: 'Secured' }).first();
    await expect(securedIndicator).toBeVisible({ timeout: 30_000 });

    const accountCard = page.locator('.account-preview').first();
    await expect(accountCard).toBeVisible();
    await accountCard.screenshot({ path: 'test-results/rebalance-green-final.png' });
    await page.screenshot({ path: 'test-results/rebalance-green-fullpage.png', fullPage: true });

    // Regression guard: faucet must keep working AFTER collateralized state.
    const debtBefore = BigInt(snapshot.hubDebt);
    const currentHeightBefore = Number(snapshot.currentHeight || 0);
    await faucet(page, entityId, hubId);
    let postSnapshot: any = null;
    const postStart = Date.now();
    while (Date.now() - postStart < 30_000) {
      postSnapshot = await readRebalanceState(page, hubId);
      if (postSnapshot && Number(postSnapshot.currentHeight || 0) > currentHeightBefore) break;
      await page.waitForTimeout(700);
    }
    expect(postSnapshot, `post-secured faucet snapshot missing\n${debugDump}`).toBeTruthy();
    expect(
      BigInt(postSnapshot.hubDebt) > debtBefore,
      `post-secured faucet did not increase hubDebt\n${buildRebalanceFailureDump({
        entityId,
        hubId,
        snapshot: postSnapshot,
        diagnostics,
        rebalanceSteps,
        stateTimeline: [...stateTimeline, { atMs: 'post-faucet', ...postSnapshot }],
        rebalanceConsole: [...rebalanceConsole, ...criticalConsole],
      })}`,
    ).toBe(true);
    expect(
      criticalConsole.length,
      `critical consensus/runtime errors after post-secured faucet:\n${criticalConsole.join('\n')}`,
    ).toBe(0);
  });
});
