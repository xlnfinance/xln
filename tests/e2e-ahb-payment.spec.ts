/**
 * E2E: Alice → Hub → Bob HTLC Payment Flow (and reverse)
 *
 * Uses random BIP39 mnemonics → fresh entities each run → no server state conflicts.
 * Exercises: runtime creation, hub discovery, account opening, faucet, htlcPayment.
 *
 * Prereqs: localhost:8080 dev server, xln.finance for relay/faucet
 */

import { test, expect, type Page } from '@playwright/test';
import { Wallet, ethers } from 'ethers';

const INIT_TIMEOUT = 30_000;
const SETTLE_MS = 10_000;

// Fee: amount × FEE_RATE_UBP / FEE_DENOMINATOR (0.001% per hop)
const FEE_RATE = 100n;
const FEE_DENOM = 10_000_000n;
const calcFee = (amount: bigint): bigint => amount * FEE_RATE / FEE_DENOM;
const afterFee = (amount: bigint): bigint => amount - calcFee(amount);

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

/** Generate random BIP39 mnemonic (Node.js side — no browser import needed) */
function randomMnemonic(): string {
  return Wallet.createRandom().mnemonic!.phrase;
}

/** Create a runtime via vaultStore (Vite dev dynamic import) */
async function createRuntime(page: Page, label: string, mnemonic: string) {
  const r = await page.evaluate(async ({ label, mnemonic }) => {
    try {
      const { vaultOperations } = await import(/* @vite-ignore */ '/src/lib/stores/vaultStore.ts') as any;
      await vaultOperations.createRuntime(label, mnemonic);
      // Tag env with debug ID for tracking identity
      const env = (window as any).isolatedEnv;
      if (env && !env._debugId) env._debugId = label + '-' + Date.now();
      return { ok: true, debugId: env?._debugId };
    } catch (e: any) {
      return { ok: false, error: e.message };
    }
  }, { label, mnemonic });
  expect(r.ok, `createRuntime(${label}) failed: ${r.error}`).toBe(true);
  console.log(`[E2E] Created runtime ${label}, env debugId=${r.debugId}`);
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

/** Dump full runtime state diagnostics */
async function dumpState(page: Page, label: string) {
  const info = await page.evaluate((label) => {
    const env = (window as any).isolatedEnv;
    if (!env) return { label, error: 'no isolatedEnv' };

    const entities: any[] = [];
    if (env.eReplicas) {
      for (const [key, rep] of env.eReplicas.entries()) {
        const accounts: any[] = [];
        if (rep.state?.accounts) {
          for (const [cpId, acc] of rep.state.accounts.entries()) {
            const deltas: any[] = [];
            if (acc.deltas) {
              for (const [tokenId, d] of acc.deltas.entries()) {
                const XLN = (window as any).XLN;
                const entityId = key.split(':')[0];
                const v = XLN?.deriveDelta?.(d, entityId < cpId);
                deltas.push({
                  tokenId,
                  out: v?.outCapacity?.toString() || '?',
                  in_: v?.inCapacity?.toString() || '?',
                  offdelta: d.offdelta?.toString() || '0',
                });
              }
            }
            accounts.push({
              cpId: cpId.slice(0, 16),
              mempoolLen: acc.mempool?.length || 0,
              height: acc.height || 0,
              deltas,
            });
          }
        }
        entities.push({
          key,  // Full key to see entityId:signerId
          entityHeight: rep.state?.height || 0,
          accountCount: rep.state?.accounts?.size || 0,
          accounts,
        });
      }
    }

    const p2p = env.runtimeState?.p2p;
    const gossipProfiles = env.gossip?.getProfiles?.()?.length || 0;

    return {
      label,
      runtimeId: env.runtimeId?.slice(0, 12) || 'none',
      envObjId: `env@${env._debugId || 'no-id'}`,
      loopActive: env.runtimeState?.loopActive || false,
      p2pConnected: !!p2p,
      gossipProfiles,
      entityCount: env.eReplicas?.size || 0,
      eReplicaKeys: env.eReplicas ? [...env.eReplicas.keys()] : [],
      entities,
    };
  }, label);
  console.log(`[E2E] STATE(${label}):`, JSON.stringify(info, null, 2));
  return info;
}

/** Switch runtime via programmatic call (more reliable than UI click) */
async function switchTo(page: Page, label: string) {
  const r = await page.evaluate(async (label) => {
    try {
      const { runtimesState, vaultOperations } = await import(/* @vite-ignore */ '/src/lib/stores/vaultStore.ts') as any;
      // Read store value without importing svelte/store — subscribe fires synchronously
      let state: any;
      const unsub = runtimesState.subscribe((s: any) => { state = s; });
      unsub();
      // Find runtime by label
      for (const [id, runtime] of Object.entries(state.runtimes) as any[]) {
        if (runtime.label?.toLowerCase() === label.toLowerCase()) {
          await vaultOperations.selectRuntime(id);
          return { ok: true, id: id.slice(0, 12) };
        }
      }
      return { ok: false, error: `Runtime "${label}" not found in runtimes: ${Object.values(state.runtimes).map((r: any) => r.label).join(',')}` };
    } catch (e: any) {
      return { ok: false, error: e.message };
    }
  }, label);
  expect(r.ok, `switchTo(${label}) failed: ${r.error}`).toBe(true);
  // Check and tag env after switch
  const envInfo = await page.evaluate((label) => {
    const env = (window as any).isolatedEnv;
    if (env && !env._debugId) env._debugId = label + '-switch-' + Date.now();
    const keys = env?.eReplicas ? [...env.eReplicas.keys()] : [];
    return { debugId: env?._debugId, eReplicaCount: keys.length, keys: keys.map((k: string) => k.slice(0, 20)) };
  }, label);
  console.log(`[E2E] Switched to ${label} (${r.id}), envId=${envInfo.debugId}, eReplicas=${envInfo.eReplicaCount}: [${envInfo.keys.join(', ')}]`);
  await page.waitForTimeout(2000);
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
      console.log(`[E2E] connectHub: env.runtimeId=${env?.runtimeId?.slice(0,12)}, entityId=${entityId.slice(0,12)}, hubId=${hubId.slice(0,12)}`);
      await XLN.process(env, [{
        entityId, signerId,
        entityTxs: [{ type: 'openAccount', data: { targetEntityId: hubId, creditAmount: 10_000n * 10n ** 18n, tokenId: 1 } }]
      }]);
      // Check if account was created locally
      for (const [k, rep] of env.eReplicas.entries()) {
        if (!k.startsWith(entityId + ':')) continue;
        const hasAccount = rep.state?.accounts?.has(hubId);
        const accSize = rep.state?.accounts?.size || 0;
        return { ok: true, hasAccount, accSize };
      }
      return { ok: true, hasAccount: false, accSize: 0 };
    } catch (e: any) { return { ok: false, error: e.message }; }
  }, { entityId, signerId, hubId });
  console.log(`[E2E] connectHub result:`, JSON.stringify(r));
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
      const acc = r.state?.accounts?.get(cpId);
      if (!acc) return 'NO_ACCOUNT';
      const d = acc.deltas?.get(1);
      if (!d) return 'NO_DELTA';
      return XLN.deriveDelta(d, entityId < cpId).outCapacity.toString();
    }
    return 'NO_ENTITY';
  }, { entityId, cpId });
  if (s === 'NO_ACCOUNT' || s === 'NO_DELTA' || s === 'NO_ENTITY') {
    console.log(`[E2E] outCap(${entityId.slice(0,12)}, ${cpId.slice(0,12)}) = ${s}`);
    return 0n;
  }
  return BigInt(s);
}

/** Faucet 100 USDC (with 30s timeout) */
async function faucet(page: Page, entityId: string) {
  const r = await page.evaluate(async (eid) => {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 30_000);
      const resp = await fetch('/api/faucet/offchain', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userEntityId: eid, tokenId: 1, amount: '100' }),
        signal: ctrl.signal,
      });
      clearTimeout(timer);
      const data = await resp.json();
      return { ok: resp.ok, status: resp.status, data };
    } catch (e: any) {
      return { ok: false, status: 0, data: { error: e.message } };
    }
  }, entityId);
  console.log(`[E2E] Faucet response: status=${r.status} data=${JSON.stringify(r.data)}`);
  expect(r.ok, `Faucet: ${JSON.stringify(r.data)}`).toBe(true);
  await page.waitForTimeout(SETTLE_MS);
}

/** Generate HTLC secret + hashlock (Node.js side) */
function generateHtlc(): { secret: string; hashlock: string } {
  const secret = ethers.hexlify(ethers.randomBytes(32));
  const abiCoder = ethers.AbiCoder.defaultAbiCoder();
  const hashlock = ethers.keccak256(abiCoder.encode(['bytes32'], [secret]));
  return { secret, hashlock };
}

/** Send htlcPayment (replaces directPayment) */
async function pay(page: Page, from: string, signerId: string, to: string, route: string[], amount: bigint) {
  const { secret, hashlock } = generateHtlc();
  console.log(`[E2E] HTLC: secret=${secret.slice(0, 16)}... hashlock=${hashlock.slice(0, 16)}...`);

  const r = await page.evaluate(async ({ from, signerId, to, route, amt, secret, hashlock }) => {
    try {
      const XLN = (window as any).XLN;
      const env = (window as any).isolatedEnv;

      // Pre-pay diagnostics
      const preKeys = env.eReplicas ? [...env.eReplicas.keys()] : [];
      let preAccounts = 0;
      for (const [k, rep] of (env.eReplicas || new Map()).entries()) {
        if (k.startsWith(from + ':')) preAccounts = rep.state?.accounts?.size || 0;
      }
      console.log(`[E2E] pay() PRE: envId=${env._debugId}, eReplicas=[${preKeys.join(', ')}], fromAccounts=${preAccounts}`);

      await XLN.process(env, [{
        entityId: from, signerId,
        entityTxs: [{ type: 'htlcPayment', data: { targetEntityId: to, tokenId: 1, amount: BigInt(amt), route, secret, hashlock } }],
      }]);

      // Post-process diagnostics (immediate, before settle)
      const postKeys = env.eReplicas ? [...env.eReplicas.keys()] : [];
      let postAccounts = 0;
      for (const [k, rep] of (env.eReplicas || new Map()).entries()) {
        if (k.startsWith(from + ':')) postAccounts = rep.state?.accounts?.size || 0;
      }
      console.log(`[E2E] pay() POST-PROCESS: eReplicas=[${postKeys.join(', ')}], fromAccounts=${postAccounts}`);

      return { ok: true, preKeys, postKeys, preAccounts, postAccounts };
    } catch (e: any) { return { ok: false, error: e.message, preKeys: [], postKeys: [], preAccounts: 0, postAccounts: 0 }; }
  }, { from, signerId, to, route, amt: amount.toString(), secret, hashlock });
  console.log(`[E2E] pay() result: pre=${r.preAccounts}accs/${r.preKeys.length}ents → post=${r.postAccounts}accs/${r.postKeys.length}ents`);
  expect(r.ok, `htlcPayment: ${r.error}`).toBe(true);

  // Check state midway through settle
  await page.waitForTimeout(SETTLE_MS / 2);
  const mid = await page.evaluate((from) => {
    const env = (window as any).isolatedEnv;
    const keys = env.eReplicas ? [...env.eReplicas.keys()] : [];
    let accounts = 0;
    for (const [k, rep] of (env.eReplicas || new Map()).entries()) {
      if (k.startsWith(from + ':')) accounts = rep.state?.accounts?.size || 0;
    }
    return { envId: env._debugId, keys, accounts };
  }, from);
  console.log(`[E2E] pay() MID-SETTLE: envId=${mid.envId}, eReplicas=[${mid.keys.join(', ')}], fromAccounts=${mid.accounts}`);

  await page.waitForTimeout(SETTLE_MS / 2);
}

/** Take named screenshot and save to test-results */
async function screenshot(page: Page, name: string) {
  await page.screenshot({ path: `tests/test-results/${name}.png`, fullPage: true });
  console.log(`[E2E] 📸 Screenshot: ${name}.png`);
}

// ─── Test ─────────────────────────────────────────────────────────

test.describe('E2E: Alice ↔ Hub ↔ Bob', () => {
  test.setTimeout(300_000);

  test('bidirectional payments through hub', async ({ page }) => {
    page.on('console', msg => {
      const t = msg.text();
      if (t.includes('[E2E]') || t.includes('[VaultStore]') || t.includes('P2P') || msg.type() === 'error')
        console.log(`[B] ${t.slice(0, 300)}`);
    });

    // ── 1. Navigate ──────────────────────────────────────────────
    console.log('[E2E] 1. Navigate to app');
    await gotoApp(page);

    // ── 2. Create Alice + Bob with random mnemonics ──────────────
    console.log('[E2E] 2. Create runtimes');
    const aliceMnemonic = randomMnemonic();
    const bobMnemonic = randomMnemonic();
    console.log(`[E2E] Alice mnemonic: ${aliceMnemonic.split(' ').slice(0, 3).join(' ')}...`);
    console.log(`[E2E] Bob mnemonic: ${bobMnemonic.split(' ').slice(0, 3).join(' ')}...`);

    await createRuntime(page, 'alice', aliceMnemonic);
    const alice = await getEntity(page);
    expect(alice, 'Alice entity missing').not.toBeNull();
    console.log(`[E2E] Alice: entity=${alice!.entityId.slice(0, 16)}  signer=${alice!.signerId.slice(0, 12)}`);
    await dumpState(page, 'alice-after-create');

    await createRuntime(page, 'bob', bobMnemonic);
    const bob = await getEntity(page);
    expect(bob, 'Bob entity missing').not.toBeNull();
    expect(bob!.entityId).not.toBe(alice!.entityId);
    console.log(`[E2E] Bob: entity=${bob!.entityId.slice(0, 16)}  signer=${bob!.signerId.slice(0, 12)}`);
    await dumpState(page, 'bob-after-create');

    // ── 3. Discover Hub ──────────────────────────────────────────
    console.log('[E2E] 3. Discover hub');
    const hubId = await discoverHub(page);
    console.log(`[E2E] Hub: ${hubId.slice(0, 16)}`);

    // ── 4. Connect both to Hub ───────────────────────────────────
    console.log('[E2E] 4a. Connect Bob to hub (active)');
    await connectHub(page, bob!.entityId, bob!.signerId, hubId);
    await dumpState(page, 'bob-after-connect');

    console.log('[E2E] 4b. Switch to Alice');
    await switchTo(page, 'alice');
    await dumpState(page, 'alice-after-switch');

    console.log('[E2E] 4c. Connect Alice to hub');
    await connectHub(page, alice!.entityId, alice!.signerId, hubId);
    await dumpState(page, 'alice-after-connect');

    await screenshot(page, '04-alice-connected');

    // ── 5. Faucet Alice ──────────────────────────────────────────
    console.log('[E2E] 5. Faucet Alice');
    const a0 = await outCap(page, alice!.entityId, hubId);
    console.log(`[E2E] Alice OUT before faucet: ${a0}`);
    await faucet(page, alice!.entityId);
    await dumpState(page, 'alice-after-faucet');
    const a1 = await outCap(page, alice!.entityId, hubId);
    console.log(`[E2E] Alice OUT after faucet: ${a0} → ${a1}`);
    expect(a1, 'Faucet should increase Alice OUT').toBeGreaterThan(a0);
    await screenshot(page, '05-alice-after-faucet');

    // ── 6. Alice → Hub → Bob (10 USDC via HTLC) ─────────────────
    const payAmount = toWei(10);
    const expectedReceived = afterFee(payAmount);
    const fee = calcFee(payAmount);
    console.log(`[E2E] 6. Forward HTLC: Alice → Hub → Bob`);
    console.log(`[E2E]    Amount: ${payAmount} (${ethers.formatUnits(payAmount, 18)} USDC)`);
    console.log(`[E2E]    Fee:    ${fee} (${ethers.formatUnits(fee, 18)} USDC)`);
    console.log(`[E2E]    Received: ${expectedReceived} (${ethers.formatUnits(expectedReceived, 18)} USDC)`);

    await switchTo(page, 'bob');
    const b0 = await outCap(page, bob!.entityId, hubId);

    await switchTo(page, 'alice');
    await pay(page, alice!.entityId, alice!.signerId, bob!.entityId,
      [alice!.entityId, hubId, bob!.entityId], payAmount);

    // Alice: sender pays full amount (capacity decreases by payAmount)
    const a2 = await outCap(page, alice!.entityId, hubId);
    const alicePaid = a1 - a2;
    console.log(`[E2E] Alice paid: ${alicePaid} (OUT ${a1} → ${a2})`);
    expect(alicePaid, 'Alice should pay full amount').toBe(payAmount);
    await screenshot(page, '06a-alice-after-send');

    // Bob: receiver gets amount minus fee
    await switchTo(page, 'bob');
    await page.waitForTimeout(3000);
    const b1 = await outCap(page, bob!.entityId, hubId);
    const bobReceived = b1 - b0;
    console.log(`[E2E] Bob received: ${bobReceived} (OUT ${b0} → ${b1})`);
    expect(bobReceived, `Bob should receive amount-fee (${expectedReceived})`).toBe(expectedReceived);

    // Bob's UI shows the received funds (data already verified via outCap above)
    await screenshot(page, '06b-bob-after-receive');

    console.log('[E2E] ✅ Forward HTLC verified (fee on sender)');

    // ── 7. Faucet Bob + Reverse: Bob → Hub → Alice (5 USDC) ──────
    const reverseAmount = toWei(5);
    const reverseReceived = afterFee(reverseAmount);
    const reverseFee = calcFee(reverseAmount);
    console.log(`[E2E] 7. Reverse HTLC: Bob → Hub → Alice`);
    console.log(`[E2E]    Amount: ${ethers.formatUnits(reverseAmount, 18)} USDC, fee: ${ethers.formatUnits(reverseFee, 18)} USDC`);

    await faucet(page, bob!.entityId);
    const b2 = await outCap(page, bob!.entityId, hubId);
    console.log(`[E2E] Bob OUT after faucet: ${b2}`);

    await switchTo(page, 'alice');
    const a3 = await outCap(page, alice!.entityId, hubId);

    await switchTo(page, 'bob');
    // Verify Bob still has account before paying
    const b2check = await outCap(page, bob!.entityId, hubId);
    console.log(`[E2E] Bob OUT pre-pay check: ${b2check}`);
    expect(b2check, 'Bob must have account before reverse pay').toBe(b2);

    await pay(page, bob!.entityId, bob!.signerId, alice!.entityId,
      [bob!.entityId, hubId, alice!.entityId], reverseAmount);

    // Dump state to understand what happened
    await dumpState(page, 'bob-after-reverse-pay');

    // Bob: sender pays full amount
    const b3 = await outCap(page, bob!.entityId, hubId);
    console.log(`[E2E] Bob OUT after reverse: ${b3}`);
    const bobPaid = b2 - b3;
    console.log(`[E2E] Bob paid: ${bobPaid} (OUT ${b2} → ${b3})`);
    expect(b3, 'Bob account must still exist after pay').toBeGreaterThan(0n);
    expect(bobPaid, 'Bob should pay full reverse amount').toBe(reverseAmount);
    await screenshot(page, '07a-bob-after-reverse-send');

    // Alice: receiver gets amount minus fee
    await switchTo(page, 'alice');
    await page.waitForTimeout(3000);
    const a4 = await outCap(page, alice!.entityId, hubId);
    const aliceReceived = a4 - a3;
    console.log(`[E2E] Alice received: ${aliceReceived} (OUT ${a3} → ${a4})`);
    expect(aliceReceived, `Alice should receive amount-fee (${reverseReceived})`).toBe(reverseReceived);
    await screenshot(page, '07b-alice-after-reverse-receive');

    console.log('[E2E] ✅ Reverse HTLC verified (fee on sender)');

    // ── 8. Second forward payment (state accumulates) ─────────────
    const pay2Amount = toWei(3);
    const pay2Received = afterFee(pay2Amount);
    console.log(`[E2E] 8. Second forward: Alice → Hub → Bob (${ethers.formatUnits(pay2Amount, 18)} USDC)`);

    const a5 = await outCap(page, alice!.entityId, hubId);
    await switchTo(page, 'bob');
    const b4 = await outCap(page, bob!.entityId, hubId);

    await switchTo(page, 'alice');
    await pay(page, alice!.entityId, alice!.signerId, bob!.entityId,
      [alice!.entityId, hubId, bob!.entityId], pay2Amount);

    const a6 = await outCap(page, alice!.entityId, hubId);
    expect(a5 - a6, '2nd payment: Alice pays exact amount').toBe(pay2Amount);

    await switchTo(page, 'bob');
    await page.waitForTimeout(5000);
    const b5 = await outCap(page, bob!.entityId, hubId);
    console.log(`[E2E] 2nd: Bob OUT ${b4} → ${b5}, diff=${b5 - b4}, expected=${pay2Received}`);
    expect(b5 - b4, '2nd payment: Bob receives amount-fee').toBe(pay2Received);
    await screenshot(page, '08-bob-after-second-payment');

    console.log('[E2E] ✅ Second payment accumulates correctly');

    // ── 9. Insufficient capacity (should fail gracefully) ─────────
    await switchTo(page, 'alice');
    console.log('[E2E] 9. Overspend: Alice tries to send more than capacity');
    const overAmount = a6 + toWei(1); // more than Alice has
    const { secret: overSecret, hashlock: overHash } = generateHtlc();
    const overResult = await page.evaluate(async ({ from, signerId, to, route, amt, secret, hashlock }) => {
      try {
        const XLN = (window as any).XLN;
        const env = (window as any).isolatedEnv;
        await XLN.process(env, [{
          entityId: from, signerId,
          entityTxs: [{ type: 'htlcPayment', data: { targetEntityId: to, tokenId: 1, amount: BigInt(amt), route, secret, hashlock } }],
        }]);
        return { ok: true };
      } catch (e: any) { return { ok: false, error: e.message }; }
    }, { from: alice!.entityId, signerId: alice!.signerId, to: bob!.entityId,
         route: [alice!.entityId, hubId, bob!.entityId], amt: overAmount.toString(),
         secret: overSecret, hashlock: overHash });
    // Overspend should either throw or not change Alice's balance
    const a7 = await outCap(page, alice!.entityId, hubId);
    console.log(`[E2E] Overspend result: ok=${overResult.ok}, error=${overResult.error?.slice(0, 80)}`);
    console.log(`[E2E] Alice OUT unchanged: ${a6} → ${a7}`);
    expect(a7, 'Overspend should not change Alice balance').toBe(a6);

    console.log('[E2E] ✅ Overspend rejected');

    // ── Summary ───────────────────────────────────────────────────
    console.log('\n[E2E] ══════ SUMMARY ══════');
    console.log(`[E2E] Route: Alice → H1 (1.00 bps) → Bob`);
    console.log(`[E2E] Fee per hop: ${ethers.formatUnits(fee, 18)} USDC on 10 USDC (0.001%)`);
    console.log(`[E2E] Forward:  Alice sent 10, Bob got ${ethers.formatUnits(expectedReceived, 18)}`);
    console.log(`[E2E] Reverse:  Bob sent 5, Alice got ${ethers.formatUnits(reverseReceived, 18)}`);
    console.log(`[E2E] 2nd fwd:  Alice sent 3, Bob got ${ethers.formatUnits(pay2Received, 18)}`);
    console.log(`[E2E] Overspend: correctly rejected`);
    console.log('[E2E] ✅ All payment cases passed');
  });
});
