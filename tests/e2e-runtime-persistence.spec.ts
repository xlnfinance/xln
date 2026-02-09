import { test, expect, type Page } from '@playwright/test';
import { Wallet } from 'ethers';

const APP_BASE_URL = process.env.E2E_BASE_URL ?? 'https://xln.finance';
const API_BASE_URL = process.env.E2E_API_BASE_URL ?? APP_BASE_URL;
const INIT_TIMEOUT = 30_000;

function randomMnemonic(): string {
  return Wallet.createRandom().mnemonic!.phrase;
}

async function gotoApp(page: Page) {
  await page.goto(`${APP_BASE_URL}/app`);
  const unlock = page.locator('button:has-text("Unlock")');
  if (await unlock.isVisible({ timeout: 2000 }).catch(() => false)) {
    await page.locator('input').first().fill('mml');
    await unlock.click();
    await page.waitForURL('**/app', { timeout: 10_000 });
  }
  await page.waitForFunction(() => (window as any).XLN, { timeout: INIT_TIMEOUT });
  await page.waitForTimeout(1500);
}

async function resetProdServer(page: Page, preserveHubs = true) {
  const reset = await page.evaluate(async ({ preserveHubs, apiBaseUrl }) => {
    const res = await fetch(`${apiBaseUrl}/api/reset-server`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ preserveHubs }),
    });
    const body = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, body };
  }, { preserveHubs, apiBaseUrl: API_BASE_URL });
  if (!reset.ok && reset.status !== 404) {
    expect(reset.ok, `reset-server failed: ${JSON.stringify(reset.body)}`).toBe(true);
  }
}

async function createRuntime(page: Page, label: string, mnemonic: string) {
  const info = await page.evaluate(async ({ label, mnemonic }) => {
    const v = (window as any).vaultOperations;
    if (!v) return { ok: false, error: 'vaultOperations missing' };
    const runtime = await v.createRuntime(label, mnemonic);
    const env = (window as any).isolatedEnv;
    let entityId: string | null = null;
    if (env?.eReplicas) {
      for (const [key] of env.eReplicas.entries()) {
        const [eid, sid] = String(key).split(':');
        if (String(sid || '').toLowerCase() === String(runtime?.id || '').toLowerCase()) {
          entityId = eid;
          break;
        }
      }
    }
    return { ok: true, runtimeId: runtime?.id, signerId: runtime?.id, entityId };
  }, { label, mnemonic });
  expect(info.ok, `createRuntime failed: ${info.error || 'unknown'}`).toBe(true);
  expect(info.runtimeId).toBeTruthy();
  expect((info as any).signerId).toBeTruthy();
  expect(info.entityId).toBeTruthy();
  await page.waitForTimeout(4000);
  return info as { ok: true; runtimeId: string; signerId: string; entityId: string };
}

async function switchRuntime(page: Page, runtimeId: string) {
  const ok = await page.evaluate(async (runtimeId) => {
    const v = (window as any).vaultOperations;
    if (!v?.selectRuntime) return false;
    await v.selectRuntime(runtimeId);
    return true;
  }, runtimeId);
  expect(ok, `selectRuntime(${runtimeId.slice(0, 10)}) failed`).toBe(true);
  await page.waitForTimeout(1500);
}

async function discoverHub(page: Page) {
  const hubId = await page.evaluate(async () => {
    const env = (window as any).isolatedEnv;
    const p2p = env?.runtimeState?.p2p;
    if (p2p?.refreshGossip) await p2p.refreshGossip();
    await new Promise((r) => setTimeout(r, 1500));
    const hubs = env?.gossip?.getHubs?.() ?? [];
    return hubs[0]?.entityId || null;
  });
  expect(hubId, 'No hub discovered').toBeTruthy();
  return hubId as string;
}

async function connectHub(page: Page, entityId: string, signerId: string, hubId: string) {
  let opened = false;
  for (let attempt = 1; attempt <= 5; attempt++) {
    const result = await page.evaluate(async ({ entityId, signerId, hubId }) => {
      try {
        const env = (window as any).isolatedEnv;
        const XLN = (window as any).XLN;
        if (!env || !XLN) return { ok: false, error: 'env/xln missing' };
        const p2p = env?.runtimeState?.p2p;
        if (typeof p2p?.refreshGossip === 'function') {
          try { await p2p.refreshGossip(); } catch {}
        }
        await XLN.process(env, [{
          entityId,
          signerId,
          entityTxs: [{
            type: 'openAccount',
            data: {
              targetEntityId: hubId,
              creditAmount: 10_000n * 10n ** 18n,
              tokenId: 1
            }
          }]
        }]);
        return { ok: true };
      } catch (e: any) {
        return { ok: false, error: e?.message || String(e) };
      }
    }, { entityId, signerId, hubId });
    expect(result.ok, `connectHub failed for ${entityId.slice(0, 10)}: ${result.error || 'unknown'}`).toBe(true);

    opened = await page.evaluate(async ({ entityId, hubId }) => {
      const ent = String(entityId).toLowerCase();
      const start = Date.now();
      while (Date.now() - start < 30_000) {
        const env = (window as any).isolatedEnv;
        if (env?.eReplicas) {
          for (const [key, rep] of env.eReplicas.entries()) {
            const id = String(key).split(':')[0].toLowerCase();
            if (id !== ent) continue;
            const accounts = rep?.state?.accounts;
            if (!accounts) continue;
            for (const [cpId, acc] of accounts.entries()) {
              if (String(cpId).toLowerCase() !== String(hubId).toLowerCase()) continue;
              const hasDelta = !!acc?.deltas?.get?.(1);
              const noPending = !acc?.pendingFrame;
              if (hasDelta && noPending) return true;
            }
          }
        }
        await new Promise((r) => setTimeout(r, 750));
      }
      return false;
    }, { entityId, hubId });
    if (opened) break;
    await page.waitForTimeout(2000);
  }

  expect(opened, `Hub account missing for ${entityId.slice(0, 10)} -> ${hubId.slice(0, 10)}`).toBe(true);
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

async function outCap(page: Page, entityId: string, cpId: string): Promise<bigint> {
  const s = await page.evaluate(({ entityId, cpId }) => {
    const env = (window as any).isolatedEnv;
    const XLN = (window as any).XLN;
    if (!env || !XLN) return '0';
    for (const [k, r] of env.eReplicas.entries()) {
      if (!k.startsWith(entityId + ':')) continue;
      const acc = r.state?.accounts?.get(cpId);
      if (!acc) return '0';
      const d = acc.deltas?.get(1);
      if (!d) return '0';
      return XLN.deriveDelta(d, entityId < cpId).outCapacity.toString();
    }
    return '0';
  }, { entityId, cpId });
  return BigInt(s);
}

async function faucet(page: Page, entityId: string) {
  const result = await page.evaluate(async (eid) => {
    try {
      const resp = await fetch('/api/faucet/offchain', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userEntityId: eid, tokenId: 1, amount: '100' }),
      });
      const data = await resp.json().catch(() => ({}));
      return { ok: resp.ok, status: resp.status, data };
    } catch (e: any) {
      return { ok: false, status: 0, data: { error: e?.message || String(e) } };
    }
  }, entityId);
  expect(result.ok, `faucet failed for ${entityId.slice(0, 10)}: ${JSON.stringify(result.data)}`).toBe(true);
  await page.waitForTimeout(10_000);
}

test.describe('E2E: Multi-runtime persistence reload', () => {
  test.setTimeout(180_000);

  test.beforeEach(async ({ page }) => {
    await gotoApp(page);
    await resetProdServer(page, true);
  });

  test.afterEach(async ({ page }) => {
    await resetProdServer(page, true);
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

    const alice = await createRuntime(page, 'alice', randomMnemonic());
    const bob = await createRuntime(page, 'bob', randomMnemonic());
    const hubId = await discoverHub(page);

    await switchRuntime(page, alice.runtimeId);
    await connectHub(page, alice.entityId, alice.signerId, hubId);
    const aliceOutBeforeFaucet = await outCap(page, alice.entityId, hubId);
    await faucet(page, alice.entityId);
    const aliceOutAfterFaucet = await outCap(page, alice.entityId, hubId);
    expect(aliceOutAfterFaucet - aliceOutBeforeFaucet).toBe(100n * 10n ** 18n);

    await switchRuntime(page, bob.runtimeId);
    await connectHub(page, bob.entityId, bob.signerId, hubId);
    const bobOutBeforeFaucet = await outCap(page, bob.entityId, hubId);
    await faucet(page, bob.entityId);
    const bobOutAfterFaucet = await outCap(page, bob.entityId, hubId);
    expect(bobOutAfterFaucet - bobOutBeforeFaucet).toBe(100n * 10n ** 18n);

    await switchRuntime(page, alice.runtimeId);
    const aliceBefore = await runtimeSnapshot(page);
    const aliceOutBeforeReload = await outCap(page, alice.entityId, hubId);
    await switchRuntime(page, bob.runtimeId);
    const bobBefore = await runtimeSnapshot(page);
    const bobOutBeforeReload = await outCap(page, bob.entityId, hubId);
    console.log('[PERSIST] before reload', JSON.stringify({
      alice: { out: aliceOutBeforeReload.toString(), snap: aliceBefore },
      bob: { out: bobOutBeforeReload.toString(), snap: bobBefore },
    }));
    expect(aliceBefore.hasEnv).toBe(true);
    expect(bobBefore.hasEnv).toBe(true);
    expect(aliceBefore.runtimeHeight).toBeGreaterThan(0);
    expect(bobBefore.runtimeHeight).toBeGreaterThan(0);

    await page.reload({ waitUntil: 'domcontentloaded' });
    await gotoApp(page);
    await page.waitForTimeout(5000);

    await switchRuntime(page, alice.runtimeId);
    const aliceAfter = await runtimeSnapshot(page);
    const aliceOutAfterReload = await outCap(page, alice.entityId, hubId);
    await switchRuntime(page, bob.runtimeId);
    const bobAfter = await runtimeSnapshot(page);
    const bobOutAfterReload = await outCap(page, bob.entityId, hubId);
    console.log('[PERSIST] after reload', JSON.stringify({
      alice: { out: aliceOutAfterReload.toString(), snap: aliceAfter },
      bob: { out: bobOutAfterReload.toString(), snap: bobAfter },
    }));

    expect(aliceAfter.hasEnv, 'Alice env must exist after reload').toBe(true);
    expect(bobAfter.hasEnv, 'Bob env must exist after reload').toBe(true);
    expect(aliceAfter.entityCount, 'Alice entities must survive reload').toBeGreaterThan(0);
    expect(bobAfter.entityCount, 'Bob entities must survive reload').toBeGreaterThan(0);
    expect(aliceAfter.runtimeHeight, 'Alice runtime height must persist').toBeGreaterThan(0);
    expect(bobAfter.runtimeHeight, 'Bob runtime height must persist').toBeGreaterThan(0);
    expect(aliceAfter.historyFrames, 'Alice history frames must persist').toBeGreaterThan(0);
    expect(bobAfter.historyFrames, 'Bob history frames must persist').toBeGreaterThan(0);
    expect(aliceOutAfterReload, 'Alice 100 USDC faucet state must persist').toBe(aliceOutBeforeReload);
    expect(bobOutAfterReload, 'Bob 100 USDC faucet state must persist').toBe(bobOutBeforeReload);
    expect(aliceOutAfterReload, 'Alice must have funded account after reload').toBeGreaterThanOrEqual(100n * 10n ** 18n);
    expect(bobOutAfterReload, 'Bob must have funded account after reload').toBeGreaterThanOrEqual(100n * 10n ** 18n);
  });
});
