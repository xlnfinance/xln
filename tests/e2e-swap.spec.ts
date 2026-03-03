import { test, expect, type Page } from '@playwright/test';
import { Wallet } from 'ethers';
import { timedStep } from './utils/e2e-timing';

const APP_BASE_URL = process.env.E2E_BASE_URL ?? 'https://localhost:8080';
const INIT_TIMEOUT = 30_000;

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
      return account.deltas.get(tokenId) ?? account.deltas.get(String(tokenId)) ?? null;
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
      break;
    }

    if (!entityId || !signerId) return { ok: false, error: 'local entity not found' };

    let hubId = String(openedHubId || '');
    if (!hubId) {
      const startedAt = Date.now();
      while (Date.now() - startedAt < 15_000) {
        const profiles = env?.gossip?.getProfiles?.() || [];
        const hub = profiles.find((p: any) =>
          p?.metadata?.isHub === true ||
          (Array.isArray(p?.capabilities) && (p.capabilities.includes('hub') || p.capabilities.includes('routing')))
        );
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
  const result = await page.evaluate(async () => {
    const TOKEN_SCALE = 10n ** 18n;
    const OPEN_TOKEN_ID = 3; // USDT

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

    const getOutCapacity = (entityId: string, counterpartyId: string, account: any, tokenId: number): bigint => {
      const XLN = (window as any).XLN;
      if (!(account?.deltas instanceof Map) || !XLN?.deriveDelta) return 0n;
      const delta = account.deltas.get(tokenId) ?? account.deltas.get(String(tokenId));
      if (!delta) return 0n;
      const isLeft = XLN?.isLeft
        ? Boolean(XLN.isLeft(entityId, counterpartyId))
        : String(entityId).toLowerCase() < String(counterpartyId).toLowerCase();
      const derived = XLN.deriveDelta(delta, isLeft);
      if (typeof derived?.outCapacity === 'bigint') return derived.outCapacity;
      const numeric = Number(derived?.outCapacity || 0);
      return Number.isFinite(numeric) ? BigInt(Math.floor(numeric)) : 0n;
    };

    const env = (window as any).isolatedEnv;
    const XLN = (window as any).XLN;
    if (!env?.eReplicas || !XLN?.enqueueRuntimeInput) return { ok: false, error: 'isolatedEnv/XLN missing' };

    const runtimeSigner = String(env.runtimeId || '').toLowerCase();
    let entityId = '';
    let signerId = '';

    for (const key of env.eReplicas.keys()) {
      const [eid, sid] = String(key).split(':');
      if (!eid || !sid) continue;
      if (runtimeSigner && String(sid).toLowerCase() !== runtimeSigner) continue;
      entityId = eid;
      signerId = sid;
      break;
    }

    if (!entityId || !signerId) return { ok: false, error: 'local entity not found' };

    let hubId = '';
    const localRepKey = Array.from(env.eReplicas.keys()).find((key: string) => {
      const [eid, sid] = String(key).split(':');
      return String(eid || '').toLowerCase() === String(entityId).toLowerCase()
        && String(sid || '').toLowerCase() === String(signerId).toLowerCase();
    });
    const localRep = localRepKey ? env.eReplicas.get(localRepKey) : null;
    if (localRep?.state?.accounts instanceof Map && localRep.state.accounts.size > 0) {
      hubId = String(localRep.state.accounts.keys().next().value || '');
    }
    if (!hubId) {
      const startedAt = Date.now();
      while (Date.now() - startedAt < 20_000) {
        const profiles = env?.gossip?.getProfiles?.() || [];
        const hub = profiles.find((p: any) =>
          p?.metadata?.isHub === true ||
          (Array.isArray(p?.capabilities) && (p.capabilities.includes('hub') || p.capabilities.includes('routing')))
        );
        hubId = String(hub?.entityId || '');
        if (hubId) break;
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
    }
    if (!hubId) return { ok: false, error: 'hub not discovered in gossip' };

    const repKey = Array.from(env.eReplicas.keys()).find((key: string) => {
      const [eid, sid] = String(key).split(':');
      return String(eid || '').toLowerCase() === String(entityId).toLowerCase()
        && String(sid || '').toLowerCase() === String(signerId).toLowerCase();
    });
    const rep = repKey ? env.eReplicas.get(repKey) : null;
    const existingAccount = findAccount(rep?.state?.accounts, entityId, hubId);

    if (!existingAccount) {
      XLN.enqueueRuntimeInput(env, {
        runtimeTxs: [],
        entityInputs: [{
          entityId,
          signerId,
          entityTxs: [{
            type: 'openAccount',
            data: { targetEntityId: hubId, creditAmount: 10_000n * TOKEN_SCALE, tokenId: OPEN_TOKEN_ID },
          }],
        }],
      });
    }

    const startedAt = Date.now();
    while (Date.now() - startedAt < 45_000) {
      const localRepKey = Array.from(env.eReplicas.keys()).find((key: string) => {
        const [eid, sid] = String(key).split(':');
        return String(eid || '').toLowerCase() === String(entityId).toLowerCase()
          && String(sid || '').toLowerCase() === String(signerId).toLowerCase();
      });
      const localRep = localRepKey ? env.eReplicas.get(localRepKey) : null;
      const account = findAccount(localRep?.state?.accounts, entityId, hubId);
      if (account && Number(account?.currentHeight || 0) > 0) {
        const outCapacity = getOutCapacity(entityId, hubId, account, OPEN_TOKEN_ID);
        if (outCapacity > 0n) return { ok: true, entityId, signerId, counterpartyId: hubId };
      }
      await new Promise((resolve) => setTimeout(resolve, 400));
    }

    return { ok: false, error: 'deterministic swap account did not reach ready state' };
  });

  expect(result.ok, `ensureDeterministicSwapAccount failed: ${result.error || 'unknown'}`).toBe(true);
  if (!result.ok) throw new Error(result.error || 'failed');
  return {
    entityId: result.entityId,
    signerId: result.signerId,
    counterpartyId: result.counterpartyId,
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

async function readSwapCapacitiesAndLatestOffer(
  page: Page,
  entityId: string,
  signerId: string,
  counterpartyId: string,
): Promise<{
  outCapacityByToken: Record<string, string>;
  latestUiOffer: { offerId: string; giveTokenId: number; wantTokenId: number } | null;
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

    const toBigIntSafe = (value: unknown): bigint => {
      if (typeof value === 'bigint') return value;
      if (typeof value === 'number' && Number.isFinite(value)) return BigInt(Math.floor(value));
      if (typeof value === 'string' && /^-?\d+$/.test(value.trim())) return BigInt(value.trim());
      return 0n;
    };

    const env = (window as any).isolatedEnv;
    const XLN = (window as any).XLN;
    if (!env?.eReplicas || !XLN?.deriveDelta) {
      return { outCapacityByToken: {}, latestUiOffer: null };
    }
    const key = Array.from(env.eReplicas.keys()).find((k: string) => {
      const [eid, sid] = String(k).split(':');
      return String(eid || '').toLowerCase() === String(entityId).toLowerCase()
        && String(sid || '').toLowerCase() === String(signerId).toLowerCase();
    });
    const rep = key ? env.eReplicas.get(key) : null;
    const account = findAccount(rep?.state?.accounts, entityId, counterpartyId);
    if (!account) return { outCapacityByToken: {}, latestUiOffer: null };

    const isLeft = XLN?.isLeft
      ? Boolean(XLN.isLeft(entityId, counterpartyId))
      : String(entityId).toLowerCase() < String(counterpartyId).toLowerCase();

    const outCapacityByToken: Record<string, string> = {};
    if (account?.deltas instanceof Map) {
      for (const [rawTokenId, delta] of account.deltas.entries()) {
        const tokenId = Number.parseInt(String(rawTokenId), 10);
        if (!Number.isFinite(tokenId) || tokenId <= 0 || !delta) continue;
        const derived = XLN.deriveDelta(delta, isLeft);
        const outCapacity = toBigIntSafe(derived?.outCapacity);
        outCapacityByToken[String(tokenId)] = outCapacity.toString();
      }
    }

    const normalizeOffer = (offer: any): { offerId: string; giveTokenId: number; wantTokenId: number } | null => {
      const offerId = String(offer?.offerId || '');
      if (!offerId.startsWith('swap-')) return null;
      const giveTokenId = Number(offer?.giveTokenId);
      const wantTokenId = Number(offer?.wantTokenId);
      if (!Number.isFinite(giveTokenId) || !Number.isFinite(wantTokenId) || giveTokenId <= 0 || wantTokenId <= 0) {
        return null;
      }
      return { offerId, giveTokenId, wantTokenId };
    };

    let latestUiOffer: { offerId: string; giveTokenId: number; wantTokenId: number } | null = null;

    if (account?.swapOffers instanceof Map && account.swapOffers.size > 0) {
      const offers = Array.from(account.swapOffers.values());
      for (let i = offers.length - 1; i >= 0; i--) {
        const normalized = normalizeOffer(offers[i]);
        if (normalized) {
          latestUiOffer = normalized;
          break;
        }
      }
    }

    if (!latestUiOffer) {
      const frames = Array.isArray(account?.frameHistory) ? account.frameHistory : [];
      for (let fi = frames.length - 1; fi >= 0; fi--) {
        const frame = frames[fi];
        const txs = Array.isArray(frame?.accountTxs) ? frame.accountTxs : [];
        for (let ti = txs.length - 1; ti >= 0; ti--) {
          const tx = txs[ti];
          if (tx?.type !== 'swap_offer') continue;
          const normalized = normalizeOffer(tx?.data);
          if (normalized) {
            latestUiOffer = normalized;
            break;
          }
        }
        if (latestUiOffer) break;
      }
    }

    return { outCapacityByToken, latestUiOffer };
  }, { entityId, signerId, counterpartyId });
}

async function openSwapWorkspace(page: Page): Promise<void> {
  const accountsTab = page.getByTestId('tab-accounts').first();
  await expect(accountsTab).toBeVisible({ timeout: 20_000 });
  await accountsTab.click();
  const swapTab = page.locator('.account-workspace-tab').filter({ hasText: /Swap/i }).first();
  await expect(swapTab).toBeVisible({ timeout: 20_000 });
  await swapTab.click();
  await expect(page.locator('.swap-panel h3').first()).toContainText(/Swap Trading/i, { timeout: 15_000 });
}

async function selectCounterpartyInSwap(page: Page): Promise<void> {
  const trigger = page.locator('.swap-panel .entity-select .es-trigger').first();
  const hasSelector = await trigger.isVisible({ timeout: 1500 }).catch(() => false);
  if (!hasSelector) return;
  await trigger.click();
  const firstOption = page.locator('.swap-panel .entity-select .es-option').first();
  await expect(firstOption).toBeVisible({ timeout: 20_000 });
  await firstOption.click();
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

async function clickBestOrderbookLevel(page: Page): Promise<void> {
  const asks = page.locator('.swap-panel .orderbook-panel .asks-section .row.clickable');
  const bids = page.locator('.swap-panel .orderbook-panel .bids-section .row.clickable');
  const askCount = await asks.count();
  const bidCount = await bids.count();
  if (askCount > 0) {
    await asks.last().click();
  } else if (bidCount > 0) {
    await bids.first().click();
  } else {
    throw new Error('Orderbook has no clickable levels');
  }
  await expect(page.locator('.swap-panel .size-hint')).toContainText(/Filled from book level/i, { timeout: 20_000 });
}

async function prepareExecutableOrder(page: Page): Promise<number> {
  const pairInput = page.getByTestId('swap-pair-search').first();
  await expect(pairInput).toBeVisible({ timeout: 20_000 });
  const pairOptions = (await page.locator('#swap-pair-options option').allTextContents())
    .map((text) => text.trim())
    .filter((text) => text.length > 0);
  if (pairOptions.length === 0) throw new Error('No pair options found');
  const expectedPairs = ['WETH/USDC', 'WETH/USDT', 'USDC/USDT'];
  for (const expectedPair of expectedPairs) {
    if (!pairOptions.includes(expectedPair)) {
      throw new Error(`Expected pair ${expectedPair} is missing from swap pair options`);
    }
  }
  const unexpectedPairs = pairOptions.filter((pair) => !expectedPairs.includes(pair));
  if (unexpectedPairs.length > 0) {
    throw new Error(`Unexpected swap pair options found: ${unexpectedPairs.join(', ')}`);
  }
  const primaryPair = 'WETH/USDC';
  if (!pairOptions.includes(primaryPair)) {
    throw new Error(`Primary pair ${primaryPair} is missing from swap pair options`);
  }

  const placeButton = page.locator('.swap-panel .primary-btn').filter({ hasText: /Place Swap Offer/i }).first();
  const amountInput = page.locator('.swap-panel input[placeholder="Amount to sell"]').first();
  await expect(amountInput).toBeVisible({ timeout: 20_000 });

  for (const pairLabel of [primaryPair]) {
    await pairInput.fill(pairLabel);
    await pairInput.press('Enter');
    await page.waitForTimeout(300);

    const askCount = await page.locator('.swap-panel .orderbook-panel .asks-section .row.clickable').count();
    const bidCount = await page.locator('.swap-panel .orderbook-panel .bids-section .row.clickable').count();
    if (askCount === 0 && bidCount === 0) continue;

    try {
      await clickBestOrderbookLevel(page);
    } catch {
      continue;
    }

    const available = await readAvailableFromSizing(page);
    if (!Number.isFinite(available) || available <= 0) continue;
    const targetAmount = Math.max(0.000001, Math.min(available, 5));
    await amountInput.fill(formatDecimalForInput(targetAmount));
    await page.waitForTimeout(100);

    if (await placeButton.isEnabled()) {
      return targetAmount;
    }
  }

  const formError = await page.locator('.swap-panel .form-error').first().textContent().catch(() => null);
  throw new Error(`Primary pair ${primaryPair} is not executable${formError ? ` (${formError.trim()})` : ''}`);
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
  test('swap place auto-prepares inbound token capacity', async ({ page }) => {
    test.setTimeout(240_000);

    await timedStep('swap_auto.goto_app', () => gotoApp(page));
    await timedStep('swap_auto.dismiss_onboarding', () => dismissOnboardingIfVisible(page));
    await timedStep('swap_auto.create_runtime', () => createDemoRuntime(page, `swap-auto-${Date.now()}`, randomMnemonic()));
    const accountRef = await timedStep('swap_auto.ensure_hub_account', () => ensureDeterministicSwapAccount(page));

    await timedStep('swap_auto.open_workspace', () => openSwapWorkspace(page));
    await timedStep('swap_auto.select_counterparty', () => selectCounterpartyInSwap(page));

    const pairInput = page.getByTestId('swap-pair-search').first();
    await expect(pairInput).toBeVisible({ timeout: 20_000 });
    await pairInput.fill('WETH/USDT');
    await pairInput.press('Enter');

    const buySide = page.getByTestId('swap-side-buy').first();
    await expect(buySide).toBeVisible({ timeout: 20_000 });
    await buySide.click();

    const amountInput = page.locator('.swap-panel input[placeholder="Amount to sell"]').first();
    await expect(amountInput).toBeVisible({ timeout: 20_000 });
    const priceInput = page.locator('.swap-panel input[placeholder="Price"]').first();
    await expect(priceInput).toBeVisible({ timeout: 20_000 });

    const availableGive = await readAvailableFromSizing(page);
    const targetAmount = Math.max(0.000001, Math.min(availableGive, 1));
    await amountInput.fill(formatDecimalForInput(targetAmount));
    await priceInput.fill('2500');
    await page.waitForTimeout(350);

    await expect(page.getByTestId('swap-auto-capacity-note')).toContainText(/auto-activate/i, { timeout: 20_000 });

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
  });

  test('swap place and cancel from UI updates state machine', async ({ page }) => {
    test.setTimeout(240_000);

    await timedStep('swap.goto_app', () => gotoApp(page));
    await timedStep('swap.dismiss_onboarding', () => dismissOnboardingIfVisible(page));
    await timedStep('swap.create_runtime', () => createDemoRuntime(page, `swap-rt-${Date.now()}`, randomMnemonic()));
    const accountRef = await timedStep('swap.ensure_hub_account', () => ensureAnyHubAccountOpen(page));

    await timedStep('swap.open_workspace', () => openSwapWorkspace(page));
    await timedStep('swap.select_counterparty', () => selectCounterpartyInSwap(page));

    await expect(page.getByTestId('swap-orderbook')).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId('swap-depth-chart-toggle')).toBeVisible({ timeout: 20_000 });
    const swapResolveCountBefore = await timedStep('swap.read_resolve_count_before', () =>
      readSwapResolveCount(page, accountRef.entityId, accountRef.signerId, accountRef.counterpartyId),
    );

    const minFillInput = page.locator('.swap-panel input[placeholder="50"]').first();
    await expect(minFillInput).toBeVisible({ timeout: 20_000 });
    await minFillInput.fill('1');

    const targetAmount = await timedStep('swap.prepare_order', () => prepareExecutableOrder(page));
    const capacitiesBefore = await timedStep('swap.read_capacities_before', () =>
      readSwapCapacitiesAndLatestOffer(page, accountRef.entityId, accountRef.signerId, accountRef.counterpartyId),
    );

    const placeButton = page.locator('.swap-panel .primary-btn').filter({ hasText: /Place Swap Offer/i }).first();
    await expect(placeButton).toBeEnabled({ timeout: 20_000 });
    await timedStep('swap.place_offer', async () => {
      await placeButton.click();
      await expect(page.getByTestId('swap-open-orders')).toBeVisible({ timeout: 60_000 });
    });
    const placedOffer = await timedStep('swap.capture_offer_tokens', async () => {
      await expect
        .poll(
          async () =>
            (await readSwapCapacitiesAndLatestOffer(page, accountRef.entityId, accountRef.signerId, accountRef.counterpartyId))
              .latestUiOffer,
          { timeout: 30_000 },
        )
        .not.toBeNull();
      const snapshot = await readSwapCapacitiesAndLatestOffer(
        page,
        accountRef.entityId,
        accountRef.signerId,
        accountRef.counterpartyId,
      );
      if (!snapshot.latestUiOffer) throw new Error('Failed to capture placed swap offer tokens');
      return snapshot.latestUiOffer;
    });

    let fillOutcome: 'partial' | 'full' = 'full';
    await timedStep('swap.assert_fill', async () => {
      await expect
        .poll(async () => {
          const rows = await page.locator('.swap-panel .orders-table tbody tr').count();
          if (rows === 0) return 'full';
          const remaining = await readFirstOpenOrderRemaining(page);
          return remaining < targetAmount ? 'partial' : 'pending';
        }, { timeout: 60_000 })
        .toMatch(/partial|full/);
      const rows = await page.locator('.swap-panel .orders-table tbody tr').count();
      if (rows > 0) {
        fillOutcome = 'partial';
        const remaining = await readFirstOpenOrderRemaining(page);
        expect(remaining).toBeGreaterThan(0);
      }
    });

    await timedStep('swap.assert_swap_resolve_emitted', async () => {
      await expect
        .poll(
          async () => await readSwapResolveCount(page, accountRef.entityId, accountRef.signerId, accountRef.counterpartyId),
          { timeout: 60_000 },
        )
        .toBeGreaterThan(swapResolveCountBefore);
    });
    await timedStep('swap.assert_new_token_outbound_increase', async () => {
      const beforeOut = BigInt(capacitiesBefore.outCapacityByToken[String(placedOffer.wantTokenId)] || '0');
      await expect
        .poll(async () => {
          const snapshot = await readSwapCapacitiesAndLatestOffer(
            page,
            accountRef.entityId,
            accountRef.signerId,
            accountRef.counterpartyId,
          );
          const afterOut = BigInt(snapshot.outCapacityByToken[String(placedOffer.wantTokenId)] || '0');
          return afterOut > beforeOut;
        }, { timeout: 60_000 })
        .toBe(true);
    });

    if (fillOutcome === 'partial') {
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
    }

    await timedStep('swap.wait_closed_orderbook_ui', async () => {
      await expect
        .poll(async () => await page.locator('.swap-panel .orders-table tbody tr').count(), { timeout: 60_000 })
        .toBe(0);
    });

    await timedStep('swap.assert_post_close_state', async () => {
      const state = await readSwapState(page, accountRef.entityId, accountRef.signerId, accountRef.counterpartyId);
      expect(state.accountSwapOffersSize).toBe(0);
    });
  });

  test('browser e2e scenario swap includes partial fills', async ({ page }) => {
    test.setTimeout(240_000);

    await timedStep('swap_scn.goto_app', () => gotoApp(page));
    await timedStep('swap_scn.dismiss_onboarding', () => dismissOnboardingIfVisible(page));
    await timedStep('swap_scn.create_runtime', () => createDemoRuntime(page, `swap-scn-${Date.now()}`, randomMnemonic()));

    const result = await timedStep('swap_scn.run_swap', async () => {
      return await page.evaluate(async () => {
        const XLN = (window as any).XLN;
        const env = (window as any).isolatedEnv;
        if (!XLN?.scenarios?.swap || !env) return { ok: false, error: 'XLN.scenarios.swap or isolatedEnv missing' };
        try {
          await XLN.scenarios.swap(env);
          let partialFillCount = 0;
          for (const rep of env.eReplicas.values()) {
            for (const account of rep?.state?.accounts?.values?.() || []) {
              for (const frame of account?.frameHistory || []) {
                for (const tx of frame?.accountTxs || []) {
                  if (tx?.type !== 'swap_resolve') continue;
                  const ratio = Number(tx?.data?.fillRatio ?? 0);
                  if (ratio > 0 && ratio < 65535) partialFillCount += 1;
                }
              }
            }
          }
          return { ok: true, partialFillCount };
        } catch (error: any) {
          return {
            ok: false,
            error: error?.message || String(error),
            stack: error?.stack || null,
            name: error?.name || null,
          };
        }
      });
    });

    expect(
      result.ok,
      `scenario swap failed: ${result.error || 'unknown'}\n${result.name || ''}\n${result.stack || ''}`,
    ).toBe(true);
    expect(Number(result.partialFillCount || 0), 'expected at least one partial fill in scenario swap').toBeGreaterThan(0);
  });

  test('browser e2e scenario swapMarket includes partial fills', async ({ page }) => {
    test.setTimeout(480_000);

    await timedStep('swap_market.goto_app', () => gotoApp(page));
    await timedStep('swap_market.dismiss_onboarding', () => dismissOnboardingIfVisible(page));
    await timedStep('swap_market.create_runtime', () => createDemoRuntime(page, `swap-market-${Date.now()}`, randomMnemonic()));

    const result = await timedStep('swap_market.run_scenario', async () => {
      return await page.evaluate(async () => {
        const XLN = (window as any).XLN;
        const env = (window as any).isolatedEnv;
        if (!XLN?.scenarios?.swapMarket || !env) return { ok: false, error: 'XLN.scenarios.swapMarket or isolatedEnv missing' };
        try {
          await XLN.scenarios.swapMarket(env);
          let partialFillCount = 0;
          for (const rep of env.eReplicas.values()) {
            for (const account of rep?.state?.accounts?.values?.() || []) {
              for (const frame of account?.frameHistory || []) {
                for (const tx of frame?.accountTxs || []) {
                  if (tx?.type !== 'swap_resolve') continue;
                  const ratio = Number(tx?.data?.fillRatio ?? 0);
                  if (ratio > 0 && ratio < 65535) partialFillCount += 1;
                }
              }
            }
          }
          return { ok: true, partialFillCount };
        } catch (error: any) {
          return {
            ok: false,
            error: error?.message || String(error),
            stack: error?.stack || null,
            name: error?.name || null,
          };
        }
      });
    });

    expect(
      result.ok,
      `scenario swapMarket failed: ${result.error || 'unknown'}\n${result.name || ''}\n${result.stack || ''}`,
    ).toBe(true);
    expect(Number(result.partialFillCount || 0), 'expected at least one partial fill in scenario swapMarket').toBeGreaterThan(0);
  });
});
