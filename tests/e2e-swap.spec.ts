/**
 * E2E swap coverage for the live UI and the built-in browser scenarios.
 *
 * These tests verify that swap offers can auto-prepare missing token capacity, place and cancel
 * cleanly through the UI, and that the scenario runners still produce partial fills after reload-safe setup.
 */
import { test, expect, type Locator, type Page, type TestInfo } from '@playwright/test';
import { Wallet } from 'ethers';
import { timedStep } from './utils/e2e-timing';
import { APP_BASE_URL, API_BASE_URL, ensureE2EBaseline, getHealth } from './utils/e2e-baseline';
import { connectRuntimeToHub as connectRuntimeToSharedHub } from './utils/e2e-connect';
import {
  gotoApp as gotoSharedApp,
  createRuntime as createSharedRuntime,
} from './utils/e2e-demo-users';
import { getRenderedOutboundForAccount } from './utils/e2e-account-ui';
import { buildDefaultEntitySwapPairs, getTokenInfo } from '../runtime/account-utils';
import { capturePageScreenshot } from './utils/e2e-screenshots';

const INIT_TIMEOUT = 30_000;
const CANONICAL_SWAP_PAIRS = buildDefaultEntitySwapPairs().map((pair) => ({
  ...pair,
  label: `${getTokenInfo(pair.baseTokenId).symbol}/${getTokenInfo(pair.quoteTokenId).symbol}`,
}));
const CANONICAL_SWAP_PAIR_IDS = CANONICAL_SWAP_PAIRS.map((pair) => pair.pairId);
const CANONICAL_SWAP_PAIR_LABELS = CANONICAL_SWAP_PAIRS.map((pair) => pair.label);

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

function orderbookRowTestId(side: 'ask' | 'bid'): string {
  return side === 'ask' ? 'orderbook-ask-row' : 'orderbook-bid-row';
}

async function readOrderbookRowCounts(page: Page): Promise<{ asks: number; bids: number }> {
  return {
    asks: await page.getByTestId(orderbookRowTestId('ask')).count(),
    bids: await page.getByTestId(orderbookRowTestId('bid')).count(),
  };
}

async function countUniqueOrderbookSources(page: Page): Promise<number> {
  return await page.locator('[data-testid="orderbook-source-icon"]').evaluateAll((nodes) => {
    const ids = new Set<string>();
    for (const node of nodes) {
      const sourceId = String((node as HTMLElement).dataset.sourceId || '').trim();
      if (sourceId) ids.add(sourceId);
    }
    return ids.size;
  });
}

async function readSwapScopeMode(page: Page): Promise<'aggregated' | 'selected' | ''> {
  const raw = String(await page.getByTestId('swap-scope-toggle').first().getAttribute('data-scope-mode') || '').trim();
  return raw === 'aggregated' || raw === 'selected' ? raw : '';
}

async function ensureSwapScope(page: Page, desired: 'aggregated' | 'selected'): Promise<void> {
  const scopeToggle = page.getByTestId('swap-scope-toggle').first();
  await expect(scopeToggle).toBeVisible({ timeout: 20_000 });
  await expect
    .poll(async () => {
      const current = await readSwapScopeMode(page);
      if (current !== desired) {
        await scopeToggle.click();
        await page.waitForTimeout(150);
      }
      return await readSwapScopeMode(page);
    }, { timeout: 10_000, intervals: [50, 100, 200] })
    .toBe(desired);
}

async function expectVisibleOrderbookDepth(
  page: Page,
  expected: { asks: number; bids: number },
  options?: { timeoutMs?: number; minSources?: number; maxSources?: number },
): Promise<void> {
  const timeoutMs = options?.timeoutMs ?? 15_000;
  await expect
    .poll(
      async () => {
        const counts = await readOrderbookRowCounts(page);
        const sources = await countUniqueOrderbookSources(page);
        return { ...counts, sources };
      },
      { timeout: timeoutMs, intervals: [200, 400, 800] },
    )
    .toEqual({
      asks: expected.asks,
      bids: expected.bids,
      sources: expect.any(Number),
    });
  if (typeof options?.minSources === 'number') {
    await expect
      .poll(async () => await countUniqueOrderbookSources(page), { timeout: timeoutMs, intervals: [200, 400, 800] })
      .toBeGreaterThanOrEqual(options.minSources);
  }
  if (typeof options?.maxSources === 'number') {
    await expect
      .poll(async () => await countUniqueOrderbookSources(page), { timeout: timeoutMs, intervals: [200, 400, 800] })
      .toBeLessThanOrEqual(options.maxSources);
  }
}

async function createDemoRuntime(page: Page, label: string, mnemonic: string): Promise<void> {
  await createSharedRuntime(page, label, mnemonic);
}

async function ensureAnyHubAccountOpen(page: Page): Promise<{
  entityId: string;
  signerId: string;
  counterpartyId: string;
  giveTokenId: number;
  wantTokenId: number;
  orderAmount: string;
  orderPrice: string;
}> {
  const result = await page.evaluate(async () => {
    const CANDIDATE_TOKEN_IDS = [1, 2, 3];
    const TOKEN_SCALE = 10n ** 18n;
    const MIN_TEST_FILL = TOKEN_SCALE / 100n; // 0.01

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

    const getDelta = (account: any, tokenId: number): any => {
      if (!(account?.deltas instanceof Map)) return null;
      return account.deltas.get(tokenId) ?? null;
    };

    const getTokenDecimals = (tokenId: number): number => {
      const XLN = (window as any).XLN;
      const decimals = Number(XLN?.getTokenInfo?.(tokenId)?.decimals ?? 18);
      return Number.isFinite(decimals) && decimals >= 0 ? Math.floor(decimals) : 18;
    };

    const formatAmount = (amount: bigint, decimals: number): string => {
      if (amount <= 0n) return '0';
      const scale = 10n ** BigInt(decimals);
      const whole = amount / scale;
      const frac = amount % scale;
      if (frac === 0n) return whole.toString();
      const fracText = frac.toString().padStart(decimals, '0').replace(/0+$/, '');
      return fracText.length > 0 ? `${whole.toString()}.${fracText}` : whole.toString();
    };

    const getCapacity = (entityId: string, counterpartyId: string, account: any, tokenId: number) => {
      const XLN = (window as any).XLN;
      const delta = getDelta(account, tokenId);
      if (!delta || !XLN?.deriveDelta) {
        return { hasDelta: Boolean(delta), inCapacity: 0n, outCapacity: 0n };
      }
      const isLeft = XLN?.isLeft
        ? Boolean(XLN.isLeft(entityId, counterpartyId))
        : String(entityId).toLowerCase() < String(counterpartyId).toLowerCase();
      const derived = XLN.deriveDelta(delta, isLeft);
      const inCapacity = typeof derived?.inCapacity === 'bigint' ? derived.inCapacity : BigInt(derived?.inCapacity || 0);
      const outCapacity = typeof derived?.outCapacity === 'bigint' ? derived.outCapacity : BigInt(derived?.outCapacity || 0);
      return { hasDelta: true, inCapacity, outCapacity };
    };

    const listTokenIds = (account: any): number[] => {
      const tokenIds = new Set<number>(CANDIDATE_TOKEN_IDS);
      if (account?.deltas instanceof Map) {
        for (const [id] of account.deltas.entries()) {
          const parsed = Number.parseInt(String(id), 10);
          if (Number.isFinite(parsed) && parsed > 0) tokenIds.add(parsed);
        }
      }
      return [...tokenIds].sort((a, b) => a - b);
    };

    const findTradablePair = (entityId: string, counterpartyId: string, account: any) => {
      if (!account) return null;
      const tokenIds = listTokenIds(account);
      const caps = tokenIds.map((tokenId) => ({ tokenId, ...getCapacity(entityId, counterpartyId, account, tokenId) }));
      let best: {
        giveTokenId: number;
        wantTokenId: number;
        giveOut: bigint;
        wantIn: bigint;
        budget: bigint;
      } | null = null;
      for (const give of caps) {
        if (give.outCapacity <= 0n) continue;
        for (const want of caps) {
          if (want.tokenId === give.tokenId) continue;
          if (!want.hasDelta || want.inCapacity <= 0n) continue;
          const budget = give.outCapacity < want.inCapacity ? give.outCapacity : want.inCapacity;
          if (budget <= 0n) continue;
          if (budget < MIN_TEST_FILL && (!best || best.budget >= MIN_TEST_FILL)) continue;
          if (!best || budget > best.budget) {
            best = {
              giveTokenId: give.tokenId,
              wantTokenId: want.tokenId,
              giveOut: give.outCapacity,
              wantIn: want.inCapacity,
              budget,
            };
          }
        }
      }
      return best;
    };

    const requestOffchainFaucet = async (
      runtimeId: string,
      userEntityId: string,
      hubEntityId: string,
      tokenId: number,
      amount: string,
    ): Promise<{ ok: boolean; detail: string }> => {
      const deadline = Date.now() + 20_000;
      let lastDetail = 'unknown';
      while (Date.now() < deadline) {
        try {
          const response = await fetch('/api/faucet/offchain', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              userEntityId,
              userRuntimeId: runtimeId,
              hubEntityId,
              tokenId,
              amount,
            }),
          });
          const payload = await response.json().catch(() => ({}));
          if (response.ok && payload?.success) {
            return { ok: true, detail: String(payload?.status || 'queued') };
          }
          lastDetail = String(payload?.code || payload?.error || `status:${response.status}`);
          // transient conflict while account pending / syncing
          if (response.status === 409 || response.status === 503) {
            await new Promise((resolve) => setTimeout(resolve, 500));
            continue;
          }
          return { ok: false, detail: lastDetail };
        } catch (error: any) {
          lastDetail = String(error?.message || error);
          await new Promise((resolve) => setTimeout(resolve, 500));
        }
      }
      return { ok: false, detail: lastDetail };
    };

    const buildOrderAmount = (giveTokenId: number, budget: bigint): string => {
      if (budget <= 0n) return '0';
      const decimals = getTokenDecimals(giveTokenId);
      const one = 10n ** BigInt(decimals);
      const tenth = one / 10n;
      let amountWei = budget;
      if (budget > one) amountWei = one;
      else if (budget > tenth && tenth > 0n) amountWei = tenth;
      return formatAmount(amountWei, decimals);
    };

    const findLocalReplica = (env: any, entityId: string, signerId: string) => {
      const repKey = Array.from(env.eReplicas.keys()).find((key: string) => {
        const [eid, sid] = String(key).split(':');
        return String(eid || '').toLowerCase() === String(entityId).toLowerCase()
          && String(sid || '').toLowerCase() === String(signerId).toLowerCase();
      });
      return repKey ? env.eReplicas.get(repKey) : null;
    };

    const accountReadyForSwap = (entityId: string, counterpartyId: string, account: any) => {
      if (!account || account?.pendingFrame || Number(account?.currentHeight || 0) <= 0) return null;
      const pair = findTradablePair(entityId, counterpartyId, account);
      if (!pair) return null;
      return {
        ...pair,
        orderAmount: buildOrderAmount(pair.giveTokenId, pair.budget),
        orderPrice: '1',
      };
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
          const ready = accountReadyForSwap(entityId, String(cpId || ''), account);
          if (ready && ready.orderAmount !== '0') {
            return { ok: true, entityId, signerId, counterpartyId: String(cpId), ...ready };
          }
          if (!openedHubId) openedHubId = String(cpId || '');
        }
      }
      // Keep scanning local replicas until we either find a usable account
      // or exhaust the runtime-owned replicas. Stopping after the first replica
      // silently picks the wrong local entity when the first entry has no account.
      if (entityId && signerId && openedHubId) break;
    }

    if (!entityId || !signerId) return { ok: false, error: 'local entity not found' };

    let hubId = String(openedHubId || '');
    if (!hubId) {
      const startedAt = Date.now();
      while (Date.now() - startedAt < 15_000) {
        const profiles = env?.gossip?.getProfiles?.() || [];
        const hub = profiles.find((p: any) => p?.metadata?.isHub === true);
        hubId = String(hub?.entityId || '');
        if (hubId) break;
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
    }
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
            data: { targetEntityId: hubId, creditAmount: 10_000n * TOKEN_SCALE, tokenId: 1 },
          }],
        }],
      });
    }

    const waitForSwapReady = async (
      timeoutMs: number,
    ): Promise<{
      giveTokenId: number;
      wantTokenId: number;
      giveOut: bigint;
      wantIn: bigint;
      budget: bigint;
      orderAmount: string;
      orderPrice: string;
    } | null> => {
      const startedAt = Date.now();
      while (Date.now() - startedAt < timeoutMs) {
        for (const [key, rep] of env.eReplicas.entries()) {
          const [eid] = String(key).split(':');
          if (String(eid || '').toLowerCase() !== String(entityId).toLowerCase()) continue;
          const account = findAccount(rep?.state?.accounts, entityId, hubId);
          const ready = accountReadyForSwap(entityId, hubId, account);
          if (ready && ready.orderAmount !== '0') {
            return ready;
          }
        }
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      return null;
    };

    const earlyReady = await waitForSwapReady(20_000);
    if (earlyReady) {
      return { ok: true, entityId, signerId, counterpartyId: hubId, ...earlyReady };
    }

    XLN.enqueueRuntimeInput(env, {
      runtimeTxs: [],
      entityInputs: [{
        entityId,
        signerId,
        entityTxs: CANDIDATE_TOKEN_IDS.map((tokenId) => ({
          type: 'extendCredit',
          data: {
            counterpartyEntityId: hubId,
            tokenId,
            amount: 10_000n * TOKEN_SCALE,
          },
        })),
      }],
    });

    const readyAfterExtend = await waitForSwapReady(45_000);
    if (readyAfterExtend) {
      return { ok: true, entityId, signerId, counterpartyId: hubId, ...readyAfterExtend };
    }

    const faucet = await requestOffchainFaucet(
      String(env.runtimeId || ''),
      entityId,
      hubId,
      1,
      '100',
    );
    const readyAfterFaucet = await waitForSwapReady(45_000);
    if (readyAfterFaucet) {
      return { ok: true, entityId, signerId, counterpartyId: hubId, ...readyAfterFaucet };
    }

    const rep = findLocalReplica(env, entityId, signerId);
    const account = findAccount(rep?.state?.accounts, entityId, hubId);
    if (account) {
      const tokens = listTokenIds(account)
        .map((tokenId) => {
          const cap = getCapacity(entityId, hubId, account, tokenId);
          return `${tokenId}:out=${cap.outCapacity.toString()}:in=${cap.inCapacity.toString()}:delta=${String(cap.hasDelta)}`;
        })
        .join(', ');
      return {
        ok: false,
        error:
          `swap-capacity timeout: faucet=${faucet.ok ? 'ok' : `fail(${faucet.detail})`} ` +
          `currentHeight=${String(account?.currentHeight || 0)} tokens=[${tokens}]`,
      };
    }

    return { ok: false, error: 'swap-capacity timeout: account not found after open/extend' };
  });

  expect(result.ok, `ensureAnyHubAccountOpen failed: ${result.error || 'unknown'}`).toBe(true);
  if (!result.ok) throw new Error(result.error || 'failed');
  return {
    entityId: result.entityId,
    signerId: result.signerId,
    counterpartyId: result.counterpartyId,
    giveTokenId: Number(result.giveTokenId),
    wantTokenId: Number(result.wantTokenId),
    orderAmount: String(result.orderAmount || '1'),
    orderPrice: String(result.orderPrice || '1'),
  };
}

async function ensureDeterministicSwapAccount(page: Page): Promise<{
  entityId: string;
  signerId: string;
  counterpartyId: string;
}> {
  const identity = await page.evaluate(() => {
    const env = (window as typeof window & {
      isolatedEnv?: {
        runtimeId?: string;
        eReplicas?: Map<string, unknown>;
      };
    }).isolatedEnv;
    if (!env?.eReplicas) return null;

    const runtimeSigner = String(env.runtimeId || '').toLowerCase();
    for (const key of env.eReplicas.keys()) {
      const [entityId, signerId] = String(key).split(':');
      if (!entityId?.startsWith('0x') || entityId.length !== 66 || !signerId) continue;
      if (runtimeSigner && String(signerId).toLowerCase() !== runtimeSigner) continue;
      return { entityId, signerId, runtimeId: String(env.runtimeId || '') };
    }

    return null;
  });
  expect(identity, 'local entity not found').not.toBeNull();

  const hubIds = await listSharedHubIds(page);
  const hubId = hubIds[0];
  expect(typeof hubId === 'string' && hubId.length > 0, 'hub not discovered').toBe(true);

  await connectRuntimeToSharedHub(page, {
    entityId: identity!.entityId,
    signerId: identity!.signerId,
  }, hubId!);

  for (const funding of [
    { tokenId: 1, amount: '100' },
    { tokenId: 2, amount: '1' },
  ]) {
    const faucetResponse = await page.request.post(`${API_BASE_URL}/api/faucet/offchain`, {
      data: {
        userEntityId: identity!.entityId,
        userRuntimeId: identity!.runtimeId,
        hubEntityId: hubId!,
        tokenId: funding.tokenId,
        amount: funding.amount,
      },
    });
    const faucetBody = await faucetResponse.json().catch(() => ({}));
    expect(
      faucetResponse.ok(),
      `swap faucet failed for token ${funding.tokenId}: ${JSON.stringify(faucetBody)}`,
    ).toBe(true);
  }

  await expect.poll(async () => {
    return await getRenderedOutboundForAccount(page, hubId!);
  }, { timeout: 60_000, intervals: [500, 1000, 2000] }).toBeGreaterThan(0);

  await expect.poll(async () => {
    return await readAccountTokenOutCapacity(page, identity!.entityId, identity!.signerId, hubId!, 2);
  }, { timeout: 60_000, intervals: [250, 500, 1000] }).toBeGreaterThan(0);

  return {
    entityId: identity!.entityId,
    signerId: identity!.signerId,
    counterpartyId: hubId!,
  };
}

async function readAccountTokenOutCapacity(
  page: Page,
  entityId: string,
  signerId: string,
  counterpartyId: string,
  tokenId: number,
): Promise<number> {
  return await page.evaluate(({ entityId, signerId, counterpartyId, tokenId }) => {
    const nonNegative = (x: bigint): bigint => (x < 0n ? 0n : x);
    const normalize = (value: string) => String(value || '').trim().toLowerCase();
    const env = (window as any).isolatedEnv;
    if (!env?.eReplicas) return 0;
    const key = Array.from(env.eReplicas.keys()).find((k: string) => {
      const [eid, sid] = String(k).split(':');
      return normalize(eid) === normalize(entityId) && normalize(sid) === normalize(signerId);
    });
    const replica = key ? env.eReplicas.get(key) : null;
    if (!replica?.state?.accounts || !(replica.state.accounts instanceof Map)) return 0;

    let account: any = null;
    for (const [accountKey, candidate] of replica.state.accounts.entries()) {
      if (normalize(String(accountKey || '')) === normalize(counterpartyId)) {
        account = candidate;
        break;
      }
      const left = normalize(String(candidate?.leftEntity || ''));
      const right = normalize(String(candidate?.rightEntity || ''));
      const owner = normalize(entityId);
      const cp = normalize(counterpartyId);
      if ((left === owner && right === cp) || (left === cp && right === owner)) {
        account = candidate;
        break;
      }
    }
    if (!account?.deltas || !(account.deltas instanceof Map)) return 0;
    const delta = account.deltas.get(tokenId);
    if (!delta) return 0;

    const totalDelta = BigInt(delta.ondelta || 0n) + BigInt(delta.offdelta || 0n);
    const collateral = nonNegative(BigInt(delta.collateral || 0n));
    const ownCreditLimit = BigInt(delta.leftCreditLimit || 0n);
    const peerCreditLimit = BigInt(delta.rightCreditLimit || 0n);
    let outCollateral = totalDelta > 0n ? (totalDelta > collateral ? collateral : totalDelta) : 0n;
    let inOwnCredit = nonNegative(-totalDelta);
    if (inOwnCredit > ownCreditLimit) inOwnCredit = ownCreditLimit;
    let outPeerCredit = nonNegative(totalDelta - collateral);
    if (outPeerCredit > peerCreditLimit) outPeerCredit = peerCreditLimit;
    const outOwnCredit = nonNegative(ownCreditLimit - inOwnCredit);
    const outAllowance = BigInt(delta.leftAllowance || 0n);
    const leftHold = BigInt(delta.leftHold || 0n);
    const leftEntity = normalize(String(account.leftEntity || ''));
    const isLeft = leftEntity === normalize(entityId);
    let outCapacity = nonNegative(outPeerCredit + outCollateral + outOwnCredit - outAllowance);
    outCapacity = nonNegative(outCapacity - leftHold);

    if (!isLeft) {
      let inCollateral = totalDelta > 0n ? nonNegative(collateral - totalDelta) : collateral;
      let inAllowance = BigInt(delta.rightAllowance || 0n);
      let inPeerCredit = nonNegative(peerCreditLimit - outPeerCredit);
      let rightHold = BigInt(delta.rightHold || 0n);
      let inCapacity = nonNegative(inOwnCredit + inCollateral + inPeerCredit - inAllowance);
      inCapacity = nonNegative(inCapacity - rightHold);
      outCapacity = inCapacity;
    }

    return Number(outCapacity) / 1e18;
  }, { entityId, signerId, counterpartyId, tokenId });
}

async function listSharedHubIds(page: Page): Promise<string[]> {
  const response = await page.request.get(`${API_BASE_URL}/api/health`);
  expect(response.ok(), 'health endpoint must be available').toBe(true);
  const body = await response.json() as {
    hubMesh?: { hubIds?: string[] };
    hubs?: Array<{ entityId?: string; online?: boolean }>;
  };

  const hubMeshIds = Array.isArray(body.hubMesh?.hubIds) ? body.hubMesh!.hubIds.filter(Boolean) : [];
  if (hubMeshIds.length > 0) return Array.from(new Set(hubMeshIds.map((id) => String(id))));

  const liveHubIds = Array.isArray(body.hubs)
    ? body.hubs
        .filter((hub) => hub.online !== false && typeof hub.entityId === 'string' && hub.entityId.length > 0)
        .map((hub) => String(hub.entityId))
    : [];
  return Array.from(new Set(liveHubIds));
}

async function ensureDeterministicSwapAccounts(
  page: Page,
  minHubCount = 3,
): Promise<{
  entityId: string;
  signerId: string;
  runtimeId: string;
  hubIds: string[];
}> {
  const identity = await page.evaluate(() => {
    const env = (window as typeof window & {
      isolatedEnv?: {
        runtimeId?: string;
        eReplicas?: Map<string, unknown>;
      };
    }).isolatedEnv;
    if (!env?.eReplicas) return null;

    const runtimeSigner = String(env.runtimeId || '').toLowerCase();
    for (const key of env.eReplicas.keys()) {
      const [entityId, signerId] = String(key).split(':');
      if (!entityId?.startsWith('0x') || entityId.length !== 66 || !signerId) continue;
      if (runtimeSigner && String(signerId).toLowerCase() !== runtimeSigner) continue;
      return { entityId, signerId, runtimeId: String(env.runtimeId || '') };
    }

    return null;
  });
  expect(identity, 'local entity not found').not.toBeNull();

  const hubIds = (await listSharedHubIds(page)).slice(0, minHubCount);
  expect(hubIds.length, `expected at least ${minHubCount} hubs for aggregated swap coverage`).toBeGreaterThanOrEqual(minHubCount);

  for (const hubId of hubIds) {
    await connectRuntimeToSharedHub(page, {
      entityId: identity!.entityId,
      signerId: identity!.signerId,
    }, hubId);
  }

  await expect
    .poll(async () => {
      const health = await getHealth(page);
      const mmHubs = Array.isArray(health?.marketMaker?.hubs) ? health.marketMaker!.hubs : [];
      let readyHubs = 0;
      let pairBookCount = 0;
      for (const hubId of hubIds) {
        const hub = mmHubs.find((entry) => String(entry.hubEntityId || '').toLowerCase() === String(hubId).toLowerCase());
        const readyPairs = (hub?.pairs ?? []).filter((pair) =>
          CANONICAL_SWAP_PAIR_IDS.includes(String(pair.pairId || '')) && pair.ready === true,
        );
        pairBookCount += readyPairs.length;
        if (readyPairs.length === CANONICAL_SWAP_PAIR_IDS.length) readyHubs += 1;
      }
      return { readyHubs, pairBookCount };
    }, {
      timeout: 30_000,
      intervals: [250, 500, 1000],
      message: 'server market-maker must expose 3x3 hub orderbooks before swap UI assertions',
    })
    .toEqual({ readyHubs: hubIds.length, pairBookCount: hubIds.length * CANONICAL_SWAP_PAIR_IDS.length });

  return {
    entityId: identity!.entityId,
    signerId: identity!.signerId,
    runtimeId: identity!.runtimeId,
    hubIds,
  };
}

async function readSwapState(
  page: Page,
  entityId: string,
  signerId: string,
  counterpartyId: string,
): Promise<{
  openOfferCount: number;
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
        openOfferCount: 0,
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
      openOfferCount: Number(
        Array.from(rep?.state?.accounts?.values?.() || []).reduce(
          (count: number, account: any) => count + Number(account?.swapOffers?.size || 0),
          0,
        ),
      ),
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

async function readSwapResolveCount(
  page: Page,
  entityId: string,
  signerId: string,
  counterpartyId: string,
): Promise<number> {
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
    if (!env?.eReplicas) return 0;
    const key = Array.from(env.eReplicas.keys()).find((k: string) => {
      const [eid, sid] = String(k).split(':');
      return String(eid || '').toLowerCase() === String(entityId).toLowerCase()
        && String(sid || '').toLowerCase() === String(signerId).toLowerCase();
    });
    const rep = key ? env.eReplicas.get(key) : null;
    const account = findAccount(rep?.state?.accounts, entityId, counterpartyId);
    if (!account) return 0;

    let count = 0;
    for (const frame of account.frameHistory || []) {
      for (const tx of frame?.accountTxs || []) {
        if (tx?.type === 'swap_resolve') count += 1;
      }
    }
    return count;
  }, { entityId, signerId, counterpartyId });
}

async function readPositiveSwapResolveCount(
  page: Page,
  entityId: string,
  signerId: string,
  counterpartyId: string,
): Promise<number> {
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
    if (!env?.eReplicas) return 0;
    const key = Array.from(env.eReplicas.keys()).find((k: string) => {
      const [eid, sid] = String(k).split(':');
      return String(eid || '').toLowerCase() === String(entityId).toLowerCase()
        && String(sid || '').toLowerCase() === String(signerId).toLowerCase();
    });
    const rep = key ? env.eReplicas.get(key) : null;
    const account = findAccount(rep?.state?.accounts, entityId, counterpartyId);
    if (!account) return 0;

    let count = 0;
    for (const frame of account.frameHistory || []) {
      for (const tx of frame?.accountTxs || []) {
        if (tx?.type !== 'swap_resolve') continue;
        const fillRatio = Number(tx?.data?.fillRatio || 0);
        if (fillRatio > 0) count += 1;
      }
    }
    return count;
  }, { entityId, signerId, counterpartyId });
}

async function openSwapWorkspace(page: Page): Promise<void> {
  const accountsTab = page.getByTestId('tab-accounts').first();
  await expect(accountsTab).toBeVisible({ timeout: 20_000 });
  await accountsTab.click();
  const swapTab = page.getByTestId('account-workspace-tab-swap').first();
  await expect(swapTab).toBeVisible({ timeout: 20_000 });
  await swapTab.click();
  await expect(page.locator('.swap-panel').first()).toBeVisible({ timeout: 15_000 });
}

async function selectCounterpartyInSwap(page: Page, preferredAccountId?: string): Promise<void> {
  const select = page.getByTestId('swap-account-select').first();
  const hasSelector = await select.isVisible({ timeout: 1500 }).catch(() => false);
  if (!hasSelector) return;
  await expect
    .poll(async () => await select.locator('option').count(), {
      timeout: 30_000,
      intervals: [250, 500, 1000],
      message: 'swap account selector must expose at least one account option',
    })
    .toBeGreaterThan(0);
  const values = await select.locator('option').evaluateAll((options) =>
    options.map((option) => ({ value: String((option as HTMLOptionElement).value || ''), label: option.textContent || '' })),
  );
  const normalizedPreferred = String(preferredAccountId || '').trim().toLowerCase();
  const preferredAccount = normalizedPreferred
    ? values.find((option) => String(option.value || '').trim().toLowerCase() === normalizedPreferred)
    : null;
  const targetAccount = preferredAccount || values.find((option) => option.value);
  if (!targetAccount) return;
  await select.evaluate((node, value) => {
    const element = node as HTMLSelectElement;
    element.value = String(value || '');
    element.dispatchEvent(new Event('change', { bubbles: true }));
    element.dispatchEvent(new Event('input', { bubbles: true }));
  }, targetAccount.value);
  await expect
    .poll(async () => String(await select.inputValue().catch(() => '')).trim().toLowerCase(), {
      timeout: 10_000,
      intervals: [100, 250, 500],
    })
    .toBe(String(targetAccount.value).trim().toLowerCase());
}

function parseFirstNumber(text: string): number {
  const match = String(text || '').match(/-?\d[\d,]*(?:\.\d+)?/);
  if (!match) return Number.NaN;
  return Number.parseFloat(match[0]!.replace(/,/g, ''));
}

function formatDecimalForInput(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0';
  return value.toFixed(6).replace(/\.?0+$/, '');
}

function normalizeDisplayedPriceText(value: string): string {
  return String(value || '').replace(/,/g, '').trim();
}

async function waitForSwapOrderbookLiquidity(
  page: Page,
  pairLabel: string,
  options?: {
    preferredAccountId?: string;
    scope?: 'Aggregated' | 'Selected';
    minSources?: number;
  },
): Promise<void> {
  const desiredScope = options?.scope || 'Aggregated';
  const minSources = Number.isFinite(options?.minSources) ? Number(options?.minSources) : 1;

  const readVisibleLiquidity = async () => {
    const { asks, bids } = await readOrderbookRowCounts(page);
    const uniqueSourceIds = await countUniqueOrderbookSources(page);
    return { asks, bids, rows: asks + bids, sources: uniqueSourceIds };
  };

  const tryWaitOnce = async (timeoutMs: number): Promise<{ asks: number; bids: number; rows: number; sources: number }> => {
    const pairSelect = page.getByTestId('swap-pair-select').first();
    const scopeToggle = page.getByTestId('swap-scope-toggle').first();
    const refreshLabel = page.locator('.swap-panel .orderbook-panel .update-label').first();
    await expect(pairSelect).toBeVisible({ timeout: 20_000 });
    await expect(scopeToggle).toBeVisible({ timeout: 20_000 });
    await selectCounterpartyInSwap(page, options?.preferredAccountId);
    const start = Date.now();
    let lastState = await readVisibleLiquidity().catch(() => ({ asks: 0, bids: 0, rows: 0, sources: 0 }));
    while (Date.now() - start < timeoutMs) {
      await ensureSwapScope(page, desiredScope === 'Aggregated' ? 'aggregated' : 'selected');
      await pairSelect.selectOption({ label: pairLabel });
      await page.waitForTimeout(250);
      lastState = await readVisibleLiquidity();
      if (lastState.rows > 0 && lastState.sources >= minSources) return lastState;
      if (await refreshLabel.isVisible().catch(() => false)) {
        await refreshLabel.click().catch(() => {});
        await page.waitForTimeout(200);
        lastState = await readVisibleLiquidity().catch(() => lastState);
        if (lastState.rows > 0 && lastState.sources >= minSources) return lastState;
      }
      await selectCounterpartyInSwap(page, options?.preferredAccountId);
      await page.waitForTimeout(750);
    }
    return lastState;
  };

  let lastState = await tryWaitOnce(45_000);
  if (lastState.rows > 0 && lastState.sources >= minSources) return;

  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => {
    const env = (window as any).isolatedEnv;
    return !!env?.runtimeId && Number(env?.eReplicas?.size || 0) > 0;
  }, { timeout: 60_000 });
  await openSwapWorkspace(page);
  lastState = await tryWaitOnce(45_000);
  if (lastState.rows > 0 && lastState.sources >= minSources) return;

  const selectedAccountId = await page.getByTestId('swap-account-select').first().inputValue().catch(() => '');
  throw new Error(
    `Swap orderbook stayed empty for ${pairLabel}: ${JSON.stringify({ ...lastState, selectedAccountId, desiredScope, minSources })}`,
  );
}

async function prepareExecutableOrder(page: Page): Promise<number> {
  const pairSelect = page.getByTestId('swap-pair-select').first();
  await pairSelect.scrollIntoViewIfNeeded().catch(() => {});
  await expect(pairSelect).toBeVisible({ timeout: 20_000 });
  const pairOptions = (await pairSelect.locator('option').allTextContents())
    .map((text) => text.trim())
    .filter((text) => text.length > 0);
  if (pairOptions.length === 0) throw new Error('No pair options found');
  const expectedPairs = CANONICAL_SWAP_PAIR_LABELS;
  for (const expectedPair of expectedPairs) {
    if (!pairOptions.includes(expectedPair)) {
      throw new Error(`Expected pair ${expectedPair} is missing from swap pair options`);
    }
  }
  const unexpectedPairs = pairOptions.filter((pair) => !expectedPairs.includes(pair));
  if (unexpectedPairs.length > 0) {
    throw new Error(`Unexpected swap pair options found: ${unexpectedPairs.join(', ')}`);
  }
  const preferredPairs = ['WETH/USDC', 'USDC/USDT', 'WETH/USDT'].filter((pair) => pairOptions.includes(pair));
  if (preferredPairs.length === 0) {
    throw new Error('No executable WETH/* pair is available in swap pair options');
  }

  const placeButton = page.getByTestId('swap-submit-order').first();
  const amountInput = page.getByTestId('swap-order-amount').first();
  const priceInput = page.getByTestId('swap-order-price').first();
  const buySideButton = page.getByTestId('swap-side-buy').first();
  const sellSideButton = page.getByTestId('swap-side-sell').first();
  await expect(amountInput).toBeVisible({ timeout: 20_000 });
  await expect(priceInput).toBeVisible({ timeout: 20_000 });
  await expect(buySideButton).toBeVisible({ timeout: 20_000 });
  await expect(sellSideButton).toBeVisible({ timeout: 20_000 });
  const deadline = Date.now() + 30_000;
  let lastFormError = '';
  while (Date.now() < deadline) {
    for (const pairLabel of preferredPairs) {
      await pairSelect.selectOption({ label: pairLabel });
      await page.waitForTimeout(250);
      const sidesToTry: Array<{
        mode: 'buy' | 'sell';
        button: Locator;
        rows: Locator;
        pick: 'first' | 'last';
      }> = [];

      const asks = page.getByTestId('orderbook-ask-row');
      const bids = page.getByTestId('orderbook-bid-row');
      const askCount = await asks.count();
      const bidCount = await bids.count();

      if (askCount > 0) sidesToTry.push({ mode: 'buy', button: buySideButton, rows: asks, pick: 'last' });
      if (bidCount > 0) sidesToTry.push({ mode: 'sell', button: sellSideButton, rows: bids, pick: 'first' });

      for (const side of sidesToTry) {
        await side.button.click();
        await page.waitForTimeout(120);

        try {
          if (side.pick === 'last') {
            await side.rows.last().click();
          } else {
            await side.rows.first().click();
          }
          await expect(page.getByTestId('swap-size-hint').first()).toBeVisible({ timeout: 5_000 });
        } catch {
          continue;
        }

        const available = await readAvailableFromSizing(page);
        if (!Number.isFinite(available) || available <= 0) continue;
        const rawPriceText = await priceInput.inputValue().catch(() => '');
        const levelPrice = parseFirstNumber(rawPriceText);
        let targetAmount = 0;
        if (side.mode === 'buy') {
          // Buy-base mode spends quote directly; enforce min-notional headroom.
          if (available < 100) continue;
          targetAmount = Math.min(available, 120);
        } else {
          // Sell-base mode spends base; ensure quote notional >=100 at selected level price.
          if (!Number.isFinite(levelPrice) || levelPrice <= 0) continue;
          const minBaseFor100 = 100 / levelPrice;
          const desiredBase = Math.max(minBaseFor100 * 1.05, 0.02);
          if (available < desiredBase) continue;
          targetAmount = Math.min(available, Math.max(desiredBase, 0.1));
        }
        if (!Number.isFinite(targetAmount) || targetAmount <= 0) continue;
        await amountInput.fill(formatDecimalForInput(targetAmount));
        await page.waitForTimeout(80);

        if (await placeButton.isEnabled()) {
          return targetAmount;
        }
      }
    }

    const formError = await page.getByTestId('swap-form-error').first().textContent().catch(() => null);
    if (formError?.trim()) lastFormError = formError.trim();
    await page.waitForTimeout(450);
  }

  throw new Error(`No preferred WETH pair is executable${lastFormError ? ` (${lastFormError})` : ''}`);
}

async function executeOrderbookClickFill(
  page: Page,
  accountRef: { entityId: string; signerId: string; counterpartyId: string; hubIds: string[] },
  clickTarget: 'lowest-ask' | 'highest-bid' | 'mid-price',
): Promise<{ routedCounterpartyId: string }> {
  const orderbookLogs: string[] = [];
  const onConsole = (msg: { text(): string }) => {
    const text = msg.text();
    if (text.includes('ORDERBOOK') || text.includes('Swap offer placed') || text.includes('Failed to place swap')) {
      orderbookLogs.push(text);
      if (orderbookLogs.length > 40) orderbookLogs.shift();
    }
  };
  page.on('console', onConsole as any);
  const readOrderbookDebug = async () => await page.evaluate(({ entityId, signerId, counterpartyId }) => {
    const env = (window as any).isolatedEnv;
    const accountSelect = document.querySelector('[data-testid="swap-account-select"]') as HTMLSelectElement | null;
    const scopeToggle = document.querySelector('[data-testid="swap-scope-toggle"]') as HTMLButtonElement | null;
    const pairSelect = document.querySelector('[data-testid="swap-pair-select"]') as HTMLSelectElement | null;
    const amountInput = document.querySelector('[data-testid="swap-order-amount"]') as HTMLInputElement | null;
    const priceInput = document.querySelector('[data-testid="swap-order-price"]') as HTMLInputElement | null;
    const formError = (document.querySelector('.swap-panel .form-error') as HTMLElement | null)?.innerText || '';
    if (!env?.eReplicas) return null;
    const key = Array.from(env.eReplicas.keys()).find((k: string) => {
      const [eid, sid] = String(k).split(':');
      return String(eid || '').toLowerCase() === String(entityId).toLowerCase()
        && String(sid || '').toLowerCase() === String(signerId).toLowerCase();
    });
    const rep = key ? env.eReplicas.get(key) : null;
    const account = rep?.state?.accounts?.get?.(counterpartyId);
    const offer = account?.swapOffers instanceof Map ? Array.from(account.swapOffers.values())[0] : null;
    let swapResolveCount = 0;
    let positiveSwapResolveCount = 0;
    for (const frame of account?.frameHistory || []) {
      for (const tx of frame?.accountTxs || []) {
        if (tx?.type !== 'swap_resolve') continue;
        swapResolveCount += 1;
        if (Number(tx?.data?.fillRatio || 0) > 0) positiveSwapResolveCount += 1;
      }
    }
    const hubRepKey = Array.from(env.eReplicas.keys()).find((k: string) => String(k).split(':')[0]?.toLowerCase() === String(counterpartyId).toLowerCase());
    const hubRep = hubRepKey ? env.eReplicas.get(hubRepKey) : null;
    const book = hubRep?.state?.orderbookExt?.books?.get?.('1/2');
    const readLevels = (headArray: any, nextArray: any, priceIdx: any, qtyLots: any, ownerIdx: any, owners: any, active: any, startIdx: number) => {
      const out = [];
      let idx = startIdx;
      while (idx !== -1 && out.length < 5) {
        if (active?.[idx]) {
          out.push({
            idx,
            owner: owners?.[ownerIdx?.[idx]],
            qtyLots: qtyLots?.[idx],
            priceIdx: priceIdx?.[idx],
          });
        }
        idx = nextArray?.[idx] ?? -1;
      }
      return out;
    };
    const bestAskIdx = Number(book?.bestAskIdx ?? -1);
    const bestBidIdx = Number(book?.bestBidIdx ?? -1);
    return {
      selectedAccountId: accountSelect?.value || '',
      scopeMode: scopeToggle?.innerText?.trim() || '',
      selectedPairId: pairSelect?.value || '',
      amountInput: amountInput?.value || '',
      priceInput: priceInput?.value || '',
      formError,
      swapDebug: (window as any).__swapDebug ?? null,
      swapResolveCount,
      positiveSwapResolveCount,
      localOffer: offer ? {
        offerId: offer.offerId,
        giveTokenId: String(offer.giveTokenId),
        wantTokenId: String(offer.wantTokenId),
        giveAmount: String(offer.giveAmount),
        wantAmount: String(offer.wantAmount),
        priceTicks: String(offer.priceTicks ?? ''),
        timeInForce: offer.timeInForce ?? null,
        makerIsLeft: offer.makerIsLeft,
        fromEntity: offer.fromEntity,
        toEntity: offer.toEntity,
      } : null,
      hubBook: book ? {
        bestAskIdx,
        bestBidIdx,
        bestAskHead: bestAskIdx >= 0 ? Number(book.levelHeadAsk?.[bestAskIdx] ?? -1) : -1,
        bestBidHead: bestBidIdx >= 0 ? Number(book.levelHeadBid?.[bestBidIdx] ?? -1) : -1,
        askTop: bestAskIdx >= 0
          ? readLevels(book.levelHeadAsk, book.orderNext, book.orderPriceIdx, book.orderQtyLots, book.orderOwnerIdx, book.owners, book.orderActive, Number(book.levelHeadAsk?.[bestAskIdx] ?? -1))
          : [],
        bidTop: bestBidIdx >= 0
          ? readLevels(book.levelHeadBid, book.orderNext, book.orderPriceIdx, book.orderQtyLots, book.orderOwnerIdx, book.owners, book.orderActive, Number(book.levelHeadBid?.[bestBidIdx] ?? -1))
          : [],
      } : null,
    };
  }, accountRef);
  const pairSelect = page.getByTestId('swap-pair-select').first();
  try {
    await expect(pairSelect).toBeVisible({ timeout: 20_000 });
    await pairSelect.selectOption({ label: 'WETH/USDC' });
    await page.waitForTimeout(250);

    const buySideButton = page.getByTestId('swap-side-buy').first();
    const sellSideButton = page.getByTestId('swap-side-sell').first();
    const placeButton = page.getByTestId('swap-submit-order').first();
    await expect(buySideButton).toBeVisible({ timeout: 20_000 });
    await expect(sellSideButton).toBeVisible({ timeout: 20_000 });
    if (clickTarget === 'highest-bid') {
      await sellSideButton.click();
    } else {
      await buySideButton.click();
    }
    await page.waitForTimeout(120);

    let clickedDisplayedPrice = '';
    if (clickTarget === 'lowest-ask') {
      const asks = page.getByTestId('orderbook-ask-row');
      await expect(asks.last()).toBeVisible({ timeout: 20_000 });
      clickedDisplayedPrice = String(await asks.last().locator('.price').textContent() || '').trim();
      await asks.last().click();
    } else if (clickTarget === 'highest-bid') {
      const bids = page.getByTestId('orderbook-bid-row');
      await expect(bids.first()).toBeVisible({ timeout: 20_000 });
      clickedDisplayedPrice = String(await bids.first().locator('.price').textContent() || '').trim();
      await bids.first().click();
    } else {
      const mid = page.getByTestId('orderbook-mid-row').first();
      await expect(mid).toBeVisible({ timeout: 20_000 });
      clickedDisplayedPrice = String(await mid.locator('.mid-price').textContent() || '').trim();
      await mid.click();
    }

    await expect(
      page.getByTestId('swap-size-hint').first(),
    ).toBeVisible({ timeout: 10_000 });
    const priceInput = page.getByTestId('swap-order-price').first();
    await expect(priceInput).toBeVisible({ timeout: 10_000 });
    if (clickedDisplayedPrice) {
      await expect.poll(async () => String(await priceInput.inputValue()).trim(), {
        timeout: 10_000,
        intervals: [50, 100, 200],
      }).toBe(normalizeDisplayedPriceText(clickedDisplayedPrice));
    }
    const scopeToggle = page.getByTestId('swap-scope-toggle').first();
    const selectedHub = page.getByTestId('swap-account-select').first();
    await expect
      .poll(async () => await readSwapScopeMode(page), { timeout: 10_000, intervals: [50, 100, 200] })
      .toBe('aggregated');
    await expect.poll(async () => String(await selectedHub.inputValue()).trim(), {
      timeout: 10_000,
      intervals: [50, 100, 200],
    }).not.toBe('');
    const routedCounterpartyId = String(await selectedHub.inputValue()).trim();
    const resolveCountBefore = await readPositiveSwapResolveCount(
      page,
      accountRef.entityId,
      accountRef.signerId,
      routedCounterpartyId,
    );
    await expect(placeButton).toBeEnabled({ timeout: 10_000 });
    await placeButton.click();

    await expect
      .poll(
        async () => await readPositiveSwapResolveCount(page, accountRef.entityId, accountRef.signerId, routedCounterpartyId),
        { timeout: 30_000, intervals: [100, 250, 500, 1000] },
      )
      .toBeGreaterThan(resolveCountBefore);

    await expect
      .poll(
        async () => {
          const state = await readSwapState(page, accountRef.entityId, accountRef.signerId, routedCounterpartyId);
          return {
            accountSwapOffersSize: state.accountSwapOffersSize,
            accountHasSwapOfferInMempool: state.accountHasSwapOfferInMempool,
            accountHasSwapOfferInPendingFrame: state.accountHasSwapOfferInPendingFrame,
          };
        },
        { timeout: 30_000, intervals: [100, 250, 500, 1000] },
      )
      .toEqual({
        accountSwapOffersSize: 0,
        accountHasSwapOfferInMempool: false,
        accountHasSwapOfferInPendingFrame: false,
      });

    await expect
      .poll(async () => await page.getByTestId('swap-open-order-row').count(), {
        timeout: 15_000,
        intervals: [100, 250, 500],
      })
      .toBe(0);
    const closedTab = page.getByTestId('swap-orders-tab-closed').first();
    await expect(closedTab).toBeVisible({ timeout: 10_000 });
    const fillModal = page.locator('.swap-modal').first();
    const fillModalVisible = await fillModal
      .waitFor({ state: 'visible', timeout: 2_000 })
      .then(() => true)
      .catch(() => false);
    if (fillModalVisible) {
      await expect(fillModal).toContainText(/Swap Filled/i, { timeout: 10_000 });
      await fillModal.getByRole('button', { name: /Close/i }).click();
    }
    await closedTab.click();
    const closedOrdersTable = page.getByTestId('swap-closed-orders').first();
    const closedOrdersVisible = await closedOrdersTable
      .waitFor({ state: 'visible', timeout: 2_000 })
      .then(() => true)
      .catch(() => false);
    if (closedOrdersVisible) {
      const firstClosedRow = closedOrdersTable.locator('tbody tr').first();
      const firstClosedRowVisible = await firstClosedRow
        .waitFor({ state: 'visible', timeout: 2_000 })
        .then(() => true)
        .catch(() => false);
      if (firstClosedRowVisible) {
        await expect(firstClosedRow.locator('td').first()).toContainText(/Filled/i, { timeout: 10_000 });
        await expect(firstClosedRow.locator('td').first()).not.toContainText(/Partial/i, { timeout: 10_000 });
      }
    }
    return { routedCounterpartyId };
  } catch (error) {
    const debugState = await readOrderbookDebug().catch(() => null);
    console.error(`[E2E-ORDERBOOK-DEBUG] ${clickTarget} recent logs:\n${orderbookLogs.join('\n')}`);
    console.error(`[E2E-ORDERBOOK-STATE] ${clickTarget} ${JSON.stringify(debugState, null, 2)}`);
    throw error;
  } finally {
    page.off('console', onConsole as any);
  }
}

async function expectAllCanonicalSwapPairsHaveLiquidity(page: Page): Promise<void> {
  const pairSelect = page.getByTestId('swap-pair-select').first();
  await expect(pairSelect).toBeVisible({ timeout: 20_000 });
  await ensureSwapScope(page, 'aggregated');
  const expectedPairs = CANONICAL_SWAP_PAIR_LABELS;

  for (const pairLabel of expectedPairs) {
    await waitForSwapOrderbookLiquidity(page, pairLabel, { scope: 'Aggregated', minSources: 3 });
    await expect
      .poll(async () => {
        const { asks, bids } = await readOrderbookRowCounts(page);
        const uniqueSourceIds = await countUniqueOrderbookSources(page);
        return { asks, bids, rows: asks + bids, sources: uniqueSourceIds };
      }, {
        timeout: 15_000,
        intervals: [250, 500, 1000],
        message: `orderbook for ${pairLabel} should have visible liquidity from 3 hubs`,
      })
      .toEqual(expect.objectContaining({
        asks: 10,
        bids: 10,
        rows: expect.any(Number),
        sources: 3,
      }));
    await expectVisibleOrderbookDepth(page, { asks: 10, bids: 10 }, { timeoutMs: 5_000, minSources: 3, maxSources: 3 });
  }
}

async function readAvailableFromSizing(page: Page): Promise<number> {
  const stat = page.getByTestId('swap-available-stat').first();
  await expect(stat).toBeVisible({ timeout: 20_000 });
  const text = String((await stat.textContent()) || '');
  const available = parseFirstNumber(text);
  if (!Number.isFinite(available)) throw new Error(`Cannot parse available amount: ${text}`);
  return available;
}

async function selectSwapAccount(page: Page, accountId: string): Promise<void> {
  const accountSelect = page.getByTestId('swap-account-select').first();
  await expect(accountSelect).toBeVisible({ timeout: 20_000 });
  await accountSelect.selectOption(accountId);
  await page.waitForTimeout(200);
}

async function readFirstOpenOrderRemaining(page: Page): Promise<number> {
  const remainingCell = page.getByTestId('swap-open-order-row').first().locator('td').nth(3);
  await expect(remainingCell).toBeVisible({ timeout: 30_000 });
  const text = String((await remainingCell.textContent()) || '');
  const value = parseFirstNumber(text);
  if (!Number.isFinite(value)) throw new Error(`Cannot parse remaining amount: ${text}`);
  return value;
}

async function expectMarketMakerBooksHealthy(page: Page): Promise<void> {
  const health = await getHealth(page, API_BASE_URL);
  expect(health?.marketMaker?.ok, 'market maker health must be ready').toBe(true);
  const hubs = health?.marketMaker?.hubs ?? [];
  expect(hubs.length, 'market maker health must expose 3 hubs').toBeGreaterThanOrEqual(3);
  for (const hub of hubs) {
    expect(hub.ready, `market maker hub ${hub.hubEntityId} must be ready`).toBe(true);
    for (const pair of hub.pairs ?? []) {
      expect(pair.ready, `market maker pair ${pair.pairId} on hub ${hub.hubEntityId} must be ready`).toBe(true);
      expect(pair.offers, `market maker pair ${pair.pairId} on hub ${hub.hubEntityId} must have enough resting offers for a 10x10 UI book`).toBeGreaterThanOrEqual(20);
    }
  }
}

async function expectSelectedBooksShowTenByTen(
  page: Page,
  pairLabels: string[],
  selectedAccountIds: string[],
): Promise<void> {
  const pairSelect = page.getByTestId('swap-pair-select').first();
  const accountSelect = page.getByTestId('swap-account-select').first();
  await expect(pairSelect).toBeVisible({ timeout: 20_000 });
  await expect(accountSelect).toBeVisible({ timeout: 20_000 });
  await ensureSwapScope(page, 'selected');
  for (const accountId of selectedAccountIds) {
    await accountSelect.selectOption(accountId);
    await page.waitForTimeout(200);
    for (const pairLabel of pairLabels) {
      await pairSelect.selectOption({ label: pairLabel });
      await waitForSwapOrderbookLiquidity(page, pairLabel, {
        preferredAccountId: accountId,
        scope: 'Selected',
        minSources: 1,
      });
      await expectVisibleOrderbookDepth(page, { asks: 10, bids: 10 }, {
        timeoutMs: 10_000,
        minSources: 1,
        maxSources: 1,
      });
    }
  }
  await ensureSwapScope(page, 'aggregated');
}

test.describe('E2E Swap Flow', () => {
  test.setTimeout(240_000);

  test.beforeEach(async ({ page }) => {
    await timedStep('swap.ensure_baseline', () => ensureE2EBaseline(page, {
      requireMarketMaker: true,
      requireHubMesh: true,
      minHubCount: 3,
    }));
  });

  test('swap shows 10x10 depth on all canonical pairs and selected books', async ({ page }) => {
    await timedStep('swap_pairs.goto_app', () => gotoApp(page));
    await timedStep('swap_pairs.dismiss_onboarding', () => dismissOnboardingIfVisible(page));
    await timedStep('swap_pairs.create_runtime', () => createDemoRuntime(page, `swap-pairs-${Date.now()}`, randomMnemonic()));
    const runtimeRef = await timedStep('swap_pairs.ensure_hub_accounts', () => ensureDeterministicSwapAccounts(page, 3));
    await timedStep('swap_pairs.open_workspace', () => openSwapWorkspace(page));
    await timedStep('swap_pairs.check_mm_health', () => expectMarketMakerBooksHealthy(page));
    await timedStep('swap_pairs.check_aggregated_depth', () => expectAllCanonicalSwapPairsHaveLiquidity(page));
    await timedStep('swap_pairs.check_selected_depth', () =>
      expectSelectedBooksShowTenByTen(page, CANONICAL_SWAP_PAIR_LABELS, runtimeRef.hubIds.slice(0, 3)));
  });

  // Scenario: place a valid non-marketable WETH/USDC offer through the visible swap UI
  // and verify the open order survives a reload.
  test('swap place WETH/USDC offer survives reload', async ({ page }) => {
    await timedStep('swap_auto.goto_app', () => gotoApp(page));
    await timedStep('swap_auto.dismiss_onboarding', () => dismissOnboardingIfVisible(page));
    await timedStep('swap_auto.create_runtime', () => createDemoRuntime(page, `swap-auto-${Date.now()}`, randomMnemonic()));
    const accountRef = await timedStep('swap_auto.ensure_hub_account', () => ensureDeterministicSwapAccount(page));

    await timedStep('swap_auto.open_workspace', () => openSwapWorkspace(page));
    await timedStep('swap_auto.select_counterparty', () => selectCounterpartyInSwap(page, accountRef.counterpartyId));

    const pairSelect = page.getByTestId('swap-pair-select').first();
    await pairSelect.scrollIntoViewIfNeeded().catch(() => {});
    await expect(pairSelect).toBeVisible({ timeout: 20_000 });
    await pairSelect.selectOption({ label: 'WETH/USDC' });

    const amountInput = page.getByTestId('swap-order-amount').first();
    await expect(amountInput).toBeVisible({ timeout: 20_000 });
    const priceInput = page.getByTestId('swap-order-price').first();
    await expect(priceInput).toBeVisible({ timeout: 20_000 });
    const placeButton = page.getByTestId('swap-submit-order').first();
    const buySide = page.getByTestId('swap-side-buy').first();
    const sellSide = page.getByTestId('swap-side-sell').first();
    const accountSelect = page.getByTestId('swap-account-select').first();
    const scopeToggle = page.getByTestId('swap-scope-toggle').first();
    await expect(buySide).toBeVisible({ timeout: 20_000 });
    await expect(sellSide).toBeVisible({ timeout: 20_000 });
    await expect(accountSelect).toBeVisible({ timeout: 20_000 });
    await expect(scopeToggle).toBeVisible({ timeout: 20_000 });
    if (String(await scopeToggle.textContent() || '').trim() !== 'Selected') {
      await scopeToggle.click();
    }

    const accountValues = await accountSelect.locator('option').evaluateAll((options) =>
      options.map((option) => String((option as HTMLOptionElement).value || '')).filter((value) => value.length > 0),
    );
    let configured = false;
    let chosenCreateAccountValue: string | null = null;
    for (const accountValue of accountValues) {
      await accountSelect.selectOption(accountValue);
      await page.waitForTimeout(150);

      await buySide.click();
      await page.waitForTimeout(150);
      const buyAvailable = await readAvailableFromSizing(page).catch(() => 0);
      if (Number.isFinite(buyAvailable) && buyAvailable >= 10) {
        await amountInput.fill(formatDecimalForInput(Math.min(buyAvailable, 25)));
        await priceInput.fill('2490');
        await page.waitForTimeout(350);
        if (await placeButton.isEnabled()) {
          chosenCreateAccountValue = accountValue;
          configured = true;
          break;
        }
      }

      await sellSide.click();
      await page.waitForTimeout(150);
      const sellAvailable = await readAvailableFromSizing(page).catch(() => 0);
      if (Number.isFinite(sellAvailable) && sellAvailable >= 0.004) {
        await amountInput.fill(formatDecimalForInput(Math.min(sellAvailable, 0.01)));
        await priceInput.fill('2510');
        await page.waitForTimeout(350);
        if (await placeButton.isEnabled()) {
          chosenCreateAccountValue = accountValue;
          configured = true;
          break;
        }
      }
    }

    expect(configured, 'Expected at least one swap account/side combination to support a valid WETH/USDC offer').toBe(true);
    await expect(placeButton).toBeEnabled({ timeout: 5_000 });

    await timedStep('swap_auto.place_offer', async () => {
      await placeButton.click();
      await expect
        .poll(
          async () => {
            const rows = await page.getByTestId('swap-open-order-row').count();
            return rows > 0;
          },
          { timeout: 60_000 },
        )
        .toBe(true);
      const settledAccountId = chosenCreateAccountValue || accountRef.counterpartyId;
      await page.waitForFunction(
        ({ entityId, accountId }) => {
          const env = (window as any).isolatedEnv;
          if (!env?.eReplicas || !(env.eReplicas instanceof Map)) return false;
          const targetEntityId = String(entityId || '').toLowerCase();
          const targetAccountId = String(accountId || '').toLowerCase();
          const replica = Array.from(env.eReplicas.values()).find((candidate: any) =>
            String(candidate?.entityId || '').toLowerCase() === targetEntityId,
          );
          const account = replica?.state?.accounts?.get?.(targetAccountId);
          if (!account) return false;
          const offerCount = account.swapOffers instanceof Map ? account.swapOffers.size : 0;
          const pendingCount = Array.isArray(account.mempool) ? account.mempool.length : 0;
          return offerCount > 0 && !account.pendingFrame && pendingCount === 0;
        },
        { entityId: accountRef.entityId, accountId: settledAccountId },
        { timeout: 60_000 },
      );
      await page.waitForTimeout(1200);
    });

    await timedStep('swap_auto.reload_page', async () => {
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => {
        const env = (window as any).isolatedEnv;
        return !!env?.runtimeId && Number(env?.eReplicas?.size || 0) > 0;
      }, { timeout: 60_000 });
      await openSwapWorkspace(page);
      await selectCounterpartyInSwap(page, accountRef.counterpartyId);
      if (chosenCreateAccountValue) {
        const accountSelectAfterReload = page.getByTestId('swap-account-select').first();
        const scopeToggleAfterReload = page.getByTestId('swap-scope-toggle').first();
        if (String(await scopeToggleAfterReload.textContent() || '').trim() !== 'Selected') {
          await scopeToggleAfterReload.click();
        }
        await accountSelectAfterReload.selectOption(chosenCreateAccountValue);
      }
    });
    await timedStep('swap_auto.reload_assert_offer_persisted', async () => {
      await expect
        .poll(
          async () => {
            const rows = await page.getByTestId('swap-open-order-row').count();
            return rows > 0;
          },
          { timeout: 60_000 },
        )
        .toBe(true);
    });
  });

  // Scenario: place a non-marketable order, cancel it from the UI, and verify both state machine
  // and rendered order table clear before and after reload.
  test('swap place and cancel from UI updates state machine', async ({ page }) => {
    await timedStep('swap.goto_app', () => gotoApp(page));
    await timedStep('swap.dismiss_onboarding', () => dismissOnboardingIfVisible(page));
    await timedStep('swap.create_runtime', () => createDemoRuntime(page, `swap-rt-${Date.now()}`, randomMnemonic()));
    const accountRef = await timedStep('swap.ensure_hub_account', () => ensureDeterministicSwapAccount(page));

    await timedStep('swap.open_workspace', () => openSwapWorkspace(page));
    await timedStep('swap.select_counterparty', () => selectCounterpartyInSwap(page, accountRef.counterpartyId));

    await expect(page.getByTestId('swap-orderbook')).toBeVisible({ timeout: 20_000 });
    const swapResolveCountBefore = await timedStep('swap.read_resolve_count_before', () =>
      readSwapResolveCount(page, accountRef.entityId, accountRef.signerId, accountRef.counterpartyId),
    );

    const pairSelect = page.getByTestId('swap-pair-select').first();
    await pairSelect.scrollIntoViewIfNeeded().catch(() => {});
    await expect(pairSelect).toBeVisible({ timeout: 20_000 });
    await pairSelect.selectOption({ label: 'WETH/USDC' });
    const buySideButton = page.getByTestId('swap-side-buy').first();
    await expect(buySideButton).toBeVisible({ timeout: 20_000 });
    await buySideButton.click();
    const amountInput = page.getByTestId('swap-order-amount').first();
    const priceInput = page.getByTestId('swap-order-price').first();
    await expect(amountInput).toBeVisible({ timeout: 20_000 });
    await expect(priceInput).toBeVisible({ timeout: 20_000 });
    const availableGive = await readAvailableFromSizing(page);
    const orderAmount = availableGive >= 100 ? 100 : Math.max(0.000001, Math.min(availableGive, 1));
    await amountInput.fill(formatDecimalForInput(orderAmount));
    // Non-marketable limit => deterministic open order, then cancel path.
    await priceInput.fill('2000');
    await page.waitForTimeout(200);

    const placeButton = page.getByTestId('swap-submit-order').first();
    await expect(placeButton).toBeEnabled({ timeout: 20_000 });
    await timedStep('swap.place_offer', async () => {
      await placeButton.click();
      await expect(page.getByTestId('swap-open-orders')).toBeVisible({ timeout: 60_000 });
    });
    const openOrderRow = page.getByTestId('swap-open-order-row').first();
    await timedStep('swap.capture_offer_row', async () => {
      await expect(openOrderRow).toBeVisible({ timeout: 30_000 });
    });

    await timedStep('swap.assert_non_marketable_order_stays_open', async () => {
      const remaining = await readFirstOpenOrderRemaining(page);
      expect(remaining, 'non-marketable order must remain open before cancel').toBeGreaterThan(0);
      await expect
        .poll(
          async () => await readSwapResolveCount(page, accountRef.entityId, accountRef.signerId, accountRef.counterpartyId),
          { timeout: 5_000, intervals: [250, 500, 1000] },
        )
        .toBe(swapResolveCountBefore);
    });

    const cancelButton = page.getByTestId('swap-open-order-cancel').first();
    await expect(cancelButton).toBeVisible({ timeout: 20_000 });
    await timedStep('swap.cancel_offer', async () => {
      await cancelButton.click({ force: true });
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

    await timedStep('swap.wait_closed_orderbook_ui', async () => {
      await expect
        .poll(async () => await page.getByTestId('swap-open-order-row').count(), { timeout: 60_000 })
        .toBe(0);
    });

    await timedStep('swap.assert_post_close_state', async () => {
      const state = await readSwapState(page, accountRef.entityId, accountRef.signerId, accountRef.counterpartyId);
      expect(state.accountSwapOffersSize).toBe(0);
    });

    await timedStep('swap.reload_page', async () => {
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => {
        const env = (window as any).isolatedEnv;
        return !!env?.runtimeId && Number(env?.eReplicas?.size || 0) > 0;
      }, { timeout: 60_000 });
    });
    await timedStep('swap.reload_assert_no_open_offer', async () => {
      await expect.poll(async () => {
        const state = await readSwapState(page, accountRef.entityId, accountRef.signerId, accountRef.counterpartyId);
        return state.accountSwapOffersSize;
      }, { timeout: 60_000 }).toBe(0);
    });
    await timedStep('swap.reload_assert_ui_no_rows', async () => {
      await expect.poll(async () => await page.getByTestId('swap-open-order-row').count(), {
        timeout: 60_000,
      }).toBe(0);
    });
  });

async function prepareOrderbookClickTest(page: Page): Promise<{
  entityId: string;
  signerId: string;
  counterpartyId: string;
  hubIds: string[];
}> {
    await timedStep('swap_click.goto_app', () => gotoApp(page));
    await timedStep('swap_click.dismiss_onboarding', () => dismissOnboardingIfVisible(page));
    await timedStep('swap_click.create_runtime', () => createDemoRuntime(page, `swap-click-${Date.now()}`, randomMnemonic()));
    const runtimeRef = await timedStep('swap_click.ensure_hub_account', () => ensureDeterministicSwapAccounts(page, 3));

    for (const hubId of runtimeRef.hubIds) {
      for (const funding of [
        { tokenId: 1, amount: '100' },
        { tokenId: 2, amount: '1' },
      ]) {
        const faucetResponse = await page.request.post(`${API_BASE_URL}/api/faucet/offchain`, {
          data: {
            userEntityId: runtimeRef.entityId,
            userRuntimeId: runtimeRef.runtimeId,
            hubEntityId: hubId,
            tokenId: funding.tokenId,
            amount: funding.amount,
          },
        });
        const faucetBody = await faucetResponse.json().catch(() => ({}));
        expect(
          faucetResponse.ok(),
          `swap click faucet failed for hub ${hubId} token ${funding.tokenId}: ${JSON.stringify(faucetBody)}`,
        ).toBe(true);
      }
    }

    for (const hubId of runtimeRef.hubIds) {
      await expect.poll(async () => {
        return await readAccountTokenOutCapacity(page, runtimeRef.entityId, runtimeRef.signerId, hubId, 2);
      }, { timeout: 60_000, intervals: [250, 500, 1000] }).toBeGreaterThan(0);
    }

    await timedStep('swap_click.open_workspace', () => openSwapWorkspace(page));
    await timedStep('swap_click.select_counterparty', () => selectCounterpartyInSwap(page, runtimeRef.hubIds[0]!));
    await expect(page.getByTestId('swap-orderbook')).toBeVisible({ timeout: 20_000 });
    await waitForSwapOrderbookLiquidity(page, 'WETH/USDC', {
      preferredAccountId: runtimeRef.hubIds[0]!,
      scope: 'Aggregated',
      minSources: 3,
    });
    return {
      entityId: runtimeRef.entityId,
      signerId: runtimeRef.signerId,
      counterpartyId: runtimeRef.hubIds[0]!,
      hubIds: runtimeRef.hubIds,
    };
  }

  test('swap orderbook lowest ask click fills immediately at displayed book price', async ({ page }) => {
    const accountRef = await prepareOrderbookClickTest(page);

    await timedStep('swap_click.lowest_ask_fills', () =>
      executeOrderbookClickFill(page, accountRef, 'lowest-ask'),
    );
  });

  test('swap orderbook highest bid click fills immediately at displayed book price', async ({ page }) => {
    const accountRef = await prepareOrderbookClickTest(page);

    await timedStep('swap_click.highest_bid_fills', () =>
      executeOrderbookClickFill(page, accountRef, 'highest-bid'),
    );
  });

  test('swap orderbook mid price click fills immediately at displayed book price', async ({ page }) => {
    const accountRef = await prepareOrderbookClickTest(page);
    await timedStep('swap_click.mid_price_fills', () =>
      executeOrderbookClickFill(page, accountRef, 'mid-price'),
    );
  });

  test('swap can buy from asks and then sell back into bids on the same book', async ({ page }) => {
    const accountRef = await prepareOrderbookClickTest(page);
    const buyResult = await timedStep('swap_roundtrip.buy_fill', () =>
      executeOrderbookClickFill(page, accountRef, 'lowest-ask'));
    await waitForSwapOrderbookLiquidity(page, 'WETH/USDC', {
      preferredAccountId: buyResult.routedCounterpartyId,
      scope: 'Aggregated',
      minSources: 3,
    });
    await timedStep('swap_roundtrip.sell_fill', () =>
      executeOrderbookClickFill(page, accountRef, 'highest-bid'));
  });

  test('swap manual price override after book click uses the edited limit price', async ({ page }) => {
    const accountRef = await prepareOrderbookClickTest(page);
    await waitForSwapOrderbookLiquidity(page, 'WETH/USDC', {
      preferredAccountId: accountRef.counterpartyId,
      scope: 'Aggregated',
      minSources: 3,
    });

    const buySideButton = page.getByTestId('swap-side-buy').first();
    const priceInput = page.getByTestId('swap-order-price').first();
    const placeButton = page.getByTestId('swap-submit-order').first();
    await expect(buySideButton).toBeVisible({ timeout: 20_000 });
    await buySideButton.click();
    await page.waitForTimeout(120);

    const asks = page.getByTestId('orderbook-ask-row');
    await expect(asks.last()).toBeVisible({ timeout: 20_000 });
    await asks.last().click();

    await expect(page.getByTestId('swap-size-hint').first()).toBeVisible({ timeout: 10_000 });
    await priceInput.fill('2000');
    await expect(page.getByTestId('swap-size-hint')).toHaveCount(0);
    await expect(placeButton).toBeEnabled({ timeout: 10_000 });
    await placeButton.click();

    const firstRow = page.getByTestId('swap-open-order-row').first();
    await expect(firstRow).toBeVisible({ timeout: 30_000 });
    await expect(firstRow.locator('td').nth(2)).toHaveText('2000', { timeout: 10_000 });

    const cancelButton = firstRow.getByTestId('swap-open-order-cancel');
    await expect(cancelButton).toBeVisible({ timeout: 10_000 });
    await cancelButton.click({ force: true });
    await expect
      .poll(async () => await page.getByTestId('swap-open-order-row').count(), {
        timeout: 60_000,
        intervals: [100, 250, 500, 1000],
      })
      .toBe(0);
  });

  test('swap rejects price beyond 30% from current orderbook', async ({ page }) => {
    const accountRef = await prepareOrderbookClickTest(page);
    await waitForSwapOrderbookLiquidity(page, 'WETH/USDC', {
      preferredAccountId: accountRef.counterpartyId,
      scope: 'Aggregated',
      minSources: 3,
    });

    const buySideButton = page.getByTestId('swap-side-buy').first();
    const amountInput = page.getByTestId('swap-order-amount').first();
    const priceInput = page.getByTestId('swap-order-price').first();
    const placeButton = page.getByTestId('swap-submit-order').first();
    await buySideButton.click();

    const asks = page.getByTestId('orderbook-ask-row');
    await expect(asks.last()).toBeVisible({ timeout: 20_000 });
    const bestAskText = String(await asks.last().locator('.price').textContent() || '').trim();
    const bestAsk = Number.parseFloat(normalizeDisplayedPriceText(bestAskText));
    expect(Number.isFinite(bestAsk) && bestAsk > 0, `best ask missing: ${bestAskText}`).toBe(true);

    await amountInput.fill('10');
    await priceInput.fill(String((bestAsk * 1.4).toFixed(4)));
    await expect(placeButton).toBeDisabled({ timeout: 10_000 });
    await expect(page.getByTestId('swap-form-error').first()).toContainText(/within 30% of the current orderbook/i, {
      timeout: 10_000,
    });
  });

  test('swap rejects sell price beyond 30% from current orderbook', async ({ page }) => {
    const accountRef = await prepareOrderbookClickTest(page);
    await waitForSwapOrderbookLiquidity(page, 'WETH/USDC', {
      preferredAccountId: accountRef.counterpartyId,
      scope: 'Aggregated',
      minSources: 3,
    });

    const sellSideButton = page.getByTestId('swap-side-sell').first();
    const amountInput = page.getByTestId('swap-order-amount').first();
    const priceInput = page.getByTestId('swap-order-price').first();
    const placeButton = page.getByTestId('swap-submit-order').first();
    await sellSideButton.click();

    const bids = page.getByTestId('orderbook-bid-row');
    await expect(bids.first()).toBeVisible({ timeout: 20_000 });
    const bestBidText = String(await bids.first().locator('.price').textContent() || '').trim();
    const bestBid = Number.parseFloat(normalizeDisplayedPriceText(bestBidText));
    expect(Number.isFinite(bestBid) && bestBid > 0, `best bid missing: ${bestBidText}`).toBe(true);

    const available = await readAvailableFromSizing(page);
    expect(available, 'sell-side available amount must be positive').toBeGreaterThan(0);
    const sellAmount = Math.max(0.01, Math.min(available, 0.05));
    await amountInput.fill(formatDecimalForInput(sellAmount));
    await priceInput.fill(String((bestBid * 0.59).toFixed(4)));
    await expect(placeButton).toBeDisabled({ timeout: 10_000 });
    await expect(page.getByTestId('swap-form-error').first()).toContainText(/within 30% of the current orderbook/i, {
      timeout: 10_000,
    });
  });

test('swap keeps a within-band wide limit as a resting order instead of filling immediately', async ({ page }, testInfo) => {
    const accountRef = await prepareOrderbookClickTest(page);
    const pairSelect = page.getByTestId('swap-pair-select').first();
    const buySideButton = page.getByTestId('swap-side-buy').first();
    const amountInput = page.getByTestId('swap-order-amount').first();
    const priceInput = page.getByTestId('swap-order-price').first();
    const placeButton = page.getByTestId('swap-submit-order').first();

    await pairSelect.selectOption({ label: 'WETH/USDC' });
    await waitForSwapOrderbookLiquidity(page, 'WETH/USDC', {
      preferredAccountId: accountRef.counterpartyId,
      scope: 'Aggregated',
      minSources: 3,
    });
    await buySideButton.click();

    const asks = page.getByTestId('orderbook-ask-row');
    await expect(asks.last()).toBeVisible({ timeout: 20_000 });
    const bestAskText = String(await asks.last().locator('.price').textContent() || '').trim();
    const bestAsk = Number.parseFloat(normalizeDisplayedPriceText(bestAskText));
    expect(Number.isFinite(bestAsk) && bestAsk > 0, `best ask missing: ${bestAskText}`).toBe(true);

    const availableQuote = await readAvailableFromSizing(page);
    expect(availableQuote, 'buy-side available quote must be positive').toBeGreaterThan(0);
    const resolveCountBefore = await readPositiveSwapResolveCount(
      page,
      accountRef.entityId,
      accountRef.signerId,
      accountRef.counterpartyId,
    );
    await amountInput.fill(formatDecimalForInput(Math.min(availableQuote, 25)));
    await priceInput.fill(String((bestAsk * 0.85).toFixed(4)));
    await expect(page.getByTestId('swap-size-hint')).toHaveCount(0);
    await expect(placeButton).toBeEnabled({ timeout: 10_000 });
    await capturePageScreenshot(page, testInfo, 'swap-form-filled-resting-limit-desktop.png');
    await placeButton.click();

    await expect(page.getByTestId('swap-open-order-row').first()).toBeVisible({ timeout: 30_000 });
    await capturePageScreenshot(page, testInfo, 'swap-resting-order-open-desktop.png');
    await expect
      .poll(async () => await readPositiveSwapResolveCount(
        page,
        accountRef.entityId,
        accountRef.signerId,
        accountRef.counterpartyId,
      ), { timeout: 5_000, intervals: [250, 500, 1000] })
      .toBe(resolveCountBefore);
    const remaining = await readFirstOpenOrderRemaining(page);
    expect(remaining, 'within-band wide limit should remain fully open').toBeGreaterThan(0);

    const cancelButton = page.getByTestId('swap-open-order-cancel').first();
    await expect(cancelButton).toBeVisible({ timeout: 10_000 });
    await cancelButton.click({ force: true });
    await expect
      .poll(async () => await page.getByTestId('swap-open-order-row').count(), {
        timeout: 60_000,
        intervals: [100, 250, 500, 1000],
      })
      .toBe(0);
  });

  test('swap scope and account switching clears stale rows and stale book hint state', async ({ page }) => {
    const accountRef = await prepareOrderbookClickTest(page);
    const pairSelect = page.getByTestId('swap-pair-select').first();

    await ensureSwapScope(page, 'selected');
    await selectSwapAccount(page, accountRef.hubIds[0]!);
    await pairSelect.selectOption({ label: 'WETH/USDC' });
    await waitForSwapOrderbookLiquidity(page, 'WETH/USDC', {
      preferredAccountId: accountRef.hubIds[0]!,
      scope: 'Selected',
      minSources: 1,
    });
    await expectVisibleOrderbookDepth(page, { asks: 10, bids: 10 }, { timeoutMs: 10_000, minSources: 1, maxSources: 1 });

    const asks = page.getByTestId('orderbook-ask-row');
    await expect(asks.last()).toBeVisible({ timeout: 20_000 });
    await asks.last().click();
    await expect(page.getByTestId('swap-size-hint').first()).toBeVisible({ timeout: 10_000 });

    await selectSwapAccount(page, accountRef.hubIds[1]!);
    await waitForSwapOrderbookLiquidity(page, 'WETH/USDC', {
      preferredAccountId: accountRef.hubIds[1]!,
      scope: 'Selected',
      minSources: 1,
    });
    await expect(page.getByTestId('swap-size-hint')).toHaveCount(0);
    await expectVisibleOrderbookDepth(page, { asks: 10, bids: 10 }, { timeoutMs: 10_000, minSources: 1, maxSources: 1 });

    await ensureSwapScope(page, 'aggregated');
    await waitForSwapOrderbookLiquidity(page, 'WETH/USDC', {
      preferredAccountId: accountRef.hubIds[1]!,
      scope: 'Aggregated',
      minSources: 3,
    });
    await expect(page.getByTestId('swap-size-hint')).toHaveCount(0);
    await expectVisibleOrderbookDepth(page, { asks: 10, bids: 10 }, { timeoutMs: 10_000, minSources: 3, maxSources: 3 });

    await pairSelect.selectOption({ label: 'USDC/USDT' });
    await waitForSwapOrderbookLiquidity(page, 'USDC/USDT', {
      preferredAccountId: accountRef.hubIds[1]!,
      scope: 'Aggregated',
      minSources: 3,
    });
    await expect(page.getByTestId('swap-size-hint')).toHaveCount(0);
    await expectVisibleOrderbookDepth(page, { asks: 10, bids: 10 }, { timeoutMs: 10_000, minSources: 3, maxSources: 3 });
  });

});
