import { HDNodeWallet, Mnemonic, getIndexedAccountPath, keccak256, toUtf8Bytes } from 'ethers';
import { deriveDelta, getTokenInfo } from '../runtime/account/utils';
import type { MarketSnapshotPayload } from '../runtime/network/relay/market-snapshot';
import { expect, type Page } from './global-setup.mts';
import { type E2EHealthResponse } from './utils/e2e-baseline';
import { requireIsolatedBaseUrl } from './utils/e2e-isolated-env';
import { enqueueEntityTxs } from './utils/e2e-runtime-input';

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
  'source_claimed',
  'target_claimed',
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

export type SyntheticJEventInput = {
  event: {
    type: string;
    data: Record<string, unknown>;
  };
  transactionHash: string;
};

export type CrossRuntimeWindow = Window & {
  isolatedEnv?: {
    runtimeId?: string;
    state: {
      eReplicas: Map<string, any>;
      jReplicas: Map<string, any>;
    };
  };
  __xln?: {
    instance?: any;
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

export function deriveJurisdictionSignerIndex(jurisdiction: string): number {
  const key = String(jurisdiction || '')
    .trim()
    .toLowerCase();
  const digest = keccak256(toUtf8Bytes(`xln:jurisdiction-signer:v1:${key}`));
  return 100_000 + Number(BigInt(digest) % 1_000_000n);
}

export function deriveSigner(mnemonic: string, jurisdictionName: string): { address: string; privateKey: string } {
  const hd = HDNodeWallet.fromMnemonic(
    Mnemonic.fromPhrase(mnemonic.trim().split(/\s+/).join(' ')),
    getIndexedAccountPath(deriveJurisdictionSignerIndex(jurisdictionName)),
  );
  return { address: hd.address.toLowerCase(), privateKey: hd.privateKey };
}

export async function injectSyntheticJEventThroughWatcher(
  page: Page,
  identity: RuntimeIdentity,
  input: SyntheticJEventInput,
): Promise<void> {
  await page.evaluate(
    async ({ identity, input }) => {
      const view = window as CrossRuntimeWindow;
      const env = view.isolatedEnv;
      if (!env) throw new Error('isolatedEnv missing');
      const runtimeModule = view.__xln?.instance;
      if (!runtimeModule) throw new Error('__xln.instance missing');
      if (typeof runtimeModule.applyJEventsToEnv !== 'function') {
        throw new Error('applyJEventsToEnv missing from runtime bundle');
      }

      const entityId = String(identity.entityId || '').toLowerCase();
      const signerId = String(identity.signerId || '').toLowerCase();
      const entityReplica = [...(env.state.eReplicas?.values?.() || [])].find(
        (replica: any) =>
          String(replica?.state?.entityId || '').toLowerCase() === entityId &&
          String(replica?.signerId || '').toLowerCase() === signerId,
      );
      const jurisdiction = entityReplica?.state?.config?.jurisdiction;
      if (!jurisdiction) throw new Error(`entity jurisdiction missing: ${identity.entityId}`);
      const finalizedHeight = Number(entityReplica.state.lastFinalizedJHeight || 0);
      const scannedHeight = Number(entityReplica.jHistory?.scannedThroughHeight ?? finalizedHeight);
      const contiguousHeight = Number(entityReplica.jHistory?.contiguousThroughHeight ?? finalizedHeight);
      if (
        !Number.isSafeInteger(finalizedHeight) ||
        !Number.isSafeInteger(scannedHeight) ||
        !Number.isSafeInteger(contiguousHeight) ||
        scannedHeight < finalizedHeight ||
        contiguousHeight !== scannedHeight
      ) {
        throw new Error(
          `synthetic J history is not contiguous: finalized=${finalizedHeight} ` +
            `scanned=${scannedHeight} contiguous=${contiguousHeight}`,
        );
      }
      const blockNumber = scannedHeight + 1;
      const expectedChainId = Number(jurisdiction.chainId);
      const expectedDepository = String(jurisdiction.depositoryAddress || '').toLowerCase();
      const watcherMatches = [...(env.state.jReplicas?.values?.() || [])].filter((replica: any) => {
        const chainId = Number(replica?.chainId ?? replica?.jadapter?.chainId);
        const depository = String(
          replica?.depositoryAddress ||
            replica?.contracts?.depository ||
            replica?.jadapter?.addresses?.depository ||
            '',
        ).toLowerCase();
        return chainId === expectedChainId && depository === expectedDepository;
      });
      if (watcherMatches.length !== 1) {
        throw new Error(
          `synthetic J watcher resolution failed: chain=${expectedChainId} ` +
            `depository=${expectedDepository} matches=${watcherMatches.length}`,
        );
      }
      const rpcUrlRaw = String(watcherMatches[0]?.rpcs?.[0] || jurisdiction.rpc || '');
      if (!rpcUrlRaw) throw new Error(`synthetic J watcher RPC missing: chain=${expectedChainId}`);
      const rpcUrl = rpcUrlRaw.startsWith('/') ? new URL(rpcUrlRaw, window.location.origin).toString() : rpcUrlRaw;
      type RpcPayload = {
        result?: unknown;
        error?: { code?: number; message?: string; data?: unknown };
      };
      const callRpc = async (method: string, params: unknown[]): Promise<RpcPayload> => {
        const response = await fetch(rpcUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        });
        if (!response.ok) throw new Error(`synthetic J RPC HTTP error: method=${method} status=${response.status}`);
        const payload = (await response.json()) as RpcPayload;
        if (payload.error) {
          throw new Error(`synthetic J RPC error: method=${method} error=${JSON.stringify(payload.error)}`);
        }
        return payload;
      };
      const blockQuantity = `0x${blockNumber.toString(16)}`;
      let headerPayload = await callRpc('eth_getBlockByNumber', [blockQuantity, false]);
      if (headerPayload.result === null) {
        const currentPayload = await callRpc('eth_blockNumber', []);
        const currentHeight = Number.parseInt(String(currentPayload.result || ''), 16);
        if (currentHeight !== scannedHeight) {
          throw new Error(
            `synthetic J canonical header gap: chain=${expectedChainId} required=${blockNumber} ` +
              `current=${currentHeight} scanned=${scannedHeight} rpc=${rpcUrl}`,
          );
        }
        const rpcHost = new URL(rpcUrl).hostname;
        if (rpcHost !== 'localhost' && rpcHost !== '127.0.0.1' && rpcHost !== '::1') {
          throw new Error(`synthetic J mining forbidden for non-local RPC: ${rpcUrl}`);
        }
        await callRpc('evm_mine', []);
        headerPayload = await callRpc('eth_getBlockByNumber', [blockQuantity, false]);
      }
      const header = headerPayload.result as { hash?: string } | null | undefined;
      const canonicalBlockHash = String(header?.hash || '').toLowerCase();
      if (!/^0x[0-9a-f]{64}$/.test(canonicalBlockHash)) {
        throw new Error(
          `synthetic J canonical header missing: chain=${expectedChainId} ` +
            `height=${blockNumber} rpc=${rpcUrl} result=${JSON.stringify(header ?? null)}`,
        );
      }

      runtimeModule.applyJEventsToEnv(
        env,
        [
          {
            name: input.event.type,
            args: input.event.data,
            blockNumber,
            blockHash: canonicalBlockHash,
            transactionHash: input.transactionHash,
            logIndex: 0,
          },
        ],
        'e2e-cross-j-source-dispute',
        watcherMatches[0],
      );
    },
    { identity, input },
  );
}

export async function importRpc2SiblingEntity(
  page: Page,
  mnemonic: string,
  label: string,
): Promise<JurisdictionIdentity> {
  const result = await page.evaluate(
    async ({ mnemonic, label }) => {
      const view = window as CrossRuntimeWindow;
      const env = view.isolatedEnv;
      if (!env) throw new Error('isolatedEnv missing');

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
      const rpc = String(jurisdictionRaw.rpc || '').startsWith('/')
        ? new URL(String(jurisdictionRaw.rpc), window.location.origin).toString()
        : String(jurisdictionRaw.rpc || '');
      const contracts = jurisdictionRaw.contracts || {};
      const blockTimeMs = Number(jurisdictionRaw.blockTimeMs);
      if (!rpc || !contracts.depository || !contracts.entityProvider) {
        throw new Error(`rpc2 jurisdiction incomplete: ${JSON.stringify(jurisdictionRaw)}`);
      }
      if (!Number.isSafeInteger(blockTimeMs) || blockTimeMs <= 0) {
        throw new Error(`rpc2 jurisdiction block time invalid: ${String(jurisdictionRaw.blockTimeMs)}`);
      }
      const runtimeModule = view.__xln?.instance;
      if (!runtimeModule) throw new Error('__xln.instance missing');

      const hasConnectedAdapter = (name: string): boolean => {
        const adapter = env.infrastructure?.liveJAdapters?.get(name);
        return (
        Boolean(
            adapter?.addresses?.depository &&
            adapter?.addresses?.entityProvider &&
            adapter?.depository &&
            adapter?.entityProvider &&
            typeof adapter?.submitTx === 'function',
          )
        );
      };
      if (!hasConnectedAdapter(jurisdictionName)) {
        const entityProviderDeploymentBlock = Number(jurisdictionRaw.entityProviderDeploymentBlock);
        if (!Number.isSafeInteger(entityProviderDeploymentBlock) || entityProviderDeploymentBlock < 1) {
          throw new Error(
            `rpc2 jurisdiction entity-provider deployment block invalid: ${String(jurisdictionRaw.entityProviderDeploymentBlock)}`,
          );
        }
        runtimeModule.enqueueRuntimeInput(env, {
          runtimeTxs: [
            {
              type: 'importJ',
              data: {
                name: jurisdictionName,
                chainId: Number(jurisdictionRaw.chainId || 31338),
                ticker: String(jurisdictionRaw.currency || 'TRX'),
                rpcs: [rpc],
                blockTimeMs,
                entityProviderDeploymentBlock,
                contracts: {
                  depository: String(contracts.depository),
                  entityProvider: String(contracts.entityProvider),
                  account: String(contracts.account || ''),
                  deltaTransformer: String(contracts.deltaTransformer || ''),
                },
              },
            },
          ],
          entityInputs: [],
        });
      }

      return {
        runtimeId: String(env.runtimeId || ''),
        jurisdictionName,
        jurisdiction: {
          name: jurisdictionName,
          address: rpc,
          chainId: Number(jurisdictionRaw.chainId || 31338),
          blockTimeMs,
          depositoryAddress: String(contracts.depository),
          entityProviderAddress: String(contracts.entityProvider),
        },
      };
    },
    { mnemonic, label },
  );

  await expect
    .poll(
      async () =>
        page.evaluate(jurisdictionName => {
          const env = (window as CrossRuntimeWindow).isolatedEnv;
          const adapter = env?.infrastructure?.liveJAdapters?.get(jurisdictionName);
          return Boolean(
            adapter?.addresses?.depository &&
            adapter?.addresses?.entityProvider &&
            adapter?.depository &&
            adapter?.entityProvider &&
            typeof adapter?.submitTx === 'function',
          );
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
    async ({ signer, label, jurisdiction }) => {
      const view = window as CrossRuntimeWindow;
      const env = view.isolatedEnv;
      if (!env) throw new Error('isolatedEnv missing');
      const runtimeModule = view.__xln?.instance;
      if (!runtimeModule) throw new Error('__xln.instance missing');
      const privateKeyBytes = new Uint8Array(
        signer.privateKey
          .slice(2)
          .match(/.{2}/g)
          .map((byte: string) => Number.parseInt(byte, 16)),
      );
      runtimeModule.registerSignerKey(env, signer.address, privateKeyBytes);
      const entityId = runtimeModule.generateLazyEntityId([signer.address], 1n).toLowerCase();
      const { config } = runtimeModule.createLazyEntity(`${label}-rpc2`, [signer.address], 1n, jurisdiction);
      const replicaKey = `${entityId}:${signer.address}`.toLowerCase();
      if (!env.state.eReplicas?.has(replicaKey)) {
        runtimeModule.enqueueRuntimeInput(env, {
          runtimeTxs: [
            {
              type: 'importReplica',
              entityId,
              signerId: signer.address,
              data: {
                isProposer: true,
                config,
                profileName: `${label}-rpc2`,
                position: { x: 240, y: 0, z: 0, jurisdiction: jurisdiction.name },
              },
            },
          ],
          entityInputs: [],
        });
      }
      return { entityId, signerId: signer.address };
    },
    { signer, label, jurisdiction: result.jurisdiction },
  );

  await expect
    .poll(
      async () =>
        page.evaluate(({ entityId, signerId }) => {
          const env = (window as CrossRuntimeWindow).isolatedEnv;
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
  await expect
    .poll(
      async () =>
        page.evaluate(
          ({ identity, hubId, tokenIds }) => {
            const env = (window as CrossRuntimeWindow).isolatedEnv;
            const replica = env?.state.eReplicas?.get(`${identity.entityId}:${identity.signerId}`.toLowerCase());
            const normalizeEntityId = (value: unknown): string =>
              String(value || '')
                .trim()
                .toLowerCase();
            const resolveCounterpartyAccount = (
              accounts: Map<
                string,
                {
                  currentHeight?: number;
                  pendingFrame?: unknown;
                  deltas?: Map<number, unknown>;
                  leftEntity?: string;
                  rightEntity?: string;
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
                const left = normalizeEntityId(account.leftEntity);
                const right = normalizeEntityId(account.rightEntity);
                if ((left === owner && right === target) || (right === owner && left === target)) return account;
              }
              return null;
            };
            const accounts = replica?.state?.accounts;
            const account =
              accounts instanceof Map ? resolveCounterpartyAccount(accounts, identity.entityId, hubId) : null;
            if (!account || Number(account.currentHeight || 0) <= 0 || account.pendingFrame) return false;
            return tokenIds.every((tokenId: number) => account.deltas instanceof Map && account.deltas.has(tokenId));
          },
          { identity, hubId, tokenIds: Array.from(tokenIds) },
        ),
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
          const view = window as CrossRuntimeWindow & {
            p2p?: { refreshGossip?: () => void };
          };
          const env = view.isolatedEnv;
          view.__xln?.instance?.refreshGossip?.(env);
          view.p2p?.refreshGossip?.();
          const target = String(targetHubId || '').toLowerCase();
          const profiles = env?.gossip?.getProfiles?.() || [];
          return profiles.some(
            (profile: any) =>
              String(profile?.entityId || '').toLowerCase() === target &&
              profile?.metadata?.isHub === true &&
              typeof profile?.runtimeId === 'string' &&
              profile.runtimeId.length > 0,
          );
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
    const env = view.isolatedEnv;
    if (!env) throw new Error('isolatedEnv missing');
    const runtimeModule = view.__xln?.instance as
      | {
          startRuntimeLoop?: (env: unknown) => unknown;
          waitForRuntimeProcessingIdle?: (env: unknown, timeoutMs?: number) => Promise<boolean>;
        }
      | undefined;
    if (!runtimeModule) throw new Error('__xln.instance missing');
    if (env.infrastructure?.halted) {
      throw new Error(`runtime halted before flush: ${JSON.stringify(env.infrastructure.fatalDebugPayload || {})}`);
    }
    runtimeModule.startRuntimeLoop?.(env);
    if (typeof runtimeModule.waitForRuntimeProcessingIdle !== 'function') {
      throw new Error('__xln.instance.waitForRuntimeProcessingIdle missing');
    }
    const waitRounds = Math.max(1, Number(roundsToRun) || 1);
    for (let round = 0; round < waitRounds; round += 1) {
      const idle = await runtimeModule.waitForRuntimeProcessingIdle(env, 1_000);
      if (!idle) {
        throw new Error('runtime processing did not become idle before flush timeout');
      }
      if (env.infrastructure?.halted) {
        throw new Error(`runtime halted during flush: ${JSON.stringify(env.infrastructure.fatalDebugPayload || {})}`);
      }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    view.isolatedEnv = env as NonNullable<CrossRuntimeWindow['isolatedEnv']>;
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
      const env = (window as CrossRuntimeWindow).isolatedEnv;
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
        },
      },
    ]);
    await flushRuntime(page, 8);
  }
  await waitForAccountReady(page, identity, hubId, [USDC], timeoutMs);

  const hasGrantedHubCredit = async (tokenId: number): Promise<boolean> =>
    page.evaluate(
      ({ identity, hubId, tokenId, amount }) => {
        const env = (window as CrossRuntimeWindow).isolatedEnv;
        const replica = env?.state.eReplicas?.get(`${identity.entityId}:${identity.signerId}`.toLowerCase());
        const normalizeEntityId = (value: unknown): string =>
          String(value || '')
            .trim()
            .toLowerCase();
        const readBig = (value: unknown): bigint => {
          if (typeof value === 'bigint') return value;
          if (typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value)) return BigInt(value);
          if (typeof value === 'string' && /^-?\d+$/.test(value.trim())) return BigInt(value.trim());
          return 0n;
        };
        const resolveCounterpartyAccount = (
          accounts: Map<
            string,
            {
              currentHeight?: number;
              pendingFrame?: unknown;
              deltas?: Map<number, unknown>;
              leftEntity?: string;
              rightEntity?: string;
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
            const left = normalizeEntityId(account.leftEntity);
            const right = normalizeEntityId(account.rightEntity);
            if ((left === owner && right === target) || (right === owner && left === target)) return account;
          }
          return null;
        };
        const accounts = replica?.state?.accounts;
        const account = accounts instanceof Map ? resolveCounterpartyAccount(accounts, identity.entityId, hubId) : null;
        if (!account || Number(account.currentHeight || 0) <= 0 || account.pendingFrame) return false;
        if (!(account.deltas instanceof Map)) return false;
        const rawDelta = account.deltas.get(tokenId);
        if (!rawDelta || typeof rawDelta !== 'object') return false;
        const delta = rawDelta as Record<string, unknown>;
        const owner = normalizeEntityId(identity.entityId);
        const left = normalizeEntityId(account.leftEntity);
        const ownerIsLeft = left ? owner === left : owner < normalizeEntityId(hubId);
        const creditGrantedToHub = ownerIsLeft ? readBig(delta.rightCreditLimit) : readBig(delta.leftCreditLimit);
        return creditGrantedToHub >= BigInt(amount);
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
        page.evaluate(() => {
          const env = (window as CrossRuntimeWindow).isolatedEnv;
          const jurisdictions = Array.from(env?.state.jReplicas?.keys?.() || []).map(name => String(name));
          const liveAdapters = Array.from(env?.infrastructure?.liveJAdapters?.entries?.() || []);
          const isConnected = (adapter: any): boolean =>
            Boolean(
              adapter?.addresses?.depository &&
              adapter?.addresses?.entityProvider &&
              adapter?.depository &&
              adapter?.entityProvider &&
              typeof adapter?.submitTx === 'function',
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
            hasTestnetAdapter: liveAdapters.some(
              ([name, adapter]: any) => /^testnet$/i.test(String(name)) && isConnected(adapter),
            ),
            hasSecondaryAdapter: liveAdapters.some(
              ([name, adapter]: any) => /tron|rpc2|second/i.test(String(name)) && isConnected(adapter),
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
          const env = (window as CrossRuntimeWindow).isolatedEnv;
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

export async function createRuntimeIdentityViaStore(
  page: Page,
  label: string,
  mnemonic: string,
): Promise<RuntimeIdentity> {
  const normalizedMnemonic = mnemonic.trim().split(/\s+/).join(' ');
  const createOnce = async (): Promise<string> =>
    page.evaluate(
      async ({ label, mnemonic }) => {
        const ops = (window as any).__xln?.vault as
          | {
              createRuntime?: (
                name: string,
                seed: string,
                options?: Record<string, unknown>,
              ) => Promise<{ id?: string }>;
            }
          | undefined;
        if (typeof ops?.createRuntime !== 'function') {
          throw new Error('__xln.vault.createRuntime unavailable');
        }
        const runtime = await ops.createRuntime(label, mnemonic, {
          loginType: 'manual',
          requiresOnboarding: false,
          mnemonic12: undefined,
          // This spec is a swap/orderbook consensus test, not a recovery-tower test.
          // Remote account frames must not be held behind a stale localhost tower
          // configuration from another browser run; watchtower behavior has its own
          // dedicated e2e suite.
          recovery: { useDefaultTowers: false, towers: [] },
        });
        return String(runtime?.id || '');
      },
      { label, mnemonic: normalizedMnemonic },
    );
  let runtimeId = '';
  let lastCreateError = '';
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      runtimeId = await createOnce();
      break;
    } catch (error) {
      lastCreateError = error instanceof Error ? error.message : String(error);
      if (!/Failed to fetch|NetworkError|Load failed/i.test(lastCreateError) || attempt === 3 || page.isClosed()) {
        throw error;
      }
      await page.waitForTimeout(500 * attempt);
    }
  }
  if (!runtimeId && lastCreateError) {
    throw new Error(`${label} direct runtime create failed: ${lastCreateError}`);
  }
  expect(runtimeId, `${label} direct runtime create must return runtime id`).toMatch(/^0x[a-fA-F0-9]{40}$/);

  await expect
    .poll(
      async () =>
        page.evaluate(runtimeId => {
          const env = (window as CrossRuntimeWindow).isolatedEnv;
          if (!env?.state.eReplicas) return null;
          const runtimeNeedle = String(runtimeId || '').toLowerCase();
          for (const [key, replica] of env.state.eReplicas.entries()) {
            const [entityId, signerId] = String(key || '').split(':');
            if (String(signerId || '').toLowerCase() !== runtimeNeedle) continue;
            return {
              entityId: String(replica?.state?.entityId || replica?.entityId || entityId || ''),
              signerId: String(signerId || replica?.signerId || ''),
              runtimeId: String(env.runtimeId || runtimeId),
            };
          }
          return null;
        }, runtimeId),
      {
        timeout: 150_000,
        intervals: [250, 500, 1000],
        message: `${label} direct runtime must hydrate primary entity`,
      },
    )
    .not.toBeNull();

  const identity = await page.evaluate(runtimeId => {
    const env = (window as CrossRuntimeWindow).isolatedEnv;
    const runtimeNeedle = String(runtimeId || '').toLowerCase();
    for (const [key, replica] of env?.state.eReplicas?.entries?.() || []) {
      const [entityId, signerId] = String(key || '').split(':');
      if (String(signerId || '').toLowerCase() !== runtimeNeedle) continue;
      return {
        entityId: String(replica?.state?.entityId || replica?.entityId || entityId || ''),
        signerId: String(signerId || replica?.signerId || ''),
        runtimeId: String(env?.runtimeId || runtimeId),
      };
    }
    return null;
  }, runtimeId);
  expect(identity, `${label} direct runtime identity must be readable`).not.toBeNull();
  return identity!;
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
              String((window as CrossRuntimeWindow).isolatedEnv?.runtimeId || ''),
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
      const env = (window as CrossRuntimeWindow).isolatedEnv;
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
        const raw = account?.deltas?.get(tokenId);
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
        const env = (window as CrossRuntimeWindow).isolatedEnv;
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
                    pulls: Array.from(account.pulls?.entries?.() || []).map(([pullId, pull]: [string, any]) => ({
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
                    deltas: Array.from(account.deltas?.entries?.() || [])
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
      const env = (window as CrossRuntimeWindow).isolatedEnv;
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
            lastFinalizedJHeight?: number;
            requestedRebalance?: Map<number, unknown>;
            shadow?: { rebalance?: { policy?: Map<number, unknown> } };
            deltas?: Map<number, unknown>;
            leftEntity?: string;
            rightEntity?: string;
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
          const left = normalizeEntityId(account.leftEntity);
          const right = normalizeEntityId(account.rightEntity);
          if ((left === owner && right === target) || (right === owner && left === target)) return account;
        }
        return null;
      };
      const replica = env?.state.eReplicas?.get(`${identity.entityId}:${identity.signerId}`.toLowerCase());
      const accounts = replica?.state?.accounts;
      if (!(accounts instanceof Map)) return null;
      const account = resolveCounterpartyAccount(accounts, identity.entityId, hubId);
      if (!account) return null;
      const delta = account.deltas?.get?.(tokenId);
      if (!delta || typeof delta !== 'object') return null;
      const policy = account.shadow?.rebalance?.policy?.get?.(tokenId);
      const policyRecord = policy && typeof policy === 'object' ? (policy as Record<string, unknown>) : null;
      const deltaRecord = delta as Record<string, unknown>;
      const owner = normalizeEntityId(identity.entityId);
      const left = normalizeEntityId(account.leftEntity);
      const ownerIsLeft = left ? owner === left : owner < normalizeEntityId(hubId);
      return {
        entityId: String(identity.entityId || ''),
        counterpartyId: String(hubId || ''),
        tokenId: Number(tokenId),
        jurisdiction: String(replica?.state?.config?.jurisdiction?.name || replica?.position?.jurisdiction || ''),
        ownerIsLeft,
        currentHeight: Number(account.currentHeight || 0),
        lastFinalizedJHeight: Number(account.lastFinalizedJHeight || 0),
        requested: readBig(account.requestedRebalance?.get?.(tokenId)),
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

export async function selectContextEntity(page: Page, identity: RuntimeIdentity): Promise<void> {
  const trigger = page.getByTestId('context-current').first();
  await expect(trigger).toBeVisible({ timeout: 20_000 });
  if (normalizeId((await trigger.getAttribute('data-entity-id')) || '') === normalizeId(identity.entityId)) return;
  await trigger.click();
  const row = page
    .locator(`[data-testid="context-entity-row"][data-entity-id="${normalizeId(identity.entityId)}"]`)
    .first();
  await expect(row).toBeVisible({ timeout: 20_000 });
  await row.click();
  await expect
    .poll(
      async () => ({
        entityId: normalizeId((await trigger.getAttribute('data-entity-id')) || ''),
        signerId: normalizeId((await trigger.getAttribute('data-signer-id')) || ''),
      }),
      {
        timeout: 20_000,
        intervals: [100, 250, 500],
        message: `context must switch to ${identity.entityId.slice(0, 10)}`,
      },
    )
    .toEqual({ entityId: normalizeId(identity.entityId), signerId: normalizeId(identity.signerId) });
}

export async function dismissSwapCompletionModal(page: Page): Promise<void> {
  if (page.isClosed()) return;
  // The terminal Account frame and Svelte dialog are observed on different
  // microtasks. Let two paint cycles publish the dialog before deciding it is
  // absent; otherwise the next navigation click can race a freshly mounted
  // modal for the rest of the Playwright timeout.
  await page.evaluate(
    () =>
      new Promise<void>(resolve => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }),
  );
  const completionClose = page.getByTestId('swap-completion-close').first();
  if (await completionClose.isVisible({ timeout: 1_000 }).catch(() => false)) {
    await completionClose.click();
    await expect(completionClose).toBeHidden({ timeout: 5_000 });
  }
}

export async function openSwapWorkspace(page: Page): Promise<void> {
  await dismissSwapCompletionModal(page);
  const accountsTab = page.getByTestId('tab-accounts').first();
  await expect(accountsTab).toBeVisible({ timeout: 20_000 });
  await accountsTab.click();
  const swapTab = page.getByTestId('account-workspace-tab-swap').first();
  try {
    await expect(swapTab).toBeVisible({ timeout: 20_000 });
  } catch (error) {
    const debug = await page.evaluate(() => {
      const current = document.querySelector('[data-testid="context-current"]');
      const entityId = String(current?.getAttribute('data-entity-id') || '').toLowerCase();
      const env = (window as CrossRuntimeWindow).isolatedEnv;
      const replica = Array.from(env?.state.eReplicas?.values?.() || []).find(
        (candidate: any) => String(candidate?.state?.entityId || '').toLowerCase() === entityId,
      ) as any;
      const state = replica?.state;
      return {
        entityId,
        height: Number(state?.height || 0),
        accounts: Array.from(state?.accounts?.entries?.() || []).map(([counterpartyId, account]: any) => ({
          counterpartyId,
          status: account?.status || 'active',
          currentHeight: Number(account?.currentHeight || 0),
          jNonce: Number(account?.jNonce || 0),
          activeDispute: account?.activeDispute
            ? {
                initialNonce: Number(account.activeDispute.initialNonce || 0),
                observedOnChain: Boolean(account.activeDispute.observedOnChain),
                finalizeQueued: Boolean(account.activeDispute.finalizeQueued),
                disputeTimeout: Number(account.activeDispute.disputeTimeout || 0),
              }
            : null,
        })),
        routes: Array.from(state?.crossJurisdictionSwaps?.values?.() || []).map((route: any) => ({
          orderId: route.orderId,
          status: route.status,
          source: route.source?.entityId,
          target: route.target?.counterpartyEntityId,
        })),
        messages: Array.from(state?.messages || []).slice(-50),
      };
    });
    throw new Error(
      `SWAP_WORKSPACE_UNAVAILABLE:${JSON.stringify(debug)}; ` +
        `cause=${error instanceof Error ? error.message : String(error)}`,
    );
  }
  await swapTab.click();
  await expect(page.locator('.swap-panel').first()).toBeVisible({ timeout: 15_000 });
}

export async function selectSourceChainInSwap(page: Page, sourceEntityId: string): Promise<void> {
  const sourceSelect = page.getByTestId('swap-ticket-from-network').first();
  await expect(sourceSelect).toBeVisible({ timeout: 20_000 });
  await expect
    .poll(
      async () =>
        sourceSelect
          .locator('option')
          .evaluateAll(
            (options, source) =>
              options.some(
                option =>
                  String((option as HTMLOptionElement).value || '').toLowerCase() === String(source).toLowerCase(),
              ),
            sourceEntityId,
          ),
      {
        timeout: 30_000,
        intervals: [250, 500, 1000],
        message: `source chain option for ${sourceEntityId.slice(0, 10)} must appear`,
      },
    )
    .toBe(true);
  await sourceSelect.selectOption(sourceEntityId.toLowerCase());
}

export async function selectCounterpartyInSwap(page: Page, hubId: string): Promise<void> {
  const select = page.getByTestId('swap-ticket-hub-select').first();
  await expect(select).toBeVisible({ timeout: 20_000 });
  await expect
    .poll(async () => select.locator('option').count(), {
      timeout: 30_000,
      intervals: [250, 500, 1000],
    })
    .toBeGreaterThan(0);
  await select.selectOption(hubId);
}

export async function configurePair(page: Page, side: 'buy' | 'sell'): Promise<void> {
  await configureTokens(page, side === 'buy' ? USDC : WETH, side === 'buy' ? WETH : USDC);
}

export async function configureTokens(page: Page, fromTokenId: number, toTokenId: number): Promise<void> {
  const fromTokenSelect = page.getByTestId('swap-ticket-from-token').first();
  const toTokenSelect = page.getByTestId('swap-ticket-to-token').first();
  await expect(fromTokenSelect).toBeVisible({ timeout: 20_000 });
  await expect(toTokenSelect).toBeVisible({ timeout: 20_000 });
  await fromTokenSelect.selectOption(String(fromTokenId));
  await toTokenSelect.selectOption(String(toTokenId));
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
  const routeSelect = page.getByTestId('swap-ticket-to-network').first();
  await expect(routeSelect).toBeVisible({ timeout: 20_000 });
  try {
    await expect
      .poll(
        async () =>
          routeSelect.locator('option').evaluateAll(
            (options, target) =>
              options.some(option =>
                String((option as HTMLOptionElement).value || '')
                  .toLowerCase()
                  .startsWith(`${String(target).toLowerCase()}:`),
              ),
            targetEntityId,
          ),
        {
          timeout: 30_000,
          intervals: [250, 500, 1000],
          message: `cross route to ${targetEntityId.slice(0, 10)} must appear`,
        },
      )
      .toBe(true);
  } catch (error) {
    const debug = await page.evaluate(() => {
      const view = window as CrossRuntimeWindow;
      const env = view.isolatedEnv;
      const routeOptions = Array.from(document.querySelectorAll('[data-testid="swap-ticket-to-network"] option')).map(
        option => ({
          value: (option as HTMLOptionElement).value,
          text: option.textContent,
          disabled: (option as HTMLOptionElement).disabled,
        }),
      );
      const sourceOptions = Array.from(document.querySelectorAll('[data-testid="swap-ticket-from-network"] option')).map(
        option => ({
          value: (option as HTMLOptionElement).value,
          text: option.textContent,
        }),
      );
      const profiles = env?.gossip?.getProfiles?.() || [];
      const hubProfiles = profiles
        .filter((profile: any) => profile?.metadata?.isHub === true)
        .map((profile: any) => ({
          entityId: String(profile?.entityId || '').slice(0, 10),
          name: String(profile?.name || ''),
          jurisdiction: String(profile?.metadata?.jurisdiction?.name || ''),
        }));
      const replicas = Array.from(env?.state.eReplicas?.entries?.() || []).map(([key, replica]: [string, any]) => ({
        key: String(key).slice(0, 22),
        entityId: String(replica?.entityId || replica?.state?.entityId || '').slice(0, 10),
        signerId: String(replica?.signerId || '').slice(0, 10),
        profileName: String(replica?.state?.profile?.name || ''),
        jurisdiction: String(replica?.state?.config?.jurisdiction?.name || replica?.position?.jurisdiction || ''),
        accounts: Array.from(replica?.state?.accounts?.keys?.() || []).map(id => String(id).slice(0, 10)),
      }));
      return { routeOptions, sourceOptions, hubProfiles, replicas };
    });
    console.log('[E2E cross route debug]', JSON.stringify(debug, null, 2));
    throw error;
  }
  const value = await routeSelect.locator('option').evaluateAll((options, target) => {
    const found = options.find(option =>
      String((option as HTMLOptionElement).value || '')
        .toLowerCase()
        .startsWith(`${String(target).toLowerCase()}:`),
    ) as HTMLOptionElement | undefined;
    return String(found?.value || '');
  }, targetEntityId);
  expect(value, 'cross route value must be present').toBeTruthy();
  await routeSelect.selectOption(value);
  await expect
    .poll(
      async () =>
        routeSelect.evaluate(select => ({
          value: String((select as HTMLSelectElement).value || ''),
          options: Array.from((select as HTMLSelectElement).options).map(option => String(option.value || '')),
        })),
      {
        timeout: 10_000,
        intervals: [100, 250, 500],
        message: 'cross route select must retain the chosen route instead of falling back to same-chain',
      },
    )
    .toMatchObject({
      value,
      options: expect.arrayContaining([value]),
    });
  const selectedOptionLabel = await routeSelect.evaluate(select => {
    const element = select as HTMLSelectElement;
    return String(element.selectedOptions[0]?.textContent || '')
      .replace(/\s+/g, ' ')
      .trim();
  });
  expect(selectedOptionLabel, 'cross route option must name the target jurisdiction once').toMatch(
    /\((Testnet|Tron)\)/,
  );
  await expect(
    routeSelect,
    'cross route selection must remain selected after the reactive UI update',
  ).toHaveValue(value);
  await expect(
    routeSelect.locator('xpath=..').locator('.swap-ticket-sel-text'),
    'the visible destination label must match the selected route',
  ).toHaveText(selectedOptionLabel);
}
