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
const APP_BASE_URL = process.env.E2E_BASE_URL ?? 'https://localhost:8080';
const API_BASE_URL = process.env.E2E_API_BASE_URL ?? APP_BASE_URL;
const RESET_BASE_URL = process.env.E2E_RESET_BASE_URL ?? 'http://localhost:8082';

const DEFAULT_FEE_PPM = 10n;
const FEE_DENOM = 1_000_000n;
const calcFee = (amount: bigint, feePPM: bigint, baseFee: bigint): bigint =>
  (amount * feePPM / FEE_DENOM) + baseFee;
const afterFee = (amount: bigint, feePPM: bigint, baseFee: bigint): bigint =>
  amount - calcFee(amount, feePPM, baseFee);
const requiredInbound = (desiredForward: bigint, feePPM: bigint, baseFee: bigint): bigint => {
  let low = desiredForward;
  let high = desiredForward;
  while (afterFee(high, feePPM, baseFee) < desiredForward) high *= 2n;
  while (low < high) {
    const mid = (low + high) / 2n;
    if (afterFee(mid, feePPM, baseFee) >= desiredForward) high = mid;
    else low = mid + 1n;
  }
  return low;
};

function toWei(n: number): bigint {
  return BigInt(n) * 10n ** 18n;
}


// ─── Helpers ─────────────────────────────────────────────────────

/** Navigate to /app. Auto-unlock if redirect occurs. */
async function gotoApp(page: Page) {
  await page.goto(`${APP_BASE_URL}/app`);
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
      const vaultOperations = (window as any).vaultOperations;
      if (!vaultOperations) {
        return { ok: false, error: 'window.vaultOperations missing' };
      }
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

async function assertP2PSingletonAndWsHealth(page: Page, tag: string) {
  const connected = await page.evaluate(async () => {
    const start = Date.now();
    while (Date.now() - start < 45_000) {
      const env = (window as any).isolatedEnv;
      const p2p = env?.runtimeState?.p2p as any;
      if (p2p && typeof p2p.isConnected === 'function' && p2p.isConnected()) {
        return true;
      }
      if (p2p) {
        if (typeof p2p.connect === 'function') {
          try { p2p.connect(); } catch {}
        } else if (typeof p2p.reconnect === 'function') {
          try { p2p.reconnect(); } catch {}
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    return false;
  });
  expect(connected, `[${tag}] runtime P2P must connect within 45s`).toBe(true);

  const snapshot = await page.evaluate(async ({ apiBaseUrl }) => {
    const env = (window as any).isolatedEnv;
    const runtimeId = String(env?.runtimeId || '');
    const p2p = env?.runtimeState?.p2p as any;
    const clients = Array.isArray(p2p?.clients) ? p2p.clients : [];
    const relayUrls = Array.isArray(p2p?.relayUrls) ? p2p.relayUrls : [];
    let wsOpenForRuntime = 0;
    let wsCloseForRuntime = 0;

    if (runtimeId) {
      try {
        const res = await fetch(`${apiBaseUrl}/api/debug/events?last=1500&runtimeId=${encodeURIComponent(runtimeId)}`);
        if (res.ok) {
          const body = await res.json();
          const events = Array.isArray(body?.events) ? body.events : [];
          for (const ev of events) {
            if (ev?.event === 'ws_open') wsOpenForRuntime += 1;
            if (ev?.event === 'ws_close') wsCloseForRuntime += 1;
          }
        }
      } catch {
        // best-effort diagnostics
      }
    }

    return {
      runtimeId,
      hasP2P: !!p2p,
      isConnected: !!p2p?.isConnected?.(),
      clientCount: clients.length,
      relayCount: relayUrls.length,
      wsOpenForRuntime,
      wsCloseForRuntime,
    };
  }, { apiBaseUrl: API_BASE_URL });

  expect(snapshot.hasP2P, `[${tag}] runtime must have active P2P`).toBe(true);
  expect(snapshot.isConnected, `[${tag}] runtime P2P must have open WS`).toBe(true);
  expect(snapshot.clientCount, `[${tag}] runtime must have exactly one WS client`).toBe(1);
  expect(snapshot.relayCount, `[${tag}] runtime must have exactly one relay URL`).toBe(1);
  expect(
    snapshot.wsOpenForRuntime,
    `[${tag}] relay should not churn ws_open for same runtime (opens=${snapshot.wsOpenForRuntime}, closes=${snapshot.wsCloseForRuntime})`,
  ).toBeLessThanOrEqual(snapshot.wsCloseForRuntime + 2);
}

async function ensureRuntimeOnline(page: Page, tag: string) {
  const ok = await page.evaluate(async () => {
    const env = (window as any).isolatedEnv;
    const p2p = env?.runtimeState?.p2p as any;
    if (!env || !p2p) return false;
    const start = Date.now();
    while (Date.now() - start < 20_000) {
      if (typeof p2p.isConnected === 'function' && p2p.isConnected()) return true;
      if (typeof p2p.connect === 'function') {
        try { p2p.connect(); } catch {}
      } else if (typeof p2p.reconnect === 'function') {
        try { p2p.reconnect(); } catch {}
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    return typeof p2p.isConnected === 'function' && p2p.isConnected();
  });
  expect(ok, `[${tag}] runtime must be online before network actions`).toBe(true);
}

async function waitForEntityAdvertised(page: Page, entityId: string) {
  const advertised = await page.evaluate(async ({ entityId, apiBaseUrl }) => {
    const target = String(entityId).toLowerCase();
    const start = Date.now();
    while (Date.now() - start < 30_000) {
      // Path 1: relay debug entity registry
      try {
        const res = await fetch(`${apiBaseUrl}/api/debug/entities?limit=5000&q=${encodeURIComponent(entityId)}`);
        if (res.ok) {
          const body = await res.json();
          const entities = Array.isArray(body?.entities) ? body.entities : [];
          const hit = entities.find((e: any) => String(e?.entityId || '').toLowerCase() === target);
          if (hit && hit.runtimeId) return true;
        }
      } catch {
        // ignore and retry
      }
      // Path 2: local gossip cache sees the profile (relay debug path can lag)
      try {
        const env = (window as any).isolatedEnv;
        const profiles = env?.gossip?.getProfiles?.();
        const found = Array.isArray(profiles)
          ? profiles.find((p: any) => String(p?.entityId || '').toLowerCase() === target)
          : null;
        if (found && found.runtimeId) return true;
      } catch {
        // ignore and retry
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    return false;
  }, { entityId, apiBaseUrl: API_BASE_URL });
  expect(advertised, `Entity ${entityId.slice(0, 12)} not advertised in relay debug or local gossip cache`).toBe(true);
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
            const v = XLN.deriveDelta(
              d,
              String(entityId).toLowerCase() < String(cpId).toLowerCase(),
            );
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
                const v = XLN?.deriveDelta?.(
                  d,
                  String(entityId).toLowerCase() < String(cpId).toLowerCase(),
                );
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
      const runtimesState = (window as any).runtimesState;
      const vaultOperations = (window as any).vaultOperations;
      if (!runtimesState || !vaultOperations) {
        return { ok: false, error: 'window.runtimesState/window.vaultOperations missing' };
      }
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
  await ensureRuntimeOnline(page, `switch-${label}`);
  await page.waitForTimeout(2000);
}

/** Discover hub via gossip polling */
async function discoverHub(page: Page): Promise<string> {
  const isHubProfile = (p: any): boolean =>
    p?.metadata?.isHub === true || Array.isArray(p?.capabilities) && p.capabilities.includes('hub');

  for (let i = 0; i < 45; i++) {
    const fromGossip = await page.evaluate(() => {
      try {
        const env = (window as any).isolatedEnv;
        const XLN = (window as any).XLN;
        XLN?.refreshGossip?.(env);
        const profiles = env?.gossip?.getProfiles?.() || [];
        const hub = profiles.find((p: any) =>
          p?.metadata?.isHub === true || Array.isArray(p?.capabilities) && p.capabilities.includes('hub'));
        return typeof hub?.entityId === 'string' ? hub.entityId : null;
      } catch {
        return null;
      }
    });
    if (fromGossip) return fromGossip;

    try {
      const r = await page.request.get('https://xln.finance/api/debug/entities');
      if (r.ok()) {
        const data = await r.json();
        const entities = Array.isArray((data as any)?.entities) ? (data as any).entities : [];
        const h = entities.find((x: any) => x?.isHub === true && typeof x?.entityId === 'string');
        if (h?.entityId) return h.entityId as string;
      }
    } catch {}

    await page.waitForTimeout(1000);
  }

  expect(null, 'Hub not found via gossip (45s)').not.toBeNull();
  return '' as never;
}

async function getHubFeeConfig(page: Page, hubId: string): Promise<{ feePPM: bigint; baseFee: bigint }> {
  const fee = await page.evaluate((targetHubId) => {
    const env = (window as any).isolatedEnv;
    const profiles = env?.gossip?.getProfiles?.() || [];
    const profile = profiles.find((p: any) => String(p?.entityId || '').toLowerCase() === String(targetHubId || '').toLowerCase());
    const rawPPM = Number(profile?.metadata?.routingFeePPM ?? 0);
    const safePPM = Number.isFinite(rawPPM) && rawPPM >= 0 ? Math.floor(rawPPM) : 0;
    const rawBase = profile?.metadata?.baseFee;
    const base = typeof rawBase === 'string'
      ? rawBase
      : (typeof rawBase === 'number' && Number.isFinite(rawBase) ? String(Math.max(0, Math.floor(rawBase))) : '0');
    return { feePPM: String(safePPM), baseFee: base };
  }, hubId);

  const baseFeeRaw = String(fee.baseFee || '0').trim();
  const baseFeeNorm = baseFeeRaw.startsWith('BigInt(') && baseFeeRaw.endsWith(')')
    ? baseFeeRaw.slice(7, -1)
    : baseFeeRaw;

  return {
    feePPM: BigInt(fee.feePPM || String(DEFAULT_FEE_PPM)),
    baseFee: BigInt(baseFeeNorm || '0'),
  };
}

/** Discover all hubs visible in gossip */
async function discoverHubs(page: Page): Promise<string[]> {
  for (let i = 0; i < 45; i++) {
    const fromGossip = await page.evaluate(() => {
      try {
        const env = (window as any).isolatedEnv;
        const XLN = (window as any).XLN;
        XLN?.refreshGossip?.(env);
        const profiles = env?.gossip?.getProfiles?.() || [];
        const ids = profiles
          .filter((p: any) => p?.metadata?.isHub === true || Array.isArray(p?.capabilities) && p.capabilities.includes('hub'))
          .map((p: any) => p.entityId)
          .filter((id: any): id is string => typeof id === 'string');
        return [...new Set(ids)];
      } catch {
        return [] as string[];
      }
    });
    if (fromGossip.length > 0) return fromGossip;

    try {
      const r = await page.request.get('https://xln.finance/api/debug/entities');
      if (r.ok()) {
        const data = await r.json();
        const ids = (Array.isArray((data as any)?.entities) ? (data as any).entities : [])
          .filter((e: any) => e?.isHub === true)
          .map((h: any) => h?.entityId)
          .filter((id: any): id is string => typeof id === 'string');
        const unique = [...new Set(ids)];
        if (unique.length > 0) return unique;
      }
    } catch {}

    await page.waitForTimeout(1000);
  }
  return [];
}

/** Find a self-payment cycle route using gossip + local account edges */
async function findSelfCycleRoute(
  page: Page,
  selfEntityId: string,
  minIntermediates: number = 2,
  requiredHubs: string[] = [],
): Promise<string[]> {
  const route = await page.evaluate(({ selfEntityId, minIntermediates, requiredHubs }) => {
    const env = (window as any).isolatedEnv;
    const replicas = env?.eReplicas;
    const profiles = env?.gossip?.getProfiles?.() || [];
    const adjacency = new Map<string, Set<string>>();

    const addEdge = (a: string, b: string) => {
      if (!adjacency.has(a)) adjacency.set(a, new Set());
      if (!adjacency.has(b)) adjacency.set(b, new Set());
      adjacency.get(a)!.add(b);
      adjacency.get(b)!.add(a);
    };

    if (replicas) {
      for (const [key, rep] of replicas.entries()) {
        const [entId] = String(key).split(':');
        if (!entId || !rep?.state?.accounts) continue;
        for (const cp of rep.state.accounts.keys()) addEdge(entId, String(cp));
      }
    }
    for (const p of profiles) {
      if (!p?.entityId || !Array.isArray(p?.accounts)) continue;
      for (const a of p.accounts) {
        if (a?.counterpartyId) addEdge(p.entityId, a.counterpartyId);
      }
    }

    // Prefer explicit obfuscated loop when 3 required hubs are provided:
    // self -> H1 -> H2 -> H3 -> self
    if (Array.isArray(requiredHubs) && requiredHubs.length >= 3) {
      const [h1, h2, h3] = requiredHubs.map((h: string) => String(h));
      const has = (a: string, b: string) => adjacency.get(a)?.has(b) === true;
      if (
        has(selfEntityId, h1) &&
        has(h1, h2) &&
        has(h2, h3) &&
        has(h3, selfEntityId)
      ) {
        return [selfEntityId, h1, h2, h3, selfEntityId];
      }
    }

    const MAX_HOPS = 8;
    let best: string[] | null = null;
    const requiredSet = new Set((requiredHubs || []).map((h: string) => String(h).toLowerCase()));
    const minHopCount = Math.max(2, Number(minIntermediates || 2) + 1);

    const dfs = (current: string, path: string[], used: Set<string>) => {
      if (best) return;
      const hops = path.length - 1;
      if (hops > MAX_HOPS) return;
      const neighbors = adjacency.get(current);
      if (!neighbors) return;
      for (const next of neighbors) {
        const nextHops = hops + 1;
        if (nextHops > MAX_HOPS) continue;
        if (next === selfEntityId) {
          // Require configurable minimum intermediates and required hubs if provided.
          if (nextHops >= minHopCount) {
            const candidate = [...path, selfEntityId];
            if (requiredSet.size > 0) {
              const middle = candidate.slice(1, -1).map((x) => String(x).toLowerCase());
              const hasAllRequired = [...requiredSet].every((h) => middle.includes(h));
              if (!hasAllRequired) {
                continue;
              }
            }
            best = candidate;
            return;
          }
          continue;
        }
        if (used.has(next)) continue;
        used.add(next);
        path.push(next);
        dfs(next, path, used);
        path.pop();
        used.delete(next);
      }
    };

    // Try deeper paths first by ordering neighbors with hub preference.
    const hubSet = new Set(
      profiles.filter((p: any) => p?.metadata?.isHub).map((p: any) => p.entityId)
    );
    const neighbors = [...(adjacency.get(selfEntityId) || [])]
      .sort((a, b) => Number(hubSet.has(b)) - Number(hubSet.has(a)));
    for (const n of neighbors) {
      if (best) break;
      dfs(n, [selfEntityId, n], new Set([selfEntityId, n]));
    }

    return best || [];
  }, { selfEntityId, minIntermediates, requiredHubs });

  return route;
}

/** Open account + 10k USDC credit with hub */
async function connectHub(page: Page, entityId: string, signerId: string, hubId: string) {
  let opened = false;
  for (let attempt = 1; attempt <= 3; attempt++) {
    await ensureRuntimeOnline(page, `connectHub-attempt-${attempt}`);
    const r = await page.evaluate(async ({ entityId, signerId, hubId }) => {
      try {
        const XLN = (window as any).XLN;
        const env = (window as any).isolatedEnv;
        console.log(`[E2E] connectHub: env.runtimeId=${env?.runtimeId?.slice(0,12)}, entityId=${entityId.slice(0,12)}, hubId=${hubId.slice(0,12)}`);
        const p2p = env?.runtimeState?.p2p;
        const start = Date.now();
        let hubRuntimeId: string | null = null;
        while (Date.now() - start < 12_000) {
          const profiles = env?.gossip?.getProfiles?.() ?? [];
          const hub = profiles.find((p: any) => String(p?.entityId || '').toLowerCase() === String(hubId).toLowerCase());
          const candidate = hub?.runtimeId ?? hub?.metadata?.runtimeId ?? null;
          if (typeof candidate === 'string' && candidate.length > 0) {
            hubRuntimeId = candidate;
            break;
          }
          if (typeof p2p?.refreshGossip === 'function') {
            try { await p2p.refreshGossip(); } catch {}
          }
          await new Promise((r) => setTimeout(r, 600));
        }
        if (!hubRuntimeId) {
          return { ok: false, error: 'hub runtimeId unresolved in gossip', hasAccount: false, accSize: 0 };
        }
        let liveSignerId = signerId;
        for (const key of env?.eReplicas?.keys?.() ?? []) {
          const [eid, sid] = String(key).split(':');
          if (String(eid).toLowerCase() === String(entityId).toLowerCase() && sid) {
            liveSignerId = sid;
            break;
          }
        }
        XLN.enqueueRuntimeInput(env, {
          runtimeTxs: [],
          entityInputs: [{
            entityId,
            signerId: liveSignerId,
            entityTxs: [{ type: 'openAccount', data: { targetEntityId: hubId, creditAmount: 10_000n * 10n ** 18n, tokenId: 1 } }],
          }],
        });
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
    console.log(`[E2E] connectHub result (attempt ${attempt}):`, JSON.stringify(r));
    expect(r.ok, `connectHub failed: ${r.error}`).toBe(true);

    // Wait until bilateral account is actually usable (delta exists, no pending frame).
    opened = await page.evaluate(async ({ entityId, hubId }) => {
      const start = Date.now();
      while (Date.now() - start < 45_000) {
        const env = (window as any).isolatedEnv;
        if (!env?.eReplicas) {
          await new Promise((resolve) => setTimeout(resolve, 500));
          continue;
        }
        let ready = false;
        for (const [k, rep] of env.eReplicas.entries()) {
          if (!String(k).startsWith(entityId + ':')) continue;
          const acc = rep.state?.accounts?.get(hubId);
          if (!acc) continue;
          const hasDelta = !!acc.deltas?.get?.(1);
          const noPending = !acc.pendingFrame;
          const atLeastOneFrame = Number(acc.currentHeight || 0) > 0;
          if (hasDelta && noPending && atLeastOneFrame) {
            ready = true;
            break;
          }
        }
        if (ready) return true;
        await new Promise((resolve) => setTimeout(resolve, 750));
      }
      return false;
    }, { entityId, hubId });

    console.log(`[E2E] account-open readiness ${entityId.slice(0, 10)}↔${hubId.slice(0, 10)} attempt=${attempt}: ${opened ? 'OPEN' : 'AWAITING'}`);
    if (opened) break;
    await page.waitForTimeout(2_000);
  }

  expect(opened, `Account open must reach OPEN for ${entityId.slice(0, 10)}↔${hubId.slice(0, 10)}`).toBe(true);
  await page.waitForTimeout(SETTLE_MS);
}

/** Get USDC outCapacity */
async function outCap(page: Page, entityId: string, cpId: string): Promise<bigint> {
  const s = await page.evaluate(({ entityId, cpId }) => {
    const env = (window as any).isolatedEnv;
    const XLN = (window as any).XLN;
    if (!env || !XLN) return 'ENV_MISSING';
    for (const [k, r] of env.eReplicas.entries()) {
      if (!k.startsWith(entityId + ':')) continue;
      const acc = r.state?.accounts?.get(cpId);
      if (!acc) {
        const accKeys = r.state?.accounts ? [...r.state.accounts.keys()].map((k: string) => k.slice(0, 12)) : [];
        console.log(`[E2E] outCap: NO_ACCOUNT for ${cpId.slice(0,12)}, accounts=[${accKeys}]`);
        return 'NO_ACCOUNT';
      }
      const d = acc.deltas?.get(1);
      if (!d) {
        const deltaKeys = acc.deltas ? [...acc.deltas.keys()] : [];
        console.log(`[E2E] outCap: NO_DELTA for tokenId=1, deltaKeys=[${deltaKeys}], height=${acc.currentHeight}, mempool=${acc.mempool?.length}`);
        return 'NO_DELTA';
      }
      return XLN
        .deriveDelta(d, String(entityId).toLowerCase() < String(cpId).toLowerCase())
        .outCapacity
        .toString();
    }
    return 'NO_ENTITY';
  }, { entityId, cpId });
  if (s === 'NO_ACCOUNT' || s === 'NO_DELTA' || s === 'NO_ENTITY' || s === 'ENV_MISSING') {
    console.log(`[E2E] outCap(${entityId.slice(0,12)}, ${cpId.slice(0,12)}) = ${s}`);
    return 0n;
  }
  return BigInt(s);
}

async function waitForOutCapDelta(
  page: Page,
  entityId: string,
  cpId: string,
  baseline: bigint,
  expectedDelta: bigint,
  timeoutMs = 25_000
): Promise<bigint> {
  const start = Date.now();
  let latest = baseline;
  while (Date.now() - start < timeoutMs) {
    latest = await outCap(page, entityId, cpId);
    if (latest - baseline === expectedDelta) return latest;
    await page.waitForTimeout(500);
  }
  throw new Error(
    `Timed out waiting outCap delta for ${entityId.slice(0, 10)}↔${cpId.slice(0, 10)}: baseline=${baseline} latest=${latest} expectedDelta=${expectedDelta}`
  );
}

async function waitForOutCapIncrease(
  page: Page,
  entityId: string,
  cpId: string,
  baseline: bigint,
  timeoutMs = 30_000
): Promise<bigint> {
  const start = Date.now();
  let latest = baseline;
  while (Date.now() - start < timeoutMs) {
    latest = await outCap(page, entityId, cpId);
    if (latest > baseline) return latest;
    await page.waitForTimeout(500);
  }
  throw new Error(
    `Timed out waiting outCap increase for ${entityId.slice(0, 10)}↔${cpId.slice(0, 10)}: baseline=${baseline} latest=${latest}`
  );
}

/** Faucet 100 USDC (with 30s timeout) */
async function faucet(page: Page, entityId: string) {
  let r: { ok: boolean; status: number; data: any } = { ok: false, status: 0, data: { error: 'not-run' } };
  for (let attempt = 1; attempt <= 6; attempt++) {
    const runtimeId = await page.evaluate(() => (window as any).isolatedEnv?.runtimeId || null);
    if (!runtimeId) {
      r = { ok: false, status: 0, data: { error: 'missing runtimeId in isolatedEnv' } };
      break;
    }
    try {
      const resp = await page.request.post(`${API_BASE_URL}/api/faucet/offchain`, {
        data: { userEntityId: entityId, userRuntimeId: runtimeId, tokenId: 1, amount: '100' },
      });
      const data = await resp.json().catch(() => ({}));
      r = { ok: resp.ok(), status: resp.status(), data };
    } catch (e: any) {
      r = { ok: false, status: 0, data: { error: e?.message || String(e) } };
    }
    console.log(`[E2E] Faucet response attempt ${attempt}: status=${r.status} data=${JSON.stringify(r.data)}`);
    if (r.ok) break;
    const message = String(r.data?.error || '');
    const code = String(r.data?.code || '');
    const status = String(r.data?.status || '');
    const transient =
      r.status === 202 ||
      r.status === 409 ||
      message.includes('SIGNER_RESOLUTION_FAILED') ||
      message.includes('AWAITING') ||
      message.includes('pending') ||
      message.includes('FAUCET_ACCOUNT_MISSING') ||
      message.includes('No hub account with target entity') ||
      code === 'FAUCET_CHANNEL_NOT_READY' ||
      status === 'channel_opening' ||
      status === 'channel_not_ready';
    if (!transient || attempt === 6) break;
    await page.waitForTimeout(1500);
  }
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
      let liveSignerId = signerId;
      for (const key of env?.eReplicas?.keys?.() ?? []) {
        const [eid, sid] = String(key).split(':');
        if (String(eid).toLowerCase() === String(from).toLowerCase() && sid) {
          liveSignerId = sid;
          break;
        }
      }

      // Pre-pay diagnostics
      const preKeys = env.eReplicas ? [...env.eReplicas.keys()] : [];
      let preAccounts = 0;
      for (const [k, rep] of (env.eReplicas || new Map()).entries()) {
        if (k.startsWith(from + ':')) preAccounts = rep.state?.accounts?.size || 0;
      }
      console.log(`[E2E] pay() PRE: envId=${env._debugId}, eReplicas=[${preKeys.join(', ')}], fromAccounts=${preAccounts}`);

      XLN.enqueueRuntimeInput(env, {
        runtimeTxs: [],
        entityInputs: [{
          entityId: from,
          signerId: liveSignerId,
          entityTxs: [{ type: 'htlcPayment', data: { targetEntityId: to, tokenId: 1, amount: BigInt(amt), route, secret, hashlock } }],
        }],
      });

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

async function getEntityPersistenceSnapshot(page: Page, entityId: string, counterpartyId: string) {
  return page.evaluate(({ entityId, counterpartyId }) => {
    const env = (window as any).isolatedEnv;
    if (!env?.eReplicas) {
      return {
        envReady: false,
        runtimeHeight: 0,
        historyFrames: 0,
        hasAccount: false,
        accountCount: 0,
      };
    }
    for (const [key, rep] of env.eReplicas.entries()) {
      if (!String(key).startsWith(entityId + ':')) continue;
      const accountCount = rep?.state?.accounts?.size || 0;
      const hasAccount = !!rep?.state?.accounts?.has?.(counterpartyId);
      return {
        envReady: true,
        runtimeHeight: Number(env.height || 0),
        historyFrames: Array.isArray(env.history) ? env.history.length : 0,
        hasAccount,
        accountCount,
      };
    }
    return {
      envReady: true,
      runtimeHeight: Number(env.height || 0),
      historyFrames: Array.isArray(env.history) ? env.history.length : 0,
      hasAccount: false,
      accountCount: 0,
    };
  }, { entityId, counterpartyId });
}

async function waitForServerHealthy(page: Page, timeoutMs = 60_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const res = await page.request.get(`${RESET_BASE_URL}/api/health`);
      if (res.ok()) {
        const body = await res.json().catch(() => ({}));
        if (typeof body?.timestamp === 'number') return;
      }
    } catch {
      // retry
    }
    await page.waitForTimeout(1000);
  }
  throw new Error('Server did not become healthy in time after reset');
}

async function resetProdServer(page: Page) {
  let lastError = '';
  let resetDone = false;
  for (let attempt = 1; attempt <= 10; attempt++) {
    try {
      const coldResponse = await page.request.post(`${RESET_BASE_URL}/reset?rpc=1&db=1&exit=0`);
      const coldData = await coldResponse.json().catch(() => ({}));
      if (coldResponse.ok()) {
        console.log(`[E2E] Cold reset requested: ${JSON.stringify(coldData)}`);
        resetDone = true;
        break;
      }
      const softResponse = await page.request.post(`${RESET_BASE_URL}/api/debug/reset`, {
        data: { preserveHubs: false },
        headers: { 'Content-Type': 'application/json' },
      });
      const softData = await softResponse.json().catch(() => ({}));
      if (softResponse.ok()) {
        console.log(`[E2E] Soft reset fallback used: ${JSON.stringify(softData)}`);
        resetDone = true;
        break;
      }
      lastError = `cold=${JSON.stringify(coldData)} soft=${JSON.stringify(softData)}`;
    } catch (error: any) {
      lastError = error?.message || String(error);
    }
    await page.waitForTimeout(1000);
  }
  expect(resetDone, `reset failed after retries: ${lastError}`).toBe(true);
  await waitForServerHealthy(page);
}

// ─── Test ─────────────────────────────────────────────────────────

test.describe('E2E: Alice ↔ Hub ↔ Bob', () => {
  test.setTimeout(300_000);

  test.beforeEach(async ({ page }) => {
    await resetProdServer(page);
    await gotoApp(page);
  });

  test.afterEach(async ({ page }) => {
    if (process.env.E2E_SKIP_AFTER_RESET === '1') return;
    await resetProdServer(page);
  });

  test('bidirectional payments through hub', async ({ page }) => {
    page.on('console', msg => {
      const t = msg.text();
      if (t.includes('[E2E]') || t.includes('[VaultStore]') || t.includes('P2P') || msg.type() === 'error'
          || t.includes('APPLY') || t.includes('Frame consensus') || t.includes('PROPOSE')
          || t.includes('credit') || t.includes('add_delta') || t.includes('SINGLE-SIGNER')
          || t.includes('Hanko') || t.includes('Replay') || t.includes('ENVELOPE')
          || t.includes('HTLC') || t.includes('Missing crypto') || t.includes('🧅'))
        console.log(`[B] ${t.slice(0, 300)}`);
    });

    // ── 1. Navigate ──────────────────────────────────────────────
    console.log('[E2E] 1. Navigate to app');

    // ── 2. Create Alice + Bob with random mnemonics ──────────────
    console.log('[E2E] 2. Create runtimes');
    const aliceMnemonic = randomMnemonic();
    const bobMnemonic = randomMnemonic();
    console.log(`[E2E] Alice mnemonic: ${aliceMnemonic.split(' ').slice(0, 3).join(' ')}...`);
    console.log(`[E2E] Bob mnemonic: ${bobMnemonic.split(' ').slice(0, 3).join(' ')}...`);

    await createRuntime(page, 'alice', aliceMnemonic);
    await assertP2PSingletonAndWsHealth(page, 'alice-create');
    const alice = await getEntity(page);
    expect(alice, 'Alice entity missing').not.toBeNull();
    await waitForEntityAdvertised(page, alice!.entityId);
    console.log(`[E2E] Alice: entity=${alice!.entityId.slice(0, 16)}  signer=${alice!.signerId.slice(0, 12)}`);
    await dumpState(page, 'alice-after-create');

    await createRuntime(page, 'bob', bobMnemonic);
    await assertP2PSingletonAndWsHealth(page, 'bob-create');
    const bob = await getEntity(page);
    expect(bob, 'Bob entity missing').not.toBeNull();
    expect(bob!.entityId).not.toBe(alice!.entityId);
    await waitForEntityAdvertised(page, bob!.entityId);
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
    await assertP2PSingletonAndWsHealth(page, 'switch-alice');
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
    const a1 = await waitForOutCapIncrease(page, alice!.entityId, hubId, a0);
    console.log(`[E2E] Alice OUT after faucet: ${a0} → ${a1}`);
    expect(a1, 'Faucet should increase Alice OUT').toBeGreaterThan(a0);
    await screenshot(page, '05-alice-after-faucet');

    // ── 6. Alice → Hub → Bob (10 USDC via HTLC) ─────────────────
    const payAmount = toWei(10);
    const hubFee = await getHubFeeConfig(page, hubId);
    const expectedSenderSpend = requiredInbound(payAmount, hubFee.feePPM, hubFee.baseFee);
    const fee = expectedSenderSpend - payAmount;
    console.log(`[E2E] 6. Forward HTLC: Alice → Hub → Bob`);
    console.log(`[E2E]    Recipient amount: ${payAmount} (${ethers.formatUnits(payAmount, 18)} USDC)`);
    console.log(`[E2E]    Sender spend: ${expectedSenderSpend} (${ethers.formatUnits(expectedSenderSpend, 18)} USDC)`);
    console.log(`[E2E]    Fee:    ${fee} (${ethers.formatUnits(fee, 18)} USDC)`);
    console.log(`[E2E]    Received: ${payAmount} (${ethers.formatUnits(payAmount, 18)} USDC)`);

    await switchTo(page, 'bob');
    await assertP2PSingletonAndWsHealth(page, 'switch-bob-forward-recv');
    const b0 = await outCap(page, bob!.entityId, hubId);

    await switchTo(page, 'alice');
    await assertP2PSingletonAndWsHealth(page, 'switch-alice-reverse-recv');
    await pay(page, alice!.entityId, alice!.signerId, bob!.entityId,
      [alice!.entityId, hubId, bob!.entityId], payAmount);

    // Alice: sender pays full amount (capacity decreases by payAmount)
    const a2 = await outCap(page, alice!.entityId, hubId);
    const alicePaid = a1 - a2;
    console.log(`[E2E] Alice paid: ${alicePaid} (OUT ${a1} → ${a2})`);
    const aliceMinSpend = expectedSenderSpend > payAmount ? expectedSenderSpend : payAmount;
    expect(alicePaid, 'Alice should pay at least quoted sender amount').toBeGreaterThanOrEqual(aliceMinSpend);
    await screenshot(page, '06a-alice-after-send');

    // Bob: receiver gets amount minus fee
    await switchTo(page, 'bob');
    const b1 = await waitForOutCapDelta(page, bob!.entityId, hubId, b0, payAmount);
    const bobReceived = b1 - b0;
    console.log(`[E2E] Bob received: ${bobReceived} (OUT ${b0} → ${b1})`);
    expect(bobReceived, `Bob should receive exact recipient amount (${payAmount})`).toBe(payAmount);

    // Bob's UI shows the received funds (data already verified via outCap above)
    await screenshot(page, '06b-bob-after-receive');

    console.log('[E2E] ✅ Forward HTLC verified (fee on sender)');

    // ── 7. Faucet Bob + Reverse: Bob → Hub → Alice (5 USDC) ──────
    const reverseAmount = toWei(5);
    const reverseSenderSpend = requiredInbound(reverseAmount, hubFee.feePPM, hubFee.baseFee);
    const reverseFee = reverseSenderSpend - reverseAmount;
    console.log(`[E2E] 7. Reverse HTLC: Bob → Hub → Alice`);
    console.log(`[E2E]    Amount: ${ethers.formatUnits(reverseAmount, 18)} USDC, fee: ${ethers.formatUnits(reverseFee, 18)} USDC`);

    await faucet(page, bob!.entityId);
    const b2 = await waitForOutCapIncrease(page, bob!.entityId, hubId, b1);
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
    const bobMinSpend = reverseSenderSpend > reverseAmount ? reverseSenderSpend : reverseAmount;
    expect(bobPaid, 'Bob should pay at least quoted sender amount').toBeGreaterThanOrEqual(bobMinSpend);
    await screenshot(page, '07a-bob-after-reverse-send');

    // Alice: receiver gets amount minus fee
    await switchTo(page, 'alice');
    const a4 = await waitForOutCapDelta(page, alice!.entityId, hubId, a3, reverseAmount);
    const aliceReceived = a4 - a3;
    console.log(`[E2E] Alice received: ${aliceReceived} (OUT ${a3} → ${a4})`);
    expect(aliceReceived, `Alice should receive exact recipient amount (${reverseAmount})`).toBe(reverseAmount);
    await screenshot(page, '07b-alice-after-reverse-receive');

    console.log('[E2E] ✅ Reverse HTLC verified (fee on sender)');

    // ── 8. Second forward payment (state accumulates) ─────────────
    const pay2Amount = toWei(3);
    const pay2SenderSpend = requiredInbound(pay2Amount, hubFee.feePPM, hubFee.baseFee);
    console.log(`[E2E] 8. Second forward: Alice → Hub → Bob (${ethers.formatUnits(pay2Amount, 18)} USDC)`);

    const a5 = await outCap(page, alice!.entityId, hubId);
    await switchTo(page, 'bob');
    const b4 = await outCap(page, bob!.entityId, hubId);

    await switchTo(page, 'alice');
    await pay(page, alice!.entityId, alice!.signerId, bob!.entityId,
      [alice!.entityId, hubId, bob!.entityId], pay2Amount);

    const a6 = await outCap(page, alice!.entityId, hubId);
    const pay2MinSpend = pay2SenderSpend > pay2Amount ? pay2SenderSpend : pay2Amount;
    expect(a5 - a6, '2nd payment: Alice pays at least quoted sender amount').toBeGreaterThanOrEqual(pay2MinSpend);

    await switchTo(page, 'bob');
    const b5 = await waitForOutCapDelta(page, bob!.entityId, hubId, b4, pay2Amount);
    console.log(`[E2E] 2nd: Bob OUT ${b4} → ${b5}, diff=${b5 - b4}, expected=${pay2Amount}`);
    expect(b5 - b4, '2nd payment: Bob receives exact recipient amount').toBe(pay2Amount);
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
        let liveSignerId = signerId;
        for (const key of env?.eReplicas?.keys?.() ?? []) {
          const [eid, sid] = String(key).split(':');
          if (String(eid).toLowerCase() === String(from).toLowerCase() && sid) {
            liveSignerId = sid;
            break;
          }
        }
        XLN.enqueueRuntimeInput(env, {
          runtimeTxs: [],
          entityInputs: [{
            entityId: from,
            signerId: liveSignerId,
            entityTxs: [{ type: 'htlcPayment', data: { targetEntityId: to, tokenId: 1, amount: BigInt(amt), route, secret, hashlock } }],
          }],
        });
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
    console.log('[E2E] 10. Self-pay obfuscated loop route');
    const hubs = await discoverHubs(page);
    console.log(`[E2E] Hubs discovered: ${hubs.map(h => h.slice(0, 10)).join(', ')}`);
    const preferredThreeHubs = hubs.slice(0, 3);
    const requireThreeHubs = preferredThreeHubs.length >= 3;
    if (requireThreeHubs) {
      // Ensure the sender has direct bilateral links into the 3-hub cycle,
      // otherwise A->H1->H2->H3->A cannot execute as a real HTLC path.
      for (const hub of preferredThreeHubs) {
        await connectHub(page, alice!.entityId, alice!.signerId, hub);
      }
    }
    const selfRoute = await findSelfCycleRoute(
      page,
      alice!.entityId,
      requireThreeHubs ? 3 : 2,
      requireThreeHubs ? preferredThreeHubs : [],
    );
    expect(
      selfRoute.length,
      requireThreeHubs
        ? 'Need explicit A->H1->H2->H3->A self-route when 3 hubs are visible'
        : 'Need at least A->X->Y->A route',
    ).toBeGreaterThanOrEqual(requireThreeHubs ? 5 : 4);
    console.log(`[E2E] Self route selected: ${selfRoute.map(r => r.slice(0, 10)).join(' -> ')}`);

    const selfBefore = await outCap(page, alice!.entityId, hubId);
    await pay(page, alice!.entityId, alice!.signerId, alice!.entityId, selfRoute, toWei(1));
    await page.waitForTimeout(5000);
    const selfAfter = await outCap(page, alice!.entityId, hubId);
    console.log(`[E2E] Self-pay OUT via hub: ${selfBefore} → ${selfAfter}`);
    expect(selfAfter, 'Self-pay should not increase outbound unexpectedly').toBeLessThanOrEqual(selfBefore);

    const lockInfo = await page.evaluate((eid) => {
      const env = (window as any).isolatedEnv;
      for (const [k, rep] of (env?.eReplicas || new Map()).entries()) {
        if (String(k).startsWith(eid + ':')) {
          return { locks: rep?.state?.lockBook?.size || 0 };
        }
      }
      return { locks: -1 };
    }, alice!.entityId);
    expect(lockInfo.locks, 'Self-pay route should fully resolve (no lingering locks)').toBe(0);

    const debugCheck = await page.evaluate(async ({ apiBaseUrl }) => {
      try {
        const r = await fetch(`${apiBaseUrl}/api/debug/events?last=200`);
        if (!r.ok) return { ok: false, status: r.status, count: 0 };
        const body = await r.json();
        const events = Array.isArray(body?.events) ? body.events : [];
        return { ok: true, status: r.status, count: events.length };
      } catch (e: any) {
        return { ok: false, status: 0, count: 0, error: e?.message };
      }
    }, { apiBaseUrl: API_BASE_URL });
    expect(debugCheck.ok, `Debug endpoint must be reachable: ${JSON.stringify(debugCheck)}`).toBe(true);
    expect(debugCheck.count, 'Debug timeline should contain events').toBeGreaterThan(0);

    // Persistence coverage is handled in tests/e2e-runtime-persistence.spec.ts.
    // Keep this suite focused on payment correctness and routing behavior.

    // ── Summary ───────────────────────────────────────────────────
    console.log('\n[E2E] ══════ SUMMARY ══════');
    console.log(`[E2E] Route: Alice → H1 (1.00 bps) → Bob`);
    console.log(`[E2E] Fee per hop: ${ethers.formatUnits(fee, 18)} USDC on 10 USDC (0.001%)`);
    console.log(`[E2E] Forward:  Alice sent 10, Bob got ${ethers.formatUnits(payAmount, 18)}`);
    console.log(`[E2E] Reverse:  Bob sent 5, Alice got ${ethers.formatUnits(reverseAmount, 18)}`);
    console.log(`[E2E] 2nd fwd:  Alice sent 3, Bob got ${ethers.formatUnits(pay2Amount, 18)}`);
    console.log(`[E2E] Overspend: correctly rejected`);
    console.log(`[E2E] Self route: ${selfRoute.map(r => r.slice(0, 6)).join(' -> ')}`);
    console.log('[E2E] Persistence: covered by e2e-runtime-persistence.spec.ts');
    console.log('[E2E] ✅ All payment cases passed');
  });
});
