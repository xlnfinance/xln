import { test, expect, type BrowserContext, type Page } from './global-setup.mts';
import { AbiCoder, HDNodeWallet, Mnemonic, Wallet, getIndexedAccountPath, keccak256, toUtf8Bytes } from 'ethers';
import { deriveDelta, getTokenInfo } from '../runtime/account/utils';
import { ensureE2EBaseline, type E2EHealthResponse } from './utils/e2e-baseline';
import { connectRuntimeToHubWithCredit } from './utils/e2e-connect';
import { gotoApp } from './utils/e2e-demo-users';
import { enqueueEntityTxs } from './utils/e2e-runtime-input';
import { requireIsolatedBaseUrl } from './utils/e2e-isolated-env';
import { timedStep } from './utils/e2e-timing.mts';
import { hasSilentRelayMarketSubscribe, installSilentRelayWebSocket } from './utils/e2e-silent-relay';

const INIT_TIMEOUT = 30_000;
const APP_BASE_URL = requireIsolatedBaseUrl('E2E_BASE_URL');
const API_BASE_URL = requireIsolatedBaseUrl('E2E_API_BASE_URL');
const SWAP_TOKENS = [1, 2, 3] as const;
const DEFAULT_USDC_REBALANCE_SOFT_LIMIT = 500n * 10n ** 6n;
const USDC = 1;
const WETH = 2;
const USDT = 3;
const tokenAmount = (tokenId: number, wholeTokens: bigint): bigint =>
  wholeTokens * 10n ** BigInt(getTokenInfo(tokenId).decimals);
const TOKEN_SYMBOL_BY_ID: Record<number, string> = {
  [USDC]: 'USDC',
  [WETH]: 'WETH',
  [USDT]: 'USDT',
};

const CROSS_J_SOURCE_COMMITTED_OR_ADVANCED_STATUSES = new Set([
  'resting',
  'partially_filled',
  'clear_requested',
  'clearing',
  'source_claimed',
  'target_claimed',
  'settled',
]);

type BrowserConsoleGuard = {
  errors: string[];
  warnings: string[];
};

function isIgnoredBrowserConsoleMessage(text: string): boolean {
  return /chrome-extension:|moz-extension:|safari-web-extension:|inpageBootstrap\.js|Ignoring Event: localhost/i.test(text);
}

function attachBrowserConsoleGuard(page: Page): BrowserConsoleGuard {
  const guard: BrowserConsoleGuard = {
    errors: [],
    warnings: [],
  };
  page.on('console', (message) => {
    const location = message.location();
    const suffix = location.url ? ` @ ${location.url}:${location.lineNumber}:${location.columnNumber}` : '';
    const text = `${message.text()}${suffix}`;
    if (isIgnoredBrowserConsoleMessage(text)) return;
    if (message.type() === 'error') guard.errors.push(text);
    if (message.type() === 'warning') guard.warnings.push(text);
  });
  page.on('pageerror', (error) => {
    const text = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    if (!isIgnoredBrowserConsoleMessage(text)) guard.errors.push(text);
  });
  return guard;
}

function expectBrowserConsoleClean(guard: BrowserConsoleGuard, label: string): void {
  expect(
    guard.errors,
    `${label} browser console errors:\n${guard.errors.join('\n')}`,
  ).toHaveLength(0);
  expect(
    guard.warnings,
    `${label} browser console warnings:\n${guard.warnings.join('\n')}`,
  ).toHaveLength(0);
}

type RuntimeIdentity = {
  entityId: string;
  signerId: string;
  runtimeId: string;
};

type JurisdictionIdentity = RuntimeIdentity & {
  jurisdictionName: string;
};

type HubEntityInfo = {
  entityId: string;
  signerId: string;
  name?: string;
  jurisdictionName: string;
  primary: boolean;
};

type SyntheticJEventInput = {
  event: {
    type: string;
    data: Record<string, unknown>;
  };
  transactionHash: string;
};

type CrossRuntimeWindow = Window & {
  isolatedEnv?: {
    runtimeId?: string;
    eReplicas?: Map<string, any>;
    jReplicas?: Map<string, any>;
  };
  __xln?: {
    instance?: any;
  };
};

type CrossResolveSnapshot = {
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

function getPrimaryHubId(health: E2EHealthResponse): string {
  const hubId = health.hubMesh?.hubIds?.[0];
  expect(hubId, `hub mesh must expose a primary hub: ${JSON.stringify(health.hubMesh || {})}`).toMatch(/^0x[a-fA-F0-9]{64}$/);
  return hubId!;
}

function expectMarketMakerSameAndCrossBooksHealthy(health: E2EHealthResponse): void {
  const marketMaker = health.marketMaker;
  expect(marketMaker?.ok, `market maker must be ready before swap tests: ${JSON.stringify(marketMaker ?? {})}`).toBe(true);
  expect(marketMaker?.hubs?.length ?? 0, 'market maker must publish same-chain books for all primary hubs').toBeGreaterThanOrEqual(3);
  for (const hub of marketMaker?.hubs ?? []) {
    expect(hub.ready, `same-chain MM hub ${hub.hubEntityId} must be ready`).toBe(true);
    expect(hub.depthReady, `same-chain MM hub ${hub.hubEntityId} must expose exact configured depth`).toBe(true);
    let expectedHubOffers = 0;
    for (const pair of hub.pairs ?? []) {
      expect(pair.ready, `same-chain MM pair ${pair.pairId} on hub ${hub.hubEntityId} must be ready`).toBe(true);
      expect(pair.depthReady, `same-chain MM pair ${pair.pairId} on hub ${hub.hubEntityId} must expose exact configured depth`).toBe(true);
      expect(pair.expectedOffers, `same-chain MM pair ${pair.pairId} must declare expected depth`).toBeGreaterThan(0);
      expect(pair.offers, `same-chain MM pair ${pair.pairId} must contain exactly its configured offers`).toBe(pair.expectedOffers);
      expectedHubOffers += Number(pair.expectedOffers);
    }
    expect(hub.offers, `same-chain MM hub ${hub.hubEntityId} must contain only its configured offers`).toBe(expectedHubOffers);
  }

  const cross = marketMaker?.cross;
  expect(cross?.ok, `cross-chain MM books must be ready: ${JSON.stringify(cross ?? {})}`).toBe(true);
  expect(cross?.expectedRoutes ?? 0, 'ETH/TRON cross-chain MM must declare expected routes').toBeGreaterThan(0);
  expect(cross?.routes?.length ?? 0, 'ETH/TRON cross-chain MM must expose all route books').toBeGreaterThanOrEqual(cross?.expectedRoutes ?? 0);
  type CrossHealthPair = {
    pairId?: string;
    sourceTokenIds?: number[];
    targetTokenIds?: number[];
  };
  const isTronOnlyToken = (tokenId: number): boolean => tokenId === 4 || tokenId === 5;
  const hasTronOnlySourcePair = (cross?.routes ?? []).some(route =>
    /tron/i.test(String(route.sourceJurisdiction || '')) &&
    (route.pairs ?? []).some(pair =>
      ((pair as CrossHealthPair).sourceTokenIds ?? []).some(isTronOnlyToken),
    ),
  );
  const hasTronOnlyTargetPair = (cross?.routes ?? []).some(route =>
    /tron/i.test(String(route.targetJurisdiction || '')) &&
    (route.pairs ?? []).some(pair =>
      ((pair as CrossHealthPair).targetTokenIds ?? []).some(isTronOnlyToken),
    ),
  );
  const tronOnlyLeaksIntoTestnet = (cross?.routes ?? []).flatMap(route => {
    const sourceIsTestnet = /testnet/i.test(String(route.sourceJurisdiction || ''));
    const targetIsTestnet = /testnet/i.test(String(route.targetJurisdiction || ''));
    return (route.pairs ?? []).flatMap(pair => {
      const sourceTokenIds = ((pair as CrossHealthPair).sourceTokenIds ?? []).filter(isTronOnlyToken);
      const targetTokenIds = ((pair as CrossHealthPair).targetTokenIds ?? []).filter(isTronOnlyToken);
      const leaks =
        (sourceIsTestnet && sourceTokenIds.length > 0) ||
        (targetIsTestnet && targetTokenIds.length > 0);
      return leaks ? [{
        sourceJurisdiction: route.sourceJurisdiction,
        targetJurisdiction: route.targetJurisdiction,
        pairId: pair.pairId,
        sourceTokenIds,
        targetTokenIds,
      }] : [];
    });
  });
  expect(hasTronOnlySourcePair, 'Tron source cross MM books must include Tron-only TRX/SUN token pairs').toBe(true);
  expect(hasTronOnlyTargetPair, 'Tron target cross MM books must include Tron-only TRX/SUN token pairs').toBe(true);
  expect(tronOnlyLeaksIntoTestnet, 'Testnet side must not publish Tron-only token ids').toEqual([]);
  for (const route of cross?.routes ?? []) {
    expect(route.ready, `cross MM route ${route.sourceHubEntityId}->${route.targetHubEntityId} must be ready`).toBe(true);
    expect(route.depthReady, `cross MM route ${route.sourceHubEntityId}->${route.targetHubEntityId} must expose exact configured depth`).toBe(true);
    expect(route.sourceJurisdiction, 'cross MM route source jurisdiction must be present').not.toEqual(route.targetJurisdiction);
    let expectedRouteOffers = 0;
    for (const pair of route.pairs ?? []) {
      expect(pair.ready, `cross MM pair ${pair.pairId} on ${route.sourceHubEntityId}->${route.targetHubEntityId} must be ready`).toBe(true);
      expect(pair.depthReady, `cross MM pair ${pair.pairId} on ${route.sourceHubEntityId}->${route.targetHubEntityId} must expose exact configured depth`).toBe(true);
      expect(pair.expectedOffers, `cross MM pair ${pair.pairId} must declare expected depth`).toBeGreaterThan(0);
      expect(pair.offers, `cross MM pair ${pair.pairId} must contain exactly its configured offers`).toBe(pair.expectedOffers);
      expectedRouteOffers += Number(pair.expectedOffers);
    }
    expect(route.offers, `cross MM route ${route.sourceHubEntityId}->${route.targetHubEntityId} must contain only configured offers`).toBe(expectedRouteOffers);
  }
}

function getPrimaryHubApiBaseUrl(health: E2EHealthResponse, primaryHubId: string): string {
  const hub = (health.hubs || []).find((entry) => normalizeId(entry.entityId) === normalizeId(primaryHubId)) as
    | (E2EHealthResponse['hubs'][number] & { apiPort?: number; apiUrl?: string })
    | undefined;
  if (hub?.apiUrl) return String(hub.apiUrl).replace(/\/$/, '');
  const apiPort = Number(hub?.apiPort);
  expect(Number.isFinite(apiPort) && apiPort > 0, `primary hub API port missing: ${JSON.stringify(hub || null)}`).toBe(true);
  return `http://127.0.0.1:${apiPort}`;
}

function getPrimaryHubName(health: E2EHealthResponse, primaryHubId: string): string {
  return String((health.hubs || []).find((entry) => normalizeId(entry.entityId) === normalizeId(primaryHubId))?.name || '').trim();
}

function getIsolatedHubRuntimeSeed(hubName: string): string {
  const name = String(hubName || '').trim().toLowerCase();
  expect(name, 'isolated cross-j source hub name is required to derive source pull args').toBeTruthy();
  return `xln-e2e-${name}`;
}

async function getSecondaryHubInfo(
  page: Page,
  primaryHubId: string,
  primaryHubName: string,
  hubApiBaseUrl: string,
): Promise<HubEntityInfo> {
  let found: HubEntityInfo | null = null;
  const normalizedPrimaryName = String(primaryHubName || '').trim().toLowerCase();
  await expect.poll(
    async () => {
      const response = await page.request.get(`${hubApiBaseUrl}/api/info`, {
        headers: { 'Cache-Control': 'no-store' },
        timeout: 5_000,
      }).catch(() => null);
      if (!response?.ok()) return false;
      const body = await response.json().catch(() => null) as { hubEntities?: HubEntityInfo[] } | null;
      const hubEntities = Array.isArray(body?.hubEntities) ? body!.hubEntities : [];
      found = hubEntities.find((hub) =>
        normalizeId(hub.entityId) !== normalizeId(primaryHubId) &&
        hub.primary !== true &&
        (!normalizedPrimaryName || String(hub.name || '').trim().toLowerCase().startsWith(normalizedPrimaryName)) &&
        /tron|rpc2|local/i.test(String(hub.jurisdictionName || '')),
      ) || hubEntities.find((hub) =>
        normalizeId(hub.entityId) !== normalizeId(primaryHubId) &&
        hub.primary !== true &&
        (!normalizedPrimaryName || String(hub.name || '').trim().toLowerCase().startsWith(normalizedPrimaryName)),
      ) || null;
      return Boolean(found?.entityId);
    },
    {
      timeout: 60_000,
      intervals: [250, 500, 1000],
      message: 'primary hub node must expose a secondary jurisdiction hub entity',
    },
  ).toBe(true);
  return found!;
}

function normalizeId(value: string): string {
  return String(value || '').trim().toLowerCase();
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function deriveJurisdictionSignerIndex(jurisdiction: string): number {
  const key = String(jurisdiction || '').trim().toLowerCase();
  const digest = keccak256(toUtf8Bytes(`xln:jurisdiction-signer:v1:${key}`));
  return 100_000 + Number(BigInt(digest) % 1_000_000n);
}

function deriveSigner(mnemonic: string, jurisdictionName: string): { address: string; privateKey: string } {
  const hd = HDNodeWallet.fromMnemonic(
    Mnemonic.fromPhrase(mnemonic.trim().split(/\s+/).join(' ')),
    getIndexedAccountPath(deriveJurisdictionSignerIndex(jurisdictionName)),
  );
  return { address: hd.address.toLowerCase(), privateKey: hd.privateKey };
}

async function injectSyntheticJEventThroughWatcher(
  page: Page,
  identity: RuntimeIdentity,
  input: SyntheticJEventInput,
): Promise<void> {
  await page.evaluate(async ({ identity, input }) => {
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
    const entityReplica = [...(env.eReplicas?.values?.() || [])].find((replica: any) =>
      String(replica?.state?.entityId || '').toLowerCase() === entityId &&
      String(replica?.signerId || '').toLowerCase() === signerId
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
    const watcherMatches = [...(env.jReplicas?.values?.() || [])].filter((replica: any) => {
      const chainId = Number(replica?.chainId ?? replica?.jadapter?.chainId);
      const depository = String(
        replica?.depositoryAddress || replica?.contracts?.depository || replica?.jadapter?.addresses?.depository || '',
      ).toLowerCase();
      return chainId === expectedChainId && depository === expectedDepository;
    });
    if (watcherMatches.length !== 1) {
      throw new Error(
        `synthetic J watcher resolution failed: chain=${expectedChainId} ` +
        `depository=${expectedDepository} matches=${watcherMatches.length}`,
      );
    }
    const rpcUrlRaw = String(
      watcherMatches[0]?.rpcs?.[0] || jurisdiction.rpc || '',
    );
    if (!rpcUrlRaw) throw new Error(`synthetic J watcher RPC missing: chain=${expectedChainId}`);
    const rpcUrl = rpcUrlRaw.startsWith('/')
      ? new URL(rpcUrlRaw, window.location.origin).toString()
      : rpcUrlRaw;
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
      const payload = await response.json() as RpcPayload;
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

    runtimeModule.applyJEventsToEnv(env, [{
      name: input.event.type,
      args: input.event.data,
      blockNumber,
      blockHash: canonicalBlockHash,
      transactionHash: input.transactionHash,
      logIndex: 0,
    }], 'e2e-cross-j-source-dispute', watcherMatches[0]);
  }, { identity, input });
}

async function importRpc2SiblingEntity(
  page: Page,
  mnemonic: string,
  label: string,
): Promise<JurisdictionIdentity> {
  const result = await page.evaluate(async ({ mnemonic, label }) => {
    const view = window as CrossRuntimeWindow;
    const env = view.isolatedEnv;
    if (!env) throw new Error('isolatedEnv missing');

    const response = await fetch(`/api/jurisdictions?ts=${Date.now()}`, { cache: 'no-store' });
    if (!response.ok) throw new Error(`jurisdictions fetch failed: ${response.status}`);
    const body = await response.json() as { jurisdictions?: Record<string, any> };
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

    const hasConnectedAdapter = (replica: any): boolean => Boolean(
      replica?.jadapter?.addresses?.depository &&
        replica?.jadapter?.addresses?.entityProvider &&
        replica?.jadapter?.depository &&
        replica?.jadapter?.entityProvider &&
        typeof replica?.jadapter?.submitTx === 'function',
    );
    if (!hasConnectedAdapter(env.jReplicas?.get(jurisdictionName))) {
      runtimeModule.enqueueRuntimeInput(env, {
        runtimeTxs: [{
          type: 'importJ',
          data: {
            name: jurisdictionName,
            chainId: Number(jurisdictionRaw.chainId || 31338),
            ticker: String(jurisdictionRaw.currency || 'TRX'),
            rpcs: [rpc],
            blockTimeMs,
            contracts: {
              depository: String(contracts.depository),
              entityProvider: String(contracts.entityProvider),
              account: String(contracts.account || ''),
              deltaTransformer: String(contracts.deltaTransformer || ''),
            },
          },
        }],
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
  }, { mnemonic, label });

  await expect.poll(
    async () => page.evaluate((jurisdictionName) => {
      const env = (window as CrossRuntimeWindow).isolatedEnv;
      const replica = env?.jReplicas?.get(jurisdictionName);
      return Boolean(
        replica?.jadapter?.addresses?.depository &&
          replica?.jadapter?.addresses?.entityProvider &&
          replica?.jadapter?.depository &&
          replica?.jadapter?.entityProvider &&
          typeof replica?.jadapter?.submitTx === 'function',
      );
    }, result.jurisdictionName),
    {
      timeout: 60_000,
      intervals: [250, 500, 1000],
      message: `${label} runtime must import connected rpc2 jurisdiction adapter`,
    },
  ).toBe(true);

  const signer = deriveSigner(mnemonic, result.jurisdictionName);
  const sibling = await page.evaluate(async ({ signer, label, jurisdiction }) => {
    const view = window as CrossRuntimeWindow;
    const env = view.isolatedEnv;
    if (!env) throw new Error('isolatedEnv missing');
    const runtimeModule = view.__xln?.instance;
    if (!runtimeModule) throw new Error('__xln.instance missing');
    const privateKeyBytes = new Uint8Array(
      signer.privateKey.slice(2).match(/.{2}/g).map((byte: string) => Number.parseInt(byte, 16)),
    );
    runtimeModule.registerSignerKey(env, signer.address, privateKeyBytes);
    const entityId = runtimeModule.generateLazyEntityId([signer.address], 1n).toLowerCase();
    const { config } = runtimeModule.createLazyEntity(`${label}-rpc2`, [signer.address], 1n, jurisdiction);
    const replicaKey = `${entityId}:${signer.address}`.toLowerCase();
    if (!env.eReplicas?.has(replicaKey)) {
      runtimeModule.enqueueRuntimeInput(env, {
        runtimeTxs: [{
          type: 'importReplica',
          entityId,
          signerId: signer.address,
          data: {
            isProposer: true,
            config,
            profileName: `${label}-rpc2`,
            position: { x: 240, y: 0, z: 0, jurisdiction: jurisdiction.name },
          },
        }],
        entityInputs: [],
      });
    }
    return { entityId, signerId: signer.address };
  }, { signer, label, jurisdiction: result.jurisdiction });

  await expect.poll(
    async () => page.evaluate(({ entityId, signerId }) => {
      const env = (window as CrossRuntimeWindow).isolatedEnv;
      return Boolean(env?.eReplicas?.has(`${entityId}:${signerId}`.toLowerCase()));
    }, sibling),
    {
      timeout: 60_000,
      intervals: [250, 500, 1000],
      message: `${label} rpc2 sibling entity must hydrate`,
    },
  ).toBe(true);

  return {
    entityId: sibling.entityId,
    signerId: sibling.signerId,
    runtimeId: String(result.runtimeId || ''),
    jurisdictionName: String(result.jurisdictionName || ''),
  };
}

async function waitForAccountReady(
  page: Page,
  identity: RuntimeIdentity,
  hubId: string,
  tokenIds: readonly number[],
  timeoutMs = 75_000,
): Promise<void> {
  await expect.poll(
    async () => page.evaluate(({ identity, hubId, tokenIds }) => {
      const env = (window as CrossRuntimeWindow).isolatedEnv;
      const replica = env?.eReplicas?.get(`${identity.entityId}:${identity.signerId}`.toLowerCase());
      const normalizeEntityId = (value: unknown): string => String(value || '').trim().toLowerCase();
      const resolveCounterpartyAccount = (
        accounts: Map<string, {
          currentHeight?: number;
          pendingFrame?: unknown;
          deltas?: Map<number, unknown>;
          leftEntity?: string;
          rightEntity?: string;
        }>,
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
      const account = accounts instanceof Map
        ? resolveCounterpartyAccount(accounts, identity.entityId, hubId)
        : null;
      if (!account || Number(account.currentHeight || 0) <= 0 || account.pendingFrame) return false;
      return tokenIds.every((tokenId: number) => account.deltas instanceof Map && account.deltas.has(tokenId));
    }, { identity, hubId, tokenIds: Array.from(tokenIds) }),
    {
      timeout: timeoutMs,
      intervals: [250, 500, 1000],
      message: `${identity.entityId.slice(0, 10)} account with hub must activate tokens ${tokenIds.join(',')}`,
    },
  ).toBe(true);
}

async function waitForHubProfile(page: Page, hubId: string): Promise<void> {
  await expect.poll(
    async () => page.evaluate((targetHubId) => {
      const view = window as CrossRuntimeWindow & {
        p2p?: { refreshGossip?: () => void };
      };
      const env = view.isolatedEnv;
      view.__xln?.instance?.refreshGossip?.(env);
      view.p2p?.refreshGossip?.();
      const target = String(targetHubId || '').toLowerCase();
      const profiles = env?.gossip?.getProfiles?.() || [];
      return profiles.some((profile: any) =>
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
  ).toBe(true);
}

async function flushRuntime(page: Page, rounds = 3): Promise<void> {
  await page.evaluate(async (roundsToRun) => {
    const view = window as CrossRuntimeWindow;
    const env = view.isolatedEnv;
    if (!env) throw new Error('isolatedEnv missing');
    const runtimeModule = view.__xln?.instance as {
      startRuntimeLoop?: (env: unknown) => unknown;
      waitForRuntimeProcessingIdle?: (env: unknown, timeoutMs?: number) => Promise<boolean>;
    } | undefined;
    if (!runtimeModule) throw new Error('__xln.instance missing');
    if (env.runtimeState?.halted) {
      throw new Error(`runtime halted before flush: ${JSON.stringify(env.runtimeState.fatalDebugPayload || {})}`);
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
      if (env.runtimeState?.halted) {
        throw new Error(`runtime halted during flush: ${JSON.stringify(env.runtimeState.fatalDebugPayload || {})}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    view.isolatedEnv = env as NonNullable<CrossRuntimeWindow['isolatedEnv']>;
  }, rounds);
}

async function ensureDirectHubAccount(
  page: Page,
  identity: RuntimeIdentity,
  hubId: string,
  tokenIds: readonly number[],
  timeoutMs = 75_000,
): Promise<void> {
  await waitForHubProfile(page, hubId);
  const hasAccount = await page.evaluate(({ identity, hubId }) => {
    const env = (window as CrossRuntimeWindow).isolatedEnv;
    const replica = env?.eReplicas?.get(`${identity.entityId}:${identity.signerId}`.toLowerCase());
    return Boolean(replica?.state?.accounts?.get(hubId));
  }, { identity, hubId });

  if (!hasAccount) {
    await enqueueEntityTxs(page, identity.entityId, identity.signerId, [{
      type: 'openAccount',
      data: {
        targetEntityId: hubId,
        tokenId: USDC,
        creditAmount: tokenAmount(USDC, 10_000n),
      },
    }]);
    await flushRuntime(page, 8);
  }
  await waitForAccountReady(page, identity, hubId, [USDC], timeoutMs);

  const hasGrantedHubCredit = async (tokenId: number): Promise<boolean> => page.evaluate(({ identity, hubId, tokenId, amount }) => {
    const env = (window as CrossRuntimeWindow).isolatedEnv;
    const replica = env?.eReplicas?.get(`${identity.entityId}:${identity.signerId}`.toLowerCase());
    const normalizeEntityId = (value: unknown): string => String(value || '').trim().toLowerCase();
    const readBig = (value: unknown): bigint => {
      if (typeof value === 'bigint') return value;
      if (typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value)) return BigInt(value);
      if (typeof value === 'string' && /^-?\d+$/.test(value.trim())) return BigInt(value.trim());
      return 0n;
    };
    const resolveCounterpartyAccount = (
      accounts: Map<string, {
        currentHeight?: number;
        pendingFrame?: unknown;
        deltas?: Map<number, unknown>;
        leftEntity?: string;
        rightEntity?: string;
      }>,
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
    const account = accounts instanceof Map
      ? resolveCounterpartyAccount(accounts, identity.entityId, hubId)
      : null;
    if (!account || Number(account.currentHeight || 0) <= 0 || account.pendingFrame) return false;
    if (!(account.deltas instanceof Map)) return false;
    const rawDelta = account.deltas.get(tokenId);
    if (!rawDelta || typeof rawDelta !== 'object') return false;
    const delta = rawDelta as Record<string, unknown>;
    const owner = normalizeEntityId(identity.entityId);
    const left = normalizeEntityId(account.leftEntity);
    const ownerIsLeft = left ? owner === left : owner < normalizeEntityId(hubId);
    const creditGrantedToHub = ownerIsLeft
      ? readBig(delta.rightCreditLimit)
      : readBig(delta.leftCreditLimit);
    return creditGrantedToHub >= BigInt(amount);
  }, { identity, hubId, tokenId, amount: tokenAmount(tokenId, 10_000n).toString() });

  for (const tokenId of tokenIds) {
    if (!await hasGrantedHubCredit(tokenId)) {
      await enqueueEntityTxs(page, identity.entityId, identity.signerId, [{
        type: 'extendCredit',
        data: {
          counterpartyEntityId: hubId,
          tokenId,
          amount: tokenAmount(tokenId, 10_000n),
        },
      }]);
      await flushRuntime(page, 8);
    }
    await expect.poll(
      async () => {
        await flushRuntime(page, 2);
        return hasGrantedHubCredit(tokenId);
      },
      {
        timeout: timeoutMs,
        intervals: [250, 500, 1000],
        message: `${identity.entityId.slice(0, 10)} must grant hub credit token=${tokenId}`,
      },
    ).toBe(true);
  }
}

async function waitForDefaultJurisdictionReplicas(page: Page, label: string): Promise<void> {
  await expect.poll(
    async () => page.evaluate(() => {
      const env = (window as CrossRuntimeWindow).isolatedEnv;
      const jurisdictions = Array.from(env?.jReplicas?.keys?.() || []).map((name) => String(name));
      const replicas = Array.from(env?.jReplicas?.values?.() || []);
      const isConnected = (replica: any): boolean => Boolean(
        replica?.jadapter?.addresses?.depository &&
          replica?.jadapter?.addresses?.entityProvider &&
          replica?.jadapter?.depository &&
          replica?.jadapter?.entityProvider &&
          typeof replica?.jadapter?.submitTx === 'function',
      );
      const entities = Array.from(env?.eReplicas?.values?.() || []).map((replica: any) => ({
        entityId: String(replica?.state?.entityId || replica?.entityId || ''),
        signerId: String(replica?.signerId || ''),
        jurisdiction: String(replica?.state?.config?.jurisdiction?.name || replica?.position?.jurisdiction || ''),
      }));
      const entityJurisdictions = new Set(
        entities
          .map((entry) => entry.jurisdiction.trim().toLowerCase())
          .filter(Boolean),
      );
      return {
        jurisdictionCount: jurisdictions.length,
        entityJurisdictionCount: entityJurisdictions.size,
        hasTestnet: jurisdictions.some((name) => /^testnet$/i.test(name)),
        hasSecondary: jurisdictions.some((name) => /tron|rpc2|second/i.test(name)),
        hasTestnetAdapter: replicas.some((replica: any) => /^testnet$/i.test(String(replica?.name || '')) && isConnected(replica)),
        hasSecondaryAdapter: replicas.some((replica: any) => /tron|rpc2|second/i.test(String(replica?.name || '')) && isConnected(replica)),
        entities: entities.length,
      };
    }),
    {
      timeout: 90_000,
      intervals: [250, 500, 1000],
      message: `${label} runtime must bootstrap primary and secondary jurisdiction entities by default`,
    },
  ).toMatchObject({
    hasTestnet: true,
    hasSecondary: true,
    hasTestnetAdapter: true,
    hasSecondaryAdapter: true,
  });

  await expect.poll(
    async () => page.evaluate(() => {
      const env = (window as CrossRuntimeWindow).isolatedEnv;
      const entityJurisdictions = new Set(
        Array.from(env?.eReplicas?.values?.() || [])
          .map((replica: any) => String(replica?.state?.config?.jurisdiction?.name || replica?.position?.jurisdiction || '').trim().toLowerCase())
          .filter(Boolean),
      );
      return {
        entityJurisdictionCount: entityJurisdictions.size,
        entities: Number(env?.eReplicas?.size || 0),
      };
    }),
    {
      timeout: 90_000,
      intervals: [250, 500, 1000],
      message: `${label} runtime must expose an entity for each default jurisdiction`,
    },
  ).toMatchObject({ entityJurisdictionCount: 2 });
}

async function createRuntimeIdentityViaStore(
  page: Page,
  label: string,
  mnemonic: string,
): Promise<RuntimeIdentity> {
  const normalizedMnemonic = mnemonic.trim().split(/\s+/).join(' ');
  const createOnce = async (): Promise<string> => page.evaluate(async ({ label, mnemonic }) => {
    const ops = (window as any).__xln?.vault as {
      createRuntime?: (name: string, seed: string, options?: Record<string, unknown>) => Promise<{ id?: string }>;
    } | undefined;
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
  }, { label, mnemonic: normalizedMnemonic });
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

  await expect.poll(
    async () => page.evaluate((runtimeId) => {
      const env = (window as CrossRuntimeWindow).isolatedEnv;
      if (!env?.eReplicas) return null;
      const runtimeNeedle = String(runtimeId || '').toLowerCase();
      for (const [key, replica] of env.eReplicas.entries()) {
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
  ).not.toBeNull();

  const identity = await page.evaluate((runtimeId) => {
    const env = (window as CrossRuntimeWindow).isolatedEnv;
    const runtimeNeedle = String(runtimeId || '').toLowerCase();
    for (const [key, replica] of env?.eReplicas?.entries?.() || []) {
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

async function faucetOffchain(
  page: Page,
  apiBaseUrl: string,
  entityId: string,
  hubEntityId: string,
  tokenId: number,
  amount: string,
): Promise<void> {
  let lastError = '';
  await expect.poll(
    async () => {
      const response = await page.request.post(`${apiBaseUrl.replace(/\/$/, '')}/api/faucet/offchain`, {
        data: {
          userEntityId: entityId,
          userRuntimeId: await page.evaluate(() => String((window as CrossRuntimeWindow).isolatedEnv?.runtimeId || '')),
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
  ).toBe(true);
}

async function accountCapacity(
  page: Page,
  entityId: string,
  counterpartyId: string,
  tokenId: number,
  direction: 'in' | 'out',
): Promise<bigint> {
  const delta = await page.evaluate(({ entityId, counterpartyId, tokenId }) => {
    const env = (window as CrossRuntimeWindow).isolatedEnv;
    if (!env?.eReplicas) return null;
    const readBig = (value: unknown): string => {
      if (typeof value === 'bigint') return value.toString();
      if (typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value)) return String(value);
      if (typeof value === 'string' && /^-?\d+$/.test(value.trim())) return value.trim();
      return '0';
    };
    for (const [replicaKey, replica] of env.eReplicas.entries()) {
      if (!String(replicaKey).toLowerCase().startsWith(`${String(entityId).toLowerCase()}:`)) continue;
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
  }, { entityId, counterpartyId, tokenId });
  if (!delta) return 0n;
  const derived = deriveDelta({
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
  }, normalizeId(entityId) < normalizeId(counterpartyId));
  return direction === 'in' ? derived.inCapacity : derived.outCapacity;
}

async function outCap(page: Page, entityId: string, counterpartyId: string, tokenId: number): Promise<bigint> {
  return accountCapacity(page, entityId, counterpartyId, tokenId, 'out');
}

async function inCap(page: Page, entityId: string, counterpartyId: string, tokenId: number): Promise<bigint> {
  return accountCapacity(page, entityId, counterpartyId, tokenId, 'in');
}

async function waitForOutCapAtLeast(
  page: Page,
  entityId: string,
  counterpartyId: string,
  tokenId: number,
  minimum: bigint,
): Promise<void> {
  try {
    await expect.poll(
      async () => {
        await flushRuntime(page, 2);
        return (await outCap(page, entityId, counterpartyId, tokenId)) >= minimum;
      },
      {
        timeout: 45_000,
        intervals: [250, 500, 1000],
        message: `${entityId.slice(0, 10)} outCap token=${tokenId} must reach ${minimum}`,
      },
    ).toBe(true);
  } catch (error) {
    const debug = await page.evaluate(({ entityId, counterpartyId, tokenId }) => {
      const env = (window as CrossRuntimeWindow).isolatedEnv;
      const normalize = (value: unknown) => String(value || '').toLowerCase();
      const stringifyBig = (value: unknown) => {
        if (typeof value === 'bigint') return value.toString();
        if (value === undefined || value === null) return '';
        return String(value);
      };
      const targetEntityId = normalize(entityId);
      const targetCounterpartyId = normalize(counterpartyId);
      const replicas = Array.from(env?.eReplicas?.entries?.() || [])
        .map(([key, replica]: [string, any]) => {
          const state = replica?.state;
          if (!state) return null;
          const id = normalize(state.entityId || replica.entityId);
          if (id !== targetEntityId && id !== targetCounterpartyId) return null;
          const account = state.accounts?.get?.(targetCounterpartyId) || state.accounts?.get?.(targetEntityId) || null;
          return {
            key: String(key || ''),
            entityId: String(state.entityId || replica.entityId || ''),
            signerId: String(replica.signerId || state.config?.validators?.[0] || ''),
            jurisdiction: String(state.config?.jurisdiction?.name || ''),
            messages: Array.from(state.messages || []).slice(-20).map(String),
            account: account ? {
              proofFrom: String(account.proofHeader?.fromEntity || ''),
              proofTo: String(account.proofHeader?.toEntity || ''),
              currentHeight: Number(account.currentHeight || 0),
              mempool: Array.from(account.mempool || []).map((tx: any) => String(tx?.type || '')),
              pendingFrame: Array.from(account.pendingFrame?.accountTxs || []).map((tx: any) => String(tx?.type || '')),
              pulls: Array.from(account.pulls?.entries?.() || []).map(([pullId, pull]: [string, any]) => ({
                pullId: String(pullId || ''),
                tokenId: Number(pull?.tokenId || 0),
                amount: stringifyBig(pull?.amount),
                claimedRatio: Number(pull?.claimedRatio || 0),
                claimedAmount: stringifyBig(pull?.claimedAmount),
                cross: pull?.crossJurisdiction ? {
                  orderId: String(pull.crossJurisdiction.orderId || ''),
                  leg: String(pull.crossJurisdiction.leg || ''),
                  status: String(pull.crossJurisdiction.status || ''),
                  cumulativeFillRatio: Number(pull.crossJurisdiction.cumulativeFillRatio || 0),
                  claimedRatio: Number(pull.crossJurisdiction.claimedRatio || 0),
                } : null,
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
            } : null,
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
        runtimeMempoolInputs: Array.from(env?.runtimeMempool?.entityInputs || env?.runtimeInput?.entityInputs || []).map((input: any) => ({
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
    }, { entityId, counterpartyId, tokenId });
    console.log('[E2E outcap wait debug]', JSON.stringify(debug, null, 2));
    throw error;
  }
}

type RebalanceSnapshot = {
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

async function readRebalanceSnapshot(
  page: Page,
  identity: RuntimeIdentity,
  hubId: string,
  tokenId = USDC,
): Promise<RebalanceSnapshot | null> {
  const raw = await page.evaluate(({ identity, hubId, tokenId }) => {
    const env = (window as CrossRuntimeWindow).isolatedEnv;
    const normalizeEntityId = (value: unknown): string => String(value || '').trim().toLowerCase();
    const readBig = (value: unknown): string => {
      if (typeof value === 'bigint') return value.toString();
      if (typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value)) return String(value);
      if (typeof value === 'string' && /^-?\d+$/.test(value.trim())) return value.trim();
      return '0';
    };
    const resolveCounterpartyAccount = (
      accounts: Map<string, {
        currentHeight?: number;
        lastFinalizedJHeight?: number;
        requestedRebalance?: Map<number, unknown>;
        shadow?: { rebalance?: { policy?: Map<number, unknown> } };
        deltas?: Map<number, unknown>;
        leftEntity?: string;
        rightEntity?: string;
      }>,
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
    const replica = env?.eReplicas?.get(`${identity.entityId}:${identity.signerId}`.toLowerCase());
    const accounts = replica?.state?.accounts;
    if (!(accounts instanceof Map)) return null;
    const account = resolveCounterpartyAccount(accounts, identity.entityId, hubId);
    if (!account) return null;
    const delta = account.deltas?.get?.(tokenId);
    if (!delta || typeof delta !== 'object') return null;
    const policy = account.shadow?.rebalance?.policy?.get?.(tokenId);
    const policyRecord = policy && typeof policy === 'object' ? policy as Record<string, unknown> : null;
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
  }, { identity, hubId, tokenId });
  if (!raw) return null;
  const derived = deriveDelta({
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
  }, Boolean(raw.ownerIsLeft));
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

async function waitForRebalancePolicy(
  page: Page,
  identity: RuntimeIdentity,
  hubId: string,
  tokenId = USDC,
): Promise<RebalanceSnapshot> {
  let last: RebalanceSnapshot | null = null;
  await expect.poll(
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
  ).toBe(true);
  return last!;
}

async function waitForRebalanceSecured(
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

async function selectContextEntity(page: Page, identity: RuntimeIdentity): Promise<void> {
  const trigger = page.getByTestId('context-current').first();
  await expect(trigger).toBeVisible({ timeout: 20_000 });
  if (normalizeId(await trigger.getAttribute('data-entity-id') || '') === normalizeId(identity.entityId)) return;
  await trigger.click();
  const row = page.locator(
    `[data-testid="context-entity-row"][data-entity-id="${normalizeId(identity.entityId)}"]`,
  ).first();
  await expect(row).toBeVisible({ timeout: 20_000 });
  await row.click();
  await expect.poll(
    async () => ({
      entityId: normalizeId(await trigger.getAttribute('data-entity-id') || ''),
      signerId: normalizeId(await trigger.getAttribute('data-signer-id') || ''),
    }),
    {
      timeout: 20_000,
      intervals: [100, 250, 500],
      message: `context must switch to ${identity.entityId.slice(0, 10)}`,
    },
  ).toEqual({ entityId: normalizeId(identity.entityId), signerId: normalizeId(identity.signerId) });
}

async function dismissSwapCompletionModal(page: Page): Promise<void> {
  const completionClose = page.getByTestId('swap-completion-close').first();
  if (await completionClose.isVisible({ timeout: 1_000 }).catch(() => false)) {
    await completionClose.click();
    await expect(completionClose).toBeHidden({ timeout: 5_000 });
  }
}

async function openSwapWorkspace(page: Page): Promise<void> {
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
      const replica = Array.from(env?.eReplicas?.values?.() || []).find((candidate: any) =>
        String(candidate?.state?.entityId || '').toLowerCase() === entityId,
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
          activeDispute: account?.activeDispute ? {
            initialNonce: Number(account.activeDispute.initialNonce || 0),
            observedOnChain: Boolean(account.activeDispute.observedOnChain),
            finalizeQueued: Boolean(account.activeDispute.finalizeQueued),
            disputeTimeout: Number(account.activeDispute.disputeTimeout || 0),
          } : null,
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

async function selectSourceChainInSwap(page: Page, sourceEntityId: string): Promise<void> {
  const sourceSelect = page.getByTestId('swap-from-chain-select').first();
  await expect(sourceSelect).toBeVisible({ timeout: 20_000 });
  await expect.poll(
    async () => sourceSelect.locator('option').evaluateAll((options, source) =>
      options.some((option) => String((option as HTMLOptionElement).value || '').toLowerCase() === String(source).toLowerCase()),
      sourceEntityId,
    ),
    {
      timeout: 30_000,
      intervals: [250, 500, 1000],
      message: `source chain option for ${sourceEntityId.slice(0, 10)} must appear`,
    },
  ).toBe(true);
  await sourceSelect.selectOption(sourceEntityId.toLowerCase());
}

async function selectCounterpartyInSwap(page: Page, hubId: string): Promise<void> {
  const createSelect = page.getByTestId('swap-create-account-select').first();
  const select = await createSelect.isVisible({ timeout: 1500 }).catch(() => false)
    ? createSelect
    : page.getByTestId('swap-account-select').first();
  await expect(select).toBeVisible({ timeout: 20_000 });
  await expect.poll(async () => select.locator('option').count(), {
    timeout: 30_000,
    intervals: [250, 500, 1000],
  }).toBeGreaterThan(0);
  await select.selectOption(hubId);
}

async function configurePair(page: Page, side: 'buy' | 'sell'): Promise<void> {
  await configureTokens(page, side === 'buy' ? USDC : WETH, side === 'buy' ? WETH : USDC);
}

async function configureTokens(page: Page, fromTokenId: number, toTokenId: number): Promise<void> {
  const fromTokenSelect = page.getByTestId('swap-from-token-select').first();
  const toTokenSelect = page.getByTestId('swap-to-token-select').first();
  await expect(fromTokenSelect).toBeVisible({ timeout: 20_000 });
  await expect(toTokenSelect).toBeVisible({ timeout: 20_000 });
  await fromTokenSelect.selectOption(String(fromTokenId));
  await toTokenSelect.selectOption(String(toTokenId));
}

async function selectOrderbookPairByLabel(page: Page, labelPattern: RegExp): Promise<string> {
  const pairSelect = page.getByTestId('swap-orderbook-pair-select').first();
  await expect(pairSelect, 'orderbook pair selector must be mounted').toHaveCount(1, { timeout: 10_000 });
  const options = await pairSelect.evaluate((node) =>
    Array.from((node as HTMLSelectElement).options).map((option) => ({
      value: option.value,
      label: option.textContent?.replace(/\s+/g, ' ').trim() || '',
    })),
  );
  const match = options.find((option) => labelPattern.test(option.label));
  expect(match, `orderbook pair selector missing ${labelPattern}: ${JSON.stringify(options)}`).toBeTruthy();
  await pairSelect.selectOption(match!.value);
  return match!.label;
}

async function readOrderbookRowCounts(page: Page): Promise<{ asks: number; bids: number }> {
  return {
    asks: await page.getByTestId('orderbook-ask-row').count(),
    bids: await page.getByTestId('orderbook-bid-row').count(),
  };
}

async function selectCrossRoute(page: Page, targetEntityId: string): Promise<void> {
  const swapPanel = page.locator('.swap-panel')
    .filter({ has: page.getByTestId('swap-order-amount') })
    .filter({ has: page.getByTestId('swap-route-flow') })
    .first();
  const routeSelect = swapPanel.getByTestId('swap-route-select').first();
  await expect(routeSelect).toBeVisible({ timeout: 20_000 });
  try {
    await expect.poll(
      async () => routeSelect.locator('option').evaluateAll((options, target) =>
        options.some((option) => String((option as HTMLOptionElement).value || '').toLowerCase().startsWith(`${String(target).toLowerCase()}:`)),
        targetEntityId,
      ),
      {
        timeout: 30_000,
        intervals: [250, 500, 1000],
        message: `cross route to ${targetEntityId.slice(0, 10)} must appear`,
      },
    ).toBe(true);
  } catch (error) {
    const debug = await page.evaluate(() => {
      const view = window as CrossRuntimeWindow;
      const env = view.isolatedEnv;
      const routeOptions = Array.from(document.querySelectorAll('[data-testid="swap-route-select"] option')).map((option) => ({
        value: (option as HTMLOptionElement).value,
        text: option.textContent,
        disabled: (option as HTMLOptionElement).disabled,
      }));
      const sourceOptions = Array.from(document.querySelectorAll('[data-testid="swap-from-chain-select"] option')).map((option) => ({
        value: (option as HTMLOptionElement).value,
        text: option.textContent,
      }));
      const profiles = env?.gossip?.getProfiles?.() || [];
      const hubProfiles = profiles
        .filter((profile: any) => profile?.metadata?.isHub === true)
        .map((profile: any) => ({
          entityId: String(profile?.entityId || '').slice(0, 10),
          name: String(profile?.name || ''),
          jurisdiction: String(profile?.metadata?.jurisdiction?.name || ''),
        }));
      const replicas = Array.from(env?.eReplicas?.entries?.() || []).map(([key, replica]: [string, any]) => ({
        key: String(key).slice(0, 22),
        entityId: String(replica?.entityId || replica?.state?.entityId || '').slice(0, 10),
        signerId: String(replica?.signerId || '').slice(0, 10),
        profileName: String(replica?.state?.profile?.name || ''),
        jurisdiction: String(replica?.state?.config?.jurisdiction?.name || replica?.position?.jurisdiction || ''),
        accounts: Array.from(replica?.state?.accounts?.keys?.() || []).map((id) => String(id).slice(0, 10)),
      }));
      return { routeOptions, sourceOptions, hubProfiles, replicas };
    });
    console.log('[E2E cross route debug]', JSON.stringify(debug, null, 2));
    throw error;
  }
  const value = await routeSelect.locator('option').evaluateAll((options, target) => {
    const found = options.find((option) =>
      String((option as HTMLOptionElement).value || '').toLowerCase().startsWith(`${String(target).toLowerCase()}:`),
    ) as HTMLOptionElement | undefined;
    return String(found?.value || '');
  }, targetEntityId);
  expect(value, 'cross route value must be present').toBeTruthy();
  await routeSelect.selectOption(value);
  await routeSelect.dispatchEvent('input');
  await routeSelect.dispatchEvent('change');
  await expect.poll(
    async () => routeSelect.evaluate((select) => ({
      value: String((select as HTMLSelectElement).value || ''),
      componentSelected: String((select as HTMLElement).dataset.selectedRouteValue || ''),
      committedSelected: String((select as HTMLElement).dataset.committedRouteValue || ''),
      commitNonce: String((select as HTMLElement).dataset.routeCommitNonce || ''),
      options: Array.from((select as HTMLSelectElement).options).map((option) => String(option.value || '')),
    })),
    {
      timeout: 10_000,
      intervals: [100, 250, 500],
      message: 'cross route select must retain the chosen route instead of falling back to same-chain',
    },
  ).toMatchObject({
    componentSelected: value,
    committedSelected: value,
    commitNonce: expect.stringMatching(/[1-9]/),
    options: expect.arrayContaining([value]),
  });
  const selectedOptionLabel = await routeSelect.evaluate((select) => {
    const element = select as HTMLSelectElement;
    return String(element.selectedOptions[0]?.textContent || '').replace(/\s+/g, ' ').trim();
  });
  expect(selectedOptionLabel, 'cross route option must name the target jurisdiction once').toMatch(/\((Testnet|Tron)\)/);
  await expect.poll(
    async () => routeSelect.evaluate((select) => {
      const panel = (select as HTMLElement).closest('.swap-panel');
      const routeFlow = panel?.querySelector('[data-testid="swap-route-flow"]') as HTMLElement | null;
      const routeButton = panel?.querySelector('[data-testid="swap-route-menu-button"]') as HTMLElement | null;
      const routeButtonText = String(routeButton?.textContent || '').replace(/\s+/g, ' ').trim();
      return {
        text: String(routeFlow?.textContent || ''),
        routeButtonText,
        visibleNetworkWordCount: (routeButtonText.match(/\b(?:Testnet|Tron)\b/g) || []).length,
        mode: String(routeFlow?.dataset.routeMode || ''),
        selected: String(routeFlow?.dataset.selectedRouteValue || ''),
        selectValue: String((select as HTMLSelectElement).value || ''),
        componentSelected: String((select as HTMLElement).dataset.selectedRouteValue || ''),
        committedSelected: String((select as HTMLElement).dataset.committedRouteValue || ''),
        commitNonce: String((select as HTMLElement).dataset.routeCommitNonce || ''),
        componentMode: String((select as HTMLElement).dataset.selectedRouteMode || ''),
        routeKnown: String((select as HTMLElement).dataset.selectedRouteKnown || ''),
        routeDisabled: String((select as HTMLElement).dataset.selectedRouteDisabled || ''),
        actionTicks: String((select as HTMLElement).dataset.routeActionTicks || ''),
        domSyncTicks: String((select as HTMLElement).dataset.routeDomSyncTicks || ''),
        domSyncValue: String((select as HTMLElement).dataset.routeDomSyncValue || ''),
        actionSyncValue: String((select as HTMLElement).dataset.routeSyncValue || ''),
        actionSyncKnown: String((select as HTMLElement).dataset.routeSyncKnown || ''),
        actionSyncDisabled: String((select as HTMLElement).dataset.routeSyncDisabled || ''),
        actionCommitted: String((select as HTMLElement).dataset.routeCommittedValue || ''),
      };
    }),
    {
      timeout: 10_000,
      intervals: [100, 250, 500],
      message: 'cross route selection must update the visible route flow in the same swap panel',
    },
  ).toMatchObject({
    mode: 'cross',
    selectValue: value,
    componentSelected: value,
    committedSelected: value,
    commitNonce: expect.stringMatching(/[1-9]/),
    componentMode: 'cross',
    routeDisabled: 'false',
    visibleNetworkWordCount: 1,
  });
}

async function expectCrossOrderbookReady(
  page: Page,
  options: { titlePattern?: RegExp; pairIdPattern?: RegExp } = {},
): Promise<void> {
  const orderbook = page.getByTestId('swap-orderbook').first();
  await expect(orderbook, 'cross route must keep the right-side orderbook visible').toBeVisible({ timeout: 20_000 });
  const panel = orderbook.locator('.orderbook-panel').first();
  await expect(panel, 'cross route must render an orderbook panel').toBeVisible({ timeout: 20_000 });
  await expect
    .poll(async () => String(await panel.getAttribute('data-pair-id') || ''), {
      timeout: 20_000,
      intervals: [100, 250, 500],
      message: 'cross route orderbook must subscribe to the cross venue id, not a numeric same-chain pair',
    })
    .toMatch(options.pairIdPattern ?? /^cross:/);
  await expect(
    page.locator('[data-testid="swap-market-section"] .book-toolbar strong').first(),
    'cross orderbook title must disambiguate token jurisdictions',
  ).toContainText(options.titlePattern ?? /\((Testnet|Tron)\)\s*-\s*.*\((Testnet|Tron)\)/, { timeout: 10_000 });
  const pairSelect = page.getByTestId('swap-orderbook-pair-select').first();
  await expect(pairSelect, 'cross orderbook pair selector must be present').toHaveCount(1, { timeout: 10_000 });
  await expect
    .poll(async () => pairSelect.evaluate((node) => {
      const select = node as HTMLSelectElement;
      return select.selectedOptions[0]?.textContent?.replace(/\s+/g, ' ').trim() || '';
    }), {
      timeout: 10_000,
      intervals: [100, 250, 500],
      message: 'cross orderbook selector must show Asset (Jurisdiction) - Asset (Jurisdiction)',
    })
    .toMatch(options.titlePattern ?? /\((Testnet|Tron)\)\s*-\s*.*\((Testnet|Tron)\)/);
  await expect
    .poll(async () => String(await panel.getAttribute('data-source-status') || ''), {
      timeout: 20_000,
      intervals: [250, 500, 1000],
      message: 'cross route orderbook must resolve to ready or an empty book instead of hanging in syncing',
    })
    .toMatch(/^(ready|empty)$/);
  const relayCheck = await page.evaluate(() => {
    const normalizeWs = (value: string): string => {
      const raw = String(value || '').trim();
      if (!raw) return '';
      const parsed = raw.startsWith('/') ? new URL(raw, window.location.origin) : new URL(raw);
      if (parsed.protocol === 'http:') parsed.protocol = 'ws:';
      if (parsed.protocol === 'https:') parsed.protocol = 'wss:';
      parsed.searchParams.set('protocol', 'market');
      return parsed.toString();
    };
    const panelEl = document.querySelector('[data-testid="swap-orderbook"] .orderbook-panel') as HTMLElement | null;
    const hubId = String(panelEl?.getAttribute('data-hub-ids') || '').split(',')[0]?.trim().toLowerCase() || '';
    const relayUrl = normalizeWs(String(panelEl?.getAttribute('data-relay-url') || ''));
    const env = (window as CrossRuntimeWindow).isolatedEnv as any;
    const rawProfiles = typeof env?.gossip?.getProfiles === 'function'
      ? env.gossip.getProfiles()
      : env?.gossip?.profiles;
    const profiles = rawProfiles instanceof Map
      ? Array.from(rawProfiles.values())
      : (Array.isArray(rawProfiles) ? rawProfiles : []);
    const profile = profiles.find((candidate: any) =>
      String(candidate?.entityId || '').trim().toLowerCase() === hubId
      && candidate?.metadata?.isHub === true
    ) as any;
    const expectedRelayUrl = normalizeWs(String((Array.isArray(profile?.relays) ? profile.relays : []).find(Boolean) || ''));
    return { hubId, relayUrl, expectedRelayUrl };
  });
  expect(relayCheck.hubId, 'cross orderbook must expose the selected book hub id').toMatch(/^0x[a-f0-9]{64}$/);
  const connectedRelay = new URL(relayCheck.relayUrl);
  expect(connectedRelay.pathname, 'cross orderbook must connect through the relay endpoint').toBe('/relay');
  expect(connectedRelay.searchParams.get('protocol'), 'cross orderbook must request the market relay protocol').toBe('market');
  if (relayCheck.expectedRelayUrl) {
    expect(relayCheck.relayUrl, 'cross orderbook relay must follow the selected book hub gossip relay').toBe(relayCheck.expectedRelayUrl);
  }
  await expect(orderbook.getByTestId('orderbook-source-status').first()).not.toContainText(/syncing/i, { timeout: 5_000 });
}

async function expectDirectCrossOrderbookReady(page: Page): Promise<void> {
  await expectCrossOrderbookReady(page);
}

async function expectSwapTokens(page: Page, fromTokenId: number, toTokenId: number): Promise<void> {
  const fromSymbol = TOKEN_SYMBOL_BY_ID[fromTokenId];
  const toSymbol = TOKEN_SYMBOL_BY_ID[toTokenId];
  expect(fromSymbol, `missing token symbol for ${fromTokenId}`).toBeTruthy();
  expect(toSymbol, `missing token symbol for ${toTokenId}`).toBeTruthy();
  await expect(page.getByTestId('swap-from-token-label').first()).toContainText(fromSymbol!, { timeout: 10_000 });
  await expect(page.getByTestId('swap-to-token-label').first()).toContainText(toSymbol!, { timeout: 10_000 });
}

async function expectSwapAssetRoute(
  page: Page,
  fromTokenId: number,
  sourceJurisdiction: string,
  toTokenId: number,
  targetJurisdiction: string,
): Promise<void> {
  await expectSwapTokens(page, fromTokenId, toTokenId);
  const routeFlow = page.getByTestId('swap-route-flow').first();
  await expect
    .poll(async () => ({
      mode: String(await routeFlow.getAttribute('data-route-mode') || ''),
      sourceJurisdiction: String(await routeFlow.getAttribute('data-source-jurisdiction') || ''),
      targetJurisdiction: String(await routeFlow.getAttribute('data-target-jurisdiction') || ''),
    }), {
      timeout: 10_000,
      intervals: [100, 250, 500],
      message: 'swap asset identity must include both token and jurisdiction',
    })
    .toMatchObject({
      mode: 'cross',
      sourceJurisdiction,
      targetJurisdiction,
    });
}

function visibleOrderbookRow(page: Page, side: 'ask' | 'bid') {
  return page
    .getByTestId('swap-orderbook')
    .first()
    .getByTestId(side === 'ask' ? 'orderbook-ask-row' : 'orderbook-bid-row')
    .first();
}

async function clickCrossOrderbookLevel(
  page: Page,
  side: 'ask' | 'bid',
  expectedFromTokenId: number,
  expectedToTokenId: number,
): Promise<void> {
  const row = visibleOrderbookRow(page, side);
  await expect(row, `cross ${side} row must be visible before clicking the orderbook`).toBeVisible({ timeout: 30_000 });
  const clickedDisplayedPrice = String(await row.locator('.price').textContent() || '').trim();
  // A fill completed while this wallet was configuring the next order can
  // legitimately surface its confirmation dialog now. A real user closes it
  // before interacting with the book; the E2E must do the same, never click
  // through the modal overlay.
  await dismissSwapCompletionModal(page);
  await row.click({ timeout: 10_000 });
  await expectSwapTokens(page, expectedFromTokenId, expectedToTokenId);
  await expect(page.getByTestId('swap-size-hint').first(), 'cross orderbook click must pin the clicked level in the visible form').toBeVisible({ timeout: 10_000 });
  await expect
    .poll(async () => String(await page.getByTestId('swap-order-amount').first().inputValue()).trim(), {
      timeout: 10_000,
      intervals: [50, 100, 200],
    })
    .not.toBe('');
  if (clickedDisplayedPrice) {
    await expect
      .poll(async () => String(await page.getByTestId('swap-order-price').first().inputValue()).trim(), {
        timeout: 10_000,
        intervals: [50, 100, 200],
      })
      .toBe(clickedDisplayedPrice.replace(/,/g, '').trim());
  }
}

async function expectCrossNonTakeableClickNoop(
  page: Page,
  side: 'ask' | 'bid',
  expectedFromTokenId: number,
  expectedToTokenId: number,
): Promise<void> {
  const panel = page.getByTestId('swap-orderbook').locator('.orderbook-panel').first();
  const row = visibleOrderbookRow(page, side);
  await expect(row, `cross ${side} row must be visible to prove wrong-side click behavior`).toBeVisible({ timeout: 20_000 });
  const before = {
    pairId: String(await panel.getAttribute('data-pair-id') || ''),
    hubIds: String(await panel.getAttribute('data-hub-ids') || ''),
    amount: String(await page.getByTestId('swap-order-amount').first().inputValue()).trim(),
    price: String(await page.getByTestId('swap-order-price').first().inputValue()).trim(),
    sizeHintCount: await page.getByTestId('swap-size-hint').count(),
  };
  expect(before.pairId, 'cross wrong-side click guard needs an active cross venue').toMatch(/^cross:/);

  await row.click({ timeout: 10_000 });
  await expectSwapTokens(page, expectedFromTokenId, expectedToTokenId);
  await expect
    .poll(async () => String(await panel.getAttribute('data-pair-id') || ''), {
      timeout: 5_000,
      intervals: [50, 100, 200],
      message: 'cross wrong-side click must not switch the visible venue',
    })
    .toBe(before.pairId);
  await expect
    .poll(async () => String(await panel.getAttribute('data-hub-ids') || ''), {
      timeout: 5_000,
      intervals: [50, 100, 200],
      message: 'cross wrong-side click must not switch the visible book hub',
    })
    .toBe(before.hubIds);
  await expect
    .poll(async () => String(await page.getByTestId('swap-order-amount').first().inputValue()).trim(), {
      timeout: 5_000,
      intervals: [50, 100, 200],
      message: 'cross wrong-side click must not pin an amount from a non-takeable level',
    })
    .toBe(before.amount);
  await expect
    .poll(async () => String(await page.getByTestId('swap-order-price').first().inputValue()).trim(), {
      timeout: 5_000,
      intervals: [50, 100, 200],
      message: 'cross wrong-side click must not pin a stale price from another route',
    })
    .toBe(before.price);
  await expect
    .poll(async () => await page.getByTestId('swap-size-hint').count(), {
      timeout: 5_000,
      intervals: [50, 100, 200],
      message: 'cross wrong-side click must not show a fill hint',
    })
    .toBe(before.sizeHintCount);
}

async function placeCrossOrder(
  page: Page,
  params: {
    source: RuntimeIdentity;
    hubId: string;
    targetEntityId: string;
    side: 'buy' | 'sell';
    amount?: string;
    price?: string;
    fromTokenId?: number;
    toTokenId?: number;
    clickBookSide?: 'ask' | 'bid';
    expectedClickFromTokenId?: number;
    expectedClickToTokenId?: number;
    checkMultihopDeferred?: boolean;
    expectSetupConsent?: boolean;
    expectedBookDepth?: number;
    expectedAutoAmount?: number;
    screenshotPath?: string;
  },
): Promise<string> {
  const flowStartedAt = Date.now();
  const emitPhaseTiming = (phase: string, startedAt: number): void => {
    console.log(`[E2E-TIMING] cross_j_order.${phase} ${Date.now() - startedAt}ms`);
  };
  await openSwapWorkspace(page);
  await dismissSwapCompletionModal(page);
  await selectSourceChainInSwap(page, params.source.entityId);
  await selectCounterpartyInSwap(page, params.hubId);
  if (params.fromTokenId && params.toTokenId && params.fromTokenId === params.toTokenId) {
    await selectCrossRoute(page, params.targetEntityId);
    await configureTokens(page, params.fromTokenId, params.toTokenId);
  } else {
    await configurePair(page, params.side);
    await selectCrossRoute(page, params.targetEntityId);
  }
  await expectCrossOrderbookReady(page);
  if (params.expectedBookDepth) {
    const orderbook = page.getByTestId('swap-orderbook').first();
    await expect(orderbook.getByTestId('orderbook-ask-row')).toHaveCount(params.expectedBookDepth, { timeout: 30_000 });
    await expect(orderbook.getByTestId('orderbook-bid-row')).toHaveCount(params.expectedBookDepth, { timeout: 30_000 });
    const displayedSizes = await orderbook.locator('.size').allTextContents();
    expect(displayedSizes, 'stable cross MM depth should be visibly sized in thousands of tokens')
      .toEqual(expect.arrayContaining([expect.stringMatching(/K$/)]));
    expect(displayedSizes, 'cross MM sizes must never expose raw million-lot counts')
      .not.toEqual(expect.arrayContaining([expect.stringMatching(/M$/)]));
  }
  await dismissSwapCompletionModal(page);
  if (params.checkMultihopDeferred) {
    await expectDirectCrossOrderbookReady(page);
    await expectCrossOrderbookReady(page);
  }
  if (params.expectedAutoAmount !== undefined) {
    await expect
      .poll(async () => Number(String(await page.getByTestId('swap-order-amount').first().inputValue()).replace(/,/g, '')), {
        timeout: 10_000,
        intervals: [50, 100, 200],
        message: 'opening the swap form must default to 100% canonical source capacity',
      })
      .toBeCloseTo(params.expectedAutoAmount, 6);
  }
  if (params.clickBookSide) {
    const expectedFromTokenId = params.expectedClickFromTokenId ?? (params.clickBookSide === 'ask' ? USDC : WETH);
    const expectedToTokenId = params.expectedClickToTokenId ?? (params.clickBookSide === 'ask' ? WETH : USDC);
    await clickCrossOrderbookLevel(
      page,
      params.clickBookSide,
      expectedFromTokenId,
      expectedToTokenId,
    );
  }
  const amountInput = page.getByTestId('swap-order-amount').first();
  const priceInput = page.getByTestId('swap-order-price').first();
  const submit = page.getByTestId('swap-submit-order').first();
  await expect(amountInput).toBeVisible({ timeout: 20_000 });
  await expect(priceInput).toBeVisible({ timeout: 20_000 });
  const beforeSubmit = await readCrossState(page, params.source, params.hubId);
  const beforeHeight = beforeSubmit.currentHeight;
  const beforeRouteIds = new Set(beforeSubmit.routeSummaries.map(route => route.orderId));
  const beforeOfferIds = new Set(beforeSubmit.offerSummaries.map(offer => offer.offerId));
  const beforeMessageCount = beforeSubmit.messages.length;
  if (params.amount !== undefined) {
    await amountInput.fill(params.amount);
  } else {
    const autoAmount = Number(String(await amountInput.inputValue()).replace(/,/g, ''));
    expect(autoAmount, 'book click must populate a positive source amount').toBeGreaterThan(0);
    if (params.expectedAutoAmount !== undefined) {
      expect(autoAmount, 'book click must size from the full canonical source capacity').toBeCloseTo(params.expectedAutoAmount, 6);
    }
  }
  if (params.screenshotPath) {
    await page.screenshot({ path: params.screenshotPath, fullPage: true });
  }
  if (params.price !== undefined) await priceInput.fill(params.price);
  if (params.expectSetupConsent) {
    const consent = page.getByTestId('swap-setup-consent').first();
    await expect(consent, 'one-click cross swap must disclose automatic target setup').toBeVisible({ timeout: 10_000 });
    await expect(consent.getByTestId('swap-setup-step'), 'target setup disclosure must include account + credit steps').toHaveCount(2, { timeout: 10_000 });
    await expect(consent.locator('[data-step-id="target-account"]'), 'target account setup step must be visible').toContainText('Create target account');
    await expect(consent.locator('[data-step-id="target-credit"]'), 'target credit setup step must be visible').toContainText('Set inbound credit limit');
    const errorText = (await page.getByTestId('swap-form-error').allTextContents()).join('\n');
    expect(errorText, 'auto-setup must replace the old manual create-account blocker')
      .not.toMatch(/create target account|account setup required/i);
  }
  await expect.poll(async () => {
    const routePicker = page.getByTestId('swap-route-picker').first();
    const [receive, formErrorParts, amountState, parsedGiveAmount, canonicalGiveAmount] = await Promise.all([
      page.getByTestId('swap-receive-amount').first().inputValue(),
      page.getByTestId('swap-form-error').allTextContents(),
      routePicker.getAttribute('data-order-amount-state'),
      routePicker.getAttribute('data-give-amount'),
      routePicker.getAttribute('data-canonical-give-amount'),
    ]);
    const diagnostics = {
      receive,
      formError: formErrorParts.join('\n').trim(),
      amountState,
      parsedGiveAmount,
      canonicalGiveAmount,
      price: await priceInput.inputValue(),
      giveToken: await routePicker.getAttribute('data-give-token'),
      wantToken: await routePicker.getAttribute('data-want-token'),
      giveDecimals: await routePicker.getAttribute('data-give-decimals'),
    };
    const ready = (
      Number(String(receive || '0').replace(/,/g, '')) > 0
      && diagnostics.formError === ''
      && parsedGiveAmount !== null
      && parsedGiveAmount !== '0'
      && canonicalGiveAmount !== null
      && canonicalGiveAmount !== '0'
    );
    return {
      ready,
      diagnostics: ready ? '' : JSON.stringify(diagnostics),
    };
  }, {
    timeout: 10_000,
    intervals: [50, 100, 250],
    message: 'cross-j manual amount must reach the canonical form state before submit',
  }).toEqual({ ready: true, diagnostics: '' });
  await expect(submit).toBeEnabled({ timeout: 30_000 });
  emitPhaseTiming('pre_submit', flowStartedAt);
  const clickStartedAt = Date.now();
  await page.evaluate(() => {
    (window as CrossRuntimeWindow & { __crossJClickAt?: number }).__crossJClickAt = Date.now();
  });
  await submit.click();
  emitPhaseTiming('click_dispatch', clickStartedAt);
  let lastSubmitState: unknown = null;
  let createdOrderId = '';
  try {
    await expect.poll(
      async () => {
        const state = await readCrossState(page, params.source, params.hubId);
        const newRoutes = state.routeSummaries.filter(route => !beforeRouteIds.has(route.orderId));
        const newOffers = state.offerSummaries.filter(offer => !beforeOfferIds.has(offer.offerId));
        const newMessages = state.messages.slice(beforeMessageCount);
        const formError = await page.getByTestId('swap-form-error').first().textContent().catch(() => '');
        const formValues = await page.evaluate(() => {
          const amount = document.querySelector<HTMLInputElement>('[data-testid="swap-order-amount"]')?.value || '';
          const price = document.querySelector<HTMLInputElement>('[data-testid="swap-order-price"]')?.value || '';
          const view = window as CrossRuntimeWindow & { __xln_env?: any };
          const summarizeEnv = (env: any) => ({
            runtimeId: String(env?.runtimeId || ''),
            height: Number(env?.height || 0),
            timestamp: Number(env?.timestamp || 0),
            scenarioMode: Boolean(env?.scenarioMode),
            loopActive: Boolean(env?.runtimeState?.loopActive),
            wakeRequested: Boolean(env?.runtimeState?.wakeRequested),
            processing: Boolean(env?.runtimeState?.processingPromise),
            lastProcessEnteredAt: Number(env?.lastProcessEnteredAt || 0),
            lastFrameAt: Number(env?.runtimeState?.lastFrameAt || 0),
            minFrameDelayMs: Number(env?.runtimeConfig?.minFrameDelayMs || 0),
            queuedAt: Number(env?.runtimeMempool?.queuedAt || 0),
            runtimeInputTypes: Array.from(env?.runtimeInput?.entityInputs || []).map((input: any) => ({
              entityId: String(input?.entityId || '').slice(-8),
              txTypes: Array.from(input?.entityTxs || []).map((tx: any) => String(tx?.type || '')),
            })),
            mempoolTypes: Array.from(env?.runtimeMempool?.entityInputs || []).map((input: any) => ({
              entityId: String(input?.entityId || '').slice(-8),
              txTypes: Array.from(input?.entityTxs || []).map((tx: any) => String(tx?.type || '')),
            })),
          });
          return {
            amount,
            price,
            isolated: summarizeEnv(view.isolatedEnv),
            live: summarizeEnv(view.__xln_env),
          };
        });
        lastSubmitState = {
          ok: newRoutes.length > 0 || newOffers.length > 0,
          routes: state.routes,
          offers: state.offers,
          newRoutes: newRoutes.map(route => ({ orderId: route.orderId, status: route.status })),
          newOffers: newOffers.map(offer => ({ offerId: offer.offerId, status: offer.status })),
          formError: String(formError || '').trim(),
          formValues,
          recentMessages: state.messages.slice(-8),
        };
        createdOrderId = newRoutes[0]?.orderId || newOffers[0]?.offerId || '';
        return lastSubmitState;
      },
      {
        message: 'cross-j order submit must create a route or a cross-j offer in live runtime',
        timeout: 30_000,
        intervals: [500, 1_000, 2_000],
      },
    ).toMatchObject({ ok: true });
  } catch (error) {
    throw new Error(`${error instanceof Error ? error.message : String(error)}\nlastSubmitState=${JSON.stringify(lastSubmitState, null, 2)}`);
  }
  expect(createdOrderId, 'cross-j order submit must return exact created orderId').toBeTruthy();
  emitPhaseTiming('click_to_route', clickStartedAt);
  const browserMeasures = await page.evaluate(() =>
    performance.getEntriesByType('measure')
      .filter(entry => entry.name.startsWith('xln.cross_j.'))
      .slice(-8)
      .map(entry => ({ name: entry.name, duration: Math.round(entry.duration) })));
  for (const measure of browserMeasures) {
    console.log(`[E2E-TIMING] ${measure.name} ${measure.duration}ms`);
  }
  let lastCommitState: unknown = null;
  try {
    await expect.poll(
      async () => {
        await flushRuntime(page, 1);
        const state = await readCrossState(page, params.source, params.hubId);
        lastCommitState = {
          currentHeight: state.currentHeight,
          beforeHeight,
          hasPendingFrame: state.hasPendingFrame,
          pendingTxs: state.pendingTxs,
          mempoolTxs: state.mempoolTxs,
          offers: state.offers,
          route: state.routeSummaries.find((route) => route.orderId === createdOrderId) || null,
          pendingOutputs: state.pendingOutputs,
          pendingNetworkOutputs: state.pendingNetworkOutputs,
          runtimeMempoolInputs: state.runtimeMempoolInputs,
          p2pState: state.p2pState,
          recoveryBarrier: state.recoveryBarrier,
          messages: state.messages.slice(-10),
        };
        const route = state.routeSummaries.find((candidate) => candidate.orderId === createdOrderId);
        // The User Runtime commits both Account legs atomically after matching
        // the Hub-signed proposal pair. The human-readable terminal message is
        // emitted later by the Hub when both ACKs commit, so waiting for the old
        // source-only message here adds a protocol round trip that no longer
        // exists. The paired pull bindings and canonical route status are the
        // state-level proof of User-side admission.
        const accountPairCommittedOrAdvanced =
          Boolean(route?.sourcePull && route?.targetPull) &&
          CROSS_J_SOURCE_COMMITTED_OR_ADVANCED_STATUSES.has(String(route?.status || ''));
        const sourceQueuesDrained =
          !state.hasPendingFrame &&
          state.pendingTxs.length === 0 &&
          state.mempoolTxs.length === 0 &&
          state.runtimeMempoolInputs.length === 0;
        return {
          committed: state.currentHeight > beforeHeight && accountPairCommittedOrAdvanced && sourceQueuesDrained,
          currentHeight: state.currentHeight,
          hasPendingFrame: state.hasPendingFrame,
          routeStatus: route?.status || '',
          sourcePull: Boolean(route?.sourcePull),
          targetPull: Boolean(route?.targetPull),
        };
      },
      {
        message: `cross-j order ${createdOrderId} must reach source-committed state before matching or advance through a valid fill path`,
        timeout: 75_000,
        intervals: [250, 500, 1000],
      },
    ).toMatchObject({ committed: true });
  } catch (error) {
    throw new Error(`${error instanceof Error ? error.message : String(error)}\nlastCommitState=${JSON.stringify(lastCommitState, null, 2)}`);
  }
  emitPhaseTiming('click_to_source_commit', clickStartedAt);
  return createdOrderId;
}

async function readCrossState(
  page: Page,
  identity: RuntimeIdentity,
  hubId: string,
): Promise<{
  offers: number;
  routes: number;
  pulls: number;
  currentHeight: number;
  hasPendingFrame: boolean;
  pendingTxs: string[];
  mempoolTxs: string[];
  settledRoutes: number;
  claimedRoutes: number;
  replicaFound: boolean;
  accountFound: boolean;
  accountKeys: string[];
  messages: string[];
  routeSummaries: Array<{
    orderId: string;
    status: string;
    fillSeq: number;
    cumulativeFillRatio: number;
    filledSourceAmount: string;
    filledTargetAmount: string;
    sourcePull: boolean;
    targetPull: boolean;
    sourcePullId: string;
    targetPullId: string;
    bookOwnerEntityId: string;
    sourceEntityId: string;
    sourceCounterpartyEntityId: string;
    targetEntityId: string;
    targetCounterpartyEntityId: string;
    venueId: string;
    priceTicks: string;
    pendingClearRequestedAt: number;
    updatedAt: number;
  }>;
  offerSummaries: Array<{
    offerId: string;
    status: string;
    amount: string;
    cross: boolean;
  }>;
  pullIds: string[];
  pendingOutputs: Array<{ entityId: string; signerId: string; txTypes: string[]; frame: boolean; precommits: number }>;
  pendingNetworkOutputs: Array<{ entityId: string; signerId: string; runtimeId: string; txTypes: string[]; frame: boolean; precommits: number }>;
  runtimeMempoolInputs: Array<{ entityId: string; signerId: string; txTypes: string[]; frame: boolean; precommits: number }>;
  p2pState: { exists: boolean; connected: boolean; queue: unknown; directPeers: unknown };
  recoveryBarrier: boolean;
}> {
  return await page.evaluate(({ identity, hubId }) => {
    const env = (window as CrossRuntimeWindow).isolatedEnv;
    const entityNeedle = String(identity.entityId || '').toLowerCase();
    const signerNeedle = String(identity.signerId || '').toLowerCase();
    const hubNeedle = String(hubId || '').toLowerCase();
    let replica = env?.eReplicas?.get(`${entityNeedle}:${signerNeedle}`);
    if (!replica && env?.eReplicas instanceof Map) {
      for (const [key, candidate] of env.eReplicas.entries()) {
        const keyText = String(key || '').toLowerCase();
        const candidateEntity = String(candidate?.state?.entityId || candidate?.entityId || '').toLowerCase();
        const candidateSigner = String(candidate?.signerId || '').toLowerCase();
        if (
          candidateEntity === entityNeedle ||
          keyText.startsWith(`${entityNeedle}:`) ||
          (keyText.includes(entityNeedle) && (!signerNeedle || keyText.includes(signerNeedle) || candidateSigner === signerNeedle))
        ) {
          replica = candidate;
          break;
        }
      }
    }
    const state = replica?.state;
    let account = state?.accounts?.get(hubId) || state?.accounts?.get(hubNeedle);
    if (!account && state?.accounts instanceof Map) {
      for (const [key, candidate] of state.accounts.entries()) {
        const keyText = String(key || '').toLowerCase();
        const left = String(candidate?.leftEntity || '').toLowerCase();
        const right = String(candidate?.rightEntity || '').toLowerCase();
        const cp = String(candidate?.counterpartyEntityId || '').toLowerCase();
        if (keyText === hubNeedle || cp === hubNeedle || left === hubNeedle || right === hubNeedle) {
          account = candidate;
          break;
        }
      }
    }
    let offers = 0;
    for (const offer of account?.swapOffers?.values?.() || []) {
      if (offer?.crossJurisdiction) offers += 1;
    }
    let settledRoutes = 0;
    let claimedRoutes = 0;
    const routeSummaries = [];
    for (const route of state?.crossJurisdictionSwaps?.values?.() || []) {
      const status = String(route?.status || '');
      if (status === 'settled') settledRoutes += 1;
      if (status === 'source_claimed' || status === 'target_claimed' || status === 'settled') claimedRoutes += 1;
      routeSummaries.push({
        orderId: String(route?.orderId || ''),
        status,
        fillSeq: Number(route?.fillSeq || 0),
        cumulativeFillRatio: Number(route?.cumulativeFillRatio || route?.claimedRatio || 0),
        filledSourceAmount: String(route?.filledSourceAmount ?? route?.sourceClaimed ?? '0'),
        filledTargetAmount: String(route?.filledTargetAmount ?? route?.targetClaimed ?? '0'),
        sourcePull: Boolean(route?.sourcePull),
        targetPull: Boolean(route?.targetPull),
        sourcePullId: String(route?.sourcePull?.pullId || ''),
        targetPullId: String(route?.targetPull?.pullId || ''),
        bookOwnerEntityId: String(route?.bookOwnerEntityId || route?.source?.counterpartyEntityId || ''),
        sourceEntityId: String(route?.source?.entityId || ''),
        sourceCounterpartyEntityId: String(route?.source?.counterpartyEntityId || ''),
        targetEntityId: String(route?.target?.entityId || ''),
        targetCounterpartyEntityId: String(route?.target?.counterpartyEntityId || ''),
        venueId: String(route?.venueId || ''),
        priceTicks: String(route?.priceTicks ?? '0'),
        pendingClearRequestedAt: Number(route?.pendingClearRequestedAt || 0),
        updatedAt: Number(route?.updatedAt || route?.createdAt || 0),
      });
    }
    return {
      offers,
      routes: Number(state?.crossJurisdictionSwaps?.size || 0),
      pulls: Number(account?.pulls?.size || 0),
      currentHeight: Number(account?.currentHeight || 0),
      hasPendingFrame: Boolean(account?.pendingFrame),
      pendingTxs: Array.from(account?.pendingFrame?.accountTxs || []).map((tx: any) => String(tx?.type || '')),
      mempoolTxs: Array.from(account?.mempool || []).map((tx: any) => String(tx?.type || '')),
      settledRoutes,
      claimedRoutes,
      replicaFound: Boolean(replica),
      accountFound: Boolean(account),
      accountKeys: Array.from(state?.accounts?.keys?.() || []).map((key: unknown) => String(key)),
      messages: Array.from(state?.messages || []).map((message: unknown) => String(message)),
      routeSummaries,
      offerSummaries: Array.from(account?.swapOffers?.entries?.() || []).map(([offerId, offer]: [string, any]) => ({
        offerId: String(offerId),
        status: String(offer?.crossJurisdiction?.status || ''),
        amount: String(offer?.amount ?? '0'),
        cross: Boolean(offer?.crossJurisdiction),
      })),
      pullIds: Array.from(account?.pulls?.keys?.() || []).map((pullId: unknown) => String(pullId)),
      pendingOutputs: Array.from(env?.pendingOutputs || []).map((input: any) => ({
        entityId: String(input?.entityId || ''),
        signerId: String(input?.signerId || ''),
        txTypes: Array.from(input?.entityTxs || []).map((tx: any) => String(tx?.type || '')),
        frame: Boolean(input?.proposedFrame),
        precommits: Number(input?.hashPrecommits?.size || 0),
      })),
      pendingNetworkOutputs: Array.from(env?.pendingNetworkOutputs || []).map((input: any) => ({
        entityId: String(input?.entityId || ''),
        signerId: String(input?.signerId || ''),
        runtimeId: String(input?.runtimeId || ''),
        txTypes: Array.from(input?.entityTxs || []).map((tx: any) => String(tx?.type || '')),
        frame: Boolean(input?.proposedFrame),
        precommits: Number(input?.hashPrecommits?.size || 0),
      })),
      runtimeMempoolInputs: Array.from(env?.runtimeMempool?.entityInputs || env?.runtimeInput?.entityInputs || []).map((input: any) => ({
        entityId: String(input?.entityId || ''),
        signerId: String(input?.signerId || ''),
        txTypes: Array.from(input?.entityTxs || []).map((tx: any) => String(tx?.type || '')),
        frame: Boolean(input?.proposedFrame),
        precommits: Number(input?.hashPrecommits?.size || 0),
      })),
      p2pState: {
        exists: Boolean(env?.runtimeState?.p2p),
        connected: Boolean(env?.runtimeState?.p2p?.isConnected?.()),
        queue: env?.runtimeState?.p2p?.getQueueState?.() || null,
        directPeers: env?.runtimeState?.p2p?.getDirectPeerState?.() || null,
      },
      recoveryBarrier: Boolean(env?.runtimeState?.recoveryBackupBarrier),
    };
  }, { identity, hubId });
}

async function waitForCrossPullFlow(
  page: Page,
  source: RuntimeIdentity,
  target: RuntimeIdentity,
  sourceHubId: string,
  targetHubId: string,
  options: { sourceRouteId?: string; targetRouteId?: string } = {},
): Promise<void> {
  try {
    await expect.poll(
      async () => {
        const sourceState = await readCrossState(page, source, sourceHubId);
        const targetState = await readCrossState(page, target, targetHubId);
        const sourceRoute = options.sourceRouteId
          ? sourceState.routeSummaries.find((route) => route.orderId === options.sourceRouteId)
          : sourceState.routeSummaries.find((route) =>
              route.sourcePull || route.targetPull || ['source_claimed', 'target_claimed', 'settled'].includes(route.status),
            );
        const targetRoute = options.targetRouteId
          ? targetState.routeSummaries.find((route) => route.orderId === options.targetRouteId)
          : targetState.routeSummaries.find((route) =>
              route.sourcePull || route.targetPull || ['source_claimed', 'target_claimed', 'settled'].includes(route.status),
            );
        const routeHasProgress = (route: typeof sourceRoute): boolean =>
          Boolean(route) &&
          (
            route.cumulativeFillRatio > 0 ||
            ['source_claimed', 'target_claimed', 'settled'].includes(route.status)
          );
        const targetHasDurablePreparedPull = Boolean(
          targetRoute?.targetPullId &&
          targetState.pullIds.includes(targetRoute.targetPullId) &&
          ['target_prepared', 'source_committed', 'target_locked', 'resting', 'partially_filled', 'clear_requested', 'clearing']
            .includes(targetRoute.status),
        );
        const sourceHasCommittedFill = routeHasProgress(sourceRoute);
        const targetHasClaimedFill = routeHasProgress(targetRoute);
        const targetHasPreparedOrClaimedPull = targetHasDurablePreparedPull || targetHasClaimedFill;
        return {
          ok: sourceHasCommittedFill && targetHasPreparedOrClaimedPull,
          sourceHasCommittedFill,
          targetHasDurablePreparedPull,
          targetHasClaimedFill,
          targetHasPreparedOrClaimedPull,
          sourceRouteStatus: sourceRoute?.status || '',
          targetRouteStatus: targetRoute?.status || '',
          sourceRouteId: sourceRoute?.orderId || '',
          targetRouteId: targetRoute?.orderId || '',
          sourceRoutes: sourceState.routes,
          targetRoutes: targetState.routes,
          sourcePulls: sourceState.pulls,
          targetPulls: targetState.pulls,
          sourceClaimed: sourceState.claimedRoutes,
          targetClaimed: targetState.claimedRoutes,
          sourceReplicaFound: sourceState.replicaFound,
          sourceAccountFound: sourceState.accountFound,
          targetReplicaFound: targetState.replicaFound,
          targetAccountFound: targetState.accountFound,
          sourceAccountKeys: sourceState.accountKeys,
          targetAccountKeys: targetState.accountKeys,
        };
      },
      {
        timeout: 60_000,
        intervals: [250, 500, 1000],
        message: 'cross-j match must materialize prepared pull routes or settled pull claims',
      },
    ).toMatchObject({
      ok: true,
      sourceHasCommittedFill: true,
      targetHasPreparedOrClaimedPull: true,
    });
  } catch (error) {
    const [sourceState, targetState] = await Promise.all([
      readCrossState(page, source, sourceHubId),
      readCrossState(page, target, targetHubId),
    ]);
    const replicas = await page.evaluate(() => {
      const env = (window as CrossRuntimeWindow).isolatedEnv;
      return Array.from(env?.eReplicas?.entries?.() || []).map(([key, replica]: [string, any]) => {
        const state = replica?.state;
        return {
          key: String(key || ''),
          entityId: String(state?.entityId || replica?.entityId || ''),
          signerId: String(replica?.signerId || ''),
          profileName: String(state?.profile?.name || ''),
          jurisdiction: String(state?.config?.jurisdiction?.name || ''),
          accounts: Array.from(state?.accounts?.entries?.() || []).map(([accountId, account]: [string, any]) => ({
            accountId: String(accountId || ''),
            currentHeight: Number(account?.currentHeight || 0),
            mempool: Array.from(account?.mempool || []).map((tx: any) => String(tx?.type || '')),
            pendingFrame: Array.from(account?.pendingFrame?.accountTxs || []).map((tx: any) => String(tx?.type || '')),
            offers: Array.from(account?.swapOffers?.entries?.() || []).map(([offerId, offer]: [string, any]) => ({
              offerId: String(offerId || ''),
              cross: Boolean(offer?.crossJurisdiction),
              status: String(offer?.crossJurisdiction?.status || ''),
            })),
            pulls: Array.from(account?.pulls?.keys?.() || []).map(String),
          })),
          routes: Array.from(state?.crossJurisdictionSwaps?.entries?.() || []).map(([orderId, route]: [string, any]) => ({
            orderId: String(orderId || ''),
            status: String(route?.status || ''),
            source: String(route?.source?.entityId || ''),
            sourceHub: String(route?.source?.counterpartyEntityId || ''),
            targetHub: String(route?.target?.entityId || ''),
            target: String(route?.target?.counterpartyEntityId || ''),
          })),
          messages: Array.from(state?.messages || []).slice(-20).map(String),
        };
      });
    });
    console.log('[E2E cross pull flow debug]', JSON.stringify({
      source: {
        entityId: source.entityId,
        hubId: sourceHubId,
        routes: sourceState.routeSummaries,
        offers: sourceState.offerSummaries,
        pulls: sourceState.pullIds,
        accountKeys: sourceState.accountKeys,
        messages: sourceState.messages.slice(-20),
      },
      target: {
        entityId: target.entityId,
        hubId: targetHubId,
        routes: targetState.routeSummaries,
        offers: targetState.offerSummaries,
        pulls: targetState.pullIds,
        accountKeys: targetState.accountKeys,
        messages: targetState.messages.slice(-20),
      },
      replicas,
    }, null, 2));
    throw error;
  }
}

async function readCrossResolveSnapshots(
  page: Page,
  entityId: string,
  counterpartyId: string,
): Promise<CrossResolveSnapshot[]> {
  return await page.evaluate(({ entityId, counterpartyId }) => {
    const env = (window as CrossRuntimeWindow).isolatedEnv;
    const recordOf = (value: unknown): Record<string, unknown> =>
      value && typeof value === 'object' ? value as Record<string, unknown> : {};
    const owner = String(entityId || '').toLowerCase();
    const cp = String(counterpartyId || '').toLowerCase();
    const out: CrossResolveSnapshot[] = [];
    const seen = new Set<string>();

    const accountMatches = (accountKey: string, rawAccount: unknown): boolean => {
      const account = recordOf(rawAccount);
      const left = typeof account.leftEntity === 'string' ? account.leftEntity.toLowerCase() : '';
      const right = typeof account.rightEntity === 'string' ? account.rightEntity.toLowerCase() : '';
      const canonicalCp = typeof account.counterpartyEntityId === 'string' ? account.counterpartyEntityId.toLowerCase() : '';
      return accountKey.toLowerCase() === cp ||
        canonicalCp === cp ||
        Boolean(left && right && ((left === owner && right === cp) || (right === owner && left === cp)));
    };
    const collectResolveSnapshots = (history: unknown, replicaKey: string, accountKey: string) => {
      if (!(history instanceof Map)) return;
      for (const [offerId, rawLifecycle] of history.entries()) {
        const resolves = recordOf(rawLifecycle).resolves;
        if (!Array.isArray(resolves)) continue;
        for (const rawResolve of resolves) {
          const resolve = recordOf(rawResolve);
          const snapshotOfferId = String(offerId || '');
          const height = Number(resolve.height ?? recordOf(rawLifecycle).lastUpdatedHeight ?? 0);
          const fillRatio = Number(resolve.fillRatio || 0);
          const key = [
            String(replicaKey || ''),
            String(accountKey || ''),
            snapshotOfferId,
            String(height),
            String(fillRatio),
            String(resolve.fillNumerator ?? '0'),
            String(resolve.fillDenominator ?? '0'),
            String(resolve.executionGiveAmount ?? '0'),
            String(resolve.executionWantAmount ?? '0'),
          ].join(':');
          if (seen.has(key)) continue;
          seen.add(key);
          out.push({
            offerId: snapshotOfferId,
            height,
            fillRatio: Number(resolve.fillRatio || 0),
            fillNumerator: String(resolve.fillNumerator ?? '0'),
            fillDenominator: String(resolve.fillDenominator ?? '0'),
            cancelRemainder: Boolean(resolve.cancelRemainder),
            executionGiveAmount: String(resolve.executionGiveAmount ?? '0'),
            executionWantAmount: String(resolve.executionWantAmount ?? '0'),
            comment: String(resolve.comment || ''),
          });
        }
      }
    };

    for (const [replicaKey, replica] of env?.eReplicas?.entries?.() || []) {
      if (!String(replicaKey).toLowerCase().startsWith(`${owner}:`)) continue;
      const state = recordOf(recordOf(replica).state);
      const accounts = state.accounts;
      if (!(accounts instanceof Map)) continue;
      for (const [accountKey, rawAccount] of accounts.entries()) {
        if (!accountMatches(String(accountKey || ''), rawAccount)) continue;
        // Multiple replicas can expose the same bilateral account while one is
        // one frame behind. Do not stop at the first match: the assertion needs
        // the latest committed account snapshot, not whichever Map entry appears
        // first in the browser runtime.
        collectResolveSnapshots(recordOf(rawAccount).swapOrderHistory, String(replicaKey || ''), String(accountKey || ''));
        collectResolveSnapshots(recordOf(rawAccount).swapClosedOrders, String(replicaKey || ''), String(accountKey || ''));
      }
    }
    return out.sort((a, b) =>
      a.height - b.height ||
      a.offerId.localeCompare(b.offerId) ||
      a.executionGiveAmount.localeCompare(b.executionGiveAmount) ||
      a.executionWantAmount.localeCompare(b.executionWantAmount)
    );
  }, { entityId, counterpartyId });
}

async function waitForLatestCrossResolveSnapshot(
  page: Page,
  entityId: string,
  counterpartyId: string,
  minimumCount: number,
): Promise<CrossResolveSnapshot> {
  try {
    await expect
      .poll(async () => (await readCrossResolveSnapshots(page, entityId, counterpartyId)).length, {
        timeout: 45_000,
        intervals: [250, 500, 1000],
        message: `cross resolve snapshots must reach ${minimumCount}`,
      })
      .toBeGreaterThanOrEqual(minimumCount);
  } catch (error) {
    const debug = await page.evaluate(({ entityId, counterpartyId }) => {
      const env = (window as CrossRuntimeWindow).isolatedEnv;
      const owner = String(entityId || '').toLowerCase();
      const cp = String(counterpartyId || '').toLowerCase();
      const out: any[] = [];
      for (const [replicaKey, replica] of env?.eReplicas?.entries?.() || []) {
        if (!String(replicaKey).toLowerCase().startsWith(`${owner}:`)) continue;
        const state = replica?.state;
        out.push({
          replicaKey: String(replicaKey),
          entityId: String(state?.entityId || ''),
          profileName: String(state?.profile?.name || ''),
          messages: Array.from(state?.messages || []).slice(-16).map(String),
          accounts: Array.from(state?.accounts?.entries?.() || []).map(([accountKey, account]: [string, any]) => ({
            accountKey,
            matchesCounterparty: String(accountKey || '').toLowerCase() === cp ||
              String(account?.counterpartyEntityId || '').toLowerCase() === cp ||
              [String(account?.leftEntity || '').toLowerCase(), String(account?.rightEntity || '').toLowerCase()].includes(cp),
            currentHeight: Number(account?.currentHeight || 0),
            pendingTxs: Array.from(account?.pendingFrame?.accountTxs || []).map((tx: any) => String(tx?.type || '')),
            mempoolTxs: Array.from(account?.mempool || []).map((tx: any) => `${String(tx?.type || '')}:${String(tx?.data?.offerId || '').slice(-8)}`),
            openOffers: Array.from(account?.swapOffers?.entries?.() || []).map(([offerId, offer]: [string, any]) => ({
              offerId,
              cross: Boolean(offer?.crossJurisdiction),
              status: String(offer?.crossJurisdiction?.status || ''),
              fillSeq: Number(offer?.crossJurisdiction?.fillSeq || 0),
              ratio: Number(offer?.crossJurisdiction?.cumulativeFillRatio || 0),
            })),
            history: Array.from(account?.swapOrderHistory?.entries?.() || []).map(([offerId, entry]: [string, any]) => ({
              offerId,
              resolves: Array.from(entry?.resolves || []).map((resolve: any) => ({
                height: Number(resolve?.height || 0),
                fillRatio: Number(resolve?.fillRatio || 0),
                executionGiveAmount: String(resolve?.executionGiveAmount ?? '0'),
                executionWantAmount: String(resolve?.executionWantAmount ?? '0'),
              })),
            })),
            closed: Array.from(account?.swapClosedOrders?.entries?.() || []).map(([offerId, entry]: [string, any]) => ({
              offerId,
              resolves: Array.from(entry?.resolves || []).map((resolve: any) => ({
                height: Number(resolve?.height || 0),
                fillRatio: Number(resolve?.fillRatio || 0),
                executionGiveAmount: String(resolve?.executionGiveAmount ?? '0'),
                executionWantAmount: String(resolve?.executionWantAmount ?? '0'),
              })),
            })),
          })),
        });
      }
      return out;
    }, { entityId, counterpartyId });
    console.log('[E2E cross resolve debug]', JSON.stringify({ entityId, counterpartyId, debug }, null, 2));
    throw error;
  }
  const latest = (await readCrossResolveSnapshots(page, entityId, counterpartyId)).at(-1);
  expect(latest, 'latest cross resolve snapshot must exist').toBeTruthy();
  return latest!;
}

async function waitForCrossOffersCleared(
  page: Page,
  identity: RuntimeIdentity,
  hubId: string,
  label: string,
  options: { orderId?: string } = {},
): Promise<void> {
  try {
    await expect.poll(
      async () => {
        const state = await readCrossState(page, identity, hubId);
        const matchingOfferOpen = options.orderId
          ? state.offerSummaries.some((offer) => offer.offerId === options.orderId)
          : state.offers > 0;
        return {
          offers: options.orderId ? (matchingOfferOpen ? 1 : 0) : state.offers,
          hasPendingFrame: state.hasPendingFrame,
          mempoolTxs: state.mempoolTxs,
          replicaFound: state.replicaFound,
          accountFound: state.accountFound,
          accountKeys: state.accountKeys,
          openOfferIds: state.offerSummaries.map((offer) => offer.offerId),
        };
      },
      {
        timeout: 45_000,
        intervals: [250, 500, 1000],
        message: `${label} cross order should resolve/cancel after match`,
      },
    ).toMatchObject({ offers: 0, hasPendingFrame: false, mempoolTxs: [] });
  } catch (error) {
    const debug = await page.evaluate(({ identity, hubId }) => {
      const env = (window as CrossRuntimeWindow).isolatedEnv;
      const out: any[] = [];
      for (const [key, replica] of env?.eReplicas?.entries?.() || []) {
        const state = replica?.state;
        const entityId = String(state?.entityId || replica?.entityId || '').toLowerCase();
        if (
          entityId !== String(identity.entityId).toLowerCase() &&
          !Array.from(state?.accounts?.keys?.() || []).some((accountId) => String(accountId).toLowerCase() === String(hubId).toLowerCase())
        ) {
          continue;
        }
        out.push({
          key: String(key),
          entityId,
          signerId: String(replica?.signerId || ''),
          profileName: String(state?.profile?.name || ''),
          jurisdiction: String(state?.config?.jurisdiction?.name || ''),
          messages: Array.from(state?.messages || []).slice(-12).map(String),
          routes: Array.from(state?.crossJurisdictionSwaps?.entries?.() || []).map(([routeId, route]: [string, any]) => ({
            routeId,
            status: String(route?.status || ''),
            source: String(route?.source?.entityId || '').slice(0, 10),
            sourceHub: String(route?.source?.counterpartyEntityId || '').slice(0, 10),
            targetHub: String(route?.target?.entityId || '').slice(0, 10),
            target: String(route?.target?.counterpartyEntityId || '').slice(0, 10),
            sourcePull: Boolean(route?.sourcePull),
            targetPull: Boolean(route?.targetPull),
          })),
          accounts: Array.from(state?.accounts?.entries?.() || []).map(([accountId, account]: [string, any]) => ({
            accountId,
            currentHeight: Number(account?.currentHeight || 0),
            mempool: Array.from(account?.mempool || []).map((tx: any) => String(tx?.type || '')),
            pendingFrame: Array.from(account?.pendingFrame?.accountTxs || []).map((tx: any) => String(tx?.type || '')),
            offers: Array.from(account?.swapOffers?.entries?.() || []).map(([offerId, offer]: [string, any]) => ({
              offerId,
              cross: Boolean(offer?.crossJurisdiction),
              status: String(offer?.crossJurisdiction?.status || ''),
            })),
            pulls: Array.from(account?.pulls?.keys?.() || []),
          })),
        });
      }
      return out;
    }, { identity, hubId });
    console.log(`[E2E ${label} offer debug]`, JSON.stringify(debug, null, 2));
    throw error;
  }
}

async function waitForCrossPendingFill(
  page: Page,
  identity: RuntimeIdentity,
  hubId: string,
  label: string,
  options: { routeId?: string; minFillSeq?: number; minRatioExclusive?: number } = {},
): Promise<{ routeId: string; ratio: number; fillSeq: number }> {
  let routeId = '';
  let ratio = 0;
  let fillSeq = 0;
  try {
    await expect.poll(
      async () => {
        const state = await readCrossState(page, identity, hubId);
        const route = state.routeSummaries
          .filter((candidate) =>
            candidate.status === 'partially_filled' &&
            candidate.cumulativeFillRatio > 0 &&
            candidate.cumulativeFillRatio < 65_535 &&
            (!options.routeId || candidate.orderId === options.routeId) &&
            candidate.fillSeq >= (options.minFillSeq ?? 1) &&
            candidate.cumulativeFillRatio > (options.minRatioExclusive ?? 0),
          )
          .sort((a, b) => b.updatedAt - a.updatedAt)[0];
        routeId = route?.orderId || '';
        ratio = route?.cumulativeFillRatio || 0;
        fillSeq = route?.fillSeq || 0;
        return {
          offers: state.offers,
          pulls: state.pulls,
          routeStatus: route?.status || '',
          ratio,
          fillSeq,
        };
      },
      {
        timeout: 75_000,
        intervals: [250, 500, 1000],
        message: `${label} cross-j partial fill must remain pending in the book without clearing pulls`,
      },
    ).toMatchObject({
      offers: expect.any(Number),
      pulls: expect.any(Number),
      routeStatus: 'partially_filled',
      fillSeq: expect.any(Number),
    });
  } catch (error) {
    const state = await readCrossState(page, identity, hubId);
    console.log(`[E2E ${label} pending fill debug]`, JSON.stringify({
      offers: state.offers,
      pulls: state.pulls,
      routes: state.routeSummaries.map((candidate: any) => ({
        orderId: String(candidate.orderId || ''),
        status: candidate.status,
        ratio: candidate.cumulativeFillRatio,
        fillSeq: candidate.fillSeq,
        filledSourceAmount: candidate.filledSourceAmount,
        filledTargetAmount: candidate.filledTargetAmount,
        sourcePull: candidate.sourcePull,
        targetPull: candidate.targetPull,
        bookOwnerEntityId: candidate.bookOwnerEntityId,
        venueId: candidate.venueId,
      })),
      offerSummaries: state.offerSummaries,
      pullIds: state.pullIds,
      accountKeys: state.accountKeys,
      messages: state.messages.slice(-20),
    }, null, 2));
    throw error;
  }
  expect(routeId, `${label} partial route id must be available`).toBeTruthy();
  const state = await readCrossState(page, identity, hubId);
  const route = state.routeSummaries.find((candidate) => candidate.orderId === routeId);
  expect(state.offers, `${label} partial order must stay open`).toBeGreaterThan(0);
  expect(state.pulls, `${label} partial pull must stay locked until explicit clear`).toBeGreaterThan(0);
  expect(route?.cumulativeFillRatio || 0, `${label} partial ratio must be positive`).toBeGreaterThan(0);
  expect(route?.cumulativeFillRatio || 0, `${label} partial ratio must not be full`).toBeLessThan(65_535);
  return { routeId, ratio, fillSeq };
}

async function requestCrossClear(
  page: Page,
  identity: RuntimeIdentity,
  orderId: string,
  options: { cancelRemainder?: boolean } = {},
): Promise<void> {
  await enqueueEntityTxs(page, identity.entityId, identity.signerId, [{
    type: 'requestCrossJurisdictionClear',
    data: {
      orderId,
      cancelRemainder: Boolean(options.cancelRemainder),
    },
  }]);
  await flushRuntime(page, 5);
}

async function waitForCrossRouteStatus(
  page: Page,
  identity: RuntimeIdentity,
  hubId: string,
  orderId: string,
  statuses: readonly string[],
  label: string,
): Promise<void> {
  try {
    await expect.poll(
      async () => {
        const state = await readCrossState(page, identity, hubId);
        const route = state.routeSummaries.find((candidate) => candidate.orderId === orderId);
        return {
          status: route?.status || '',
          offers: state.offers,
          pulls: state.pulls,
          ratio: route?.cumulativeFillRatio || 0,
        };
      },
      {
        timeout: 75_000,
        intervals: [250, 500, 1000],
        message: `${label} route ${orderId.slice(0, 10)} must reach ${statuses.join('/')}`,
      },
    ).toMatchObject({
      status: expect.stringMatching(new RegExp(`^(${statuses.map(escapeRegex).join('|')})$`)),
    });
  } catch (error) {
    const state = await readCrossState(page, identity, hubId);
    console.log(`[E2E ${label} route status debug]`, JSON.stringify({
      orderId,
      expected: statuses,
      offers: state.offers,
      pulls: state.pulls,
      route: state.routeSummaries.find((candidate) => candidate.orderId === orderId),
      offerSummaries: state.offerSummaries,
      pullIds: state.pullIds,
      messages: state.messages.slice(-24),
    }, null, 2));
    throw error;
  }
}

async function waitForCrossRouteMaterialized(
  page: Page,
  identity: RuntimeIdentity,
  hubId: string,
  orderId: string,
  label: string,
): Promise<void> {
  try {
    await expect.poll(
      async () => {
        const state = await readCrossState(page, identity, hubId);
        const route = state.routeSummaries.find((candidate) => candidate.orderId === orderId);
        return {
          present: Boolean(route),
          sourcePull: Boolean(route?.sourcePull),
          targetPull: Boolean(route?.targetPull),
          status: route?.status || '',
        };
      },
      {
        timeout: 45_000,
        intervals: [250, 500, 1000],
        message: `${label} route ${orderId.slice(0, 10)} must materialize before dispute salvage`,
      },
    ).toMatchObject({ present: true, targetPull: true });
  } catch (error) {
    const state = await readCrossState(page, identity, hubId);
    console.log(`[E2E ${label} route materialization debug]`, JSON.stringify({
      orderId,
      routes: state.routeSummaries,
      accountKeys: state.accountKeys,
      messages: state.messages.slice(-24),
    }, null, 2));
    throw error;
  }
}

async function triggerSourceDisputeArguments(
  page: Page,
  source: RuntimeIdentity,
  hubId: string,
  routeId: string,
  sourceHubRuntimeSeed: string,
): Promise<void> {
  expect(routeId, `${source.entityId.slice(0, 10)} active cross-j route id required for dispute args`).toBeTruthy();
  const abi = AbiCoder.defaultAbiCoder();
  const partialBinary = await page.evaluate(async ({ source, routeId, sourceHubRuntimeSeed }) => {
    const view = window as CrossRuntimeWindow;
    const env = view.isolatedEnv;
    if (!env) throw new Error('isolatedEnv missing');
    const runtimeModule = view.__xln?.instance;
    if (!runtimeModule) throw new Error('__xln.instance missing');
    const sourceEntityId = String(source.entityId || '').toLowerCase();
    let sourceState: any = null;
    for (const replica of env.eReplicas?.values?.() || []) {
      const state = replica?.state;
      if (String(state?.entityId || '').toLowerCase() === sourceEntityId) {
        sourceState = state;
        break;
      }
    }
    const route = sourceState?.crossJurisdictionSwaps?.get(routeId);
    if (!route) throw new Error(`cross-j source dispute route missing: ${routeId}`);
    const fillRatio = Number(route.cumulativeFillRatio || route.claimedRatio || 0);
    if (!Number.isFinite(fillRatio) || fillRatio <= 0) {
      throw new Error(`cross-j source dispute route has no committed fill: ${routeId}`);
    }
    // Pull commitments are prepared by the source hub, so source-dispute args
    // must reveal with the source hub runtime seed, not the user's BrainVault seed.
    const privateSeed = runtimeModule.getCrossJurisdictionPrivateSeed({ runtimeSeed: sourceHubRuntimeSeed }, route);
    const reveal = runtimeModule.buildCrossJurisdictionPullReveal(route, fillRatio, privateSeed);
    if (!reveal?.binary || reveal.binary === '0x') {
      throw new Error(`cross-j source dispute reveal missing binary: ${routeId}`);
    }
    return String(reveal.binary);
  }, { source, routeId, sourceHubRuntimeSeed });
  const crossPullArgs = abi.encode(
    ['tuple(uint16[] fillRatios, bytes32[] secrets, bytes[] pulls)'],
    [{ fillRatios: [], secrets: [], pulls: [partialBinary] }],
  );
  const starterInitialArguments = abi.encode(['bytes[]'], [[crossPullArgs]]);
  const suffix = routeId.replace(/[^a-fA-F0-9]/g, '').padEnd(64, '0').slice(0, 64);
  const event = {
    type: 'DisputeStarted',
    data: {
      sender: hubId,
      counterentity: source.entityId,
      nonce: '1',
      proofbodyHash: `0x${suffix}`,
      starterInitialArguments,
      starterIncrementedArguments: '0x',
      disputeTimeout: 100,
      onChainNonce: 1,
    },
  };
  const transactionHash = `0x${'cd'.repeat(32)}`;
  await injectSyntheticJEventThroughWatcher(page, source, {
    event,
    transactionHash,
  });
  await flushRuntime(page, 8);
}

async function waitForCrossDisputeRouted(
  page: Page,
  source: RuntimeIdentity,
  hubId: string,
  routeId: string,
): Promise<void> {
  try {
    await expect.poll(
      async () => {
        await flushRuntime(page, 1);
        const state = await readCrossState(page, source, hubId);
        return state.messages.some((message) =>
          /Cross-j pull args observed/i.test(message) && message.includes(routeId),
        );
      },
      {
        timeout: 45_000,
        intervals: [250, 500, 1000],
        message: 'source dispute must route cross-j pull args to target sibling',
      },
    ).toBe(true);
  } catch (error) {
    const state = await readCrossState(page, source, hubId);
    console.log('[E2E source dispute route debug]', JSON.stringify({
      routeId,
      routes: state.routeSummaries,
      accountKeys: state.accountKeys,
      messages: state.messages.slice(-32),
    }, null, 2));
    throw error;
  }
}

async function waitForCrossSalvageQueued(
  page: Page,
  target: RuntimeIdentity,
  hubId: string,
  routeId: string,
): Promise<void> {
  try {
    await expect.poll(
      async () => {
        await flushRuntime(page, 1);
        const state = await readCrossState(page, target, hubId);
        const route = state.routeSummaries.find((candidate) => candidate.orderId === routeId);
        const routedMessage = state.messages.some((message) =>
          /Cross-j salvage queued/i.test(message) && message.includes(routeId),
        );
        const disputeStarted = state.messages.some((message) => /Dispute started/i.test(message));
        const routeProgressedPastSalvage = Boolean(
          route
          && route.targetPull
          && route.cumulativeFillRatio > 0
          && ['clearing', 'source_claimed', 'target_claimed', 'settled'].includes(route.status),
        );
        return routedMessage || (disputeStarted && Boolean(route)) || routeProgressedPastSalvage;
      },
      {
        timeout: 45_000,
        intervals: [250, 500, 1000],
        message: 'target sibling must queue cross-j salvage after source dispute arguments',
      },
    ).toBe(true);
  } catch (error) {
    const state = await readCrossState(page, target, hubId);
    console.log('[E2E target salvage debug]', JSON.stringify({
      routeId,
      routes: state.routeSummaries,
      pullIds: state.pullIds,
      accountKeys: state.accountKeys,
      messages: state.messages.slice(-32),
    }, null, 2));
    throw error;
  }
}

test.describe('E2E Cross-J Swap Isolated Flow', () => {
  test.setTimeout(360_000);

  test('market maker prepublishes same-chain and ETH/TRON cross-chain books before user swaps', { tag: '@functional' }, async ({ page }) => {
    const baseline = await timedStep('cross_j_mm_books.ensure_baseline', () => ensureE2EBaseline(page, {
      apiBaseUrl: API_BASE_URL,
      requireMarketMaker: true,
      requireHubMesh: true,
      minHubCount: 3,
    }));
    expectMarketMakerSameAndCrossBooksHealthy(baseline);
  });

  test('real MM full fill auto-closes and partial fill closes manually on both legs', { tag: '@functional' }, async ({ page }, testInfo) => {
    const baseline = await timedStep('cross_j_mm_fill.ensure_baseline', () => ensureE2EBaseline(page, {
      apiBaseUrl: API_BASE_URL,
      requireMarketMaker: true,
      requireHubMesh: true,
      minHubCount: 3,
    }));
    expectMarketMakerSameAndCrossBooksHealthy(baseline);
    const hubId = getPrimaryHubId(baseline);
    const primaryHubApiBaseUrl = getPrimaryHubApiBaseUrl(baseline, hubId);
    const primaryHubName = getPrimaryHubName(baseline, hubId);
    const targetHub = await getSecondaryHubInfo(page, hubId, primaryHubName, primaryHubApiBaseUrl);

    await gotoApp(page, { appBaseUrl: APP_BASE_URL, initTimeoutMs: INIT_TIMEOUT, settleMs: 1200 });
    const mnemonic = Wallet.createRandom().mnemonic!.phrase;
    const source = await createRuntimeIdentityViaStore(page, 'cross-real-mm', mnemonic);
    await waitForDefaultJurisdictionReplicas(page, 'cross-real-mm');
    const target = await importRpc2SiblingEntity(page, mnemonic, 'cross-real-mm');
    await connectRuntimeToHubWithCredit(page, source, hubId, '10000', SWAP_TOKENS);
    await ensureDirectHubAccount(page, target, targetHub.entityId, SWAP_TOKENS, 150_000);
    await faucetOffchain(page, primaryHubApiBaseUrl, source.entityId, hubId, USDC, '300');
    await waitForOutCapAtLeast(page, source.entityId, hubId, USDC, tokenAmount(USDC, 300n));

    const orderId = await placeCrossOrder(page, {
      source,
      hubId,
      targetEntityId: target.entityId,
      side: 'sell',
      fromTokenId: USDC,
      toTokenId: USDC,
      clickBookSide: 'bid',
      expectedClickFromTokenId: USDC,
      expectedClickToTokenId: USDC,
      expectedBookDepth: 10,
      expectedAutoAmount: 300,
      screenshotPath: testInfo.outputPath('cross-j-mm-10x10-hub-first.png'),
    });
    await expect(page.getByTestId('swap-from-token-label').first()).toContainText('USDC (Testnet)');
    await expect(page.getByTestId('swap-to-token-label').first()).toContainText('USDC (Tron)');

    await waitForCrossPullFlow(page, source, target, hubId, targetHub.entityId, {
      sourceRouteId: orderId,
      targetRouteId: orderId,
    });
    await waitForCrossOffersCleared(page, source, hubId, 'real MM USDC fill', { orderId });
    await expect.poll(async () => {
      await flushRuntime(page, 3);
      const [sourceState, targetState] = await Promise.all([
        readCrossState(page, source, hubId),
        readCrossState(page, target, targetHub.entityId),
      ]);
      return {
        sourcePulls: sourceState.pulls,
        targetPulls: targetState.pulls,
        sourcePending: sourceState.hasPendingFrame,
        targetPending: targetState.hasPendingFrame,
        sourceMempool: sourceState.mempoolTxs,
        targetMempool: targetState.mempoolTxs,
      };
    }, {
      timeout: 75_000,
      intervals: [250, 500, 1000],
      message: 'real MM cross-j fill must leave no pulls, pending frames, or Account mempool residue',
    }).toEqual({
      sourcePulls: 0,
      targetPulls: 0,
      sourcePending: false,
      targetPending: false,
      sourceMempool: [],
      targetMempool: [],
    });
    const [filledSourceState, filledTargetState] = await Promise.all([
      readCrossState(page, source, hubId),
      readCrossState(page, target, targetHub.entityId),
    ]);
    expect(
      filledSourceState.routeSummaries.find((route) => route.orderId === orderId)?.status,
      'a fully matched source route must close automatically',
    ).toBe('settled');
    expect(
      filledTargetState.routeSummaries.find((route) => route.orderId === orderId)?.status,
      'a fully matched target route must close automatically',
    ).toBe('settled');
    await expect(page.getByTestId('swap-open-order-row')).toHaveCount(0, { timeout: 15_000 });

    await enqueueEntityTxs(page, target.entityId, target.signerId, [{
      type: 'extendCredit',
      data: {
        counterpartyEntityId: targetHub.entityId,
        tokenId: USDC,
        amount: tokenAmount(USDC, 100_000n),
      },
    }]);
    await flushRuntime(page, 8);
    await faucetOffchain(page, primaryHubApiBaseUrl, source.entityId, hubId, WETH, '15');
    await waitForOutCapAtLeast(page, source.entityId, hubId, WETH, tokenAmount(WETH, 15n));
    const partialOrderId = await placeCrossOrder(page, {
      source,
      hubId,
      targetEntityId: target.entityId,
      side: 'sell',
      fromTokenId: WETH,
      toTokenId: USDC,
      clickBookSide: 'bid',
      expectedClickFromTokenId: WETH,
      expectedClickToTokenId: USDC,
      amount: '15',
    });
    const partial = await waitForCrossPendingFill(page, source, hubId, 'real MM WETH partial', {
      routeId: partialOrderId,
    });
    const clearButton = page.getByTestId('cross-swap-clear').first();
    await expect(clearButton, 'real MM partial remainder must expose Clear + Close').toBeVisible({ timeout: 20_000 });
    await clearButton.click({ force: true });
    await flushRuntime(page, 5);
    await Promise.all([
      waitForCrossRouteStatus(page, source, hubId, partial.routeId, ['settled'], 'real MM source clear'),
      waitForCrossRouteStatus(page, target, targetHub.entityId, partial.routeId, ['settled'], 'real MM target clear'),
    ]);
    await waitForCrossOffersCleared(page, source, hubId, 'real MM partial clear', { orderId: partial.routeId });
    await expect.poll(async () => {
      await flushRuntime(page, 3);
      const [sourceState, targetState] = await Promise.all([
        readCrossState(page, source, hubId),
        readCrossState(page, target, targetHub.entityId),
      ]);
      return {
        sourcePulls: sourceState.pulls,
        targetPulls: targetState.pulls,
        sourcePending: sourceState.hasPendingFrame,
        targetPending: targetState.hasPendingFrame,
        sourceMempool: sourceState.mempoolTxs,
        targetMempool: targetState.mempoolTxs,
      };
    }, {
      timeout: 75_000,
      intervals: [250, 500, 1000],
      message: 'real MM Clear + Close must release both pull legs and every Account queue',
    }).toEqual({
      sourcePulls: 0,
      targetPulls: 0,
      sourcePending: false,
      targetPending: false,
      sourceMempool: [],
      targetMempool: [],
    });
  });

  test('cross USDT/USDT orderbook resolves terminal no-market when the selected route relay has no snapshots', { tag: '@resilience' }, async ({ page }) => {
    const baseline = await timedStep('cross_j_no_market.ensure_baseline', () => ensureE2EBaseline(page, {
      apiBaseUrl: API_BASE_URL,
      requireMarketMaker: false,
      requireHubMesh: true,
      minHubCount: 3,
    }));
    const hubId = getPrimaryHubId(baseline);
    const primaryHubApiBaseUrl = getPrimaryHubApiBaseUrl(baseline, hubId);
    const primaryHubName = getPrimaryHubName(baseline, hubId);
    const targetHub = await timedStep('cross_j_no_market.resolve_rpc2_hub', () =>
      getSecondaryHubInfo(page, hubId, primaryHubName, primaryHubApiBaseUrl),
    );

    await timedStep('cross_j_no_market.goto', () => gotoApp(page, { appBaseUrl: APP_BASE_URL, initTimeoutMs: INIT_TIMEOUT, settleMs: 1200 }));
    const mnemonic = Wallet.createRandom().mnemonic!.phrase;
    const source = await timedStep('cross_j_no_market.create_runtime', () =>
      createRuntimeIdentityViaStore(page, 'cross-no-market', mnemonic),
    );
    await timedStep('cross_j_no_market.default_jurisdictions', () => waitForDefaultJurisdictionReplicas(page, 'cross-no-market'));
    const target = await timedStep('cross_j_no_market.import_rpc2_sibling', () =>
      importRpc2SiblingEntity(page, mnemonic, 'cross-no-market'),
    );
    await timedStep('cross_j_no_market.connect_primary', () =>
      connectRuntimeToHubWithCredit(page, source, hubId, '10000', SWAP_TOKENS),
    );
    await timedStep('cross_j_no_market.connect_rpc2', () =>
      ensureDirectHubAccount(page, target, targetHub.entityId, SWAP_TOKENS, 150_000),
    );

    await timedStep('cross_j_no_market.install_silent_relay', () =>
      installSilentRelayWebSocket(page, { currentPage: true }),
    );
    await timedStep('cross_j_no_market.open_swap', async () => {
      await openSwapWorkspace(page);
      await selectSourceChainInSwap(page, source.entityId);
      await selectCounterpartyInSwap(page, hubId);
      await selectCrossRoute(page, target.entityId);
      await configureTokens(page, USDT, USDT);
    });

    const orderbook = page.getByTestId('swap-orderbook').first();
    const panel = orderbook.locator('.orderbook-panel').first();
    await expect(orderbook, 'cross route must keep the right-side orderbook mounted when stream is silent').toBeVisible({ timeout: 20_000 });
    await expect(panel, 'cross no-market state must still render the orderbook panel').toBeVisible({ timeout: 20_000 });
    await expect
      .poll(async () => String(await panel.getAttribute('data-pair-id') || ''), {
        timeout: 10_000,
        intervals: [100, 250, 500],
        message: 'silent cross route must subscribe to a cross venue id',
      })
      .toMatch(/^cross:/);
    await expect
      .poll(async () => hasSilentRelayMarketSubscribe(page, ['cross:']), {
        timeout: 10_000,
        intervals: [100, 250, 500],
        message: 'cross orderbook must actually send market_subscribe before terminal no-market is accepted',
      })
      .toBe(true);
    await expect
      .poll(async () => String(await panel.getAttribute('data-source-status') || ''), {
        timeout: 12_000,
        intervals: [250, 500, 1000],
        message: 'silent cross relay must resolve to no-market instead of hanging in syncing',
      })
      .toBe('no-market');
    await expect(orderbook.getByTestId('orderbook-source-status').first()).toContainText(/No market/i, { timeout: 5_000 });
    await expect(orderbook.getByTestId('orderbook-source-status').first()).not.toContainText(/syncing|loading/i, { timeout: 5_000 });
    const recommendation = page.getByTestId('swap-route-recommendation').first();
    await expect(recommendation, 'terminal no-market direct cross route should show manual route candidates').toBeVisible({ timeout: 10_000 });
    await expect
      .poll(async () => await page.getByTestId('swap-route-recommendation-row').count(), {
        timeout: 5_000,
        intervals: [100, 250, 500],
      })
      .toBeGreaterThan(0);
    await expect
      .poll(async () => ({
        asks: await orderbook.getByTestId('orderbook-ask-row').count(),
        bids: await orderbook.getByTestId('orderbook-bid-row').count(),
      }), {
        timeout: 5_000,
        intervals: [100, 250, 500],
      })
      .toEqual({ asks: 0, bids: 0 });
  });

  test('Tron sibling inherits rebalance policy and auto-collateralizes USDC after faucet', { tag: '@functional' }, async ({ page }) => {
    const baseline = await timedStep('cross_j_tron_rebalance.ensure_baseline', () => ensureE2EBaseline(page, {
      apiBaseUrl: API_BASE_URL,
      requireMarketMaker: false,
      requireHubMesh: true,
      minHubCount: 3,
    }));
    const hubId = getPrimaryHubId(baseline);
    const primaryHubApiBaseUrl = getPrimaryHubApiBaseUrl(baseline, hubId);
    const primaryHubName = getPrimaryHubName(baseline, hubId);
    const targetHub = await timedStep('cross_j_tron_rebalance.resolve_rpc2_hub', () =>
      getSecondaryHubInfo(page, hubId, primaryHubName, primaryHubApiBaseUrl),
    );

    await timedStep('cross_j_tron_rebalance.goto', () =>
      gotoApp(page, { appBaseUrl: APP_BASE_URL, initTimeoutMs: INIT_TIMEOUT, settleMs: 1200 }),
    );
    const mnemonic = Wallet.createRandom().mnemonic!.phrase;
    await timedStep('cross_j_tron_rebalance.create_runtime', () =>
      createRuntimeIdentityViaStore(page, 'cross-tron-rebalance', mnemonic),
    );
    await timedStep('cross_j_tron_rebalance.default_jurisdictions', () =>
      waitForDefaultJurisdictionReplicas(page, 'cross-tron-rebalance'),
    );
    const target = await timedStep('cross_j_tron_rebalance.import_rpc2_sibling', () =>
      importRpc2SiblingEntity(page, mnemonic, 'cross-tron-rebalance'),
    );
    expect(
      /tron|rpc2/i.test(target.jurisdictionName),
      `target sibling must be in Tron/rpc2 jurisdiction, got ${target.jurisdictionName}`,
    ).toBe(true);

    await timedStep('cross_j_tron_rebalance.connect_rpc2', () =>
      ensureDirectHubAccount(page, target, targetHub.entityId, SWAP_TOKENS, 150_000),
    );
    const policySnapshot = await timedStep('cross_j_tron_rebalance.wait_policy', () =>
      waitForRebalancePolicy(page, target, targetHub.entityId, USDC),
    );
    expect(policySnapshot.jurisdiction).toMatch(/tron|rpc2/i);
    expect(BigInt(policySnapshot.policy?.r2cRequestSoftLimit || '0')).toBe(DEFAULT_USDC_REBALANCE_SOFT_LIMIT);

    await timedStep('cross_j_tron_rebalance.faucet_usdc_over_soft_limit', () =>
      faucetOffchain(page, primaryHubApiBaseUrl, target.entityId, targetHub.entityId, USDC, '700'),
    );
    const secured = await timedStep('cross_j_tron_rebalance.wait_secured', () =>
      waitForRebalanceSecured(page, target, targetHub.entityId, USDC),
    );
    expect(BigInt(secured.collateral), `Tron USDC collateral must be positive: ${JSON.stringify(secured)}`).toBeGreaterThan(0n);
    expect(BigInt(secured.uncollateralized), `Tron USDC debt must be secured: ${JSON.stringify(secured)}`).toBe(0n);
    expect(secured.lastFinalizedJHeight, `Tron jwatch must finalize AccountSettled: ${JSON.stringify(secured)}`).toBeGreaterThan(0);
  });

  test('cross swap one-click prepares missing target account and inbound credit', { tag: '@functional' }, async ({ page }) => {
    const browserConsole = attachBrowserConsoleGuard(page);
    page.on('console', (message) => {
      if (message.text().includes('[INFO][p2p] ingress.entity_inputs')) {
        console.log(`[E2E-P2P] ${message.text()}`);
      }
    });
    const baseline = await timedStep('cross_j_auto_setup.ensure_baseline', () => ensureE2EBaseline(page, {
      apiBaseUrl: API_BASE_URL,
      requireMarketMaker: false,
      requireHubMesh: true,
      minHubCount: 3,
    }));
    const hubId = getPrimaryHubId(baseline);
    const primaryHubApiBaseUrl = getPrimaryHubApiBaseUrl(baseline, hubId);
    const primaryHubName = getPrimaryHubName(baseline, hubId);
    const targetHub = await timedStep('cross_j_auto_setup.resolve_rpc2_hub', () =>
      getSecondaryHubInfo(page, hubId, primaryHubName, primaryHubApiBaseUrl),
    );

    await timedStep('cross_j_auto_setup.goto', () =>
      gotoApp(page, { appBaseUrl: APP_BASE_URL, initTimeoutMs: INIT_TIMEOUT, settleMs: 1200 }),
    );
    const mnemonic = Wallet.createRandom().mnemonic!.phrase;
    const source = await timedStep('cross_j_auto_setup.create_runtime', () =>
      createRuntimeIdentityViaStore(page, 'cross-auto-setup', mnemonic),
    );
    await timedStep('cross_j_auto_setup.default_jurisdictions', () =>
      waitForDefaultJurisdictionReplicas(page, 'cross-auto-setup'),
    );
    const target = await timedStep('cross_j_auto_setup.import_rpc2_sibling', () =>
      importRpc2SiblingEntity(page, mnemonic, 'cross-auto-setup'),
    );
    await timedStep('cross_j_auto_setup.connect_primary', () =>
      connectRuntimeToHubWithCredit(page, source, hubId, '10000', SWAP_TOKENS),
    );
    await timedStep('cross_j_auto_setup.faucet_source_weth', () =>
      faucetOffchain(page, primaryHubApiBaseUrl, source.entityId, hubId, WETH, '1'),
    );
    await timedStep('cross_j_auto_setup.wait_source_weth', () =>
      waitForOutCapAtLeast(page, source.entityId, hubId, WETH, 1n * 10n ** 16n),
    );
    await timedStep('cross_j_auto_setup.install_synthetic_relay', () =>
      installSilentRelayWebSocket(page, {
        currentPage: true,
        marketSnapshots: [{
          bids: [{ price: '24900000', size: 1000 }],
          asks: [{ price: '25100000', size: 1000 }],
        }],
      }),
    );

    await page.evaluate(() => {
      const view = window as CrossRuntimeWindow & { __crossJFrameTrace?: unknown[]; __crossJClickAt?: number };
      const browserProcess = (globalThis as typeof globalThis & {
        process?: { env?: Record<string, string | undefined> };
      }).process;
      if (browserProcess?.env) {
        browserProcess.env.XLN_P2P_INGRESS_PROFILE = '1';
      }
      const longTasks: Array<{ startTime: number; duration: number; name: string }> = [];
      (view as typeof view & { __crossJLongTasks?: typeof longTasks }).__crossJLongTasks = longTasks;
      if (typeof PerformanceObserver === 'function') {
        const observer = new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) {
            longTasks.push({
              startTime: Math.round(entry.startTime),
              duration: Math.round(entry.duration),
              name: entry.name,
            });
          }
        });
        observer.observe({ entryTypes: ['longtask'] });
      }
      const env = view.isolatedEnv;
      const runtimeModule = view.__xln?.instance;
      if (!env || typeof runtimeModule?.registerRuntimeFrameCommitCallback !== 'function') {
        throw new Error('cross-j Runtime frame trace API missing');
      }
      view.__crossJFrameTrace = [];
      runtimeModule.registerRuntimeFrameCommitCallback(env, ({ height, runtimeInput }: any) => {
        const activeEnv = view.isolatedEnv;
        const effectiveTxs = (input: any) => Array.from(input?.entityTxs || []).flatMap((tx: any) =>
          tx?.type === 'consensusOutput' || tx?.type === 'runtimeOutput'
            ? Array.from(tx?.data?.entityTxs || [])
            : [tx]);
        const accountInputs = (input: any) => effectiveTxs(input).flatMap((tx: any) => {
          if (tx?.type !== 'accountInput') return [];
          const data = tx.data || {};
          return [{
            entityId: String(input.entityId || ''),
            runtimeId: String(input.runtimeId || ''),
            sourceRuntimeFrame: input.sourceRuntimeFrame || null,
            kind: String(data.kind || ''),
            ackHeight: Number(data.ack?.height ?? -1),
            proposalHeight: Number(data.proposal?.frame?.height ?? -1),
            accountTxTypes: Array.from(data.proposal?.frame?.accountTxs || []).map((accountTx: any) =>
              String(accountTx?.type || '')),
          }];
        });
        view.__crossJFrameTrace!.push({
          height,
          wallAfterClickMs: view.__crossJClickAt ? Date.now() - view.__crossJClickAt : null,
          inputEntityTxTypes: Array.from(runtimeInput?.entityInputs || []).map((input: any) => ({
            entityId: String(input?.entityId || ''),
            txTypes: effectiveTxs(input).map((tx: any) => String(tx?.type || '')),
          })),
          crossRoutes: Array.from(activeEnv?.eReplicas?.values?.() || []).flatMap((replica: any) =>
            Array.from(replica?.state?.crossJurisdictionSwaps?.values?.() || []).map((route: any) => ({
              entityId: String(replica?.state?.entityId || replica?.entityId || ''),
              orderId: String(route?.orderId || ''),
              status: String(route?.status || ''),
            }))),
          inputAccountInputs: Array.from(runtimeInput?.entityInputs || []).flatMap(accountInputs),
          inputReliableReceipts: Array.from(runtimeInput?.reliableReceipts || []).map((receipt: any) => ({
            kind: String(receipt?.body?.identity?.kind || ''),
            height: Number(receipt?.body?.identity?.height ?? -1),
            coverage: String(receipt?.body?.coverage || ''),
            receiverRuntimeId: String(receipt?.body?.receiverRuntimeId || ''),
          })),
          pendingOutputAccountInputs: Array.from(activeEnv?.pendingNetworkOutputs || []).flatMap(accountInputs),
        });
      });
    });

    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Profiler.enable');
    await cdp.send('Profiler.start');
    await timedStep('cross_j_auto_setup.submit_one_click_swap', () => placeCrossOrder(page, {
      source,
      hubId,
      targetEntityId: target.entityId,
      side: 'sell',
      amount: '0.01',
      price: '2490.0000',
      clickBookSide: 'bid',
      expectedClickFromTokenId: WETH,
      expectedClickToTokenId: USDC,
      expectSetupConsent: true,
    }));
    const { profile } = await cdp.send('Profiler.stop') as {
      profile: {
        nodes: Array<{
          id: number;
          callFrame: { functionName: string; url: string; lineNumber: number };
          children?: number[];
        }>;
        samples?: number[];
        timeDeltas?: number[];
      };
    };
    await cdp.detach();
    const cpuByNode = new Map<number, number>();
    for (const [index, nodeId] of (profile.samples ?? []).entries()) {
      cpuByNode.set(nodeId, (cpuByNode.get(nodeId) ?? 0) + Number(profile.timeDeltas?.[index] ?? 0) / 1000);
    }
    const nodeById = new Map(profile.nodes.map(node => [node.id, node]));
    const parentById = new Map<number, number>();
    for (const node of profile.nodes) {
      for (const childId of node.children ?? []) parentById.set(childId, node.id);
    }
    const inclusiveCpuByNode = new Map<number, number>();
    for (const [index, sampleNodeId] of (profile.samples ?? []).entries()) {
      const sampleMs = Number(profile.timeDeltas?.[index] ?? 0) / 1000;
      let nodeId: number | undefined = sampleNodeId;
      while (nodeId !== undefined) {
        inclusiveCpuByNode.set(nodeId, (inclusiveCpuByNode.get(nodeId) ?? 0) + sampleMs);
        nodeId = parentById.get(nodeId);
      }
    }
    const cpuTop = [...cpuByNode]
      .map(([nodeId, selfMs]) => ({ node: nodeById.get(nodeId), selfMs: Math.round(selfMs) }))
      .filter(row => row.node && row.node.callFrame.functionName !== '(idle)')
      .sort((left, right) => right.selfMs - left.selfMs)
      .slice(0, 20)
      .map(row => ({
        functionName: row.node!.callFrame.functionName,
        selfMs: row.selfMs,
        url: row.node!.callFrame.url,
        lineNumber: row.node!.callFrame.lineNumber + 1,
      }));
    const longTasks = await page.evaluate(() =>
      (window as CrossRuntimeWindow & {
        __crossJLongTasks?: Array<{ startTime: number; duration: number; name: string }>;
      }).__crossJLongTasks ?? []);
    console.log(`[E2E-CROSS-J-CPU] ${JSON.stringify(cpuTop)}`);
    const inclusiveCpuTop = [...inclusiveCpuByNode]
      .map(([nodeId, inclusiveMs]) => ({ node: nodeById.get(nodeId), inclusiveMs: Math.round(inclusiveMs) }))
      .filter(row => row.node && !['(root)', '(idle)', '(program)'].includes(row.node.callFrame.functionName))
      .sort((left, right) => right.inclusiveMs - left.inclusiveMs)
      .slice(0, 40)
      .map(row => ({
        functionName: row.node!.callFrame.functionName,
        inclusiveMs: row.inclusiveMs,
        url: row.node!.callFrame.url,
        lineNumber: row.node!.callFrame.lineNumber + 1,
      }));
    console.log(`[E2E-CROSS-J-CPU-INCLUSIVE] ${JSON.stringify(inclusiveCpuTop)}`);
    console.log(`[E2E-CROSS-J-LONG-TASKS] ${JSON.stringify(longTasks.slice(-30))}`);
    const frameTrace = await page.evaluate(() =>
      (window as CrossRuntimeWindow & { __crossJFrameTrace?: unknown[] }).__crossJFrameTrace ?? []);
    console.log(`[E2E-CROSS-J-FRAMES] ${JSON.stringify(frameTrace)}`);

    await timedStep('cross_j_auto_setup.wait_target_account', () =>
      waitForAccountReady(page, target, targetHub.entityId, [USDC], 90_000),
    );
    const expectedTargetAmount = 24_900_000n;
    await expect
      .poll(async () => page.evaluate(({ entityId, hubId, tokenId }) => {
        const env = (window as CrossRuntimeWindow).isolatedEnv;
        const owner = String(entityId).toLowerCase();
        const counterparty = String(hubId).toLowerCase();
        const replica = Array.from(env?.eReplicas?.values?.() || []).find((candidate: any) =>
          String(candidate?.state?.entityId || candidate?.entityId || '').toLowerCase() === owner);
        const account = replica?.state?.accounts?.get?.(counterparty);
        const delta = account?.deltas?.get?.(tokenId);
        if (!account || !delta) return null;
        const ownerIsLeft = owner === String(account.leftEntity || '').toLowerCase();
        return {
          peerCreditLimit: String(ownerIsLeft ? delta.rightCreditLimit : delta.leftCreditLimit),
          inboundHold: String(ownerIsLeft ? delta.rightHold : delta.leftHold),
        };
      }, {
        entityId: target.entityId,
        hubId: targetHub.entityId,
        tokenId: USDC,
      }), {
        timeout: 30_000,
        intervals: [250, 500, 1000],
        message: 'one-click cross swap must grant and lock only the exact target USDC amount',
      })
      .toEqual({
        peerCreditLimit: expectedTargetAmount.toString(),
        inboundHold: expectedTargetAmount.toString(),
      });
    expect(
      await inCap(page, target.entityId, targetHub.entityId, USDC),
      'the exact target credit is fully reserved by the cross-j pull',
    ).toBe(0n);
    expectBrowserConsoleClean(browserConsole, 'cross_j_auto_setup');
  });

  test('cross WETH/USDC ignores non-takeable orderbook side before filling the takeable side', { tag: '@resilience' }, async ({ page }) => {
    const baseline = await timedStep('cross_j_wrong_side.ensure_baseline', () => ensureE2EBaseline(page, {
      apiBaseUrl: API_BASE_URL,
      requireMarketMaker: false,
      requireHubMesh: true,
      minHubCount: 3,
    }));
    const hubId = getPrimaryHubId(baseline);
    const primaryHubApiBaseUrl = getPrimaryHubApiBaseUrl(baseline, hubId);
    const primaryHubName = getPrimaryHubName(baseline, hubId);
    const targetHub = await timedStep('cross_j_wrong_side.resolve_rpc2_hub', () =>
      getSecondaryHubInfo(page, hubId, primaryHubName, primaryHubApiBaseUrl),
    );

    await timedStep('cross_j_wrong_side.goto', () => gotoApp(page, { appBaseUrl: APP_BASE_URL, initTimeoutMs: INIT_TIMEOUT, settleMs: 1200 }));
    const mnemonic = Wallet.createRandom().mnemonic!.phrase;
    const source = await timedStep('cross_j_wrong_side.create_runtime', () =>
      createRuntimeIdentityViaStore(page, 'cross-wrong-side', mnemonic),
    );
    await timedStep('cross_j_wrong_side.default_jurisdictions', () => waitForDefaultJurisdictionReplicas(page, 'cross-wrong-side'));
    const target = await timedStep('cross_j_wrong_side.import_rpc2_sibling', () =>
      importRpc2SiblingEntity(page, mnemonic, 'cross-wrong-side'),
    );
    await timedStep('cross_j_wrong_side.connect_primary', () =>
      connectRuntimeToHubWithCredit(page, source, hubId, '10000', SWAP_TOKENS),
    );
    await timedStep('cross_j_wrong_side.connect_rpc2', () =>
      ensureDirectHubAccount(page, target, targetHub.entityId, SWAP_TOKENS, 150_000),
    );
    await timedStep('cross_j_wrong_side.faucet_source_weth', () =>
      faucetOffchain(page, primaryHubApiBaseUrl, source.entityId, hubId, WETH, '1'),
    );
    await timedStep('cross_j_wrong_side.wait_source_weth', () =>
      waitForOutCapAtLeast(page, source.entityId, hubId, WETH, 1n * 10n ** 16n),
    );

    await timedStep('cross_j_wrong_side.install_synthetic_relay', () =>
      installSilentRelayWebSocket(page, {
        currentPage: true,
        marketSnapshots: [{
          bids: [{ price: '24900000', size: 1000 }],
          asks: [{ price: '25100000', size: 1000 }],
        }],
      }),
    );
    await timedStep('cross_j_wrong_side.open_swap', async () => {
      await openSwapWorkspace(page);
      await selectSourceChainInSwap(page, source.entityId);
      await selectCounterpartyInSwap(page, hubId);
      await configurePair(page, 'sell');
      await selectCrossRoute(page, target.entityId);
    });

    await expectCrossOrderbookReady(page);
    await expectSwapTokens(page, WETH, USDC);
    await expectDirectCrossOrderbookReady(page);
    await expectCrossOrderbookReady(page);
    await expectSwapTokens(page, WETH, USDC);
    await expect(visibleOrderbookRow(page, 'ask'), 'synthetic cross book must show a non-takeable ask').toBeVisible({ timeout: 10_000 });
    await expect(visibleOrderbookRow(page, 'bid'), 'synthetic cross book must show a takeable bid').toBeVisible({ timeout: 10_000 });

    await expectCrossNonTakeableClickNoop(page, 'ask', WETH, USDC);
    await clickCrossOrderbookLevel(page, 'bid', WETH, USDC);
  });

  test('cross WETH/USDT displays prices as stable quote per WETH for Tron source', { tag: '@functional' }, async ({ page }) => {
    const baseline = await timedStep('cross_j_stable_quote.ensure_baseline', () => ensureE2EBaseline(page, {
      apiBaseUrl: API_BASE_URL,
      requireMarketMaker: false,
      requireHubMesh: true,
      minHubCount: 3,
    }));
    const testnetHubId = getPrimaryHubId(baseline);
    const primaryHubApiBaseUrl = getPrimaryHubApiBaseUrl(baseline, testnetHubId);
    const primaryHubName = getPrimaryHubName(baseline, testnetHubId);
    const tronHub = await timedStep('cross_j_stable_quote.resolve_rpc2_hub', () =>
      getSecondaryHubInfo(page, testnetHubId, primaryHubName, primaryHubApiBaseUrl),
    );

    await timedStep('cross_j_stable_quote.goto', () => gotoApp(page, { appBaseUrl: APP_BASE_URL, initTimeoutMs: INIT_TIMEOUT, settleMs: 1200 }));
    const mnemonic = Wallet.createRandom().mnemonic!.phrase;
    const testnetEntity = await timedStep('cross_j_stable_quote.create_runtime', () =>
      createRuntimeIdentityViaStore(page, 'cross-stable-quote', mnemonic),
    );
    await timedStep('cross_j_stable_quote.default_jurisdictions', () => waitForDefaultJurisdictionReplicas(page, 'cross-stable-quote'));
    const tronEntity = await timedStep('cross_j_stable_quote.import_rpc2_sibling', () =>
      importRpc2SiblingEntity(page, mnemonic, 'cross-stable-quote'),
    );
    await timedStep('cross_j_stable_quote.connect_testnet', () =>
      connectRuntimeToHubWithCredit(page, testnetEntity, testnetHubId, '10000', SWAP_TOKENS),
    );
    await timedStep('cross_j_stable_quote.connect_tron', () =>
      ensureDirectHubAccount(page, tronEntity, tronHub.entityId, SWAP_TOKENS, 150_000),
    );

    await timedStep('cross_j_stable_quote.install_synthetic_relay', () =>
      installSilentRelayWebSocket(page, {
        currentPage: true,
        marketSnapshots: [{
          bids: [{ price: '25000000', size: 1000 }],
          asks: [{ price: '25100000', size: 1000 }],
        }],
      }),
    );
    await timedStep('cross_j_stable_quote.open_swap', async () => {
      await openSwapWorkspace(page);
      await selectSourceChainInSwap(page, tronEntity.entityId);
      await selectCounterpartyInSwap(page, tronHub.entityId);
      await configureTokens(page, WETH, USDT);
      await selectCrossRoute(page, testnetEntity.entityId);
    });

    await expectCrossOrderbookReady(page, {
      titlePattern: /WETH\s*\(Tron\)\s*-\s*USDT\s*\(Testnet\)/,
      pairIdPattern: /^cross:stack:31338:[^/]+:2\/stack:31337:[^/]+:3$/,
    });
    const tokenOptions = await page.evaluate(() => {
      const optionTexts = (selector: string) => Array.from(document.querySelectorAll(`${selector} option`))
        .map((option) => String((option as HTMLOptionElement).textContent || '').trim())
        .filter(Boolean);
      return {
        from: optionTexts('[data-testid="swap-from-token-select"]'),
        to: optionTexts('[data-testid="swap-to-token-select"]'),
      };
    });
    expect(tokenOptions.from, 'Tron source token list must expose Tron-only assets').toEqual(
      expect.arrayContaining(['TRX (Tron)', 'SUN (Tron)']),
    );
    expect(
      tokenOptions.to.some((label) => /^(TRX|SUN)(?:\s|\(|$)/.test(label)),
      'Testnet target token list must not leak Tron-only assets',
    ).toBe(false);
    await expect(
      page.getByTestId('orderbook-bid-row').first().locator('.price'),
      'cross WETH/USDT price must be displayed as USDT per WETH, not inverted WETH per USDT',
    ).toHaveText('2500.0000', { timeout: 10_000 });
    await expectSwapTokens(page, WETH, USDT);

    const dropdownPairLabel = await selectOrderbookPairByLabel(page, /USDT\s*\(Testnet\)\s*-\s*USDT\s*\(Tron\)/i);
    expect(dropdownPairLabel).toMatch(/USDT\s*\(Testnet\)\s*-\s*USDT\s*\(Tron\)/i);
    const marketSection = page.getByTestId('swap-market-section').first();
    await expect
      .poll(async () => ({
        mode: String(await marketSection.getAttribute('data-last-orderbook-pair-select-mode') || ''),
        commit: String(await marketSection.getAttribute('data-last-orderbook-pair-select-commit') || ''),
        route: String(await marketSection.getAttribute('data-last-orderbook-pair-select-route') || ''),
        value: String(await marketSection.getAttribute('data-last-orderbook-pair-select-value') || ''),
      }), {
        timeout: 5_000,
        intervals: [50, 100, 200],
        message: 'cross orderbook dropdown must commit the selected cross pair',
      })
      .toMatchObject({ mode: 'cross', commit: 'cross-committed' });
    await expectSwapTokens(page, USDT, USDT);
    const panel = page.getByTestId('swap-orderbook').first().locator('.orderbook-panel').first();
    await expect
      .poll(async () => String(await panel.getAttribute('data-pair-id') || ''), {
        timeout: 10_000,
        intervals: [100, 250, 500],
        message: 'cross orderbook dropdown must switch the subscribed venue id',
      })
      .toMatch(/^cross:stack:31337:[^/]+:3\/stack:31338:[^/]+:3$/);
    await expectSwapAssetRoute(page, USDT, 'Tron', USDT, 'Testnet');

    await timedStep('cross_j_stable_quote.reverse_same_symbol_asset_identity', async () => {
      await page.getByTestId('swap-flip-tokens').first().click();
    });
    await expectSwapAssetRoute(page, USDT, 'Testnet', USDT, 'Tron');
    await expectCrossOrderbookReady(page, {
      titlePattern: /USDT\s*\(Testnet\)\s*-\s*USDT\s*\(Tron\)/,
      pairIdPattern: /^cross:stack:31337:[^/]+:3\/stack:31338:[^/]+:3$/,
    });

    await timedStep('cross_j_stable_quote.restore_original_cross_direction', async () => {
      await page.getByTestId('swap-flip-tokens').first().click();
    });
    await expectSwapAssetRoute(page, USDT, 'Tron', USDT, 'Testnet');

    await timedStep('cross_j_stable_quote.configure_reverse_stable_source', async () => {
      await configureTokens(page, USDT, WETH);
      await selectCrossRoute(page, testnetEntity.entityId);
    });
    await expectCrossOrderbookReady(page, {
      titlePattern: /WETH\s*\(Testnet\)\s*-\s*USDT\s*\(Tron\)/,
      pairIdPattern: /^cross:stack:31337:[^/]+:2\/stack:31338:[^/]+:3$/,
    });
    await expect(
      page.getByTestId('orderbook-bid-row').first().locator('.price'),
      'cross USDT/WETH must still display stable quote per WETH, not inverted WETH per USDT',
    ).toHaveText('2500.0000', { timeout: 10_000 });
    await expectSwapTokens(page, USDT, WETH);
  });

  test('two users can place full, partial, and disputed cross-j swaps through the shared swap builder', { tag: '@resilience' }, async ({ browser, page }) => {
    let aliceContext: BrowserContext | null = null;
    let bobContext: BrowserContext | null = null;

    try {
      const baseline = await timedStep('cross_j_swap.ensure_baseline', () => ensureE2EBaseline(page, {
        apiBaseUrl: API_BASE_URL,
        requireMarketMaker: false,
        requireHubMesh: true,
        minHubCount: 3,
      }));
      const hubId = getPrimaryHubId(baseline);
      const primaryHubApiBaseUrl = getPrimaryHubApiBaseUrl(baseline, hubId);
      const primaryHubName = getPrimaryHubName(baseline, hubId);
      const primaryHubRuntimeSeed = getIsolatedHubRuntimeSeed(primaryHubName);
      const targetHub = await timedStep('cross_j_swap.resolve_rpc2_hub', () =>
        getSecondaryHubInfo(page, hubId, primaryHubName, primaryHubApiBaseUrl),
      );
      const targetHubId = targetHub.entityId;

      aliceContext = await browser.newContext({ ignoreHTTPSErrors: true });
      bobContext = await browser.newContext({ ignoreHTTPSErrors: true });
      const alicePage = await aliceContext.newPage();
      const bobPage = await bobContext.newPage();

      await Promise.all([
        timedStep('cross_j_swap.alice.goto', () => gotoApp(alicePage, { appBaseUrl: APP_BASE_URL, initTimeoutMs: INIT_TIMEOUT, settleMs: 1200 })),
        timedStep('cross_j_swap.bob.goto', () => gotoApp(bobPage, { appBaseUrl: APP_BASE_URL, initTimeoutMs: INIT_TIMEOUT, settleMs: 1200 })),
      ]);

      // Cross-j tests reset the hub mesh aggressively. Reusing demo mnemonics
      // reuses runtimeId/entityId, so a fresh browser can accidentally pair a
      // local restored account with a reset hub or receive stale relay frames.
      // New mnemonics keep every run in a distinct bilateral namespace.
      const aliceMnemonic = Wallet.createRandom().mnemonic!.phrase;
      const bobMnemonic = Wallet.createRandom().mnemonic!.phrase;
      const alice = await timedStep('cross_j_swap.alice.create_runtime', () => createRuntimeIdentityViaStore(alicePage, 'alice-cross', aliceMnemonic));
      const bob = await timedStep('cross_j_swap.bob.create_runtime', () => createRuntimeIdentityViaStore(bobPage, 'bob-cross', bobMnemonic));
      await Promise.all([
        timedStep('cross_j_swap.alice.default_jurisdictions', () => waitForDefaultJurisdictionReplicas(alicePage, 'alice')),
        timedStep('cross_j_swap.bob.default_jurisdictions', () => waitForDefaultJurisdictionReplicas(bobPage, 'bob')),
      ]);

      const [aliceRpc2, bobRpc2] = await Promise.all([
        timedStep('cross_j_swap.alice.import_rpc2_sibling', () => importRpc2SiblingEntity(alicePage, aliceMnemonic, 'alice')),
        timedStep('cross_j_swap.bob.import_rpc2_sibling', () => importRpc2SiblingEntity(bobPage, bobMnemonic, 'bob')),
      ]);

      await Promise.all([
        timedStep('cross_j_swap.alice.connect_primary', () => connectRuntimeToHubWithCredit(alicePage, alice, hubId, '10000', SWAP_TOKENS)),
        timedStep('cross_j_swap.bob.connect_primary', () => connectRuntimeToHubWithCredit(bobPage, bob, hubId, '10000', SWAP_TOKENS)),
      ]);
      await Promise.all([
        timedStep('cross_j_swap.alice.connect_rpc2', () => ensureDirectHubAccount(alicePage, aliceRpc2, targetHubId, SWAP_TOKENS, 150_000)),
        timedStep('cross_j_swap.bob.connect_rpc2', () => ensureDirectHubAccount(bobPage, bobRpc2, targetHubId, SWAP_TOKENS, 150_000)),
      ]);

      await Promise.all([
        faucetOffchain(alicePage, primaryHubApiBaseUrl, alice.entityId, hubId, WETH, '1'),
        faucetOffchain(alicePage, primaryHubApiBaseUrl, alice.entityId, hubId, USDT, '100'),
        faucetOffchain(bobPage, primaryHubApiBaseUrl, bobRpc2.entityId, targetHubId, USDC, '200'),
        faucetOffchain(bobPage, primaryHubApiBaseUrl, bobRpc2.entityId, targetHubId, USDT, '100'),
      ]);
      await Promise.all([
        waitForOutCapAtLeast(alicePage, alice.entityId, hubId, WETH, tokenAmount(WETH, 3n) / 100n),
        waitForOutCapAtLeast(alicePage, alice.entityId, hubId, USDT, tokenAmount(USDT, 25n)),
        waitForOutCapAtLeast(bobPage, bobRpc2.entityId, targetHubId, USDC, tokenAmount(USDC, 78n)),
        waitForOutCapAtLeast(bobPage, bobRpc2.entityId, targetHubId, USDT, tokenAmount(USDT, 25n)),
      ]);

      const aliceUsdtOrderId = await timedStep('cross_j_swap.usdt.alice_eth_to_tron_offer', () => placeCrossOrder(alicePage, {
        source: alice,
        hubId,
        targetEntityId: aliceRpc2.entityId,
        side: 'sell',
        fromTokenId: USDT,
        toTokenId: USDT,
        amount: '25',
        price: '1',
      }));
      const bobUsdtOrderId = await timedStep('cross_j_swap.usdt.bob_tron_to_eth_offer', () => placeCrossOrder(bobPage, {
        source: bobRpc2,
        hubId: targetHubId,
        targetEntityId: bob.entityId,
        side: 'sell',
        fromTokenId: USDT,
        toTokenId: USDT,
        clickBookSide: 'ask',
        expectedClickFromTokenId: USDT,
        expectedClickToTokenId: USDT,
        amount: '25',
        price: '1',
      }));
      await Promise.all([
        waitForCrossPullFlow(alicePage, alice, aliceRpc2, hubId, targetHubId, {
          sourceRouteId: aliceUsdtOrderId,
          targetRouteId: aliceUsdtOrderId,
        }),
        waitForCrossPullFlow(bobPage, bobRpc2, bob, targetHubId, hubId, {
          sourceRouteId: bobUsdtOrderId,
          targetRouteId: bobUsdtOrderId,
        }),
      ]);
      await Promise.all([
        waitForCrossOffersCleared(alicePage, alice, hubId, 'Alice USDT/USDT', { orderId: aliceUsdtOrderId }),
        waitForCrossOffersCleared(bobPage, bobRpc2, targetHubId, 'Bob USDT/USDT', { orderId: bobUsdtOrderId }),
      ]);

      const aliceFullOrderId = await timedStep('cross_j_swap.full.alice_offer', () => placeCrossOrder(alicePage, {
        source: alice,
        hubId,
        targetEntityId: aliceRpc2.entityId,
        side: 'sell',
        checkMultihopDeferred: true,
        amount: '0.03',
        price: '2500',
      }));
      const bobFullOrderId = await timedStep('cross_j_swap.full.bob_offer', () => placeCrossOrder(bobPage, {
        source: bobRpc2,
        hubId: targetHubId,
        targetEntityId: bob.entityId,
        side: 'buy',
        clickBookSide: 'ask',
        amount: '78',
        price: '2600',
      }));

      await Promise.all([
        waitForCrossPullFlow(alicePage, alice, aliceRpc2, hubId, targetHubId, {
          sourceRouteId: aliceFullOrderId,
          targetRouteId: aliceFullOrderId,
        }),
        waitForCrossPullFlow(bobPage, bobRpc2, bob, targetHubId, hubId, {
          sourceRouteId: bobFullOrderId,
          targetRouteId: bobFullOrderId,
        }),
      ]);

      await Promise.all([
        waitForCrossOffersCleared(alicePage, alice, hubId, 'Alice full', { orderId: aliceFullOrderId }),
        waitForCrossOffersCleared(bobPage, bobRpc2, targetHubId, 'Bob full', { orderId: bobFullOrderId }),
      ]);
      const bobFullResolve = await timedStep('cross_j_swap.full.bob_price_improvement', () =>
        waitForLatestCrossResolveSnapshot(bobPage, bobRpc2.entityId, targetHubId, 1),
      );
      expect(bobFullResolve.fillRatio, 'Bob source-savings fill must consume the full target ratio').toBe(65_535);
      expect(bobFullResolve.cancelRemainder, 'Bob source-savings terminal fill must remove the terminal order').toBe(true);
      expect(bobFullResolve.executionGiveAmount, 'Bob spends the improved execution source, not his 78 USDC limit').toBe(tokenAmount(USDC, 75n).toString());
      expect(bobFullResolve.executionWantAmount, 'Bob receives exactly the committed 0.03 WETH target').toBe((tokenAmount(WETH, 3n) / 100n).toString());

      await Promise.all([
        waitForOutCapAtLeast(alicePage, aliceRpc2.entityId, targetHubId, USDC, tokenAmount(USDC, 25n)),
        waitForOutCapAtLeast(bobPage, bob.entityId, hubId, WETH, tokenAmount(WETH, 1n) / 100n),
      ]);
      const aliceReverseOrderId = await timedStep('cross_j_swap.reverse.alice_offer', () => placeCrossOrder(alicePage, {
        source: aliceRpc2,
        hubId: targetHubId,
        targetEntityId: alice.entityId,
        side: 'buy',
        amount: '25',
        price: '2500',
      }));
      const bobReverseOrderId = await timedStep('cross_j_swap.reverse.bob_offer', () => placeCrossOrder(bobPage, {
        source: bob,
        hubId,
        targetEntityId: bobRpc2.entityId,
        side: 'sell',
        clickBookSide: 'bid',
        amount: '0.01',
        price: '2500',
      }));
      await Promise.all([
        waitForCrossPullFlow(alicePage, aliceRpc2, alice, targetHubId, hubId, {
          sourceRouteId: aliceReverseOrderId,
          targetRouteId: aliceReverseOrderId,
        }),
        waitForCrossPullFlow(bobPage, bob, bobRpc2, hubId, targetHubId, {
          sourceRouteId: bobReverseOrderId,
          targetRouteId: bobReverseOrderId,
        }),
      ]);
      await Promise.all([
        waitForCrossOffersCleared(alicePage, aliceRpc2, targetHubId, 'Alice reverse', { orderId: aliceReverseOrderId }),
        waitForCrossOffersCleared(bobPage, bob, hubId, 'Bob reverse', { orderId: bobReverseOrderId }),
      ]);

      await Promise.all([
        faucetOffchain(alicePage, primaryHubApiBaseUrl, alice.entityId, hubId, WETH, '1'),
        faucetOffchain(bobPage, primaryHubApiBaseUrl, bobRpc2.entityId, targetHubId, USDC, '100'),
      ]);
      await Promise.all([
        waitForOutCapAtLeast(alicePage, alice.entityId, hubId, WETH, tokenAmount(WETH, 6n) / 100n),
        waitForOutCapAtLeast(bobPage, bobRpc2.entityId, targetHubId, USDC, tokenAmount(USDC, 75n)),
      ]);

      const alicePartialOrderId = await timedStep('cross_j_swap.partial.alice_offer', () => placeCrossOrder(alicePage, {
        source: alice,
        hubId,
        targetEntityId: aliceRpc2.entityId,
        side: 'sell',
        amount: '0.04',
        price: '2500',
      }));
      const bobPartialFirstOrderId = await timedStep('cross_j_swap.partial.bob_offer', () => placeCrossOrder(bobPage, {
        source: bobRpc2,
        hubId: targetHubId,
        targetEntityId: bob.entityId,
        side: 'buy',
        clickBookSide: 'ask',
        amount: '25',
        price: '2500',
      }));

      const [aliceFirstPartial] = await Promise.all([
        timedStep('cross_j_swap.partial.alice_pending_fill', () =>
          waitForCrossPendingFill(alicePage, alice, hubId, 'Alice partial', { routeId: alicePartialOrderId }),
        ),
        timedStep('cross_j_swap.partial.bob_first_cleared', () =>
          waitForCrossOffersCleared(bobPage, bobRpc2, targetHubId, 'Bob first partial counter-order', { orderId: bobPartialFirstOrderId }),
        ),
      ]);

      const bobPartialSecondOrderId = await timedStep('cross_j_swap.partial.bob_second_offer', () => placeCrossOrder(bobPage, {
        source: bobRpc2,
        hubId: targetHubId,
        targetEntityId: bob.entityId,
        side: 'buy',
        clickBookSide: 'ask',
        amount: '25',
        price: '2500',
      }));

      const aliceSecondPartial = await timedStep('cross_j_swap.partial.alice_second_pending_fill', () =>
        waitForCrossPendingFill(alicePage, alice, hubId, 'Alice second partial', {
          routeId: aliceFirstPartial.routeId,
          minFillSeq: aliceFirstPartial.fillSeq + 1,
          minRatioExclusive: aliceFirstPartial.ratio,
        }),
      );
      expect(aliceSecondPartial.routeId).toBe(aliceFirstPartial.routeId);
      expect(aliceSecondPartial.ratio).toBeGreaterThan(aliceFirstPartial.ratio);

      await timedStep('cross_j_swap.partial.bob_second_cleared', () =>
        waitForCrossOffersCleared(bobPage, bobRpc2, targetHubId, 'Bob second partial counter-order', { orderId: bobPartialSecondOrderId }),
      );

      await timedStep('cross_j_swap.partial.alice_cancel_clear_button', async () => {
        const beforeClear = await readCrossState(alicePage, alice, hubId);
        expect(beforeClear.pulls, 'Alice partial source pull must be locked before Clear + Close').toBeGreaterThan(0);
        const clearButton = alicePage.getByTestId('cross-swap-clear').first();
        await expect(clearButton).toBeVisible({ timeout: 20_000 });
        await clearButton.click({ force: true });
        await flushRuntime(alicePage, 5);
      });

      await Promise.all([
        timedStep('cross_j_swap.partial.alice_source_claimed', () =>
          waitForCrossRouteStatus(alicePage, alice, hubId, aliceSecondPartial.routeId, ['source_claimed', 'settled'], 'Alice source clear'),
        ),
        timedStep('cross_j_swap.partial.alice_target_settled', () =>
          waitForCrossRouteStatus(alicePage, aliceRpc2, targetHubId, aliceSecondPartial.routeId, ['settled'], 'Alice target clear'),
        ),
      ]);
      await timedStep('cross_j_swap.partial.alice_remainder_removed', () =>
        waitForCrossOffersCleared(alicePage, alice, hubId, 'Alice partial cancel-clear', { orderId: aliceSecondPartial.routeId }),
      );
      await timedStep('cross_j_swap.partial.alice_source_remainder_released', () =>
        expect.poll(async () => {
          await flushRuntime(alicePage, 3);
          const state = await readCrossState(alicePage, alice, hubId);
          return {
            pulls: state.pulls,
            hasPendingFrame: state.hasPendingFrame,
            mempoolTxs: state.mempoolTxs,
          };
        }, {
          timeout: 45_000,
          intervals: [250, 500, 1000],
          message: 'Alice partial Clear + Close must release the source pull remainder',
        }).toMatchObject({ pulls: 0, hasPendingFrame: false, mempoolTxs: [] }),
      );
      await timedStep('cross_j_swap.partial.alice_target_remainder_released', () =>
        expect.poll(async () => {
          await flushRuntime(alicePage, 3);
          const state = await readCrossState(alicePage, aliceRpc2, targetHubId);
          return {
            pulls: state.pulls,
            hasPendingFrame: state.hasPendingFrame,
            mempoolTxs: state.mempoolTxs,
          };
        }, {
          timeout: 45_000,
          intervals: [250, 500, 1000],
          message: 'Alice partial Clear + Close must release the target pull remainder',
        }).toMatchObject({ pulls: 0, hasPendingFrame: false, mempoolTxs: [] }),
      );

      const aliceDisputeOrderId = await timedStep('cross_j_swap.dispute.alice_offer', () => placeCrossOrder(alicePage, {
        source: alice,
        hubId,
        targetEntityId: aliceRpc2.entityId,
        side: 'sell',
        amount: '0.04',
        price: '2500',
      }));
      const bobDisputeOrderId = await timedStep('cross_j_swap.dispute.bob_offer', () => placeCrossOrder(bobPage, {
        source: bobRpc2,
        hubId: targetHubId,
        targetEntityId: bob.entityId,
        side: 'buy',
        clickBookSide: 'ask',
        amount: '25',
        price: '2500',
      }));

      const [aliceDisputePartial] = await Promise.all([
        timedStep('cross_j_swap.dispute.alice_pending_fill', () =>
          waitForCrossPendingFill(alicePage, alice, hubId, 'Alice dispute route', { routeId: aliceDisputeOrderId }),
        ),
        timedStep('cross_j_swap.dispute.bob_cleared', () =>
          waitForCrossOffersCleared(bobPage, bobRpc2, targetHubId, 'Bob dispute counter-order', { orderId: bobDisputeOrderId }),
        ),
      ]);

      // Bob can disappear after submitting the counter-order. Dispute salvage is driven by
      // Alice/source+target sibling state and must not require the counterparty browser.
      await bobContext.close();
      bobContext = null;

      await timedStep('cross_j_swap.dispute.target_route_ready', () =>
        waitForCrossRouteMaterialized(alicePage, aliceRpc2, targetHubId, aliceDisputePartial.routeId, 'Alice target dispute sibling'),
      );

      await timedStep('cross_j_swap.dispute.source_args', () =>
        triggerSourceDisputeArguments(alicePage, alice, hubId, aliceDisputePartial.routeId, primaryHubRuntimeSeed),
      );
      await timedStep('cross_j_swap.dispute.source_routed', () =>
        waitForCrossDisputeRouted(alicePage, alice, hubId, aliceDisputePartial.routeId),
      );
      await timedStep('cross_j_swap.dispute.target_salvage', () =>
        waitForCrossSalvageQueued(alicePage, aliceRpc2, targetHubId, aliceDisputePartial.routeId),
      );
    } finally {
      await Promise.all([
        aliceContext ? aliceContext.close().catch(() => {}) : Promise.resolve(),
        bobContext ? bobContext.close().catch(() => {}) : Promise.resolve(),
      ]);
    }
  });
});
