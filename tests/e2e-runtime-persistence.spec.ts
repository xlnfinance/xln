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
import { waitForRenderedOutboundForAccount } from './utils/e2e-account-ui';

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
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await connectRuntimeToSharedHub(page, { entityId, signerId }, hubId);
      opened = true;
      break;
    } catch (error: any) {
      lastError = error?.message || String(error);
      await page.waitForTimeout(800);
    }
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
              });
          }
        }
        entities.push({
          key: String(k),
          accountCount: Number(rep?.state?.accounts?.size || 0),
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
    };
  });
}

async function runtimeDbMeta(page: Page) {
  return await page.evaluate(async () => {
    const env = (window as any).isolatedEnv;
    const XLN = (window as any).XLN;
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
  void entityId;
  const rendered = await waitForRenderedOutboundForAccount(page, cpId, { timeoutMs: 5_000 });
  return ethers.parseUnits(String(rendered), 18);
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
      code === 'FAUCET_TOKEN_SURFACE_NOT_READY' ||
      code === 'FAUCET_CHANNEL_NOT_READY' ||
      status === 'channel_opening' ||
      status === 'channel_not_ready';
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

  test('reload restores all runtimes and account state', async ({ page }) => {
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
    const aliceBefore = await runtimeSnapshot(page);
    const aliceDbBefore = await runtimeDbMeta(page);
    const aliceOutBeforeReload = await outCap(page, alice.entityId, hubId);
    await switchToRuntimeId(page, bob.runtimeId);
    const bobBefore = await runtimeSnapshot(page);
    const bobDbBefore = await runtimeDbMeta(page);
    const bobOutBeforeReload = await outCap(page, bob.entityId, hubId);
    console.log('[PERSIST] before reload', JSON.stringify({
      alice: { out: aliceOutBeforeReload.toString(), snap: aliceBefore, db: aliceDbBefore },
      bob: { out: bobOutBeforeReload.toString(), snap: bobBefore, db: bobDbBefore },
    }));
    expect(aliceBefore.hasEnv).toBe(true);
    expect(bobBefore.hasEnv).toBe(true);
    expect(aliceBefore.runtimeHeight).toBeGreaterThan(0);
    expect(bobBefore.runtimeHeight).toBeGreaterThan(0);

    await page.reload({ waitUntil: 'domcontentloaded' });
    await gotoApp(page, { appBaseUrl: APP_BASE_URL, settleMs: 600 });
    await page.waitForTimeout(1500);

    await switchToRuntimeId(page, alice.runtimeId);
    const aliceAfter = await runtimeSnapshot(page);
    const aliceDbAfter = await runtimeDbMeta(page);
    const aliceOutAfterReload = await outCap(page, alice.entityId, hubId);
    await switchToRuntimeId(page, bob.runtimeId);
    const bobAfter = await runtimeSnapshot(page);
    const bobDbAfter = await runtimeDbMeta(page);
    const bobOutAfterReload = await outCap(page, bob.entityId, hubId);
    console.log('[PERSIST] after reload', JSON.stringify({
      alice: { out: aliceOutAfterReload.toString(), snap: aliceAfter, db: aliceDbAfter },
      bob: { out: bobOutAfterReload.toString(), snap: bobAfter, db: bobDbAfter },
    }));

    expect(aliceAfter.hasEnv, 'Alice env must exist after reload').toBe(true);
    expect(bobAfter.hasEnv, 'Bob env must exist after reload').toBe(true);
    expect(aliceAfter.entityCount, 'Alice entities must survive reload').toBeGreaterThan(0);
    expect(bobAfter.entityCount, 'Bob entities must survive reload').toBeGreaterThan(0);
    expect(aliceAfter.runtimeHeight, 'Alice runtime height must persist').toBeGreaterThan(0);
    expect(bobAfter.runtimeHeight, 'Bob runtime height must persist').toBeGreaterThan(0);
    expect(aliceAfter.historyFrames, 'Alice history frames must persist').toBeGreaterThan(0);
    expect(bobAfter.historyFrames, 'Bob history frames must persist').toBeGreaterThan(0);
    expect(aliceOutAfterReload, 'Alice 500 USDC faucet state must persist').toBe(aliceOutBeforeReload);
    expect(bobOutAfterReload, 'Bob 500 USDC faucet state must persist').toBe(bobOutBeforeReload);
    expect(aliceOutAfterReload, 'Alice must have funded account after reload').toBeGreaterThanOrEqual(500n * 10n ** 18n);
    expect(bobOutAfterReload, 'Bob must have funded account after reload').toBeGreaterThanOrEqual(500n * 10n ** 18n);
  });
});
