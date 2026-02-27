import { test, expect, type Page } from '@playwright/test';
import { Wallet, ethers } from 'ethers';

/**
 * REBALANCE INVARIANT (do not "simplify" this in future edits):
 *
 * Auto request_collateral MUST trigger ONLY from deriveDelta(...).outPeerCredit > softLimit.
 * - outPeerCredit = currently used peer credit (actual risk surface).
 * - outCollateral = already posted collateral; it must NOT be added to trigger metric.
 *
 * Why:
 * Using (outCollateral + outPeerCredit) over-triggers after the first successful top-up
 * and causes a new request_collateral on almost every small payment/faucet click.
 */
const APP_BASE_URL = process.env.E2E_BASE_URL ?? 'https://localhost:8080';
const API_BASE_URL = process.env.E2E_API_BASE_URL ?? APP_BASE_URL;
const RESET_BASE_URL = process.env.E2E_RESET_BASE_URL ?? APP_BASE_URL;
const INIT_TIMEOUT = 30_000;
const FAST_E2E = process.env.E2E_FAST !== '0';
const LONG_E2E = process.env.E2E_LONG === '1';

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
  await page.waitForTimeout(500);

  // Dismiss onboarding if visible.
  const onboardingCheckbox = page.locator('text=I understand and accept the risks of using this software').first();
  if (await onboardingCheckbox.isVisible({ timeout: 1000 }).catch(() => false)) {
    await onboardingCheckbox.click();
    const continueBtn = page.locator('button:has-text("Continue")').first();
    if (await continueBtn.isVisible({ timeout: 1000 }).catch(() => false)) {
      await continueBtn.click();
      await page.waitForTimeout(300);
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
  await page.waitForFunction(() => {
    const env = (window as any).isolatedEnv;
    return !!env?.runtimeId && Number(env?.eReplicas?.size || 0) > 0;
  }, { timeout: 10_000 });
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
        const acc = findAccount(rep?.state?.accounts, entityId, hubId);
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
  await page.waitForTimeout(800);
}

async function connectHubWithCredit(
  page: Page,
  entityId: string,
  signerId: string,
  hubId: string,
  creditUsd: bigint,
) {
  const opened = await page.evaluate(async ({ entityId, signerId, hubId, creditUsd }) => {
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
    if (!env || !XLN) return false;

    XLN.enqueueRuntimeInput(env, {
      runtimeTxs: [],
      entityInputs: [{
        entityId,
        signerId,
        entityTxs: [{
          type: 'openAccount',
          data: { targetEntityId: hubId, creditAmount: BigInt(creditUsd) * 10n ** 18n, tokenId: 1 },
        }],
      }],
    });

    const start = Date.now();
    while (Date.now() - start < 45_000) {
      for (const [k, rep] of env.eReplicas.entries()) {
        if (!String(k).startsWith(entityId + ':')) continue;
        const acc = findAccount(rep?.state?.accounts, entityId, hubId);
        if (!acc) continue;
        const hasDelta = !!acc.deltas?.get?.(1);
        const noPending = !acc.pendingFrame;
        const hasFrames = Number(acc.currentHeight || 0) > 0;
        if (hasDelta && noPending && hasFrames) return true;
      }
      await new Promise((resolve) => setTimeout(resolve, 750));
    }
    return false;
  }, { entityId, signerId, hubId, creditUsd: creditUsd.toString() });

  expect(opened, `openAccount(${creditUsd} USD) -> bilateral account ready`).toBe(true);
  await page.waitForTimeout(800);
}

async function switchRuntime(page: Page, label: string) {
  const result = await page.evaluate(async (label) => {
    try {
      const runtimesState = (window as any).runtimesState;
      const vaultOperations = (window as any).vaultOperations;
      if (!runtimesState || !vaultOperations) {
        return { ok: false, error: 'window.runtimesState/window.vaultOperations missing' };
      }
      let state: any;
      const unsub = runtimesState.subscribe((s: any) => { state = s; });
      unsub();
      for (const [id, runtime] of Object.entries(state.runtimes) as any[]) {
        if (String(runtime?.label || '').toLowerCase() !== String(label).toLowerCase()) continue;
        await vaultOperations.selectRuntime(id);
        return { ok: true, runtimeId: String(id) };
      }
      return { ok: false, error: `Runtime ${label} not found` };
    } catch (e: any) {
      return { ok: false, error: e?.message || String(e) };
    }
  }, label);
  expect(result.ok, `switchRuntime(${label}) failed: ${result.error || 'unknown'}`).toBe(true);
  await ensureRuntimeOnline(page, `switch-${label}`);
}

async function discoverHubsByName(
  page: Page,
  requiredNames: string[],
): Promise<Record<string, string>> {
  for (let i = 0; i < 80; i++) {
    const hubs = await page.evaluate(() => {
      const env = (window as any).isolatedEnv;
      const XLN = (window as any).XLN;
      XLN?.refreshGossip?.(env);
      const profiles = env?.gossip?.getProfiles?.() || [];
      return profiles
        .filter((p: any) => p?.metadata?.isHub === true || (Array.isArray(p?.capabilities) && p.capabilities.includes('hub')))
        .map((p: any) => ({
          entityId: String(p?.entityId || ''),
          name: String(p?.metadata?.name || ''),
        }))
        .filter((h: any) => !!h.entityId);
    });
    const hubByName = new Map<string, string>();
    for (const hub of hubs) hubByName.set(String(hub.name || '').toLowerCase(), hub.entityId);
    const out: Record<string, string> = {};
    let ready = true;
    for (const requiredName of requiredNames) {
      const key = String(requiredName || '').toLowerCase();
      const entityId = hubByName.get(key);
      if (!entityId) {
        ready = false;
        break;
      }
      out[key] = entityId;
    }
    if (ready) return out;
    await page.waitForTimeout(1000);
  }
  throw new Error(`Required hubs not discovered in gossip: ${requiredNames.join(', ')}`);
}

async function discoverNamedHubs(page: Page): Promise<{ h1: string; h3: string }> {
  const hubs = await discoverHubsByName(page, ['h1', 'h3']);
  return { h1: hubs.h1, h3: hubs.h3 };
}

async function discoverH1H2(page: Page): Promise<{ h1: string; h2: string }> {
  const hubs = await discoverHubsByName(page, ['h1', 'h2']);
  return { h1: hubs.h1, h2: hubs.h2 };
}

async function setRebalancePolicy(
  page: Page,
  entityId: string,
  signerId: string,
  hubId: string,
  softUsd: bigint = 500n,
  hardUsd: bigint = 10_000n,
  maxFeeUsd: bigint = 20n,
) {
  const result = await page.evaluate(
    async ({ entityId, signerId, hubId, softUsd, hardUsd, maxFeeUsd }) => {
      try {
        const env = (window as any).isolatedEnv;
        const XLN = (window as any).XLN;
        if (!env || !XLN?.enqueueRuntimeInput) {
          return { ok: false, error: 'isolatedEnv/XLN missing' };
        }
        XLN.enqueueRuntimeInput(env, {
          runtimeTxs: [],
          entityInputs: [{
            entityId,
            signerId,
            entityTxs: [{
              type: 'setRebalancePolicy',
              data: {
                counterpartyEntityId: hubId,
                tokenId: 1,
                softLimit: BigInt(softUsd) * 10n ** 18n,
                hardLimit: BigInt(hardUsd) * 10n ** 18n,
                maxAcceptableFee: BigInt(maxFeeUsd) * 10n ** 18n,
              },
            }],
          }],
        });
        return { ok: true };
      } catch (error: any) {
        return { ok: false, error: error?.message || String(error) };
      }
    },
    {
      entityId,
      signerId,
      hubId,
      softUsd: softUsd.toString(),
      hardUsd: hardUsd.toString(),
      maxFeeUsd: maxFeeUsd.toString(),
    },
  );
  expect(result.ok, `setRebalancePolicy failed: ${result.error || 'unknown'}`).toBe(true);
  await page.waitForTimeout(600);
}

async function faucet(page: Page, userEntityId: string, hubEntityId: string) {
  const runtimeId = await page.evaluate(() => (window as any).isolatedEnv?.runtimeId || null);
  expect(runtimeId, 'runtimeId must exist before faucet').toBeTruthy();
  const deadline = Date.now() + 20_000;
  let lastBody: any = null;
  let lastStatus = 0;
  while (Date.now() < deadline) {
    const resp = await page.request.post(`${API_BASE_URL}/api/faucet/offchain`, {
      data: { userEntityId, userRuntimeId: runtimeId, hubEntityId, tokenId: 1, amount: '100' },
    });
    const body = await resp.json().catch(() => ({}));
    if (resp.ok()) return;
    lastBody = body;
    lastStatus = resp.status();
    const code = String(body?.code || '');
    if (code !== 'FAUCET_ACCOUNT_PENDING_FRAME' && code !== 'FAUCET_CLIENT_PENDING_FRAME') {
      break;
    }
    await page.waitForTimeout(300);
  }
  expect(false, `faucet failed: status=${lastStatus} body=${JSON.stringify(lastBody)}`).toBe(true);
}

async function faucetAmount(page: Page, userEntityId: string, hubEntityId: string, amountUsd: string) {
  const runtimeId = await page.evaluate(() => (window as any).isolatedEnv?.runtimeId || null);
  expect(runtimeId, 'runtimeId must exist before faucetAmount').toBeTruthy();
  const deadline = Date.now() + 20_000;
  let lastBody: any = null;
  let lastStatus = 0;
  while (Date.now() < deadline) {
    const resp = await page.request.post(`${API_BASE_URL}/api/faucet/offchain`, {
      data: { userEntityId, userRuntimeId: runtimeId, hubEntityId, tokenId: 1, amount: amountUsd },
    });
    const body = await resp.json().catch(() => ({}));
    if (resp.ok()) return;
    lastBody = body;
    lastStatus = resp.status();
    const code = String(body?.code || '');
    if (code !== 'FAUCET_ACCOUNT_PENDING_FRAME' && code !== 'FAUCET_CLIENT_PENDING_FRAME') {
      break;
    }
    await page.waitForTimeout(300);
  }
  expect(false, `faucetAmount failed: status=${lastStatus} body=${JSON.stringify(lastBody)}`).toBe(true);
}

async function sendRoutedHtlcPayment(
  page: Page,
  fromEntityId: string,
  fromSignerId: string,
  targetEntityId: string,
  route: string[],
  amountUsd: bigint,
  description: string,
): Promise<{ secret: string; hashlock: string }> {
  const { secret, hashlock } = generateHtlcPayload();
  const res = await page.evaluate(
    async ({ fromEntityId, fromSignerId, targetEntityId, route, amountUsd, description, secret, hashlock }) => {
      try {
        const env = (window as any).isolatedEnv;
        const XLN = (window as any).XLN;
        if (!env || !XLN?.enqueueRuntimeInput) {
          return { ok: false, error: 'isolatedEnv/XLN missing' };
        }
        XLN.enqueueRuntimeInput(env, {
          runtimeTxs: [],
          entityInputs: [{
            entityId: fromEntityId,
            signerId: fromSignerId,
            entityTxs: [{
              type: 'htlcPayment',
              data: {
                targetEntityId,
                tokenId: 1,
                amount: BigInt(amountUsd) * 10n ** 18n,
                route,
                description,
                secret,
                hashlock,
              },
            }],
          }],
        });
        return { ok: true };
      } catch (error: any) {
        return { ok: false, error: error?.message || String(error) };
      }
    },
    {
      fromEntityId,
      fromSignerId,
      targetEntityId,
      route,
      amountUsd: amountUsd.toString(),
      description,
      secret,
      hashlock,
    },
  );
  expect(res.ok, `sendRoutedHtlcPayment failed: ${res.error || 'unknown'}`).toBe(true);
  return { secret, hashlock };
}

async function readPairState(page: Page, counterpartyId: string) {
  return page.evaluate(({ counterpartyId }) => {
    const env = (window as any).isolatedEnv;
    if (!env?.eReplicas) return null;
    const runtimeSigner = String(env.runtimeId || '').toLowerCase();
    for (const [key, rep] of env.eReplicas.entries()) {
      const parts = String(key || '').split(':');
      const signerId = String(parts[1] || '').toLowerCase();
      if (runtimeSigner && signerId && signerId !== runtimeSigner) continue;
      const acc = rep.state?.accounts?.get(counterpartyId);
      if (!acc) continue;
      const delta = acc.deltas?.get?.(1);
      if (!delta) continue;
      const XLN = (window as any).XLN;
      const isLeft = String(rep.entityId || '').toLowerCase() < String(counterpartyId).toLowerCase();
      const derived = typeof XLN?.deriveDelta === 'function' ? XLN.deriveDelta(delta, isLeft) : null;
      const hubDebt = BigInt(derived?.inOwnCredit ?? 0n);
      const collateral = BigInt(derived?.outCollateral ?? 0n);
      const uncollateralized = hubDebt > collateral ? hubDebt - collateral : 0n;
      const requested = acc.requestedRebalance?.get?.(1) || 0n;
      const history = Array.isArray(acc.frameHistory) ? acc.frameHistory : [];
      const recentDirectPaymentDescriptions = history
        .slice(-40)
        .flatMap((frame: any) => (Array.isArray(frame?.accountTxs) ? frame.accountTxs : []))
        .filter((tx: any) => tx?.type === 'direct_payment')
        .map((tx: any) => String(tx?.data?.description || ''));
      const recentHtlcHashlocks = history
        .slice(-80)
        .flatMap((frame: any) => (Array.isArray(frame?.accountTxs) ? frame.accountTxs : []))
        .filter((tx: any) => tx?.type === 'htlc_lock' || tx?.type === 'htlc_resolve')
        .map((tx: any) => String(tx?.data?.hashlock || ''))
        .filter((hash: string) => hash.startsWith('0x') && hash.length > 10);
      const recentHtlcResolveCount = history
        .slice(-80)
        .flatMap((frame: any) => (Array.isArray(frame?.accountTxs) ? frame.accountTxs : []))
        .filter((tx: any) => tx?.type === 'htlc_resolve')
        .length;
      const recentHtlcLockCount = history
        .slice(-80)
        .flatMap((frame: any) => (Array.isArray(frame?.accountTxs) ? frame.accountTxs : []))
        .filter((tx: any) => tx?.type === 'htlc_lock')
        .length;
      return {
        currentHeight: Number(acc.currentHeight || 0),
        requested: requested.toString(),
        hubExposure: hubDebt.toString(),
        hubDebt: hubDebt.toString(),
        totalDelta: String(derived?.delta ?? 0n),
        inCollateral: String(derived?.inCollateral ?? 0n),
        outCollateral: String(derived?.outCollateral ?? 0n),
        inCapacity: String(derived?.inCapacity ?? 0n),
        outCapacity: String(derived?.outCapacity ?? 0n),
        collateral: collateral.toString(),
        uncollateralized: uncollateralized.toString(),
        lastFinalizedJHeight: Number(acc.lastFinalizedJHeight || 0),
        recentDirectPaymentDescriptions,
        recentHtlcHashlocks,
        recentHtlcResolveCount,
        recentHtlcLockCount,
      };
    }
    return null;
  }, { counterpartyId });
}

async function sendDirectPaymentToHub(
  page: Page,
  entityId: string,
  signerId: string,
  hubId: string,
  amountUsd: bigint,
) {
  const res = await page.evaluate(
    async ({ entityId, signerId, hubId, amountUsd }) => {
      try {
        const env = (window as any).isolatedEnv;
        const XLN = (window as any).XLN;
        if (!env || !XLN?.enqueueRuntimeInput) {
          return { ok: false, error: 'isolatedEnv/XLN missing' };
        }
        XLN.enqueueRuntimeInput(env, {
          runtimeTxs: [],
          entityInputs: [{
            entityId,
            signerId,
            entityTxs: [{
              type: 'directPayment',
              data: {
                targetEntityId: hubId,
                tokenId: 1,
                amount: BigInt(amountUsd) * 10n ** 18n,
                route: [entityId, hubId],
                description: 'e2e-c2r-drain',
              },
            }],
          }],
        });
        return { ok: true };
      } catch (error: any) {
        return { ok: false, error: error?.message || String(error) };
      }
    },
    { entityId, signerId, hubId, amountUsd: amountUsd.toString() },
  );
  expect(res.ok, `directPayment enqueue failed: ${res.error || 'unknown'}`).toBe(true);
}

function generateHtlcPayload(): { secret: string; hashlock: string } {
  const secret = ethers.hexlify(ethers.randomBytes(32));
  const hashlock = ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(['bytes32'], [secret]),
  );
  return { secret, hashlock };
}

async function sendHtlcPaymentToHub(
  page: Page,
  entityId: string,
  signerId: string,
  hubId: string,
  amountUsd: bigint,
): Promise<{ secret: string; hashlock: string }> {
  const { secret, hashlock } = generateHtlcPayload();
  const res = await page.evaluate(
    async ({ entityId, signerId, hubId, amountUsd, secret, hashlock }) => {
      try {
        const env = (window as any).isolatedEnv;
        const XLN = (window as any).XLN;
        if (!env || !XLN?.enqueueRuntimeInput) {
          return { ok: false, error: 'isolatedEnv/XLN missing' };
        }
        XLN.enqueueRuntimeInput(env, {
          runtimeTxs: [],
          entityInputs: [{
            entityId,
            signerId,
            entityTxs: [{
              type: 'htlcPayment',
              data: {
                targetEntityId: hubId,
                tokenId: 1,
                amount: BigInt(amountUsd) * 10n ** 18n,
                route: [entityId, hubId],
                description: 'e2e-htlc-before-rebalance',
                secret,
                hashlock,
              },
            }],
          }],
        });
        return { ok: true };
      } catch (error: any) {
        return { ok: false, error: error?.message || String(error) };
      }
    },
    { entityId, signerId, hubId, amountUsd: amountUsd.toString(), secret, hashlock },
  );
  expect(res.ok, `htlcPayment enqueue failed: ${res.error || 'unknown'}`).toBe(true);
  return { secret, hashlock };
}

async function readAccountFlowState(page: Page, hubId: string) {
  return page.evaluate(({ hubId }) => {
    const env = (window as any).isolatedEnv;
    if (!env?.eReplicas) return null;
    const runtimeSigner = String(env.runtimeId || '').toLowerCase();
    for (const [key, rep] of env.eReplicas.entries()) {
      const parts = String(key || '').split(':');
      const signerId = String(parts[1] || '').toLowerCase();
      if (runtimeSigner && signerId && signerId !== runtimeSigner) continue;
      const acc = rep.state?.accounts?.get(hubId);
      if (!acc) continue;
      const history = Array.isArray(acc.frameHistory) ? acc.frameHistory : [];
      const recentTxTypes = history
        .slice(-20)
        .flatMap((frame: any) => (Array.isArray(frame?.accountTxs) ? frame.accountTxs : []))
        .map((tx: any) => String(tx?.type || ''));
      const recentHtlcHashlocks = history
        .slice(-80)
        .flatMap((frame: any) => (Array.isArray(frame?.accountTxs) ? frame.accountTxs : []))
        .filter((tx: any) => tx?.type === 'htlc_lock' || tx?.type === 'htlc_resolve')
        .map((tx: any) => String(tx?.data?.hashlock || ''))
        .filter((hash: string) => hash.startsWith('0x') && hash.length > 10);
      let accountLockCount = 0;
      if (rep.state?.lockBook && typeof rep.state.lockBook.values === 'function') {
        for (const lock of rep.state.lockBook.values()) {
          if (String(lock?.accountId || '').toLowerCase() === String(hubId || '').toLowerCase()) {
            accountLockCount += 1;
          }
        }
      }
      return {
        currentHeight: Number(acc.currentHeight || 0),
        recentTxTypes,
        recentHtlcHashlocks,
        accountLockCount,
      };
    }
    return null;
  }, { hubId });
}

async function readAccountJEventClaims(page: Page, hubId: string) {
  return page.evaluate(({ hubId }) => {
    const env = (window as any).isolatedEnv;
    if (!env?.eReplicas) return null;
    const target = String(hubId || '').toLowerCase();
    const runtimeSigner = String(env.runtimeId || '').toLowerCase();
    for (const [key, rep] of env.eReplicas.entries()) {
      const parts = String(key || '').split(':');
      const signerId = String(parts[1] || '').toLowerCase();
      if (runtimeSigner && signerId && signerId !== runtimeSigner) continue;
      const acc = rep.state?.accounts?.get(hubId);
      if (!acc) continue;
      const history = Array.isArray(acc.frameHistory) ? acc.frameHistory : [];
      const claims: Array<{
        frameHeight: number;
        jHeight: number;
        txHash: string;
        nonce: string;
        leftEntity: string;
        rightEntity: string;
        tokenId: number;
        collateral: string;
        ondelta: string;
      }> = [];
      for (const frame of history.slice(-200)) {
        const txs = Array.isArray(frame?.accountTxs) ? frame.accountTxs : [];
        for (const tx of txs) {
          if (tx?.type !== 'j_event_claim') continue;
          const payload = tx?.data || {};
          const events = Array.isArray(payload?.events) ? payload.events : [];
          for (const event of events) {
            if (String(event?.type || '') !== 'AccountSettled') continue;
            const data = event?.data || {};
            claims.push({
              frameHeight: Number(frame?.height || 0),
              jHeight: Number(payload?.jHeight || 0),
              txHash: String(event?.transactionHash || ''),
              nonce: String(data?.nonce ?? ''),
              leftEntity: String(data?.leftEntity || '').toLowerCase(),
              rightEntity: String(data?.rightEntity || '').toLowerCase(),
              tokenId: Number(data?.tokenId || 0),
              collateral: String(data?.collateral ?? '0'),
              ondelta: String(data?.ondelta ?? '0'),
            });
          }
        }
      }
      return {
        accountEntityId: String(rep.entityId || '').toLowerCase(),
        counterpartyId: target,
        claims,
      };
    }
    return null;
  }, { hubId });
}

async function readRebalanceState(page: Page, hubId: string) {
  return page.evaluate(({ hubId }) => {
    const env = (window as any).isolatedEnv;
    if (!env?.eReplicas) return null;
    const runtimeSigner = String(env.runtimeId || '').toLowerCase();
    for (const [key, rep] of env.eReplicas.entries()) {
      const parts = String(key || '').split(':');
      const signerId = String(parts[1] || '').toLowerCase();
      if (runtimeSigner && signerId && signerId !== runtimeSigner) continue;
      const acc = rep.state?.accounts?.get(hubId);
      if (!acc) continue;
      const delta = acc.deltas?.get?.(1);
      if (!delta) continue;
      const XLN = (window as any).XLN;
      const isLeft = String(rep.entityId || '').toLowerCase() < String(hubId).toLowerCase();
      const derived = typeof XLN?.deriveDelta === 'function' ? XLN.deriveDelta(delta, isLeft) : null;
      const hubDebt = BigInt(derived?.inOwnCredit ?? 0n);
      const collateral = BigInt(derived?.outCollateral ?? 0n);
      const uncollateralized = hubDebt > collateral ? hubDebt - collateral : 0n;
      const requested = acc.requestedRebalance?.get?.(1) || 0n;
      const policy = acc.rebalancePolicy?.get?.(1) || null;
      return {
        entityId: String(rep.entityId || ''),
        requested: requested.toString(),
        collateral: collateral.toString(),
        ondelta: String(delta.ondelta || 0n),
        offdelta: String(delta.offdelta || 0n),
        hubExposure: hubDebt.toString(),
        hubDebt: hubDebt.toString(),
        totalDelta: String(derived?.delta ?? 0n),
        inCollateral: String(derived?.inCollateral ?? 0n),
        outCollateral: String(derived?.outCollateral ?? 0n),
        inCapacity: String(derived?.inCapacity ?? 0n),
        outCapacity: String(derived?.outCapacity ?? 0n),
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
    const runtimeSigner = String(env.runtimeId || '').toLowerCase();
    for (const [key, rep] of env.eReplicas.entries()) {
      const parts = String(key || '').split(':');
      const signerId = String(parts[1] || '').toLowerCase();
      if (runtimeSigner && signerId && signerId !== runtimeSigner) continue;
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
  const response = await page.request.get(`${API_BASE_URL}/api/debug/events?last=20000&since=${sinceTs}`);
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
  const stringifySafe = (value: unknown) =>
    JSON.stringify(
      value,
      (_key, v) => (typeof v === 'bigint' ? v.toString() : v),
      2,
    );
  const stepCounts = input.rebalanceSteps.reduce((acc: Record<string, number>, step: any) => {
    const key = String(step?.event || 'unknown');
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
  return stringifySafe(
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
    await page.waitForTimeout(500);
  }
  throw new Error('Server did not become healthy in time after reset');
}

async function resetProdServer(page: Page) {
  let resetDone = false;
  let lastError = '';
  for (let attempt = 1; attempt <= 10; attempt++) {
    try {
      const coldResponse = await page.request.post(`${RESET_BASE_URL}/reset?rpc=1&db=1&sync=1`);
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
    await page.waitForTimeout(300);
  }
  expect(resetDone, `reset failed after retries: ${lastError}`).toBe(true);
  await waitForServerHealthy(page);
}

test.describe('Rebalance E2E', () => {
  // Rebalance involves async j-event bilateral finalization and can exceed 60s on local runs.
  test.setTimeout(LONG_E2E ? 300_000 : 180_000);

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
    const hubIsLeft = hubId.toLowerCase() < entityId.toLowerCase();
    await waitForHubProfile(page, hubId);
    await connectHub(page, entityId, signerId, hubId);

    // 6x faucet => cross soft limit ($500) deterministically without adding
    // post-request debt that can make final collateral assertions flaky.
    for (let i = 0; i < 6; i++) {
      await faucet(page, entityId, hubId);
      await page.waitForTimeout(300);
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
      await page.waitForTimeout(700);
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
    const step4UserIdx = indexOfStep('j_event_claim_queued', (s) => String(s.entityId || '').toLowerCase() === userIdLower);
    const step4HubIdx = indexOfStep('j_event_claim_queued', (s) => String(s.entityId || '').toLowerCase() === hubIdLower); // optional on local runtime
    const step5Idx = indexOfStep('account_settled_finalized_bilateral');

    expect(step1Idx >= 0, `step1 missing: request_collateral_committed\n${debugDump}`).toBe(true);
    expect(step4UserIdx >= 0, `step4 missing: user j_event_claim_queued\n${debugDump}`).toBe(true);
    // Hub-side claim is observed only when that runtime's debug stream is available locally.
    // Keep as diagnostic, but do not fail on absence.
    expect(step5Idx >= 0, `step5 missing: account_settled_finalized_bilateral\n${debugDump}`).toBe(true);
    expect(step4UserIdx > step1Idx, `invalid order: user claim must be after request commit\n${debugDump}`).toBe(true);
    expect(step5Idx > step4UserIdx, `invalid order: finalize must be after user claim\n${debugDump}`).toBe(true);

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

    if (FAST_E2E && !LONG_E2E) {
      console.log('[E2E] FAST mode: first secured cycle verified, skipping long stress phases.');
      return;
    }

    // Regression guard + stronger invariant:
    // after first successful collateralization, faucet must still work and must
    // be able to trigger a second independent collateralization cycle.
    const claimSnapshotBeforeSecondCycle = await readAccountJEventClaims(page, hubId);
    const uniqueSettleKeysBefore = new Set(
      (claimSnapshotBeforeSecondCycle?.claims || []).map((c) => `${c.txHash}:${c.nonce}:${c.jHeight}`),
    );
    const currentHeightBefore = Number(snapshot.currentHeight || 0);

    // Push debt enough to cross soft-limit again after first finalize.
    for (let i = 0; i < 8; i++) {
      await faucet(page, entityId, hubId);
      await page.waitForTimeout(150);
    }

    let postSnapshot: any = null;
    const postStart = Date.now();
    while (Date.now() - postStart < 120_000) {
      postSnapshot = await readRebalanceState(page, hubId);
      const claimSnapshotNow = await readAccountJEventClaims(page, hubId);
      const uniqueSettleKeysNow = new Set(
        (claimSnapshotNow?.claims || []).map((c) => `${c.txHash}:${c.nonce}:${c.jHeight}`),
      );
      const hasSecondSettlement = uniqueSettleKeysNow.size >= uniqueSettleKeysBefore.size + 1;
      if (
        postSnapshot &&
        Number(postSnapshot.currentHeight || 0) > currentHeightBefore &&
        BigInt(postSnapshot.requested || '0') === 0n &&
        BigInt(postSnapshot.uncollateralized || '0') === 0n &&
        hasSecondSettlement
      ) {
        break;
      }
      await page.waitForTimeout(400);
    }
    expect(postSnapshot, `post-secured faucet snapshot missing\n${debugDump}`).toBeTruthy();
    expect(
      Number(postSnapshot.currentHeight || 0) > currentHeightBefore,
      `post-secured faucet did not advance account consensus height\n${buildRebalanceFailureDump({
        entityId,
        hubId,
        snapshot: postSnapshot,
        diagnostics,
        rebalanceSteps,
        stateTimeline: [...stateTimeline, { atMs: 'post-faucet-2nd-cycle', ...postSnapshot }],
        rebalanceConsole: [...rebalanceConsole, ...criticalConsole],
      })}`,
    ).toBe(true);
    expect(
      criticalConsole.length,
      `critical consensus/runtime errors after post-secured faucet:\n${criticalConsole.join('\n')}`,
    ).toBe(0);

    // Strong invariant: each on-chain AccountSettled tx should appear as exactly 2 bilateral j_event_claims.
    // Multiple faucet clicks may coalesce into a single settlement while one request is pending.
    const claimSnapshot = await readAccountJEventClaims(page, hubId);
    expect(claimSnapshot, 'claim snapshot must exist').toBeTruthy();
    const claimCounts = new Map<string, number>();
    for (const c of claimSnapshot?.claims || []) {
      const key = `${c.txHash}:${c.nonce}:${c.jHeight}`;
      claimCounts.set(key, (claimCounts.get(key) || 0) + 1);
      const hasLocal = c.leftEntity === userIdLower || c.rightEntity === userIdLower;
      const hasHub = c.leftEntity === hubIdLower || c.rightEntity === hubIdLower;
      expect(hasLocal && hasHub, `misattributed AccountSettled claim pair: ${JSON.stringify(c)}`).toBe(true);
    }
    expect(claimCounts.size >= 1, 'must have at least one AccountSettled tx').toBe(true);
    expect(
      [...claimCounts.values()].every((n) => n === 2),
      `each AccountSettled must be claimed exactly twice (bilateral): ${JSON.stringify(Object.fromEntries(claimCounts), null, 2)}`,
    ).toBe(true);
  });

  test('edge: pending request_collateral must not duplicate before first settlement finalize', async ({ page }) => {
    test.skip(FAST_E2E && !LONG_E2E, 'Long rebalance edge coverage disabled in fast mode.');
    const scenarioStartedAt = Date.now();
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
    await createRuntime(page, `rebalance-edge-pending-${Date.now()}`, randomMnemonic());
    await ensureRuntimeOnline(page, 'edge-pending-post-create');

    const { entityId, signerId } = await getLocalEntity(page);
    const hubId = await discoverHub(page);
    const hubIsLeft = hubId.toLowerCase() < entityId.toLowerCase();
    await waitForHubProfile(page, hubId);
    await connectHub(page, entityId, signerId, hubId);

    // Trigger first request.
    for (let i = 0; i < 6; i++) {
      await faucet(page, entityId, hubId);
      await page.waitForTimeout(120);
    }
    const firstPendingStart = Date.now();
    let pendingSeen = false;
    while (Date.now() - firstPendingStart < 45_000) {
      const s = await readRebalanceState(page, hubId);
      if (s && BigInt(s.requested || '0') > 0n) {
        pendingSeen = true;
        break;
      }
      await page.waitForTimeout(300);
    }
    expect(pendingSeen, 'expected pending requestedRebalance > 0').toBe(true);

    // While pending, add more debt; this must NOT create a second request commit before first finalize.
    for (let i = 0; i < 3; i++) {
      await faucet(page, entityId, hubId);
      await page.waitForTimeout(100);
    }
    await page.waitForTimeout(1500);

    const steps = await readRebalanceStepEvents(page, scenarioStartedAt);
    const lowerHub = hubId.toLowerCase();
    const firstFinalizeIdx = steps.findIndex((s) =>
      String(s?.event || '') === 'account_settled_finalized_bilateral'
      && String(s?.accountId || '').toLowerCase() === lowerHub,
    );
    const beforeFirstFinalize = firstFinalizeIdx >= 0 ? steps.slice(0, firstFinalizeIdx + 1) : steps;
    const reqCommits = beforeFirstFinalize.filter((s) =>
      String(s?.event || '') === 'request_collateral_committed'
      && String(s?.accountId || '').toLowerCase() === lowerHub,
    );
    const reqUnique = new Set(
      reqCommits.map((s) => `${String(s?.accountId || '').toLowerCase()}:${String(s?.tokenId || '')}:${String(s?.requestedAt || '')}`),
    );
    expect(
      reqUnique.size,
      `request_collateral unique-commit duplicated before first finalize: ${JSON.stringify(reqCommits, null, 2)}`,
    ).toBe(1);
  });

  test('cycle R2C -> C2R -> R2C (100ms action cadence)', async ({ page }) => {
    test.skip(FAST_E2E && !LONG_E2E, 'Long rebalance edge coverage disabled in fast mode.');
    const scenarioStartedAt = Date.now();
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
    await createRuntime(page, `rebalance-cycle-${Date.now()}`, randomMnemonic());
    await ensureRuntimeOnline(page, 'cycle-post-create');

    const { entityId, signerId } = await getLocalEntity(page);
    const hubId = await discoverHub(page);
    const hubIsLeft = hubId.toLowerCase() < entityId.toLowerCase();
    await waitForHubProfile(page, hubId);
    await connectHub(page, entityId, signerId, hubId);

    // Keep cycle test focused on rebalance transitions only.
    // HTLC E2E is validated by dedicated routed-payment coverage below.
    const baselineFlow = await readAccountFlowState(page, hubId);
    expect(baselineFlow, 'baseline account flow state must exist').toBeTruthy();

    const waitForState = async (
      predicate: (snapshot: any) => boolean,
      timeoutMs: number,
      label: string,
    ) => {
      const start = Date.now();
      let last: any = null;
      while (Date.now() - start < timeoutMs) {
        last = await readRebalanceState(page, hubId);
        if (last && predicate(last)) return last;
        await page.waitForTimeout(700);
      }
      throw new Error(`${label} timeout; last=${JSON.stringify(last, null, 2)}`);
    };

    // Phase 1: R2C (hub owes user, user auto-requests collateral)
    for (let i = 0; i < 10; i++) {
      await faucet(page, entityId, hubId);
      await page.waitForTimeout(100);
    }
    const r2cSnapshot1 = await waitForState(
      (s) =>
        BigInt(s.requested) === 0n &&
        BigInt(s.collateral) > 500n * 10n ** 18n &&
        Number(s.lastFinalizedJHeight || 0) > 0,
      180_000,
      'phase1-r2c',
    );
    const collateralAfterFirstR2C = BigInt(r2cSnapshot1.collateral);

    // Phase 2: C2R (user repays enough so collateral becomes excess and hub withdraws to reserve)
    const hubOwesUser = (snapshot: any): bigint => {
      const d = BigInt(snapshot?.totalDelta || '0');
      return hubIsLeft ? (d < 0n ? -d : 0n) : (d > 0n ? d : 0n);
    };
    const c2rDebtTarget = 1n * 10n ** 18n; // ~1 USD residual tolerance
    for (let i = 0; i < 25; i++) {
      const before = await readRebalanceState(page, hubId);
      const debtWei = before ? hubOwesUser(before) : 0n;
      if (debtWei <= c2rDebtTarget) break;
      const paymentUsd = debtWei / 10n ** 18n;
      const payAmount = paymentUsd > 0n && paymentUsd < 100n ? paymentUsd : 100n;
      await sendDirectPaymentToHub(page, entityId, signerId, hubId, payAmount);
      await page.waitForTimeout(100);
      if (before) {
        await waitForState(
          (s) => Number(s.currentHeight || 0) > Number(before.currentHeight || 0),
          25_000,
          `phase2-payment-commit-${i + 1}`,
        );
      }
      const after = await readRebalanceState(page, hubId);
      if (after && hubOwesUser(after) <= c2rDebtTarget) {
        break;
      }
    }

    const c2rSnapshot = await waitForState(
      (s) =>
        BigInt(s.requested) === 0n &&
        BigInt(s.collateral) < collateralAfterFirstR2C,
      220_000,
      'phase2-c2r',
    );
    const collateralAfterC2R = BigInt(c2rSnapshot.collateral);
    expect(
      collateralAfterC2R < collateralAfterFirstR2C,
      `expected C2R to decrease collateral (${collateralAfterFirstR2C} -> ${collateralAfterC2R})`,
    ).toBe(true);

    // Phase 3: R2C again (hub owes user again and tops collateral back up)
    for (let i = 0; i < 24; i++) {
      await faucet(page, entityId, hubId);
      await page.waitForTimeout(100);
    }
    const r2cSnapshot2 = await waitForState(
      (s) =>
        BigInt(s.requested) === 0n &&
        BigInt(s.collateral) > collateralAfterC2R,
      180_000,
      'phase3-r2c-again',
    );

    const steps = await readRebalanceStepEvents(page, scenarioStartedAt);
    const c2rPropose = steps.some((s) => s?.event === 'c2r_settle_propose_queued');
    const c2rExecute = steps.some((s) => s?.event === 'c2r_settle_execute_queued');
    const finalizedCount = steps.filter((s) => s?.event === 'account_settled_finalized_bilateral').length;
    expect(
      c2rPropose || c2rExecute || collateralAfterC2R < collateralAfterFirstR2C,
      `c2r evidence missing (events + collateral delta)`,
    ).toBe(true);
    expect(finalizedCount >= 2, `expected >=2 account_settled_finalized_bilateral, got ${finalizedCount}`).toBe(true);

    await page.screenshot({ path: 'test-results/rebalance-cycle-r2c-c2r-r2c.png', fullPage: true });

    expect(BigInt(r2cSnapshot2.collateral) > collateralAfterC2R, 'second R2C should increase collateral').toBe(true);
  });

  test('rt1->h1->h2->rt2: second 550 fails before rebalance, passes after H2 R2C', async ({ page }) => {
    test.skip(FAST_E2E && !LONG_E2E, 'Long rebalance edge coverage disabled in fast mode.');
    const scenarioStartedAt = Date.now();
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

    const rt1Label = `rt1-h1h2-${Date.now()}`;
    const rt2Label = `rt2-h1h2-${Date.now() + 1}`;
    await createRuntime(page, rt1Label, randomMnemonic());
    await ensureRuntimeOnline(page, 'rt1-h1h2-online');
    const rt1 = await getLocalEntity(page);

    await createRuntime(page, rt2Label, randomMnemonic());
    await ensureRuntimeOnline(page, 'rt2-h1h2-online');
    const rt2 = await getLocalEntity(page);

    await switchRuntime(page, rt2Label);
    const { h1, h2 } = await discoverH1H2(page);
    await waitForHubProfile(page, h1);
    await waitForHubProfile(page, h2);

    // Recipient runtime: small credit on H2 so second 550 should fail pre-rebalance.
    await connectHubWithCredit(page, rt2.entityId, rt2.signerId, h2, 1_000n);
    await setRebalancePolicy(page, rt2.entityId, rt2.signerId, h2, 500n, 10_000n, 20n);

    await switchRuntime(page, rt1Label);
    // Sender runtime: liquidity source through H1.
    await connectHubWithCredit(page, rt1.entityId, rt1.signerId, h1, 10_000n);
    await faucetAmount(page, rt1.entityId, h1, '2000');
    await page.waitForTimeout(600);

    await switchRuntime(page, rt2Label);
    const baseline = await readPairState(page, h2);
    expect(baseline, 'rt2-h2 baseline must exist').toBeTruthy();
    const baselineDebt = BigInt(baseline?.hubExposure || baseline?.hubDebt || '0');
    const baselineResolveCount = Number(baseline?.recentHtlcResolveCount || 0);

    // Payment #1 succeeds.
    await switchRuntime(page, rt1Label);
    const p1 = await sendRoutedHtlcPayment(
      page,
      rt1.entityId,
      rt1.signerId,
      rt2.entityId,
      [rt1.entityId, h1, h2, rt2.entityId],
      550n,
      'rt1->rt2 via h1,h2 htlc #1',
    );

    await switchRuntime(page, rt2Label);
    const p1Start = Date.now();
    let afterP1: any = null;
    while (Date.now() - p1Start < 30_000) {
      afterP1 = await readPairState(page, h2);
      const debtIncreased = afterP1
        && BigInt(afterP1.hubExposure || afterP1.hubDebt || '0') >= baselineDebt + 500n * 10n ** 18n;
      const resolveSeen = Number(afterP1?.recentHtlcResolveCount || 0) > baselineResolveCount;
      if (debtIncreased && resolveSeen) break;
      await page.waitForTimeout(400);
    }
    expect(afterP1, 'rt2-h2 state after payment#1').toBeTruthy();
    expect(
      BigInt(afterP1?.hubExposure || afterP1?.hubDebt || '0') >= baselineDebt + 500n * 10n ** 18n,
      `payment#1 must increase H2 exposure by ~550 (baseline=${baselineDebt}, now=${afterP1?.hubExposure || afterP1?.hubDebt || 'n/a'})`,
    ).toBe(true);
    expect(
      Number(afterP1?.recentHtlcResolveCount || 0) > baselineResolveCount,
      `payment#1 must be resolved (resolveCount baseline=${baselineResolveCount}, now=${afterP1?.recentHtlcResolveCount || 0})`,
    ).toBe(true);

    // Payment #2 should fail before rebalance due credit ceiling.
    await switchRuntime(page, rt1Label);
    const p2 = await sendRoutedHtlcPayment(
      page,
      rt1.entityId,
      rt1.signerId,
      rt2.entityId,
      [rt1.entityId, h1, h2, rt2.entityId],
      550n,
      'rt1->rt2 via h1,h2 htlc #2 pre-rebalance',
    );

    await switchRuntime(page, rt2Label);
    const beforeP2Debt = BigInt(afterP1?.hubExposure || afterP1?.hubDebt || '0');
    const p2Start = Date.now();
    const PRE_REBALANCE_WINDOW_MS = 2_000;
    let afterP2: any = null;
    while (Date.now() - p2Start < PRE_REBALANCE_WINDOW_MS) {
      afterP2 = await readPairState(page, h2);
      await page.waitForTimeout(150);
    }
    expect(afterP2, 'rt2-h2 state after payment#2').toBeTruthy();
    const p2HashSeen = Array.isArray(afterP2?.recentHtlcHashlocks) && afterP2.recentHtlcHashlocks.includes(p2.hashlock);
    const afterP2Debt = BigInt(afterP2?.hubExposure || afterP2?.hubDebt || '0');
    expect(
      p2HashSeen,
      `payment#2 must not finalize in pre-rebalance window (${PRE_REBALANCE_WINDOW_MS}ms)`,
    ).toBe(false);
    expect(
      afterP2Debt < beforeP2Debt + 500n * 10n ** 18n,
      'payment#2 should not increase debt by full 550 in pre-rebalance window',
    ).toBe(true);

    // Wait for H2 R2C rebalance pipeline (request -> batch -> bilateral finalize).
    const rebStart = Date.now();
    let h2RequestCommitted = false;
    let h2SettledFinalized = false;
    while (Date.now() - rebStart < 35_000) {
      const steps = await readRebalanceStepEvents(page, scenarioStartedAt);
      h2RequestCommitted = steps.some((s) =>
        String(s?.event || '') === 'request_collateral_committed'
        && String(s?.accountId || '').toLowerCase() === h2.toLowerCase(),
      );
      h2SettledFinalized = steps.some((s) =>
        String(s?.event || '') === 'account_settled_finalized_bilateral'
        && String(s?.accountId || '').toLowerCase() === h2.toLowerCase(),
      );
      if (h2RequestCommitted && h2SettledFinalized) break;
      await page.waitForTimeout(450);
    }
    expect(h2RequestCommitted, 'H2 must commit request_collateral').toBe(true);
    expect(h2SettledFinalized, 'H2 must finalize bilateral AccountSettled').toBe(true);
    const rebDone = await readPairState(page, h2);
    expect(rebDone, 'rt2-h2 rebalance snapshot must exist').toBeTruthy();
    expect(BigInt(rebDone?.requested || '0') === 0n, 'requestedRebalance must be cleared after finalize').toBe(true);
    if (!rebDone) {
      throw new Error('rt2-h2 rebalance snapshot missing');
    }

    // Payment #3 passes after rebalance.
    await switchRuntime(page, rt1Label);
    const p3 = await sendRoutedHtlcPayment(
      page,
      rt1.entityId,
      rt1.signerId,
      rt2.entityId,
      [rt1.entityId, h1, h2, rt2.entityId],
      550n,
      'rt1->rt2 via h1,h2 htlc #3 post-rebalance',
    );

    await switchRuntime(page, rt2Label);
    const debtBeforeP3 = BigInt(rebDone.hubExposure || rebDone.hubDebt || '0');
    const p3Start = Date.now();
    let afterP3: any = null;
    while (Date.now() - p3Start < 30_000) {
      afterP3 = await readPairState(page, h2);
      const hashSeen = Array.isArray(afterP3?.recentHtlcHashlocks) && afterP3.recentHtlcHashlocks.includes(p3.hashlock);
      const debtIncreased = afterP3 && BigInt(afterP3.hubExposure || afterP3.hubDebt || '0') >= debtBeforeP3 + 500n * 10n ** 18n;
      if (hashSeen || debtIncreased) break;
      await page.waitForTimeout(450);
    }
    expect(afterP3, 'rt2-h2 state after payment#3').toBeTruthy();
    expect(
      BigInt(afterP3.hubExposure || afterP3.hubDebt || '0') >= debtBeforeP3 + 500n * 10n ** 18n,
      `payment#3 should increase exposure by ~550 (before=${debtBeforeP3}, after=${afterP3?.hubExposure || afterP3?.hubDebt || 'n/a'})`,
    ).toBe(true);

    await page.screenshot({ path: 'test-results/rebalance-rt1-h1-h2-rt2.png', fullPage: true });
  });

  test('runtime2: H1=10k, H3=1k; second 550 via H3 fails before rebalance, passes after', async ({ page }) => {
    test.skip(FAST_E2E && !LONG_E2E, 'Long rebalance edge coverage disabled in fast mode.');
    const scenarioStartedAt = Date.now();
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

    // Step 1: two isolated runtimes/entities.
    const rt1Label = `rt1-${Date.now()}`;
    const rt2Label = `rt2-${Date.now() + 1}`;
    await createRuntime(page, rt1Label, randomMnemonic());
    await ensureRuntimeOnline(page, 'rt1-online');
    const rt1 = await getLocalEntity(page);

    await createRuntime(page, rt2Label, randomMnemonic());
    await ensureRuntimeOnline(page, 'rt2-online');
    const rt2 = await getLocalEntity(page);
    expect(rt1.entityId.toLowerCase()).not.toBe(rt2.entityId.toLowerCase());

    await switchRuntime(page, rt2Label);

    // Step 2: discover named hubs.
    const { h1, h3 } = await discoverNamedHubs(page);
    expect(h1 && h3, 'must discover both H1 and H3').toBeTruthy();

    // Step 3: runtime2 opens H1=10k, H3=1k.
    await connectHubWithCredit(page, rt2.entityId, rt2.signerId, h1, 10_000n);
    await connectHubWithCredit(page, rt2.entityId, rt2.signerId, h3, 1_000n);

    // Step 4: runtime1 opens funding path via H3 and receives spendable liquidity.
    await switchRuntime(page, rt1Label);
    await connectHubWithCredit(page, rt1.entityId, rt1.signerId, h3, 10_000n);
    await faucetAmount(page, rt1.entityId, h3, '2000');
    await page.waitForTimeout(1200);

    // Step 5: switch to runtime2 and capture baseline on H3.
    await switchRuntime(page, rt2Label);
    const baseline = await readPairState(page, h3);
    expect(baseline, 'runtime2-h3 baseline must exist').toBeTruthy();
    const baselineDebt = BigInt(baseline?.hubDebt || baseline?.hubExposure || '0');
    const baselineResolveCount = Number(baseline?.recentHtlcResolveCount || 0);

    // Step 6: HTLC #1 (550) from runtime1 -> runtime2 via H3 should pass.
    await switchRuntime(page, rt1Label);
    await sendRoutedHtlcPayment(
      page,
      rt1.entityId,
      rt1.signerId,
      rt2.entityId,
      [rt1.entityId, h3, rt2.entityId],
      550n,
      'rt1->rt2 via h3 htlc #1',
    );

    await switchRuntime(page, rt2Label);

    const p1Start = Date.now();
    let afterP1: any = null;
    while (Date.now() - p1Start < 60_000) {
      afterP1 = await readPairState(page, h3);
      const debtIncreased = afterP1
        && BigInt(afterP1.hubDebt || afterP1.hubExposure || '0') >= baselineDebt + 500n * 10n ** 18n;
      const resolveSeen = Number(afterP1?.recentHtlcResolveCount || 0) > baselineResolveCount;
      if (debtIncreased && resolveSeen) break;
      await page.waitForTimeout(700);
    }
    expect(afterP1, 'runtime2-h3 state after payment1').toBeTruthy();
    expect(
      BigInt(afterP1?.hubDebt || afterP1?.hubExposure || '0') >= baselineDebt + 500n * 10n ** 18n,
      `payment1 must increase H3 debt by ~550 (baseline=${baselineDebt}, now=${afterP1?.hubDebt || afterP1?.hubExposure || 'n/a'})`,
    ).toBe(true);
    expect(
      Number(afterP1?.recentHtlcResolveCount || 0) > baselineResolveCount,
      `payment1 must be resolved (resolveCount baseline=${baselineResolveCount}, now=${afterP1?.recentHtlcResolveCount || 0})`,
    ).toBe(true);

    // Step 7: HTLC #2 (550) immediately should fail on H3 capacity (1k credit total).
    await switchRuntime(page, rt1Label);
    const p2QueuedAt = Date.now();
    const payment2 = await sendRoutedHtlcPayment(
      page,
      rt1.entityId,
      rt1.signerId,
      rt2.entityId,
      [rt1.entityId, h3, rt2.entityId],
      550n,
      'rt1->rt2 via h3 htlc #2 should fail pre-rebalance',
    );

    await switchRuntime(page, rt2Label);

    const p2Start = Date.now();
    const PRE_REBALANCE_WINDOW_MS = 2_000;
    let afterP2: any = null;
    while (Date.now() - p2Start < PRE_REBALANCE_WINDOW_MS) {
      afterP2 = await readPairState(page, h3);
      await page.waitForTimeout(150);
    }
    expect(afterP2, 'runtime2-h3 state after payment2').toBeTruthy();
    const hasPayment2PreRebalance = Array.isArray(afterP2.recentHtlcHashlocks)
      && afterP2.recentHtlcHashlocks.includes(payment2.hashlock);
    if (hasPayment2PreRebalance) {
      const steps = await readRebalanceStepEvents(page, scenarioStartedAt);
      const h3SettledEarly = steps.some((s) =>
        String(s?.event || '') === 'account_settled_finalized_bilateral'
        && String(s?.accountId || '').toLowerCase() === h3.toLowerCase()
        && Number(s?.ts || 0) >= p2QueuedAt - 1_000,
      );
      expect(
        h3SettledEarly,
        `payment2 passed too early without finalized rebalance evidence: ${JSON.stringify(steps.slice(-40), null, 2)}`,
      ).toBe(true);
    }

    const debtAfterP2 = BigInt(afterP2.hubDebt || '0');
    if (!hasPayment2PreRebalance) {
      expect(
        debtAfterP2 <= 1_000n * 10n ** 18n + 20n * 10n ** 18n,
        `runtime2-H3 debt should remain around <=1k in pre-rebalance window, got ${debtAfterP2}`,
      ).toBe(true);
    }

    // Step 8: wait rebalance finalize on runtime2-H3 (collateralized and request cleared).
    const rebStart = Date.now();
    let rebDone: any = null;
    while (Date.now() - rebStart < 180_000) {
      const snap = await readPairState(page, h3);
      if (
        snap &&
        BigInt(snap.requested || '0') === 0n &&
        BigInt(snap.collateral || '0') >= BigInt(snap.hubDebt || '0') &&
        Number(snap.lastFinalizedJHeight || 0) > 0
      ) {
        rebDone = snap;
        break;
      }
      await page.waitForTimeout(800);
    }
    expect(rebDone, 'rebalance must complete before payment3').toBeTruthy();

    // Step 9: HTLC #3 (550) after rebalance should pass again.
    await switchRuntime(page, rt1Label);
    const payment3 = await sendRoutedHtlcPayment(
      page,
      rt1.entityId,
      rt1.signerId,
      rt2.entityId,
      [rt1.entityId, h3, rt2.entityId],
      550n,
      'rt1->rt2 via h3 htlc #3 post-rebalance',
    );

    await switchRuntime(page, rt2Label);

    const debtBeforeP3 = BigInt(rebDone.hubDebt || '0');
    const p3Start = Date.now();
    let afterP3: any = null;
    while (Date.now() - p3Start < 70_000) {
      afterP3 = await readPairState(page, h3);
      const hasPayment3 = Array.isArray(afterP3?.recentHtlcHashlocks)
        && afterP3.recentHtlcHashlocks.includes(payment3.hashlock);
      if (afterP3 && hasPayment3) break;
      await page.waitForTimeout(700);
    }
    expect(afterP3, 'runtime2-h3 state after payment3').toBeTruthy();
    expect(
      Array.isArray(afterP3.recentHtlcHashlocks)
        && afterP3.recentHtlcHashlocks.includes(payment3.hashlock),
      `payment3 should pass post-rebalance (HTLC hashlock not found): ${JSON.stringify(afterP3?.recentHtlcHashlocks || [])}`,
    ).toBe(true);
    expect(
      BigInt(afterP3.hubDebt || '0') >= debtBeforeP3 + 500n * 10n ** 18n,
      `post-rebalance payment3 should increase debt by ~550 (debt ${debtBeforeP3} -> ${afterP3?.hubDebt || 'n/a'})`,
    ).toBe(true);
  });
});
