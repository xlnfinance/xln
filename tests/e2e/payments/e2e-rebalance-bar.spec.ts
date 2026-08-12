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
import { test, expect, type Browser, type BrowserContext, type Page } from '../../global-setup.mts';
import { deriveDelta, getTokenInfo } from '../../../runtime/account/utils';
import { ethers } from 'ethers';
import { timedStep } from '../../utils/e2e-timing.mts';
import { APP_BASE_URL, API_BASE_URL, resetProdServer, waitForNamedHubs } from '../../utils/e2e-baseline';
import {
  gotoApp as gotoSharedApp,
  createRuntime as createSharedRuntime,
  selectDemoMnemonic,
} from '../../utils/e2e-demo-users';
import {
  connectRuntimeToHub as connectRuntimeToSharedHub,
  connectRuntimeToHubWithCredit,
} from '../../utils/e2e-connect';
import {
  getPersistedReceiptCursor,
  readPersistedFrameEventsSinceCursor,
  waitForPersistedFrameEventMatch,
  type PersistedFrameEvent,
} from '../../utils/e2e-runtime-receipts';
import { submitUiPayment } from '../../utils/runtime/e2e-pay-ui';
import { enqueueEntityTxs } from '../../utils/runtime/e2e-runtime-input';

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
 * A committed pending request is immutable; later exposure waits for the next
 * threshold cycle after the corresponding finalized event.
 */
const INIT_TIMEOUT = 30_000;
const USDC_TOKEN_ID = 1;
const USDC_DECIMALS = getTokenInfo(USDC_TOKEN_ID).decimals;
const USDC_UNIT = 10n ** BigInt(USDC_DECIMALS);

const usdcUnits = (wholeTokens: bigint): bigint => wholeTokens * USDC_UNIT;

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

function deriveDeltaFromSnapshot(
  delta: DeltaSnapshot,
  tokenId: number,
  isLeft: boolean,
) {
  return deriveDelta({
    tokenId,
    ondelta: BigInt(delta.ondelta),
    offdelta: BigInt(delta.offdelta),
    collateral: BigInt(delta.collateral),
    leftCreditLimit: BigInt(delta.leftCreditLimit),
    rightCreditLimit: BigInt(delta.rightCreditLimit),
    leftAllowance: BigInt(delta.leftAllowance),
    rightAllowance: BigInt(delta.rightAllowance),
    leftHold: BigInt(delta.leftHold),
    rightHold: BigInt(delta.rightHold),
  }, isLeft);
}

function readDeltaSnapshot(value: unknown): DeltaSnapshot | null {
  if (!isRecord(value)) return null;
  const readBig = (input: unknown): string => {
    if (typeof input === 'bigint') return input.toString();
    if (typeof input === 'number' && Number.isFinite(input) && Number.isInteger(input)) return String(input);
    if (typeof input === 'string' && /^-?\d+$/.test(input.trim())) return input.trim();
    return '0';
  };
  return {
    ondelta: readBig(value.ondelta),
    offdelta: readBig(value.offdelta),
    collateral: readBig(value.collateral),
    leftCreditLimit: readBig(value.leftCreditLimit),
    rightCreditLimit: readBig(value.rightCreditLimit),
    leftAllowance: readBig(value.leftAllowance),
    rightAllowance: readBig(value.rightAllowance),
    leftHold: readBig(value.leftHold),
    rightHold: readBig(value.rightHold),
  };
}

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

    for (const [key, rep] of env?.state?.eReplicas?.entries?.() || []) {
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

const REBALANCE_DEMO_USERS = ['alice', 'bob', 'carol', 'dave'] as const;
let rebalanceDemoUserCursor = 0;

function nextRebalanceMnemonic(): string {
  const label = REBALANCE_DEMO_USERS[rebalanceDemoUserCursor % REBALANCE_DEMO_USERS.length];
  rebalanceDemoUserCursor += 1;
  return selectDemoMnemonic(label);
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

async function createLiveRuntimePage(
  browser: Browser,
  label: string,
  mnemonic: string,
): Promise<{ context: BrowserContext; page: Page; entity: { entityId: string; signerId: string } }> {
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  await context.addInitScript(() => {
    try {
      localStorage.setItem('xln-app-mode', 'user');
      localStorage.setItem('xln-onboarding-complete', 'true');
    } catch {
      // no-op
    }
  });
  const runtimePage = await context.newPage();
  await gotoApp(runtimePage);
  await createRuntime(runtimePage, label, mnemonic);
  await ensureRuntimeOnline(runtimePage, `${label}-online`);
  const entity = await getLocalEntity(runtimePage);
  return { context, page: runtimePage, entity };
}

async function ensureRuntimeOnline(page: Page, tag: string) {
  await expect
    .poll(async () => {
      if (page.isClosed()) return false;
      return await page.evaluate(() => {
        type RuntimeConnectivity = {
          connected?: boolean;
          connect?: () => void;
          reconnect?: () => void;
        };
        const connectivity = (window as typeof window & {
          __xln?: { runtimeConnectivity?: RuntimeConnectivity };
        }).__xln?.runtimeConnectivity;
        if (!connectivity) return false;
        if (connectivity.connected === true) return true;
        const start = typeof connectivity.connect === 'function'
          ? connectivity.connect
          : connectivity.reconnect;
        if (typeof start === 'function') {
          setTimeout(() => {
            try { start(); } catch {}
          }, 0);
        }
        return false;
      }).catch(() => false);
    }, {
      timeout: 20_000,
      intervals: [250, 500, 1000],
      message: `[${tag}] runtime must be online`,
    })
    .toBe(true);
}

async function discoverHub(page: Page): Promise<string> {
  const hubs = await waitForNamedHubs(page, ['h3'], { apiBaseUrl: API_BASE_URL });
  return hubs.h3;
}

async function discoverPrimaryHub(page: Page): Promise<string> {
  // H1 performs Testnet bootstrap/maintenance batches before user traffic, so
  // its Entity nonce is already non-zero when the first user rebalance starts.
  // This is the production-shaped lazy-jBatch nonce lifecycle.
  const hubs = await waitForNamedHubs(page, ['h1'], { apiBaseUrl: API_BASE_URL });
  return hubs.h1;
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
      if (profile?.metadata?.isHub === true) {
        return true;
      }
      await new Promise((resolve) => setTimeout(resolve, 800));
    }
    return false;
  }, { hubId });
  expect(ok, `hub profile not visible in local gossip for ${hubId.slice(0, 12)}`).toBe(true);
}

async function waitForEntityAdvertised(page: Page, entityId: string, timeoutMs = 60_000): Promise<void> {
  await expect
    .poll(
      async () => {
        const inGossip = await page.evaluate((targetEntityId) => {
          const view = window as typeof window & {
            XLN?: { refreshGossip?: (env: unknown) => void };
            isolatedEnv?: {
              gossip?: {
                getProfiles?: () => Array<{ entityId?: string; runtimeId?: string; metadata?: { runtimeId?: string } }>;
              };
            };
          };
          try {
            view.XLN?.refreshGossip?.(view.isolatedEnv);
          } catch {
            // best effort
          }
          const profiles = view.isolatedEnv?.gossip?.getProfiles?.() || [];
          return profiles.some((profile) =>
            String(profile?.entityId || '').toLowerCase() === String(targetEntityId || '').toLowerCase()
            && Boolean(profile?.runtimeId || profile?.metadata?.runtimeId),
          );
        }, entityId).catch(() => false);
        if (inGossip) return true;

        const response = await page.request.get(
          `${API_BASE_URL}/api/debug/entities?limit=5000&q=${encodeURIComponent(entityId)}`,
        );
        if (!response.ok()) return false;
        const body = await response.json() as { entities?: Array<{ entityId?: string; runtimeId?: string }> };
        return (Array.isArray(body.entities) ? body.entities : []).some((entry) =>
          String(entry.entityId || '').toLowerCase() === entityId.toLowerCase() && Boolean(entry.runtimeId),
        );
      },
      { timeout: timeoutMs, intervals: [500, 1000, 1500] },
    )
    .toBe(true);
}

async function getLocalEntity(page: Page): Promise<{ entityId: string; signerId: string }> {
  const entity = await page.evaluate(() => {
    const env = (window as any).isolatedEnv;
    if (!env?.state?.eReplicas) return null;
    for (const [key] of env.state.eReplicas.entries()) {
      const [entityId, signerId] = String(key).split(':');
      if (!entityId || !signerId) continue;
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
  await connectRuntimeToHubWithCredit(page, { entityId, signerId }, hubId, creditUsd.toString(), [1]);
  await page.waitForTimeout(800);
}


async function discoverNamedHubs(page: Page): Promise<{ h1: string; h3: string }> {
  const hubs = await waitForNamedHubs(page, ['h1', 'h3'], { apiBaseUrl: API_BASE_URL });
  return { h1: hubs.h1, h3: hubs.h3 };
}

async function discoverH1H2(page: Page): Promise<{ h1: string; h2: string }> {
  const hubs = await waitForNamedHubs(page, ['h1', 'h2'], { apiBaseUrl: API_BASE_URL });
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
  await enqueueEntityTxs(page, entityId, signerId, [{
    type: 'setRebalancePolicy',
    data: {
      counterpartyEntityId: hubId,
      tokenId: USDC_TOKEN_ID,
      r2cRequestSoftLimit: usdcUnits(softUsd),
      hardLimit: usdcUnits(hardUsd),
      maxAcceptableFee: usdcUnits(maxFeeUsd),
    },
  }]);
  await page.waitForTimeout(600);
}

type OffchainFaucetResponse = {
  success?: boolean;
  status?: string;
  requestId?: string;
  statusUrl?: string;
  receipt?: {
    id?: string;
    status?: string;
    enqueuedHeight?: number;
    observedHeight?: number;
    expiresAt?: number;
  };
};

async function waitForRuntimeInputObserved(
  page: Page,
  statusUrl: string,
  label: string,
  timeoutMs = 30_000,
): Promise<OffchainFaucetResponse['receipt']> {
  const statusEndpoint = new URL(statusUrl, API_BASE_URL).toString();
  const deadline = Date.now() + timeoutMs;
  let lastBody: any = null;
  let lastStatus = 0;
  while (Date.now() < deadline) {
    const response = await page.request.get(statusEndpoint);
    const body = await response.json().catch(() => ({}));
    lastBody = body;
    lastStatus = response.status();
    if (response.ok()) {
      const receipt = body?.receipt;
      const status = String(receipt?.status || '');
      if (status === 'observed') return receipt;
      if (status === 'expired') {
        throw new Error(`${label} receipt expired before observation: ${JSON.stringify(body)}`);
      }
    }
    await page.waitForTimeout(250);
  }
  throw new Error(
    `${label} receipt was not observed within ${timeoutMs}ms: ` +
      `status=${lastStatus} body=${JSON.stringify(lastBody)}`,
  );
}

async function faucet(page: Page, userEntityId: string, hubEntityId: string): Promise<OffchainFaucetResponse> {
  const runtimeId = await page.evaluate(() => (window as any).isolatedEnv?.runtimeId || null);
  expect(runtimeId, 'runtimeId must exist before faucet').toBeTruthy();
  const deadline = Date.now() + 20_000;
  let lastBody: any = null;
  let lastStatus = 0;
  while (Date.now() < deadline) {
    const resp = await page.request.post(`${API_BASE_URL}/api/faucet/offchain`, {
      data: { userEntityId, userRuntimeId: runtimeId, hubEntityId, tokenId: USDC_TOKEN_ID, amount: '100' },
    });
    const body = await resp.json().catch(() => ({}));
    if (resp.ok()) {
      if (!body?.requestId || !body?.statusUrl) {
        throw new Error(`faucet accepted without receipt metadata: ${JSON.stringify(body)}`);
      }
      await waitForRuntimeInputObserved(page, body.statusUrl, `faucet ${body.requestId}`);
      return body as OffchainFaucetResponse;
    }
    lastBody = body;
    lastStatus = resp.status();
    const code = String(body?.code || '');
    if (
      code !== 'FAUCET_ACCOUNT_NOT_READY' &&
      code !== 'FAUCET_ACCOUNT_PENDING_FRAME' &&
      code !== 'FAUCET_CLIENT_PENDING_FRAME'
    ) {
      break;
    }
    await page.waitForTimeout(300);
  }
  expect(false, `faucet failed: status=${lastStatus} body=${JSON.stringify(lastBody)}`).toBe(true);
}

async function injectEmptyTestnetLiveness(page: Page): Promise<number> {
  const bursts = 1;
  for (let index = 0; index < bursts; index += 1) {
    const response = await page.request.post(`${API_BASE_URL}/rpc`, {
      data: { jsonrpc: '2.0', id: index + 1, method: 'anvil_mine', params: ['0x64'] },
    });
    const body = await response.json().catch(async () => ({ error: (await response.text()).slice(0, 500) }));
    if (!response.ok() || body?.error) {
      throw new Error(
        `E2E_TESTNET_LIVENESS_MINE_FAILED:${response.status()}:${JSON.stringify(body?.error ?? body)}`,
      );
    }
    await page.waitForTimeout(250);
  }
  return bursts;
}

async function faucetAmount(page: Page, userEntityId: string, hubEntityId: string, amountUsd: string) {
  const runtimeId = await page.evaluate(() => (window as any).isolatedEnv?.runtimeId || null);
  expect(runtimeId, 'runtimeId must exist before faucetAmount').toBeTruthy();
  const deadline = Date.now() + 20_000;
  let lastBody: any = null;
  let lastStatus = 0;
  while (Date.now() < deadline) {
    const resp = await page.request.post(`${API_BASE_URL}/api/faucet/offchain`, {
      data: { userEntityId, userRuntimeId: runtimeId, hubEntityId, tokenId: USDC_TOKEN_ID, amount: amountUsd },
    });
    const body = await resp.json().catch(() => ({}));
    if (resp.ok()) return;
    lastBody = body;
    lastStatus = resp.status();
    const code = String(body?.code || '');
    if (
      code !== 'FAUCET_ACCOUNT_NOT_READY' &&
      code !== 'FAUCET_ACCOUNT_PENDING_FRAME' &&
      code !== 'FAUCET_CLIENT_PENDING_FRAME'
    ) {
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
): Promise<void> {
  await enqueueEntityTxs(page, fromEntityId, fromSignerId, [{
    type: 'htlcPayment',
    data: {
      targetEntityId,
      tokenId: USDC_TOKEN_ID,
      amount: usdcUnits(amountUsd),
      maxSenderDebit: usdcUnits(amountUsd) * 2n,
      route,
      description,
      deliveryMode: 'instant',
    },
  }]);
}

async function readPairState(page: Page, counterpartyId: string, ownerEntityId?: string) {
  const raw = await page.evaluate(({ counterpartyId, ownerEntityId }) => {
    const env = (window as any).isolatedEnv;
    if (!env?.state?.eReplicas) return null;
    const ownerTarget = String(ownerEntityId || '').toLowerCase();
    for (const [key, rep] of env.state.eReplicas.entries()) {
      const replicaEntityId = String(rep?.state?.entityId || String(key).split(':')[0] || '').toLowerCase();
      if (ownerTarget && replicaEntityId !== ownerTarget) continue;
      const acc = rep.state?.accounts?.get(counterpartyId);
      if (!acc) continue;
      const accountState = acc.state;
      const delta = accountState.deltas?.get?.(1);
      if (!delta) continue;
      const isLeft = replicaEntityId < String(counterpartyId).toLowerCase();
      const requested = accountState.requestedRebalance?.get?.(1) || 0n;
      const history = Array.isArray(acc.frameHistory) ? acc.frameHistory : [];
      const pendingTxs = Array.isArray(acc?.pendingFrame?.accountTxs) ? acc.pendingFrame.accountTxs : [];
      const htlcFrames = [...history.slice(-80), ...(pendingTxs.length > 0 ? [{ accountTxs: pendingTxs }] : [])];
      const recentDirectPaymentDescriptions = history
        .slice(-40)
        .flatMap((frame: any) => (Array.isArray(frame?.accountTxs) ? frame.accountTxs : []))
        .filter((tx: any) => tx?.type === 'direct_payment')
        .map((tx: any) => String(tx?.data?.description || ''));
      const recentHtlcHashlocks = htlcFrames
        .flatMap((frame: any) => (Array.isArray(frame?.accountTxs) ? frame.accountTxs : []))
        .filter((tx: any) => tx?.type === 'htlc_lock' || tx?.type === 'htlc_resolve')
        .map((tx: any) => String(tx?.data?.hashlock || ''))
        .filter((hash: string) => hash.startsWith('0x') && hash.length > 10);
      const recentHtlcResolveCount = htlcFrames
        .flatMap((frame: any) => (Array.isArray(frame?.accountTxs) ? frame.accountTxs : []))
        .filter((tx: any) => tx?.type === 'htlc_resolve')
        .length;
      const recentHtlcLockCount = htlcFrames
        .flatMap((frame: any) => (Array.isArray(frame?.accountTxs) ? frame.accountTxs : []))
        .filter((tx: any) => tx?.type === 'htlc_lock')
        .length;
      return {
        delta: {
          ondelta: String(delta.ondelta || 0n),
          offdelta: String(delta.offdelta || 0n),
          collateral: String(delta.collateral || 0n),
          leftCreditLimit: String(delta.leftCreditLimit || 0n),
          rightCreditLimit: String(delta.rightCreditLimit || 0n),
          leftAllowance: String(delta.leftAllowance || 0n),
          rightAllowance: String(delta.rightAllowance || 0n),
          leftHold: String(delta.leftHold || 0n),
          rightHold: String(delta.rightHold || 0n),
        },
        isLeft,
        currentHeight: Number(acc.currentHeight || 0),
        pendingHeight: acc.pendingFrame ? Number(acc.pendingFrame.height || 0) : 0,
        mempoolLen: Number(acc.mempool?.length || 0),
        requested: requested.toString(),
        lastFinalizedJHeight: Number(accountState.lastFinalizedJHeight || 0),
        recentDirectPaymentDescriptions,
        recentHtlcHashlocks,
        recentHtlcResolveCount,
        recentHtlcLockCount,
      };
    }
    return null;
  }, { counterpartyId, ownerEntityId });

  if (!raw) return null;
  const delta = readDeltaSnapshot(raw.delta);
  if (!delta) return null;
  const derived = deriveDeltaFromSnapshot(delta, 1, Boolean(raw.isLeft));
  const outPeerCredit = derived.outPeerCredit;
  const outCollateral = derived.outCollateral;
  const hubExposure = outPeerCredit + outCollateral;
  const uncollateralized = outPeerCredit > outCollateral ? outPeerCredit - outCollateral : 0n;

  return {
    currentHeight: Number(raw.currentHeight || 0),
    pendingHeight: Number(raw.pendingHeight || 0),
    mempoolLen: Number(raw.mempoolLen || 0),
    requested: String(raw.requested || '0'),
    hubExposure: hubExposure.toString(),
    hubDebt: outPeerCredit.toString(),
    totalDelta: derived.delta.toString(),
    inCollateral: derived.inCollateral.toString(),
    outCollateral: derived.outCollateral.toString(),
    inCapacity: derived.inCapacity.toString(),
    outCapacity: derived.outCapacity.toString(),
    collateral: outCollateral.toString(),
    uncollateralized: uncollateralized.toString(),
    lastFinalizedJHeight: Number(raw.lastFinalizedJHeight || 0),
    recentDirectPaymentDescriptions: Array.isArray(raw.recentDirectPaymentDescriptions) ? raw.recentDirectPaymentDescriptions.map(String) : [],
    recentHtlcHashlocks: Array.isArray(raw.recentHtlcHashlocks) ? raw.recentHtlcHashlocks.map(String) : [],
    recentHtlcResolveCount: Number(raw.recentHtlcResolveCount || 0),
    recentHtlcLockCount: Number(raw.recentHtlcLockCount || 0),
  };
}

async function waitForPairIdle(
  page: Page,
  counterpartyId: string,
  timeoutMs = 20_000,
  ownerEntityId?: string,
) {
  const start = Date.now();
  let last: Awaited<ReturnType<typeof readPairState>> = null;
  while (Date.now() - start < timeoutMs) {
    last = await readPairState(page, counterpartyId, ownerEntityId);
    if (last && Number(last.pendingHeight || 0) === 0) return last;
    await page.waitForTimeout(250);
  }
  throw new Error(
    `pair ${counterpartyId.slice(0, 12)} not idle: ${JSON.stringify(last, null, 2)}`,
  );
}


async function waitForFundingLiquidityReady(
  page: Page,
  counterpartyId: string,
  baselineOutCapacity: bigint,
  timeoutMs = 180_000,
  ownerEntityId?: string,
) {
  const start = Date.now();
  let last: Awaited<ReturnType<typeof readPairState>> = null;
  while (Date.now() - start < timeoutMs) {
    last = await readPairState(page, counterpartyId, ownerEntityId);
    const outCapacity = BigInt(last?.outCapacity || '0');
    const requested = BigInt(last?.requested || '0');
    if (
      last
      && outCapacity > baselineOutCapacity
      && Number(last.pendingHeight || 0) === 0
      && Number(last.mempoolLen || 0) === 0
      && requested === 0n
    ) {
      return last;
    }
    await page.waitForTimeout(800);
  }
  throw new Error(
    `funding liquidity not ready for ${counterpartyId.slice(0, 12)}: ` +
      `baselineOut=${baselineOutCapacity} last=${JSON.stringify(last, null, 2)}`,
  );
}

async function waitForRebalanceReceiveReady(
  page: Page,
  opts: {
    localAccountId: string;
    hubAccountId: string;
    requiredInCapacity: bigint;
    minLocalFinalizedJHeight: number;
    timeoutMs?: number;
  },
) {
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const startedAt = Date.now();
  let lastSnap: Awaited<ReturnType<typeof readPairState>> = null;

  while (Date.now() - startedAt < timeoutMs) {
    lastSnap = await readPairState(page, opts.hubAccountId, opts.localAccountId);
    if (
      lastSnap &&
      Number(lastSnap.lastFinalizedJHeight || 0) > opts.minLocalFinalizedJHeight &&
      Number(lastSnap.pendingHeight || 0) === 0 &&
      Number(lastSnap.mempoolLen || 0) === 0 &&
      BigInt(lastSnap.requested || '0') === 0n &&
      BigInt(lastSnap.inCapacity || '0') >= opts.requiredInCapacity
    ) {
      return lastSnap;
    }
    await page.waitForTimeout(800);
  }

  throw new Error(
    `rebalance receive capacity not ready: ` +
      `minLocalFinalizedJHeight=${opts.minLocalFinalizedJHeight} ` +
      `requiredIn=${opts.requiredInCapacity} last=${JSON.stringify(lastSnap, null, 2)}`,
  );
}

async function waitForSenderHtlcLock(
  page: Page,
  counterpartyId: string,
  baselineHashlocks: string[],
  baselineLockCount: number,
  timeoutMs = 25_000,
  ownerEntityId?: string,
): Promise<{ snapshot: NonNullable<Awaited<ReturnType<typeof readPairState>>>; hashlock: string }> {
  const start = Date.now();
  let last: Awaited<ReturnType<typeof readPairState>> = null;
  const prior = new Set(baselineHashlocks.map((hashlock) => hashlock.toLowerCase()));
  while (Date.now() - start < timeoutMs) {
    last = await readPairState(page, counterpartyId, ownerEntityId);
    const hashlock = last?.recentHtlcHashlocks.find((candidate) => !prior.has(candidate.toLowerCase())) || '';
    const lockCountIncreased = Number(last?.recentHtlcLockCount || 0) > baselineLockCount;
    if (last && hashlock && lockCountIncreased) return { snapshot: last, hashlock };
    await page.waitForTimeout(350);
  }
  throw new Error(
    `sender HTLC lock not observed for ${counterpartyId.slice(0, 12)}: ${JSON.stringify(last, null, 2)}`,
  );
}

async function sendDirectPaymentToHub(
  page: Page,
  entityId: string,
  signerId: string,
  hubId: string,
  amountUsd: bigint,
) {
  void entityId;
  void signerId;
  await submitUiPayment(page, {
    recipientEntityId: hubId,
    amount: ethers.parseUnits(amountUsd.toString(), USDC_DECIMALS),
    tokenId: USDC_TOKEN_ID,
    routeEntityIds: [],
  });
}

async function readAccountFlowState(page: Page, hubId: string) {
  return page.evaluate(({ hubId }) => {
    const env = (window as any).isolatedEnv;
    if (!env?.state?.eReplicas) return null;
    for (const [key, rep] of env.state.eReplicas.entries()) {
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
    if (!env?.state?.eReplicas) return null;
    const target = String(hubId || '').toLowerCase();
    for (const [key, rep] of env.state.eReplicas.entries()) {
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
        accountEntityId: String(rep.state?.entityId || '').toLowerCase(),
        counterpartyId: target,
        claims,
      };
    }
    return null;
  }, { hubId });
}

async function readRebalanceState(page: Page, hubId: string) {
  const raw = await page.evaluate(({ hubId }) => {
    const env = (window as any).isolatedEnv;
    if (!env?.state?.eReplicas) return null;
    for (const [key, rep] of env.state.eReplicas.entries()) {
      const acc = rep.state?.accounts?.get(hubId);
      if (!acc) continue;
      const accountState = acc.state;
      const delta = accountState.deltas?.get?.(1);
      if (!delta) continue;
      const entityId = String(rep.state?.entityId || '');
      const localIsLeft = entityId.toLowerCase() < String(hubId).toLowerCase();
      const hubIsLeft = String(hubId || '').toLowerCase() < entityId.toLowerCase();
      const requested = accountState.requestedRebalance?.get?.(1) || 0n;
      const policy = accountState.rebalanceFeePolicies?.get?.(1) || null;
      return {
        entityId,
        delta: {
          ondelta: String(delta.ondelta || 0n),
          offdelta: String(delta.offdelta || 0n),
          collateral: String(delta.collateral || 0n),
          leftCreditLimit: String(delta.leftCreditLimit || 0n),
          rightCreditLimit: String(delta.rightCreditLimit || 0n),
          leftAllowance: String(delta.leftAllowance || 0n),
          rightAllowance: String(delta.rightAllowance || 0n),
          leftHold: String(delta.leftHold || 0n),
          rightHold: String(delta.rightHold || 0n),
        },
        localIsLeft,
        hubIsLeft,
        requested: requested.toString(),
        lastFinalizedJHeight: Number(accountState.lastFinalizedJHeight || 0),
        currentHeight: Number(acc.currentHeight || 0),
        hasPolicy: !!policy,
      };
    }
    return null;
  }, { hubId });

  if (!raw) return null;
  const delta = readDeltaSnapshot(raw.delta);
  if (!delta) return null;
  const localDerived = deriveDeltaFromSnapshot(delta, 1, Boolean(raw.localIsLeft));
  const hubDerived = deriveDeltaFromSnapshot(delta, 1, Boolean(raw.hubIsLeft));
  const outPeerCredit = localDerived.outPeerCredit;
  const outCollateral = localDerived.outCollateral;
  const outTotalHold = localDerived.outTotalHold;
  const hubOutCollateral = hubDerived.outCollateral;
  const hubOutTotalHold = hubDerived.outTotalHold;
  const hubFreeOutCollateral = hubOutCollateral > hubOutTotalHold ? hubOutCollateral - hubOutTotalHold : 0n;
  const hubExposure = outPeerCredit + outCollateral;
  const uncollateralized = outPeerCredit > outCollateral ? outPeerCredit - outCollateral : 0n;
  return {
    entityId: String(raw.entityId || ''),
    requested: String(raw.requested || '0'),
    collateral: outCollateral.toString(),
    ondelta: delta.ondelta,
    offdelta: delta.offdelta,
    hubExposure: hubExposure.toString(),
    hubDebt: outPeerCredit.toString(),
    totalDelta: localDerived.delta.toString(),
    inCollateral: localDerived.inCollateral.toString(),
    outCollateral: localDerived.outCollateral.toString(),
    outTotalHold: localDerived.outTotalHold.toString(),
    freeOutCollateral: String(outCollateral > outTotalHold ? outCollateral - outTotalHold : 0n),
    inCapacity: localDerived.inCapacity.toString(),
    outCapacity: localDerived.outCapacity.toString(),
    uncollateralized: uncollateralized.toString(),
    hubOutCollateral: hubOutCollateral.toString(),
    hubOutTotalHold: hubOutTotalHold.toString(),
    hubFreeOutCollateral: hubFreeOutCollateral.toString(),
    lastFinalizedJHeight: Number(raw.lastFinalizedJHeight || 0),
    currentHeight: Number(raw.currentHeight || 0),
    hasPolicy: Boolean(raw.hasPolicy),
  };
}

const DEFAULT_REBALANCE_SOFT_LIMIT_UNITS = usdcUnits(500n);

async function waitForRebalanceStateProgress(
  page: Page,
  hubId: string,
  baseline: {
    currentHeight: number;
    uncollateralized: bigint;
    requested: bigint;
    collateral: bigint;
    hubExposure: bigint;
    outCapacity: bigint;
  },
  timeoutMs = 20_000,
) {
  const startedAt = Date.now();
  let last: Awaited<ReturnType<typeof readRebalanceState>> = null;
  while (Date.now() - startedAt < timeoutMs) {
    last = await readRebalanceState(page, hubId);
    if (!last) {
      await page.waitForTimeout(250);
      continue;
    }
    const currentHeight = Number(last.currentHeight || 0);
    const uncollateralized = BigInt(last.uncollateralized || '0');
    const requested = BigInt(last.requested || '0');
    const collateral = BigInt(last.collateral || '0');
    const hubExposure = BigInt(last.hubExposure || '0');
    const outCapacity = BigInt(last.outCapacity || '0');
    if (
      currentHeight > baseline.currentHeight ||
      uncollateralized > baseline.uncollateralized ||
      requested > baseline.requested ||
      collateral !== baseline.collateral ||
      hubExposure !== baseline.hubExposure ||
      outCapacity !== baseline.outCapacity
    ) {
      return last;
    }
    await page.waitForTimeout(250);
  }
  throw new Error(
    `rebalance state did not progress after faucet for ${hubId.slice(0, 12)}: ` +
      `baseline=${JSON.stringify({
        currentHeight: baseline.currentHeight,
        uncollateralized: baseline.uncollateralized.toString(),
        requested: baseline.requested.toString(),
        collateral: baseline.collateral.toString(),
        hubExposure: baseline.hubExposure.toString(),
        outCapacity: baseline.outCapacity.toString(),
      })} last=${JSON.stringify(last, null, 2)}`,
  );
}

async function driveFaucetsUntilRequestCollateralCommitted(
  page: Page,
  opts: {
    entityId: string;
    hubId: string;
    scenarioStartedAt: number;
    softLimitUnits?: bigint;
    maxFaucets?: number;
    receiptCursor?: Awaited<ReturnType<typeof getPersistedReceiptCursor>>;
  },
) {
  const softLimitUnits = opts.softLimitUnits ?? DEFAULT_REBALANCE_SOFT_LIMIT_UNITS;
  const maxFaucets = opts.maxFaucets ?? 14;
  let receiptCursor = opts.receiptCursor ?? await getPersistedReceiptCursor(page);
  let faucets = 0;
  let lastSnapshot = await readRebalanceState(page, opts.hubId);

  for (; faucets < maxFaucets; faucets++) {
    const baseline = {
      currentHeight: Number(lastSnapshot?.currentHeight || 0),
      uncollateralized: BigInt(lastSnapshot?.uncollateralized || '0'),
      requested: BigInt(lastSnapshot?.requested || '0'),
      collateral: BigInt(lastSnapshot?.collateral || '0'),
      hubExposure: BigInt(lastSnapshot?.hubExposure || '0'),
      outCapacity: BigInt(lastSnapshot?.outCapacity || '0'),
    };
    await faucet(page, opts.entityId, opts.hubId);
    lastSnapshot = await waitForRebalanceStateProgress(page, opts.hubId, baseline);

    // Durable Runtime activity is the release evidence. Relay debug events are
    // useful diagnostics but may be absent when an embedded browser Runtime
    // completes the whole request/settlement cycle between two polls.
    const persisted = await readPersistedFrameEventsSinceCursor(page, {
      cursor: receiptCursor,
      eventNames: ['request_collateral_committed'],
      entityId: opts.entityId,
    });
    receiptCursor = persisted.cursor;
    const committed = persisted.events.find((event) =>
      String(event.data?.accountId || '').toLowerCase() === opts.hubId.toLowerCase(),
    );
    if (committed) {
      return { faucets: faucets + 1, snapshot: lastSnapshot, committed };
    }

    if (BigInt(lastSnapshot.uncollateralized || '0') <= softLimitUnits) {
      continue;
    }

    const latestCommit = await waitForPersistedFrameEventMatch(page, {
      cursor: receiptCursor,
      eventName: 'request_collateral_committed',
      entityId: opts.entityId,
      timeoutMs: 30_000,
      predicate: (event) =>
        String(event.data?.accountId || '').toLowerCase() === opts.hubId.toLowerCase(),
    });
    lastSnapshot = await readRebalanceState(page, opts.hubId);
    return { faucets: faucets + 1, snapshot: lastSnapshot, committed: latestCommit };
  }

  throw new Error(
    `rebalance threshold did not commit within ${maxFaucets} faucet frames: ` +
      `soft=${softLimitUnits} last=${JSON.stringify(lastSnapshot, null, 2)}`,
  );
}

async function readRebalanceDiagnostics(page: Page, hubId: string) {
  return page.evaluate(({ hubId }) => {
    const env = (window as any).isolatedEnv;
    if (!env?.state?.eReplicas) return null;
    let profile: any = null;
    const target = String(hubId || '').toLowerCase();
    const profiles = env?.gossip?.getProfiles?.() || [];
    profile = profiles.find((p: any) => String(p?.entityId || '').toLowerCase() === target) || null;
    for (const [key, rep] of env.state.eReplicas.entries()) {
      const acc = rep.state?.accounts?.get(hubId);
      if (!acc) continue;
      return {
        accountEntityId: String(rep.state?.entityId || ''),
        rebalanceFeePolicies: acc.state.rebalanceFeePolicies || null,
        profileFound: !!profile,
        profileIsHub: profile?.metadata?.isHub === true,
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

async function reloadRuntimeAndWaitReady(page: Page, rebalanceConsole: string[], timingLabel: string): Promise<void> {
  await timedStep(timingLabel, async () => {
    await page.reload({ waitUntil: 'domcontentloaded' });
    try {
      await page.waitForFunction(() => {
        const env = (window as unknown as {
          isolatedEnv?: {
            runtimeId?: string;
            state?: { eReplicas?: { size?: number } };
          };
        }).isolatedEnv;
        return !!env?.runtimeId && Number(env?.state?.eReplicas?.size || 0) > 0;
      }, { timeout: 60_000 });
    } catch (error) {
      const runtimeDebug = await page.evaluate(() => {
        const env = (window as unknown as {
          isolatedEnv?: {
            runtimeId?: string;
            state?: { eReplicas?: { size?: number } };
          };
        }).isolatedEnv;
        const runtimesRaw = typeof localStorage !== 'undefined' ? localStorage.getItem('xln-vaults') : null;
        return {
          hasEnv: !!env,
          runtimeId: env?.runtimeId || null,
          replicaCount: Number(env?.state?.eReplicas?.size || 0),
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
  test.setTimeout(300_000);

  // Scenario: repeated faucet traffic should cross the soft limit, trigger request_collateral,
  // and end with a secured account bar and a second successful rebalance cycle.
  test('faucet -> request_collateral -> secured bar', { tag: '@functional' }, async ({ page }) => {
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
        const rawSettings = localStorage.getItem('xln-settings');
        const parsedSettings = rawSettings ? JSON.parse(rawSettings) : {};
        localStorage.setItem('xln-settings', JSON.stringify({
          ...parsedSettings,
          balanceRefreshMs: 1000,
        }));
      } catch {
        // no-op
      }
    });
    await timedStep('rebalance.goto_app', () => gotoApp(page));
    await timedStep('rebalance.create_runtime', () => createRuntime(page, `rebalance-${Date.now()}`, nextRebalanceMnemonic()));
    await timedStep('rebalance.ensure_runtime_online', () => ensureRuntimeOnline(page, 'post-create'));

    const { entityId, signerId } = await timedStep('rebalance.get_local_entity', () => getLocalEntity(page));
    const hubId = await timedStep('rebalance.discover_hub', () => discoverPrimaryHub(page));
    const hubIsLeft = hubId.toLowerCase() < entityId.toLowerCase();
    await timedStep('rebalance.wait_hub_profile', () => waitForHubProfile(page, hubId));
    await timedStep('rebalance.connect_hub', () => connectHub(page, entityId, signerId, hubId));
    // Start collection window after reset/bootstrap to avoid cross-test bleed.
    scenarioStartedAt = Date.now();
    const firstCycleCursor = await getPersistedReceiptCursor(page);
    await markE2EPhase(page, 'rebalance.connected_hub', {
      phase: 'setup',
      entityId,
      details: { hubId },
    });

    // Drive from committed account state. The faucet endpoint only confirms input acceptance;
    // rebalance must be tested after the account frame actually advances.
    // Keep the local Testnet watcher producing authenticated empty-prefix
    // liveness while the sixth faucet crosses the soft limit. Empty prefixes
    // cannot change the Entity nonce and must not starve the J submit.
    const emptyLiveness = injectEmptyTestnetLiveness(page);
    const firstTrigger = await timedStep('rebalance.drive_to_first_request', () =>
      driveFaucetsUntilRequestCollateralCommitted(page, {
        entityId,
        hubId,
        scenarioStartedAt,
        receiptCursor: firstCycleCursor,
      }));
    await markE2EPhase(page, 'rebalance.faucet_burst_6x_done', {
      phase: 'trigger',
      entityId,
      details: {
        hubId,
        count: firstTrigger.faucets,
        requestedAt: firstTrigger.committed?.data?.requestedAt,
        snapshot: firstTrigger.snapshot,
      },
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
    const firstSecuredCycleMs = Date.now() - start;
    const livenessBursts = await emptyLiveness;
    expect(livenessBursts).toBe(1);
    expect(
      firstSecuredCycleMs,
      `first secured rebalance cycle should complete promptly on anvil (got ${firstSecuredCycleMs}ms)`,
    // Eight isolated E2E stacks intentionally contend for the same host CPU and
    // disk. Keep a hard regression ceiling here, while the runner's isolated
    // benchmark records the useful protocol latency (normally about 1.5s).
    ).toBeLessThanOrEqual(8_000);

    const diagnostics = await readRebalanceDiagnostics(page, hubId);
    const firstSettlement = await waitForPersistedFrameEventMatch(page, {
      cursor: firstCycleCursor,
      eventName: 'account_settled_finalized_bilateral',
      entityId,
      predicate: (event) =>
        String(event.data?.accountId || '').toLowerCase() === hubId.toLowerCase(),
    });
    const { phaseMarkers, debugErrors, frameEvents } = await collectRebalanceDebugArtifacts(page, scenarioStartedAt, hubId);
    const debugDump = buildRebalanceFailureDump({
      entityId,
      hubId,
      snapshot,
      diagnostics,
      rebalanceSteps: [],
      stateTimeline,
      rebalanceConsole,
      phaseMarkers,
      debugErrors,
      frameEvents,
    });
    expect(snapshot, 'account snapshot must exist').toBeTruthy();
    expect(
      firstSettlement.frameHeight > firstTrigger.committed.frameHeight,
      `invalid durable order: settlement must follow request commit\n${debugDump}`,
    ).toBe(true);

    expect(BigInt(snapshot.requested), `request_collateral must be cleared\n${debugDump}`).toBe(0n);
    expect(BigInt(snapshot.uncollateralized), `uncollateralized debt must be zero\n${debugDump}`).toBe(0n);
    expect(BigInt(snapshot.collateral), `collateral must be positive\n${debugDump}`).toBeGreaterThan(0n);
    expect(BigInt(snapshot.hubDebt) <= BigInt(snapshot.collateral), `hubDebt must be fully collateralized\n${debugDump}`).toBe(true);
    expect(snapshot.lastFinalizedJHeight, `jHeight must finalize (>0)\n${debugDump}`).toBeGreaterThan(0);

    // UI assertion + final screenshot artifact
    const accountCard = page.getByTestId('account-preview').first();
    const readyIndicator = accountCard.getByTestId('account-status-coverage').filter({ hasText: '100%' }).first();
    await timedStep('rebalance.wait_ready_indicator', async () => {
      await expect(readyIndicator).toBeVisible({ timeout: 30_000 });
      await expect(readyIndicator).toHaveClass(/cov-good/);
    });

    await expect(accountCard).toBeVisible();
    await accountCard.screenshot({ path: 'test-results/rebalance-green-final.png' });
    await page.screenshot({ path: 'test-results/rebalance-green-fullpage.png', fullPage: true });

    // Regression guard + stronger invariant:
    // after first successful collateralization, faucet must still work and must
    // be able to trigger a second independent collateralization cycle.
    const claimSnapshotBeforeSecondCycle = await readAccountJEventClaims(page, hubId);
    const uniqueSettleKeysBefore = new Set(
      (claimSnapshotBeforeSecondCycle?.claims || []).map((c) => `${c.txHash}:${c.nonce}:${c.jHeight}`),
    );
    const currentHeightBefore = Number(snapshot.currentHeight || 0);
    const lastFinalizedJHeightBefore = Number(snapshot.lastFinalizedJHeight || 0);

    // Push debt enough to cross soft-limit again after first finalize.
    const secondCycleCursor = await getPersistedReceiptCursor(page);
    const secondTrigger = await timedStep('rebalance.second_drive_to_request', () =>
      driveFaucetsUntilRequestCollateralCommitted(page, {
        entityId,
        hubId,
        scenarioStartedAt,
        receiptCursor: secondCycleCursor,
      }));
    await markE2EPhase(page, 'rebalance.second_burst_8x_done', {
      phase: 'second-cycle-trigger',
      entityId,
      details: {
        hubId,
        count: secondTrigger.faucets,
        requestedAt: secondTrigger.committed?.data?.requestedAt,
        snapshot: secondTrigger.snapshot,
      },
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
        const hasSecondSettlement =
          uniqueSettleKeysNow.size >= uniqueSettleKeysBefore.size + 1 ||
          Number(postSnapshot?.lastFinalizedJHeight || 0) > lastFinalizedJHeightBefore;
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
    const secondSecuredCycleMs = Date.now() - postStart;
    const secondSettlement = await waitForPersistedFrameEventMatch(page, {
      cursor: secondCycleCursor,
      eventName: 'account_settled_finalized_bilateral',
      entityId,
      predicate: (event) =>
        String(event.data?.accountId || '').toLowerCase() === hubId.toLowerCase(),
    });
    expect(
      secondSecuredCycleMs,
      `second secured rebalance cycle should complete promptly on anvil (got ${secondSecuredCycleMs}ms)`,
    ).toBeLessThanOrEqual(10_000);
    expect(postSnapshot, `post-secured faucet snapshot missing\n${debugDump}`).toBeTruthy();
    expect(
      Number(postSnapshot.currentHeight || 0) > currentHeightBefore,
      `post-secured faucet did not advance account consensus height\n${buildRebalanceFailureDump({
        entityId,
        hubId,
        snapshot: postSnapshot,
        diagnostics,
        rebalanceSteps: [],
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
    const claimDebugDump = buildRebalanceFailureDump({
      entityId,
      hubId,
      snapshot: postSnapshot,
      diagnostics,
      rebalanceSteps: [],
      stateTimeline: [...stateTimeline, { atMs: 'post-faucet-2nd-cycle', ...postSnapshot }],
      rebalanceConsole: [...rebalanceConsole, ...criticalConsole],
      phaseMarkers: claimArtifacts.phaseMarkers,
      debugErrors: claimArtifacts.debugErrors,
      frameEvents: claimArtifacts.frameEvents,
    });

    expect(claimSnapshot, `claim snapshot must exist\n${claimDebugDump}`).toBeTruthy();
    expect(
      secondSettlement.frameHeight > secondTrigger.committed.frameHeight,
      `second durable settlement must follow its request commit\n${claimDebugDump}`,
    ).toBe(true);
    expect(
      secondSettlement.frameHeight > firstSettlement.frameHeight,
      `second durable settlement must be distinct from the first cycle\n${claimDebugDump}`,
    ).toBe(true);
    const userIdLower = entityId.toLowerCase();
    const hubIdLower = hubId.toLowerCase();
    for (const c of claimSnapshot?.claims || []) {
      const hasLocal = c.leftEntity === userIdLower || c.rightEntity === userIdLower;
      const hasHub = c.leftEntity === hubIdLower || c.rightEntity === hubIdLower;
      expect(hasLocal && hasHub, `misattributed AccountSettled claim pair: ${JSON.stringify(c)}\n${claimDebugDump}`).toBe(true);
    }
    const finalizedJHeightAdvanced = Number(postSnapshot?.lastFinalizedJHeight || 0) > lastFinalizedJHeightBefore;
    expect(
      claimCounts.size >= uniqueSettleKeysBefore.size + 1 || finalizedJHeightAdvanced,
      `must have a new AccountSettled tx after second cycle\n${claimDebugDump}`,
    ).toBe(true);
    if (claimCounts.size >= uniqueSettleKeysBefore.size + 1) {
      expect(
        [...claimCounts.values()].every((n) => n === 2),
        `each AccountSettled must be claimed exactly twice (bilateral): ${JSON.stringify(Object.fromEntries(claimCounts), null, 2)}\n${claimDebugDump}`,
      ).toBe(true);
    }
  });

  // Scenario: once an account is secured, a reload must restore the same state and the watcher must
  // still drive the next rebalance cycle without manual repair.
  test('persistence: secured rebalance survives reload and watcher resumes', { tag: '@resilience' }, async ({ page }) => {
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
        const rawSettings = localStorage.getItem('xln-settings');
        const parsedSettings = rawSettings ? JSON.parse(rawSettings) : {};
        localStorage.setItem('xln-settings', JSON.stringify({
          ...parsedSettings,
          balanceRefreshMs: 1000,
        }));
      } catch {
        // no-op
      }
    });
    await timedStep('rebalance_persist.goto_app', () => gotoApp(page));
    await timedStep('rebalance_persist.create_runtime', () => createRuntime(page, `rebalance-persist-${Date.now()}`, nextRebalanceMnemonic()));
    await timedStep('rebalance_persist.ensure_runtime_online', () => ensureRuntimeOnline(page, 'rebalance-persist-post-create'));

    const { entityId, signerId } = await timedStep('rebalance_persist.get_local_entity', () => getLocalEntity(page));
    const hubId = await timedStep('rebalance_persist.discover_hub', () => discoverPrimaryHub(page));
    await timedStep('rebalance_persist.wait_hub_profile', () => waitForHubProfile(page, hubId));
    await timedStep('rebalance_persist.connect_hub', () => connectHub(page, entityId, signerId, hubId));
    scenarioStartedAt = Date.now();
    const firstSettlementCursor = await getPersistedReceiptCursor(page);

    const firstPersistTrigger = await timedStep('rebalance_persist.drive_to_first_request', () =>
      driveFaucetsUntilRequestCollateralCommitted(page, {
        entityId,
        hubId,
        scenarioStartedAt,
      }));
    await markE2EPhase(page, 'rebalance_persist.first_trigger_done', {
      phase: 'trigger',
      entityId,
      details: {
        hubId,
        count: firstPersistTrigger.faucets,
        requestedAt: firstPersistTrigger.committed?.data?.requestedAt,
        snapshot: firstPersistTrigger.snapshot,
      },
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
    const initialArtifacts = await collectRebalanceDebugArtifacts(page, scenarioStartedAt, hubId);
    const initialDebugDump = buildRebalanceFailureDump({
      entityId,
      hubId,
      snapshot: firstSnapshot,
      diagnostics: initialDiagnostics,
      rebalanceSteps: [],
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
    const firstSettlement = await waitForPersistedFrameEventMatch(page, {
      cursor: firstSettlementCursor,
      eventName: 'account_settled_finalized_bilateral',
      entityId,
      predicate: (event) => persistedEventHasAccount(event, hubId),
    });
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
    const secondSettlementCursor = await getPersistedReceiptCursor(page);

    const secondPersistTrigger = await timedStep('rebalance_persist.drive_to_second_request', () =>
      driveFaucetsUntilRequestCollateralCommitted(page, {
        entityId,
        hubId,
        scenarioStartedAt,
      }));
    await markE2EPhase(page, 'rebalance_persist.second_trigger_done', {
      phase: 'second-cycle-trigger',
      entityId,
      details: {
        hubId,
        count: secondPersistTrigger.faucets,
        requestedAt: secondPersistTrigger.committed?.data?.requestedAt,
        snapshot: secondPersistTrigger.snapshot,
      },
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
        const hasSecondSettlement =
          uniqueSettleKeysNow.size >= uniqueSettleKeysBeforeReload.size + 1 ||
          Number(postReloadSnapshot?.lastFinalizedJHeight || 0) > settledBeforeReload.jHeight;
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
    const finalArtifacts = await collectRebalanceDebugArtifacts(page, scenarioStartedAt, hubId);
    const finalDebugDump = buildRebalanceFailureDump({
      entityId,
      hubId,
      snapshot: postReloadSnapshot,
      diagnostics: finalDiagnostics,
      rebalanceSteps: [],
      stateTimeline: firstStateTimeline,
      rebalanceConsole: [...rebalanceConsole, ...criticalConsole],
      phaseMarkers: finalArtifacts.phaseMarkers,
      debugErrors: finalArtifacts.debugErrors,
      frameEvents: finalArtifacts.frameEvents,
    });
    const secondSettlement = await waitForPersistedFrameEventMatch(page, {
      cursor: secondSettlementCursor,
      eventName: 'account_settled_finalized_bilateral',
      entityId,
      predicate: (event) => persistedEventHasAccount(event, hubId),
    });
    const claimSnapshotAfterReload = await readAccountJEventClaims(page, hubId);
    const uniqueSettleKeysAfterReload = new Set(
      (claimSnapshotAfterReload?.claims || []).map((claim) => `${claim.txHash}:${claim.nonce}:${claim.jHeight}`),
    );

    expect(postReloadSnapshot, `post-reload secured snapshot missing\n${finalDebugDump}`).toBeTruthy();
    expect(Number(postReloadSnapshot.currentHeight || 0) > currentHeightBeforeReload, `account frame height must advance after reload second cycle\n${finalDebugDump}`).toBe(true);
    expect(Number(postReloadSnapshot.lastFinalizedJHeight || 0) > settledBeforeReload.jHeight, `jHeight must advance after reload second cycle\n${finalDebugDump}`).toBe(true);
    expect(BigInt(postReloadSnapshot.requested || '0'), `requested must clear after reload second cycle\n${finalDebugDump}`).toBe(0n);
    expect(BigInt(postReloadSnapshot.uncollateralized || '0'), `uncollateralized must clear after reload second cycle\n${finalDebugDump}`).toBe(0n);
    expect(
      firstSettlement.frameHeight > firstPersistTrigger.committed.frameHeight,
      `first durable settlement must follow its request commit\n${finalDebugDump}`,
    ).toBe(true);
    expect(
      secondSettlement.frameHeight > secondPersistTrigger.committed.frameHeight,
      `second durable settlement must follow its request commit\n${finalDebugDump}`,
    ).toBe(true);
    expect(
      secondSettlement.frameHeight > firstSettlement.frameHeight,
      `post-reload durable settlement must be distinct from the first cycle\n${finalDebugDump}`,
    ).toBe(true);
    const finalizedJHeightAdvancedAfterReload = Number(postReloadSnapshot.lastFinalizedJHeight || 0) > settledBeforeReload.jHeight;
    expect(
      uniqueSettleKeysAfterReload.size >= uniqueSettleKeysBeforeReload.size + 1 ||
        finalizedJHeightAdvancedAfterReload,
      `must have a new settlement after reload second cycle\n${finalDebugDump}`,
    ).toBe(true);
    expect(criticalConsole.length, `critical consensus/runtime errors during reload persistence flow:\n${criticalConsole.join('\n')}`).toBe(0);
  });

  // Scenario: six faucets cross the 500 soft limit. Two more faucets while that
  // request is pending remain below a fresh soft limit and must not top it up.
  test('edge: rapid 8 faucets keep the sub-soft tail out of the pending collateral batch', { tag: '@resilience' }, async ({ page }) => {
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
    await timedStep('rebalance_edge.create_runtime', () => createRuntime(page, `rebalance-edge-pending-${Date.now()}`, nextRebalanceMnemonic()));
    await timedStep('rebalance_edge.ensure_runtime_online', () => ensureRuntimeOnline(page, 'edge-pending-post-create'));

    const { entityId, signerId } = await timedStep('rebalance_edge.get_local_entity', () => getLocalEntity(page));
    const hubId = await timedStep('rebalance_edge.discover_hub', () => discoverHub(page));
    await timedStep('rebalance_edge.wait_hub_profile', () => waitForHubProfile(page, hubId));
    await timedStep('rebalance_edge.connect_hub', () => connectHub(page, entityId, signerId, hubId));
    // Start collection window after reset/bootstrap to avoid cross-test bleed.
    scenarioStartedAt = Date.now();
    await markE2EPhase(page, 'rebalance_edge.connected_hub', {
      phase: 'setup',
      entityId,
      details: { hubId },
    });

    // Trigger the first request from committed account state, not from accepted faucet API calls.
    const edgeCursor = await getPersistedReceiptCursor(page);
    const edgeBaseline = await readRebalanceState(page, hubId);
    expect(edgeBaseline, 'edge baseline must exist').toBeTruthy();
    const firstTrigger = await timedStep('rebalance_edge.drive_to_first_request', () =>
      driveFaucetsUntilRequestCollateralCommitted(page, {
        entityId,
        hubId,
        scenarioStartedAt,
        receiptCursor: edgeCursor,
      }));
    await markE2EPhase(page, 'rebalance_edge.first_trigger_done', {
      phase: 'trigger',
      entityId,
      details: {
        hubId,
        count: firstTrigger.faucets,
        requestedAt: firstTrigger.committed?.data?.requestedAt,
        snapshot: firstTrigger.snapshot,
      },
    });
    const pendingSnapshot: any = firstTrigger.snapshot;
    const firstRequestCommit: any = firstTrigger.committed;
    expect(firstTrigger.faucets, 'the first request must start only after six 100-unit faucets').toBe(6);
    await markE2EPhase(page, 'rebalance_edge.request_committed', {
      phase: 'trigger-confirmed',
      entityId,
      details: {
        hubId,
        requestedAt: firstRequestCommit.requestedAt,
        tokenId: firstRequestCommit.tokenId,
        pendingSeen: BigInt(pendingSnapshot?.requested || '0') > 0n,
      },
    });
    expect(firstRequestCommit, 'expected request_collateral_committed before first finalize').toBeTruthy();

    // Clicks seven and eight add less than a new 500-unit soft limit.
    for (let i = 0; i < 2; i++) {
      const before = await readRebalanceState(page, hubId);
      expect(before, `edge burst baseline ${i + 1} must exist`).toBeTruthy();
      await faucet(page, entityId, hubId);
      await waitForRebalanceStateProgress(page, hubId, {
        currentHeight: Number(before?.currentHeight || 0),
        uncollateralized: BigInt(before?.uncollateralized || '0'),
        requested: BigInt(before?.requested || '0'),
        collateral: BigInt(before?.collateral || '0'),
        hubExposure: BigInt(before?.hubExposure || '0'),
        outCapacity: BigInt(before?.outCapacity || '0'),
      });
    }
    await markE2EPhase(page, 'rebalance_edge.second_burst_while_pending_done', {
      phase: 'duplicate-guard',
      entityId,
      details: { hubId, count: 2 },
    });
    const settlement = await waitForPersistedFrameEventMatch(page, {
      cursor: edgeCursor,
      eventName: 'account_settled_finalized_bilateral',
      entityId,
      timeoutMs: 60_000,
      predicate: (event) => persistedEventHasAccount(event, hubId),
    });
    let settledSnapshot: Awaited<ReturnType<typeof readRebalanceState>> = null;
    await expect.poll(async () => {
      settledSnapshot = await readRebalanceState(page, hubId);
      return !!settledSnapshot
        && BigInt(settledSnapshot.requested || '0') === 0n
        && Number(settledSnapshot.lastFinalizedJHeight || 0) > Number(edgeBaseline?.lastFinalizedJHeight || 0);
    }, { timeout: 30_000, intervals: [250, 500, 1000] }).toBe(true);
    const persisted = await readPersistedFrameEventsSinceCursor(page, {
      cursor: edgeCursor,
      eventNames: ['request_collateral_committed'],
      entityId,
    });
    const requestCommits = persisted.events.filter((event) => persistedEventHasAccount(event, hubId));
    const diagnostics = await readRebalanceDiagnostics(page, hubId);
    const { phaseMarkers, debugErrors, frameEvents } = await collectRebalanceDebugArtifacts(page, scenarioStartedAt, hubId);
    const debugDump = buildRebalanceFailureDump({
      entityId,
      hubId,
      snapshot: settledSnapshot,
      diagnostics,
      rebalanceSteps: [],
      stateTimeline: [
        { atMs: 'pending-request', ...pendingSnapshot },
        { atMs: 'settled', ...settledSnapshot },
      ],
      rebalanceConsole: [],
      phaseMarkers,
      debugErrors,
      frameEvents,
    });
    expect(
      requestCommits.length,
      `clicks seven and eight must not create a second durable collateral request\n${debugDump}`,
    ).toBe(1);
    expect(
      settlement.frameHeight > firstRequestCommit.frameHeight,
      `settlement must follow the durable collateral request\n${debugDump}`,
    ).toBe(true);
    const requestedAmount = BigInt(firstRequestCommit.data?.requestedAmount || '0');
    expect(requestedAmount, `durable request amount must be positive\n${debugDump}`).toBeGreaterThan(0n);
    expect(
      BigInt(settledSnapshot?.collateral || '0') - BigInt(edgeBaseline?.collateral || '0'),
      `one request must produce one exact collateral increase\n${debugDump}`,
    ).toBe(requestedAmount);
  });

  // Scenario: force a full R2C -> C2R -> R2C loop and verify the account transitions through each
  // collateral phase without breaking cadence or losing finalization signal.
  test('cycle R2C -> C2R -> R2C (100ms action cadence)', { tag: '@functional' }, async ({ page }) => {
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
    await timedStep('rebalance_cycle.create_runtime', () => createRuntime(page, `rebalance-cycle-${Date.now()}`, nextRebalanceMnemonic()));
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
    const phase1SettlementCursor = await getPersistedReceiptCursor(page);
    const phase1Trigger = await timedStep('rebalance_cycle.drive_phase1_request', () =>
      driveFaucetsUntilRequestCollateralCommitted(page, {
        entityId,
        hubId,
        scenarioStartedAt,
        receiptCursor: phase1SettlementCursor,
      }));
    const r2cSnapshot1 = await waitForState(
      (s) =>
        BigInt(s.requested) === 0n &&
        BigInt(s.collateral) > usdcUnits(500n) &&
        Number(s.lastFinalizedJHeight || 0) > 0,
      180_000,
      'phase1-r2c',
    );
    const phase1Settlement = await waitForPersistedFrameEventMatch(page, {
      cursor: phase1SettlementCursor,
      eventName: 'account_settled_finalized_bilateral',
      entityId,
      timeoutMs: 60_000,
      predicate: (event) => persistedEventHasAccount(event, hubId),
    });
    expect(phase1Settlement.frameHeight).toBeGreaterThan(phase1Trigger.committed.frameHeight);
    const collateralAfterFirstR2C = BigInt(r2cSnapshot1.collateral);
    const c2rSoftLimitUnits = usdcUnits(500n);

    // Phase 2: C2R (user repays enough so collateral becomes excess and hub withdraws to reserve)
    const hubOwesUser = (snapshot: any): bigint => {
      const d = BigInt(snapshot?.totalDelta || '0');
      return hubIsLeft ? (d < 0n ? -d : 0n) : (d > 0n ? d : 0n);
    };
    if (!hubIsLeft) {
      // When hub is on the right side, paying hub can free right-side outCollateral for C2R.
      const c2rDebtTarget = usdcUnits(1n); // ~1 USD residual tolerance
      for (let i = 0; i < 25; i++) {
        const before = await readRebalanceState(page, hubId);
        const debtUnits = before ? hubOwesUser(before) : 0n;
        if (debtUnits <= c2rDebtTarget) break;
        const paymentUsd = debtUnits / USDC_UNIT;
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
      (s) => BigInt(s.outTotalHold || '0') <= usdcUnits(1n),
      120_000,
      'phase2-hold-clear',
    );
    const preC2RSnapshot = await readRebalanceState(page, hubId);
    expect(preC2RSnapshot, 'phase2 pre-C2R snapshot must exist').toBeTruthy();
    const hubFreeOutBeforeC2R = BigInt(preC2RSnapshot?.hubFreeOutCollateral || '0');
    const c2rShouldTrigger = hubFreeOutBeforeC2R > c2rSoftLimitUnits;

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
        hubFreeOutAfterC2R <= c2rSoftLimitUnits,
        `C2R must not trigger when hub freeOutCollateral <= soft limit (freeOut=${hubFreeOutAfterC2R}, soft=${c2rSoftLimitUnits})`,
      ).toBe(true);
    }

    // Phase 3: R2C again (hub owes user again and tops collateral back up)
    const phase3SettlementCursor = await getPersistedReceiptCursor(page);
    const phase3Trigger = await timedStep('rebalance_cycle.drive_phase3_request', () =>
      driveFaucetsUntilRequestCollateralCommitted(page, {
        entityId,
        hubId,
        scenarioStartedAt,
        maxFaucets: 28,
        receiptCursor: phase3SettlementCursor,
      }));
    const phase3CollateralFloor = c2rShouldTrigger ? collateralAfterC2R : collateralAfterFirstR2C;
    const r2cSnapshot2 = await waitForState(
      (s) => {
        const collateral = BigInt(s.collateral || '0');
        const collateralReady = c2rShouldTrigger
          ? collateral > phase3CollateralFloor
          : collateral >= phase3CollateralFloor;
        return collateralReady &&
          Number(s.lastFinalizedJHeight || 0) > Number(c2rSnapshot?.lastFinalizedJHeight || r2cSnapshot1.lastFinalizedJHeight || 0);
      },
      180_000,
      'phase3-r2c-again',
    );
    const phase3Settlement = await waitForPersistedFrameEventMatch(page, {
      cursor: phase3SettlementCursor,
      eventName: 'account_settled_finalized_bilateral',
      entityId,
      timeoutMs: 60_000,
      predicate: (event) => persistedEventHasAccount(event, hubId),
    });
    expect(phase3Settlement.frameHeight).toBeGreaterThan(phase3Trigger.committed.frameHeight);
    expect(phase3Settlement.frameHeight).toBeGreaterThan(phase1Settlement.frameHeight);

    await page.screenshot({ path: 'test-results/rebalance-cycle-r2c-c2r-r2c.png', fullPage: true });

    if (c2rShouldTrigger) {
      expect(BigInt(r2cSnapshot2.collateral) > collateralAfterC2R, 'second R2C should increase collateral').toBe(true);
    } else {
      expect(BigInt(r2cSnapshot2.collateral) >= collateralAfterFirstR2C, 'R2C must keep collateral non-decreasing').toBe(true);
    }
  });

  // Scenario: multi-hop routing through H1 and H2 should fail on the second 550 payment before H2
  // rebalances, then pass again after H2 completes R2C.
  test('rt1->h1->h2->rt2: second 550 fails before rebalance, passes after H2 R2C', { tag: '@resilience' }, async ({ browser, page }) => {
    let senderContext: BrowserContext | null = null;
    let recipientContext: BrowserContext | null = null;
    try {
      await resetProdServer(page);

      const rt1Label = `rt1-h1h2-${Date.now()}`;
      const rt2Label = `rt2-h1h2-${Date.now() + 1}`;
      const sender = await createLiveRuntimePage(browser, rt1Label, nextRebalanceMnemonic());
      const recipient = await createLiveRuntimePage(browser, rt2Label, nextRebalanceMnemonic());
      senderContext = sender.context;
      recipientContext = recipient.context;
      const senderPage = sender.page;
      const recipientPage = recipient.page;
      const rt1 = sender.entity;
      const rt2 = recipient.entity;
      expect(rt1.entityId.toLowerCase()).not.toBe(rt2.entityId.toLowerCase());

      const { h1, h2 } = await discoverH1H2(recipientPage);
      await Promise.all([
        waitForHubProfile(senderPage, h1),
        waitForHubProfile(senderPage, h2),
        waitForHubProfile(recipientPage, h1),
        waitForHubProfile(recipientPage, h2),
        waitForEntityAdvertised(senderPage, rt2.entityId),
        waitForEntityAdvertised(recipientPage, rt1.entityId),
      ]);

      await markE2EPhase(recipientPage, 'rebalance_h2.connect_recipient_start', {
        entityId: rt2.entityId,
        details: { hub: h2.slice(0, 10) },
      });
      await connectHubWithCredit(recipientPage, rt2.entityId, rt2.signerId, h2, 1_000n);
      await setRebalancePolicy(recipientPage, rt2.entityId, rt2.signerId, h2, 500n, 10_000n, 20n);
      await waitForPairIdle(recipientPage, h2, 20_000, rt2.entityId);

      await markE2EPhase(senderPage, 'rebalance_h2.connect_sender_start', {
        entityId: rt1.entityId,
        details: { hub: h1.slice(0, 10) },
      });
      await connectHubWithCredit(senderPage, rt1.entityId, rt1.signerId, h1, 10_000n);
      const senderBeforeFaucet = await readPairState(senderPage, h1, rt1.entityId);
      expect(senderBeforeFaucet, 'rt1-h1 pair must exist before faucet').toBeTruthy();
      await faucetAmount(senderPage, rt1.entityId, h1, '2000');
      await waitForFundingLiquidityReady(senderPage, h1, BigInt(senderBeforeFaucet?.outCapacity || '0'), 180_000, rt1.entityId);

      const baseline = await readPairState(recipientPage, h2, rt2.entityId);
      expect(baseline, 'rt2-h2 baseline must exist').toBeTruthy();
      const baselineDebt = BigInt(baseline?.hubExposure || baseline?.hubDebt || '0');
      const scenarioStartedAt = Date.now();

      await waitForPairIdle(senderPage, h1, 60_000, rt1.entityId);
      const senderBeforeP1 = await readPairState(senderPage, h1, rt1.entityId);
      await sendRoutedHtlcPayment(
        senderPage,
        rt1.entityId,
        rt1.signerId,
        rt2.entityId,
        [rt1.entityId, h1, h2, rt2.entityId],
        550n,
        'rt1->rt2 via h1,h2 htlc #1',
      );
      await waitForSenderHtlcLock(
        senderPage,
        h1,
        senderBeforeP1?.recentHtlcHashlocks ?? [],
        Number(senderBeforeP1?.recentHtlcLockCount || 0),
        25_000,
        rt1.entityId,
      );

      let afterP1: any = null;
      await expect.poll(async () => {
        afterP1 = await readPairState(recipientPage, h2, rt2.entityId);
        return !!afterP1 && BigInt(afterP1.hubExposure || afterP1.hubDebt || '0') >= baselineDebt + usdcUnits(500n);
      }, { timeout: 30_000 }).toBe(true);

      const beforeP2Debt = BigInt(afterP1?.hubExposure || afterP1?.hubDebt || '0');
      const rt2P2Cursor = await getPersistedReceiptCursor(recipientPage);
      await waitForPairIdle(senderPage, h1, 60_000, rt1.entityId);
      const senderBeforeP2 = await readPairState(senderPage, h1, rt1.entityId);
      await sendRoutedHtlcPayment(
        senderPage,
        rt1.entityId,
        rt1.signerId,
        rt2.entityId,
        [rt1.entityId, h1, h2, rt2.entityId],
        550n,
        'rt1->rt2 via h1,h2 htlc #2 pre-rebalance',
      );
      const p2Lock = await waitForSenderHtlcLock(
        senderPage,
        h1,
        senderBeforeP2?.recentHtlcHashlocks ?? [],
        Number(senderBeforeP2?.recentHtlcLockCount || 0),
        25_000,
        rt1.entityId,
      ).catch(() => null);
      const p2Hashlock = p2Lock?.hashlock ?? '';

      await recipientPage.waitForTimeout(2_000);
      type P2Observation = {
        afterP2: Awaited<ReturnType<typeof readPairState>>;
        p2HashSeen: boolean;
        p2Received: boolean;
        debtReachedFullPayment: boolean;
        h2SettledDuringP2: boolean;
        h2SettlementObserved: boolean;
        receivedFrameHeight: number | null;
        settlementFrameHeight: number | null;
        rt2P2Events: Awaited<ReturnType<typeof readPersistedFrameEventsSinceCursor>>;
      };
      const readP2Observation = async (): Promise<P2Observation> => {
        const afterP2 = await readPairState(recipientPage, h2, rt2.entityId);
        expect(afterP2, 'rt2-h2 state after payment#2').toBeTruthy();
        const p2HashSeen = !!p2Hashlock && Array.isArray(afterP2?.recentHtlcHashlocks) && afterP2.recentHtlcHashlocks.includes(p2Hashlock);
        const rt2P2Events = await readPersistedFrameEventsSinceCursor(recipientPage, {
          cursor: rt2P2Cursor,
          eventNames: ['HtlcReceived', 'account_settled_finalized_bilateral'],
          entityId: rt2.entityId,
        });
        const receivedEvent = rt2P2Events.events.find((event) =>
          event.message === 'HtlcReceived' &&
          (!p2Hashlock || String(event.data?.hashlock || '').toLowerCase() === p2Hashlock.toLowerCase()),
        );
        const settlementEvent = rt2P2Events.events.find((event) =>
          event.message === 'account_settled_finalized_bilateral' && persistedEventHasAccount(event, h2),
        );
        const p2Received = !!receivedEvent;
        const h2SettledDuringP2 = !!receivedEvent && !!settlementEvent &&
          settlementEvent.frameHeight <= receivedEvent.frameHeight;
        return {
          afterP2,
          p2HashSeen,
          p2Received,
          debtReachedFullPayment: BigInt(afterP2?.hubExposure || afterP2?.hubDebt || '0') >= beforeP2Debt + usdcUnits(500n),
          h2SettledDuringP2,
          h2SettlementObserved: !!settlementEvent,
          receivedFrameHeight: receivedEvent?.frameHeight ?? null,
          settlementFrameHeight: settlementEvent?.frameHeight ?? null,
          rt2P2Events,
        };
      };
      let p2Observation = await readP2Observation();
      if (
        (p2Observation.p2HashSeen || p2Observation.p2Received || p2Observation.debtReachedFullPayment) &&
        !p2Observation.h2SettledDuringP2
      ) {
        await expect.poll(async () => {
          p2Observation = await readP2Observation();
          return (p2Observation.p2Received && p2Observation.h2SettlementObserved) ||
            !(p2Observation.p2HashSeen || p2Observation.p2Received || p2Observation.debtReachedFullPayment);
        }, {
          timeout: 10_000,
          intervals: [250, 500, 1000],
          message: 'payment#2 outcome must include H2 settle evidence before accepting debt growth',
        }).toBe(true);
      }
      const { afterP2, p2HashSeen, p2Received, h2SettledDuringP2, rt2P2Events } = p2Observation;
      if (p2HashSeen || p2Received || p2Observation.debtReachedFullPayment) {
        expect(
          p2Received,
          `payment#2 economic success must have exact durable HtlcReceived evidence: ` +
            `events=${JSON.stringify(rt2P2Events.events.slice(-24), null, 2)}`,
        ).toBe(true);
        expect(
          h2SettledDuringP2,
          `payment#2 passed before its persisted rebalance finalize evidence: ` +
            `beforeDebt=${beforeP2Debt} afterDebt=${afterP2?.hubExposure || afterP2?.hubDebt || 'n/a'} ` +
            `settlementFrame=${p2Observation.settlementFrameHeight} receivedFrame=${p2Observation.receivedFrameHeight} ` +
            `events=${JSON.stringify(rt2P2Events.events.slice(-24), null, 2)}`,
        ).toBe(true);
      } else {
        expect(
          BigInt(afterP2?.hubExposure || afterP2?.hubDebt || '0') < beforeP2Debt + usdcUnits(500n),
          'payment#2 should not increase debt by full 550 in pre-rebalance window',
        ).toBe(true);
      }

      if (!p2Observation.h2SettlementObserved) {
        await waitForPersistedFrameEventMatch(recipientPage, {
          cursor: rt2P2Cursor,
          eventName: 'account_settled_finalized_bilateral',
          entityId: rt2.entityId,
          timeoutMs: 35_000,
          predicate: (event) => persistedEventHasAccount(event, h2),
        });
      }

      let rebDone: Awaited<ReturnType<typeof readPairState>> = null;
      const rebalanceClearDeadline = Date.now() + 20_000;
      while (Date.now() < rebalanceClearDeadline) {
        rebDone = await readPairState(recipientPage, h2, rt2.entityId);
        if (rebDone && BigInt(rebDone.requested || '0') === 0n && Number(rebDone.pendingHeight || 0) === 0 && Number(rebDone.mempoolLen || 0) === 0) {
          break;
        }
        await recipientPage.waitForTimeout(400);
      }
      expect(rebDone, 'rt2-h2 rebalance snapshot must exist').toBeTruthy();
      expect(BigInt(rebDone?.requested || '0') === 0n, 'requestedRebalance must be cleared after finalize').toBe(true);
      if (!rebDone) throw new Error('rt2-h2 rebalance snapshot missing');

      let afterP2PostRebalance: any = rebDone;
      let p2PostRebalanceApplied =
        BigInt(rebDone.hubExposure || rebDone.hubDebt || '0') >= beforeP2Debt + usdcUnits(500n);
      const p2PostRebalanceDeadline = Date.now() + 10_000;
      while (!p2PostRebalanceApplied && Date.now() < p2PostRebalanceDeadline) {
        afterP2PostRebalance = await readPairState(recipientPage, h2, rt2.entityId);
        p2PostRebalanceApplied =
          BigInt(afterP2PostRebalance?.hubExposure || afterP2PostRebalance?.hubDebt || '0')
            >= beforeP2Debt + usdcUnits(500n);
        if (p2PostRebalanceApplied) break;
        await recipientPage.waitForTimeout(400);
      }
      if (p2PostRebalanceApplied) {
        await recipientPage.screenshot({ path: 'test-results/rebalance-rt1-h1-h2-rt2.png', fullPage: true });
        return;
      }

      const debtBeforeP3 = BigInt(rebDone.hubExposure || rebDone.hubDebt || '0');
      await waitForPairIdle(senderPage, h1, 20_000, rt1.entityId);
      const senderBeforeP3 = await readPairState(senderPage, h1, rt1.entityId);
      await sendRoutedHtlcPayment(
        senderPage,
        rt1.entityId,
        rt1.signerId,
        rt2.entityId,
        [rt1.entityId, h1, h2, rt2.entityId],
        550n,
        'rt1->rt2 via h1,h2 htlc #3 post-rebalance',
      );
      await waitForSenderHtlcLock(
        senderPage,
        h1,
        senderBeforeP3?.recentHtlcHashlocks ?? [],
        Number(senderBeforeP3?.recentHtlcLockCount || 0),
        25_000,
        rt1.entityId,
      );

      let afterP3: any = null;
      await expect.poll(async () => {
        afterP3 = await readPairState(recipientPage, h2, rt2.entityId);
        return !!afterP3 && BigInt(afterP3.hubExposure || afterP3.hubDebt || '0') >= debtBeforeP3 + usdcUnits(500n);
      }, { timeout: 30_000 }).toBe(true);
      expect(afterP3, 'rt2-h2 state after payment#3').toBeTruthy();
      await waitForPairIdle(recipientPage, h2, 20_000, rt2.entityId);
      await recipientPage.waitForTimeout(2_000);

      await recipientPage.screenshot({ path: 'test-results/rebalance-rt1-h1-h2-rt2.png', fullPage: true });
    } finally {
      await Promise.all([
        senderContext?.close().catch(() => {}),
        recipientContext?.close().catch(() => {}),
      ]);
    }
  });

  // Scenario: same routed-capacity cliff as above, but through H3 with asymmetric hub credit so we
  // prove the failure/recovery logic is not specific to one hub pair.
  test('runtime2: H1=10k, H3=1k; second 550 via H3 fails before rebalance, passes after', { tag: '@resilience' }, async ({ browser, page }) => {
    let senderContext: BrowserContext | null = null;
    let recipientContext: BrowserContext | null = null;
    try {
      await resetProdServer(page);

      const rt1Label = `rt1-${Date.now()}`;
      const rt2Label = `rt2-${Date.now() + 1}`;
      const sender = await createLiveRuntimePage(browser, rt1Label, nextRebalanceMnemonic());
      const recipient = await createLiveRuntimePage(browser, rt2Label, nextRebalanceMnemonic());
      senderContext = sender.context;
      recipientContext = recipient.context;
      const senderPage = sender.page;
      const recipientPage = recipient.page;
      const rt1 = sender.entity;
      const rt2 = recipient.entity;
      expect(rt1.entityId.toLowerCase()).not.toBe(rt2.entityId.toLowerCase());

      const { h1, h3 } = await discoverNamedHubs(recipientPage);
      await Promise.all([
        waitForHubProfile(senderPage, h1),
        waitForHubProfile(senderPage, h3),
        waitForHubProfile(recipientPage, h1),
        waitForHubProfile(recipientPage, h3),
        waitForEntityAdvertised(senderPage, rt2.entityId),
        waitForEntityAdvertised(recipientPage, rt1.entityId),
      ]);

      await connectHubWithCredit(recipientPage, rt2.entityId, rt2.signerId, h1, 10_000n);
      await connectHubWithCredit(recipientPage, rt2.entityId, rt2.signerId, h3, 1_000n);
      await setRebalancePolicy(recipientPage, rt2.entityId, rt2.signerId, h3, 2_000n, 10_000n, 20n);
      await waitForPairIdle(recipientPage, h3, 60_000, rt2.entityId);

      await connectHubWithCredit(senderPage, rt1.entityId, rt1.signerId, h3, 10_000n);
      const h3BeforeFaucet = await readPairState(senderPage, h3, rt1.entityId);
      expect(h3BeforeFaucet, 'runtime1-h3 pair must exist before faucet').toBeTruthy();
      await faucetAmount(senderPage, rt1.entityId, h3, '2000');
      await waitForFundingLiquidityReady(senderPage, h3, BigInt(h3BeforeFaucet?.outCapacity || '0'), 180_000, rt1.entityId);

      const baseline = await readPairState(recipientPage, h3, rt2.entityId);
      expect(baseline, 'runtime2-h3 baseline must exist').toBeTruthy();
      const baselineDebt = BigInt(baseline?.hubDebt || baseline?.hubExposure || '0');
      const scenarioStartedAt = Date.now();

      await waitForPairIdle(senderPage, h3, 60_000, rt1.entityId);
      await sendRoutedHtlcPayment(
        senderPage,
        rt1.entityId,
        rt1.signerId,
        rt2.entityId,
        [rt1.entityId, h3, rt2.entityId],
        550n,
        'rt1->rt2 via h3 htlc #1',
      );

      let afterP1: any = null;
      await expect.poll(async () => {
        afterP1 = await readPairState(recipientPage, h3, rt2.entityId);
        return !!afterP1 && BigInt(afterP1.hubDebt || afterP1.hubExposure || '0') >= baselineDebt + usdcUnits(500n);
      }, { timeout: 60_000 }).toBe(true);

      const rt2P2Cursor = await getPersistedReceiptCursor(recipientPage);
      await waitForPairIdle(senderPage, h3, 60_000, rt1.entityId);
      const senderBeforeP2 = await readPairState(senderPage, h3, rt1.entityId);
      await sendRoutedHtlcPayment(
        senderPage,
        rt1.entityId,
        rt1.signerId,
        rt2.entityId,
        [rt1.entityId, h3, rt2.entityId],
        550n,
        'rt1->rt2 via h3 htlc #2 should fail pre-rebalance',
      );
      const payment2Lock = await waitForSenderHtlcLock(
        senderPage,
        h3,
        senderBeforeP2?.recentHtlcHashlocks ?? [],
        Number(senderBeforeP2?.recentHtlcLockCount || 0),
        25_000,
        rt1.entityId,
      ).catch(() => null);
      const payment2Hashlock = payment2Lock?.hashlock ?? '';

      await recipientPage.waitForTimeout(2_000);
      const afterP2 = await readPairState(recipientPage, h3, rt2.entityId);
      expect(afterP2, 'runtime2-h3 state after payment2').toBeTruthy();
      const hasPayment2PreRebalance = !!payment2Hashlock
        && Array.isArray(afterP2?.recentHtlcHashlocks)
        && afterP2.recentHtlcHashlocks.includes(payment2Hashlock);
      let rt2P2Events = await readPersistedFrameEventsSinceCursor(recipientPage, {
        cursor: rt2P2Cursor,
        eventNames: ['HtlcReceived', 'account_settled_finalized_bilateral'],
        entityId: rt2.entityId,
      });
      let receivedEvent = rt2P2Events.events.find((event) =>
        event.message === 'HtlcReceived' &&
        (!payment2Hashlock || String(event.data?.hashlock || '').toLowerCase() === payment2Hashlock.toLowerCase()),
      );
      let settlementEvent = rt2P2Events.events.find((event) =>
        event.message === 'account_settled_finalized_bilateral' && persistedEventHasAccount(event, h3),
      );
      if ((hasPayment2PreRebalance || receivedEvent) && (!receivedEvent || !settlementEvent)) {
        await expect.poll(async () => {
          rt2P2Events = await readPersistedFrameEventsSinceCursor(recipientPage, {
            cursor: rt2P2Cursor,
            eventNames: ['HtlcReceived', 'account_settled_finalized_bilateral'],
            entityId: rt2.entityId,
          });
          receivedEvent = rt2P2Events.events.find((event) =>
            event.message === 'HtlcReceived' &&
            (!payment2Hashlock || String(event.data?.hashlock || '').toLowerCase() === payment2Hashlock.toLowerCase()),
          );
          settlementEvent = rt2P2Events.events.find((event) =>
            event.message === 'account_settled_finalized_bilateral' && persistedEventHasAccount(event, h3),
          );
          return !!receivedEvent && !!settlementEvent;
        }, {
          timeout: 10_000,
          intervals: [250, 500, 1000],
          message: 'payment2 success must expose both durable receive and settlement evidence',
        }).toBe(true);
      }
      const payment2Received = !!receivedEvent;
      const h3SettledDuringP2 = !!receivedEvent && !!settlementEvent &&
        settlementEvent.frameHeight <= receivedEvent.frameHeight;
      if (hasPayment2PreRebalance || payment2Received) {
        expect(
          payment2Received,
          `payment2 economic success must have exact durable HtlcReceived evidence: ${JSON.stringify(rt2P2Events.events.slice(-24), null, 2)}`,
        ).toBe(true);
        expect(
          h3SettledDuringP2,
          `payment2 passed before rebalance finality: settlementFrame=${settlementEvent?.frameHeight ?? 'none'} ` +
            `receivedFrame=${receivedEvent?.frameHeight ?? 'none'} events=${JSON.stringify(rt2P2Events.events.slice(-24), null, 2)}`,
        ).toBe(true);
      } else {
        expect(
          BigInt(afterP2?.hubDebt || '0') <= usdcUnits(1_000n) + usdcUnits(20n),
          `runtime2-H3 debt should remain around <=1k in pre-rebalance window, got ${afterP2?.hubDebt || 'n/a'}`,
        ).toBe(true);
      }

      const h3FinalizedJHeightBeforeRebalance = Number(afterP2?.lastFinalizedJHeight || 0);
      await setRebalancePolicy(recipientPage, rt2.entityId, rt2.signerId, h3, 500n, 10_000n, 20n);
      const rebDone = await waitForRebalanceReceiveReady(recipientPage, {
        localAccountId: rt2.entityId,
        hubAccountId: h3,
        requiredInCapacity: usdcUnits(550n),
        minLocalFinalizedJHeight: h3FinalizedJHeightBeforeRebalance,
      });

      await waitForPairIdle(senderPage, h3, 60_000, rt1.entityId);
      await sendRoutedHtlcPayment(
        senderPage,
        rt1.entityId,
        rt1.signerId,
        rt2.entityId,
        [rt1.entityId, h3, rt2.entityId],
        550n,
        'rt1->rt2 via h3 htlc #3 post-rebalance',
      );

      // The authoritative success proof is the recipient's economic state
      // below. Sender frameHistory is intentionally pruned from RAM and a
      // fast lock+resolve may disappear before the browser observes it.
      const debtBeforeP3 = BigInt(rebDone.hubDebt || rebDone.hubExposure || '0');
      const outCapacityBeforeP3 = BigInt(rebDone.outCapacity || '0');
      let afterP3: any = null;
      await expect.poll(async () => {
        afterP3 = await readPairState(recipientPage, h3, rt2.entityId);
        if (!afterP3) return false;
        const debtIncreased = BigInt(afterP3.hubDebt || afterP3.hubExposure || '0') >= debtBeforeP3 + usdcUnits(500n);
        const outCapacityIncreased = BigInt(afterP3.outCapacity || '0') >= outCapacityBeforeP3 + usdcUnits(500n);
        return debtIncreased || outCapacityIncreased;
      }, { timeout: 70_000 }).toBe(true);
      expect(afterP3, 'runtime2-h3 state after payment3').toBeTruthy();
      await waitForPairIdle(recipientPage, h3, 20_000, rt2.entityId);
      await recipientPage.waitForTimeout(2_000);
    } finally {
      await Promise.all([
        senderContext?.close().catch(() => {}),
        recipientContext?.close().catch(() => {}),
      ]);
    }
  });
});
