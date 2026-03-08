/**
 * E2E rebalance coverage for the secured bar, repeated R2C/C2R cycles, routed capacity cliffs,
 * and reload persistence.
 *
 * Flow and goals:
 * 1. Start from the shared 3-hub baseline and create browser users.
 * 2. Push account usage until rebalance thresholds are crossed.
 * 3. Verify the bar requests collateral only from the canonical derived metric.
 * 4. Verify bilateral `j_event_claim` and finalize logic release holds correctly.
 * 5. Reload runtimes and verify the same rebalance/account state is restored from snapshot + WAL.
 *
 * These tests exist to prove that rebalance is deterministic, visually correct, and replay-safe.
 */
import { test, expect, type Page } from '@playwright/test';
import { Wallet, ethers } from 'ethers';
import { timedStep } from './utils/e2e-timing';
import { resetProdServer } from './utils/e2e-baseline';
import {
  gotoApp as gotoSharedApp,
  createRuntime as createSharedRuntime,
} from './utils/e2e-demo-users';
import { connectRuntimeToHub as connectRuntimeToSharedHub } from './utils/e2e-connect';
import {
  getPersistedReceiptCursor,
  readPersistedFrameEventsSinceCursor,
  waitForPersistedFrameEventMatch,
  type PersistedFrameEvent,
} from './utils/e2e-runtime-receipts';

/**
 * REBALANCE INVARIANT (do not "simplify" this in future edits):
 *
 * Auto request_collateral MUST trigger ONLY from deriveDelta(...).outPeerCredit > r2cRequestSoftLimit.
 * - outPeerCredit = currently used peer credit (actual risk surface).
 * - outCollateral = already posted collateral; it must NOT be added to trigger metric.
 *
 * Why:
 * Using (outCollateral + outPeerCredit) over-triggers after the first successful top-up
 * and causes a new request_collateral on almost every small payment/faucet click.
 */
const APP_BASE_URL = process.env.E2E_BASE_URL ?? 'https://localhost:8080';
const API_BASE_URL = process.env.E2E_API_BASE_URL ?? APP_BASE_URL;
const INIT_TIMEOUT = 30_000;
const FAST_E2E = process.env.E2E_FAST !== '0';
const LONG_E2E = process.env.E2E_LONG === '1';

type RelayTimelineEvent = {
  ts: number;
  event: string;
  runtimeId?: string;
  from?: string;
  to?: string;
  msgType?: string;
  status?: string;
  reason?: string;
  details?: unknown;
};

type PhaseMarker = {
  ts: number;
  label: string;
  phase?: string;
  entityId?: string;
  details?: unknown;
};

type DebugErrorSummary = {
  ts: number;
  event: string;
  level?: string;
  category?: string;
  message?: string;
  runtimeId?: string;
  entityId?: string;
  reason?: string;
  data?: unknown;
};

type FrameEventSummary = {
  runtimeId: string;
  currentFrameLogs: Array<{
    id: number;
    level: string;
    category: string;
    message: string;
    entityId?: string;
    data?: unknown;
  }>;
  accountHistory: Array<{
    frameHeight: number;
    txTypes: string[];
  }>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function persistedEventHasAccount(event: PersistedFrameEvent, accountId: string): boolean {
  return String(event.data?.accountId || '').toLowerCase() === accountId.toLowerCase();
}

async function readDebugTimeline(
  page: Page,
  params: { last?: number; sinceTs?: number; event?: string } = {},
): Promise<RelayTimelineEvent[]> {
  const search = new URLSearchParams();
  search.set('last', String(params.last ?? 400));
  if (typeof params.sinceTs === 'number' && Number.isFinite(params.sinceTs) && params.sinceTs > 0) {
    search.set('since', String(Math.floor(params.sinceTs)));
  }
  if (params.event) search.set('event', params.event);
  const response = await page.request.get(`${API_BASE_URL}/api/debug/events?${search.toString()}`);
  if (!response.ok()) return [];
  const body = await response.json().catch(() => ({}));
  return Array.isArray(body?.events) ? body.events as RelayTimelineEvent[] : [];
}

async function markE2EPhase(
  page: Page,
  label: string,
  input: {
    phase?: string;
    entityId?: string;
    details?: Record<string, unknown>;
  } = {},
): Promise<void> {
  const runtimeId = await page.evaluate(() => {
    const runtimeWindow = window as Window & typeof globalThis & {
      isolatedEnv?: {
        runtimeId?: string;
      };
    };
    return typeof runtimeWindow.isolatedEnv?.runtimeId === 'string'
      ? runtimeWindow.isolatedEnv.runtimeId
      : null;
  }).catch(() => null);

  const payload = {
    label,
    phase: input.phase,
    entityId: input.entityId,
    runtimeId: typeof runtimeId === 'string' && runtimeId.length > 0 ? runtimeId : undefined,
    details: input.details,
  };

  console.log(`[E2E-PHASE] ${label} ${JSON.stringify(payload)}`);
  await page.request.post(`${API_BASE_URL}/api/debug/events/mark`, { data: payload }).catch(() => null);
}

async function readPhaseMarkers(page: Page, sinceTs: number): Promise<PhaseMarker[]> {
  const events = await readDebugTimeline(page, { last: 600, sinceTs, event: 'e2e_phase' });
  return events.map((event) => {
    const details = isRecord(event.details) ? event.details : {};
    return {
      ts: event.ts,
      label: typeof details.label === 'string' ? details.label : String(event.reason || ''),
      phase: typeof details.phase === 'string' ? details.phase : undefined,
      entityId: typeof details.entityId === 'string' ? details.entityId : undefined,
      details: details.details,
    };
  });
}

async function readDebugErrors(page: Page, sinceTs: number): Promise<DebugErrorSummary[]> {
  const events = await readDebugTimeline(page, { last: 1000, sinceTs });
  const out: DebugErrorSummary[] = [];

  for (const event of events) {
    if (event.event === 'debug_event') {
      const details = isRecord(event.details) ? event.details : {};
      const payload = isRecord(details.payload) ? details.payload : {};
      const level = typeof payload.level === 'string' ? payload.level : undefined;
      if (level !== 'warn' && level !== 'error') continue;
      out.push({
        ts: event.ts,
        event: event.event,
        level,
        category: typeof payload.category === 'string' ? payload.category : undefined,
        message: typeof payload.message === 'string'
          ? payload.message
          : (typeof payload.eventName === 'string' ? payload.eventName : undefined),
        runtimeId: typeof payload.runtimeId === 'string' ? payload.runtimeId : event.runtimeId,
        entityId: typeof payload.entityId === 'string' ? payload.entityId : undefined,
        reason: event.reason,
        data: payload.data,
      });
      continue;
    }

    if (event.event === 'error') {
      out.push({
        ts: event.ts,
        event: event.event,
        level: 'error',
        runtimeId: event.runtimeId,
        reason: event.reason,
        data: event.details,
      });
    }
  }

  return out.slice(-80);
}

async function readRecentFrameEvents(page: Page, counterpartyId: string): Promise<FrameEventSummary> {
  return page.evaluate(({ counterpartyId }) => {
    const env = (window as any).isolatedEnv;
    const currentFrameLogs = Array.isArray(env?.frameLogs)
      ? env.frameLogs.slice(-80).map((entry: any) => ({
        id: Number(entry?.id || 0),
        level: String(entry?.level || ''),
        category: String(entry?.category || ''),
        message: String(entry?.message || ''),
        entityId: typeof entry?.entityId === 'string' ? entry.entityId : undefined,
        data: entry?.data,
      }))
      : [];

    const runtimeSigner = String(env?.runtimeId || '').toLowerCase();
    for (const [key, rep] of env?.eReplicas?.entries?.() || []) {
      const signerId = String(String(key || '').split(':')[1] || '').toLowerCase();
      if (runtimeSigner && signerId && signerId !== runtimeSigner) continue;
      const acc = rep?.state?.accounts?.get?.(counterpartyId);
      const history = Array.isArray(acc?.frameHistory)
        ? acc.frameHistory.slice(-12).map((frame: any) => ({
          frameHeight: Number(frame?.height || 0),
          txTypes: Array.isArray(frame?.accountTxs)
            ? frame.accountTxs.map((tx: any) => String(tx?.type || 'unknown'))
            : [],
        }))
        : [];
      return {
        runtimeId: String(env?.runtimeId || ''),
        currentFrameLogs,
        accountHistory: history,
      };
    }

    return {
      runtimeId: String(env?.runtimeId || ''),
      currentFrameLogs,
      accountHistory: [],
    };
  }, { counterpartyId });
}

async function collectRebalanceDebugArtifacts(
  page: Page,
  sinceTs: number,
  hubId: string,
): Promise<{
  phaseMarkers: PhaseMarker[];
  debugErrors: DebugErrorSummary[];
  frameEvents: FrameEventSummary;
}> {
  const [phaseMarkers, debugErrors, frameEvents] = await Promise.all([
    readPhaseMarkers(page, sinceTs),
    readDebugErrors(page, sinceTs),
    readRecentFrameEvents(page, hubId),
  ]);
  return { phaseMarkers, debugErrors, frameEvents };
}

function randomMnemonic(): string {
  return Wallet.createRandom().mnemonic!.phrase;
}

async function gotoApp(page: Page) {
  await gotoSharedApp(page, {
    appBaseUrl: APP_BASE_URL,
    initTimeoutMs: INIT_TIMEOUT,
    settleMs: 500,
  });
}

async function createRuntime(page: Page, label: string, mnemonic: string) {
  await createSharedRuntime(page, label, mnemonic);
}

async function ensureRuntimeOnline(page: Page, tag: string) {
  const ok = await page.evaluate(async () => {
    type RuntimeP2P = {
      isConnected?: () => boolean;
      connect?: () => void;
      reconnect?: () => void;
    };
    type RuntimeEnv = {
      runtimeState?: {
        p2p?: RuntimeP2P;
      };
    };
    const runtimeWindow = window as typeof window & {
      isolatedEnv?: RuntimeEnv;
    };
    const start = Date.now();
    while (Date.now() - start < 30_000) {
      const env = runtimeWindow.isolatedEnv;
      const p2p = env?.runtimeState?.p2p;
      if (!env || !p2p) {
        await new Promise((resolve) => setTimeout(resolve, 250));
        continue;
      }
      if (typeof p2p.isConnected === 'function' && p2p.isConnected()) return true;
      if (typeof p2p.connect === 'function') {
        try { p2p.connect(); } catch {}
      } else if (typeof p2p.reconnect === 'function') {
        try { p2p.reconnect(); } catch {}
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    return false;
  });
  expect(ok, `[${tag}] runtime must be online`).toBe(true);
}

async function discoverHub(page: Page): Promise<string> {
  for (let i = 0; i < 60; i++) {
    const fromGossip = await page.evaluate(() => {
      const env = (window as any).isolatedEnv;
      const XLN = (window as any).XLN;
      XLN?.refreshGossip?.(env);
      const profiles = env?.gossip?.getProfiles?.() || [];
      const hub = profiles.find((p: any) =>
        p?.metadata?.isHub === true || (Array.isArray(p?.capabilities) && p.capabilities.includes('hub')));
      return typeof hub?.entityId === 'string' ? hub.entityId : null;
    });
    if (fromGossip) return fromGossip;
    await page.waitForTimeout(1000);
  }
  throw new Error('Hub not discovered within 60s');
}

async function waitForHubProfile(page: Page, hubId: string) {
  const ok = await page.evaluate(async ({ hubId }) => {
    const env = (window as any).isolatedEnv;
    const XLN = (window as any).XLN;
    const target = String(hubId).toLowerCase();
    const start = Date.now();
    while (Date.now() - start < 60_000) {
      XLN?.refreshGossip?.(env);
      const profiles = env?.gossip?.getProfiles?.() || [];
      const profile = profiles.find((p: any) => String(p?.entityId || '').toLowerCase() === target);
      if (profile?.metadata?.isHub === true || (Array.isArray(profile?.capabilities) && profile.capabilities.includes('hub'))) {
        return true;
      }
      await new Promise((resolve) => setTimeout(resolve, 800));
    }
    return false;
  }, { hubId });
  expect(ok, `hub profile not visible in local gossip for ${hubId.slice(0, 12)}`).toBe(true);
}

async function getLocalEntity(page: Page): Promise<{ entityId: string; signerId: string }> {
  const entity = await page.evaluate(() => {
    const env = (window as any).isolatedEnv;
    if (!env?.eReplicas) return null;
    const runtimeSigner = String(env.runtimeId || '').toLowerCase();
    for (const [key] of env.eReplicas.entries()) {
      const [entityId, signerId] = String(key).split(':');
      if (!entityId || !signerId) continue;
      if (runtimeSigner && String(signerId).toLowerCase() !== runtimeSigner) continue;
      return { entityId, signerId };
    }
    return null;
  });
  if (!entity) throw new Error('No local entity in isolatedEnv');
  return entity;
}

async function connectHub(page: Page, entityId: string, signerId: string, hubId: string) {
  await connectRuntimeToSharedHub(page, { entityId, signerId }, hubId);
  await page.waitForTimeout(800);
}

async function connectHubWithCredit(
  page: Page,
  entityId: string,
  signerId: string,
  hubId: string,
  creditUsd: bigint,
) {
  const opened = await page.evaluate(async ({ entityId, signerId, hubId, creditUsd }) => {
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

    const env = (window as any).isolatedEnv;
    const XLN = (window as any).XLN;
    if (!env || !XLN) return false;

    XLN.enqueueRuntimeInput(env, {
      runtimeTxs: [],
      entityInputs: [{
        entityId,
        signerId,
        entityTxs: [{
          type: 'openAccount',
          data: { targetEntityId: hubId, creditAmount: BigInt(creditUsd) * 10n ** 18n, tokenId: 1 },
        }],
      }],
    });

    const start = Date.now();
    while (Date.now() - start < 45_000) {
      for (const [k, rep] of env.eReplicas.entries()) {
        if (!String(k).startsWith(entityId + ':')) continue;
        const acc = findAccount(rep?.state?.accounts, entityId, hubId);
        if (!acc) continue;
        const hasDelta = !!acc.deltas?.get?.(1);
        const noPending = !acc.pendingFrame;
        const hasFrames = Number(acc.currentHeight || 0) > 0;
        if (hasDelta && noPending && hasFrames) return true;
      }
      await new Promise((resolve) => setTimeout(resolve, 750));
    }
    return false;
  }, { entityId, signerId, hubId, creditUsd: creditUsd.toString() });

  expect(opened, `openAccount(${creditUsd} USD) -> bilateral account ready`).toBe(true);
  await page.waitForTimeout(800);
}

async function switchRuntime(page: Page, label: string) {
  const deadline = Date.now() + 30_000;
  let result: { ok: boolean; runtimeId?: string; error?: string } = { ok: false, error: 'not-started' };

  while (Date.now() < deadline) {
    try {
      result = await page.evaluate(async (runtimeLabel) => {
        try {
          const runtimesState = (window as any).runtimesState;
          const vaultOperations = (window as any).vaultOperations;
          if (!runtimesState || !vaultOperations) {
            return { ok: false, error: 'window.runtimesState/window.vaultOperations missing' };
          }
          let state: any;
          const unsub = runtimesState.subscribe((s: any) => { state = s; });
          unsub();
          for (const [id, runtime] of Object.entries(state.runtimes) as any[]) {
            if (String(runtime?.label || '').toLowerCase() !== String(runtimeLabel).toLowerCase()) continue;
            await vaultOperations.selectRuntime(id);
            return { ok: true, runtimeId: String(id) };
          }
          return { ok: false, error: `Runtime ${runtimeLabel} not found` };
        } catch (e: any) {
          return { ok: false, error: e?.message || String(e) };
        }
      }, label);
      if (result.ok) break;
    } catch (e: any) {
      const message = String(e?.message || e || '');
      if (/Execution context was destroyed|Cannot find context|Target closed/i.test(message)) {
        result = { ok: false, error: message };
      } else {
        throw e;
      }
    }
    await page.waitForLoadState('domcontentloaded', { timeout: 5_000 }).catch(() => {});
    await page.waitForTimeout(400);
  }

  expect(result.ok, `switchRuntime(${label}) failed: ${result.error || 'unknown'}`).toBe(true);
  await page.waitForFunction((expectedRuntimeId) => {
    type RuntimeState = {
      activeRuntimeId?: string | null;
      runtimes?: Record<string, { label?: string }>;
    };
    type RuntimeEnv = {
      runtimeId?: string;
      eReplicas?: Map<string, unknown>;
    };
    type RuntimeWindow = Window & typeof globalThis & {
      isolatedEnv?: RuntimeEnv;
      runtimesState?: {
        subscribe: (callback: (state: RuntimeState) => void) => () => void;
      };
    };
    const runtimeWindow = window as RuntimeWindow;
    const normalizedExpected = String(expectedRuntimeId || '').toLowerCase();
    const env = runtimeWindow.isolatedEnv;
    const envRuntimeId = String(env?.runtimeId || '').toLowerCase();
    if (!normalizedExpected || envRuntimeId !== normalizedExpected) return false;

    let activeRuntimeId = '';
    const stateStore = runtimeWindow.runtimesState;
    if (stateStore?.subscribe) {
      const unsubscribe = stateStore.subscribe((state) => {
        activeRuntimeId = String(state?.activeRuntimeId || '');
      });
      unsubscribe();
    }
    if (String(activeRuntimeId).toLowerCase() !== normalizedExpected) return false;

    const replicaKeys = env?.eReplicas ? Array.from(env.eReplicas.keys()) : [];
    return replicaKeys.some((key) => String(key).split(':')[1]?.toLowerCase() === normalizedExpected);
  }, result.runtimeId, { timeout: 15_000 });
  await ensureRuntimeOnline(page, `switch-${label}`);
}

async function discoverHubsByName(
  page: Page,
  requiredNames: string[],
): Promise<Record<string, string>> {
  for (let i = 0; i < 80; i++) {
    const hubs = await page.evaluate(() => {
      const env = (window as any).isolatedEnv;
      const XLN = (window as any).XLN;
      XLN?.refreshGossip?.(env);
      const profiles = env?.gossip?.getProfiles?.() || [];
      return profiles
        .filter((p: any) => p?.metadata?.isHub === true || (Array.isArray(p?.capabilities) && p.capabilities.includes('hub')))
        .map((p: any) => ({
          entityId: String(p?.entityId || ''),
          name: String(p?.metadata?.name || ''),
        }))
        .filter((h: any) => !!h.entityId);
    });
    const hubByName = new Map<string, string>();
    for (const hub of hubs) hubByName.set(String(hub.name || '').toLowerCase(), hub.entityId);
    const out: Record<string, string> = {};
    let ready = true;
    for (const requiredName of requiredNames) {
      const key = String(requiredName || '').toLowerCase();
      const entityId = hubByName.get(key);
      if (!entityId) {
        ready = false;
        break;
      }
      out[key] = entityId;
    }
    if (ready) return out;
    await page.waitForTimeout(1000);
  }
  throw new Error(`Required hubs not discovered in gossip: ${requiredNames.join(', ')}`);
}

async function discoverNamedHubs(page: Page): Promise<{ h1: string; h3: string }> {
  const hubs = await discoverHubsByName(page, ['h1', 'h3']);
  return { h1: hubs.h1, h3: hubs.h3 };
}

async function discoverH1H2(page: Page): Promise<{ h1: string; h2: string }> {
  const hubs = await discoverHubsByName(page, ['h1', 'h2']);
  return { h1: hubs.h1, h2: hubs.h2 };
}

async function setRebalancePolicy(
  page: Page,
  entityId: string,
  signerId: string,
  hubId: string,
  softUsd: bigint = 500n,
  hardUsd: bigint = 10_000n,
  maxFeeUsd: bigint = 20n,
) {
  const result = await page.evaluate(
    async ({ entityId, signerId, hubId, softUsd, hardUsd, maxFeeUsd }) => {
      try {
        const env = (window as any).isolatedEnv;
        const XLN = (window as any).XLN;
        if (!env || !XLN?.enqueueRuntimeInput) {
          return { ok: false, error: 'isolatedEnv/XLN missing' };
        }
        XLN.enqueueRuntimeInput(env, {
          runtimeTxs: [],
          entityInputs: [{
            entityId,
            signerId,
            entityTxs: [{
              type: 'setRebalancePolicy',
              data: {
                counterpartyEntityId: hubId,
                tokenId: 1,
                r2cRequestSoftLimit: BigInt(softUsd) * 10n ** 18n,
                hardLimit: BigInt(hardUsd) * 10n ** 18n,
                maxAcceptableFee: BigInt(maxFeeUsd) * 10n ** 18n,
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
      entityId,
      signerId,
      hubId,
      softUsd: softUsd.toString(),
      hardUsd: hardUsd.toString(),
      maxFeeUsd: maxFeeUsd.toString(),
    },
  );
  expect(result.ok, `setRebalancePolicy failed: ${result.error || 'unknown'}`).toBe(true);
  await page.waitForTimeout(600);
}

async function faucet(page: Page, userEntityId: string, hubEntityId: string) {
  const runtimeId = await page.evaluate(() => (window as any).isolatedEnv?.runtimeId || null);
  expect(runtimeId, 'runtimeId must exist before faucet').toBeTruthy();
  const deadline = Date.now() + 20_000;
  let lastBody: any = null;
  let lastStatus = 0;
  while (Date.now() < deadline) {
    const resp = await page.request.post(`${API_BASE_URL}/api/faucet/offchain`, {
      data: { userEntityId, userRuntimeId: runtimeId, hubEntityId, tokenId: 1, amount: '100' },
    });
    const body = await resp.json().catch(() => ({}));
    if (resp.ok()) return;
    lastBody = body;
    lastStatus = resp.status();
    const code = String(body?.code || '');
    if (code !== 'FAUCET_ACCOUNT_PENDING_FRAME' && code !== 'FAUCET_CLIENT_PENDING_FRAME') {
      break;
    }
    await page.waitForTimeout(300);
  }
  expect(false, `faucet failed: status=${lastStatus} body=${JSON.stringify(lastBody)}`).toBe(true);
}

async function faucetAmount(page: Page, userEntityId: string, hubEntityId: string, amountUsd: string) {
  const runtimeId = await page.evaluate(() => (window as any).isolatedEnv?.runtimeId || null);
  expect(runtimeId, 'runtimeId must exist before faucetAmount').toBeTruthy();
  const deadline = Date.now() + 20_000;
  let lastBody: any = null;
  let lastStatus = 0;
  while (Date.now() < deadline) {
    const resp = await page.request.post(`${API_BASE_URL}/api/faucet/offchain`, {
      data: { userEntityId, userRuntimeId: runtimeId, hubEntityId, tokenId: 1, amount: amountUsd },
    });
    const body = await resp.json().catch(() => ({}));
    if (resp.ok()) return;
    lastBody = body;
    lastStatus = resp.status();
    const code = String(body?.code || '');
    if (code !== 'FAUCET_ACCOUNT_PENDING_FRAME' && code !== 'FAUCET_CLIENT_PENDING_FRAME') {
      break;
    }
    await page.waitForTimeout(300);
  }
  expect(false, `faucetAmount failed: status=${lastStatus} body=${JSON.stringify(lastBody)}`).toBe(true);
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
  const res = await page.evaluate(
    async ({ fromEntityId, fromSignerId, targetEntityId, route, amountUsd, description, secret, hashlock }) => {
      try {
        type RuntimeEnv = {
          runtimeId?: string;
          eReplicas?: Map<string, unknown>;
        };
        type RuntimeWindow = Window & typeof globalThis & {
          isolatedEnv?: RuntimeEnv;
          XLN?: {
            enqueueRuntimeInput?: (env: RuntimeEnv, input: unknown) => void;
          };
        };
        const runtimeWindow = window as RuntimeWindow;
        const env = runtimeWindow.isolatedEnv;
        const XLN = runtimeWindow.XLN;
        if (!env || !XLN?.enqueueRuntimeInput) {
          return { ok: false, error: 'isolatedEnv/XLN missing' };
        }
        const expectedReplicaKey = `${fromEntityId}:${fromSignerId}`.toLowerCase();
        const replicaKeys = env.eReplicas ? Array.from(env.eReplicas.keys(), (key) => String(key).toLowerCase()) : [];
        if (!replicaKeys.includes(expectedReplicaKey)) {
          return {
            ok: false,
            error: `local replica ${expectedReplicaKey} missing in env.runtimeId=${String(env.runtimeId || 'none')}`,
          };
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
  expect(res.ok, `sendRoutedHtlcPayment failed: ${res.error || 'unknown'}`).toBe(true);
  return { secret, hashlock };
}

async function readPairState(page: Page, counterpartyId: string) {
  return page.evaluate(({ counterpartyId }) => {
    const env = (window as any).isolatedEnv;
    if (!env?.eReplicas) return null;
    const runtimeSigner = String(env.runtimeId || '').toLowerCase();
    for (const [key, rep] of env.eReplicas.entries()) {
      const parts = String(key || '').split(':');
      const signerId = String(parts[1] || '').toLowerCase();
      if (runtimeSigner && signerId && signerId !== runtimeSigner) continue;
      const acc = rep.state?.accounts?.get(counterpartyId);
      if (!acc) continue;
      const delta = acc.deltas?.get?.(1);
      if (!delta) continue;
      const XLN = (window as any).XLN;
      const isLeft = String(rep.entityId || '').toLowerCase() < String(counterpartyId).toLowerCase();
      const derived = typeof XLN?.deriveDelta === 'function' ? XLN.deriveDelta(delta, isLeft) : null;
      const outPeerCredit = BigInt(derived?.outPeerCredit ?? 0n);
      const outCollateral = BigInt(derived?.outCollateral ?? 0n);
      const hubExposure = outPeerCredit + outCollateral;
      const uncollateralized = outPeerCredit > outCollateral ? outPeerCredit - outCollateral : 0n;
      const requested = acc.requestedRebalance?.get?.(1) || 0n;
      const history = Array.isArray(acc.frameHistory) ? acc.frameHistory : [];
      const recentDirectPaymentDescriptions = history
        .slice(-40)
        .flatMap((frame: any) => (Array.isArray(frame?.accountTxs) ? frame.accountTxs : []))
        .filter((tx: any) => tx?.type === 'direct_payment')
        .map((tx: any) => String(tx?.data?.description || ''));
      const recentHtlcHashlocks = history
        .slice(-80)
        .flatMap((frame: any) => (Array.isArray(frame?.accountTxs) ? frame.accountTxs : []))
        .filter((tx: any) => tx?.type === 'htlc_lock' || tx?.type === 'htlc_resolve')
        .map((tx: any) => String(tx?.data?.hashlock || ''))
        .filter((hash: string) => hash.startsWith('0x') && hash.length > 10);
      const recentHtlcResolveCount = history
        .slice(-80)
        .flatMap((frame: any) => (Array.isArray(frame?.accountTxs) ? frame.accountTxs : []))
        .filter((tx: any) => tx?.type === 'htlc_resolve')
        .length;
      const recentHtlcLockCount = history
        .slice(-80)
        .flatMap((frame: any) => (Array.isArray(frame?.accountTxs) ? frame.accountTxs : []))
        .filter((tx: any) => tx?.type === 'htlc_lock')
        .length;
      return {
        currentHeight: Number(acc.currentHeight || 0),
        pendingHeight: acc.pendingFrame ? Number(acc.pendingFrame.height || 0) : 0,
        mempoolLen: Number(acc.mempool?.length || 0),
        requested: requested.toString(),
        hubExposure: hubExposure.toString(),
        hubDebt: outPeerCredit.toString(),
        totalDelta: String(derived?.delta ?? 0n),
        inCollateral: String(derived?.inCollateral ?? 0n),
        outCollateral: String(derived?.outCollateral ?? 0n),
        inCapacity: String(derived?.inCapacity ?? 0n),
        outCapacity: String(derived?.outCapacity ?? 0n),
        collateral: outCollateral.toString(),
        uncollateralized: uncollateralized.toString(),
        lastFinalizedJHeight: Number(acc.lastFinalizedJHeight || 0),
        recentDirectPaymentDescriptions,
        recentHtlcHashlocks,
        recentHtlcResolveCount,
        recentHtlcLockCount,
      };
    }
    return null;
  }, { counterpartyId });
}

async function waitForPairIdle(
  page: Page,
  counterpartyId: string,
  timeoutMs = 20_000,
) {
  const start = Date.now();
  let last: Awaited<ReturnType<typeof readPairState>> = null;
  while (Date.now() - start < timeoutMs) {
    last = await readPairState(page, counterpartyId);
    if (last && Number(last.pendingHeight || 0) === 0) return last;
    await page.waitForTimeout(250);
  }
  throw new Error(
    `pair ${counterpartyId.slice(0, 12)} not idle: ${JSON.stringify(last, null, 2)}`,
  );
}

async function waitForOutCapacityIncrease(
  page: Page,
  counterpartyId: string,
  baselineOutCapacity: bigint,
  timeoutMs = 30_000,
) {
  const start = Date.now();
  let last: Awaited<ReturnType<typeof readPairState>> = null;
  while (Date.now() - start < timeoutMs) {
    last = await readPairState(page, counterpartyId);
    const outCapacity = BigInt(last?.outCapacity || '0');
    if (outCapacity > baselineOutCapacity) return last;
    await page.waitForTimeout(500);
  }
  throw new Error(
    `outCapacity did not increase for ${counterpartyId.slice(0, 12)}: baseline=${baselineOutCapacity} last=${JSON.stringify(last, null, 2)}`,
  );
}

async function waitForSenderHtlcLock(
  page: Page,
  counterpartyId: string,
  hashlock: string,
  baselineLockCount: number,
  timeoutMs = 25_000,
) {
  const start = Date.now();
  let last: Awaited<ReturnType<typeof readPairState>> = null;
  while (Date.now() - start < timeoutMs) {
    last = await readPairState(page, counterpartyId);
    const hashSeen = Array.isArray(last?.recentHtlcHashlocks) && last.recentHtlcHashlocks.includes(hashlock);
    const lockCountIncreased = Number(last?.recentHtlcLockCount || 0) > baselineLockCount;
    if (hashSeen || lockCountIncreased) return last;
    await page.waitForTimeout(350);
  }
  throw new Error(
    `sender HTLC lock not observed for ${counterpartyId.slice(0, 12)} hashlock=${hashlock.slice(0, 12)}: ${JSON.stringify(last, null, 2)}`,
  );
}

async function sendDirectPaymentToHub(
  page: Page,
  entityId: string,
  signerId: string,
  hubId: string,
  amountUsd: bigint,
) {
  const res = await page.evaluate(
    async ({ entityId, signerId, hubId, amountUsd }) => {
      try {
        const env = (window as any).isolatedEnv;
        const XLN = (window as any).XLN;
        if (!env || !XLN?.enqueueRuntimeInput) {
          return { ok: false, error: 'isolatedEnv/XLN missing' };
        }
        XLN.enqueueRuntimeInput(env, {
          runtimeTxs: [],
          entityInputs: [{
            entityId,
            signerId,
            entityTxs: [{
              type: 'directPayment',
              data: {
                targetEntityId: hubId,
                tokenId: 1,
                amount: BigInt(amountUsd) * 10n ** 18n,
                route: [entityId, hubId],
                description: 'e2e-c2r-drain',
              },
            }],
          }],
        });
        return { ok: true };
      } catch (error: any) {
        return { ok: false, error: error?.message || String(error) };
      }
    },
    { entityId, signerId, hubId, amountUsd: amountUsd.toString() },
  );
  expect(res.ok, `directPayment enqueue failed: ${res.error || 'unknown'}`).toBe(true);
}

function generateHtlcPayload(): { secret: string; hashlock: string } {
  const secret = ethers.hexlify(ethers.randomBytes(32));
  const hashlock = ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(['bytes32'], [secret]),
  );
  return { secret, hashlock };
}

async function sendHtlcPaymentToHub(
  page: Page,
  entityId: string,
  signerId: string,
  hubId: string,
  amountUsd: bigint,
): Promise<{ secret: string; hashlock: string }> {
  const { secret, hashlock } = generateHtlcPayload();
  const res = await page.evaluate(
    async ({ entityId, signerId, hubId, amountUsd, secret, hashlock }) => {
      try {
        const env = (window as any).isolatedEnv;
        const XLN = (window as any).XLN;
        if (!env || !XLN?.enqueueRuntimeInput) {
          return { ok: false, error: 'isolatedEnv/XLN missing' };
        }
        XLN.enqueueRuntimeInput(env, {
          runtimeTxs: [],
          entityInputs: [{
            entityId,
            signerId,
            entityTxs: [{
              type: 'htlcPayment',
              data: {
                targetEntityId: hubId,
                tokenId: 1,
                amount: BigInt(amountUsd) * 10n ** 18n,
                route: [entityId, hubId],
                description: 'e2e-htlc-before-rebalance',
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
    { entityId, signerId, hubId, amountUsd: amountUsd.toString(), secret, hashlock },
  );
  expect(res.ok, `htlcPayment enqueue failed: ${res.error || 'unknown'}`).toBe(true);
  return { secret, hashlock };
}

async function readAccountFlowState(page: Page, hubId: string) {
  return page.evaluate(({ hubId }) => {
    const env = (window as any).isolatedEnv;
    if (!env?.eReplicas) return null;
    const runtimeSigner = String(env.runtimeId || '').toLowerCase();
    for (const [key, rep] of env.eReplicas.entries()) {
      const parts = String(key || '').split(':');
      const signerId = String(parts[1] || '').toLowerCase();
      if (runtimeSigner && signerId && signerId !== runtimeSigner) continue;
      const acc = rep.state?.accounts?.get(hubId);
      if (!acc) continue;
      const history = Array.isArray(acc.frameHistory) ? acc.frameHistory : [];
      const recentTxTypes = history
        .slice(-20)
        .flatMap((frame: any) => (Array.isArray(frame?.accountTxs) ? frame.accountTxs : []))
        .map((tx: any) => String(tx?.type || ''));
      const recentHtlcHashlocks = history
        .slice(-80)
        .flatMap((frame: any) => (Array.isArray(frame?.accountTxs) ? frame.accountTxs : []))
        .filter((tx: any) => tx?.type === 'htlc_lock' || tx?.type === 'htlc_resolve')
        .map((tx: any) => String(tx?.data?.hashlock || ''))
        .filter((hash: string) => hash.startsWith('0x') && hash.length > 10);
      let accountLockCount = 0;
      if (rep.state?.lockBook && typeof rep.state.lockBook.values === 'function') {
        for (const lock of rep.state.lockBook.values()) {
          if (String(lock?.accountId || '').toLowerCase() === String(hubId || '').toLowerCase()) {
            accountLockCount += 1;
          }
        }
      }
      return {
        currentHeight: Number(acc.currentHeight || 0),
        recentTxTypes,
        recentHtlcHashlocks,
        accountLockCount,
      };
    }
    return null;
  }, { hubId });
}

async function readAccountJEventClaims(page: Page, hubId: string) {
  return page.evaluate(({ hubId }) => {
    const env = (window as any).isolatedEnv;
    if (!env?.eReplicas) return null;
    const target = String(hubId || '').toLowerCase();
    const runtimeSigner = String(env.runtimeId || '').toLowerCase();
    for (const [key, rep] of env.eReplicas.entries()) {
      const parts = String(key || '').split(':');
      const signerId = String(parts[1] || '').toLowerCase();
      if (runtimeSigner && signerId && signerId !== runtimeSigner) continue;
      const acc = rep.state?.accounts?.get(hubId);
      if (!acc) continue;
      const history = Array.isArray(acc.frameHistory) ? acc.frameHistory : [];
      const claims: Array<{
        frameHeight: number;
        jHeight: number;
        txHash: string;
        nonce: string;
        leftEntity: string;
        rightEntity: string;
        tokenId: number;
        collateral: string;
        ondelta: string;
      }> = [];
      for (const frame of history.slice(-200)) {
        const txs = Array.isArray(frame?.accountTxs) ? frame.accountTxs : [];
        for (const tx of txs) {
          if (tx?.type !== 'j_event_claim') continue;
          const payload = tx?.data || {};
          const events = Array.isArray(payload?.events) ? payload.events : [];
          for (const event of events) {
            if (String(event?.type || '') !== 'AccountSettled') continue;
            const data = event?.data || {};
            claims.push({
              frameHeight: Number(frame?.height || 0),
              jHeight: Number(payload?.jHeight || 0),
              txHash: String(event?.transactionHash || ''),
              nonce: String(data?.nonce ?? ''),
              leftEntity: String(data?.leftEntity || '').toLowerCase(),
              rightEntity: String(data?.rightEntity || '').toLowerCase(),
              tokenId: Number(data?.tokenId || 0),
              collateral: String(data?.collateral ?? '0'),
              ondelta: String(data?.ondelta ?? '0'),
            });
          }
        }
      }
      return {
        accountEntityId: String(rep.entityId || '').toLowerCase(),
        counterpartyId: target,
        claims,
      };
    }
    return null;
  }, { hubId });
}

async function readRebalanceState(page: Page, hubId: string) {
  return page.evaluate(({ hubId }) => {
    const env = (window as any).isolatedEnv;
    if (!env?.eReplicas) return null;
    const runtimeSigner = String(env.runtimeId || '').toLowerCase();
    for (const [key, rep] of env.eReplicas.entries()) {
      const parts = String(key || '').split(':');
      const signerId = String(parts[1] || '').toLowerCase();
      if (runtimeSigner && signerId && signerId !== runtimeSigner) continue;
      const acc = rep.state?.accounts?.get(hubId);
      if (!acc) continue;
      const delta = acc.deltas?.get?.(1);
      if (!delta) continue;
      const XLN = (window as any).XLN;
      const localIsLeft = String(rep.entityId || '').toLowerCase() < String(hubId).toLowerCase();
      const hubIsLeft = String(hubId || '').toLowerCase() < String(rep.entityId || '').toLowerCase();
      const localDerived = typeof XLN?.deriveDelta === 'function' ? XLN.deriveDelta(delta, localIsLeft) : null;
      const hubDerived = typeof XLN?.deriveDelta === 'function' ? XLN.deriveDelta(delta, hubIsLeft) : null;
      const outPeerCredit = BigInt(localDerived?.outPeerCredit ?? 0n);
      const outCollateral = BigInt(localDerived?.outCollateral ?? 0n);
      const outTotalHold = BigInt(localDerived?.outTotalHold ?? 0n);
      const hubOutCollateral = BigInt(hubDerived?.outCollateral ?? 0n);
      const hubOutTotalHold = BigInt(hubDerived?.outTotalHold ?? 0n);
      const hubFreeOutCollateral = hubOutCollateral > hubOutTotalHold ? hubOutCollateral - hubOutTotalHold : 0n;
      const hubExposure = outPeerCredit + outCollateral;
      const uncollateralized = outPeerCredit > outCollateral ? outPeerCredit - outCollateral : 0n;
      const requested = acc.requestedRebalance?.get?.(1) || 0n;
      const policy = acc.rebalancePolicy?.get?.(1) || null;
      return {
        entityId: String(rep.entityId || ''),
        requested: requested.toString(),
        collateral: outCollateral.toString(),
        ondelta: String(delta.ondelta || 0n),
        offdelta: String(delta.offdelta || 0n),
        hubExposure: hubExposure.toString(),
        hubDebt: outPeerCredit.toString(),
        totalDelta: String(localDerived?.delta ?? 0n),
        inCollateral: String(localDerived?.inCollateral ?? 0n),
        outCollateral: String(localDerived?.outCollateral ?? 0n),
        outTotalHold: String(localDerived?.outTotalHold ?? 0n),
        freeOutCollateral: String(outCollateral > outTotalHold ? outCollateral - outTotalHold : 0n),
        inCapacity: String(localDerived?.inCapacity ?? 0n),
        outCapacity: String(localDerived?.outCapacity ?? 0n),
        uncollateralized: uncollateralized.toString(),
        hubOutCollateral: hubOutCollateral.toString(),
        hubOutTotalHold: hubOutTotalHold.toString(),
        hubFreeOutCollateral: hubFreeOutCollateral.toString(),
        lastFinalizedJHeight: Number(acc.lastFinalizedJHeight || 0),
        currentHeight: Number(acc.currentHeight || 0),
        hasPolicy: !!policy,
      };
    }
    return null;
  }, { hubId });
}

async function readRebalanceDiagnostics(page: Page, hubId: string) {
  return page.evaluate(({ hubId }) => {
    const env = (window as any).isolatedEnv;
    if (!env?.eReplicas) return null;
    let profile: any = null;
    const target = String(hubId || '').toLowerCase();
    const profiles = env?.gossip?.getProfiles?.() || [];
    profile = profiles.find((p: any) => String(p?.entityId || '').toLowerCase() === target) || null;
    const runtimeSigner = String(env.runtimeId || '').toLowerCase();
    for (const [key, rep] of env.eReplicas.entries()) {
      const parts = String(key || '').split(':');
      const signerId = String(parts[1] || '').toLowerCase();
      if (runtimeSigner && signerId && signerId !== runtimeSigner) continue;
      const acc = rep.state?.accounts?.get(hubId);
      if (!acc) continue;
      return {
        accountEntityId: String(rep.entityId || ''),
        counterpartyRebalanceFeePolicy: acc.counterpartyRebalanceFeePolicy || null,
        profileFound: !!profile,
        profileIsHub: profile?.metadata?.isHub === true,
        profileCapabilities: Array.isArray(profile?.capabilities) ? profile.capabilities : [],
        profileFeeFields: {
          rebalanceBaseFee: profile?.metadata?.rebalanceBaseFee ?? null,
          rebalanceLiquidityFeeBps: profile?.metadata?.rebalanceLiquidityFeeBps ?? null,
          rebalanceGasFee: profile?.metadata?.rebalanceGasFee ?? null,
          policyVersion: profile?.metadata?.policyVersion ?? null,
        },
      };
    }
    return null;
  }, { hubId });
}

async function readRebalanceStepEvents(page: Page, sinceTs: number): Promise<any[]> {
  const response = await page.request.get(`${API_BASE_URL}/api/debug/events?last=20000&since=${sinceTs}`);
  if (!response.ok()) return [];
  const body = await response.json().catch(() => ({}));
  const events = Array.isArray(body?.events) ? body.events : [];
  return events
    .filter((e: any) => e?.event === 'debug_event' && e?.details?.payload?.code === 'REB_STEP')
    .map((e: any) => ({ ts: e.ts, ...e.details.payload }));
}

function buildRebalanceFailureDump(input: {
  entityId: string;
  hubId: string;
  snapshot: any;
  diagnostics: any;
  rebalanceSteps: any[];
  stateTimeline: any[];
  rebalanceConsole: string[];
  phaseMarkers?: PhaseMarker[];
  debugErrors?: DebugErrorSummary[];
  frameEvents?: FrameEventSummary | null;
}) {
  const stringifySafe = (value: unknown) =>
    JSON.stringify(
      value,
      (_key, v) => (typeof v === 'bigint' ? v.toString() : v),
      2,
    );
  const stepCounts = input.rebalanceSteps.reduce((acc: Record<string, number>, step: any) => {
    const key = String(step?.event || 'unknown');
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
  return stringifySafe(
    {
      entityId: input.entityId,
      hubId: input.hubId,
      snapshot: input.snapshot,
      diagnostics: input.diagnostics,
      stepCounts,
      recentSteps: input.rebalanceSteps.slice(-120),
      phaseMarkers: (input.phaseMarkers || []).slice(-40),
      debugErrors: (input.debugErrors || []).slice(-40),
      frameEvents: input.frameEvents || null,
      stateTimeline: input.stateTimeline.slice(-60),
      console: input.rebalanceConsole.slice(-120),
    },
    null,
    2,
  );
}

function countRebalanceStepEvents(
  steps: Array<Record<string, unknown>>,
  event: string,
  predicate?: (step: Record<string, unknown>) => boolean,
): number {
  return steps.filter((step) => step?.event === event && (!predicate || predicate(step))).length;
}

async function reloadRuntimeAndWaitReady(page: Page, rebalanceConsole: string[], timingLabel: string): Promise<void> {
  await timedStep(timingLabel, async () => {
    await page.reload({ waitUntil: 'domcontentloaded' });
    try {
      await page.waitForFunction(() => {
        const env = (window as unknown as { isolatedEnv?: { runtimeId?: string; eReplicas?: { size?: number } } }).isolatedEnv;
        return !!env?.runtimeId && Number(env?.eReplicas?.size || 0) > 0;
      }, { timeout: 60_000 });
    } catch (error) {
      const runtimeDebug = await page.evaluate(() => {
        const env = (window as unknown as { isolatedEnv?: { runtimeId?: string; eReplicas?: { size?: number } } }).isolatedEnv;
        const runtimesRaw = typeof localStorage !== 'undefined' ? localStorage.getItem('xln-vaults') : null;
        return {
          hasEnv: !!env,
          runtimeId: env?.runtimeId || null,
          replicaCount: Number(env?.eReplicas?.size || 0),
          hasVaultsKey: !!runtimesRaw,
          vaultsKeyLength: runtimesRaw?.length || 0,
          location: window.location.href,
        };
      }).catch(() => ({
        hasEnv: false,
        runtimeId: null,
        replicaCount: 0,
        hasVaultsKey: false,
        vaultsKeyLength: 0,
        location: 'eval-failed',
      }));
      const tailConsole = rebalanceConsole.slice(-25);
      throw new Error(
        `reload restore failed: ${JSON.stringify(runtimeDebug)} :: ${(error as Error).message} :: consoleTail=${JSON.stringify(tailConsole)}`,
      );
    }
  });
}

test.describe('Rebalance E2E', () => {
  // Rebalance involves async j-event bilateral finalization and can exceed 60s on local runs.
  test.setTimeout(LONG_E2E ? 300_000 : 180_000);

  // Scenario: repeated faucet traffic should cross the soft limit, trigger request_collateral,
  // and end with a secured account bar and a second successful rebalance cycle.
  test('faucet -> request_collateral -> secured bar', async ({ page }) => {
    let scenarioStartedAt = 0;
    const rebalanceConsole: string[] = [];
    const criticalConsole: string[] = [];
    page.on('console', (msg) => {
      const text = msg.text();
      if (/AUTO-REBALANCE|Auto-rebalance|request_collateral|counterparty-not-hub|missing-hub-fee-policy/.test(text)) {
        rebalanceConsole.push(text);
      }
      if (/FRAME_CONSENSUS_FAILED|Frame hash verification failed|Runtime loop error|RUNTIME_LOOP_HALTED/.test(text)) {
        criticalConsole.push(text);
      }
    });

    await timedStep('rebalance.reset_server', () => resetProdServer(page));
    await page.addInitScript(() => {
      try {
        localStorage.setItem('xln-app-mode', 'user');
        localStorage.setItem('xln-onboarding-complete', 'true');
      } catch {
        // no-op
      }
    });
    await timedStep('rebalance.goto_app', () => gotoApp(page));
    await timedStep('rebalance.create_runtime', () => createRuntime(page, `rebalance-${Date.now()}`, randomMnemonic()));
    await timedStep('rebalance.ensure_runtime_online', () => ensureRuntimeOnline(page, 'post-create'));

    const { entityId, signerId } = await timedStep('rebalance.get_local_entity', () => getLocalEntity(page));
    const hubId = await timedStep('rebalance.discover_hub', () => discoverHub(page));
    const hubIsLeft = hubId.toLowerCase() < entityId.toLowerCase();
    await timedStep('rebalance.wait_hub_profile', () => waitForHubProfile(page, hubId));
    await timedStep('rebalance.connect_hub', () => connectHub(page, entityId, signerId, hubId));
    // Start collection window after reset/bootstrap to avoid cross-test bleed.
    scenarioStartedAt = Date.now();
    await markE2EPhase(page, 'rebalance.connected_hub', {
      phase: 'setup',
      entityId,
      details: { hubId },
    });

    // 6x faucet => cross soft limit ($500) deterministically without adding
    // post-request debt that can make final collateral assertions flaky.
    await timedStep('rebalance.faucet_burst_6x', async () => {
      for (let i = 0; i < 6; i++) {
        await faucet(page, entityId, hubId);
        await page.waitForTimeout(300);
      }
    });
    await markE2EPhase(page, 'rebalance.faucet_burst_6x_done', {
      phase: 'trigger',
      entityId,
      details: { hubId, count: 6 },
    });

    // Wait until bilateral j-event finalized and account becomes secured.
    const start = Date.now();
    let snapshot: any = null;
    const stateTimeline: any[] = [];
    await timedStep('rebalance.wait_first_secured_cycle', async () => {
      while (Date.now() - start < 180_000) {
        snapshot = await readRebalanceState(page, hubId);
        if (snapshot) {
          stateTimeline.push({
            atMs: Date.now() - start,
            requested: snapshot.requested,
            uncollateralized: snapshot.uncollateralized,
            collateral: snapshot.collateral,
            hubDebt: snapshot.hubDebt,
            jHeight: snapshot.lastFinalizedJHeight,
            frame: snapshot.currentHeight,
          });
        }
        if (
          snapshot &&
          BigInt(snapshot.requested) === 0n &&
          BigInt(snapshot.uncollateralized) === 0n &&
          BigInt(snapshot.collateral) > 0n &&
          snapshot.lastFinalizedJHeight > 0
        ) {
          await markE2EPhase(page, 'rebalance.first_secured_cycle_observed', {
            phase: 'assert-ready',
            entityId,
            details: {
              hubId,
              requested: snapshot.requested,
              uncollateralized: snapshot.uncollateralized,
              collateral: snapshot.collateral,
              jHeight: snapshot.lastFinalizedJHeight,
              frame: snapshot.currentHeight,
            },
          });
          break;
        }
        await page.waitForTimeout(700);
      }
    });

    const diagnostics = await readRebalanceDiagnostics(page, hubId);
    const rebalanceSteps = await readRebalanceStepEvents(page, scenarioStartedAt);
    const { phaseMarkers, debugErrors, frameEvents } = await collectRebalanceDebugArtifacts(page, scenarioStartedAt, hubId);
    const debugDump = buildRebalanceFailureDump({
      entityId,
      hubId,
      snapshot,
      diagnostics,
      rebalanceSteps,
      stateTimeline,
      rebalanceConsole,
      phaseMarkers,
      debugErrors,
      frameEvents,
    });
    const userIdLower = entityId.toLowerCase();
    const hubIdLower = hubId.toLowerCase();
    const indexOfStep = (event: string, predicate?: (step: any) => boolean): number =>
      rebalanceSteps.findIndex((step) => step?.event === event && (!predicate || predicate(step)));

    expect(snapshot, 'account snapshot must exist').toBeTruthy();
    const step1Idx = indexOfStep('request_collateral_committed');
    const step4UserIdx = indexOfStep('j_event_claim_queued', (s) => String(s.entityId || '').toLowerCase() === userIdLower);
    const step4HubIdx = indexOfStep('j_event_claim_queued', (s) => String(s.entityId || '').toLowerCase() === hubIdLower); // optional on local runtime
    const step5Idx = indexOfStep('account_settled_finalized_bilateral');

    expect(step1Idx >= 0, `step1 missing: request_collateral_committed\n${debugDump}`).toBe(true);
    expect(step4UserIdx >= 0, `step4 missing: user j_event_claim_queued\n${debugDump}`).toBe(true);
    // Hub-side claim is observed only when that runtime's debug stream is available locally.
    // Keep as diagnostic, but do not fail on absence.
    expect(step5Idx >= 0, `step5 missing: account_settled_finalized_bilateral\n${debugDump}`).toBe(true);
    expect(step4UserIdx > step1Idx, `invalid order: user claim must be after request commit\n${debugDump}`).toBe(true);
    expect(step5Idx > step4UserIdx, `invalid order: finalize must be after user claim\n${debugDump}`).toBe(true);

    const blockedForUser = rebalanceSteps.filter((s) => {
      const event = String(s?.event || '');
      const cp = String(s?.counterpartyId || '').toLowerCase();
      return (
        cp === userIdLower &&
        (event === 'policy_mismatch_manual' ||
          event === 'prepaid_fee_too_low_manual' ||
          event === 'hub_reserve_zero')
      );
    });
    expect(blockedForUser.length, `unexpected step2 blocked state for user\n${debugDump}`).toBe(0);

    expect(BigInt(snapshot.requested), `request_collateral must be cleared\n${debugDump}`).toBe(0n);
    expect(BigInt(snapshot.uncollateralized), `uncollateralized debt must be zero\n${debugDump}`).toBe(0n);
    expect(BigInt(snapshot.collateral), `collateral must be positive\n${debugDump}`).toBeGreaterThan(0n);
    expect(BigInt(snapshot.hubDebt) <= BigInt(snapshot.collateral), `hubDebt must be fully collateralized\n${debugDump}`).toBe(true);
    expect(snapshot.lastFinalizedJHeight, `jHeight must finalize (>0)\n${debugDump}`).toBeGreaterThan(0);

    // UI assertion + final screenshot artifact
    const readyIndicator = page.locator('.account-preview .status-pill.ready').first();
    await timedStep('rebalance.wait_ready_indicator', async () => {
      await expect(readyIndicator).toBeVisible({ timeout: 30_000 });
    });

    const accountCard = page.locator('.account-preview').first();
    await expect(accountCard).toBeVisible();
    await accountCard.screenshot({ path: 'test-results/rebalance-green-final.png' });
    await page.screenshot({ path: 'test-results/rebalance-green-fullpage.png', fullPage: true });

    if (FAST_E2E && !LONG_E2E) {
      console.log('[E2E] FAST mode: first secured cycle verified, skipping long stress phases.');
      return;
    }

    // Regression guard + stronger invariant:
    // after first successful collateralization, faucet must still work and must
    // be able to trigger a second independent collateralization cycle.
    const claimSnapshotBeforeSecondCycle = await readAccountJEventClaims(page, hubId);
    const uniqueSettleKeysBefore = new Set(
      (claimSnapshotBeforeSecondCycle?.claims || []).map((c) => `${c.txHash}:${c.nonce}:${c.jHeight}`),
    );
    const currentHeightBefore = Number(snapshot.currentHeight || 0);

    // Push debt enough to cross soft-limit again after first finalize.
    await timedStep('rebalance.second_faucet_burst_8x', async () => {
      for (let i = 0; i < 8; i++) {
        await faucet(page, entityId, hubId);
        await page.waitForTimeout(150);
      }
    });
    await markE2EPhase(page, 'rebalance.second_burst_8x_done', {
      phase: 'second-cycle-trigger',
      entityId,
      details: { hubId, count: 8 },
    });

    let postSnapshot: any = null;
    const postStart = Date.now();
    await timedStep('rebalance.wait_second_secured_cycle', async () => {
      while (Date.now() - postStart < 120_000) {
        postSnapshot = await readRebalanceState(page, hubId);
        const claimSnapshotNow = await readAccountJEventClaims(page, hubId);
        const uniqueSettleKeysNow = new Set(
          (claimSnapshotNow?.claims || []).map((c) => `${c.txHash}:${c.nonce}:${c.jHeight}`),
        );
        const hasSecondSettlement = uniqueSettleKeysNow.size >= uniqueSettleKeysBefore.size + 1;
        if (
          postSnapshot &&
          Number(postSnapshot.currentHeight || 0) > currentHeightBefore &&
          BigInt(postSnapshot.requested || '0') === 0n &&
          BigInt(postSnapshot.uncollateralized || '0') === 0n &&
          hasSecondSettlement
        ) {
          await markE2EPhase(page, 'rebalance.second_secured_cycle_observed', {
            phase: 'second-cycle-ready',
            entityId,
            details: {
              hubId,
              requested: postSnapshot.requested,
              uncollateralized: postSnapshot.uncollateralized,
              collateral: postSnapshot.collateral,
              frame: postSnapshot.currentHeight,
              jHeight: postSnapshot.lastFinalizedJHeight,
            },
          });
          break;
        }
        await page.waitForTimeout(400);
      }
    });
    expect(postSnapshot, `post-secured faucet snapshot missing\n${debugDump}`).toBeTruthy();
    expect(
      Number(postSnapshot.currentHeight || 0) > currentHeightBefore,
      `post-secured faucet did not advance account consensus height\n${buildRebalanceFailureDump({
        entityId,
        hubId,
        snapshot: postSnapshot,
        diagnostics,
        rebalanceSteps,
        stateTimeline: [...stateTimeline, { atMs: 'post-faucet-2nd-cycle', ...postSnapshot }],
        rebalanceConsole: [...rebalanceConsole, ...criticalConsole],
        phaseMarkers,
        debugErrors,
        frameEvents,
      })}`,
    ).toBe(true);
    expect(
      criticalConsole.length,
      `critical consensus/runtime errors after post-secured faucet:\n${criticalConsole.join('\n')}`,
    ).toBe(0);

    // Strong invariant: each on-chain AccountSettled tx should appear as exactly 2 bilateral j_event_claims.
    // Multiple faucet clicks may coalesce into a single settlement while one request is pending.
    let claimSnapshot = await readAccountJEventClaims(page, hubId);
    let claimCounts = new Map<string, number>();
    const bilateralClaimDeadline = Date.now() + 60_000;
    while (Date.now() < bilateralClaimDeadline) {
      claimSnapshot = await readAccountJEventClaims(page, hubId);
      claimCounts = new Map<string, number>();
      for (const c of claimSnapshot?.claims || []) {
        const key = `${c.txHash}:${c.nonce}:${c.jHeight}`;
        claimCounts.set(key, (claimCounts.get(key) || 0) + 1);
      }
      const hasNewSettlement = claimCounts.size >= uniqueSettleKeysBefore.size + 1;
      const allBilateral = [...claimCounts.values()].every((n) => n === 2);
      if (hasNewSettlement && allBilateral) break;
      await page.waitForTimeout(500);
    }

    const claimArtifacts = await collectRebalanceDebugArtifacts(page, scenarioStartedAt, hubId);
    const finalRebalanceSteps = await readRebalanceStepEvents(page, scenarioStartedAt);
    const claimDebugDump = buildRebalanceFailureDump({
      entityId,
      hubId,
      snapshot: postSnapshot,
      diagnostics,
      rebalanceSteps: finalRebalanceSteps,
      stateTimeline: [...stateTimeline, { atMs: 'post-faucet-2nd-cycle', ...postSnapshot }],
      rebalanceConsole: [...rebalanceConsole, ...criticalConsole],
      phaseMarkers: claimArtifacts.phaseMarkers,
      debugErrors: claimArtifacts.debugErrors,
      frameEvents: claimArtifacts.frameEvents,
    });
    const userDeliveredCount = countRebalanceStepEvents(
      finalRebalanceSteps,
      'j_event_delivered',
      (step) => String(step.entityId || '').toLowerCase() === userIdLower,
    );
    const hubDeliveredCount = countRebalanceStepEvents(
      finalRebalanceSteps,
      'j_event_delivered',
      (step) => String(step.entityId || '').toLowerCase() === hubIdLower,
    );
    const userClaimQueuedCount = countRebalanceStepEvents(
      finalRebalanceSteps,
      'j_event_claim_queued',
      (step) => String(step.entityId || '').toLowerCase() === userIdLower,
    );
    const hubClaimQueuedCount = countRebalanceStepEvents(
      finalRebalanceSteps,
      'j_event_claim_queued',
      (step) => String(step.entityId || '').toLowerCase() === hubIdLower,
    );

    expect(claimSnapshot, `claim snapshot must exist\n${claimDebugDump}`).toBeTruthy();
    expect(userDeliveredCount >= 2, `user runtime must receive both AccountSettled j-events across two cycles\n${claimDebugDump}`).toBe(true);
    expect(hubDeliveredCount >= 2, `hub runtime must receive both AccountSettled j-events across two cycles\n${claimDebugDump}`).toBe(true);
    expect(userClaimQueuedCount >= 2, `user runtime must queue bilateral j_event_claim in both cycles\n${claimDebugDump}`).toBe(true);
    expect(hubClaimQueuedCount >= 2, `hub runtime must queue bilateral j_event_claim in both cycles\n${claimDebugDump}`).toBe(true);
    for (const c of claimSnapshot?.claims || []) {
      const hasLocal = c.leftEntity === userIdLower || c.rightEntity === userIdLower;
      const hasHub = c.leftEntity === hubIdLower || c.rightEntity === hubIdLower;
      expect(hasLocal && hasHub, `misattributed AccountSettled claim pair: ${JSON.stringify(c)}\n${claimDebugDump}`).toBe(true);
    }
    expect(claimCounts.size >= uniqueSettleKeysBefore.size + 1, `must have a new AccountSettled tx after second cycle\n${claimDebugDump}`).toBe(true);
    expect(
      [...claimCounts.values()].every((n) => n === 2),
      `each AccountSettled must be claimed exactly twice (bilateral): ${JSON.stringify(Object.fromEntries(claimCounts), null, 2)}\n${claimDebugDump}`,
    ).toBe(true);
  });

  // Scenario: once an account is secured, a reload must restore the same state and the watcher must
  // still drive the next rebalance cycle without manual repair.
  test('persistence: secured rebalance survives reload and watcher resumes', async ({ page }) => {
    test.skip(FAST_E2E && !LONG_E2E, 'Reload persistence coverage disabled in fast mode.');
    let scenarioStartedAt = 0;
    const rebalanceConsole: string[] = [];
    const criticalConsole: string[] = [];
    page.on('console', (msg) => {
      const text = msg.text();
      if (/AUTO-REBALANCE|Auto-rebalance|request_collateral|counterparty-not-hub|missing-hub-fee-policy/.test(text)) {
        rebalanceConsole.push(text);
      }
      if (/FRAME_CONSENSUS_FAILED|Frame hash verification failed|Runtime loop error|RUNTIME_LOOP_HALTED/.test(text)) {
        criticalConsole.push(text);
      }
    });

    await timedStep('rebalance_persist.reset_server', () => resetProdServer(page));
    await page.addInitScript(() => {
      try {
        localStorage.setItem('xln-app-mode', 'user');
        localStorage.setItem('xln-onboarding-complete', 'true');
      } catch {
        // no-op
      }
    });
    await timedStep('rebalance_persist.goto_app', () => gotoApp(page));
    await timedStep('rebalance_persist.create_runtime', () => createRuntime(page, `rebalance-persist-${Date.now()}`, randomMnemonic()));
    await timedStep('rebalance_persist.ensure_runtime_online', () => ensureRuntimeOnline(page, 'rebalance-persist-post-create'));

    const { entityId, signerId } = await timedStep('rebalance_persist.get_local_entity', () => getLocalEntity(page));
    const hubId = await timedStep('rebalance_persist.discover_hub', () => discoverHub(page));
    await timedStep('rebalance_persist.wait_hub_profile', () => waitForHubProfile(page, hubId));
    await timedStep('rebalance_persist.connect_hub', () => connectHub(page, entityId, signerId, hubId));
    scenarioStartedAt = Date.now();

    await timedStep('rebalance_persist.first_faucet_burst_6x', async () => {
      for (let i = 0; i < 6; i += 1) {
        await faucet(page, entityId, hubId);
        await page.waitForTimeout(120);
      }
    });

    let firstSnapshot: any = null;
    const firstStateTimeline: Array<Record<string, unknown>> = [];
    const firstWaitStartedAt = Date.now();
    await timedStep('rebalance_persist.wait_first_secured_cycle', async () => {
      while (Date.now() - firstWaitStartedAt < 90_000) {
        firstSnapshot = await readRebalanceState(page, hubId);
        if (firstSnapshot) {
          firstStateTimeline.push({
            atMs: Date.now() - firstWaitStartedAt,
            requested: firstSnapshot.requested,
            uncollateralized: firstSnapshot.uncollateralized,
            collateral: firstSnapshot.collateral,
            jHeight: firstSnapshot.lastFinalizedJHeight,
            frame: firstSnapshot.currentHeight,
          });
        }
        if (
          firstSnapshot &&
          BigInt(firstSnapshot.requested || '0') === 0n &&
          BigInt(firstSnapshot.uncollateralized || '0') === 0n &&
          BigInt(firstSnapshot.collateral || '0') > 0n &&
          Number(firstSnapshot.lastFinalizedJHeight || 0) > 0
        ) {
          break;
        }
        await page.waitForTimeout(500);
      }
    });

    const initialDiagnostics = await readRebalanceDiagnostics(page, hubId);
    const initialSteps = await readRebalanceStepEvents(page, scenarioStartedAt);
    const initialArtifacts = await collectRebalanceDebugArtifacts(page, scenarioStartedAt, hubId);
    const initialDebugDump = buildRebalanceFailureDump({
      entityId,
      hubId,
      snapshot: firstSnapshot,
      diagnostics: initialDiagnostics,
      rebalanceSteps: initialSteps,
      stateTimeline: firstStateTimeline,
      rebalanceConsole: [...rebalanceConsole, ...criticalConsole],
      phaseMarkers: initialArtifacts.phaseMarkers,
      debugErrors: initialArtifacts.debugErrors,
      frameEvents: initialArtifacts.frameEvents,
    });

    expect(firstSnapshot, `first secured snapshot missing\n${initialDebugDump}`).toBeTruthy();
    expect(BigInt(firstSnapshot.requested || '0'), `requested must clear before reload\n${initialDebugDump}`).toBe(0n);
    expect(BigInt(firstSnapshot.uncollateralized || '0'), `uncollateralized must clear before reload\n${initialDebugDump}`).toBe(0n);
    expect(BigInt(firstSnapshot.collateral || '0'), `collateral must be positive before reload\n${initialDebugDump}`).toBeGreaterThan(0n);
    expect(Number(firstSnapshot.lastFinalizedJHeight || 0), `jHeight must finalize before reload\n${initialDebugDump}`).toBeGreaterThan(0);

    const settledBeforeReload = {
      requested: BigInt(firstSnapshot.requested || '0'),
      uncollateralized: BigInt(firstSnapshot.uncollateralized || '0'),
      collateral: BigInt(firstSnapshot.collateral || '0'),
      jHeight: Number(firstSnapshot.lastFinalizedJHeight || 0),
    };
    const claimSnapshotBeforeReload = await readAccountJEventClaims(page, hubId);
    const uniqueSettleKeysBeforeReload = new Set(
      (claimSnapshotBeforeReload?.claims || []).map((claim) => `${claim.txHash}:${claim.nonce}:${claim.jHeight}`),
    );
    const currentHeightBeforeReload = Number(firstSnapshot.currentHeight || 0);

    await reloadRuntimeAndWaitReady(page, rebalanceConsole, 'rebalance_persist.reload_page');
    await timedStep('rebalance_persist.reload_assert_secured_state', async () => {
      await expect.poll(async () => {
        const reloaded = await readRebalanceState(page, hubId);
        return {
          requested: BigInt(reloaded?.requested || '0'),
          uncollateralized: BigInt(reloaded?.uncollateralized || '0'),
          collateral: BigInt(reloaded?.collateral || '0'),
          jHeight: Number(reloaded?.lastFinalizedJHeight || 0),
        };
      }, { timeout: 60_000, intervals: [500, 1000, 2000] }).toEqual(settledBeforeReload);
    });

    await timedStep('rebalance_persist.second_faucet_burst_8x', async () => {
      for (let i = 0; i < 8; i += 1) {
        await faucet(page, entityId, hubId);
        await page.waitForTimeout(120);
      }
    });

    let postReloadSnapshot: any = null;
    const secondWaitStartedAt = Date.now();
    await timedStep('rebalance_persist.wait_second_secured_cycle', async () => {
      while (Date.now() - secondWaitStartedAt < 120_000) {
        postReloadSnapshot = await readRebalanceState(page, hubId);
        const claimSnapshotNow = await readAccountJEventClaims(page, hubId);
        const uniqueSettleKeysNow = new Set(
          (claimSnapshotNow?.claims || []).map((claim) => `${claim.txHash}:${claim.nonce}:${claim.jHeight}`),
        );
        const hasSecondSettlement = uniqueSettleKeysNow.size >= uniqueSettleKeysBeforeReload.size + 1;
        if (
          postReloadSnapshot &&
          Number(postReloadSnapshot.currentHeight || 0) > currentHeightBeforeReload &&
          Number(postReloadSnapshot.lastFinalizedJHeight || 0) > settledBeforeReload.jHeight &&
          BigInt(postReloadSnapshot.requested || '0') === 0n &&
          BigInt(postReloadSnapshot.uncollateralized || '0') === 0n &&
          hasSecondSettlement
        ) {
          break;
        }
        await page.waitForTimeout(500);
      }
    });

    const finalDiagnostics = await readRebalanceDiagnostics(page, hubId);
    const finalSteps = await readRebalanceStepEvents(page, scenarioStartedAt);
    const finalArtifacts = await collectRebalanceDebugArtifacts(page, scenarioStartedAt, hubId);
    const finalDebugDump = buildRebalanceFailureDump({
      entityId,
      hubId,
      snapshot: postReloadSnapshot,
      diagnostics: finalDiagnostics,
      rebalanceSteps: finalSteps,
      stateTimeline: firstStateTimeline,
      rebalanceConsole: [...rebalanceConsole, ...criticalConsole],
      phaseMarkers: finalArtifacts.phaseMarkers,
      debugErrors: finalArtifacts.debugErrors,
      frameEvents: finalArtifacts.frameEvents,
    });
    const userIdLower = entityId.toLowerCase();
    const hubIdLower = hubId.toLowerCase();
    const userDeliveredCount = countRebalanceStepEvents(
      finalSteps,
      'j_event_delivered',
      (step) => String(step.entityId || '').toLowerCase() === userIdLower,
    );
    const hubDeliveredCount = countRebalanceStepEvents(
      finalSteps,
      'j_event_delivered',
      (step) => String(step.entityId || '').toLowerCase() === hubIdLower,
    );
    const userClaimQueuedCount = countRebalanceStepEvents(
      finalSteps,
      'j_event_claim_queued',
      (step) => String(step.entityId || '').toLowerCase() === userIdLower,
    );
    const hubClaimQueuedCount = countRebalanceStepEvents(
      finalSteps,
      'j_event_claim_queued',
      (step) => String(step.entityId || '').toLowerCase() === hubIdLower,
    );
    const claimSnapshotAfterReload = await readAccountJEventClaims(page, hubId);
    const uniqueSettleKeysAfterReload = new Set(
      (claimSnapshotAfterReload?.claims || []).map((claim) => `${claim.txHash}:${claim.nonce}:${claim.jHeight}`),
    );

    expect(postReloadSnapshot, `post-reload secured snapshot missing\n${finalDebugDump}`).toBeTruthy();
    expect(Number(postReloadSnapshot.currentHeight || 0) > currentHeightBeforeReload, `account frame height must advance after reload second cycle\n${finalDebugDump}`).toBe(true);
    expect(Number(postReloadSnapshot.lastFinalizedJHeight || 0) > settledBeforeReload.jHeight, `jHeight must advance after reload second cycle\n${finalDebugDump}`).toBe(true);
    expect(BigInt(postReloadSnapshot.requested || '0'), `requested must clear after reload second cycle\n${finalDebugDump}`).toBe(0n);
    expect(BigInt(postReloadSnapshot.uncollateralized || '0'), `uncollateralized must clear after reload second cycle\n${finalDebugDump}`).toBe(0n);
    expect(userDeliveredCount >= 2, `user runtime must receive AccountSettled before and after reload\n${finalDebugDump}`).toBe(true);
    expect(hubDeliveredCount >= 2, `hub runtime must receive AccountSettled before and after reload\n${finalDebugDump}`).toBe(true);
    expect(userClaimQueuedCount >= 2, `user runtime must queue bilateral j_event_claim before and after reload\n${finalDebugDump}`).toBe(true);
    expect(hubClaimQueuedCount >= 2, `hub runtime must queue bilateral j_event_claim before and after reload\n${finalDebugDump}`).toBe(true);
    expect(uniqueSettleKeysAfterReload.size >= uniqueSettleKeysBeforeReload.size + 1, `must have a new settlement after reload second cycle\n${finalDebugDump}`).toBe(true);
    expect(criticalConsole.length, `critical consensus/runtime errors during reload persistence flow:\n${criticalConsole.join('\n')}`).toBe(0);
  });

  // Scenario: while one request_collateral is still pending, extra debt must not commit a duplicate
  // request before the first settlement finalize arrives.
  test('edge: pending request_collateral must not duplicate before first settlement finalize', async ({ page }) => {
    test.skip(FAST_E2E && !LONG_E2E, 'Long rebalance edge coverage disabled in fast mode.');
    let scenarioStartedAt = 0;
    await timedStep('rebalance_edge.reset_server', () => resetProdServer(page));
    await page.addInitScript(() => {
      try {
        localStorage.setItem('xln-app-mode', 'user');
        localStorage.setItem('xln-onboarding-complete', 'true');
      } catch {
        // no-op
      }
    });
    await timedStep('rebalance_edge.goto_app', () => gotoApp(page));
    await timedStep('rebalance_edge.create_runtime', () => createRuntime(page, `rebalance-edge-pending-${Date.now()}`, randomMnemonic()));
    await timedStep('rebalance_edge.ensure_runtime_online', () => ensureRuntimeOnline(page, 'edge-pending-post-create'));

    const { entityId, signerId } = await timedStep('rebalance_edge.get_local_entity', () => getLocalEntity(page));
    const hubId = await timedStep('rebalance_edge.discover_hub', () => discoverHub(page));
    const hubIsLeft = hubId.toLowerCase() < entityId.toLowerCase();
    await timedStep('rebalance_edge.wait_hub_profile', () => waitForHubProfile(page, hubId));
    await timedStep('rebalance_edge.connect_hub', () => connectHub(page, entityId, signerId, hubId));
    // Start collection window after reset/bootstrap to avoid cross-test bleed.
    scenarioStartedAt = Date.now();
    await markE2EPhase(page, 'rebalance_edge.connected_hub', {
      phase: 'setup',
      entityId,
      details: { hubId },
    });

    // Trigger first request.
    for (let i = 0; i < 6; i++) {
      await faucet(page, entityId, hubId);
      await page.waitForTimeout(120);
    }
    await markE2EPhase(page, 'rebalance_edge.first_burst_done', {
      phase: 'trigger',
      entityId,
      details: { hubId, count: 6 },
    });
    const lowerHub = hubId.toLowerCase();
    const firstPendingStart = Date.now();
    let pendingSeen = false;
    let pendingSnapshot: any = null;
    let firstRequestCommit: any = null;
    while (Date.now() - firstPendingStart < 45_000) {
      const [s, rebalanceSteps] = await Promise.all([
        readRebalanceState(page, hubId),
        readRebalanceStepEvents(page, scenarioStartedAt),
      ]);
      if (!pendingSeen && s && BigInt(s.requested || '0') > 0n) {
        pendingSeen = true;
        pendingSnapshot = s;
        await markE2EPhase(page, 'rebalance_edge.pending_request_seen', {
          phase: 'trigger-confirmed',
          entityId,
          details: {
            hubId,
            requested: s.requested,
            uncollateralized: s.uncollateralized,
            collateral: s.collateral,
            frame: s.currentHeight,
            jHeight: s.lastFinalizedJHeight,
          },
        });
      }

      firstRequestCommit = rebalanceSteps.find((step) =>
        String(step?.event || '') === 'request_collateral_committed'
        && String(step?.accountId || '').toLowerCase() === lowerHub,
      );
      if (firstRequestCommit) {
        await markE2EPhase(page, 'rebalance_edge.request_committed', {
          phase: 'trigger-confirmed',
          entityId,
          details: {
            hubId,
            requestedAt: firstRequestCommit.requestedAt,
            tokenId: firstRequestCommit.tokenId,
            pendingSeen,
          },
        });
        break;
      }

      await page.waitForTimeout(150);
    }
    if (!firstRequestCommit) {
      const pendingDiagnostics = await readRebalanceDiagnostics(page, hubId);
      const pendingSteps = await readRebalanceStepEvents(page, scenarioStartedAt);
      const { phaseMarkers, debugErrors, frameEvents } = await collectRebalanceDebugArtifacts(page, scenarioStartedAt, hubId);
      expect(
        firstRequestCommit,
        `expected request_collateral_committed before first finalize\n${buildRebalanceFailureDump({
          entityId,
          hubId,
          snapshot: pendingSnapshot,
          diagnostics: pendingDiagnostics,
          rebalanceSteps: pendingSteps,
          stateTimeline: pendingSnapshot ? [{ atMs: Date.now() - firstPendingStart, ...pendingSnapshot }] : [],
          rebalanceConsole: [],
          phaseMarkers,
          debugErrors,
          frameEvents,
        })}`,
      ).toBeTruthy();
    }
    expect(firstRequestCommit, 'expected request_collateral_committed before first finalize').toBeTruthy();

    // While pending, add more debt; this must NOT create a second request commit before first finalize.
    for (let i = 0; i < 3; i++) {
      await faucet(page, entityId, hubId);
      await page.waitForTimeout(100);
    }
    await markE2EPhase(page, 'rebalance_edge.second_burst_while_pending_done', {
      phase: 'duplicate-guard',
      entityId,
      details: { hubId, count: 3 },
    });
    await page.waitForTimeout(1500);

    const diagnostics = await readRebalanceDiagnostics(page, hubId);
    const steps = await readRebalanceStepEvents(page, scenarioStartedAt);
    const { phaseMarkers, debugErrors, frameEvents } = await collectRebalanceDebugArtifacts(page, scenarioStartedAt, hubId);
    const firstFinalizeIdx = steps.findIndex((s) =>
      String(s?.event || '') === 'account_settled_finalized_bilateral'
      && String(s?.accountId || '').toLowerCase() === lowerHub,
    );
    const beforeFirstFinalize = firstFinalizeIdx >= 0 ? steps.slice(0, firstFinalizeIdx + 1) : steps;
    const reqCommits = beforeFirstFinalize.filter((s) =>
      String(s?.event || '') === 'request_collateral_committed'
      && String(s?.accountId || '').toLowerCase() === lowerHub,
    );
    const reqUnique = new Set(
      reqCommits.map((s) => `${String(s?.accountId || '').toLowerCase()}:${String(s?.tokenId || '')}:${String(s?.requestedAt || '')}`),
    );
    const debugDump = buildRebalanceFailureDump({
      entityId,
      hubId,
      snapshot: pendingSnapshot,
      diagnostics,
      rebalanceSteps: steps,
      stateTimeline: pendingSnapshot ? [{ atMs: 'pending-request', ...pendingSnapshot }] : [],
      rebalanceConsole: [],
      phaseMarkers,
      debugErrors,
      frameEvents,
    });
    expect(
      reqUnique.size,
      `request_collateral unique-commit duplicated before first finalize: ${JSON.stringify(reqCommits, null, 2)}\n${debugDump}`,
    ).toBe(1);
  });

  // Scenario: force a full R2C -> C2R -> R2C loop and verify the account transitions through each
  // collateral phase without breaking cadence or losing finalization signal.
  test('cycle R2C -> C2R -> R2C (100ms action cadence)', async ({ page }) => {
    test.skip(FAST_E2E && !LONG_E2E, 'Long rebalance edge coverage disabled in fast mode.');
    let scenarioStartedAt = 0;
    await timedStep('rebalance_cycle.reset_server', () => resetProdServer(page));
    await page.addInitScript(() => {
      try {
        localStorage.setItem('xln-app-mode', 'user');
        localStorage.setItem('xln-onboarding-complete', 'true');
      } catch {
        // no-op
      }
    });
    await timedStep('rebalance_cycle.goto_app', () => gotoApp(page));
    await timedStep('rebalance_cycle.create_runtime', () => createRuntime(page, `rebalance-cycle-${Date.now()}`, randomMnemonic()));
    await timedStep('rebalance_cycle.ensure_runtime_online', () => ensureRuntimeOnline(page, 'cycle-post-create'));

    const { entityId, signerId } = await timedStep('rebalance_cycle.get_local_entity', () => getLocalEntity(page));
    const hubId = await timedStep('rebalance_cycle.discover_hub', () => discoverHub(page));
    const hubIsLeft = hubId.toLowerCase() < entityId.toLowerCase();
    await timedStep('rebalance_cycle.wait_hub_profile', () => waitForHubProfile(page, hubId));
    await timedStep('rebalance_cycle.connect_hub', () => connectHub(page, entityId, signerId, hubId));
    // Start collection window after reset/bootstrap to avoid cross-test bleed.
    scenarioStartedAt = Date.now();

    // Keep cycle test focused on rebalance transitions only.
    // HTLC E2E is validated by dedicated routed-payment coverage below.
    const baselineFlow = await readAccountFlowState(page, hubId);
    expect(baselineFlow, 'baseline account flow state must exist').toBeTruthy();

    const waitForState = async (
      predicate: (snapshot: any) => boolean,
      timeoutMs: number,
      label: string,
    ) => {
      const start = Date.now();
      let last: any = null;
      while (Date.now() - start < timeoutMs) {
        last = await readRebalanceState(page, hubId);
        if (last && predicate(last)) return last;
        await page.waitForTimeout(700);
      }
      throw new Error(`${label} timeout; last=${JSON.stringify(last, null, 2)}`);
    };

    // Phase 1: R2C (hub owes user, user auto-requests collateral)
    for (let i = 0; i < 10; i++) {
      await faucet(page, entityId, hubId);
      await page.waitForTimeout(100);
    }
    const r2cSnapshot1 = await waitForState(
      (s) =>
        BigInt(s.requested) === 0n &&
        BigInt(s.collateral) > 500n * 10n ** 18n &&
        Number(s.lastFinalizedJHeight || 0) > 0,
      180_000,
      'phase1-r2c',
    );
    const collateralAfterFirstR2C = BigInt(r2cSnapshot1.collateral);
    const c2rSoftLimitWei = 500n * 10n ** 18n;

    // Phase 2: C2R (user repays enough so collateral becomes excess and hub withdraws to reserve)
    const hubOwesUser = (snapshot: any): bigint => {
      const d = BigInt(snapshot?.totalDelta || '0');
      return hubIsLeft ? (d < 0n ? -d : 0n) : (d > 0n ? d : 0n);
    };
    if (!hubIsLeft) {
      // When hub is on the right side, paying hub can free right-side outCollateral for C2R.
      const c2rDebtTarget = 1n * 10n ** 18n; // ~1 USD residual tolerance
      for (let i = 0; i < 25; i++) {
        const before = await readRebalanceState(page, hubId);
        const debtWei = before ? hubOwesUser(before) : 0n;
        if (debtWei <= c2rDebtTarget) break;
        const paymentUsd = debtWei / 10n ** 18n;
        const payAmount = paymentUsd > 0n && paymentUsd < 100n ? paymentUsd : 100n;
        await sendDirectPaymentToHub(page, entityId, signerId, hubId, payAmount);
        await page.waitForTimeout(100);
        if (before) {
          await waitForState(
            (s) => Number(s.currentHeight || 0) > Number(before.currentHeight || 0),
            25_000,
            `phase2-payment-commit-${i + 1}`,
          );
        }
        const after = await readRebalanceState(page, hubId);
        if (after && hubOwesUser(after) <= c2rDebtTarget) {
          break;
        }
      }
    }

    // Hold-aware C2R: hub must not withdraw ring-fenced collateral.
    // Wait until outbound holds clear (or become negligible) before expecting collateral pullback.
    await waitForState(
      (s) => BigInt(s.outTotalHold || '0') <= 1n * 10n ** 18n,
      120_000,
      'phase2-hold-clear',
    );
    const preC2RSnapshot = await readRebalanceState(page, hubId);
    expect(preC2RSnapshot, 'phase2 pre-C2R snapshot must exist').toBeTruthy();
    const hubFreeOutBeforeC2R = BigInt(preC2RSnapshot?.hubFreeOutCollateral || '0');
    const c2rShouldTrigger = hubFreeOutBeforeC2R > c2rSoftLimitWei;

    let c2rSnapshot: any;
    if (c2rShouldTrigger) {
      c2rSnapshot = await waitForState(
        (s) =>
          BigInt(s.hubFreeOutCollateral || '0') < hubFreeOutBeforeC2R &&
          Number(s.lastFinalizedJHeight || 0) >= Number(r2cSnapshot1.lastFinalizedJHeight || 0),
        220_000,
        'phase2-c2r',
      );
    } else {
      await page.waitForTimeout(4_000);
      c2rSnapshot = await readRebalanceState(page, hubId);
    }
    expect(c2rSnapshot, 'phase2 snapshot must exist').toBeTruthy();
    const collateralAfterC2R = BigInt(c2rSnapshot?.collateral || '0');
    const hubFreeOutAfterC2R = BigInt(c2rSnapshot?.hubFreeOutCollateral || '0');
    if (c2rShouldTrigger) {
      expect(
        hubFreeOutAfterC2R < hubFreeOutBeforeC2R,
        `expected C2R to decrease hub freeOutCollateral (${hubFreeOutBeforeC2R} -> ${hubFreeOutAfterC2R})`,
      ).toBe(true);
    } else {
      expect(
        hubFreeOutAfterC2R <= c2rSoftLimitWei,
        `C2R must not trigger when hub freeOutCollateral <= soft limit (freeOut=${hubFreeOutAfterC2R}, soft=${c2rSoftLimitWei})`,
      ).toBe(true);
    }

    // Phase 3: R2C again (hub owes user again and tops collateral back up)
    for (let i = 0; i < 24; i++) {
      await faucet(page, entityId, hubId);
      await page.waitForTimeout(100);
    }
    const r2cSnapshot2 = await waitForState(
      (s) =>
        BigInt(s.requested) === 0n &&
        Number(s.lastFinalizedJHeight || 0) > Number(c2rSnapshot?.lastFinalizedJHeight || r2cSnapshot1.lastFinalizedJHeight || 0),
      180_000,
      'phase3-r2c-again',
    );

    const steps = await readRebalanceStepEvents(page, scenarioStartedAt);
    const c2rPropose = steps.some((s) => s?.event === 'c2r_settle_propose_queued');
    const c2rExecute = steps.some((s) => s?.event === 'c2r_settle_execute_queued');
    const finalizedCount = steps.filter((s) => s?.event === 'account_settled_finalized_bilateral').length;
    if (c2rShouldTrigger) {
      expect(
        c2rPropose || c2rExecute || hubFreeOutAfterC2R < hubFreeOutBeforeC2R,
        `c2r evidence missing (events + hub freeOutCollateral delta)`,
      ).toBe(true);
    }
    expect(finalizedCount >= 2, `expected >=2 account_settled_finalized_bilateral, got ${finalizedCount}`).toBe(true);

    await page.screenshot({ path: 'test-results/rebalance-cycle-r2c-c2r-r2c.png', fullPage: true });

    if (c2rShouldTrigger) {
      expect(BigInt(r2cSnapshot2.collateral) > collateralAfterC2R, 'second R2C should increase collateral').toBe(true);
    } else {
      expect(BigInt(r2cSnapshot2.collateral) >= collateralAfterFirstR2C, 'R2C must keep collateral non-decreasing').toBe(true);
    }
  });

  // Scenario: multi-hop routing through H1 and H2 should fail on the second 550 payment before H2
  // rebalances, then pass again after H2 completes R2C.
  test('rt1->h1->h2->rt2: second 550 fails before rebalance, passes after H2 R2C', async ({ page }) => {
    test.skip(FAST_E2E && !LONG_E2E, 'Long rebalance edge coverage disabled in fast mode.');
    let scenarioStartedAt = 0;
    await resetProdServer(page);
    await page.addInitScript(() => {
      try {
        localStorage.setItem('xln-app-mode', 'user');
        localStorage.setItem('xln-onboarding-complete', 'true');
      } catch {
        // no-op
      }
    });
    await gotoApp(page);

    const rt1Label = `rt1-h1h2-${Date.now()}`;
    const rt2Label = `rt2-h1h2-${Date.now() + 1}`;
    await createRuntime(page, rt1Label, randomMnemonic());
    await ensureRuntimeOnline(page, 'rt1-h1h2-online');
    const rt1 = await getLocalEntity(page);

    await createRuntime(page, rt2Label, randomMnemonic());
    await ensureRuntimeOnline(page, 'rt2-h1h2-online');
    const rt2 = await getLocalEntity(page);

    await switchRuntime(page, rt2Label);
    const { h1, h2 } = await discoverH1H2(page);
    await waitForHubProfile(page, h1);
    await waitForHubProfile(page, h2);

    // Recipient runtime: small credit on H2 so second 550 should fail pre-rebalance.
    await connectHubWithCredit(page, rt2.entityId, rt2.signerId, h2, 1_000n);
    await setRebalancePolicy(page, rt2.entityId, rt2.signerId, h2, 500n, 10_000n, 20n);
    await waitForPairIdle(page, h2);

    await switchRuntime(page, rt1Label);
    // Sender runtime: liquidity source through H1.
    await connectHubWithCredit(page, rt1.entityId, rt1.signerId, h1, 10_000n);
    const senderBeforeFaucet = await readPairState(page, h1);
    expect(senderBeforeFaucet, 'rt1-h1 pair must exist before faucet').toBeTruthy();
    const senderOutBaseline = BigInt(senderBeforeFaucet?.outCapacity || '0');
    await faucetAmount(page, rt1.entityId, h1, '2000');
    await waitForOutCapacityIncrease(page, h1, senderOutBaseline);
    await waitForPairIdle(page, h1);

    await switchRuntime(page, rt2Label);
    const baseline = await readPairState(page, h2);
    expect(baseline, 'rt2-h2 baseline must exist').toBeTruthy();
    const baselineDebt = BigInt(baseline?.hubExposure || baseline?.hubDebt || '0');
    const baselineResolveCount = Number(baseline?.recentHtlcResolveCount || 0);
    // Start collection window after reset/bootstrap to avoid cross-test bleed.
    scenarioStartedAt = Date.now();

    // Payment #1 succeeds.
    await switchRuntime(page, rt1Label);
    await waitForPairIdle(page, h1);
    const senderBeforeP1 = await readPairState(page, h1);
    const senderP1LockBaseline = Number(senderBeforeP1?.recentHtlcLockCount || 0);
    const p1 = await sendRoutedHtlcPayment(
      page,
      rt1.entityId,
      rt1.signerId,
      rt2.entityId,
      [rt1.entityId, h1, h2, rt2.entityId],
      550n,
      'rt1->rt2 via h1,h2 htlc #1',
    );
    await waitForSenderHtlcLock(page, h1, p1.hashlock, senderP1LockBaseline);

    await switchRuntime(page, rt2Label);
    const p1Start = Date.now();
    let afterP1: any = null;
    while (Date.now() - p1Start < 30_000) {
      afterP1 = await readPairState(page, h2);
      const debtIncreased = afterP1
        && BigInt(afterP1.hubExposure || afterP1.hubDebt || '0') >= baselineDebt + 500n * 10n ** 18n;
      const resolveSeen = Number(afterP1?.recentHtlcResolveCount || 0) > baselineResolveCount;
      if (debtIncreased && resolveSeen) break;
      await page.waitForTimeout(400);
    }
    expect(afterP1, 'rt2-h2 state after payment#1').toBeTruthy();
    expect(
      BigInt(afterP1?.hubExposure || afterP1?.hubDebt || '0') >= baselineDebt + 500n * 10n ** 18n,
      `payment#1 must increase H2 exposure by ~550 (baseline=${baselineDebt}, now=${afterP1?.hubExposure || afterP1?.hubDebt || 'n/a'})`,
    ).toBe(true);
    expect(
      Number(afterP1?.recentHtlcResolveCount || 0) > baselineResolveCount,
      `payment#1 must be resolved (resolveCount baseline=${baselineResolveCount}, now=${afterP1?.recentHtlcResolveCount || 0})`,
    ).toBe(true);

    // Payment #2 should fail before rebalance due credit ceiling.
    await switchRuntime(page, rt1Label);
    await waitForPairIdle(page, h1);
    const senderBeforeP2 = await readPairState(page, h1);
    const p2 = await sendRoutedHtlcPayment(
      page,
      rt1.entityId,
      rt1.signerId,
      rt2.entityId,
      [rt1.entityId, h1, h2, rt2.entityId],
      550n,
      'rt1->rt2 via h1,h2 htlc #2 pre-rebalance',
    );
    await waitForSenderHtlcLock(
      page,
      h1,
      p2.hashlock,
      Number(senderBeforeP2?.recentHtlcLockCount || 0),
      25_000,
    ).catch(() => null);

    await switchRuntime(page, rt2Label);
    const beforeP2Debt = BigInt(afterP1?.hubExposure || afterP1?.hubDebt || '0');
    const rt2P2Cursor = await getPersistedReceiptCursor(page);
    const p2Start = Date.now();
    const PRE_REBALANCE_WINDOW_MS = 2_000;
    let afterP2: any = null;
    while (Date.now() - p2Start < PRE_REBALANCE_WINDOW_MS) {
      afterP2 = await readPairState(page, h2);
      await page.waitForTimeout(150);
    }
    expect(afterP2, 'rt2-h2 state after payment#2').toBeTruthy();
    const p2HashSeen = Array.isArray(afterP2?.recentHtlcHashlocks) && afterP2.recentHtlcHashlocks.includes(p2.hashlock);
    const afterP2Debt = BigInt(afterP2?.hubExposure || afterP2?.hubDebt || '0');
    const rt2P2Events = await readPersistedFrameEventsSinceCursor(page, {
      cursor: rt2P2Cursor,
      eventNames: ['HtlcReceived', 'account_settled_finalized_bilateral'],
    });
    const h2SettledEarly = rt2P2Events.events.some((event) =>
      event.message === 'account_settled_finalized_bilateral' && persistedEventHasAccount(event, h2),
    );
    if (p2HashSeen) {
      expect(
        h2SettledEarly,
        `payment#2 passed too early without persisted rebalance finalize evidence: ${JSON.stringify(rt2P2Events.events.slice(-24), null, 2)}`,
      ).toBe(true);
    } else {
      expect(
        afterP2Debt < beforeP2Debt + 500n * 10n ** 18n,
        'payment#2 should not increase debt by full 550 in pre-rebalance window',
      ).toBe(true);
    }

    // Wait for H2 R2C rebalance pipeline only if the post-cursor slice has not already
    // captured the bilateral finalize event that allowed payment #2 through.
    const h2Lower = h2.toLowerCase();
    if (!h2SettledEarly) {
      await expect.poll(async () => {
        const steps = await readRebalanceStepEvents(page, scenarioStartedAt);
        return countRebalanceStepEvents(
          steps,
          'account_settled_finalized_bilateral',
          (step) => String(step?.accountId || '').toLowerCase() === h2Lower,
        );
      }, {
        timeout: 35_000,
        message: `expected saved rebalance finalize step for ${h2Lower.slice(0, 10)}`,
      }).toBeGreaterThan(0);
    }
    const rebDone = await readPairState(page, h2);
    expect(rebDone, 'rt2-h2 rebalance snapshot must exist').toBeTruthy();
    expect(BigInt(rebDone?.requested || '0') === 0n, 'requestedRebalance must be cleared after finalize').toBe(true);
    if (!rebDone) {
      throw new Error('rt2-h2 rebalance snapshot missing');
    }

    // Payment #3 passes after rebalance.
    await switchRuntime(page, rt1Label);
    await waitForPairIdle(page, h1);
    const senderBeforeP3 = await readPairState(page, h1);
    const p3 = await sendRoutedHtlcPayment(
      page,
      rt1.entityId,
      rt1.signerId,
      rt2.entityId,
      [rt1.entityId, h1, h2, rt2.entityId],
      550n,
      'rt1->rt2 via h1,h2 htlc #3 post-rebalance',
    );
    await waitForSenderHtlcLock(page, h1, p3.hashlock, Number(senderBeforeP3?.recentHtlcLockCount || 0));

    await switchRuntime(page, rt2Label);
    const debtBeforeP3 = BigInt(rebDone.hubExposure || rebDone.hubDebt || '0');
    const resolveBeforeP3 = Number(rebDone.recentHtlcResolveCount || 0);
    const p3Start = Date.now();
    let afterP3: any = null;
    while (Date.now() - p3Start < 30_000) {
      afterP3 = await readPairState(page, h2);
      const resolveSeen = Number(afterP3?.recentHtlcResolveCount || 0) > resolveBeforeP3;
      const debtIncreased = afterP3 && BigInt(afterP3.hubExposure || afterP3.hubDebt || '0') >= debtBeforeP3 + 500n * 10n ** 18n;
      if (debtIncreased && resolveSeen) break;
      await page.waitForTimeout(450);
    }
    expect(afterP3, 'rt2-h2 state after payment#3').toBeTruthy();
    expect(
      BigInt(afterP3.hubExposure || afterP3.hubDebt || '0') >= debtBeforeP3 + 500n * 10n ** 18n,
      `payment#3 should increase exposure by ~550 (before=${debtBeforeP3}, after=${afterP3?.hubExposure || afterP3?.hubDebt || 'n/a'})`,
    ).toBe(true);
    expect(
      Number(afterP3?.recentHtlcResolveCount || 0) > resolveBeforeP3,
      `payment#3 should resolve after rebalance (resolveCount before=${resolveBeforeP3}, after=${afterP3?.recentHtlcResolveCount || 0})`,
    ).toBe(true);

    await page.screenshot({ path: 'test-results/rebalance-rt1-h1-h2-rt2.png', fullPage: true });
  });

  // Scenario: same routed-capacity cliff as above, but through H3 with asymmetric hub credit so we
  // prove the failure/recovery logic is not specific to one hub pair.
  test('runtime2: H1=10k, H3=1k; second 550 via H3 fails before rebalance, passes after', async ({ page }) => {
    test.skip(FAST_E2E && !LONG_E2E, 'Long rebalance edge coverage disabled in fast mode.');
    let scenarioStartedAt = 0;
    await resetProdServer(page);
    await page.addInitScript(() => {
      try {
        localStorage.setItem('xln-app-mode', 'user');
        localStorage.setItem('xln-onboarding-complete', 'true');
      } catch {
        // no-op
      }
    });
    await gotoApp(page);

    // Step 1: two isolated runtimes/entities.
    const rt1Label = `rt1-${Date.now()}`;
    const rt2Label = `rt2-${Date.now() + 1}`;
    await createRuntime(page, rt1Label, randomMnemonic());
    await ensureRuntimeOnline(page, 'rt1-online');
    const rt1 = await getLocalEntity(page);

    await createRuntime(page, rt2Label, randomMnemonic());
    await ensureRuntimeOnline(page, 'rt2-online');
    const rt2 = await getLocalEntity(page);
    expect(rt1.entityId.toLowerCase()).not.toBe(rt2.entityId.toLowerCase());

    await switchRuntime(page, rt2Label);

    // Step 2: discover named hubs.
    const { h1, h3 } = await discoverNamedHubs(page);
    expect(h1 && h3, 'must discover both H1 and H3').toBeTruthy();

    // Step 3: runtime2 opens H1=10k, H3=1k.
    await connectHubWithCredit(page, rt2.entityId, rt2.signerId, h1, 10_000n);
    await connectHubWithCredit(page, rt2.entityId, rt2.signerId, h3, 1_000n);
    await setRebalancePolicy(page, rt2.entityId, rt2.signerId, h3, 500n, 10_000n, 20n);
    await waitForPairIdle(page, h3);

    // Step 4: runtime1 opens funding path via H3 and receives spendable liquidity.
    await switchRuntime(page, rt1Label);
    await connectHubWithCredit(page, rt1.entityId, rt1.signerId, h3, 10_000n);
    const h3BeforeFaucet = await readPairState(page, h3);
    expect(h3BeforeFaucet, 'runtime1-h3 pair must exist before faucet').toBeTruthy();
    await faucetAmount(page, rt1.entityId, h3, '2000');
    await waitForOutCapacityIncrease(page, h3, BigInt(h3BeforeFaucet?.outCapacity || '0'));
    await waitForPairIdle(page, h3);

    // Step 5: switch to runtime2 and capture baseline on H3.
    await switchRuntime(page, rt2Label);
    const baseline = await readPairState(page, h3);
    expect(baseline, 'runtime2-h3 baseline must exist').toBeTruthy();
    const baselineDebt = BigInt(baseline?.hubDebt || baseline?.hubExposure || '0');
    const baselineResolveCount = Number(baseline?.recentHtlcResolveCount || 0);
    // Start collection window after reset/bootstrap to avoid cross-test bleed.
    scenarioStartedAt = Date.now();

    // Step 6: HTLC #1 (550) from runtime1 -> runtime2 via H3 should pass.
    await switchRuntime(page, rt1Label);
    await waitForPairIdle(page, h3);
    const senderBeforeFirstH3 = await readPairState(page, h3);
    const payment1 = await sendRoutedHtlcPayment(
      page,
      rt1.entityId,
      rt1.signerId,
      rt2.entityId,
      [rt1.entityId, h3, rt2.entityId],
      550n,
      'rt1->rt2 via h3 htlc #1',
    );
    await waitForSenderHtlcLock(page, h3, payment1.hashlock, Number(senderBeforeFirstH3?.recentHtlcLockCount || 0));

    await switchRuntime(page, rt2Label);

    const p1Start = Date.now();
    let afterP1: any = null;
    while (Date.now() - p1Start < 60_000) {
      afterP1 = await readPairState(page, h3);
      const debtIncreased = afterP1
        && BigInt(afterP1.hubDebt || afterP1.hubExposure || '0') >= baselineDebt + 500n * 10n ** 18n;
      const resolveSeen = Number(afterP1?.recentHtlcResolveCount || 0) > baselineResolveCount;
      if (debtIncreased && resolveSeen) break;
      await page.waitForTimeout(700);
    }
    expect(afterP1, 'runtime2-h3 state after payment1').toBeTruthy();
    expect(
      BigInt(afterP1?.hubDebt || afterP1?.hubExposure || '0') >= baselineDebt + 500n * 10n ** 18n,
      `payment1 must increase H3 debt by ~550 (baseline=${baselineDebt}, now=${afterP1?.hubDebt || afterP1?.hubExposure || 'n/a'})`,
    ).toBe(true);
    expect(
      Number(afterP1?.recentHtlcResolveCount || 0) > baselineResolveCount,
      `payment1 must be resolved (resolveCount baseline=${baselineResolveCount}, now=${afterP1?.recentHtlcResolveCount || 0})`,
    ).toBe(true);

    // Step 7: HTLC #2 (550) immediately should fail on H3 capacity (1k credit total).
    await switchRuntime(page, rt1Label);
    await waitForPairIdle(page, h3);
    const senderBeforeP2 = await readPairState(page, h3);
    const payment2 = await sendRoutedHtlcPayment(
      page,
      rt1.entityId,
      rt1.signerId,
      rt2.entityId,
      [rt1.entityId, h3, rt2.entityId],
      550n,
      'rt1->rt2 via h3 htlc #2 should fail pre-rebalance',
    );
    await waitForSenderHtlcLock(page, h3, payment2.hashlock, Number(senderBeforeP2?.recentHtlcLockCount || 0))
      .catch(() => null);

    await switchRuntime(page, rt2Label);

    const rt2P2Cursor = await getPersistedReceiptCursor(page);
    const p2Start = Date.now();
    const PRE_REBALANCE_WINDOW_MS = 2_000;
    let afterP2: any = null;
    while (Date.now() - p2Start < PRE_REBALANCE_WINDOW_MS) {
      afterP2 = await readPairState(page, h3);
      await page.waitForTimeout(150);
    }
    expect(afterP2, 'runtime2-h3 state after payment2').toBeTruthy();
    const hasPayment2PreRebalance = Array.isArray(afterP2.recentHtlcHashlocks)
      && afterP2.recentHtlcHashlocks.includes(payment2.hashlock);
    const rt2P2Events = await readPersistedFrameEventsSinceCursor(page, {
      cursor: rt2P2Cursor,
      eventNames: ['HtlcReceived', 'account_settled_finalized_bilateral'],
    });
    const h3SettledEarly = rt2P2Events.events.some((event) =>
      event.message === 'account_settled_finalized_bilateral' && persistedEventHasAccount(event, h3),
    );
    if (hasPayment2PreRebalance) {
      expect(
        h3SettledEarly,
        `payment2 passed too early without persisted rebalance finalize evidence: ${JSON.stringify(rt2P2Events.events.slice(-24), null, 2)}`,
      ).toBe(true);
    }

    const debtAfterP2 = BigInt(afterP2.hubDebt || '0');
    if (!hasPayment2PreRebalance) {
      expect(
        debtAfterP2 <= 1_000n * 10n ** 18n + 20n * 10n ** 18n,
        `runtime2-H3 debt should remain around <=1k in pre-rebalance window, got ${debtAfterP2}`,
      ).toBe(true);
    }

    // Step 8: wait rebalance finalize on runtime2-H3 (collateralized and request cleared).
    let rebDone: any = null;
    const h3Lower = h3.toLowerCase();
    if (!h3SettledEarly) {
      await expect.poll(async () => {
        const steps = await readRebalanceStepEvents(page, scenarioStartedAt);
        return countRebalanceStepEvents(
          steps,
          'account_settled_finalized_bilateral',
          (step) => String(step?.accountId || '').toLowerCase() === h3Lower,
        );
      }, {
        timeout: 180_000,
        message: `expected saved rebalance finalize step for ${h3Lower.slice(0, 10)}`,
      }).toBeGreaterThan(0);
    }
    const rebStart = Date.now();
    while (Date.now() - rebStart < 30_000) {
      const snap = await readPairState(page, h3);
      if (
        snap &&
        BigInt(snap.requested || '0') === 0n &&
        BigInt(snap.collateral || '0') >= BigInt(snap.hubDebt || '0') &&
        Number(snap.lastFinalizedJHeight || 0) > 0
      ) {
        rebDone = snap;
        break;
      }
      await page.waitForTimeout(800);
    }
    expect(rebDone, 'rebalance must complete before payment3').toBeTruthy();

    // Step 9: HTLC #3 (550) after rebalance should pass again.
    await switchRuntime(page, rt1Label);
    await waitForPairIdle(page, h3);
    const senderBeforeP3 = await readPairState(page, h3);
    const payment3 = await sendRoutedHtlcPayment(
      page,
      rt1.entityId,
      rt1.signerId,
      rt2.entityId,
      [rt1.entityId, h3, rt2.entityId],
      550n,
      'rt1->rt2 via h3 htlc #3 post-rebalance',
    );
    await waitForSenderHtlcLock(page, h3, payment3.hashlock, Number(senderBeforeP3?.recentHtlcLockCount || 0));

    await switchRuntime(page, rt2Label);

    const debtBeforeP3 = BigInt(rebDone.hubDebt || '0');
    const resolveBeforeP3 = Number(rebDone.recentHtlcResolveCount || 0);
    const p3Start = Date.now();
    let afterP3: any = null;
    while (Date.now() - p3Start < 70_000) {
      afterP3 = await readPairState(page, h3);
      const hasResolve = Number(afterP3?.recentHtlcResolveCount || 0) > resolveBeforeP3;
      const debtIncreased = afterP3 && BigInt(afterP3.hubDebt || '0') >= debtBeforeP3 + 500n * 10n ** 18n;
      if (afterP3 && hasResolve && debtIncreased) break;
      await page.waitForTimeout(700);
    }
    expect(afterP3, 'runtime2-h3 state after payment3').toBeTruthy();
    expect(
      Number(afterP3?.recentHtlcResolveCount || 0) > resolveBeforeP3,
      `payment3 should resolve post-rebalance (resolveCount before=${resolveBeforeP3}, after=${afterP3?.recentHtlcResolveCount || 0})`,
    ).toBe(true);
    expect(
      BigInt(afterP3.hubDebt || '0') >= debtBeforeP3 + 500n * 10n ** 18n,
      `post-rebalance payment3 should increase debt by ~550 (debt ${debtBeforeP3} -> ${afterP3?.hubDebt || 'n/a'})`,
    ).toBe(true);
  });
});
