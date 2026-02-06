/**
 * E2E: Alice → Hub → Bob Payment Flow (and reverse)
 *
 * Uses random BIP39 mnemonics → fresh entities each run → no server state conflicts.
 * Exercises: runtime creation, hub discovery, account opening, faucet, directPayment.
 *
 * Prereqs: localhost:8080 dev server, xln.finance for relay/faucet
 */

import { test, expect, type Page } from '@playwright/test';

const INIT_TIMEOUT = 30_000;
const SETTLE_MS = 8_000;

function toWei(n: number): bigint {
  return BigInt(n) * 10n ** 18n;
}

// ─── Helpers ─────────────────────────────────────────────────────

/** Navigate to /app. Auto-unlock if redirect occurs. */
async function gotoApp(page: Page) {
  await page.goto('https://localhost:8080/app');
  // Handle unlock redirect
  const unlock = page.locator('button:has-text("Unlock")');
  if (await unlock.isVisible({ timeout: 2000 }).catch(() => false)) {
    const input = page.locator('input').first();
    await input.fill('mml');
    await unlock.click();
    await page.waitForURL('**/app', { timeout: 10_000 });
  }
  // Wait for XLN module to load
  await page.waitForFunction(() => (window as any).XLN, { timeout: INIT_TIMEOUT });
  await page.waitForTimeout(2000);
}

/** Generate random BIP39 mnemonic in browser */
async function randomMnemonic(page: Page): Promise<string> {
  return page.evaluate(async () => {
    const { Wallet } = await import(/* @vite-ignore */ 'ethers') as any;
    return Wallet.createRandom().mnemonic.phrase;
  });
}

/** Create a runtime via vaultStore (Vite dev dynamic import) */
async function createRuntime(page: Page, label: string, mnemonic: string) {
  const r = await page.evaluate(async ({ label, mnemonic }) => {
    try {
      const { vaultOperations } = await import(/* @vite-ignore */ '/src/lib/stores/vaultStore.ts') as any;
      await vaultOperations.createRuntime(label, mnemonic);
      return { ok: true };
    } catch (e: any) {
      return { ok: false, error: e.message };
    }
  }, { label, mnemonic });
  expect(r.ok, `createRuntime(${label}) failed: ${r.error}`).toBe(true);
  // Wait for entity creation, P2P start, gossip
  await page.waitForTimeout(5000);
}

/** Get first entity from active runtime's env */
async function getEntity(page: Page) {
  return page.evaluate(() => {
    const env = (window as any).isolatedEnv;
    const XLN = (window as any).XLN;
    if (!env?.eReplicas || !XLN) return null;
    for (const [key, rep] of env.eReplicas.entries()) {
      const [entityId, signerId] = key.split(':');
      const accounts: Array<{ cpId: string; out: string; in_: string }> = [];
      if (rep.state?.accounts) {
        for (const [cpId, acc] of rep.state.accounts.entries()) {
          const d = acc.deltas?.get(1);
          if (d) {
            const v = XLN.deriveDelta(d, entityId < cpId);
            accounts.push({ cpId: String(cpId), out: v.outCapacity.toString(), in_: v.inCapacity.toString() });
          }
        }
      }
      return { entityId, signerId, accounts };
    }
    return null;
  });
}

/** Switch runtime via dropdown */
async function switchTo(page: Page, label: string) {
  await page.locator('button').filter({ hasText: /🧭.*▼/ }).first().click();
  await page.waitForTimeout(400);
  const btn = page.locator('button').filter({ hasText: new RegExp(label, 'i') }).first();
  if (await btn.isVisible({ timeout: 2000 }).catch(() => false)) {
    await btn.click();
  } else {
    await page.keyboard.press('Escape');
    throw new Error(`Runtime "${label}" not in dropdown`);
  }
  await page.waitForTimeout(1500);
}

/** Discover hub via gossip polling */
async function discoverHub(page: Page): Promise<string> {
  const id = await page.evaluate(async () => {
    for (let i = 0; i < 45; i++) {
      try {
        const env = (window as any).isolatedEnv;
        const profiles = env?.gossip?.getProfiles?.() || [];
        const hub = profiles.find((p: any) => p.metadata?.isHub);
        if (hub) return hub.entityId;
      } catch {}
      await new Promise(r => setTimeout(r, 1000));
    }
    return null;
  });
  expect(id, 'Hub not found via gossip (45s)').not.toBeNull();
  return id!;
}

/** Open account + 10k USDC credit with hub */
async function connectHub(page: Page, entityId: string, signerId: string, hubId: string) {
  const r = await page.evaluate(async ({ entityId, signerId, hubId }) => {
    try {
      const XLN = (window as any).XLN;
      const env = (window as any).isolatedEnv;
      await XLN.process(env, [{
        entityId, signerId,
        entityTxs: [{ type: 'openAccount', data: { targetEntityId: hubId, creditAmount: 10_000n * 10n ** 18n, tokenId: 1 } }]
      }]);
      return { ok: true };
    } catch (e: any) { return { ok: false, error: e.message }; }
  }, { entityId, signerId, hubId });
  expect(r.ok, `connectHub failed: ${r.error}`).toBe(true);
  await page.waitForTimeout(SETTLE_MS);
}

/** Get USDC outCapacity */
async function outCap(page: Page, entityId: string, cpId: string): Promise<bigint> {
  const s = await page.evaluate(({ entityId, cpId }) => {
    const env = (window as any).isolatedEnv;
    const XLN = (window as any).XLN;
    if (!env || !XLN) return '0';
    for (const [k, r] of env.eReplicas.entries()) {
      if (!k.startsWith(entityId + ':')) continue;
      const d = r.state?.accounts?.get(cpId)?.deltas?.get(1);
      if (!d) return '0';
      return XLN.deriveDelta(d, entityId < cpId).outCapacity.toString();
    }
    return '0';
  }, { entityId, cpId });
  return BigInt(s);
}

/** Faucet 100 USDC */
async function faucet(page: Page, entityId: string) {
  const r = await page.evaluate(async (eid) => {
    const resp = await fetch('/api/faucet/offchain', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userEntityId: eid, tokenId: 1, amount: '100' }),
    });
    return { ok: resp.ok, data: await resp.json() };
  }, entityId);
  expect(r.ok, `Faucet: ${JSON.stringify(r.data)}`).toBe(true);
  await page.waitForTimeout(SETTLE_MS);
}

/** Send directPayment */
async function pay(page: Page, from: string, signerId: string, to: string, route: string[], amount: bigint) {
  const r = await page.evaluate(async ({ from, signerId, to, route, amt }) => {
    try {
      const XLN = (window as any).XLN;
      const env = (window as any).isolatedEnv;
      await XLN.process(env, [{
        entityId: from, signerId,
        entityTxs: [{ type: 'directPayment', data: { targetEntityId: to, tokenId: 1, amount: BigInt(amt), route } }],
      }]);
      return { ok: true };
    } catch (e: any) { return { ok: false, error: e.message }; }
  }, { from, signerId, to, route, amt: amount.toString() });
  expect(r.ok, `Payment: ${r.error}`).toBe(true);
  await page.waitForTimeout(SETTLE_MS);
}

// ─── Test ─────────────────────────────────────────────────────────

test.describe('E2E: Alice ↔ Hub ↔ Bob', () => {
  test.setTimeout(180_000);

  test('bidirectional payments through hub', async ({ page }) => {
    page.on('console', msg => {
      const t = msg.text();
      if (t.includes('[E2E]') || msg.type() === 'error')
        console.log(`[B] ${t.slice(0, 250)}`);
    });

    // ── 1. Navigate ──────────────────────────────────────────────
    console.log('[E2E] 1. Navigate to app');
    await gotoApp(page);

    // ── 2. Create Alice + Bob with random mnemonics ──────────────
    console.log('[E2E] 2. Create runtimes');
    const aliceMnemonic = await randomMnemonic(page);
    const bobMnemonic = await randomMnemonic(page);
    console.log(`[E2E] Alice mnemonic: ${aliceMnemonic.split(' ').slice(0, 3).join(' ')}...`);
    console.log(`[E2E] Bob mnemonic: ${bobMnemonic.split(' ').slice(0, 3).join(' ')}...`);

    await createRuntime(page, 'alice', aliceMnemonic);
    const alice = await getEntity(page);
    expect(alice, 'Alice entity missing').not.toBeNull();
    console.log(`[E2E] Alice: ${alice!.entityId.slice(0, 16)}  signer: ${alice!.signerId.slice(0, 10)}`);

    await createRuntime(page, 'bob', bobMnemonic);
    const bob = await getEntity(page);
    expect(bob, 'Bob entity missing').not.toBeNull();
    expect(bob!.entityId).not.toBe(alice!.entityId);
    console.log(`[E2E] Bob: ${bob!.entityId.slice(0, 16)}  signer: ${bob!.signerId.slice(0, 10)}`);

    // ── 3. Discover Hub ──────────────────────────────────────────
    console.log('[E2E] 3. Discover hub');
    const hubId = await discoverHub(page);
    console.log(`[E2E] Hub: ${hubId.slice(0, 16)}`);

    // ── 4. Connect both to Hub ───────────────────────────────────
    console.log('[E2E] 4. Connect both to hub');
    // Bob is active (just created)
    await connectHub(page, bob!.entityId, bob!.signerId, hubId);
    console.log('[E2E] Bob ↔ Hub connected');

    await switchTo(page, 'alice');
    await connectHub(page, alice!.entityId, alice!.signerId, hubId);
    console.log('[E2E] Alice ↔ Hub connected');

    // ── 5. Faucet Alice ──────────────────────────────────────────
    console.log('[E2E] 5. Faucet Alice');
    const a0 = await outCap(page, alice!.entityId, hubId);
    await faucet(page, alice!.entityId);
    const a1 = await outCap(page, alice!.entityId, hubId);
    console.log(`[E2E] Alice OUT: ${a0} → ${a1}`);
    expect(a1, 'Faucet should increase Alice OUT').toBeGreaterThan(a0);

    // ── 6. Alice → Hub → Bob (10 USDC) ──────────────────────────
    console.log('[E2E] 6. Forward payment: Alice → Hub → Bob');
    await switchTo(page, 'bob');
    const b0 = await outCap(page, bob!.entityId, hubId);

    await switchTo(page, 'alice');
    await pay(page, alice!.entityId, alice!.signerId, bob!.entityId,
      [alice!.entityId, hubId, bob!.entityId], toWei(10));

    const a2 = await outCap(page, alice!.entityId, hubId);
    expect(a2, 'Alice OUT should decrease').toBeLessThan(a1);

    await switchTo(page, 'bob');
    await page.waitForTimeout(2000);
    const b1 = await outCap(page, bob!.entityId, hubId);
    console.log(`[E2E] Bob OUT: ${b0} → ${b1}`);
    expect(b1, 'Bob OUT should increase').toBeGreaterThan(b0);
    console.log('[E2E] ✅ Forward verified');

    // ── 7. Faucet Bob + Reverse: Bob → Hub → Alice (10 USDC) ────
    console.log('[E2E] 7. Reverse: Bob → Hub → Alice');
    await faucet(page, bob!.entityId);
    const b2 = await outCap(page, bob!.entityId, hubId);

    await switchTo(page, 'alice');
    const a3 = await outCap(page, alice!.entityId, hubId);

    await switchTo(page, 'bob');
    await pay(page, bob!.entityId, bob!.signerId, alice!.entityId,
      [bob!.entityId, hubId, alice!.entityId], toWei(10));

    const b3 = await outCap(page, bob!.entityId, hubId);
    expect(b3, 'Bob OUT should decrease').toBeLessThan(b2);

    await switchTo(page, 'alice');
    await page.waitForTimeout(2000);
    const a4 = await outCap(page, alice!.entityId, hubId);
    console.log(`[E2E] Alice OUT: ${a3} → ${a4}`);
    expect(a4, 'Alice OUT should increase').toBeGreaterThan(a3);

    console.log('[E2E] ✅ Reverse verified');
    console.log('[E2E] ✅ Full bidirectional E2E complete');
  });
});
