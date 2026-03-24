/**
 * E2E runtime persistence and replay coverage.
 *
 * Flow and goals:
 * 1. Create browser runtimes and connect them through the shared hub mesh.
 * 2. Perform state-changing actions that produce persisted frame journals.
 * 3. Reload the wallet/runtime at critical points in the bilateral flow.
 * 4. Verify the restored state matches the pre-reload state after snapshot + WAL replay.
 *
 * This test exists to prove that reload is not cosmetic: the runtime must restore the exact
 * financial state machine, not a UI cache approximation.
 */
import { test, expect, type Page } from '@playwright/test';
import { Wallet, ethers } from 'ethers';
import {
  createRuntimeIdentity,
  gotoApp,
  switchToRuntimeId,
} from './utils/e2e-demo-users';
import { connectRuntimeToHub as connectRuntimeToSharedHub } from './utils/e2e-connect';
import { APP_BASE_URL, API_BASE_URL, resetProdServer } from './utils/e2e-baseline';

function randomMnemonic(): string {
  return Wallet.createRandom().mnemonic!.phrase;
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

async function getActiveApiBase(page: Page): Promise<string> {
  if (process.env.E2E_API_BASE_URL) return API_BASE_URL;
  const runtimeApi = await page.evaluate(() => {
    const env = (window as any).isolatedEnv;
    const relay = env?.runtimeState?.p2p?.relayUrls?.[0] ?? null;
    return typeof relay === 'string' ? relay : null;
  });
  return relayToApiBase(runtimeApi) ?? APP_BASE_URL;
}

async function discoverHub(page: Page) {
  const hubId = await page.evaluate(async () => {
    const env = (window as any).isolatedEnv;
    const p2p = env?.runtimeState?.p2p;
    if (p2p?.refreshGossip) await p2p.refreshGossip();
    await new Promise((r) => setTimeout(r, 600));
    const hubs = env?.gossip?.getHubs?.() ?? [];
    return hubs[0]?.entityId || null;
  });
  expect(hubId, 'No hub discovered').toBeTruthy();
  return hubId as string;
}

async function connectHub(page: Page, entityId: string, signerId: string, hubId: string) {
  let opened = false;
  let lastError = '';
  try {
    await connectRuntimeToSharedHub(page, { entityId, signerId }, hubId);
    opened = true;
  } catch (error: any) {
    lastError = error?.message || String(error);
  }

  const debugState = await page.evaluate(({ entityId, hubId }) => {
    const env = (window as any).isolatedEnv;
    if (!env?.eReplicas) return { foundEntity: false, accounts: [] as any[] };
    for (const [k, rep] of env.eReplicas.entries()) {
      if (!String(k).startsWith(entityId + ':')) continue;
      const accounts: any[] = [];
      for (const [cpId, acc] of (rep?.state?.accounts ?? new Map()).entries()) {
        accounts.push({
          cpId: String(cpId),
          hasDelta1: !!acc?.deltas?.get?.(1),
          pendingFrame: !!acc?.pendingFrame,
          currentHeight: Number(acc?.currentHeight ?? -1),
        });
      }
      return { foundEntity: true, accounts, targetHub: hubId };
    }
    return { foundEntity: false, accounts: [] as any[] };
  }, { entityId, hubId });
  console.log('[PERSIST] connectHub debug state', JSON.stringify(debugState));
  expect(
    opened,
    `Hub account missing for ${entityId.slice(0, 10)} -> ${hubId.slice(0, 10)} (${lastError || 'unknown'})`,
  ).toBe(true);
}

async function runtimeSnapshot(page: Page) {
  return await page.evaluate(async () => {
    const env = (window as any).isolatedEnv;
    const runtimeId = String(env?.runtimeId || '');
    if (!env) {
      return {
        runtimeId: '',
        hasEnv: false,
        runtimeHeight: 0,
        historyFrames: 0,
        entityCount: 0,
        replayMeta: null,
      };
    }

    let entityCount = 0;
    const entityKeys: string[] = [];
    if (env.eReplicas) {
      for (const [k] of env.eReplicas.entries()) {
        entityCount += 1;
        entityKeys.push(String(k));
      }
    }

    const entities: any[] = [];
    if (env.eReplicas) {
      for (const [k, rep] of env.eReplicas.entries()) {
        const entityId = String(k).split(':')[0];
        const accounts: any[] = [];
        if (rep?.state?.accounts) {
          for (const [cpId, acc] of rep.state.accounts.entries()) {
            const deltaToken1 = acc?.deltas?.get?.(1);
            let out = 'n/a';
            let inCap = 'n/a';
            try {
              const XLN = (window as any).XLN;
              const d = deltaToken1;
              if (XLN && d) {
                const v = XLN.deriveDelta(d, String(entityId).toLowerCase() < String(cpId).toLowerCase());
                out = v.outCapacity.toString();
                inCap = v.inCapacity.toString();
              }
            } catch {
              // best effort
            }
              accounts.push({
                cpId: String(cpId),
                hasDelta1: !!deltaToken1,
                out,
                inCap,
                currentHeight: Number(acc?.currentHeight ?? -1),
                hasPendingFrame: !!acc?.pendingFrame,
                currentFrameHash: String(acc?.currentFrame?.stateHash ?? ''),
                pendingFrameHash: String(acc?.pendingFrame?.stateHash ?? ''),
                frameHistoryHashes: Array.isArray(acc?.frameHistory)
                  ? acc.frameHistory.map((f: any) => String(f?.stateHash || ''))
                  : [],
                frameHistoryJHeights: Array.isArray(acc?.frameHistory)
                  ? acc.frameHistory.map((f: any) => Number(f?.jHeight ?? 0))
                  : [],
                frameHistoryMeta: Array.isArray(acc?.frameHistory)
                  ? acc.frameHistory.map((f: any) => ({
                      height: Number(f?.height ?? 0),
                      byLeft: Boolean(f?.byLeft),
                      deltas: Array.isArray(f?.deltas) ? f.deltas.map((d: any) => String(d)) : [],
                      txTypes: Array.isArray(f?.accountTxs) ? f.accountTxs.map((tx: any) => String(tx?.type || '')) : [],
                    }))
                  : [],
                deltaRaw: deltaToken1 ? {
                  collateral: String((deltaToken1 as any).collateral ?? ''),
                  ondelta: String((deltaToken1 as any).ondelta ?? ''),
                  offdelta: String((deltaToken1 as any).offdelta ?? ''),
                  leftCreditLimit: String((deltaToken1 as any).leftCreditLimit ?? ''),
                  rightCreditLimit: String((deltaToken1 as any).rightCreditLimit ?? ''),
                  leftHold: String((deltaToken1 as any).leftHold ?? ''),
                  rightHold: String((deltaToken1 as any).rightHold ?? ''),
                } : null,
                swapOffersSize: Number(acc?.swapOffers?.size || 0),
              });
          }
        }
        entities.push({
          key: String(k),
          accountCount: Number(rep?.state?.accounts?.size || 0),
          swapBookSize: Number(rep?.state?.swapBook?.size || 0),
          accounts,
        });
      }
    }

    return {
      runtimeId,
      hasEnv: true,
      runtimeHeight: Number(env.height || 0),
      historyFrames: Number(env.history?.length || 0),
      entityCount,
      entityKeys,
      entities,
      replayMeta: env.__replayMeta ?? null,
    };
  });
}

async function readPairProgress(page: Page, counterpartyId: string) {
  return await page.evaluate(({ counterpartyId }) => {
    const env = (window as any).isolatedEnv;
    if (!env?.eReplicas) return null;
    const runtimeId = String(env.runtimeId || '').toLowerCase();
    for (const [key, rep] of env.eReplicas.entries()) {
      const [entityId, signerId] = String(key).split(':');
      if (!entityId || !signerId || String(signerId).toLowerCase() !== runtimeId) continue;
      const account = rep?.state?.accounts?.get?.(counterpartyId);
      if (!account) continue;
      const history = Array.isArray(account.frameHistory) ? account.frameHistory : [];
      const pendingTxs = Array.isArray(account?.pendingFrame?.accountTxs) ? account.pendingFrame.accountTxs : [];
      const htlcFrames = [...history.slice(-80), ...(pendingTxs.length > 0 ? [{ accountTxs: pendingTxs }] : [])];
      return {
        currentHeight: Number(account.currentHeight || 0),
        pendingHeight: Number(account?.pendingFrame?.height || 0),
        recentHtlcHashlocks: htlcFrames
          .flatMap((frame: any) => (Array.isArray(frame?.accountTxs) ? frame.accountTxs : []))
          .filter((tx: any) => tx?.type === 'htlc_lock' || tx?.type === 'htlc_resolve')
          .map((tx: any) => String(tx?.data?.hashlock || ''))
          .filter((hash: string) => hash.startsWith('0x') && hash.length > 10),
        recentHtlcResolveCount: htlcFrames
          .flatMap((frame: any) => (Array.isArray(frame?.accountTxs) ? frame.accountTxs : []))
          .filter((tx: any) => tx?.type === 'htlc_resolve')
          .length,
        recentHtlcLockCount: htlcFrames
          .flatMap((frame: any) => (Array.isArray(frame?.accountTxs) ? frame.accountTxs : []))
          .filter((tx: any) => tx?.type === 'htlc_lock')
          .length,
      };
    }
    return null;
  }, { counterpartyId });
}

async function waitForPairIdle(page: Page, counterpartyId: string, timeoutMs = 20_000) {
  const startedAt = Date.now();
  let last: Awaited<ReturnType<typeof readPairProgress>> = null;
  while (Date.now() - startedAt < timeoutMs) {
    last = await readPairProgress(page, counterpartyId);
    if (last && Number(last.pendingHeight || 0) === 0) return last;
    await page.waitForTimeout(250);
  }
  throw new Error(`pair ${counterpartyId.slice(0, 10)} not idle: ${JSON.stringify(last)}`);
}

function generateHtlcPayload(): { secret: string; hashlock: string } {
  const secret = ethers.hexlify(ethers.randomBytes(32));
  const hashlock = ethers.keccak256(secret);
  return { secret, hashlock };
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
  const result = await page.evaluate(
    async ({ fromEntityId, fromSignerId, targetEntityId, route, amountUsd, description, secret, hashlock }) => {
      try {
        const runtimeWindow = window as typeof window & {
          isolatedEnv?: { runtimeId?: string; eReplicas?: Map<string, unknown> };
          XLN?: { enqueueRuntimeInput?: (env: unknown, input: unknown) => void };
        };
        const env = runtimeWindow.isolatedEnv;
        const runtimeModule =
          runtimeWindow.XLN
          || await import(/* @vite-ignore */ new URL(`/runtime.js?v=${Date.now()}`, window.location.origin).href);
        const XLN = runtimeModule as { enqueueRuntimeInput?: (env: unknown, input: unknown) => void };
        if (!env || !XLN?.enqueueRuntimeInput) {
          return { ok: false, error: 'isolatedEnv/XLN missing' };
        }
        const expectedReplicaKey = `${fromEntityId}:${fromSignerId}`.toLowerCase();
        const replicaKeys = env.eReplicas ? Array.from(env.eReplicas.keys(), (key) => String(key).toLowerCase()) : [];
        if (!replicaKeys.includes(expectedReplicaKey)) {
          return { ok: false, error: `local replica ${expectedReplicaKey} missing` };
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
  expect(result.ok, `sendRoutedHtlcPayment failed: ${result.error || 'unknown'}`).toBe(true);
  return { secret, hashlock };
}

async function waitForSenderHtlcLock(
  page: Page,
  counterpartyId: string,
  hashlock: string,
  baselineLockCount: number,
  timeoutMs = 25_000,
) {
  const startedAt = Date.now();
  let last: Awaited<ReturnType<typeof readPairProgress>> = null;
  while (Date.now() - startedAt < timeoutMs) {
    last = await readPairProgress(page, counterpartyId);
    const hashSeen = Array.isArray(last?.recentHtlcHashlocks) && last.recentHtlcHashlocks.includes(hashlock);
    const lockCountIncreased = Number(last?.recentHtlcLockCount || 0) > baselineLockCount;
    if (hashSeen || lockCountIncreased) return last;
    await page.waitForTimeout(350);
  }
  throw new Error(`sender HTLC lock not observed for ${counterpartyId.slice(0, 10)} hashlock=${hashlock.slice(0, 10)} last=${JSON.stringify(last)}`);
}

async function waitForRecipientPaymentObserved(
  page: Page,
  counterpartyId: string,
  hashlock: string,
  baselineResolveCount: number,
  timeoutMs = 30_000,
) {
  const startedAt = Date.now();
  let last: Awaited<ReturnType<typeof readPairProgress>> = null;
  while (Date.now() - startedAt < timeoutMs) {
    last = await readPairProgress(page, counterpartyId);
    const hashSeen = Array.isArray(last?.recentHtlcHashlocks) && last.recentHtlcHashlocks.includes(hashlock);
    const resolveSeen = Number(last?.recentHtlcResolveCount || 0) > baselineResolveCount;
    if ((hashSeen || resolveSeen) && Number(last?.pendingHeight || 0) === 0) {
      return last;
    }
    await page.waitForTimeout(400);
  }
  throw new Error(
    `recipient payment not observed for ${counterpartyId.slice(0, 10)} hashlock=${hashlock.slice(0, 10)} baseline=${baselineResolveCount} last=${JSON.stringify(last)}`,
  );
}

function parseFirstNumber(text: string): number {
  let started = false;
  let seenDot = false;
  let value = '';
  for (const ch of String(text || '')) {
    if (!started) {
      if (ch >= '0' && ch <= '9') {
        started = true;
        value += ch;
      } else if (ch === '-') {
        started = true;
        value += ch;
      }
      continue;
    }
    if (ch >= '0' && ch <= '9') {
      value += ch;
      continue;
    }
    if (ch === ',' ) {
      continue;
    }
    if (ch === '.' && !seenDot) {
      seenDot = true;
      value += ch;
      continue;
    }
    break;
  }
  if (value === '' || value === '-') return Number.NaN;
  return Number.parseFloat(value);
}

function formatDecimalForInput(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0';
  let text = value.toFixed(6);
  while (text.endsWith('0')) {
    text = text.slice(0, -1);
  }
  if (text.endsWith('.')) {
    text = text.slice(0, -1);
  }
  return text;
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
    options.map((option) => ({
      value: String((option as HTMLOptionElement).value || ''),
      label: option.textContent || '',
    })),
  );
  const normalizedPreferred = String(preferredAccountId || '').trim().toLowerCase();
  const preferredAccount = normalizedPreferred
    ? values.find((option) => String(option.value || '').trim().toLowerCase() === normalizedPreferred)
    : null;
  const targetAccount = preferredAccount || values.find((option) => option.value && option.value !== '__aggregated__');
  if (!targetAccount) return;
  await select.evaluate((node, value) => {
    const element = node as HTMLSelectElement;
    element.value = String(value || '');
    element.dispatchEvent(new Event('change', { bubbles: true }));
    element.dispatchEvent(new Event('input', { bubbles: true }));
  }, targetAccount.value);
}

async function readAvailableFromSizing(page: Page): Promise<number> {
  const stat = page.locator('.swap-panel .size-stats span').filter({ hasText: /^Available:/ }).first();
  await expect(stat).toBeVisible({ timeout: 20_000 });
  const text = String((await stat.textContent()) || '');
  const available = parseFirstNumber(text);
  if (!Number.isFinite(available)) throw new Error(`Cannot parse available amount: ${text}`);
  return available;
}

async function readSwapState(page: Page, entityId: string, signerId: string, counterpartyId: string) {
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
      accountHasSwapCancelRequestInMempool: !!(account?.mempool || []).find((tx: any) => tx?.type === 'swap_cancel_request' || tx?.type === 'swap_cancel'),
      accountHasSwapCancelRequestInPendingFrame: !!(account?.pendingFrame?.accountTxs || []).find((tx: any) => tx?.type === 'swap_cancel_request' || tx?.type === 'swap_cancel'),
    };
  }, { entityId, signerId, counterpartyId });
}

async function placeNonMarketableSwapOrder(page: Page, counterpartyId: string): Promise<void> {
  await openSwapWorkspace(page);
  await selectCounterpartyInSwap(page, counterpartyId);
  const pairSelect = page.getByTestId('swap-pair-select').first();
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
  await priceInput.fill('2000');
  await page.waitForTimeout(200);
  const placeButton = page.getByTestId('swap-submit-order').first();
  await expect(placeButton).toBeEnabled({ timeout: 20_000 });
  await placeButton.click();
  await expect(page.getByTestId('swap-open-orders')).toBeVisible({ timeout: 60_000 });
  await expect(page.locator('.swap-panel .orders-table tbody tr').first()).toBeVisible({ timeout: 30_000 });
}

async function cancelFirstOpenSwapOrder(page: Page): Promise<void> {
  const cancelButton = page.locator('.swap-panel .orders-table tbody .cancel-btn').first();
  await expect(cancelButton).toBeVisible({ timeout: 20_000 });
  await cancelButton.click();
  await expect
    .poll(async () => await page.locator('.swap-panel .orders-table tbody tr').count(), { timeout: 60_000 })
    .toBe(0);
}

async function runtimeDbMeta(page: Page) {
  return await page.evaluate(async () => {
    const env = (window as any).isolatedEnv;
    const XLN = (window as any).XLN
      || await import(/* @vite-ignore */ new URL(`/runtime.js?v=${Date.now()}`, window.location.origin).href);
    if (!env || !XLN?.getRuntimeDb) return { ok: false, error: 'env/xln missing' };
    const db = XLN.getRuntimeDb(env);
    const ns = String(env.dbNamespace || env.runtimeId || '').toLowerCase();
    const key = (name: string) => `${ns}:${name}`;
    const read = async (name: string): Promise<string | null> => {
      try {
        const buf = await db.get((window as any).Buffer ? (window as any).Buffer.from(key(name)) : key(name));
        return String(buf?.toString?.() ?? '');
      } catch {
        return null;
      }
    };
    const latest = await read('latest_height');
    const checkpoint = await read('latest_checkpoint_height');
    const latestN = Number(latest || 0);
    const checkpointN = Number(checkpoint || 0);
    const hasFrameLatest = await read(`frame_input:${latestN}`) !== null;
    const hasSnapshotLatest = await read(`snapshot:${latestN}`) !== null;
    let frameSummary: any = null;
    let snapshotSummary: any = null;
    const frameTimeline: any[] = [];
    try {
      const frameRaw = await read(`frame_input:${latestN}`);
      if (frameRaw) {
        const parsed = JSON.parse(frameRaw);
        const runtimeInput = parsed?.runtimeInput ?? {};
        frameSummary = {
          height: parsed?.height ?? null,
          runtimeTxs: Array.isArray(runtimeInput.runtimeTxs) ? runtimeInput.runtimeTxs.map((tx: any) => tx?.type || 'unknown') : [],
          entityInputs: Array.isArray(runtimeInput.entityInputs)
            ? runtimeInput.entityInputs.map((input: any) => ({
                entityId: String(input?.entityId || ''),
                txTypes: Array.isArray(input?.entityTxs) ? input.entityTxs.map((tx: any) => tx?.type || 'unknown') : [],
              }))
            : [],
        };
      }
    } catch {
      frameSummary = { parseError: true };
    }
    try {
      for (let h = 1; h <= latestN; h++) {
        const raw = await read(`frame_input:${h}`);
        if (!raw) {
          frameTimeline.push({ h, missing: true });
          continue;
        }
        const parsed = JSON.parse(raw);
        const runtimeInput = parsed?.runtimeInput ?? {};
        frameTimeline.push({
          h,
          timestamp: Number(parsed?.timestamp ?? 0),
          runtimeTxs: Array.isArray(runtimeInput.runtimeTxs)
            ? runtimeInput.runtimeTxs.map((tx: any) => tx?.type || 'unknown')
            : [],
          entityInputs: Array.isArray(runtimeInput.entityInputs)
            ? runtimeInput.entityInputs.map((input: any) => ({
                entityId: String(input?.entityId || ''),
                signerId: String(input?.signerId || ''),
                txs: Array.isArray(input?.entityTxs)
                  ? input.entityTxs.map((tx: any) => ({
                      type: tx?.type || 'unknown',
                      height: Number(tx?.data?.height ?? -1),
                      hasNewFrame: !!tx?.data?.newAccountFrame,
                      hasPrevHanko: !!tx?.data?.prevHanko,
                      toEntityId: String(tx?.data?.toEntityId || ''),
                      fromEntityId: String(tx?.data?.fromEntityId || ''),
                      newFrameHeight: Number(tx?.data?.newAccountFrame?.height ?? -1),
                      newFramePrevHash: String(tx?.data?.newAccountFrame?.prevFrameHash ?? ''),
                      newFrameDeltas: Array.isArray(tx?.data?.newAccountFrame?.deltas)
                        ? tx.data.newAccountFrame.deltas.map((d: any) => String(d))
                        : [],
                      newFrameAccountTxTypes: Array.isArray(tx?.data?.newAccountFrame?.accountTxs)
                        ? tx.data.newAccountFrame.accountTxs.map((atx: any) => atx?.type || 'unknown')
                        : [],
                    }))
                  : [],
              }))
            : [],
        });
      }
    } catch {
      frameTimeline.push({ parseError: true });
    }
    try {
      const snapRaw = await read(`snapshot:${checkpointN}`);
      if (snapRaw) {
        const parsed = JSON.parse(snapRaw);
        const eReps = parsed?.eReplicas;
        snapshotSummary = {
          height: parsed?.height ?? null,
          timestamp: parsed?.timestamp ?? null,
          eReplicasType: Array.isArray(eReps) ? 'array' : typeof eReps,
          eReplicasCount: Array.isArray(eReps) ? eReps.length : null,
        };
      }
    } catch {
      snapshotSummary = { parseError: true };
    }
    return {
      ok: true,
      ns,
      latest,
      checkpoint,
      hasFrameLatest,
      hasSnapshotLatest,
      hasSnapshotCheckpoint: await read(`snapshot:${checkpointN}`) !== null,
      frameSummary,
      frameTimeline,
      snapshotSummary,
    };
  });
}

async function outCap(page: Page, entityId: string, cpId: string): Promise<bigint> {
  return await page.evaluate(async ({ entityId, cpId }) => {
    const env = (window as any).isolatedEnv;
    if (!env?.eReplicas) throw new Error('isolatedEnv missing');
    const runtimeModule = (window as any).XLN
      || await import(/* @vite-ignore */ new URL(`/runtime.js?v=${Date.now()}`, window.location.origin).href);
    const deriveDelta = (runtimeModule as any)?.deriveDelta;
    if (typeof deriveDelta !== 'function') {
      throw new Error('deriveDelta missing');
    }
    const entity = String(entityId || '').toLowerCase();
    const counterparty = String(cpId || '').toLowerCase();
    for (const [key, replica] of env.eReplicas.entries()) {
      const [replicaEntityId] = String(key).split(':');
      if (String(replicaEntityId || '').toLowerCase() !== entity) continue;
      const account = replica?.state?.accounts?.get?.(cpId);
      const delta = account?.deltas?.get?.(1);
      if (!delta) return '0';
      const isLeft = entity < counterparty;
      const derived = deriveDelta(delta, isLeft);
      return String(derived?.outCapacity ?? 0n);
    }
    throw new Error(`replica/account missing for ${entityId} -> ${cpId}`);
  }, { entityId, cpId }).then((raw) => BigInt(String(raw || '0')));
}

async function faucet(page: Page, entityId: string, hubEntityId: string) {
  let result: { ok: boolean; status: number; data: any } = { ok: false, status: 0, data: { error: 'not-run' } };
  for (let attempt = 1; attempt <= 15; attempt++) {
    const runtimeId = await page.evaluate(() => (window as any).isolatedEnv?.runtimeId || null);
    const apiBaseUrl = await getActiveApiBase(page);
    if (!runtimeId) {
      result = { ok: false, status: 0, data: { error: 'missing runtimeId in isolatedEnv' } };
      break;
    }
    try {
      const resp = await page.request.post(`${apiBaseUrl}/api/faucet/offchain`, {
        data: { userEntityId: entityId, userRuntimeId: runtimeId, hubEntityId, tokenId: 1, amount: '100' },
      });
      const data = await resp.json().catch(() => ({}));
      result = { ok: resp.status() === 200, status: resp.status(), data };
    } catch (e: any) {
      result = { ok: false, status: 0, data: { error: e?.message || String(e) } };
    }
    if (result.ok) break;
    const code = String(result.data?.code || '');
    const status = String(result.data?.status || '');
    const transient =
      result.status === 202 ||
      result.status === 409 ||
      code === 'FAUCET_TOKEN_SURFACE_NOT_READY';
    if (!transient || attempt === 15) break;
    await page.waitForTimeout(1000);
  }
  expect(result.ok, `faucet failed for ${entityId.slice(0, 10)}: ${JSON.stringify(result.data)}`).toBe(true);
}

async function faucetViaBrowserFetch(page: Page, entityId: string, hubEntityId: string) {
  const apiBaseUrl = await getActiveApiBase(page);
  const result = await page.evaluate(async ({ eid, hubEntityId, apiBaseUrl }) => {
    try {
      const runtimeId = (window as any).isolatedEnv?.runtimeId;
      if (!runtimeId) {
        return { ok: false, status: 0, data: { error: 'missing runtimeId in isolatedEnv' } };
      }
      const resp = await fetch(`${apiBaseUrl}/api/faucet/offchain`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userEntityId: eid, userRuntimeId: runtimeId, hubEntityId, tokenId: 1, amount: '100' }),
      });
      const data = await resp.json().catch(() => ({}));
      return { ok: resp.status === 200, status: resp.status, data };
    } catch (e: any) {
      return { ok: false, status: 0, data: { error: e?.message || String(e) } };
    }
  }, { eid: entityId, hubEntityId, apiBaseUrl });
  expect(result.ok, `faucet failed for ${entityId.slice(0, 10)}: ${JSON.stringify(result.data)}`).toBe(true);
}

async function waitForOutCapAtLeast(
  page: Page,
  entityId: string,
  cpId: string,
  minOut: bigint,
  timeoutMs = 15_000,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const now = await outCap(page, entityId, cpId);
    if (now >= minOut) return;
    await page.waitForTimeout(400);
  }
  const current = await outCap(page, entityId, cpId);
  throw new Error(
    `waitForOutCapAtLeast timeout: entity=${entityId.slice(0, 10)} cp=${cpId.slice(0, 10)} current=${current.toString()} min=${minOut.toString()}`
  );
}

async function setSnapshotInterval(page: Page, frames: number) {
  const ok = await page.evaluate((frames) => {
    const env = (window as any).isolatedEnv;
    if (!env) return false;
    if (!env.runtimeConfig) env.runtimeConfig = {};
    env.runtimeConfig.snapshotIntervalFrames = frames;
    return true;
  }, frames);
  expect(ok, 'setSnapshotInterval failed').toBe(true);
}

test.describe('E2E: Multi-runtime persistence reload', () => {
  test.setTimeout(120_000);

  test.beforeEach(async ({ page }) => {
    await resetProdServer(page, {
      apiBaseUrl: API_BASE_URL,
      requireHubMesh: true,
      requireMarketMaker: false,
      minHubCount: 3,
      softPreserveHubs: false,
    });
    await gotoApp(page, { appBaseUrl: APP_BASE_URL, settleMs: 600 });
  });

  test('reload restores complex runtime WAL chain from genesis snapshot when #nosnapshot is set', async ({ page }) => {
    page.on('console', msg => {
      const t = msg.text();
      if (
        t.includes('[VaultStore') ||
        t.includes('loadEnvFromDB') ||
        t.includes('[Runtime]') ||
        t.includes('[P2P]') ||
        t.includes('[SAVE]') ||
        t.includes('Failed to save to LevelDB') ||
        t.includes('Recovery halted')
      ) {
        console.log(`[B] ${t.slice(0, 300)}`);
      }
    });

    const alice = await createRuntimeIdentity(page, 'alice', randomMnemonic());
    const bob = await createRuntimeIdentity(page, 'bob', randomMnemonic());
    const hubId = await discoverHub(page);

    await switchToRuntimeId(page, alice.runtimeId);
    await setSnapshotInterval(page, 5);
    await connectHub(page, alice.entityId, alice.signerId, hubId);
    const aliceOutBeforeFaucet = await outCap(page, alice.entityId, hubId);
    for (let i = 0; i < 5; i++) {
      await faucet(page, alice.entityId, hubId);
    }
    await waitForOutCapAtLeast(page, alice.entityId, hubId, aliceOutBeforeFaucet + (500n * 10n ** 18n));
    const aliceOutAfterFaucet = await outCap(page, alice.entityId, hubId);
    expect(aliceOutAfterFaucet - aliceOutBeforeFaucet).toBe(500n * 10n ** 18n);

    await switchToRuntimeId(page, bob.runtimeId);
    await setSnapshotInterval(page, 5);
    await connectHub(page, bob.entityId, bob.signerId, hubId);
    const bobOutBeforeFaucet = await outCap(page, bob.entityId, hubId);
    for (let i = 0; i < 5; i++) {
      await faucet(page, bob.entityId, hubId);
    }
    await waitForOutCapAtLeast(page, bob.entityId, hubId, bobOutBeforeFaucet + (500n * 10n ** 18n));
    const bobOutAfterFaucet = await outCap(page, bob.entityId, hubId);
    expect(bobOutAfterFaucet - bobOutBeforeFaucet).toBe(500n * 10n ** 18n);

    await switchToRuntimeId(page, alice.runtimeId);
    await waitForPairIdle(page, hubId);
    const alicePairBeforePayment = await readPairProgress(page, hubId);
    const alicePayment1 = await sendRoutedHtlcPayment(
      page,
      alice.entityId,
      alice.signerId,
      bob.entityId,
      [alice.entityId, hubId, bob.entityId],
      35n,
      'persist alice->bob #1',
    );
    await waitForSenderHtlcLock(
      page,
      hubId,
      alicePayment1.hashlock,
      Number(alicePairBeforePayment?.recentHtlcLockCount || 0),
    );

    await switchToRuntimeId(page, bob.runtimeId);
    const bobPairBeforePayment = await readPairProgress(page, hubId);
    await waitForRecipientPaymentObserved(
      page,
      hubId,
      alicePayment1.hashlock,
      Number(bobPairBeforePayment?.recentHtlcResolveCount || 0),
    );
    await waitForPairIdle(page, hubId);
    const bobPayment1 = await sendRoutedHtlcPayment(
      page,
      bob.entityId,
      bob.signerId,
      alice.entityId,
      [bob.entityId, hubId, alice.entityId],
      12n,
      'persist bob->alice #1',
    );
    await waitForSenderHtlcLock(
      page,
      hubId,
      bobPayment1.hashlock,
      Number(bobPairBeforePayment?.recentHtlcLockCount || 0),
    );

    await switchToRuntimeId(page, alice.runtimeId);
    const alicePairBeforeReceive = await readPairProgress(page, hubId);
    await waitForRecipientPaymentObserved(
      page,
      hubId,
      bobPayment1.hashlock,
      Number(alicePairBeforeReceive?.recentHtlcResolveCount || 0),
    );
    await waitForPairIdle(page, hubId);

    await switchToRuntimeId(page, alice.runtimeId);
    await placeNonMarketableSwapOrder(page, hubId);
    await expect
      .poll(async () => (await readSwapState(page, alice.entityId, alice.signerId, hubId)).accountSwapOffersSize, { timeout: 60_000 })
      .toBe(1);
    await cancelFirstOpenSwapOrder(page);
    await expect
      .poll(async () => (await readSwapState(page, alice.entityId, alice.signerId, hubId)).accountSwapOffersSize, { timeout: 60_000 })
      .toBe(0);

    await switchToRuntimeId(page, alice.runtimeId);
    const aliceBefore = await runtimeSnapshot(page);
    const aliceDbBefore = await runtimeDbMeta(page);
    const aliceOutBeforeReload = await outCap(page, alice.entityId, hubId);
    const aliceSwapBefore = await readSwapState(page, alice.entityId, alice.signerId, hubId);
    console.log('[PERSIST] before reload', JSON.stringify({
      alice: { out: aliceOutBeforeReload.toString(), swap: aliceSwapBefore, snap: aliceBefore, db: aliceDbBefore },
    }));
    expect(aliceBefore.hasEnv).toBe(true);
    expect(aliceBefore.runtimeHeight).toBeGreaterThan(0);
    expect(Number(aliceDbBefore.checkpoint || 0), 'Alice must have a non-genesis checkpoint before forced replay').toBeGreaterThan(1);
    expect(Number(aliceDbBefore.latest || 0)).toBeGreaterThan(Number(aliceDbBefore.checkpoint || 0));
    expect(aliceSwapBefore.accountSwapOffersSize).toBe(0);

    await page.goto(`${APP_BASE_URL}/app?nosnapshot=1#nosnapshot=1`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => {
      const loadingVisible = Boolean(document.querySelector('.loading-screen'));
      const errorVisible = Boolean(document.querySelector('.error-screen'));
      const viewVisible = Boolean(document.querySelector('.view-wrapper'));
      return !loadingVisible && !errorVisible && viewVisible;
    }, { timeout: 30_000 });
    await page.waitForTimeout(1500);

    await switchToRuntimeId(page, alice.runtimeId);
    const aliceAfter = await runtimeSnapshot(page);
    const aliceDbAfter = await runtimeDbMeta(page);
    const aliceOutAfterReload = await outCap(page, alice.entityId, hubId);
    const aliceSwapAfter = await readSwapState(page, alice.entityId, alice.signerId, hubId);
    console.log('[PERSIST] after reload', JSON.stringify({
      alice: { out: aliceOutAfterReload.toString(), swap: aliceSwapAfter, snap: aliceAfter, db: aliceDbAfter },
    }));

    expect(aliceAfter.hasEnv, 'Alice env must exist after reload').toBe(true);
    expect(aliceAfter.entityCount, 'Alice entities must survive reload').toBeGreaterThan(0);
    expect(aliceAfter.runtimeHeight, 'Alice runtime height must persist').toBeGreaterThan(0);
    expect(aliceAfter.historyFrames, 'Alice history frames must persist').toBeGreaterThan(0);
    expect(aliceOutAfterReload, 'Alice 500 USDC faucet state must persist').toBe(aliceOutBeforeReload);
    expect(aliceOutAfterReload, 'Alice must remain funded after replayed payments and swaps').toBeGreaterThan(0n);
    expect(aliceSwapAfter.accountSwapOffersSize, 'Alice canceled swap offer must stay canceled after genesis replay').toBe(aliceSwapBefore.accountSwapOffersSize);
    expect(aliceAfter.replayMeta?.checkpointHeight, 'Alice restore must replay from snapshot:1').toBe(1);
    expect(String(aliceAfter.replayMeta?.selectedSnapshotLabel || '')).toContain('genesis');
    expect(Number(aliceAfter.replayMeta?.latestHeight || 0)).toBe(Number(aliceDbBefore.latest || 0));
    expect(Number(aliceDbAfter.checkpoint || 0)).toBeGreaterThan(1);
  });
});
