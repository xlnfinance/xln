import { importStackPhraseUi } from '../ui/tests/wallet-ui';
import type { RuntimeReplica } from '../core/runtime/types';
import type { XLNModule } from '../core/api/public/runtime-module';
import { HDNodeWallet, Mnemonic, getIndexedAccountPath } from 'ethers';
import { deriveDelta, getTokenInfo } from '../core/account/utils';
import { defaultAccountDisputeConfigForParties } from '../core/account/config/dispute-config';
import { deriveJurisdictionSignerIndex } from '../core/jurisdiction/machine/config/signer-derivation';
import type { MarketSnapshotPayload } from '../core/network/relay/market/snapshot';
import { expect, type Page } from './global-setup.mts';
export { aggregateExpectedCrossBookDepth } from './utils/e2e-cross-book-depth';
import { type E2EHealthResponse } from './utils/e2e-baseline';
import { requireIsolatedBaseUrl } from './utils/runtime/e2e-isolated-env';
import { enqueueEntityTxs } from './utils/runtime/e2e-runtime-input';

export const INIT_TIMEOUT = 30_000;

export const APP_BASE_URL = requireIsolatedBaseUrl('E2E_BASE_URL');

export const API_BASE_URL = requireIsolatedBaseUrl('E2E_API_BASE_URL');

export const SWAP_TOKENS = [1, 2, 3] as const;

export const DEFAULT_USDC_REBALANCE_SOFT_LIMIT = 500n * 10n ** 6n;

export const USDC = 1;

export const WETH = 2;

export const USDT = 3;

export const tokenAmount = (tokenId: number, wholeTokens: bigint): bigint =>
  wholeTokens * 10n ** BigInt(getTokenInfo(tokenId).decimals);

export const TOKEN_SYMBOL_BY_ID: Record<number, string> = {
  [USDC]: 'USDC',
  [WETH]: 'WETH',
  [USDT]: 'USDT',
};

export const CROSS_J_SOURCE_COMMITTED_OR_ADVANCED_STATUSES = new Set([
  'resting',
  'partially_filled',
  'clear_requested',
  'clearing',
  'settled',
]);

export type BrowserConsoleGuard = {
  errors: string[];
  warnings: string[];
};

export function isIgnoredBrowserConsoleMessage(text: string): boolean {
  return /chrome-extension:|moz-extension:|safari-web-extension:|inpageBootstrap\.js|Ignoring Event: localhost/i.test(
    text,
  );
}

export function attachBrowserConsoleGuard(page: Page): BrowserConsoleGuard {
  const guard: BrowserConsoleGuard = {
    errors: [],
    warnings: [],
  };
  page.on('console', message => {
    const location = message.location();
    const suffix = location.url ? ` @ ${location.url}:${location.lineNumber}:${location.columnNumber}` : '';
    const text = `${message.text()}${suffix}`;
    if (isIgnoredBrowserConsoleMessage(text)) return;
    if (message.type() === 'error') guard.errors.push(text);
    if (message.type() === 'warning') guard.warnings.push(text);
  });
  page.on('pageerror', error => {
    const text = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    if (!isIgnoredBrowserConsoleMessage(text)) guard.errors.push(text);
  });
  return guard;
}

export function expectBrowserConsoleClean(guard: BrowserConsoleGuard, label: string): void {
  expect(guard.errors, `${label} browser console errors:\n${guard.errors.join('\n')}`).toHaveLength(0);
  expect(guard.warnings, `${label} browser console warnings:\n${guard.warnings.join('\n')}`).toHaveLength(0);
}

export type RuntimeIdentity = {
  entityId: string;
  signerId: string;
  runtimeId: string;
};

export type CrossDeltaSnapshot = Readonly<{
  tokenId: number;
  collateral: string;
  ondelta: string;
  offdelta: string;
  leftCreditLimit: string;
  rightCreditLimit: string;
  leftAllowance: string;
  rightAllowance: string;
  leftHold: string;
  rightHold: string;
}>;

export type JurisdictionIdentity = RuntimeIdentity & {
  jurisdictionName: string;
};

export type HubEntityInfo = {
  entityId: string;
  signerId: string;
  name?: string;
  jurisdictionName: string;
  primary: boolean;
};

export type CrossRuntimeWindow = Window & {
  __xln?: {
    env: () => RuntimeReplica | null;
    xln: () => Promise<XLNModule>;
    instance?: any;
    runtimeIngress?: {
      waitForProcessingIdle?: (timeoutMs?: number) => Promise<boolean>;
      waitForDrained?: (timeoutMs?: number) => Promise<boolean>;
    };
    runtimeConnectivity?: {
      profiles: Array<{ entityId: string; runtimeId: string; wsUrl?: string; isHub: boolean }>;
      connected: boolean;
      queue: unknown;
      directPeers: unknown;
      refreshGossip?: () => void;
    };
  };
};

export type CrossResolveSnapshot = {
  offerId: string;
  height: number;
  fillRatio: number;
  fillNumerator: string;
  fillDenominator: string;
  cancelRemainder: boolean;
  executionGiveAmount: string;
  executionWantAmount: string;
  comment: string;
};

export function getPrimaryHubId(health: E2EHealthResponse): string {
  const hubId = health.hubMesh?.hubIds?.[0];
  expect(hubId, `hub mesh must expose a primary hub: ${JSON.stringify(health.hubMesh || {})}`).toMatch(
    /^0x[a-fA-F0-9]{64}$/,
  );
  return hubId!;
}

export function expectMarketMakerSameAndCrossBooksHealthy(health: E2EHealthResponse): void {
  const marketMaker = health.marketMaker;
  expect(marketMaker?.ok, `market maker must be ready before swap tests: ${JSON.stringify(marketMaker ?? {})}`).toBe(
    true,
  );
  expect(
    marketMaker?.hubs?.length ?? 0,
    'market maker must publish same-chain books for all primary hubs',
  ).toBeGreaterThanOrEqual(3);
  for (const hub of marketMaker?.hubs ?? []) {
    expect(hub.ready, `same-chain MM hub ${hub.hubEntityId} must be ready`).toBe(true);
    expect(hub.depthReady, `same-chain MM hub ${hub.hubEntityId} must expose exact configured depth`).toBe(true);
    let expectedHubOffers = 0;
    for (const pair of hub.pairs ?? []) {
      expect(pair.ready, `same-chain MM pair ${pair.pairId} on hub ${hub.hubEntityId} must be ready`).toBe(true);
      expect(
        pair.depthReady,
        `same-chain MM pair ${pair.pairId} on hub ${hub.hubEntityId} must expose exact configured depth`,
      ).toBe(true);
      expect(pair.expectedOffers, `same-chain MM pair ${pair.pairId} must declare expected depth`).toBeGreaterThan(0);
      expect(pair.offers, `same-chain MM pair ${pair.pairId} must contain exactly its configured offers`).toBe(
        pair.expectedOffers,
      );
      expectedHubOffers += Number(pair.expectedOffers);
    }
    expect(hub.offers, `same-chain MM hub ${hub.hubEntityId} must contain only its configured offers`).toBe(
      expectedHubOffers,
    );
  }

  const cross = marketMaker?.cross;
  expect(cross?.ok, `cross-chain MM books must be ready: ${JSON.stringify(cross ?? {})}`).toBe(true);
  expect(cross?.expectedRoutes ?? 0, 'ETH/TRON cross-chain MM must declare expected routes').toBeGreaterThan(0);
  expect(cross?.routes?.length ?? 0, 'ETH/TRON cross-chain MM must expose all route books').toBeGreaterThanOrEqual(
    cross?.expectedRoutes ?? 0,
  );
  type CrossHealthPair = {
    pairId?: string;
    sourceTokenIds?: number[];
    targetTokenIds?: number[];
  };
  const isTronOnlyToken = (tokenId: number): boolean => tokenId === 4 || tokenId === 5;
  const hasTronOnlySourcePair = (cross?.routes ?? []).some(
    route =>
      /tron/i.test(String(route.sourceJurisdiction || '')) &&
      (route.pairs ?? []).some(pair => ((pair as CrossHealthPair).sourceTokenIds ?? []).some(isTronOnlyToken)),
  );
  const hasTronOnlyTargetPair = (cross?.routes ?? []).some(
    route =>
      /tron/i.test(String(route.targetJurisdiction || '')) &&
      (route.pairs ?? []).some(pair => ((pair as CrossHealthPair).targetTokenIds ?? []).some(isTronOnlyToken)),
  );
  const tronOnlyLeaksIntoTestnet = (cross?.routes ?? []).flatMap(route => {
    const sourceIsTestnet = /testnet/i.test(String(route.sourceJurisdiction || ''));
    const targetIsTestnet = /testnet/i.test(String(route.targetJurisdiction || ''));
    return (route.pairs ?? []).flatMap(pair => {
      const sourceTokenIds = ((pair as CrossHealthPair).sourceTokenIds ?? []).filter(isTronOnlyToken);
      const targetTokenIds = ((pair as CrossHealthPair).targetTokenIds ?? []).filter(isTronOnlyToken);
      const leaks = (sourceIsTestnet && sourceTokenIds.length > 0) || (targetIsTestnet && targetTokenIds.length > 0);
      return leaks
        ? [
            {
              sourceJurisdiction: route.sourceJurisdiction,
              targetJurisdiction: route.targetJurisdiction,
              pairId: pair.pairId,
              sourceTokenIds,
              targetTokenIds,
            },
          ]
        : [];
    });
  });
  expect(hasTronOnlySourcePair, 'Tron source cross MM books must include Tron-only TRX/SUN token pairs').toBe(true);
  expect(hasTronOnlyTargetPair, 'Tron target cross MM books must include Tron-only TRX/SUN token pairs').toBe(true);
  expect(tronOnlyLeaksIntoTestnet, 'Testnet side must not publish Tron-only token ids').toEqual([]);
  for (const route of cross?.routes ?? []) {
    expect(route.ready, `cross MM route ${route.sourceHubEntityId}->${route.targetHubEntityId} must be ready`).toBe(
      true,
    );
    expect(
      route.depthReady,
      `cross MM route ${route.sourceHubEntityId}->${route.targetHubEntityId} must expose exact configured depth`,
    ).toBe(true);
    expect(route.sourceJurisdiction, 'cross MM route source jurisdiction must be present').not.toEqual(
      route.targetJurisdiction,
    );
    let expectedRouteOffers = 0;
    for (const pair of route.pairs ?? []) {
      expect(
        pair.ready,
        `cross MM pair ${pair.pairId} on ${route.sourceHubEntityId}->${route.targetHubEntityId} must be ready`,
      ).toBe(true);
      expect(
        pair.depthReady,
        `cross MM pair ${pair.pairId} on ${route.sourceHubEntityId}->${route.targetHubEntityId} must expose exact configured depth`,
      ).toBe(true);
      expect(pair.expectedOffers, `cross MM pair ${pair.pairId} must declare expected depth`).toBeGreaterThan(0);
      expect(pair.offers, `cross MM pair ${pair.pairId} must contain exactly its configured offers`).toBe(
        pair.expectedOffers,
      );
      expectedRouteOffers += Number(pair.expectedOffers);
    }
    expect(
      route.offers,
      `cross MM route ${route.sourceHubEntityId}->${route.targetHubEntityId} must contain only configured offers`,
    ).toBe(expectedRouteOffers);
  }
}

export async function readFullMeshHealth(page: Page): Promise<E2EHealthResponse> {
  const response = await page.request.get(`${API_BASE_URL}/api/health?full=1&marketSnapshots=1`);
  expect(response.ok(), `full mesh health failed: ${response.status()} ${await response.text()}`).toBe(true);
  return (await response.json()) as E2EHealthResponse;
}

export async function readOpenDebugIncidents(page: Page): Promise<
  Array<{
    fingerprint: string;
    code: string;
    message: string;
  }>
> {
  const response = await page.request.get(`${API_BASE_URL}/api/debug/incidents?state=open&limit=1000`);
  expect(response.ok(), `debug incident query failed: ${response.status()} ${await response.text()}`).toBe(true);
  const body = (await response.json()) as { incidents?: unknown };
  return Array.isArray(body.incidents)
    ? body.incidents.flatMap(value => {
        if (!value || typeof value !== 'object') return [];
        const incident = value as Record<string, unknown>;
        const fingerprint = String(incident.fingerprint || '');
        return fingerprint
          ? [
              {
                fingerprint,
                code: String(incident.code || ''),
                message: String(incident.message || ''),
              },
            ]
          : [];
      })
    : [];
}

export async function readHubPairSnapshot(
  page: Page,
  hub: NonNullable<E2EHealthResponse['hubs']>[number],
  pairId: string,
): Promise<MarketSnapshotPayload> {
  const apiBase = String(hub.apiUrl || '').replace(/\/$/, '');
  expect(apiBase, `hub API missing for ${String(hub.name || hub.entityId || 'unknown')}`).toMatch(/^https?:\/\//);
  const hubEntityId = String(hub.entityId || '');
  const response = await page.request.get(
    `${apiBase}/api/market/snapshots?hubEntityId=${encodeURIComponent(hubEntityId)}` +
      `&pair=${encodeURIComponent(pairId)}&depth=10`,
  );
  expect(response.ok(), `hub market snapshot failed: ${response.status()} ${await response.text()}`).toBe(true);
  const payload = (await response.json()) as { snapshots?: MarketSnapshotPayload[] };
  const snapshot = payload.snapshots?.find(candidate => candidate.pairId === pairId);
  expect(snapshot, `hub ${String(hub.name || hubEntityId)} snapshot missing pair ${pairId}`).toBeTruthy();
  return snapshot!;
}

export function expectExactTenByTen(snapshot: MarketSnapshotPayload, context: string): void {
  expect(snapshot.bids, `${context} must expose exactly 10 bid levels`).toHaveLength(10);
  expect(snapshot.asks, `${context} must expose exactly 10 ask levels`).toHaveLength(10);
  expect(
    snapshot.bids.reduce((sum, level) => sum + Number(level.orderCount ?? 1), 0),
    `${context} must contain exactly 10 bid orders`,
  ).toBe(10);
  expect(
    snapshot.asks.reduce((sum, level) => sum + Number(level.orderCount ?? 1), 0),
    `${context} must contain exactly 10 ask orders`,
  ).toBe(10);
}

export function expectExactConfiguredDepth(
  snapshot: MarketSnapshotPayload,
  expected: { expectedOffers?: number; expectedBidOffers?: number; expectedAskOffers?: number },
  context: string,
): void {
  const expectedBids = Number(expected.expectedBidOffers ?? -1);
  const expectedAsks = Number(expected.expectedAskOffers ?? -1);
  const expectedTotal = Number(expected.expectedOffers ?? -1);
  expect(expectedBids, `${context} must declare exact bid depth`).toBeGreaterThanOrEqual(0);
  expect(expectedAsks, `${context} must declare exact ask depth`).toBeGreaterThanOrEqual(0);
  expect(expectedTotal, `${context} must declare exact total depth`).toBe(expectedBids + expectedAsks);
  const bidOrders = snapshot.bids.reduce((sum, level) => sum + Number(level.orderCount ?? 1), 0);
  const askOrders = snapshot.asks.reduce((sum, level) => sum + Number(level.orderCount ?? 1), 0);
  expect(bidOrders, `${context} bid depth must match canonical health`).toBe(expectedBids);
  expect(askOrders, `${context} ask depth must match canonical health`).toBe(expectedAsks);
  expect(bidOrders + askOrders, `${context} total depth must match canonical health`).toBe(expectedTotal);
}

export function getPrimaryHubApiBaseUrl(health: E2EHealthResponse, primaryHubId: string): string {
  const hub = (health.hubs || []).find(entry => normalizeId(entry.entityId) === normalizeId(primaryHubId)) as
    (E2EHealthResponse['hubs'][number] & { apiPort?: number; apiUrl?: string }) | undefined;
  if (hub?.apiUrl) return String(hub.apiUrl).replace(/\/$/, '');
  const apiPort = Number(hub?.apiPort);
  expect(Number.isFinite(apiPort) && apiPort > 0, `primary hub API port missing: ${JSON.stringify(hub || null)}`).toBe(
    true,
  );
  return `http://127.0.0.1:${apiPort}`;
}

export function getPrimaryHubName(health: E2EHealthResponse, primaryHubId: string): string {
  return String(
    (health.hubs || []).find(entry => normalizeId(entry.entityId) === normalizeId(primaryHubId))?.name || '',
  ).trim();
}

export function getIsolatedHubRuntimeSeed(hubName: string): string {
  const name = String(hubName || '')
    .trim()
    .toLowerCase();
  expect(name, 'isolated cross-j source hub name is required to derive source pull args').toBeTruthy();
  return `xln-e2e-${name}`;
}

export async function getSecondaryHubInfo(
  page: Page,
  primaryHubId: string,
  primaryHubName: string,
  hubApiBaseUrl: string,
): Promise<HubEntityInfo> {
  let found: HubEntityInfo | null = null;
  const normalizedPrimaryName = String(primaryHubName || '')
    .trim()
    .toLowerCase();
  await expect
    .poll(
      async () => {
        const response = await page.request
          .get(`${hubApiBaseUrl}/api/info`, {
            headers: { 'Cache-Control': 'no-store' },
            timeout: 5_000,
          })
          .catch(() => null);
        if (!response?.ok()) return false;
        const body = (await response.json().catch(() => null)) as { hubEntities?: HubEntityInfo[] } | null;
        const hubEntities = Array.isArray(body?.hubEntities) ? body!.hubEntities : [];
        found =
          hubEntities.find(
            hub =>
              normalizeId(hub.entityId) !== normalizeId(primaryHubId) &&
              hub.primary !== true &&
              (!normalizedPrimaryName ||
                String(hub.name || '')
                  .trim()
                  .toLowerCase()
                  .startsWith(normalizedPrimaryName)) &&
              /tron|rpc2|local/i.test(String(hub.jurisdictionName || '')),
          ) ||
          hubEntities.find(
            hub =>
              normalizeId(hub.entityId) !== normalizeId(primaryHubId) &&
              hub.primary !== true &&
              (!normalizedPrimaryName ||
                String(hub.name || '')
                  .trim()
                  .toLowerCase()
                  .startsWith(normalizedPrimaryName)),
          ) ||
          null;
        return Boolean(found?.entityId);
      },
      {
        timeout: 60_000,
        intervals: [250, 500, 1000],
        message: 'primary hub node must expose a secondary jurisdiction hub entity',
      },
    )
    .toBe(true);
  return found!;
}

export function normalizeId(value: string): string {
  return String(value || '')
    .trim()
    .toLowerCase();
}

export function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function deriveSigner(mnemonic: string, jurisdictionName: string): { address: string; privateKey: string } {
  const hd = HDNodeWallet.fromMnemonic(
    Mnemonic.fromPhrase(mnemonic.trim().split(/\s+/).join(' ')),
    getIndexedAccountPath(deriveJurisdictionSignerIndex(jurisdictionName)),
  );
  return { address: hd.address.toLowerCase(), privateKey: hd.privateKey };
}

export async function importRpc2SiblingEntity(
  page: Page,
  mnemonic: string,
  label: string,
): Promise<JurisdictionIdentity> {
  const result = await page.evaluate(async () => {
    const view = window as CrossRuntimeWindow;
    const env = view.__xln?.env();
    if (!env) throw new Error('CURRENT_WALLET_RUNTIME_MISSING');

    const response = await fetch(`/api/jurisdictions?ts=${Date.now()}`, { cache: 'no-store' });
    if (!response.ok) throw new Error(`jurisdictions fetch failed: ${response.status}`);
    const body = (await response.json()) as { jurisdictions?: Record<string, any> };
    const entries = Object.entries(body.jurisdictions || {});
    const rpc2 = entries.find(([key, item]) => {
      const haystack = `${key} ${item?.name || ''} ${item?.rpc || ''}`.toLowerCase();
      return haystack.includes('tron') || haystack.includes('rpc2');
    });
    if (!rpc2) throw new Error(`rpc2/tron jurisdiction missing: ${entries.map(([key]) => key).join(',')}`);
    const [jurisdictionKey, jurisdictionRaw] = rpc2;
    const jurisdictionName = String(jurisdictionRaw.name || jurisdictionKey);
    return {
      runtimeId: String(env.runtimeId || ''),
      jurisdictionName,
    };
  });

  await expect
    .poll(
      async () =>
        page.evaluate(async jurisdictionName => {
          const env = (window as CrossRuntimeWindow).__xln?.env();
          const adapter = env?.infrastructure?.liveJAdapters?.get(jurisdictionName);
          return Boolean(adapter && adapter.isWatching() && (await adapter.provider.getBlockNumber()) >= 0);
        }, result.jurisdictionName),
      {
        timeout: 60_000,
        intervals: [250, 500, 1000],
        message: `${label} runtime must import connected rpc2 jurisdiction adapter`,
      },
    )
    .toBe(true);

  const signer = deriveSigner(mnemonic, result.jurisdictionName);
  const sibling = await page.evaluate(
    ({ signer, jurisdictionName }) => {
      const view = window as CrossRuntimeWindow;
      const env = view.__xln?.env();
      if (!env) throw new Error('CURRENT_WALLET_RUNTIME_MISSING');
      const matches = Array.from(env.state.eReplicas.entries()).filter(([key, replica]) => {
        const [, signerId] = String(key).split(':');
        const replicaJurisdiction = String(
          replica?.state?.config?.jurisdiction?.name || replica?.position?.jurisdiction || '',
        );
        return signerId?.toLowerCase() === signer.address && replicaJurisdiction === jurisdictionName;
      });
      if (matches.length !== 1) {
        throw new Error(
          `Expected one pre-imported ${jurisdictionName} sibling for ${signer.address}, found ${matches.length}`,
        );
      }
      const [key, replica] = matches[0]!;
      const [entityId] = String(key).split(':');
      return {
        entityId: String(replica?.state?.entityId || replica?.entityId || entityId || '').toLowerCase(),
        signerId: signer.address,
      };
    },
    { signer: { address: signer.address }, jurisdictionName: result.jurisdictionName },
  );

  await expect
    .poll(
      async () =>
        page.evaluate(({ entityId, signerId }) => {
          const env = (window as CrossRuntimeWindow).__xln?.env();
          return Boolean(env?.state.eReplicas?.has(`${entityId}:${signerId}`.toLowerCase()));
        }, sibling),
      {
        timeout: 60_000,
        intervals: [250, 500, 1000],
        message: `${label} rpc2 sibling entity must hydrate`,
      },
    )
    .toBe(true);

  return {
    entityId: sibling.entityId,
    signerId: sibling.signerId,
    runtimeId: String(result.runtimeId || ''),
    jurisdictionName: String(result.jurisdictionName || ''),
  };
}

export async function waitForAccountReady(
  page: Page,
  identity: RuntimeIdentity,
  hubId: string,
  tokenIds: readonly number[],
  timeoutMs = 75_000,
): Promise<void> {
  let lastEvidence = '';
  await expect
    .poll(
      async () => {
        const status = await page.evaluate(
          ({ identity, hubId, tokenIds }) => {
            const env = (window as CrossRuntimeWindow).__xln?.env();
            if (!env) throw new Error('CURRENT_WALLET_RUNTIME_MISSING');
            const replica = env.state.eReplicas.get(`${identity.entityId}:${identity.signerId}`.toLowerCase());
            if (!replica) throw new Error('CURRENT_WALLET_REPLICA_MISSING');
            const account = replica.state.accounts.get(hubId.toLowerCase());
            return {
              ready: Boolean(
                account &&
                account.currentHeight > 0 &&
                !account.pendingFrame &&
                tokenIds.every(tokenId => account.state.deltas.has(tokenId)),
              ),
              currentHeight: account?.currentHeight,
              pendingHeight: account?.pendingFrame?.height,
              mempool: account?.mempool.map(tx => tx.type),
              tokens: account ? [...account.state.deltas.keys()] : [],
            };
          },
          { identity, hubId, tokenIds: [...tokenIds] },
        );
        const evidence = JSON.stringify({ identity, hubId, ...status });
        if (evidence !== lastEvidence) {
          console.log(`[ACCOUNT_READINESS] ${evidence}`);
          lastEvidence = evidence;
        }
        return status.ready;
      },
      {
        timeout: timeoutMs,
        intervals: [250, 500, 1000],
        message: `${identity.entityId.slice(0, 10)} account with hub must activate tokens ${tokenIds.join(',')}`,
      },
    )
    .toBe(true);
}

export async function waitForHubProfile(page: Page, hubId: string): Promise<void> {
  await expect
    .poll(
      async () =>
        page.evaluate(targetHubId => {
          const env = (window as CrossRuntimeWindow).__xln?.env();
          if (!env) throw new Error('CURRENT_WALLET_RUNTIME_MISSING');
          const target = targetHubId.toLowerCase();
          return env.gossip
            .getHubs()
            .some(profile => profile.entityId.toLowerCase() === target && Boolean(profile.runtimeId));
        }, hubId),
      {
        timeout: 60_000,
        intervals: [250, 500, 1000],
        message: `hub profile must be visible before opening account: ${hubId.slice(0, 10)}`,
      },
    )
    .toBe(true);
}

export async function flushRuntime(page: Page, rounds = 3): Promise<void> {
  await page.evaluate(async roundsToRun => {
    const view = window as CrossRuntimeWindow;
    const debug = view.__xln;
    const env = debug?.env();
    if (!debug || !env) throw new Error('CURRENT_WALLET_RUNTIME_MISSING');
    const api = await debug.xln();
    const waitRounds = Math.max(1, Number(roundsToRun) || 1);
    for (let round = 0; round < waitRounds; round += 1) {
      const idle = await api.waitForRuntimeProcessingIdle(env, 1_000);
      if (!idle) {
        throw new Error('runtime processing did not become idle before flush timeout');
      }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }, rounds);
}

export async function ensureDirectHubAccount(
  page: Page,
  identity: RuntimeIdentity,
  hubId: string,
  tokenIds: readonly number[],
  timeoutMs = 75_000,
): Promise<void> {
  await waitForHubProfile(page, hubId);
  const hasAccount = await page.evaluate(
    ({ identity, hubId }) => {
      const env = (window as CrossRuntimeWindow).__xln?.env();
      const replica = env?.state.eReplicas?.get(`${identity.entityId}:${identity.signerId}`.toLowerCase());
      return Boolean(replica?.state?.accounts?.get(hubId));
    },
    { identity, hubId },
  );

  if (!hasAccount) {
    await enqueueEntityTxs(page, identity.entityId, identity.signerId, [
      {
        type: 'openAccount',
        data: {
          targetEntityId: hubId,
          tokenId: USDC,
          creditAmount: tokenAmount(USDC, 10_000n),
          disputeConfig: defaultAccountDisputeConfigForParties(identity.entityId, false, hubId, true),
        },
      },
    ]);
    await flushRuntime(page, 8);
  }
  await waitForAccountReady(page, identity, hubId, [USDC], timeoutMs);

  const hasGrantedHubCredit = async (tokenId: number): Promise<boolean> =>
    page.evaluate(
      async ({ identity, hubId, tokenId, amount }) => {
        const debug = (window as CrossRuntimeWindow).__xln;
        const env = debug?.env();
        if (!debug || !env) throw new Error('CURRENT_WALLET_RUNTIME_MISSING');
        const replica = env.state.eReplicas.get(`${identity.entityId}:${identity.signerId}`.toLowerCase());
        const account = replica?.state.accounts.get(hubId.toLowerCase());
        if (!account || account.currentHeight <= 0 || account.pendingFrame) return false;
        const delta = account.state.deltas.get(tokenId);
        if (!delta) return false;
        const { deriveDelta } = await debug.xln();
        return deriveDelta(delta, identity.entityId === account.state.leftEntity).peerCreditLimit >= BigInt(amount);
      },
      { identity, hubId, tokenId, amount: tokenAmount(tokenId, 10_000n).toString() },
    );

  for (const tokenId of tokenIds) {
    if (!(await hasGrantedHubCredit(tokenId))) {
      await enqueueEntityTxs(page, identity.entityId, identity.signerId, [
        {
          type: 'extendCredit',
          data: {
            counterpartyEntityId: hubId,
            tokenId,
            amount: tokenAmount(tokenId, 10_000n),
          },
        },
      ]);
      await flushRuntime(page, 8);
    }
    await expect
      .poll(
        async () => {
          await flushRuntime(page, 2);
          return hasGrantedHubCredit(tokenId);
        },
        {
          timeout: timeoutMs,
          intervals: [250, 500, 1000],
          message: `${identity.entityId.slice(0, 10)} must grant hub credit token=${tokenId}`,
        },
      )
      .toBe(true);
  }
}

export async function waitForDefaultJurisdictionReplicas(page: Page, label: string): Promise<void> {
  await expect
    .poll(
      async () =>
        page.evaluate(async () => {
          const env = (window as CrossRuntimeWindow).__xln?.env();
          if (!env) throw new Error('CURRENT_WALLET_RUNTIME_MISSING');
          const jurisdictions = [...env.state.jReplicas.keys()];
          const liveAdapters = await Promise.all(
            [...(env.infrastructure?.liveJAdapters ?? [])].map(async ([name, adapter]) => ({
              name,
              connected: adapter.isWatching() && (await adapter.provider.getBlockNumber()) >= 0,
            })),
          );
          const entities = Array.from(env?.state.eReplicas?.values?.() || []).map((replica: any) => ({
            entityId: String(replica?.state?.entityId || replica?.entityId || ''),
            signerId: String(replica?.signerId || ''),
            jurisdiction: String(replica?.state?.config?.jurisdiction?.name || replica?.position?.jurisdiction || ''),
          }));
          const entityJurisdictions = new Set(
            entities.map(entry => entry.jurisdiction.trim().toLowerCase()).filter(Boolean),
          );
          return {
            jurisdictionCount: jurisdictions.length,
            entityJurisdictionCount: entityJurisdictions.size,
            hasTestnet: jurisdictions.some(name => /^testnet$/i.test(name)),
            hasSecondary: jurisdictions.some(name => /tron|rpc2|second/i.test(name)),
            hasTestnetAdapter: liveAdapters.some(adapter => /^testnet$/i.test(adapter.name) && adapter.connected),
            hasSecondaryAdapter: liveAdapters.some(
              adapter => /tron|rpc2|second/i.test(adapter.name) && adapter.connected,
            ),
            entities: entities.length,
          };
        }),
      {
        timeout: 90_000,
        intervals: [250, 500, 1000],
        message: `${label} runtime must bootstrap primary and secondary jurisdiction entities by default`,
      },
    )
    .toMatchObject({
      hasTestnet: true,
      hasSecondary: true,
      hasTestnetAdapter: true,
      hasSecondaryAdapter: true,
    });

  await expect
    .poll(
      async () =>
        page.evaluate(() => {
          const env = (window as CrossRuntimeWindow).__xln?.env();
          const entityJurisdictions = new Set(
            Array.from(env?.state.eReplicas?.values?.() || [])
              .map((replica: any) =>
                String(replica?.state?.config?.jurisdiction?.name || replica?.position?.jurisdiction || '')
                  .trim()
                  .toLowerCase(),
              )
              .filter(Boolean),
          );
          return {
            entityJurisdictionCount: entityJurisdictions.size,
            entities: Number(env?.state.eReplicas?.size || 0),
          };
        }),
      {
        timeout: 90_000,
        intervals: [250, 500, 1000],
        message: `${label} runtime must expose an entity for each default jurisdiction`,
      },
    )
    .toMatchObject({ entityJurisdictionCount: 2 });
}

export async function createWalletIdentity(page: Page, label: string, mnemonic: string): Promise<RuntimeIdentity> {
  await importStackPhraseUi(page, mnemonic.trim().split(/\s+/).join(' '));
  await page.waitForFunction(
    () => {
      const debug = (
        window as Window & {
          __xln?: { env: () => RuntimeReplica | null; store: { getState: () => { activeEntityId: string | null } } };
        }
      ).__xln;
      return Boolean(debug && debug.env()?.runtimeId && debug.store.getState().activeEntityId);
    },
    undefined,
    { timeout: 150_000 },
  );
  const identity = await page.evaluate(() => {
    const debug = (
      window as Window & {
        __xln?: { env: () => RuntimeReplica | null; store: { getState: () => { activeEntityId: string | null } } };
      }
    ).__xln;
    if (!debug) throw new Error('WALLET_DIAGNOSTICS_UNAVAILABLE');
    const env = debug.env();
    const entityId = debug.store.getState().activeEntityId;
    if (!env || !entityId || !env.runtimeId) throw new Error('WALLET_IDENTITY_UNAVAILABLE');
    const replicas = [...env.state.eReplicas.values()].filter(replica => replica.entityId === entityId);
    const [replica] = replicas;
    if (replicas.length !== 1 || !replica) throw new Error(`WALLET_SIGNER_NOT_UNIQUE:${entityId}:${replicas.length}`);
    return { entityId, signerId: replica.signerId, runtimeId: env.runtimeId };
  });
  expect(identity.runtimeId, `${label} public wallet import must select its Runtime`).toMatch(/^0x[a-fA-F0-9]{40}$/);
  return identity;
}

export async function faucetOffchain(
  page: Page,
  apiBaseUrl: string,
  entityId: string,
  hubEntityId: string,
  tokenId: number,
  amount: string,
): Promise<void> {
  let lastError = '';
  await expect
    .poll(
      async () => {
        const response = await page.request.post(`${apiBaseUrl.replace(/\/$/, '')}/api/faucet/offchain`, {
          data: {
            userEntityId: entityId,
            userRuntimeId: await page.evaluate(() =>
              String((window as CrossRuntimeWindow).__xln?.env()?.runtimeId || ''),
            ),
            hubEntityId,
            tokenId,
            amount,
          },
          timeout: 30_000,
        });
        if (response.ok()) return true;
        lastError = `${response.status()} ${await response.text().catch(() => '')}`;
        if (
          response.status() === 409 &&
          (lastError.includes('FAUCET_ACCOUNT_NOT_OPEN') || lastError.includes('FAUCET_ACCOUNT_NOT_READY'))
        ) {
          await flushRuntime(page, 2);
          return false;
        }
        throw new Error(`offchain faucet failed: ${lastError}`);
      },
      {
        timeout: 60_000,
        intervals: [250, 500, 1000],
        message: `offchain faucet account must be visible on hub: ${lastError}`,
      },
    )
    .toBe(true);
}

export async function accountCapacity(
  page: Page,
  entityId: string,
  counterpartyId: string,
  tokenId: number,
  direction: 'in' | 'out',
): Promise<bigint> {
  const delta = await page.evaluate(
    ({ entityId, counterpartyId, tokenId }) => {
      const env = (window as CrossRuntimeWindow).__xln?.env();
      if (!env?.state.eReplicas) return null;
      const readBig = (value: unknown): string => {
        if (typeof value === 'bigint') return value.toString();
        if (typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value)) return String(value);
        if (typeof value === 'string' && /^-?\d+$/.test(value.trim())) return value.trim();
        return '0';
      };
      for (const [replicaKey, replica] of env.state.eReplicas.entries()) {
        if (
          !String(replicaKey)
            .toLowerCase()
            .startsWith(`${String(entityId).toLowerCase()}:`)
        )
          continue;
        const account = replica.state?.accounts?.get(counterpartyId);
        const raw = account?.state?.deltas?.get(tokenId);
        if (!account || !raw || typeof raw !== 'object') return null;
        const record = raw as Record<string, unknown>;
        return {
          ondelta: readBig(record.ondelta),
          offdelta: readBig(record.offdelta),
          collateral: readBig(record.collateral),
          leftCreditLimit: readBig(record.leftCreditLimit),
          rightCreditLimit: readBig(record.rightCreditLimit),
          leftAllowance: readBig(record.leftAllowance),
          rightAllowance: readBig(record.rightAllowance),
          leftHold: readBig(record.leftHold),
          rightHold: readBig(record.rightHold),
        };
      }
      return null;
    },
    { entityId, counterpartyId, tokenId },
  );
  if (!delta) return 0n;
  const derived = deriveDelta(
    {
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
    },
    normalizeId(entityId) < normalizeId(counterpartyId),
  );
  return direction === 'in' ? derived.inCapacity : derived.outCapacity;
}

export async function outCap(page: Page, entityId: string, counterpartyId: string, tokenId: number): Promise<bigint> {
  return accountCapacity(page, entityId, counterpartyId, tokenId, 'out');
}

export async function inCap(page: Page, entityId: string, counterpartyId: string, tokenId: number): Promise<bigint> {
  return accountCapacity(page, entityId, counterpartyId, tokenId, 'in');
}

export async function waitForOutCapAtLeast(
  page: Page,
  entityId: string,
  counterpartyId: string,
  tokenId: number,
  minimum: bigint,
): Promise<void> {
  try {
    await expect
      .poll(
        async () => {
          await flushRuntime(page, 2);
          return (await outCap(page, entityId, counterpartyId, tokenId)) >= minimum;
        },
        {
          timeout: 45_000,
          intervals: [250, 500, 1000],
          message: `${entityId.slice(0, 10)} outCap token=${tokenId} must reach ${minimum}`,
        },
      )
      .toBe(true);
  } catch (error) {
    const debug = await page.evaluate(
      ({ entityId, counterpartyId, tokenId }) => {
        const env = (window as CrossRuntimeWindow).__xln?.env();
        const normalize = (value: unknown) => String(value || '').toLowerCase();
        const stringifyBig = (value: unknown) => {
          if (typeof value === 'bigint') return value.toString();
          if (value === undefined || value === null) return '';
          return String(value);
        };
        const targetEntityId = normalize(entityId);
        const targetCounterpartyId = normalize(counterpartyId);
        const replicas = Array.from(env?.state.eReplicas?.entries?.() || [])
          .map(([key, replica]: [string, any]) => {
            const state = replica?.state;
            if (!state) return null;
            const id = normalize(state.entityId || replica.entityId);
            if (id !== targetEntityId && id !== targetCounterpartyId) return null;
            const account =
              state.accounts?.get?.(targetCounterpartyId) || state.accounts?.get?.(targetEntityId) || null;
            return {
              key: String(key || ''),
              entityId: String(state.entityId || replica.entityId || ''),
              signerId: String(replica.signerId || state.config?.validators?.[0] || ''),
              jurisdiction: String(state.config?.jurisdiction?.name || ''),
              messages: Array.from(state.messages || [])
                .slice(-20)
                .map(String),
              account: account
                ? {
                    proofFrom: String(account.proofHeader?.fromEntity || ''),
                    proofTo: String(account.proofHeader?.toEntity || ''),
                    currentHeight: Number(account.currentHeight || 0),
                    mempool: Array.from(account.mempool || []).map((tx: any) => String(tx?.type || '')),
                    pendingFrame: Array.from(account.pendingFrame?.accountTxs || []).map((tx: any) =>
                      String(tx?.type || ''),
                    ),
                    pulls: Array.from(account.state?.pulls?.entries?.() || []).map(([pullId, pull]: [string, any]) => ({
                      pullId: String(pullId || ''),
                      tokenId: Number(pull?.tokenId || 0),
                      amount: stringifyBig(pull?.amount),
                      claimedRatio: Number(pull?.claimedRatio || 0),
                      claimedAmount: stringifyBig(pull?.claimedAmount),
                      cross: pull?.crossJurisdiction
                        ? {
                            orderId: String(pull.crossJurisdiction.orderId || ''),
                            leg: String(pull.crossJurisdiction.leg || ''),
                            status: String(pull.crossJurisdiction.status || ''),
                            cumulativeFillRatio: Number(pull.crossJurisdiction.cumulativeFillRatio || 0),
                            claimedRatio: Number(pull.crossJurisdiction.claimedRatio || 0),
                          }
                        : null,
                    })),
                    deltas: Array.from(account.state?.deltas?.entries?.() || [])
                      .filter(([id]: [number, any]) => Number(id) === Number(tokenId))
                      .map(([id, delta]: [number, any]) => ({
                        tokenId: Number(id),
                        ondelta: stringifyBig(delta?.ondelta),
                        offdelta: stringifyBig(delta?.offdelta),
                        collateral: stringifyBig(delta?.collateral),
                        leftCreditLimit: stringifyBig(delta?.leftCreditLimit),
                        rightCreditLimit: stringifyBig(delta?.rightCreditLimit),
                        leftAllowance: stringifyBig(delta?.leftAllowance),
                        rightAllowance: stringifyBig(delta?.rightAllowance),
                        leftHold: stringifyBig(delta?.leftHold),
                        rightHold: stringifyBig(delta?.rightHold),
                      })),
                  }
                : null,
              routes: Array.from(state.crossJurisdictionSwaps?.values?.() || []).map((route: any) => ({
                orderId: String(route?.orderId || ''),
                status: String(route?.status || ''),
                source: String(route?.source?.entityId || ''),
                sourceHub: String(route?.source?.counterpartyEntityId || ''),
                targetHub: String(route?.target?.entityId || ''),
                target: String(route?.target?.counterpartyEntityId || ''),
                sourcePull: String(route?.sourcePull?.pullId || ''),
                targetPull: String(route?.targetPull?.pullId || ''),
                cumulativeFillRatio: Number(route?.cumulativeFillRatio || 0),
                claimedRatio: Number(route?.claimedRatio || 0),
                filledSourceAmount: stringifyBig(route?.filledSourceAmount),
                filledTargetAmount: stringifyBig(route?.filledTargetAmount),
              })),
            };
          })
          .filter(Boolean);
        return {
          entityId,
          counterpartyId,
          tokenId,
          runtimeMempoolInputs: Array.from(
            env?.runtimeMempool?.entityInputs || env?.runtimeInput?.entityInputs || [],
          ).map((input: any) => ({
            entityId: String(input?.entityId || ''),
            signerId: String(input?.signerId || ''),
            txTypes: Array.from(input?.entityTxs || []).map((tx: any) => String(tx?.type || '')),
            frame: Boolean(input?.proposedFrame),
          })),
          pendingNetworkOutputs: Array.from(env?.pendingNetworkOutputs || []).map((input: any) => ({
            entityId: String(input?.entityId || ''),
            signerId: String(input?.signerId || ''),
            txTypes: Array.from(input?.entityTxs || []).map((tx: any) => String(tx?.type || '')),
            frame: Boolean(input?.proposedFrame),
          })),
          replicas,
        };
      },
      { entityId, counterpartyId, tokenId },
    );
    console.log('[E2E outcap wait debug]', JSON.stringify(debug, null, 2));
    throw error;
  }
}

export type RebalanceSnapshot = {
  entityId: string;
  counterpartyId: string;
  tokenId: number;
  jurisdiction: string;
  currentHeight: number;
  lastFinalizedJHeight: number;
  requested: string;
  collateral: string;
  hubDebt: string;
  uncollateralized: string;
  outCapacity: string;
  hasPolicy: boolean;
  policy: {
    r2cRequestSoftLimit: string;
    hardLimit: string;
    maxAcceptableFee: string;
  } | null;
};

export async function readRebalanceSnapshot(
  page: Page,
  identity: RuntimeIdentity,
  hubId: string,
  tokenId = USDC,
): Promise<RebalanceSnapshot | null> {
  const raw = await page.evaluate(
    ({ identity, hubId, tokenId }) => {
      const env = (window as CrossRuntimeWindow).__xln?.env();
      const normalizeEntityId = (value: unknown): string =>
        String(value || '')
          .trim()
          .toLowerCase();
      const readBig = (value: unknown): string => {
        if (typeof value === 'bigint') return value.toString();
        if (typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value)) return String(value);
        if (typeof value === 'string' && /^-?\d+$/.test(value.trim())) return value.trim();
        return '0';
      };
      const resolveCounterpartyAccount = (
        accounts: Map<
          string,
          {
            currentHeight?: number;
            shadow?: { rebalance?: { policy?: Map<number, unknown> } };
            state: {
              lastFinalizedJHeight?: number;
              requestedRebalance?: Map<number, unknown>;
              deltas: Map<number, unknown>;
              leftEntity: string;
              rightEntity: string;
            };
          }
        >,
        ownerEntityId: string,
        counterpartyEntityId: string,
      ) => {
        const owner = normalizeEntityId(ownerEntityId);
        const target = normalizeEntityId(counterpartyEntityId);
        const direct = accounts.get(target) ?? accounts.get(String(counterpartyEntityId || ''));
        if (direct) return direct;
        for (const [accountKey, account] of accounts.entries()) {
          if (normalizeEntityId(accountKey) === target) return account;
          const left = normalizeEntityId(account.state.leftEntity);
          const right = normalizeEntityId(account.state.rightEntity);
          if ((left === owner && right === target) || (right === owner && left === target)) return account;
        }
        return null;
      };
      const replica = env?.state.eReplicas?.get(`${identity.entityId}:${identity.signerId}`.toLowerCase());
      const accounts = replica?.state?.accounts;
      if (!(accounts instanceof Map)) return null;
      const account = resolveCounterpartyAccount(accounts, identity.entityId, hubId);
      if (!account) return null;
      const delta = account.state.deltas.get(tokenId);
      if (!delta || typeof delta !== 'object') return null;
      const policy = account.shadow?.rebalance?.policy?.get?.(tokenId);
      const policyRecord = policy && typeof policy === 'object' ? (policy as Record<string, unknown>) : null;
      const deltaRecord = delta as Record<string, unknown>;
      const owner = normalizeEntityId(identity.entityId);
      const left = normalizeEntityId(account.state.leftEntity);
      const ownerIsLeft = left ? owner === left : owner < normalizeEntityId(hubId);
      return {
        entityId: String(identity.entityId || ''),
        counterpartyId: String(hubId || ''),
        tokenId: Number(tokenId),
        jurisdiction: String(replica?.state?.config?.jurisdiction?.name || replica?.position?.jurisdiction || ''),
        ownerIsLeft,
        currentHeight: Number(account.currentHeight || 0),
        lastFinalizedJHeight: Number(account.state.lastFinalizedJHeight || 0),
        requested: readBig(account.state.requestedRebalance?.get?.(tokenId)),
        delta: {
          ondelta: readBig(deltaRecord.ondelta),
          offdelta: readBig(deltaRecord.offdelta),
          collateral: readBig(deltaRecord.collateral),
          leftCreditLimit: readBig(deltaRecord.leftCreditLimit),
          rightCreditLimit: readBig(deltaRecord.rightCreditLimit),
          leftAllowance: readBig(deltaRecord.leftAllowance),
          rightAllowance: readBig(deltaRecord.rightAllowance),
          leftHold: readBig(deltaRecord.leftHold),
          rightHold: readBig(deltaRecord.rightHold),
        },
        hasPolicy: Boolean(policyRecord),
        policy: policyRecord
          ? {
              r2cRequestSoftLimit: readBig(policyRecord.r2cRequestSoftLimit),
              hardLimit: readBig(policyRecord.hardLimit),
              maxAcceptableFee: readBig(policyRecord.maxAcceptableFee),
            }
          : null,
      };
    },
    { identity, hubId, tokenId },
  );
  if (!raw) return null;
  const derived = deriveDelta(
    {
      tokenId,
      ondelta: BigInt(raw.delta.ondelta),
      offdelta: BigInt(raw.delta.offdelta),
      collateral: BigInt(raw.delta.collateral),
      leftCreditLimit: BigInt(raw.delta.leftCreditLimit),
      rightCreditLimit: BigInt(raw.delta.rightCreditLimit),
      leftAllowance: BigInt(raw.delta.leftAllowance),
      rightAllowance: BigInt(raw.delta.rightAllowance),
      leftHold: BigInt(raw.delta.leftHold),
      rightHold: BigInt(raw.delta.rightHold),
    },
    Boolean(raw.ownerIsLeft),
  );
  const outCollateral = derived.outCollateral;
  const outPeerCredit = derived.outPeerCredit;
  const uncollateralized = outPeerCredit > outCollateral ? outPeerCredit - outCollateral : 0n;
  return {
    entityId: raw.entityId,
    counterpartyId: raw.counterpartyId,
    tokenId: raw.tokenId,
    jurisdiction: raw.jurisdiction,
    currentHeight: raw.currentHeight,
    lastFinalizedJHeight: raw.lastFinalizedJHeight,
    requested: String(raw.requested || '0'),
    collateral: outCollateral.toString(),
    hubDebt: outPeerCredit.toString(),
    uncollateralized: uncollateralized.toString(),
    outCapacity: derived.outCapacity.toString(),
    hasPolicy: Boolean(raw.hasPolicy),
    policy: raw.policy,
  };
}

export async function waitForRebalancePolicy(
  page: Page,
  identity: RuntimeIdentity,
  hubId: string,
  tokenId = USDC,
): Promise<RebalanceSnapshot> {
  let last: RebalanceSnapshot | null = null;
  await expect
    .poll(
      async () => {
        await flushRuntime(page, 2);
        last = await readRebalanceSnapshot(page, identity, hubId, tokenId);
        return Boolean(last?.hasPolicy) && BigInt(last?.policy?.r2cRequestSoftLimit || '0') > 0n;
      },
      {
        timeout: 60_000,
        intervals: [250, 500, 1000],
        message: `rebalance policy must exist for ${identity.entityId.slice(0, 10)} ${TOKEN_SYMBOL_BY_ID[tokenId] || tokenId}`,
      },
    )
    .toBe(true);
  return last!;
}

export async function waitForRebalanceSecured(
  page: Page,
  identity: RuntimeIdentity,
  hubId: string,
  tokenId = USDC,
  timeoutMs = 120_000,
): Promise<RebalanceSnapshot> {
  const startedAt = Date.now();
  const timeline: RebalanceSnapshot[] = [];
  let last: RebalanceSnapshot | null = null;
  while (Date.now() - startedAt < timeoutMs) {
    await flushRuntime(page, 2);
    last = await readRebalanceSnapshot(page, identity, hubId, tokenId);
    if (last) {
      timeline.push(last);
      if (
        BigInt(last.requested) === 0n &&
        BigInt(last.uncollateralized) === 0n &&
        BigInt(last.collateral) > 0n &&
        last.lastFinalizedJHeight > 0
      ) {
        return last;
      }
    }
    await page.waitForTimeout(500);
  }
  throw new Error(
    `rebalance did not secure ${identity.entityId.slice(0, 10)} on ${hubId.slice(0, 10)} ` +
      `token=${TOKEN_SYMBOL_BY_ID[tokenId] || tokenId}: ` +
      JSON.stringify({ last, timeline: timeline.slice(-20) }, null, 2),
  );
}

export async function dismissSwapCompletionModal(page: Page): Promise<void> {
  if (page.isClosed()) return;
  // Fill dialogs mount after the bilateral settle wait returns. A single 1s
  // probe races the Svelte mount and leaves the overlay intercepting every
  // later tab click for the rest of the test timeout (shard-8 bob_second_offer).
  const completionClose = page.getByTestId('swap-completion-close').first();
  if (!(await completionClose.isVisible())) {
    await page.evaluate(
      () =>
        new Promise<void>(resolve => {
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
        }),
    );
    if (!(await completionClose.isVisible())) return;
  }
  // A visible completion overlay is authoritative UI state. Failing to close
  // it must fail this flow; force-clicking the covered workspace would turn a
  // real modal regression into a false-green financial E2E.
  await completionClose.click();
  await expect(completionClose).toBeHidden({ timeout: 3_000 });
}

export async function openSwapWorkspace(page: Page): Promise<void> {
  await page.getByTestId('nav-home').locator('visible=true').first().click();
  await page.getByTestId('home-swap').click();
  await expect(page.getByTestId('swap-give')).toBeVisible();
}

export async function selectSourceChainInSwap(page: Page, sourceEntityId: string): Promise<void> {
  await page.getByTestId('nav-home').locator('visible=true').first().click();
  const trigger = page.getByTestId('entity-switcher-trigger');
  if ((await trigger.getAttribute('data-entity-id')) !== sourceEntityId.toLowerCase()) {
    await trigger.click();
    await page
      .locator(`[data-testid="entity-switcher-entity"][data-entity-id="${sourceEntityId.toLowerCase()}"]`)
      .click();
  }
  await expect(trigger).toHaveAttribute('data-entity-id', sourceEntityId.toLowerCase());
  await page.getByTestId('home-swap').click();
}

export async function selectCounterpartyInSwap(page: Page, hubId: string): Promise<void> {
  const label = await page.evaluate(hubId => {
    const env = (window as CrossRuntimeWindow).__xln?.env();
    const profile = env?.gossip.getProfile(hubId);
    if (!profile?.name) throw new Error(`HUB_PROFILE_NAME_MISSING:${hubId}`);
    return profile.name;
  }, hubId);
  const choice = page.locator('.chips').getByRole('button', { name: label, exact: true });
  if (await choice.isVisible()) await choice.click();
  await expect(page.getByRole('button', { name: new RegExp(`^Up to .* with ${escapeRegex(label)}$`) })).toBeVisible();
}

export async function configurePair(page: Page, side: 'buy' | 'sell'): Promise<void> {
  await configureTokens(page, side === 'buy' ? USDC : WETH, side === 'buy' ? WETH : USDC);
}

export async function configureTokens(page: Page, fromTokenId: number, toTokenId: number): Promise<void> {
  for (const [inputId, tokenId] of [
    ['swap-give', fromTokenId],
    ['swap-want', toTokenId],
  ] as const) {
    const symbol = TOKEN_SYMBOL_BY_ID[tokenId];
    if (!symbol) throw new Error(`TOKEN_SYMBOL_MISSING:${tokenId}`);
    await page.getByTestId(inputId).locator('..').getByRole('button').click();
    await page.getByRole('option', { name: new RegExp(`^${escapeRegex(symbol)}\\b`) }).click();
  }
}

export async function selectOrderbookPairByLabel(page: Page, labelPattern: RegExp): Promise<string> {
  const pairSelect = page.getByTestId('swap-orderbook-pair-select').first();
  await expect(pairSelect, 'orderbook pair selector must be mounted').toHaveCount(1, { timeout: 10_000 });
  const options = await pairSelect.evaluate(node =>
    Array.from((node as HTMLSelectElement).options).map(option => ({
      value: option.value,
      label: option.textContent?.replace(/\s+/g, ' ').trim() || '',
    })),
  );
  const match = options.find(option => labelPattern.test(option.label));
  expect(match, `orderbook pair selector missing ${labelPattern}: ${JSON.stringify(options)}`).toBeTruthy();
  await pairSelect.selectOption(match!.value);
  return match!.label;
}

export async function readOrderbookRowCounts(page: Page): Promise<{ asks: number; bids: number }> {
  return {
    asks: await page.getByTestId('orderbook-ask-row').count(),
    bids: await page.getByTestId('orderbook-bid-row').count(),
  };
}

export async function selectCrossRoute(page: Page, targetEntityId: string): Promise<void> {
  await page.getByTestId('swap-cross-mode').click();
  const routeSelect = page.locator('.kv').filter({ hasText: 'Your other account' }).locator('select');
  await expect(routeSelect).toBeVisible();
  await routeSelect.selectOption(targetEntityId.toLowerCase());
  await expect(routeSelect).toHaveValue(targetEntityId.toLowerCase());
}