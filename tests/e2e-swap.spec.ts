/**
 * E2E swap coverage for the live UI and the built-in browser scenarios.
 *
 * These tests verify that swap offers can auto-prepare missing token capacity, place and cancel
 * cleanly through the UI, and that the scenario runners still produce partial fills after reload-safe setup.
 */
import { test, expect, type Locator, type Page } from '@playwright/test';
import { Wallet } from 'ethers';
import { timedStep } from './utils/e2e-timing';
import { APP_BASE_URL, ensureE2EBaseline, getHealth } from './utils/e2e-baseline';
import { connectRuntimeToHub as connectRuntimeToSharedHub } from './utils/e2e-connect';
import {
  gotoApp as gotoSharedApp,
  createRuntime as createSharedRuntime,
} from './utils/e2e-demo-users';
import { getRenderedOutboundForAccount } from './utils/e2e-account-ui';
import { buildDefaultEntitySwapPairs, getTokenInfo } from '../runtime/account-utils';

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

  const faucetResponse = await page.request.post('/api/faucet/offchain', {
    data: {
      userEntityId: identity!.entityId,
      userRuntimeId: identity!.runtimeId,
      hubEntityId: hubId!,
      tokenId: 1,
      amount: '100',
    },
  });
  const faucetBody = await faucetResponse.json().catch(() => ({}));
  expect(
    faucetResponse.ok(),
    `swap faucet failed: ${JSON.stringify(faucetBody)}`,
  ).toBe(true);

  await expect.poll(async () => {
    return await getRenderedOutboundForAccount(page, hubId!);
  }, { timeout: 60_000, intervals: [500, 1000, 2000] }).toBeGreaterThan(0);

  return {
    entityId: identity!.entityId,
    signerId: identity!.signerId,
    counterpartyId: hubId!,
  };
}

async function listSharedHubIds(page: Page): Promise<string[]> {
  const response = await page.request.get('/api/health');
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

async function openSwapWorkspace(page: Page): Promise<void> {
  const accountsTab = page.getByTestId('tab-accounts').first();
  await expect(accountsTab).toBeVisible({ timeout: 20_000 });
  await accountsTab.click();
  const swapTab = page.locator('.account-workspace-tab').filter({ hasText: /Swap/i }).first();
  await expect(swapTab).toBeVisible({ timeout: 20_000 });
  await swapTab.click();
  await expect(page.locator('.swap-panel').first()).toBeVisible({ timeout: 15_000 });
}

async function selectCounterpartyInSwap(page: Page, preferredAccountId?: string): Promise<void> {
  const createSelect = page.getByTestId('swap-create-account-select').first();
  const createVisible = await createSelect.isVisible({ timeout: 1500 }).catch(() => false);
  const select = createVisible ? createSelect : page.getByTestId('swap-account-select').first();
  const hasSelector = await select.isVisible({ timeout: 1500 }).catch(() => false);
  if (!hasSelector) return;
  const values = await select.locator('option').evaluateAll((options) =>
    options.map((option) => ({ value: String((option as HTMLOptionElement).value || ''), label: option.textContent || '' })),
  );
  const normalizedPreferred = String(preferredAccountId || '').trim().toLowerCase();
  const preferredAccount = normalizedPreferred
    ? values.find((option) => String(option.value || '').trim().toLowerCase() === normalizedPreferred)
    : null;
  const targetAccount = preferredAccount
    || values.find((option) => option.value && option.value !== '__aggregated__');
  if (!targetAccount) return;
  await select.evaluate((node, value) => {
    const element = node as HTMLSelectElement;
    element.value = String(value || '');
    element.dispatchEvent(new Event('change', { bubbles: true }));
    element.dispatchEvent(new Event('input', { bubbles: true }));
  }, targetAccount.value);
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

  const placeButton = page.locator('.swap-panel .primary-btn').filter({ hasText: /Place Swap Offer/i }).first();
  const amountInput = page.locator('.swap-panel input[placeholder="Amount to sell"]').first();
  const priceInput = page.locator('.swap-panel input[placeholder="Price"]').first();
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

      const asks = page.locator('.swap-panel .orderbook-panel .asks-section .row.clickable');
      const bids = page.locator('.swap-panel .orderbook-panel .bids-section .row.clickable');
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
          await expect(page.locator('.swap-panel .size-hint')).toContainText(/Filled from book level/i, { timeout: 5_000 });
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

    const formError = await page.locator('.swap-panel .form-error').first().textContent().catch(() => null);
    if (formError?.trim()) lastFormError = formError.trim();
    await page.waitForTimeout(450);
  }

  throw new Error(`No preferred WETH pair is executable${lastFormError ? ` (${lastFormError})` : ''}`);
}

async function expectAllCanonicalSwapPairsHaveLiquidity(page: Page): Promise<void> {
  const pairSelect = page.getByTestId('swap-pair-select').first();
  const scopeSelect = page.getByTestId('swap-account-select').first();
  await expect(pairSelect).toBeVisible({ timeout: 20_000 });
  await expect(scopeSelect).toBeVisible({ timeout: 20_000 });
  await scopeSelect.selectOption('__aggregated__');
  const expectedPairs = CANONICAL_SWAP_PAIR_LABELS;

  for (const pairLabel of expectedPairs) {
    await pairSelect.selectOption({ label: pairLabel });
    await page.waitForTimeout(250);
    await expect
      .poll(async () => {
        const asks = await page.locator('.swap-panel .orderbook-panel .asks-section .row.clickable').count();
        const bids = await page.locator('.swap-panel .orderbook-panel .bids-section .row.clickable').count();
        const uniqueSourceIds = await page.locator('[data-testid="orderbook-source-icon"]').evaluateAll((nodes) => {
          const ids = new Set<string>();
          for (const node of nodes) {
            const sourceId = String((node as HTMLElement).dataset.sourceId || '').trim();
            if (sourceId) ids.add(sourceId);
          }
          return ids.size;
        });
        return { asks, bids, rows: asks + bids, sources: uniqueSourceIds };
      }, {
        timeout: 15_000,
        intervals: [250, 500, 1000],
        message: `orderbook for ${pairLabel} should have visible liquidity from 3 hubs`,
      })
      .toEqual(expect.objectContaining({
        asks: expect.any(Number),
        bids: expect.any(Number),
        rows: expect.any(Number),
        sources: 3,
      }));
    await expect
      .poll(async () => {
        const asks = await page.locator('.swap-panel .orderbook-panel .asks-section .row.clickable').count();
        const bids = await page.locator('.swap-panel .orderbook-panel .bids-section .row.clickable').count();
        return { asks, bids };
      }, {
        timeout: 5_000,
        intervals: [250, 500],
      })
      .toEqual(expect.objectContaining({
        asks: expect.any(Number),
        bids: expect.any(Number),
      }));
    await expect
      .poll(async () => await page.locator('.swap-panel .orderbook-panel .asks-section .row.clickable').count(), {
        timeout: 5_000,
        intervals: [250, 500],
      })
      .toBeGreaterThanOrEqual(3);
    await expect
      .poll(async () => await page.locator('.swap-panel .orderbook-panel .bids-section .row.clickable').count(), {
        timeout: 5_000,
        intervals: [250, 500],
      })
      .toBeGreaterThanOrEqual(3);
  }
}

async function readAvailableFromSizing(page: Page): Promise<number> {
  const stat = page.locator('.swap-panel .size-stats span').filter({ hasText: /^Available:/ }).first();
  await expect(stat).toBeVisible({ timeout: 20_000 });
  const text = String((await stat.textContent()) || '');
  const available = parseFirstNumber(text);
  if (!Number.isFinite(available)) throw new Error(`Cannot parse available amount: ${text}`);
  return available;
}

async function readFirstOpenOrderRemaining(page: Page): Promise<number> {
  const remainingCell = page.locator('.swap-panel .orders-table tbody tr').first().locator('td').nth(3);
  await expect(remainingCell).toBeVisible({ timeout: 30_000 });
  const text = String((await remainingCell.textContent()) || '');
  const value = parseFirstNumber(text);
  if (!Number.isFinite(value)) throw new Error(`Cannot parse remaining amount: ${text}`);
  return value;
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

  test('swap shows liquidity on all canonical pairs', async ({ page }) => {
    await timedStep('swap_pairs.goto_app', () => gotoApp(page));
    await timedStep('swap_pairs.dismiss_onboarding', () => dismissOnboardingIfVisible(page));
    await timedStep('swap_pairs.create_runtime', () => createDemoRuntime(page, `swap-pairs-${Date.now()}`, randomMnemonic()));
    await timedStep('swap_pairs.ensure_hub_accounts', () => ensureDeterministicSwapAccounts(page, 3));
    await timedStep('swap_pairs.open_workspace', () => openSwapWorkspace(page));
    await timedStep('swap_pairs.check_liquidity', () => expectAllCanonicalSwapPairsHaveLiquidity(page));
  });

  // Scenario: the runtime baseline now pre-opens the common hub deltas, so a WETH/USDC offer
  // should stay executable through the visible swap UI and remain present after a reload.
  test('swap place executable WETH/USDC offer survives reload', async ({ page }) => {
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

    const buySide = page.getByTestId('swap-side-buy').first();
    await expect(buySide).toBeVisible({ timeout: 20_000 });
    await buySide.click();

    const amountInput = page.locator('.swap-panel input[placeholder="Amount to sell"]').first();
    await expect(amountInput).toBeVisible({ timeout: 20_000 });
    const priceInput = page.locator('.swap-panel input[placeholder="Price"]').first();
    await expect(priceInput).toBeVisible({ timeout: 20_000 });

    const availableGive = await readAvailableFromSizing(page);
    const targetAmount = availableGive >= 100 ? Math.min(availableGive, 100) : Math.max(0.000001, Math.min(availableGive, 1));
    await amountInput.fill(formatDecimalForInput(targetAmount));
    await priceInput.fill('2500');
    await page.waitForTimeout(350);

    const placeButton = page.locator('.swap-panel .primary-btn').filter({ hasText: /Place Swap Offer/i }).first();
    await expect(placeButton).toBeEnabled({ timeout: 20_000 });

    await timedStep('swap_auto.place_offer', async () => {
      await placeButton.click();
      await expect
        .poll(
          async () => {
            const state = await readSwapState(page, accountRef.entityId, accountRef.signerId, accountRef.counterpartyId);
            return (
              state.accountSwapOffersSize > 0
              || state.accountHasSwapOfferInMempool
              || state.accountHasSwapOfferInPendingFrame
              || state.swapBookSize > 0
            );
          },
          { timeout: 60_000 },
        )
        .toBe(true);

      await expect
        .poll(
          async () => {
            return await page.evaluate(({ entityId, signerId, counterpartyId }) => {
              const env = (window as any).isolatedEnv;
              if (!env?.eReplicas) return false;
              const repKey = Array.from(env.eReplicas.keys()).find((key: string) => {
                const [eid, sid] = String(key).split(':');
                return String(eid || '').toLowerCase() === String(entityId).toLowerCase()
                  && String(sid || '').toLowerCase() === String(signerId).toLowerCase();
              });
              const rep = repKey ? env.eReplicas.get(repKey) : null;
              if (!(rep?.state?.accounts instanceof Map)) return false;
              const account = rep.state.accounts.get(counterpartyId) || rep.state.accounts.get(String(counterpartyId));
              if (!account?.deltas) return false;
              return account.deltas.has(2) || account.deltas.has('2');
            }, accountRef);
          },
          { timeout: 60_000 },
        )
        .toBe(true);
    });

    await timedStep('swap_auto.reload_page', async () => {
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => {
        const env = (window as any).isolatedEnv;
        return !!env?.runtimeId && Number(env?.eReplicas?.size || 0) > 0;
      }, { timeout: 60_000 });
    });
    await timedStep('swap_auto.reload_assert_offer_persisted', async () => {
      await expect.poll(async () => {
        const state = await readSwapState(page, accountRef.entityId, accountRef.signerId, accountRef.counterpartyId);
        return (
          state.accountSwapOffersSize > 0
          || state.accountHasSwapOfferInMempool
          || state.accountHasSwapOfferInPendingFrame
          || state.swapBookSize > 0
        );
      }, { timeout: 60_000 }).toBe(true);
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
    const amountInput = page.locator('.swap-panel input[placeholder="Amount to sell"]').first();
    const priceInput = page.locator('.swap-panel input[placeholder="Price"]').first();
    await expect(amountInput).toBeVisible({ timeout: 20_000 });
    await expect(priceInput).toBeVisible({ timeout: 20_000 });
    const availableGive = await readAvailableFromSizing(page);
    const orderAmount = availableGive >= 100 ? 100 : Math.max(0.000001, Math.min(availableGive, 1));
    await amountInput.fill(formatDecimalForInput(orderAmount));
    // Non-marketable limit => deterministic open order, then cancel path.
    await priceInput.fill('2000');
    await page.waitForTimeout(200);

    const placeButton = page.locator('.swap-panel .primary-btn').filter({ hasText: /Place Swap Offer/i }).first();
    await expect(placeButton).toBeEnabled({ timeout: 20_000 });
    await timedStep('swap.place_offer', async () => {
      await placeButton.click();
      await expect(page.getByTestId('swap-open-orders')).toBeVisible({ timeout: 60_000 });
    });
    const openOrderRow = page.locator('.swap-panel .orders-table tbody tr').first();
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

    const cancelButton = page.locator('.swap-panel .orders-table tbody .cancel-btn').first();
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

    await timedStep('swap.wait_closed_orderbook_ui', async () => {
      await expect
        .poll(async () => await page.locator('.swap-panel .orders-table tbody tr').count(), { timeout: 60_000 })
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
      await expect.poll(async () => await page.locator('.swap-panel .orders-table tbody tr').count(), {
        timeout: 60_000,
      }).toBe(0);
    });
  });

});
