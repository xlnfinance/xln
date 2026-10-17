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
import { allowBrowserIssue, allowDebugIncident, test, expect, type Browser, type BrowserContext, type Page } from '../../global-setup.mts';
import { safeStringify } from '../../../core/protocol/serialization';
import { createWalletIdentity, LOCAL_PASSWORD } from '../../../ui/tests/wallet-ui';
import type { RuntimeReplica, XLNModule } from '../../../core/api/public/runtime-module';
import { deriveDelta, getTokenInfo } from '../../../core/account/utils';
import { computeBatchHankoHash, decodeJBatch } from '../../../core/jurisdiction/machine/batch';
import { computeAccountKey } from '../../../core/jurisdiction/adapter/events/contract-codec';
import { ethers } from 'ethers';
import { timedStep } from '../../utils/e2e-timing.mts';
import { APP_BASE_URL, API_BASE_URL, getHealth, resetProdServer, waitForNamedHubs } from '../../utils/e2e-baseline';
import {
  gotoApp as gotoSharedApp,
  selectDemoMnemonic,
} from '../../utils/e2e-demo-users';
import {
  connectRuntimeToHub as connectRuntimeToSharedHub,
  ensureRuntimeOnline,
  connectRuntimeToHubWithCredit,
} from '../../utils/e2e-connect';
import {
  getPersistedReceiptCursor,
  readPersistedFrameEventsSinceCursor,
  waitForPersistedFrameEventMatch,
  type PersistedFrameEvent,
} from '../../utils/e2e-runtime-receipts';
import { prepareUiPayment, submitUiPayment } from '../../utils/runtime/e2e-pay-ui';
import { readCommittedPayment } from '../../../ui/tests/payment-evidence';
import { enqueueEntityTxs } from '../../utils/runtime/e2e-runtime-input';

/**
 * REBALANCE INVARIANT (do not "simplify" this in future edits):
 *
 * Auto request_collateral MUST trigger ONLY from deriveDelta(...).outPeerCredit >= r2cRequestSoftLimit.
 * - outPeerCredit = currently used peer credit (actual risk surface).
 * - outCollateral = already posted collateral; it must NOT be added to trigger metric.
 *
 * Why:
 * Using (outCollateral + outPeerCredit) over-triggers after the first successful top-up
 * and causes a new request_collateral on almost every small payment/faucet click.
 * A committed pending request is immutable; later exposure waits for the next
 * threshold cycle after the corresponding finalized event.
 */
type RebalanceWindow = Window & {
  __xln?: {
    env(): RuntimeReplica | null;
    xln(): Promise<XLNModule>;
    store: { getState(): { activeEntityId: string | null } };
  };
};

const INIT_TIMEOUT = 30_000;
const USDC_TOKEN_ID = 1;
const USDC_DECIMALS = getTokenInfo(USDC_TOKEN_ID).decimals;
const USDC_UNIT = 10n ** BigInt(USDC_DECIMALS);
const DEPOSITORY_BATCH_INTERFACE = new ethers.Interface([
  'function processBatch(bytes encodedBatch, bytes hankoData, uint256 nonce)',
  'event HankoBatchProcessed(bytes32 indexed entityId, bytes32 indexed batchHash, uint256 nonce)',
]);
const PROCESS_BATCH_SELECTOR = ethers.id('processBatch(bytes,bytes,uint256)').slice(0, 10).toLowerCase();
const HANKO_BATCH_TOPIC = ethers.id('HankoBatchProcessed(bytes32,bytes32,uint256)').toLowerCase();
const COLLATERAL_INTERFACE = new ethers.Interface([
  'function _collaterals(bytes accountKey,uint256 tokenId) view returns (uint256 collateral,(int256 high,uint256 low) ondelta)',
]);

const usdcUnits = (wholeTokens: bigint): bigint => wholeTokens * USDC_UNIT;

type PendingRpcTransaction = {
  hash?: string;
  input?: string;
  to?: string | null;
};

type RpcTransactionReceipt = {
  blockNumber?: string;
  logs?: Array<{
    address?: string;
    data?: string;
    topics?: string[];
  }>;
  status?: string;
  transactionHash?: string;
};

type PendingRebalanceBatch = {
  batchHash: string;
  entityNonce: bigint;
  transactionHash: string;
};

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
  phase?: string | undefined;
  entityId?: string | undefined;
  details?: unknown;
};

type DebugErrorSummary = {
  ts: number;
  event: string;
  level?: string | undefined;
  category?: string | undefined;
  message?: string | undefined;
  runtimeId?: string | undefined;
  entityId?: string | undefined;
  reason?: string | undefined;
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

function persistedEventHasAccountToken(
  event: PersistedFrameEvent,
  accountId: string,
  tokenId: number,
): boolean {
  return persistedEventHasAccount(event, accountId) && Number(event.data?.tokenId) === tokenId;
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

    for (const rep of env?.state?.eReplicas?.values?.() || []) {
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
  if (!label) throw new Error('REBALANCE_DEMO_USER_UNAVAILABLE');
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
  await createWalletIdentity(runtimePage, label, mnemonic);
  await ensureRuntimeOnline(runtimePage, `${label}-online`);
  const entity = await getLocalEntity(runtimePage);
  return { context, page: runtimePage, entity };
}

async function discoverHub(page: Page): Promise<string> {
  const hubs = await waitForNamedHubs(page, ['h3'], { apiBaseUrl: API_BASE_URL });
  if (!hubs.h3) throw new Error('REBALANCE_H3_UNAVAILABLE');
  return hubs.h3;
}

async function discoverPrimaryHub(page: Page): Promise<string> {
  // H1 performs Testnet bootstrap/maintenance batches before user traffic, so
  // its Entity nonce is already non-zero when the first user rebalance starts.
  // This is the production-shaped lazy-jBatch nonce lifecycle.
  const hubs = await waitForNamedHubs(page, ['h1'], { apiBaseUrl: API_BASE_URL });
  if (!hubs.h1) throw new Error('REBALANCE_H1_UNAVAILABLE');
  return hubs.h1;
}

async function waitForHubProfile(page: Page, hubId: string) {
  await expect
    .poll(
      () =>
        page.evaluate(target => {
          const env = (window as RebalanceWindow).__xln?.env();
          if (!env) throw new Error('REBALANCE_RUNTIME_UNAVAILABLE');
          return env.gossip
            .getProfiles()
            .some(profile => profile.entityId.toLowerCase() === target && profile.metadata?.isHub === true);
        }, hubId.toLowerCase()),
      { timeout: 60_000 },
    )
    .toBe(true);
}

async function waitForEntityAdvertised(page: Page, entityId: string, timeoutMs = 60_000): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate(async target => {
          const debug = (window as RebalanceWindow).__xln;
          const env = debug?.env();
          if (!debug || !env) throw new Error('REBALANCE_RUNTIME_UNAVAILABLE');
          await (await debug.xln()).ensureGossipProfiles(env, [target]);
          return env.gossip
            .getProfiles()
            .some(
              profile =>
                profile.entityId.toLowerCase() === target.toLowerCase() && Boolean(profile.runtimeId),
            );
        }, entityId),
      { timeout: timeoutMs, intervals: [200, 400, 800] },
    )
    .toBe(true);
}

async function getLocalEntity(page: Page): Promise<{ entityId: string; signerId: string }> {
  return page.evaluate(() => {
    const debug = (window as RebalanceWindow).__xln;
    const env = debug?.env();
    const entityId = debug?.store.getState().activeEntityId;
    if (!env || !entityId) throw new Error('REBALANCE_RUNTIME_OWNER_UNAVAILABLE');
    const replicas = [...env.state.eReplicas.values()].filter(replica => replica.entityId === entityId);
    const [replica] = replicas;
    if (replicas.length !== 1 || !replica) throw new Error('REBALANCE_ENTITY_NOT_UNIQUE');
    return { entityId, signerId: replica.signerId };
  });
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
  if (!hubs.h1 || !hubs.h3) throw new Error('REBALANCE_H1_H3_UNAVAILABLE');
  return { h1: hubs.h1, h3: hubs.h3 };
}

async function discoverH1H2(page: Page): Promise<{ h1: string; h2: string }> {
  const hubs = await waitForNamedHubs(page, ['h1', 'h2'], { apiBaseUrl: API_BASE_URL });
  if (!hubs.h1 || !hubs.h2) throw new Error('REBALANCE_H1_H2_UNAVAILABLE');
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
};


async function faucet(
  page: Page, userEntityId: string, hubEntityId: string, amountUsd = '100',
): Promise<OffchainFaucetResponse> {
  const runtimeId = await page.evaluate(() => (window as RebalanceWindow).__xln?.env()?.runtimeId || null);
  expect(runtimeId, 'runtimeId must exist before faucet').toBeTruthy();
  const deadline = Date.now() + 20_000;
  let lastBody: any = null;
  let lastStatus = 0;
  while (Date.now() < deadline) {
    const resp = await page.request.post(`${API_BASE_URL}/api/faucet/offchain`, {
      data: { userEntityId, userRuntimeId: runtimeId, hubEntityId, tokenId: USDC_TOKEN_ID, amount: amountUsd },
    });
    const body = await resp.json().catch(() => ({}));
    if (resp.ok()) {
      if (!body?.requestId) {
        throw new Error(`faucet accepted without requestId: ${JSON.stringify(body)}`);
      }
      // Settlement is observed by callers through Account state progress; the
      // faucet response carries no receipt polling URL.
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
  throw new Error(`faucet failed: status=${lastStatus} body=${JSON.stringify(lastBody)}`);
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

async function callTestnetRpc<T>(page: Page, method: string, params: unknown[] = []): Promise<T> {
  const response = await page.request.post(`${API_BASE_URL}/rpc`, {
    data: { jsonrpc: '2.0', id: 1, method, params },
  });
  const body = await response.json().catch(() => null) as {
    error?: unknown;
    result?: T;
  } | null;
  if (!response.ok() || !body || body.error !== undefined || !Object.hasOwn(body, 'result')) {
    throw new Error(`TESTNET_RPC_FAILED:${method}:${response.status()}:${JSON.stringify(body)}`);
  }
  return body.result as T;
}

async function readActiveChainRebalanceState(page: Page, entityId: string, hubId: string) {
  const jurisdiction = await page.evaluate(targetEntityId => {
    const env = (window as RebalanceWindow).__xln?.env();
    const replicas = env?.state?.eReplicas;
    const replica = [...(replicas?.values?.() ?? [])].find(
      entry => String(entry?.entityId || '').toLowerCase() === targetEntityId.toLowerCase(),
    );
    return replica?.state?.config?.jurisdiction ?? null;
  }, entityId);
  const depository = String(jurisdiction?.depositoryAddress || '');
  const chainId = Number(jurisdiction?.chainId);
  if (!ethers.isAddress(depository)) throw new Error(`REBALANCE_DEPOSITORY_INVALID:${depository}`);
  if (!Number.isSafeInteger(chainId) || chainId <= 0) throw new Error(`REBALANCE_CHAIN_ID_INVALID:${chainId}`);
  const data = COLLATERAL_INTERFACE.encodeFunctionData('_collaterals', [
    computeAccountKey(entityId, hubId),
    USDC_TOKEN_ID,
  ]);
  const raw = await callTestnetRpc<string>(page, 'eth_call', [{ to: depository, data }, 'latest']);
  const [collateral] = COLLATERAL_INTERFACE.decodeFunctionResult('_collaterals', raw);
  return { chainId, collateral: String(collateral), depository };
}

async function waitForPendingRebalanceBatch(
  page: Page,
  input: {
    chainId: number;
    depository: string;
    entityId: string;
    expectedAmount: bigint;
    hubId: string;
  },
): Promise<PendingRebalanceBatch> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const block = await callTestnetRpc<{ transactions?: PendingRpcTransaction[] } | null>(page, 'eth_getBlockByNumber', ['pending', true]);
    for (const transaction of block?.transactions ?? []) {
      const data = String(transaction.input || '');
      if (String(transaction.to || '').toLowerCase() !== input.depository.toLowerCase()) continue;
      if (!data.toLowerCase().startsWith(PROCESS_BATCH_SELECTOR)) continue;
      const parsed = DEPOSITORY_BATCH_INTERFACE.parseTransaction({ data });
      if (!parsed || parsed.name !== 'processBatch') throw new Error('REBALANCE_PENDING_BATCH_DECODE_FAILED');
      const encodedBatch = String(parsed.args.encodedBatch);
      const batch = decodeJBatch(encodedBatch);
      const amount = batch.reserveToCollateral.reduce((total, operation) => {
        if (operation.tokenId !== USDC_TOKEN_ID) return total;
        if (operation.receivingEntity.toLowerCase() !== input.hubId.toLowerCase()) return total;
        return total + operation.pairs.reduce(
          (pairTotal, pair) => pair.entity.toLowerCase() === input.entityId.toLowerCase()
            ? pairTotal + pair.amount
            : pairTotal,
          0n,
        );
      }, 0n);
      if (amount === 0n) continue;
      if (amount !== input.expectedAmount) {
        throw new Error(`REBALANCE_PENDING_AMOUNT_MISMATCH:${amount}:${input.expectedAmount}`);
      }
      const entityNonce = BigInt(parsed.args.nonce);
      const transactionHash = String(transaction.hash || '');
      if (!/^0x[0-9a-f]{64}$/i.test(transactionHash)) {
        throw new Error(`REBALANCE_PENDING_TX_HASH_INVALID:${transactionHash}`);
      }
      return {
        batchHash: computeBatchHankoHash(
          BigInt(input.chainId),
          input.depository,
          encodedBatch,
          entityNonce,
        ),
        entityNonce,
        transactionHash,
      };
    }
    await page.waitForTimeout(100);
  }
  throw new Error(`REBALANCE_PENDING_BATCH_TIMEOUT:${input.entityId}:${input.hubId}`);
}

async function waitForTransactionReceipt(page: Page, transactionHash: string): Promise<RpcTransactionReceipt> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const receipt = await callTestnetRpc<RpcTransactionReceipt | null>(
      page,
      'eth_getTransactionReceipt',
      [transactionHash],
    );
    if (receipt) return receipt;
    await page.waitForTimeout(50);
  }
  throw new Error(`REBALANCE_MINED_RECEIPT_TIMEOUT:${transactionHash}`);
}

async function countExactHankoBatchLogs(
  page: Page,
  depository: string,
  entityId: string,
  batchHash: string,
): Promise<number> {
  const logs = await callTestnetRpc<unknown[]>(page, 'eth_getLogs', [{
    address: depository,
    fromBlock: '0x0',
    toBlock: 'latest',
    topics: [HANKO_BATCH_TOPIC, entityId, batchHash],
  }]);
  return logs.length;
}

async function sendRoutedHtlcPayment(
  page: Page,
  fromEntityId: string,
  fromSignerId: string,
  targetEntityId: string,
  route: string[],
  amountUsd: bigint,
  description: string,
): Promise<{ senderAmount: string; recipientAmount: string; feeAmount: string }> {
  const active = await getLocalEntity(page);
  expect(active).toEqual({ entityId: fromEntityId, signerId: fromSignerId });
  await prepareUiPayment(page, {
    recipientEntityId: targetEntityId,
    amount: usdcUnits(amountUsd),
    tokenId: USDC_TOKEN_ID,
    routeEntityIds: route,
  });
  const note = page.getByTestId('pay-note');
  if (!(await note.isVisible())) await page.getByRole('button', { name: 'Add a note', exact: true }).click();
  await note.fill(description);
  const quote = page.getByTestId('pay-quote');
  const senderAmount = await quote.getAttribute('data-sender-amount');
  const recipientAmount = await quote.getAttribute('data-recipient-amount');
  const feeAmount = await quote.getAttribute('data-fee-amount');
  if (senderAmount === null || recipientAmount === null || feeAmount === null)
    throw new Error('REBALANCE_QUOTE_AMOUNTS_MISSING');
  expect(BigInt(senderAmount) - BigInt(recipientAmount)).toBe(BigInt(feeAmount));
  await expect(page.getByTestId('pay-submit')).toBeEnabled();
  await page.getByTestId('pay-submit').click();
  return { senderAmount, recipientAmount, feeAmount };
}

async function readPairState(page: Page, counterpartyId: string, ownerEntityId?: string) {
  const raw = await page.evaluate(({ counterpartyId, ownerEntityId }) => {
    const debug = (window as RebalanceWindow).__xln;
    if (!debug) throw new Error('REBALANCE_RUNTIME_UNAVAILABLE');
    const env = debug.env();
    if (!env?.state?.eReplicas) return null;
    const ownerTarget = String(ownerEntityId || '').toLowerCase();
    for (const rep of env.state.eReplicas.values()) {
      if (typeof rep.entityId !== 'string') throw new Error('REBALANCE_REPLICA_ENTITY_MISSING');
      const replicaEntityId = rep.entityId.toLowerCase();
      if (ownerTarget && replicaEntityId !== ownerTarget) continue;
      const acc = rep.state?.accounts?.get(counterpartyId);
      if (!acc) continue;
      const accountState = acc.state;
      const delta = accountState.deltas?.get?.(1);
      if (!delta) continue;
      const isLeft = replicaEntityId < String(counterpartyId).toLowerCase();
      const requested = accountState.requestedRebalance?.get?.(1) || 0n;
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
  // deriveDelta already excludes collateral from outPeerCredit.
  const uncollateralized = outPeerCredit;

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

async function readAccountJEventClaims(page: Page, hubId: string) {
  return page.evaluate(async ({ hubId }) => {
    const env = (window as RebalanceWindow).__xln?.env();
    if (!env?.state?.eReplicas) return null;
    const debug = (window as RebalanceWindow).__xln;
    if (!debug) throw new Error('REBALANCE_RUNTIME_UNAVAILABLE');
    const readHistory = (await debug.xln()).readPersistedAccountFrameHistory;
    if (typeof readHistory !== 'function') throw new Error('PERSISTED_ACCOUNT_HISTORY_API_UNAVAILABLE');
    const target = String(hubId || '').toLowerCase();
    for (const rep of env.state.eReplicas.values()) {
      const acc = rep.state?.accounts?.get(hubId);
      if (!acc) continue;
      const accountEntityId = String(rep.state?.entityId || '').toLowerCase();
      const history = await readHistory(env, accountEntityId, hubId, 200);
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
            if (event.type !== 'AccountSettled') continue;
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
        accountEntityId,
        counterpartyId: target,
        claims,
      };
    }
    return null;
  }, { hubId });
}

async function readRebalanceState(page: Page, hubId: string) {
  const raw = await page.evaluate(({ hubId }) => {
    const env = (window as RebalanceWindow).__xln?.env();
    if (!env?.state?.eReplicas) return null;
    for (const rep of env.state.eReplicas.values()) {
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
        leftPendingJClaims: String(accountState.leftPendingJClaims?.count || 0n),
        requested: requested.toString(),
        rightPendingJClaims: String(accountState.rightPendingJClaims?.count || 0n),
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
  // deriveDelta already excludes collateral from outPeerCredit.
  const uncollateralized = outPeerCredit;
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
    leftPendingJClaims: String(raw.leftPendingJClaims || '0'),
    lastFinalizedJHeight: Number(raw.lastFinalizedJHeight || 0),
    rightPendingJClaims: String(raw.rightPendingJClaims || '0'),
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
  const cycleCursor = opts.receiptCursor ?? await getPersistedReceiptCursor(page);
  let faucets = 0;
  let lastSnapshot = await readRebalanceState(page, opts.hubId);
  if (!lastSnapshot) throw new Error(`REBALANCE_BASELINE_MISSING:${opts.hubId}`);
  if (BigInt(lastSnapshot.requested || '0') !== 0n) {
    throw new Error(`REBALANCE_BASELINE_REQUEST_PENDING:${opts.hubId}`);
  }
  const initialCollateral = BigInt(lastSnapshot.collateral || '0');

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
      cursor: cycleCursor,
      eventNames: ['request_collateral_committed'],
      entityId: opts.entityId,
    });
    const committed = persisted.events.find((event) => {
      const eventAccountId = String(event.data?.accountId || '').toLowerCase();
      const eventTokenId = Number(event.data?.tokenId);
      return eventAccountId === opts.hubId.toLowerCase() && eventTokenId === USDC_TOKEN_ID;
    });
    if (committed) {
      return { faucets: faucets + 1, snapshot: lastSnapshot, committed };
    }

    const triggeredOrSettled =
      BigInt(lastSnapshot.uncollateralized || '0') >= softLimitUnits ||
      BigInt(lastSnapshot.collateral || '0') > initialCollateral;
    if (!triggeredOrSettled) {
      continue;
    }

    const latestCommit = await waitForPersistedFrameEventMatch(page, {
      cursor: cycleCursor,
      eventName: 'request_collateral_committed',
      entityId: opts.entityId,
      timeoutMs: 30_000,
      predicate: (event) =>
        String(event.data?.accountId || '').toLowerCase() === opts.hubId.toLowerCase() &&
        Number(event.data?.tokenId) === USDC_TOKEN_ID,
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
    for (const rep of env.state.eReplicas.values()) {
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
  );
}

async function reloadRuntimeAndWaitReady(page: Page, timingLabel: string): Promise<void> {
  const before = await page.evaluate(() => {
    const env = (window as RebalanceWindow).__xln?.env();
    if (!env) throw new Error('REBALANCE_RELOAD_RUNTIME_MISSING');
    return { runtimeId: env.runtimeId, replicas: env.state.eReplicas.size };
  });
  await timedStep(timingLabel, async () => {
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await page.getByLabel('Password', { exact: true }).fill(LOCAL_PASSWORD);
    await page.getByRole('button', { name: 'Unlock', exact: true }).click();
    await expect(page.getByTestId('nav-home').locator('visible=true').first()).toBeVisible();
    await expect
      .poll(
        () =>
          page.evaluate(() => {
            const env = (window as RebalanceWindow).__xln?.env();
            return { runtimeId: env?.runtimeId, replicas: env?.state.eReplicas.size };
          }),
        { timeout: 60_000 },
      )
      .toEqual(before);
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
    page.on('console', msg => {
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
        localStorage.setItem(
          'xln-settings',
          JSON.stringify({
            ...parsedSettings,
            balanceRefreshMs: 1000,
          }),
        );
      } catch {
        // no-op
      }
    });
    await timedStep('rebalance.goto_app', () => gotoApp(page));
    await timedStep('rebalance.create_runtime', () =>
      createWalletIdentity(page, `rebalance-${Date.now()}`, nextRebalanceMnemonic()),
    );
    await timedStep('rebalance.ensure_runtime_online', () => ensureRuntimeOnline(page, 'post-create'));

    const { entityId, signerId } = await timedStep('rebalance.get_local_entity', () => getLocalEntity(page));
    const hubId = await timedStep('rebalance.discover_hub', () => discoverPrimaryHub(page));
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
    // liveness while the fifth faucet reaches the inclusive soft limit. Empty prefixes
    // cannot change the Entity nonce and must not starve the J submit.
    const emptyLiveness = injectEmptyTestnetLiveness(page);
    const firstTrigger = await timedStep('rebalance.drive_to_first_request', () =>
      driveFaucetsUntilRequestCollateralCommitted(page, {
        entityId,
        hubId,
        scenarioStartedAt,
        receiptCursor: firstCycleCursor,
      }),
    );
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
      predicate: event =>
        String(event.data?.accountId || '').toLowerCase() === hubId.toLowerCase() &&
        event.frameHeight > firstTrigger.committed.frameHeight,
    });
    const { phaseMarkers, debugErrors, frameEvents } = await collectRebalanceDebugArtifacts(
      page,
      scenarioStartedAt,
      hubId,
    );
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
    expect(
      BigInt(snapshot.hubDebt) <= BigInt(snapshot.collateral),
      `hubDebt must be fully collateralized\n${debugDump}`,
    ).toBe(true);
    expect(snapshot.lastFinalizedJHeight, `jHeight must finalize (>0)\n${debugDump}`).toBeGreaterThan(0);

    // The React balance breakdown must show the same fully secured exposure.
    await page.getByTestId('nav-home').locator('visible=true').first().click();
    const accountCard = page.getByTestId('account-row');
    await expect(accountCard).toHaveCount(1);
    const securedUsd = Number(ethers.formatUnits(BigInt(snapshot.collateral), USDC_DECIMALS)).toFixed(2);
    await timedStep('rebalance.wait_ready_indicator', async () => {
      await expect(page.getByTestId('home-risk').locator('strong')).toHaveText('$0.00');
      await expect(page.getByTestId('home-secured').locator('strong')).toHaveText(`$${securedUsd}`);
    });
    await accountCard.screenshot({ path: 'test-results/rebalance-green-final.png' });
    await page.screenshot({ path: 'test-results/rebalance-green-fullpage.png', fullPage: true });

    // Regression guard + stronger invariant:
    // after first successful collateralization, faucet must still work and must
    // be able to trigger a second independent collateralization cycle.
    const claimSnapshotBeforeSecondCycle = await readAccountJEventClaims(page, hubId);
    const uniqueSettleKeysBefore = new Set(
      (claimSnapshotBeforeSecondCycle?.claims || []).map(c => `${c.txHash}:${c.nonce}:${c.jHeight}`),
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
      }),
    );
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
          (claimSnapshotNow?.claims || []).map(c => `${c.txHash}:${c.nonce}:${c.jHeight}`),
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
      predicate: event =>
        String(event.data?.accountId || '').toLowerCase() === hubId.toLowerCase() &&
        event.frameHeight > secondTrigger.committed.frameHeight &&
        event.frameHeight > firstSettlement.frameHeight,
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
      const allBilateral = [...claimCounts.values()].every(n => n === 2);
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
      expect(
        hasLocal && hasHub,
        `misattributed AccountSettled claim pair: ${JSON.stringify(c)}\n${claimDebugDump}`,
      ).toBe(true);
    }
    const finalizedJHeightAdvanced = Number(postSnapshot?.lastFinalizedJHeight || 0) > lastFinalizedJHeightBefore;
    expect(
      claimCounts.size >= uniqueSettleKeysBefore.size + 1 || finalizedJHeightAdvanced,
      `must have a new AccountSettled tx after second cycle\n${claimDebugDump}`,
    ).toBe(true);
    if (claimCounts.size >= uniqueSettleKeysBefore.size + 1) {
      expect(
        [...claimCounts.values()].every(n => n === 2),
        `each AccountSettled must be claimed exactly twice (bilateral): ${JSON.stringify(Object.fromEntries(claimCounts), null, 2)}\n${claimDebugDump}`,
      ).toBe(true);
    }
    await test.info().attach('rebalance-cycles', {
      contentType: 'application/json',
      body: safeStringify({
        first: {
          state: snapshot,
          requestFrame: firstTrigger.committed.frameHeight,
          settlementFrame: firstSettlement.frameHeight,
          milliseconds: firstSecuredCycleMs,
        },
        second: {
          state: postSnapshot,
          requestFrame: secondTrigger.committed.frameHeight,
          settlementFrame: secondSettlement.frameHeight,
          milliseconds: secondSecuredCycleMs,
        },
        bilateralClaims: Object.fromEntries(claimCounts),
        livenessBursts,
      }),
    });
  });

  // Crash H1 immediately after the exact R2C receipt is mined. Recovery must
  // retain one batch and one bilateral settlement across a browser reload.
  test('persistence: mined rebalance survives H1 and user restart exactly once', { tag: '@resilience' }, async ({ page }) => {
    allowDebugIncident({ source: 'orchestrator', code: 'CHILD_UNEXPECTED_EXIT', message: 'child.unexpected_exit' });
    allowDebugIncident({
      source: 'orchestrator',
      code: 'H1_UNEXPECTED_EXIT',
      message: 'H1_UNEXPECTED_EXIT code=null signal=SIGKILL',
    });
    let h1OutageExpected = false;
    const unexpectedUnavailableResponses: string[] = [];
    page.on('response', response => {
      if (response.status() !== 503) return;
      const url = response.url();
      if (!h1OutageExpected || new URL(url).pathname !== '/api/tokens') {
        unexpectedUnavailableResponses.push(url);
        return;
      }
      allowBrowserIssue({ type: 'http', severity: 'error', url, method: 'GET', status: 503, message: 'HTTP 503' });
    });
    const criticalConsole: string[] = [];
    page.on('console', (msg) => {
      const text = msg.text();
      if (h1OutageExpected && text === 'Failed to load resource: the server responded with a status of 503 (Service Unavailable)') {
        allowBrowserIssue({ type: 'console', severity: 'error', message: text });
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
    await timedStep('rebalance_persist.create_runtime', () => createWalletIdentity(page, `rebalance-persist-${Date.now()}`, nextRebalanceMnemonic()));
    await timedStep('rebalance_persist.ensure_runtime_online', () => ensureRuntimeOnline(page, 'rebalance-persist-post-create'));

    const { entityId, signerId } = await timedStep('rebalance_persist.get_local_entity', () => getLocalEntity(page));
    const hubId = await timedStep('rebalance_persist.discover_hub', () => discoverPrimaryHub(page));
    await timedStep('rebalance_persist.wait_hub_profile', () => waitForHubProfile(page, hubId));
    await timedStep('rebalance_persist.connect_hub', () => connectHub(page, entityId, signerId, hubId));
    const cycleCursor = await getPersistedReceiptCursor(page);
    const baseline = await readRebalanceState(page, hubId);
    expect(baseline, 'rebalance restart baseline must exist').toBeTruthy();
    const chainBefore = await readActiveChainRebalanceState(page, entityId, hubId);
    expect(BigInt(chainBefore.collateral)).toBe(BigInt(baseline!.collateral));
    const healthBefore = await getHealth(page, API_BASE_URL);
    const h1Before = healthBefore?.process?.children?.find((child) => child.role === 'hub' && child.name === 'H1');
    expect(healthBefore?.systemOk, 'mesh must be healthy before H1 crash').toBe(true);
    expect(h1Before?.online, 'H1 must be online before crash').toBe(true);
    expect(h1Before?.pid, 'H1 PID must be observable').toBeGreaterThan(0);
    const oldPid = Number(h1Before!.pid);
    const oldRestartCount = Number(h1Before!.restartCount || 0);
    const h1RuntimeId = healthBefore?.hubs?.find((hub) => hub.name === 'H1')?.runtimeId;
    const userRuntimeId = await page.evaluate(() => {
      const env = (window as RebalanceWindow).__xln?.env();
      if (!env) throw new Error('REBALANCE_CRASH_RUNTIME_MISSING');
      return env.runtimeId;
    });
    expect(h1RuntimeId).toMatch(/^0x[0-9a-f]{40}$/);
    expect(userRuntimeId).toMatch(/^0x[0-9a-f]{40}$/);
    const h1WsUrl = await page.evaluate(runtimeId => {
      const env = (window as RebalanceWindow).__xln?.env();
      if (!env) throw new Error('REBALANCE_CRASH_RUNTIME_MISSING');
      const profile = env.gossip.getProfileByRuntimeId(runtimeId);
      if (!profile?.wsUrl) throw new Error('REBALANCE_CRASH_HUB_ENDPOINT_MISSING');
      return profile.wsUrl;
    }, h1RuntimeId!);
    const escapedH1WsUrl = h1WsUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // The deliberately killed peer may advertise localhost or 127.0.0.1.
    // Exempt only its exact endpoint; unrelated disconnects remain failures.
    allowBrowserIssue({ type: 'console', severity: 'error', message: new RegExp(`WS_UNEXPECTED_CLOSE:runtime=.*:url=${escapedH1WsUrl}:`) });
    allowBrowserIssue({ type: 'console', severity: 'error', message: new RegExp(`WebSocket connection to '${escapedH1WsUrl}' failed: Error in connection establishment: net::ERR_CONNECTION_REFUSED`) });
    allowBrowserIssue({ type: 'console', severity: 'warning', message: new RegExp(`\\[WARN\\]\\[runtime\\.wsClient\\] initial_connect\\.(error|closed).*url=${escapedH1WsUrl}:`) });
    allowBrowserIssue({ type: 'console', severity: 'warning', message: new RegExp(`\\[network\\] WS_DIRECT_PEER_OFFLINE \\{endpoint: ${escapedH1WsUrl},`) });
    // SIGKILL makes this one peer undeliverable. Retention is expected only for
    // that offline target; the queue and bilateral ACK must drain before reload.
    allowBrowserIssue({
      type: 'console', severity: 'warning',
      message: new RegExp(`^\\[WARN\\]\\[network\\.route\\] output\\.retained \\{"retained":\\d+,"runtimeId":"${userRuntimeId}","targets":\\[\\{"count":\\d+,"deliverable":false,"runtimeId":"${h1RuntimeId}"\\}\\]\\}$`),
    });
    const crashBoundary = await timedStep('rebalance_persist.mine_then_crash_h1', async () => {
      let h1Frozen = false;
      let automineDisabled = false;
      try {
        await callTestnetRpc<unknown>(page, 'evm_setAutomine', [false]);
        automineDisabled = true;
        const trigger = await driveFaucetsUntilRequestCollateralCommitted(page, {
          entityId,
          hubId,
          scenarioStartedAt: Date.now(),
          receiptCursor: cycleCursor,
        });
        const requestedAmount = BigInt(String(trigger.committed.data?.requestedAmount || '0'));
        if (requestedAmount <= 0n) throw new Error(`REBALANCE_REQUEST_AMOUNT_INVALID:${requestedAmount}`);
        const pending = await waitForPendingRebalanceBatch(page, {
          chainId: chainBefore.chainId,
          depository: chainBefore.depository,
          entityId,
          expectedAmount: requestedAmount,
          hubId,
        });
        h1OutageExpected = true;
        process.kill(oldPid, 'SIGSTOP');
        h1Frozen = true;
        await callTestnetRpc<unknown>(page, 'anvil_mine', ['0x1']);
        const receipt = await waitForTransactionReceipt(page, pending.transactionHash);
        process.kill(oldPid, 'SIGKILL');
        h1Frozen = false;
        return { pending, receipt, requestedAmount, trigger };
      } finally {
        if (h1Frozen) process.kill(oldPid, 'SIGCONT');
        if (automineDisabled) await callTestnetRpc<unknown>(page, 'evm_setAutomine', [true]);
      }
    });

    const receiptLog = crashBoundary.receipt.logs?.find((log) =>
      String(log.address || '').toLowerCase() === chainBefore.depository.toLowerCase()
      && String(log.topics?.[0] || '').toLowerCase() === HANKO_BATCH_TOPIC);
    if (!receiptLog?.data || !receiptLog.topics) throw new Error('REBALANCE_HANKO_RECEIPT_MISSING');
    const hanko = DEPOSITORY_BATCH_INTERFACE.parseLog({ data: receiptLog.data, topics: receiptLog.topics });
    if (!hanko || hanko.name !== 'HankoBatchProcessed') throw new Error('REBALANCE_HANKO_RECEIPT_INVALID');
    const minedJHeight = Number(BigInt(crashBoundary.receipt.blockNumber || '0x0'));
    expect(crashBoundary.receipt.status, 'R2C transaction must succeed').toBe('0x1');
    expect(crashBoundary.receipt.transactionHash?.toLowerCase()).toBe(crashBoundary.pending.transactionHash.toLowerCase());
    expect(String(hanko.args.entityId).toLowerCase()).toBe(hubId.toLowerCase());
    expect(String(hanko.args.batchHash).toLowerCase()).toBe(crashBoundary.pending.batchHash.toLowerCase());
    expect(BigInt(hanko.args.nonce)).toBe(crashBoundary.pending.entityNonce);
    expect(minedJHeight).toBeGreaterThan(Number(baseline!.lastFinalizedJHeight));

    await expect.poll(async () => {
      const health = await getHealth(page, API_BASE_URL);
      const child = health?.process?.children?.find((candidate) => candidate.role === 'hub' && candidate.name === 'H1');
      const hub = health?.hubs?.find((candidate) => candidate.name === 'H1');
      return {
        hubOnline: hub?.online === true,
        processOnline: child?.online === true,
        replaced: Number(child?.pid || 0) > 0 && Number(child?.pid) !== oldPid,
        restarted: Number(child?.restartCount || 0) > oldRestartCount,
        systemOk: health?.systemOk === true,
      };
    }, { timeout: 90_000, intervals: [250, 500, 1000] }).toEqual({
      hubOnline: true,
      processOnline: true,
      replaced: true,
      restarted: true,
      systemOk: true,
    });
    h1OutageExpected = false;
    const recoveredTokens = await page.request.get(`${API_BASE_URL}/api/tokens`);
    expect(recoveredTokens.ok(), `token catalog must recover with the hub: ${recoveredTokens.status()} ${await recoveredTokens.text()}`).toBe(true);

    const finalizedReceipt = await waitForPersistedFrameEventMatch(page, {
      cursor: cycleCursor,
      eventName: 'account_settled_finalized_bilateral',
      entityId,
      timeoutMs: 60_000,
      predicate: (event) => persistedEventHasAccountToken(event, hubId, USDC_TOKEN_ID),
    });
    const chainAfterRestart = await readActiveChainRebalanceState(page, entityId, hubId);
    expect(BigInt(chainAfterRestart.collateral) - BigInt(chainBefore.collateral)).toBe(crashBoundary.requestedAmount);
    expect(await countExactHankoBatchLogs(page, chainBefore.depository, hubId, crashBoundary.pending.batchHash)).toBe(1);

    await expect.poll(() => page.evaluate(({ entityId, hubId }) => {
      const env = (window as RebalanceWindow).__xln?.env();
      if (!env) throw new Error('REBALANCE_RECOVERED_RUNTIME_MISSING');
      const replica = [...env.state.eReplicas.values()].find(entry => entry.entityId === entityId);
      const account = replica?.state.accounts.get(hubId);
      if (!account) throw new Error('REBALANCE_RECOVERED_ACCOUNT_MISSING');
      return { retained: env.pendingNetworkOutputs?.length ?? 0, pendingAck: Boolean(account.pendingFrame) };
    }, { entityId, hubId }), { timeout: 15_000, intervals: [100, 250, 500] }).toEqual({ retained: 0, pendingAck: false });

    const readExactCycle = async () => (await readPersistedFrameEventsSinceCursor(page, {
      cursor: cycleCursor,
      entityId,
      eventNames: ['request_collateral_committed', 'account_settled_finalized_bilateral'],
    })).events.filter((event) => persistedEventHasAccountToken(event, hubId, USDC_TOKEN_ID));
    const durableCycle = await readExactCycle();
    expect(durableCycle.map((event) => event.message)).toEqual([
      'request_collateral_committed',
      'account_settled_finalized_bilateral',
    ]);

    await reloadRuntimeAndWaitReady(page, 'rebalance_persist.reload_user_after_finality');
    let finalState: Awaited<ReturnType<typeof readRebalanceState>> = null;
    await expect.poll(async () => {
      finalState = await readRebalanceState(page, hubId);
      return Boolean(finalState
        && BigInt(finalState.requested) === 0n
        && BigInt(finalState.uncollateralized) === 0n
        && Number(finalState.lastFinalizedJHeight) === minedJHeight);
    }, { timeout: 60_000, intervals: [250, 500, 1000] }).toBe(true);
    const finalClaimSnapshot = await readAccountJEventClaims(page, hubId);
    const finalClaims = (finalClaimSnapshot?.claims || []).filter((claim) =>
      claim.txHash.toLowerCase() === crashBoundary.pending.transactionHash.toLowerCase());
    expect(finalClaims).toHaveLength(2);

    const afterReloadCycle = await readExactCycle();
    expect(afterReloadCycle, 'journal order and receipts must survive user reload').toEqual(durableCycle);
    expect(finalizedReceipt.frameHeight).toBeGreaterThan(crashBoundary.trigger.committed.frameHeight);
    expect(Number(finalizedReceipt.data?.jHeight)).toBe(minedJHeight);
    expect(new Set(finalClaims.map((claim) => `${claim.txHash}:${claim.nonce}:${claim.jHeight}`)).size).toBe(1);
    for (const claim of finalClaims) {
      expect([claim.leftEntity, claim.rightEntity].sort()).toEqual([entityId.toLowerCase(), hubId.toLowerCase()].sort());
      expect(claim.jHeight).toBe(minedJHeight);
    }
    expect(BigInt(finalState!.collateral) - BigInt(baseline!.collateral)).toBe(crashBoundary.requestedAmount);
    expect((await readActiveChainRebalanceState(page, entityId, hubId)).collateral).toBe(finalState!.collateral);
    const finalHealth = await getHealth(page, API_BASE_URL);
    const recoveredH1 = finalHealth?.process?.children?.find(child => child.role === 'hub' && child.name === 'H1');
    await test.info().attach('mined-rebalance-recovery', {
      contentType: 'application/json',
      body: safeStringify({
        oldPid,
        recoveredPid: recoveredH1?.pid,
        oldRestartCount,
        restartCount: recoveredH1?.restartCount,
        userRuntimeId,
        chainBefore,
        chainAfterRestart,
        requestedAmount: crashBoundary.requestedAmount,
        batch: crashBoundary.pending,
        minedJHeight,
        finalState,
        finalClaims,
        durableCycle,
        afterReloadCycle,
      }),
    });
    expect(unexpectedUnavailableResponses, '503 is expected only for token discovery during the injected H1 outage').toEqual([]);
    expect(criticalConsole, `critical consensus/runtime errors:\n${criticalConsole.join('\n')}`).toEqual([]);
  });

  // Scenario: five faucets reach the inclusive 500 soft limit. Three more faucets while the
  // signed batch is held pending remain below a fresh soft limit and must not top it up.
  test(
    'edge: rapid 8 faucets keep the sub-soft tail out of the pending collateral batch',
    { tag: '@resilience' },
    async ({ page }) => {
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
      await timedStep('rebalance_edge.create_runtime', () =>
        createWalletIdentity(page, `rebalance-edge-pending-${Date.now()}`, nextRebalanceMnemonic()),
      );
      await timedStep('rebalance_edge.ensure_runtime_online', () =>
        ensureRuntimeOnline(page, 'edge-pending-post-create'),
      );

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
      if (!edgeBaseline) throw new Error('REBALANCE_EDGE_BASELINE_MISSING');
      const chainBefore = await readActiveChainRebalanceState(page, entityId, hubId);
      const pendingProof = await timedStep('rebalance_edge.hold_batch_through_tail', async () => {
        await callTestnetRpc<unknown>(page, 'evm_setAutomine', [false]);
        try {
          const firstTrigger = await driveFaucetsUntilRequestCollateralCommitted(page, {
            entityId,
            hubId,
            scenarioStartedAt,
            receiptCursor: edgeCursor,
          });
          expect(firstTrigger.faucets, 'the first request must start on the fifth 100-unit faucet').toBe(5);
          const requestedAmount = BigInt(String(firstTrigger.committed.data?.requestedAmount));
          expect(requestedAmount).toBeGreaterThan(0n);
          const pending = await waitForPendingRebalanceBatch(page, {
            chainId: chainBefore.chainId,
            depository: chainBefore.depository,
            entityId,
            expectedAmount: requestedAmount,
            hubId,
          });
          const tailStates: NonNullable<Awaited<ReturnType<typeof readRebalanceState>>>[] = [];
          for (let index = 0; index < 3; index++) {
            const before = await readRebalanceState(page, hubId);
            if (!before) throw new Error('REBALANCE_EDGE_PENDING_ACCOUNT_MISSING');
            expect(BigInt(before.requested)).toBe(requestedAmount);
            expect(BigInt(before.collateral)).toBe(BigInt(edgeBaseline.collateral));
            await faucet(page, entityId, hubId);
            await waitForRebalanceStateProgress(page, hubId, {
              currentHeight: before.currentHeight,
              uncollateralized: BigInt(before.uncollateralized),
              requested: BigInt(before.requested),
              collateral: BigInt(before.collateral),
              hubExposure: BigInt(before.hubExposure),
              outCapacity: BigInt(before.outCapacity),
            });
            await expect
              .poll(
                async () => {
                  const state = await readRebalanceState(page, hubId);
                  if (!state) throw new Error('REBALANCE_EDGE_TAIL_ACCOUNT_MISSING');
                  return {
                    requested: BigInt(state.requested),
                    collateral: BigInt(state.collateral),
                    out: BigInt(state.outCapacity),
                  };
                },
                { timeout: 15_000, intervals: [100, 250, 500] },
              )
              .toEqual({
                requested: requestedAmount,
                collateral: BigInt(edgeBaseline.collateral),
                out: BigInt(before.outCapacity) + 100n * USDC_UNIT,
              });
            const state = await readRebalanceState(page, hubId);
            if (!state) throw new Error('REBALANCE_EDGE_TAIL_ACCOUNT_MISSING');
            tailStates.push(state);
          }
          const stillPending = await waitForPendingRebalanceBatch(page, {
            chainId: chainBefore.chainId,
            depository: chainBefore.depository,
            entityId,
            expectedAmount: requestedAmount,
            hubId,
          });
          expect(stillPending, 'all eight faucets retain the exact signed pending batch').toEqual(pending);
          expect((await readActiveChainRebalanceState(page, entityId, hubId)).collateral).toBe(chainBefore.collateral);
          await callTestnetRpc<unknown>(page, 'anvil_mine', ['0x1']);
          const receipt = await waitForTransactionReceipt(page, pending.transactionHash);
          expect(receipt.status).toBe('0x1');
          return { firstTrigger, pending, receipt, tailStates };
        } finally {
          await callTestnetRpc<unknown>(page, 'evm_setAutomine', [true]);
        }
      });
      const firstRequestCommit = pendingProof.firstTrigger.committed;
      const pendingSnapshot = pendingProof.firstTrigger.snapshot;
      expect(pendingSnapshot, 'expected committed request before first finalize').toBeTruthy();
      const settlement = await waitForPersistedFrameEventMatch(page, {
        cursor: edgeCursor,
        eventName: 'account_settled_finalized_bilateral',
        entityId,
        timeoutMs: 60_000,
        predicate: event => persistedEventHasAccount(event, hubId),
      });
      const settled: { snapshot: Awaited<ReturnType<typeof readRebalanceState>> } = { snapshot: null };
      await expect
        .poll(
          async () => {
            settled.snapshot = await readRebalanceState(page, hubId);
            return (
              !!settled.snapshot &&
              BigInt(settled.snapshot.requested || '0') === 0n &&
              Number(settled.snapshot.lastFinalizedJHeight || 0) > Number(edgeBaseline?.lastFinalizedJHeight || 0)
            );
          },
          { timeout: 30_000, intervals: [250, 500, 1000] },
        )
        .toBe(true);
      const persisted = await readPersistedFrameEventsSinceCursor(page, {
        cursor: edgeCursor,
        eventNames: ['request_collateral_committed'],
        entityId,
      });
      const requestCommits = persisted.events.filter(event => persistedEventHasAccount(event, hubId));
      const diagnostics = await readRebalanceDiagnostics(page, hubId);
      const { phaseMarkers, debugErrors, frameEvents } = await collectRebalanceDebugArtifacts(
        page,
        scenarioStartedAt,
        hubId,
      );
      const debugDump = buildRebalanceFailureDump({
        entityId,
        hubId,
        snapshot: settled.snapshot,
        diagnostics,
        rebalanceSteps: [],
        stateTimeline: [
          { atMs: 'pending-request', ...pendingSnapshot },
          { atMs: 'settled', ...settled.snapshot },
        ],
        rebalanceConsole: [],
        phaseMarkers,
        debugErrors,
        frameEvents,
      });
      expect(
        requestCommits.length,
        `clicks six through eight must not create a second durable collateral request\n${debugDump}`,
      ).toBe(1);
      expect(
        settlement.frameHeight > firstRequestCommit.frameHeight,
        `settlement must follow the durable collateral request\n${debugDump}`,
      ).toBe(true);
      const requestData = firstRequestCommit.data;
      if (typeof requestData?.requestedAmount !== 'string' || typeof requestData.prepaidFee !== 'string') {
        throw new Error('Committed collateral request must contain exact amount and prepaid fee strings');
      }
      const requestedAmount = BigInt(requestData.requestedAmount);
      expect(requestedAmount, `durable request amount must be positive\n${debugDump}`).toBeGreaterThan(0n);
      expect(
        BigInt(settled.snapshot?.collateral || '0') - BigInt(edgeBaseline?.collateral || '0'),
        `one request must produce one exact collateral increase\n${debugDump}`,
      ).toBe(requestedAmount);
      expect(pendingProof.firstTrigger.faucets + pendingProof.tailStates.length).toBe(8);
      expect(BigInt(settled.snapshot?.uncollateralized ?? '')).toBe(300n * USDC_UNIT);
      expect(BigInt(settled.snapshot?.hubDebt ?? '')).toBe(300n * USDC_UNIT);
      expect(BigInt(settled.snapshot?.outCapacity ?? '') - BigInt(edgeBaseline.outCapacity)).toBe(
        800n * USDC_UNIT - BigInt(requestData.prepaidFee),
      );
      expect(await countExactHankoBatchLogs(page, chainBefore.depository, hubId, pendingProof.pending.batchHash)).toBe(
        1,
      );
      await page.getByTestId('nav-home').locator('visible=true').first().click();
      await expect(page.getByTestId('home-risk').locator('strong')).toHaveText('$300.00');
      await expect(page.getByTestId('home-secured').locator('strong')).toHaveText(
        `$${Number(ethers.formatUnits(requestedAmount, USDC_DECIMALS)).toFixed(2)}`,
      );
      await test.info().attach('pending-rebalance-tail', {
        contentType: 'application/json',
        body: safeStringify({ pendingProof, chainBefore, settled: settled.snapshot, requestCommits, settlement }),
      });
    },
  );

  // Exercise actual chain R2C -> C2R -> R2C, including the strict C2R threshold.
  test('cycle R2C -> C2R -> R2C (100ms action cadence)', { tag: '@functional' }, async ({ page }) => {
    await timedStep('rebalance_cycle.reset_server', () => resetProdServer(page));
    await gotoApp(page);
    await createWalletIdentity(page, `rebalance-cycle-${Date.now()}`, nextRebalanceMnemonic());
    await ensureRuntimeOnline(page, 'cycle-post-create');
    const { entityId, signerId } = await getLocalEntity(page);
    const hubId = await discoverHub(page);
    await waitForHubProfile(page, hubId);
    await connectHub(page, entityId, signerId, hubId);
    const scenarioStartedAt = Date.now();
    type Snapshot = NonNullable<Awaited<ReturnType<typeof readRebalanceState>>>;
    const readState = async (): Promise<Snapshot> => {
      const snapshot = await readRebalanceState(page, hubId);
      if (!snapshot) throw new Error('REBALANCE_CYCLE_ACCOUNT_MISSING');
      return snapshot;
    };
    const waitForState = async (predicate: (snapshot: Snapshot) => boolean) => {
      const observed = { snapshot: await readState() };
      await expect
        .poll(
          async () => {
            observed.snapshot = await readState();
            return predicate(observed.snapshot);
          },
          { timeout: 30_000, intervals: [100, 250, 500] },
        )
        .toBe(true);
      return observed.snapshot;
    };
    const settleR2C = async () => {
      const before = await readState();
      const cursor = await getPersistedReceiptCursor(page);
      const trigger = await driveFaucetsUntilRequestCollateralCommitted(page, {
        entityId,
        hubId,
        scenarioStartedAt,
        receiptCursor: cursor,
      });
      const snapshot = await waitForState(
        state =>
          BigInt(state.requested) === 0n &&
          BigInt(state.uncollateralized) === 0n &&
          BigInt(state.collateral) > BigInt(before.collateral) &&
          state.lastFinalizedJHeight > before.lastFinalizedJHeight,
      );
      const settlement = await waitForPersistedFrameEventMatch(page, {
        cursor,
        eventName: 'account_settled_finalized_bilateral',
        entityId,
        timeoutMs: 30_000,
        predicate: event => persistedEventHasAccountToken(event, hubId, USDC_TOKEN_ID),
      });
      expect(trigger.faucets).toBe(5);
      expect(settlement.frameHeight).toBeGreaterThan(trigger.committed.frameHeight);
      return { trigger, snapshot, settlement };
    };

    // One request nets499.85USDC, below the unchanged500USDC C2R threshold.
    // Two authentic cycles provide enough collateral to exercise a real withdrawal.
    const first = await settleR2C();
    const second = await settleR2C();
    const chainBefore = await readActiveChainRebalanceState(page, entityId, hubId);
    expect(BigInt(chainBefore.collateral)).toBe(999_700_000n);
    expect(BigInt(second.snapshot.outCapacity)).toBe(999_700_000n);
    const reserveInterface = new ethers.Interface([
      'function _reserves(bytes32 entity,uint256 tokenId) view returns (uint256)',
    ]);
    const readHubReserve = async () => {
      const data = reserveInterface.encodeFunctionData('_reserves', [hubId, USDC_TOKEN_ID]);
      const raw = await callTestnetRpc<string>(page, 'eth_call', [
        { to: chainBefore.depository, data },
        'latest',
      ]);
      return String(reserveInterface.decodeFunctionResult('_reserves', raw)[0]);
    };
    const reserveBefore = await readHubReserve();
    const c2rCursor = await getPersistedReceiptCursor(page);
    const repayments: Snapshot[] = [];
    // Both Entity orderings repay the same economic debt. Account authority is unchanged.
    for (let i = 1; i <= 6; i++) {
      const before = await readState();
      await sendDirectPaymentToHub(page, entityId, signerId, hubId, 100n);
      await page.waitForTimeout(100);
      const snapshot = await waitForState(
        state =>
          state.currentHeight > before.currentHeight &&
          BigInt(state.outCapacity) === BigInt(before.outCapacity) - 100n * USDC_UNIT &&
          BigInt(state.outTotalHold) === 0n &&
          BigInt(state.hubOutTotalHold) === 0n,
      );
      repayments.push(snapshot);
      if (i <= 5) {
        expect(BigInt(snapshot.hubFreeOutCollateral)).toBe(BigInt(i) * 100n * USDC_UNIT);
        expect((await readActiveChainRebalanceState(page, entityId, hubId)).collateral).toBe(
          chainBefore.collateral,
        );
        expect(await readHubReserve()).toBe(reserveBefore);
      }
    }
    const c2r = await waitForState(
      state =>
        state.lastFinalizedJHeight > second.snapshot.lastFinalizedJHeight &&
        BigInt(state.hubFreeOutCollateral) === 0n &&
        BigInt(state.leftPendingJClaims) === 0n &&
        BigInt(state.rightPendingJClaims) === 0n,
    );
    const c2rSettlement = await waitForPersistedFrameEventMatch(page, {
      cursor: c2rCursor,
      eventName: 'account_settled_finalized_bilateral',
      entityId,
      timeoutMs: 30_000,
      predicate: event => persistedEventHasAccountToken(event, hubId, USDC_TOKEN_ID),
    });
    const chainAfter = await readActiveChainRebalanceState(page, entityId, hubId);
    const reserveAfter = await readHubReserve();
    expect(BigInt(chainBefore.collateral) - BigInt(chainAfter.collateral)).toBe(600n * USDC_UNIT);
    expect(BigInt(reserveAfter) - BigInt(reserveBefore)).toBe(600n * USDC_UNIT);
    expect(BigInt(c2r.outCapacity)).toBe(399_700_000n);
    expect(BigInt(c2r.uncollateralized)).toBe(0n);
    const history = await readAccountJEventClaims(page, hubId);
    if (!history) throw new Error('REBALANCE_CYCLE_CLAIMS_MISSING');
    const claims = history.claims.filter(claim => claim.jHeight === c2r.lastFinalizedJHeight);
    expect(claims).toHaveLength(2);
    const claim = claims[0];
    if (!claim) throw new Error('REBALANCE_CYCLE_C2R_CLAIM_MISSING');
    expect(new Set(claims.map(entry => `${entry.txHash}:${entry.nonce}:${entry.jHeight}`)).size).toBe(1);
    for (const entry of claims) {
      expect(entry.collateral).toBe(chainAfter.collateral);
      expect([entry.leftEntity, entry.rightEntity].sort()).toEqual(
        [entityId.toLowerCase(), hubId.toLowerCase()].sort(),
      );
    }
    const receipt = await waitForTransactionReceipt(page, claim.txHash);
    expect(BigInt(receipt.status ?? '0')).toBe(1n);
    expect(Number(BigInt(receipt.blockNumber ?? '0'))).toBe(c2r.lastFinalizedJHeight);

    const third = await settleR2C();
    expect(third.settlement.frameHeight).toBeGreaterThan(c2rSettlement.frameHeight);
    expect(c2rSettlement.frameHeight).toBeGreaterThan(second.settlement.frameHeight);
    const finalChain = await readActiveChainRebalanceState(page, entityId, hubId);
    expect(BigInt(finalChain.collateral) - BigInt(chainAfter.collateral)).toBe(499_850_000n);
    expect(BigInt(third.snapshot.collateral)).toBe(899_550_000n);
    expect(BigInt(third.snapshot.uncollateralized)).toBe(0n);
    await page.getByTestId('nav-home').locator('visible=true').first().click();
    await expect(page.getByTestId('home-risk').locator('strong')).toHaveText('$0.00');
    await expect(page.getByTestId('home-secured').locator('strong')).toHaveText('$899.55');
    await page.screenshot({ path: 'test-results/rebalance-cycle-r2c-c2r-r2c.png', fullPage: true });
    await test.info().attach('rebalance-chain-cycle', {
      contentType: 'application/json',
      body: safeStringify({
        first,
        second,
        repayments,
        c2r,
        c2rSettlement,
        claims,
        receipt,
        chainBefore,
        chainAfter,
        reserveBefore,
        reserveAfter,
        third,
        finalChain,
      }),
    });
  });

  // Hold the actual H2 R2C pending:550 fits once, then fits again only after chain finality.
  test(
    'rt1->h1->h2->rt2: second 550 fails before rebalance, passes after H2 R2C',
    { tag: '@resilience' },
    async ({ browser, page }) => {
      let senderContext: BrowserContext | null = null;
      let recipientContext: BrowserContext | null = null;
      let miningHeld = false;
      try {
        await resetProdServer(page);
        const sender = await createLiveRuntimePage(
          browser,
          `rt1-h1h2-${Date.now()}`,
          nextRebalanceMnemonic(),
        );
        senderContext = sender.context;
        const recipient = await createLiveRuntimePage(
          browser,
          `rt2-h1h2-${Date.now()}`,
          nextRebalanceMnemonic(),
        );
        recipientContext = recipient.context;
        const senderPage = sender.page;
        const recipientPage = recipient.page;
        const rt1 = sender.entity;
        const rt2 = recipient.entity;
        expect(rt1.entityId.toLowerCase()).not.toBe(rt2.entityId.toLowerCase());
        const { h1, h2 } = await discoverH1H2(recipientPage);
        const route = [rt1.entityId, h1, h2, rt2.entityId];
        await Promise.all([
          waitForHubProfile(senderPage, h1),
          waitForHubProfile(senderPage, h2),
          waitForHubProfile(recipientPage, h1),
          waitForHubProfile(recipientPage, h2),
          waitForEntityAdvertised(senderPage, rt2.entityId),
          waitForEntityAdvertised(recipientPage, rt1.entityId),
        ]);
        await connectHubWithCredit(recipientPage, rt2.entityId, rt2.signerId, h2, 1_000n);
        await setRebalancePolicy(recipientPage, rt2.entityId, rt2.signerId, h2, 500n, 10_000n, 20n);
        await waitForPairIdle(recipientPage, h2, 20_000, rt2.entityId);
        await connectHubWithCredit(senderPage, rt1.entityId, rt1.signerId, h1, 10_000n);
        // Keep sender funding inside its existing credit line: otherwise the first payment
        // starts an unrelated H1 C2R that blocks the sender while H2 mining is held.
        await setRebalancePolicy(senderPage, rt1.entityId, rt1.signerId, h1, 10_000n, 10_000n, 20n);
        await faucet(senderPage, rt1.entityId, h1, '2000');
        const senderBefore = await waitForFundingLiquidityReady(senderPage, h1, 0n, 30_000, rt1.entityId);
        expect(BigInt(senderBefore.collateral)).toBe(0n);
        expect(BigInt(senderBefore.outCapacity)).toBe(2_000n * USDC_UNIT);
        const receiverBefore = await readPairState(recipientPage, h2, rt2.entityId);
        if (!receiverBefore) throw new Error('ROUTED_RECIPIENT_ACCOUNT_MISSING');
        expect(BigInt(receiverBefore.inCapacity)).toBe(1_000n * USDC_UNIT);
        const recipientCursor = await getPersistedReceiptCursor(recipientPage);
        const senderCursor = await getPersistedReceiptCursor(senderPage);
        const chainBefore = await readActiveChainRebalanceState(recipientPage, rt2.entityId, h2);
        await callTestnetRpc<unknown>(page, 'evm_setAutomine', [false]);
        miningHeld = true;
        const firstQuote = await sendRoutedHtlcPayment(
          senderPage,
          rt1.entityId,
          rt1.signerId,
          rt2.entityId,
          route,
          550n,
          'H1-H2 payment before rebalance',
        );
        const [firstSent, firstReceived, request] = await Promise.all([
          waitForPersistedFrameEventMatch(senderPage, {
            cursor: senderCursor,
            eventName: 'HtlcFinalized',
            entityId: rt1.entityId,
            predicate: event => String(event.data?.amount) === '550000000',
            timeoutMs: 20_000,
          }),
          waitForPersistedFrameEventMatch(recipientPage, {
            cursor: recipientCursor,
            eventName: 'HtlcReceived',
            entityId: rt2.entityId,
            predicate: event => String(event.data?.amount) === '550000000',
            timeoutMs: 20_000,
          }),
          waitForPersistedFrameEventMatch(recipientPage, {
            cursor: recipientCursor,
            eventName: 'request_collateral_committed',
            entityId: rt2.entityId,
            predicate: event => persistedEventHasAccountToken(event, h2, USDC_TOKEN_ID),
            timeoutMs: 20_000,
          }),
        ]);
        const data = request.data;
        if (typeof data?.requestedAmount !== 'string' || typeof data.prepaidFee !== 'string')
          throw new Error('ROUTED_REBALANCE_REQUEST_AMOUNT_MISSING');
        expect(BigInt(data.requestedAmount) + BigInt(data.prepaidFee)).toBe(550n * USDC_UNIT);
        const pendingInput = {
          ...chainBefore,
          entityId: rt2.entityId,
          hubId: h2,
          expectedAmount: BigInt(data.requestedAmount),
        };
        const pending = await waitForPendingRebalanceBatch(page, pendingInput);
        const firstPayment = await readCommittedPayment(senderPage, rt1.entityId, senderCursor.nextHeight);
        expect(firstPayment.senderAmount).toBe(firstQuote.senderAmount);
        expect(firstPayment.hashlock).toBe(String(firstReceived.data?.hashlock));
        expect(String(firstSent.data?.toEntity).toLowerCase()).toBe(h1.toLowerCase());
        expect(String(firstReceived.data?.fromEntity).toLowerCase()).toBe(h2.toLowerCase());
        const senderAfterFirst = await waitForPairIdle(senderPage, h1, 20_000, rt1.entityId);
        const receiverPending = await waitForPairIdle(recipientPage, h2, 20_000, rt2.entityId);
        expect(BigInt(senderBefore.outCapacity) - BigInt(senderAfterFirst.outCapacity)).toBe(
          BigInt(firstPayment.senderAmount),
        );
        expect(BigInt(receiverPending.outCapacity) - BigInt(receiverBefore.outCapacity)).toBe(
          BigInt(data.requestedAmount),
        );
        expect(BigInt(receiverPending.inCapacity)).toBeLessThan(550n * USDC_UNIT);
        expect(receiverPending.lastFinalizedJHeight).toBe(receiverBefore.lastFinalizedJHeight);
        const rejectedSenderCursor = await getPersistedReceiptCursor(senderPage);
        const rejectedRecipientCursor = await getPersistedReceiptCursor(recipientPage);
        const rejectedQuote = await sendRoutedHtlcPayment(
          senderPage,
          rt1.entityId,
          rt1.signerId,
          rt2.entityId,
          route,
          550n,
          'H1-H2 rejected before rebalance',
        );
        const rejection = await waitForPersistedFrameEventMatch(senderPage, {
          cursor: rejectedSenderCursor,
          entityId: rt1.entityId,
          eventName: 'HtlcFailed',
          timeoutMs: 20_000,
        });
        const senderAfterReject = await waitForPairIdle(senderPage, h1, 20_000, rt1.entityId);
        const receiverAfterReject = await readPairState(recipientPage, h2, rt2.entityId);
        expect(senderAfterReject.outCapacity).toBe(senderAfterFirst.outCapacity);
        expect(senderAfterReject.mempoolLen).toBe(0);
        expect(receiverAfterReject).toEqual(receiverPending);
        const rejectedEvents = await readPersistedFrameEventsSinceCursor(senderPage, {
          cursor: rejectedSenderCursor,
          entityId: rt1.entityId,
          eventNames: ['HtlcInitiated', 'HtlcFinalized', 'HtlcFailed'],
        });
        expect(rejectedEvents.events.map(event => event.message)).toEqual(['HtlcInitiated', 'HtlcFailed']);
        expect(rejectedEvents.events[0]?.data?.hashlock).toBe(rejection.data?.hashlock);
        expect(rejectedEvents.events[0]?.data?.senderAmount).toBe(rejectedQuote.senderAmount);
        console.log('[rebalance-route-rejection]', safeStringify(rejection));
        expect(
          (
            await readPersistedFrameEventsSinceCursor(recipientPage, {
              cursor: rejectedRecipientCursor,
              entityId: rt2.entityId,
              eventNames: ['HtlcReceived', 'account_settled_finalized_bilateral'],
            })
          ).events,
        ).toHaveLength(0);
        expect(await waitForPendingRebalanceBatch(page, pendingInput)).toEqual(pending);
        expect((await readActiveChainRebalanceState(recipientPage, rt2.entityId, h2)).collateral).toBe(
          chainBefore.collateral,
        );
        await callTestnetRpc<unknown>(page, 'evm_mine');
        const receipt = await waitForTransactionReceipt(page, pending.transactionHash);
        expect(BigInt(receipt.status ?? '0')).toBe(1n);
        await callTestnetRpc<unknown>(page, 'evm_setAutomine', [true]);
        miningHeld = false;
        const settlement = await waitForPersistedFrameEventMatch(recipientPage, {
          cursor: recipientCursor,
          eventName: 'account_settled_finalized_bilateral',
          entityId: rt2.entityId,
          predicate: event => persistedEventHasAccountToken(event, h2, USDC_TOKEN_ID),
          timeoutMs: 20_000,
        });
        expect(settlement.frameHeight).toBeGreaterThan(request.frameHeight);
        const ready = await waitForRebalanceReceiveReady(recipientPage, {
          localAccountId: rt2.entityId,
          hubAccountId: h2,
          requiredInCapacity: usdcUnits(550n),
          minLocalFinalizedJHeight: receiverBefore.lastFinalizedJHeight,
          timeoutMs: 20_000,
        });
        expect(Number(BigInt(receipt.blockNumber ?? '0'))).toBe(ready.lastFinalizedJHeight);
        expect(
          BigInt((await readActiveChainRebalanceState(recipientPage, rt2.entityId, h2)).collateral) -
            BigInt(chainBefore.collateral),
        ).toBe(BigInt(data.requestedAmount));
        expect(await countExactHankoBatchLogs(page, chainBefore.depository, h2, pending.batchHash)).toBe(1);
        const secondSenderCursor = await getPersistedReceiptCursor(senderPage);
        const secondRecipientCursor = await getPersistedReceiptCursor(recipientPage);
        const secondQuote = await sendRoutedHtlcPayment(
          senderPage,
          rt1.entityId,
          rt1.signerId,
          rt2.entityId,
          route,
          550n,
          'H1-H2 payment after rebalance',
        );
        const [secondSent, secondReceived] = await Promise.all([
          waitForPersistedFrameEventMatch(senderPage, {
            cursor: secondSenderCursor,
            eventName: 'HtlcFinalized',
            entityId: rt1.entityId,
            predicate: event => String(event.data?.amount) === '550000000',
            timeoutMs: 20_000,
          }),
          waitForPersistedFrameEventMatch(recipientPage, {
            cursor: secondRecipientCursor,
            eventName: 'HtlcReceived',
            entityId: rt2.entityId,
            predicate: event => String(event.data?.amount) === '550000000',
            timeoutMs: 20_000,
          }),
        ]);
        const secondPayment = await readCommittedPayment(
          senderPage,
          rt1.entityId,
          secondSenderCursor.nextHeight,
        );
        expect(secondPayment.senderAmount).toBe(secondQuote.senderAmount);
        expect(secondPayment.hashlock).toBe(String(secondReceived.data?.hashlock));
        expect(secondPayment.hashlock).not.toBe(firstPayment.hashlock);
        expect(secondReceived.frameHeight).toBeGreaterThan(settlement.frameHeight);
        expect(String(secondSent.data?.toEntity).toLowerCase()).toBe(h1.toLowerCase());
        expect(String(secondReceived.data?.fromEntity).toLowerCase()).toBe(h2.toLowerCase());
        const senderFinal = await waitForPairIdle(senderPage, h1, 20_000, rt1.entityId);
        expect(BigInt(senderBefore.outCapacity) - BigInt(senderFinal.outCapacity)).toBe(
          BigInt(firstPayment.senderAmount) + BigInt(secondPayment.senderAmount),
        );
        const receivedEvents = await readPersistedFrameEventsSinceCursor(recipientPage, {
          cursor: recipientCursor,
          entityId: rt2.entityId,
          eventNames: ['HtlcReceived'],
        });
        expect(receivedEvents.events).toHaveLength(2);
        expect(receivedEvents.events.map(event => String(event.data?.amount))).toEqual([
          '550000000',
          '550000000',
        ]);
        await test.info().attach('routed-rebalance-window', {
          contentType: 'application/json',
          body: safeStringify({
            route,
            firstQuote,
            rejectedQuote,
            secondQuote,
            firstPayment,
            secondPayment,
            senderBefore,
            senderAfterFirst,
            senderAfterReject,
            receiverAfterReject,
            senderFinal,
            receiverBefore,
            receiverPending,
            ready,
            rejection,
            pending,
            receipt,
            request,
            settlement,
            firstReceivedHeight: firstReceived.frameHeight,
            secondReceivedHeight: secondReceived.frameHeight,
          }),
        });
        await recipientPage.screenshot({ path: 'test-results/rebalance-rt1-h1-h2-rt2.png', fullPage: true });
      } finally {
        if (miningHeld) await callTestnetRpc<unknown>(page, 'evm_setAutomine', [true]);
        await senderContext?.close();
        await recipientContext?.close();
      }
    },
  );

  // Scenario: same routed-capacity cliff as above, but through H3 with asymmetric hub credit so we
  // prove the failure/recovery logic is not specific to one hub pair.
  test(
    'runtime2: H1=10k, H3=1k; second 550 via H3 fails before rebalance, passes after',
    { tag: '@resilience' },
    async ({ browser, page }) => {
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
        await faucet(senderPage, rt1.entityId, h3, '2000');
        await waitForFundingLiquidityReady(
          senderPage,
          h3,
          BigInt(h3BeforeFaucet?.outCapacity || '0'),
          180_000,
          rt1.entityId,
        );

        const baseline = await readPairState(recipientPage, h3, rt2.entityId);
        expect(baseline, 'runtime2-h3 baseline must exist').toBeTruthy();
        if (!baseline) throw new Error('H3_BASELINE_ACCOUNT_MISSING');
        expect(BigInt(baseline.inCapacity)).toBe(usdcUnits(1_000n));
        const unusedH1 = await readPairState(recipientPage, h1, rt2.entityId);
        if (!unusedH1) throw new Error('H1_BASELINE_ACCOUNT_MISSING');
        expect(BigInt(unusedH1.inCapacity)).toBe(usdcUnits(10_000n));
        const senderBefore = await waitForPairIdle(senderPage, h3, 20_000, rt1.entityId);
        const firstSenderCursor = await getPersistedReceiptCursor(senderPage);
        const allRecipientCursor = await getPersistedReceiptCursor(recipientPage);

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

        await waitForPersistedFrameEventMatch(senderPage, {
          cursor: firstSenderCursor,
          entityId: rt1.entityId,
          eventName: 'HtlcFinalized',
          predicate: event => String(event.data?.amount) === '550000000',
          timeoutMs: 20_000,
        });
        const firstReceived = await waitForPersistedFrameEventMatch(recipientPage, {
          cursor: allRecipientCursor,
          entityId: rt2.entityId,
          eventName: 'HtlcReceived',
          predicate: event => String(event.data?.amount) === '550000000',
          timeoutMs: 20_000,
        });
        const firstPayment = await readCommittedPayment(
          senderPage,
          rt1.entityId,
          firstSenderCursor.nextHeight,
        );
        expect(firstPayment.hashlock).toBe(firstReceived.data?.hashlock);
        expect(String(firstReceived.data?.fromEntity).toLowerCase()).toBe(h3.toLowerCase());
        const afterP1 = await waitForPairIdle(recipientPage, h3, 20_000, rt2.entityId);
        expect(BigInt(afterP1.outCapacity) - BigInt(baseline.outCapacity)).toBe(usdcUnits(550n));
        expect(BigInt(afterP1.inCapacity)).toBe(usdcUnits(450n));
        expect(afterP1.requested).toBe('0');
        expect(afterP1.lastFinalizedJHeight).toBe(baseline.lastFinalizedJHeight);
        const beforeReject = await waitForPairIdle(senderPage, h3, 20_000, rt1.entityId);
        expect(BigInt(senderBefore.outCapacity) - BigInt(beforeReject.outCapacity)).toBe(
          BigInt(firstPayment.senderAmount),
        );
        const rt2P2Cursor = await getPersistedReceiptCursor(recipientPage);
        const rejectedSenderCursor = await getPersistedReceiptCursor(senderPage);
        await sendRoutedHtlcPayment(
          senderPage,
          rt1.entityId,
          rt1.signerId,
          rt2.entityId,
          [rt1.entityId, h3, rt2.entityId],
          550n,
          'H3 rejected before policy change',
        );
        const rejected = await waitForPersistedFrameEventMatch(senderPage, {
          cursor: rejectedSenderCursor,
          entityId: rt1.entityId,
          eventName: 'HtlcFailed',
          timeoutMs: 20_000,
        });
        const failedEvents = await readPersistedFrameEventsSinceCursor(senderPage, {
          cursor: rejectedSenderCursor,
          entityId: rt1.entityId,
          eventNames: ['HtlcInitiated', 'HtlcFinalized', 'HtlcFailed'],
        });
        expect(failedEvents.events.map(event => event.message)).toEqual(['HtlcInitiated', 'HtlcFailed']);
        expect(failedEvents.events[0]?.data?.hashlock).toBe(rejected.data?.hashlock);
        const afterReject = await waitForPairIdle(senderPage, h3, 20_000, rt1.entityId);
        expect(afterReject.outCapacity).toBe(beforeReject.outCapacity);
        expect(afterReject.mempoolLen).toBe(0);
        const afterP2 = await readPairState(recipientPage, h3, rt2.entityId);
        expect(afterP2).toEqual(afterP1);
        expect(
          (
            await readPersistedFrameEventsSinceCursor(recipientPage, {
              cursor: rt2P2Cursor,
              entityId: rt2.entityId,
              eventNames: ['HtlcReceived', 'account_settled_finalized_bilateral'],
            })
          ).events,
        ).toHaveLength(0);
        expect(await readPairState(recipientPage, h1, rt2.entityId)).toEqual(unusedH1);
        const chainBefore = await readActiveChainRebalanceState(recipientPage, rt2.entityId, h3);
        const h3FinalizedJHeightBeforeRebalance = Number(afterP2?.lastFinalizedJHeight || 0);
        await setRebalancePolicy(recipientPage, rt2.entityId, rt2.signerId, h3, 500n, 10_000n, 20n);
        const rebDone = await waitForRebalanceReceiveReady(recipientPage, {
          localAccountId: rt2.entityId,
          hubAccountId: h3,
          requiredInCapacity: usdcUnits(550n),
          minLocalFinalizedJHeight: h3FinalizedJHeightBeforeRebalance,
        });

        const firstSettlement = await waitForPersistedFrameEventMatch(recipientPage, {
          cursor: rt2P2Cursor,
          entityId: rt2.entityId,
          eventName: 'account_settled_finalized_bilateral',
          predicate: event => persistedEventHasAccountToken(event, h3, USDC_TOKEN_ID),
          timeoutMs: 20_000,
        });
        const chainReady = await readActiveChainRebalanceState(recipientPage, rt2.entityId, h3);
        expect(BigInt(chainReady.collateral) - BigInt(chainBefore.collateral)).toBe(549_845_000n);
        const lastSenderCursor = await getPersistedReceiptCursor(senderPage);
        const lastRecipientCursor = await getPersistedReceiptCursor(recipientPage);
        await waitForPairIdle(senderPage, h3, 20_000, rt1.entityId);
        await sendRoutedHtlcPayment(
          senderPage,
          rt1.entityId,
          rt1.signerId,
          rt2.entityId,
          [rt1.entityId, h3, rt2.entityId],
          550n,
          'rt1->rt2 via h3 htlc #3 post-rebalance',
        );

        await waitForPersistedFrameEventMatch(senderPage, {
          cursor: lastSenderCursor,
          entityId: rt1.entityId,
          eventName: 'HtlcFinalized',
          predicate: event => String(event.data?.amount) === '550000000',
          timeoutMs: 20_000,
        });
        const lastReceived = await waitForPersistedFrameEventMatch(recipientPage, {
          cursor: lastRecipientCursor,
          entityId: rt2.entityId,
          eventName: 'HtlcReceived',
          predicate: event => String(event.data?.amount) === '550000000',
          timeoutMs: 20_000,
        });
        const lastPayment = await readCommittedPayment(senderPage, rt1.entityId, lastSenderCursor.nextHeight);
        expect(lastPayment.hashlock).toBe(lastReceived.data?.hashlock);
        expect(lastPayment.hashlock).not.toBe(firstPayment.hashlock);
        expect(lastReceived.frameHeight).toBeGreaterThan(firstSettlement.frameHeight);
        const finalSender = await waitForPairIdle(senderPage, h3, 20_000, rt1.entityId);
        expect(BigInt(senderBefore.outCapacity) - BigInt(finalSender.outCapacity)).toBe(
          BigInt(firstPayment.senderAmount) + BigInt(lastPayment.senderAmount),
        );
        const finalReceiver = await waitForFundingLiquidityReady(
          recipientPage,
          h3,
          BigInt(rebDone.outCapacity),
          20_000,
          rt2.entityId,
        );
        const records = await readPersistedFrameEventsSinceCursor(recipientPage, {
          cursor: allRecipientCursor,
          entityId: rt2.entityId,
          eventNames: ['HtlcReceived', 'request_collateral_committed', 'account_settled_finalized_bilateral'],
        });
        const received = records.events.filter(event => event.message === 'HtlcReceived');
        const requests = records.events.filter(
          event =>
            event.message === 'request_collateral_committed' &&
            persistedEventHasAccountToken(event, h3, USDC_TOKEN_ID),
        );
        expect(received.map(event => String(event.data?.amount))).toEqual(['550000000', '550000000']);
        expect(requests).toHaveLength(2);
        let prepaidFees = 0n;
        for (const request of requests) {
          if (typeof request.data?.prepaidFee !== 'string') throw new Error('H3_REBALANCE_FEE_MISSING');
          prepaidFees += BigInt(request.data.prepaidFee);
        }
        expect(BigInt(finalReceiver.outCapacity) - BigInt(baseline.outCapacity)).toBe(
          usdcUnits(1_100n) - prepaidFees,
        );
        expect(await readPairState(recipientPage, h1, rt2.entityId)).toEqual(unusedH1);
        await test.info().attach('asymmetric-h3-rebalance', {
          contentType: 'application/json',
          body: safeStringify({
            h1,
            h3,
            unusedH1,
            baseline,
            senderBefore,
            beforeReject,
            afterReject,
            rejected,
            firstPayment,
            lastPayment,
            afterP1,
            afterP2,
            rebDone,
            finalSender,
            finalReceiver,
            chainBefore,
            chainReady,
            firstSettlement,
            firstReceivedHeight: firstReceived.frameHeight,
            lastReceivedHeight: lastReceived.frameHeight,
            requests,
            prepaidFees,
          }),
        });
        await recipientPage.screenshot({ path: 'test-results/rebalance-asymmetric-h3.png', fullPage: true });
      } finally {
        await senderContext?.close();
        await recipientContext?.close();
      }
    },
  );
});
