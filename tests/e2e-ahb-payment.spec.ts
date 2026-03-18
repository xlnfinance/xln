/**
 * E2E: Alice -> Hub -> Bob HTLC payment flow with reverse transfer, overspend rejection,
 * self-cycle routing, and reload persistence.
 *
 * Uses deterministic BIP39 mnemonics by default (override via env) so IDs are reproducible.
 * The scenario proves that three distinct runtimes can open bilateral accounts through a hub,
 * move HTLC payments in both directions, keep sender and recipient balances coherent, and
 * restore the same state after reload via snapshot + WAL replay.
 */

import { test, expect, type Page } from '@playwright/test';
import { ethers } from 'ethers';
import { deriveDelta } from '../runtime/account-utils';
import { APP_BASE_URL, API_BASE_URL, resetProdServer } from './utils/e2e-baseline';
import {
  listRenderedCounterpartyIds,
  getRenderedOutboundForAccount,
  waitForRenderedOutboundForAccountDelta,
} from './utils/e2e-account-ui';
import { connectHub as connectActiveRuntimeToHub } from './utils/e2e-connect';
import {
  createDemoUsers,
  gotoApp as gotoSharedApp,
  switchToRuntime,
} from './utils/e2e-demo-users';
import { getPersistedReceiptCursor, waitForPersistedFrameEvent } from './utils/e2e-runtime-receipts';

const INIT_TIMEOUT = 30_000;
const SETTLE_MS = 10_000;
const FAST_E2E = process.env.E2E_FAST !== '0';
const LONG_E2E = process.env.E2E_LONG === '1';

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

type DeltaSnapshot = {
  ondelta: string;
  offdelta: string;
  collateral: string;
  leftCreditLimit: string;
  rightCreditLimit: string;
  leftAllowance: string;
  rightAllowance: string;
  leftHold: string;
  rightHold: string;
};

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


// ─── Helpers ─────────────────────────────────────────────────────

/** Navigate to /app. Auto-unlock if redirect occurs. */
async function gotoApp(page: Page) {
  await gotoSharedApp(page, {
    appBaseUrl: APP_BASE_URL,
    initTimeoutMs: INIT_TIMEOUT,
    settleMs: 0,
  });
  await dismissOnboardingIfVisible(page);
  await page.waitForTimeout(2000);
}

async function dismissOnboardingIfVisible(page: Page) {
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

async function assertP2PSingletonAndWsHealth(page: Page, tag: string) {
  const apiBaseUrl = await getActiveApiBase(page);
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
  }, { apiBaseUrl });

  expect(snapshot.hasP2P, `[${tag}] runtime must have active P2P`).toBe(true);
  expect(snapshot.isConnected, `[${tag}] runtime P2P must have open WS`).toBe(true);
  expect(snapshot.clientCount, `[${tag}] runtime must have exactly one WS client`).toBe(1);
  expect(snapshot.relayCount, `[${tag}] runtime must have exactly one relay URL`).toBe(1);
  expect(
    snapshot.wsOpenForRuntime,
    `[${tag}] relay should not churn ws_open for same runtime (opens=${snapshot.wsOpenForRuntime}, closes=${snapshot.wsCloseForRuntime})`,
  ).toBeLessThanOrEqual(snapshot.wsCloseForRuntime + 2);
}

async function waitForActiveRuntime(page: Page, expectedRuntimeId: string, tag: string): Promise<void> {
  await page.waitForFunction(({ expectedRuntimeId }) => {
    const env = (window as any).isolatedEnv;
    return String(env?.runtimeId || '').toLowerCase() === String(expectedRuntimeId || '').toLowerCase()
      && Number(env?.eReplicas?.size || 0) > 0;
  }, { expectedRuntimeId }, { timeout: 20_000 });

  const activeRuntimeId = await page.evaluate(() => String((window as any).isolatedEnv?.runtimeId || '').toLowerCase());
  expect(activeRuntimeId, `[${tag}] active runtime mismatch`).toBe(String(expectedRuntimeId || '').toLowerCase());
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
  const apiBaseUrl = await getActiveApiBase(page);
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
  }, { entityId, apiBaseUrl });
  expect(advertised, `Entity ${entityId.slice(0, 12)} not advertised in relay debug or local gossip cache`).toBe(true);
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
                deltas.push({
                  tokenId,
                  offdelta: d.offdelta?.toString() || '0',
                  collateral: d.collateral?.toString?.() || '0',
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

async function getHubFeeConfig(page: Page, hubId: string): Promise<{ feePPM: bigint; baseFee: bigint }> {
  const fee = await page.evaluate((targetHubId) => {
    const env = (window as any).isolatedEnv;
    const profiles = env?.gossip?.getProfiles?.() || [];
    const profile = profiles.find((p: any) => String(p?.entityId || '').toLowerCase() === String(targetHubId || '').toLowerCase());
    const rawPPM = Number(profile?.metadata?.routingFeePPM ?? 0);
    const safePPM = Number.isFinite(rawPPM) && rawPPM >= 0 ? Math.floor(rawPPM) : 0;
    const rawBase = profile?.metadata?.baseFee;
    let base = '0';
    if (typeof rawBase === 'string') {
      base = rawBase;
    } else if (typeof rawBase === 'bigint') {
      base = rawBase.toString();
    } else if (typeof rawBase === 'number' && Number.isFinite(rawBase)) {
      base = String(Math.max(0, Math.floor(rawBase)));
    }
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
  const apiBaseUrl = await getActiveApiBase(page);
  for (let i = 0; i < 45; i++) {
    try {
      const r = await page.request.get(`${apiBaseUrl}/api/debug/entities`);
      if (r.ok()) {
        const data = await r.json();
        const ids = (Array.isArray((data as any)?.entities) ? (data as any).entities : [])
          .filter((e: any) => e?.isHub === true)
          .map((h: any) => h?.entityId)
          .filter((id: any): id is string => typeof id === 'string');
        const unique: string[] = Array.from(new Set(ids));
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

/** Get USDC outCapacity */
async function outCap(page: Page, entityId: string, cpId: string): Promise<bigint> {
  const delta = await page.evaluate(({ entityId, cpId }) => {
    const env = (window as any).isolatedEnv;
    if (!env?.eReplicas) return null;

    for (const [replicaKey, replica] of env.eReplicas.entries()) {
      if (!String(replicaKey).startsWith(`${entityId}:`)) continue;
      const account = replica?.state?.accounts?.get?.(cpId);
      const rawDelta = account?.deltas?.get?.(1);
      if (!rawDelta || typeof rawDelta !== 'object') return null;

      const raw = rawDelta as Record<string, unknown>;
      const readBig = (value: unknown): string => {
        if (typeof value === 'bigint') return value.toString();
        if (typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value)) return String(value);
        if (typeof value === 'string' && /^-?\\d+$/.test(value.trim())) return value.trim();
        return '0';
      };

      return {
        ondelta: readBig(raw.ondelta),
        offdelta: readBig(raw.offdelta),
        collateral: readBig(raw.collateral),
        leftCreditLimit: readBig(raw.leftCreditLimit),
        rightCreditLimit: readBig(raw.rightCreditLimit),
        leftAllowance: readBig(raw.leftAllowance),
        rightAllowance: readBig(raw.rightAllowance),
        leftHold: readBig(raw.leftHold),
        rightHold: readBig(raw.rightHold),
      } satisfies DeltaSnapshot;
    }

    return null;
  }, { entityId, cpId });

  if (!delta) return 0n;

  return deriveDelta({
    tokenId: 1,
    ondelta: BigInt(delta.ondelta),
    offdelta: BigInt(delta.offdelta),
    collateral: BigInt(delta.collateral),
    leftCreditLimit: BigInt(delta.leftCreditLimit),
    rightCreditLimit: BigInt(delta.rightCreditLimit),
    leftAllowance: BigInt(delta.leftAllowance),
    rightAllowance: BigInt(delta.rightAllowance),
    leftHold: BigInt(delta.leftHold),
    rightHold: BigInt(delta.rightHold),
  }, String(entityId).toLowerCase() < String(cpId).toLowerCase()).outCapacity;
}

async function connectedCounterparties(page: Page, entityId: string): Promise<Set<string>> {
  void entityId;
  return new Set(await listRenderedCounterpartyIds(page));
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

async function waitForSenderSpend(
  page: Page,
  entityId: string,
  cpId: string,
  baseline: bigint,
  minSpend: bigint,
  timeoutMs = 25_000
): Promise<{ latest: bigint; spent: bigint }> {
  const start = Date.now();
  let latest = baseline;
  let spent = 0n;
  while (Date.now() - start < timeoutMs) {
    latest = await outCap(page, entityId, cpId);
    spent = baseline - latest;
    if (spent >= minSpend) return { latest, spent };
    await page.waitForTimeout(250);
  }
  throw new Error(
    `Timed out waiting sender spend for ${entityId.slice(0, 10)}↔${cpId.slice(0, 10)}: baseline=${baseline} latest=${latest} spent=${spent} minSpend=${minSpend}`
  );
}

async function getAccountSyncState(
  page: Page,
  entityId: string,
  counterpartyId: string
): Promise<{ hasAccount: boolean; height: number; pendingHeight: number | null; mempoolLen: number }> {
  return page.evaluate(({ entityId, counterpartyId }) => {
    const env = (window as any).isolatedEnv;
    if (!env?.eReplicas) {
      return { hasAccount: false, height: 0, pendingHeight: null, mempoolLen: 0 };
    }
    for (const [key, rep] of env.eReplicas.entries()) {
      if (!String(key).startsWith(entityId + ':')) continue;
      const account = rep?.state?.accounts?.get?.(counterpartyId);
      if (!account) return { hasAccount: false, height: 0, pendingHeight: null, mempoolLen: 0 };
      return {
        hasAccount: true,
        height: Number(account.currentHeight || 0),
        pendingHeight: account.pendingFrame ? Number(account.pendingFrame.height || 0) : null,
        mempoolLen: Number(account.mempool?.length || 0),
      };
    }
    return { hasAccount: false, height: 0, pendingHeight: null, mempoolLen: 0 };
  }, { entityId, counterpartyId });
}

async function waitForAccountIdle(
  page: Page,
  entityId: string,
  counterpartyId: string,
  timeoutMs = 12_000
): Promise<void> {
  const started = Date.now();
  let last = { hasAccount: false, height: 0, pendingHeight: null as number | null, mempoolLen: 0 };
  while (Date.now() - started < timeoutMs) {
    last = await getAccountSyncState(page, entityId, counterpartyId);
    if (last.hasAccount && last.pendingHeight === null) return;
    await page.waitForTimeout(250);
  }
  throw new Error(
    `Account not idle for ${entityId.slice(0, 10)}↔${counterpartyId.slice(0, 10)}; ` +
    `hasAccount=${last.hasAccount} height=${last.height} pending=${last.pendingHeight} mempool=${last.mempoolLen}`
  );
}

async function fetchRelayEvents(page: Page, query: Record<string, string | number>): Promise<any[]> {
  const apiBaseUrl = await getActiveApiBase(page);
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) params.set(k, String(v));
  const res = await page.request.get(`${apiBaseUrl}/api/debug/events?${params.toString()}`);
  if (!res.ok()) return [];
  const body = await res.json().catch(() => ({}));
  return Array.isArray((body as any)?.events) ? (body as any).events : [];
}

async function getDebugEntities(page: Page): Promise<any[]> {
  const apiBaseUrl = await getActiveApiBase(page);
  const res = await page.request.get(`${apiBaseUrl}/api/debug/entities`);
  if (!res.ok()) return [];
  const body = await res.json().catch(() => ({}));
  return Array.isArray((body as any)?.entities) ? (body as any).entities : [];
}

async function getEntityRuntimeId(page: Page, entityId: string): Promise<string> {
  const entities = await getDebugEntities(page);
  const match = entities.find((e: any) =>
    String(e?.entityId || '').toLowerCase() === String(entityId).toLowerCase()
  );
  const runtimeId = String(match?.runtimeId || '');
  expect(runtimeId.length > 0, `Missing runtime hint for entity ${entityId.slice(0, 12)}`).toBe(true);
  return runtimeId;
}

async function dumpRelaySlice(page: Page, tag: string, last = 120): Promise<void> {
  const events = await fetchRelayEvents(page, { last });
  const rows = events.map((ev: any) => ({
    id: ev?.id,
    ts: ev?.ts,
    event: ev?.event,
    msgType: ev?.msgType,
    from: ev?.from,
    to: ev?.to,
    status: ev?.status,
    entityId: ev?.details?.entityId,
    txs: ev?.details?.txs,
  }));
  console.log(`[E2E][${tag}] relay events (last ${last}): ${JSON.stringify(rows)}`);
}

async function dumpRelayErrorSlice(page: Page, tag: string, since: number): Promise<void> {
  const events = await fetchRelayEvents(page, {
    last: 800,
    event: 'debug_event',
    since,
  });
  const rows = events
    .map((ev: any) => ev?.details?.payload)
    .filter((p: any) => p && (p.level === 'error' || p.level === 'warn'))
    .map((p: any) => ({
      level: p.level,
      category: p.category,
      message: p.message || p.eventName,
      entityId: p.entityId,
      runtimeId: p.runtimeId,
      data: p.data,
    }));
  console.log(`[E2E][${tag}] relay debug errors/warns since=${since}: ${JSON.stringify(rows)}`);
}

async function waitForRelayHtlcPipeline(
  page: Page,
  opts: {
    since: number;
    senderRuntimeId: string;
    hubRuntimeId: string;
    recipientRuntimeId: string;
    hubEntityId: string;
    recipientEntityId: string;
    timeoutMs?: number;
  }
): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? 12_000;
  const start = Date.now();
  let sawSenderToHub = false;
  while (Date.now() - start < timeoutMs) {
    const events = await fetchRelayEvents(page, {
      last: 1000,
      event: 'delivery',
      msgType: 'entity_input',
      since: opts.since,
    });

    sawSenderToHub = events.some((ev: any) =>
      String(ev?.from || '').toLowerCase() === String(opts.senderRuntimeId).toLowerCase() &&
      String(ev?.to || '').toLowerCase() === String(opts.hubRuntimeId).toLowerCase() &&
      String(ev?.details?.entityId || '').toLowerCase() === String(opts.hubEntityId).toLowerCase() &&
      String(ev?.status || '').startsWith('delivered')
    );

    const sawHubToRecipient = events.some((ev: any) =>
      String(ev?.from || '').toLowerCase() === String(opts.hubRuntimeId).toLowerCase() &&
      String(ev?.to || '').toLowerCase() === String(opts.recipientRuntimeId).toLowerCase() &&
      String(ev?.details?.entityId || '').toLowerCase() === String(opts.recipientEntityId).toLowerCase() &&
      (String(ev?.status || '').startsWith('delivered') || String(ev?.status || '').startsWith('queued'))
    );

    if (sawSenderToHub && sawHubToRecipient) return;
    await page.waitForTimeout(250);
  }

  await dumpRelaySlice(page, 'htlc-pipeline-timeout', 250);
  await dumpRelayErrorSlice(page, 'htlc-pipeline-timeout', opts.since);
  if (!sawSenderToHub) {
    throw new Error(
      `Relay pipeline break: sender(${opts.senderRuntimeId.slice(0, 12)}) -> hub(${opts.hubRuntimeId.slice(0, 12)}) not delivered`
    );
  }
  throw new Error(
    `Relay pipeline break: hub(${opts.hubRuntimeId.slice(0, 12)}) did not emit entity_input to recipient runtime=${opts.recipientRuntimeId.slice(0, 12)} entity=${opts.recipientEntityId.slice(0, 12)}`
  );
}

/** Faucet 100 USDC into one exact bilateral hub account (with 30s timeout). */
async function faucet(page: Page, entityId: string, hubEntityId: string) {
  let r: { ok: boolean; status: number; data: any } = { ok: false, status: 0, data: { error: 'not-run' } };
  for (let attempt = 1; attempt <= 6; attempt++) {
    const runtimeId = await page.evaluate(() => (window as any).isolatedEnv?.runtimeId || null);
    const apiBaseUrl = await getActiveApiBase(page);
    if (!runtimeId) {
      r = { ok: false, status: 0, data: { error: 'missing runtimeId in isolatedEnv' } };
      break;
    }
    try {
      const payload = {
        userEntityId: entityId,
        userRuntimeId: runtimeId,
        tokenId: 1,
        amount: '100',
        hubEntityId,
      };
      const resp = await page.request.post(`${apiBaseUrl}/api/faucet/offchain`, {
        data: payload,
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

async function openPayWorkspace(page: Page): Promise<void> {
  const accountsTab = page.getByTestId('tab-accounts').first();
  if (!await accountsTab.isVisible().catch(() => false)) {
    const backButton = page.locator('.account-panel .back-button').first();
    if (await backButton.isVisible().catch(() => false)) {
      await backButton.click();
    }
  }
  await expect(accountsTab).toBeVisible({ timeout: 20_000 });
  await accountsTab.click();
  const workspaceTabs = page.locator('.account-workspace-tabs').first();
  await expect(workspaceTabs).toBeVisible({ timeout: 20_000 });
  const payTab = workspaceTabs.locator('.account-workspace-tab').filter({ hasText: /Pay/i }).first();
  await expect(payTab).toBeVisible({ timeout: 20_000 });
  await payTab.click();
}

async function chooseVisibleRoute(page: Page, route: string[]): Promise<void> {
  if (route.length === 0) return;
  const routeOptions = page.locator('.route-option');
  const routeCount = await routeOptions.count();
  if (routeCount <= 1) return;
  const routeNeedles = route.map((hopId) => hopId.toLowerCase().slice(0, 10));
  for (let index = 0; index < routeCount; index += 1) {
    const option = routeOptions.nth(index);
    const text = (await option.textContent()).toLowerCase();
    const matches = routeNeedles.every((needle) => text.includes(needle));
    if (matches) {
      await option.click();
      return;
    }
  }
}

function parseRouteFeeText(rawText: string): bigint {
  const match = rawText.match(/Fee:\s*([0-9][0-9,]*(?:\.[0-9]+)?)/i);
  if (!match?.[1]) return 0n;
  const normalized = match[1].replace(/,/g, '').trim();
  return ethers.parseUnits(normalized, 18);
}

async function selectPayRecipient(page: Page, targetEntityId: string): Promise<void> {
  const recipientPicker = page.locator('button.closed-trigger').first();
  await expect(recipientPicker).toBeVisible({ timeout: 10_000 });
  await recipientPicker.click();
  const recipientOption = page.locator('.dropdown-item').filter({ hasText: targetEntityId }).first();
  await expect(recipientOption).toBeVisible({ timeout: 10_000 });
  await recipientOption.click();
}

async function pay(page: Page, from: string, signerId: string, to: string, route: string[], amount: bigint): Promise<bigint> {
  void from;
  void signerId;

  await openPayWorkspace(page);

  await selectPayRecipient(page, to);

  const amountInput = page.locator('#payment-amount-input');
  await expect(amountInput).toBeVisible({ timeout: 10_000 });
  await amountInput.click();
  await amountInput.fill(ethers.formatUnits(amount, 18));

  const findRoutesBtn = page.getByRole('button', { name: 'Find Routes' }).first();
  await expect(findRoutesBtn).toBeEnabled({ timeout: 10_000 });
  await findRoutesBtn.click();

  const routesPanel = page.locator('.route-option').first();
  await expect(routesPanel).toBeVisible({ timeout: 15_000 });
  await chooseVisibleRoute(page, route);
  const selectedRoute = page.locator('.route-option.selected, .route-option:has(input[type="radio"]:checked)').first();
  const selectedRouteText = (await selectedRoute.textContent().catch(() => '')) || '';
  const quotedSenderSpend = amount + parseRouteFeeText(selectedRouteText);

  const sendPaymentBtn = page.getByRole('button', { name: /Send Hashlock Payment|Pay Now/i }).first();
  await expect(sendPaymentBtn).toBeEnabled({ timeout: 10_000 });
  await sendPaymentBtn.click();
  await page.waitForTimeout(200);
  return quotedSenderSpend;
}

async function attemptOverspend(page: Page, to: string, route: string[], amount: bigint): Promise<void> {
  await openPayWorkspace(page);

  await selectPayRecipient(page, to);

  const amountInput = page.locator('#payment-amount-input');
  await amountInput.click();
  await amountInput.fill(ethers.formatUnits(amount, 18));

  const findRoutesBtn = page.getByRole('button', { name: 'Find Routes' }).first();
  await expect(findRoutesBtn).toBeEnabled({ timeout: 10_000 });
  await findRoutesBtn.click();
  await page.waitForTimeout(500);
  await chooseVisibleRoute(page, route);

  const sendPaymentBtn = page.getByRole('button', { name: /Send Hashlock Payment|Pay Now/i }).first();
  if (await sendPaymentBtn.isEnabled().catch(() => false)) {
    await sendPaymentBtn.click();
    await page.waitForTimeout(300);
  }
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

// ─── Test ─────────────────────────────────────────────────────────

test.describe('E2E: Alice ↔ Hub ↔ Bob', () => {
  test.setTimeout(LONG_E2E ? 300_000 : 60_000);

  test.beforeEach(async ({ page }) => {
    await resetProdServer(page, {
      timeoutMs: LONG_E2E ? 240_000 : 120_000,
      requireHubMesh: true,
      requireMarketMaker: false,
      minHubCount: 3,
    });
    await gotoApp(page);
  });

  test('bidirectional payments through hub', async ({ page }) => {
    // Scenario: bootstrap Alice and Bob on separate runtimes, route HTLCs through a hub,
    // verify sender debit plus recipient credit in both directions, then confirm persistence.
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

    // ── 2. Create Alice + Bob from shared demo-user bootstrap ────
    console.log('[E2E] 2. Create runtimes');
    const demoUsers = await createDemoUsers(page, ['alice', 'bob'] as const);
    const alice = demoUsers.alice;
    const bob = demoUsers.bob;
    expect(alice, 'Alice entity missing').toBeDefined();
    expect(bob, 'Bob entity missing').toBeDefined();
    console.log(`[E2E] Alice mnemonic: ${alice!.mnemonic.split(' ').slice(0, 3).join(' ')}...`);
    console.log(`[E2E] Bob mnemonic: ${bob!.mnemonic.split(' ').slice(0, 3).join(' ')}...`);

    await switchToRuntime(page, 'alice');
    await waitForActiveRuntime(page, alice!.runtimeId, 'alice-create');
    await assertP2PSingletonAndWsHealth(page, 'alice-create');
    await waitForEntityAdvertised(page, alice!.entityId);
    const aliceRuntimeId = alice!.runtimeId;
    console.log(`[E2E] Alice: entity=${alice!.entityId.slice(0, 16)}  signer=${alice!.signerId.slice(0, 12)}`);
    await dumpState(page, 'alice-after-create');

    await switchToRuntime(page, 'bob');
    await waitForActiveRuntime(page, bob!.runtimeId, 'bob-create');
    await assertP2PSingletonAndWsHealth(page, 'bob-create');
    expect(bob!.entityId).not.toBe(alice!.entityId);
    await waitForEntityAdvertised(page, bob!.entityId);
    const bobRuntimeId = bob!.runtimeId;
    console.log(`[E2E] Bob: entity=${bob!.entityId.slice(0, 16)}  signer=${bob!.signerId.slice(0, 12)}`);
    await dumpState(page, 'bob-after-create');

    // ── 3. Discover hubs ─────────────────────────────────────────
    console.log('[E2E] 3. Discover hubs');
    const hubs = await discoverHubs(page);
    expect(hubs.length, 'Need at least one hub visible in gossip').toBeGreaterThan(0);
    const hubId = hubs[0]!;
    const preferredThreeHubs = hubs.slice(0, 3);
    const aliceSetupHubs = preferredThreeHubs.length >= 3 ? preferredThreeHubs : [hubId];
    console.log(`[E2E] Primary hub: ${hubId.slice(0, 16)}`);
    console.log(`[E2E] Alice setup hubs: ${aliceSetupHubs.map((hub) => hub.slice(0, 10)).join(', ')}`);

    // ── 4. Connect accounts once during setup ────────────────────
    console.log('[E2E] 4a. Connect Bob to primary hub');
    await connectActiveRuntimeToHub(page, hubId);
    await dumpState(page, 'bob-after-connect');

    console.log('[E2E] 4b. Switch to Alice');
    await switchToRuntime(page, 'alice');
    await waitForActiveRuntime(page, aliceRuntimeId, 'switch-alice');
    await assertP2PSingletonAndWsHealth(page, 'switch-alice');
    await dumpState(page, 'alice-after-switch');

    console.log('[E2E] 4c. Connect Alice to required hubs upfront');
    for (const targetHubId of aliceSetupHubs) {
      console.log(`[E2E] 4c.i Open Alice account to ${targetHubId.slice(0, 16)}`);
      await connectActiveRuntimeToHub(page, targetHubId);
    }
    await dumpState(page, 'alice-after-connect');

    await screenshot(page, '04-alice-connected');

    // ── 5. Faucet Alice ──────────────────────────────────────────
    console.log('[E2E] 5. Faucet Alice');
    const a0 = await outCap(page, alice!.entityId, hubId);
    const a0Rendered = await getRenderedOutboundForAccount(page, hubId);
    console.log(`[E2E] Alice OUT before faucet: ${a0}`);
    await faucet(page, alice!.entityId, hubId);
    await dumpState(page, 'alice-after-faucet');
    const a1 = await waitForOutCapIncrease(page, alice!.entityId, hubId, a0);
    await waitForRenderedOutboundForAccountDelta(page, hubId, a0Rendered, 100, { timeoutMs: 20_000 });
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

    await switchToRuntime(page, 'bob');
    await waitForActiveRuntime(page, bobRuntimeId, 'switch-bob-forward-recv');
    await assertP2PSingletonAndWsHealth(page, 'switch-bob-forward-recv');
    await waitForAccountIdle(page, bob!.entityId, hubId);
    const b0 = await outCap(page, bob!.entityId, hubId);
    const bobForwardRendered = await getRenderedOutboundForAccount(page, hubId);
    const bobForwardCursor = await getPersistedReceiptCursor(page);

    await switchToRuntime(page, 'alice');
    await waitForActiveRuntime(page, aliceRuntimeId, 'switch-alice-reverse-recv');
    await assertP2PSingletonAndWsHealth(page, 'switch-alice-reverse-recv');
    await waitForAccountIdle(page, alice!.entityId, hubId);
    const hubRuntimeId = await getEntityRuntimeId(page, hubId);
    expect(hubRuntimeId, `hub runtimeId missing for hub=${hubId.slice(0, 12)}`).toBeTruthy();
    const runtimeIdSet = new Set([
      String(aliceRuntimeId || '').toLowerCase(),
      String(hubRuntimeId || '').toLowerCase(),
      String(bobRuntimeId || '').toLowerCase(),
    ]);
    expect(
      runtimeIdSet.has('') || runtimeIdSet.size !== 3,
      `AHB must use 3 distinct runtimes (alice/hub/bob). got alice=${aliceRuntimeId} hub=${hubRuntimeId} bob=${bobRuntimeId}`,
    ).toBe(false);
    const forwardQuotedSpend = await pay(page, alice!.entityId, alice!.signerId, bob!.entityId,
      [alice!.entityId, hubId, bob!.entityId], payAmount);

    const aliceMinSpend = forwardQuotedSpend > payAmount ? forwardQuotedSpend : payAmount;
    // Alice: sender pays the quoted lock amount once the debit is committed locally.
    const { latest: a2, spent: alicePaid } = await waitForSenderSpend(
      page,
      alice!.entityId,
      hubId,
      a1,
      aliceMinSpend,
    );
    console.log(`[E2E] Alice paid: ${alicePaid} (OUT ${a1} → ${a2})`);
    expect(alicePaid, 'Alice should pay at least quoted sender amount').toBeGreaterThanOrEqual(aliceMinSpend);
    await screenshot(page, '06a-alice-after-send');

    // Bob: receiver gets amount minus fee
    await switchToRuntime(page, 'bob');
    await waitForActiveRuntime(page, bobRuntimeId, 'switch-bob-forward-verify');
    await assertP2PSingletonAndWsHealth(page, 'switch-bob-forward-verify');
    await waitForPersistedFrameEvent(page, {
      cursor: bobForwardCursor,
      eventName: 'HtlcReceived',
      entityId: bob!.entityId,
      timeoutMs: 12_000,
    });
    const b1 = await waitForOutCapDelta(page, bob!.entityId, hubId, b0, payAmount);
    await waitForRenderedOutboundForAccountDelta(
      page,
      hubId,
      bobForwardRendered,
      Number(ethers.formatUnits(payAmount, 18)),
    );
    const bobReceived = b1 - b0;
    console.log(`[E2E] Bob received: ${bobReceived} (OUT ${b0} → ${b1})`);
    expect(bobReceived, `Bob should receive exact recipient amount (${payAmount})`).toBe(payAmount);

    // Bob's UI shows the received funds (data already verified via outCap above)
    await screenshot(page, '06b-bob-after-receive');

    console.log('[E2E] ✅ Forward HTLC verified (fee on sender)');

    if (FAST_E2E && !LONG_E2E) {
      console.log('[E2E] FAST mode: stopping after forward path.');
      return;
    }

    // ── 7. Reverse: Bob → Hub → Alice (5 USDC) ────────────────────
    const reverseAmount = toWei(5);
    const reverseSenderSpend = requiredInbound(reverseAmount, hubFee.feePPM, hubFee.baseFee);
    const reverseFee = reverseSenderSpend - reverseAmount;
    console.log(`[E2E] 7. Reverse HTLC: Bob → Hub → Alice`);
    console.log(`[E2E]    Amount: ${ethers.formatUnits(reverseAmount, 18)} USDC, fee: ${ethers.formatUnits(reverseFee, 18)} USDC`);

    // Bob already received funds in step 6, so reverse payment should not depend on a second faucet call.
    const b2 = b1;
    expect(b2, 'Bob must have enough OUT capacity for reverse payment').toBeGreaterThanOrEqual(reverseSenderSpend);
    console.log(`[E2E] Bob OUT available for reverse: ${b2}`);

    await switchToRuntime(page, 'alice');
    await waitForActiveRuntime(page, aliceRuntimeId, 'switch-alice-before-reverse');
    await assertP2PSingletonAndWsHealth(page, 'switch-alice-before-reverse');
    const a3 = await outCap(page, alice!.entityId, hubId);
    const aliceReverseRendered = await getRenderedOutboundForAccount(page, hubId);
    const aliceReverseCursor = await getPersistedReceiptCursor(page);

    await switchToRuntime(page, 'bob');
    await waitForActiveRuntime(page, bobRuntimeId, 'switch-bob-before-reverse');
    await assertP2PSingletonAndWsHealth(page, 'switch-bob-before-reverse');
    // Verify Bob still has account before paying
    const b2check = await outCap(page, bob!.entityId, hubId);
    console.log(`[E2E] Bob OUT pre-pay check: ${b2check}`);
    expect(b2check, 'Bob must have account before reverse pay').toBe(b2);

    const reverseQuotedSpend = await pay(page, bob!.entityId, bob!.signerId, alice!.entityId,
      [bob!.entityId, hubId, alice!.entityId], reverseAmount);

    // Dump state to understand what happened
    await dumpState(page, 'bob-after-reverse-pay');

    const bobMinSpend = reverseQuotedSpend > reverseAmount ? reverseQuotedSpend : reverseAmount;
    // Bob: sender pays full amount once the debit is committed locally.
    const { latest: b3, spent: bobPaid } = await waitForSenderSpend(
      page,
      bob!.entityId,
      hubId,
      b2,
      bobMinSpend,
    );
    console.log(`[E2E] Bob OUT after reverse: ${b3}`);
    console.log(`[E2E] Bob paid: ${bobPaid} (OUT ${b2} → ${b3})`);
    const bobCounterpartiesAfterReverse = await connectedCounterparties(page, bob!.entityId);
    expect(
      bobCounterpartiesAfterReverse.has(hubId.toLowerCase()),
      'Bob account must still exist after pay',
    ).toBe(true);
    expect(bobPaid, 'Bob should pay at least quoted sender amount').toBeGreaterThanOrEqual(bobMinSpend);
    await screenshot(page, '07a-bob-after-reverse-send');

    // Alice: receiver gets amount minus fee
    await switchToRuntime(page, 'alice');
    await waitForActiveRuntime(page, aliceRuntimeId, 'switch-alice-reverse-verify');
    await assertP2PSingletonAndWsHealth(page, 'switch-alice-reverse-verify');
    await waitForPersistedFrameEvent(page, {
      cursor: aliceReverseCursor,
      eventName: 'HtlcReceived',
      entityId: alice!.entityId,
      timeoutMs: 12_000,
    });
    const a4 = await waitForOutCapDelta(page, alice!.entityId, hubId, a3, reverseAmount);
    await waitForRenderedOutboundForAccountDelta(
      page,
      hubId,
      aliceReverseRendered,
      Number(ethers.formatUnits(reverseAmount, 18)),
    );
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
    await switchToRuntime(page, 'bob');
    await waitForActiveRuntime(page, bobRuntimeId, 'switch-bob-second-forward-baseline');
    await assertP2PSingletonAndWsHealth(page, 'switch-bob-second-forward-baseline');
    const b4 = await outCap(page, bob!.entityId, hubId);
    const bobSecondForwardRendered = await getRenderedOutboundForAccount(page, hubId);
    const bobSecondForwardCursor = await getPersistedReceiptCursor(page);

    await switchToRuntime(page, 'alice');
    await waitForActiveRuntime(page, aliceRuntimeId, 'switch-alice-second-forward-send');
    await assertP2PSingletonAndWsHealth(page, 'switch-alice-second-forward-send');
    const secondForwardQuotedSpend = await pay(page, alice!.entityId, alice!.signerId, bob!.entityId,
      [alice!.entityId, hubId, bob!.entityId], pay2Amount);
    const pay2MinSpend = secondForwardQuotedSpend > pay2Amount ? secondForwardQuotedSpend : pay2Amount;
    const { latest: a6, spent: pay2Spent } = await waitForSenderSpend(
      page,
      alice!.entityId,
      hubId,
      a5,
      pay2MinSpend,
    );
    expect(pay2Spent, '2nd payment: Alice pays at least quoted sender amount').toBeGreaterThanOrEqual(pay2MinSpend);

    await switchToRuntime(page, 'bob');
    await waitForActiveRuntime(page, bobRuntimeId, 'switch-bob-second-forward-verify');
    await assertP2PSingletonAndWsHealth(page, 'switch-bob-second-forward-verify');
    await waitForPersistedFrameEvent(page, {
      cursor: bobSecondForwardCursor,
      eventName: 'HtlcReceived',
      entityId: bob!.entityId,
      timeoutMs: 12_000,
    });
    const b5 = await waitForOutCapDelta(page, bob!.entityId, hubId, b4, pay2Amount);
    await waitForRenderedOutboundForAccountDelta(
      page,
      hubId,
      bobSecondForwardRendered,
      Number(ethers.formatUnits(pay2Amount, 18)),
    );
    console.log(`[E2E] 2nd: Bob OUT ${b4} → ${b5}, diff=${b5 - b4}, expected=${pay2Amount}`);
    expect(b5 - b4, '2nd payment: Bob receives exact recipient amount').toBe(pay2Amount);
    await screenshot(page, '08-bob-after-second-payment');

    console.log('[E2E] ✅ Second payment accumulates correctly');

    // ── 9. Insufficient capacity (should fail gracefully) ─────────
    await switchToRuntime(page, 'alice');
    await waitForActiveRuntime(page, aliceRuntimeId, 'switch-alice-overspend');
    await assertP2PSingletonAndWsHealth(page, 'switch-alice-overspend');
    console.log('[E2E] 9. Overspend: Alice tries to send more than capacity');
    const overAmount = a6 + toWei(1); // more than Alice has
    await attemptOverspend(page, bob!.entityId, [alice!.entityId, hubId, bob!.entityId], overAmount);
    // Overspend should either throw or not change Alice's balance
    const a7 = await outCap(page, alice!.entityId, hubId);
    console.log(`[E2E] Alice OUT unchanged: ${a6} → ${a7}`);
    expect(a7, 'Overspend should not change Alice balance').toBe(a6);

    console.log('[E2E] ✅ Overspend rejected');

    // ── Summary ───────────────────────────────────────────────────
    console.log('[E2E] 10. Self-pay obfuscated loop route');
    console.log(`[E2E] Hubs discovered: ${hubs.map(h => h.slice(0, 10)).join(', ')}`);
    const requireThreeHubs = preferredThreeHubs.length >= 3;
    if (requireThreeHubs) {
      const existingCounterparties = await connectedCounterparties(page, alice!.entityId);
      const hasAllCycleHubs = preferredThreeHubs.every((candidate) => existingCounterparties.has(candidate.toLowerCase()));
      expect(
        hasAllCycleHubs,
        `Alice must already be connected to cycle hubs from setup: ${preferredThreeHubs.join(', ')}`,
      ).toBe(true);
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

    const activeApiBase = await getActiveApiBase(page);
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
    }, { apiBaseUrl: activeApiBase });
    expect(debugCheck.ok, `Debug endpoint must be reachable: ${JSON.stringify(debugCheck)}`).toBe(true);
    expect(debugCheck.count, 'Debug timeline should contain events').toBeGreaterThan(0);

    // Reload hard-assert: payment balances must survive runtime restore.
    const aliceBeforeReload = await outCap(page, alice!.entityId, hubId);
    await switchToRuntime(page, 'bob');
    await waitForActiveRuntime(page, bobRuntimeId, 'switch-bob-before-reload');
    await assertP2PSingletonAndWsHealth(page, 'switch-bob-before-reload');
    const bobBeforeReload = await outCap(page, bob!.entityId, hubId);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => {
      const env = (window as any).isolatedEnv;
      return !!env?.runtimeId && Number(env?.eReplicas?.size || 0) > 0;
    }, { timeout: 60_000 });

    await switchToRuntime(page, 'alice');
    await waitForActiveRuntime(page, aliceRuntimeId, 'switch-alice-after-reload');
    await assertP2PSingletonAndWsHealth(page, 'switch-alice-after-reload');
    const aliceAfterReload = await outCap(page, alice!.entityId, hubId);
    expect(aliceAfterReload, 'Alice OUT must survive reload').toBe(aliceBeforeReload);
    await switchToRuntime(page, 'bob');
    await waitForActiveRuntime(page, bobRuntimeId, 'switch-bob-after-reload');
    await assertP2PSingletonAndWsHealth(page, 'switch-bob-after-reload');
    const bobAfterReload = await outCap(page, bob!.entityId, hubId);
    expect(bobAfterReload, 'Bob OUT must survive reload').toBe(bobBeforeReload);

    // ── Summary ───────────────────────────────────────────────────
    console.log('\n[E2E] ══════ SUMMARY ══════');
    console.log(`[E2E] Route: Alice → H1 (1.00 bps) → Bob`);
    console.log(`[E2E] Fee per hop: ${ethers.formatUnits(fee, 18)} USDC on 10 USDC (0.001%)`);
    console.log(`[E2E] Forward:  Alice sent 10, Bob got ${ethers.formatUnits(payAmount, 18)}`);
    console.log(`[E2E] Reverse:  Bob sent 5, Alice got ${ethers.formatUnits(reverseAmount, 18)}`);
    console.log(`[E2E] 2nd fwd:  Alice sent 3, Bob got ${ethers.formatUnits(pay2Amount, 18)}`);
    console.log(`[E2E] Overspend: correctly rejected`);
    console.log(`[E2E] Self route: ${selfRoute.map(r => r.slice(0, 6)).join(' -> ')}`);
    console.log('[E2E] Persistence: verified inline with page reload');
    console.log('[E2E] ✅ All payment cases passed');
  });
});
