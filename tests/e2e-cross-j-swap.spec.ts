import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { AbiCoder, HDNodeWallet, Mnemonic, getIndexedAccountPath, keccak256, toUtf8Bytes } from 'ethers';
import { deriveDelta } from '../runtime/account-utils';
import { ensureE2EBaseline, type E2EHealthResponse } from './utils/e2e-baseline';
import { connectRuntimeToHubWithCredit } from './utils/e2e-connect';
import { gotoApp, selectDemoMnemonic } from './utils/e2e-demo-users';
import { enqueueEntityTxs } from './utils/e2e-runtime-input';
import { requireIsolatedBaseUrl } from './utils/e2e-isolated-env';
import { timedStep } from './utils/e2e-timing';

const INIT_TIMEOUT = 30_000;
const APP_BASE_URL = requireIsolatedBaseUrl('E2E_BASE_URL');
const API_BASE_URL = requireIsolatedBaseUrl('E2E_API_BASE_URL');
const SWAP_TOKENS = [1, 2] as const;
const CREDIT_AMOUNT = 10_000n * 10n ** 18n;
const USDC = 1;
const WETH = 2;

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
  event: unknown;
  blockNumber: number;
  blockHash: string;
  transactionHash: string;
};

type CrossRuntimeWindow = Window & {
  isolatedEnv?: {
    runtimeId?: string;
    eReplicas?: Map<string, any>;
    jReplicas?: Map<string, any>;
  };
  XLN?: any;
  __xln_instance?: any;
};

type CrossResolveSnapshot = {
  offerId: string;
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

async function signSyntheticJEventObservation(
  page: Page,
  identity: RuntimeIdentity,
  input: SyntheticJEventInput,
): Promise<{ eventsHash: string; signature: string }> {
  return page.evaluate(async ({ identity, input }) => {
    const view = window as CrossRuntimeWindow;
    const env = view.isolatedEnv;
    if (!env) throw new Error('isolatedEnv missing');
    const runtimeModule = view.XLN
      ?? view.__xln_instance
      ?? await import(/* @vite-ignore */ new URL('/runtime.js', window.location.origin).href) as any;
    view.XLN = runtimeModule;
    view.__xln_instance = runtimeModule;
    if (typeof runtimeModule.canonicalJurisdictionEventsHash !== 'function') {
      throw new Error('canonicalJurisdictionEventsHash missing from runtime bundle');
    }
    if (typeof runtimeModule.buildJEventObservationDigest !== 'function') {
      throw new Error('buildJEventObservationDigest missing from runtime bundle');
    }
    if (typeof runtimeModule.signAccountFrame !== 'function') {
      throw new Error('signAccountFrame missing from runtime bundle');
    }

    const eventsHash = runtimeModule.canonicalJurisdictionEventsHash([input.event]);
    const digest = runtimeModule.buildJEventObservationDigest({
      entityId: identity.entityId,
      signerId: identity.signerId,
      blockNumber: input.blockNumber,
      blockHash: input.blockHash,
      transactionHash: input.transactionHash,
      eventsHash,
    });
    return {
      eventsHash,
      signature: runtimeModule.signAccountFrame(env, identity.signerId, digest),
    };
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
    if (!rpc || !contracts.depository || !contracts.entityProvider) {
      throw new Error(`rpc2 jurisdiction incomplete: ${JSON.stringify(jurisdictionRaw)}`);
    }

    const runtimeModule = view.XLN
      ?? view.__xln_instance
      ?? await import(/* @vite-ignore */ new URL('/runtime.js', window.location.origin).href) as any;
    view.XLN = runtimeModule;
    view.__xln_instance = runtimeModule;

    if (!env.jReplicas?.has(jurisdictionName)) {
      runtimeModule.enqueueRuntimeInput(env, {
        runtimeTxs: [{
          type: 'importJ',
          data: {
            name: jurisdictionName,
            chainId: Number(jurisdictionRaw.chainId || 31338),
            ticker: String(jurisdictionRaw.currency || 'TRX'),
            rpcs: [rpc],
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
        depositoryAddress: String(contracts.depository),
        entityProviderAddress: String(contracts.entityProvider),
      },
    };
  }, { mnemonic, label });

  await expect.poll(
    async () => page.evaluate((jurisdictionName) => {
      const env = (window as CrossRuntimeWindow).isolatedEnv;
      return Boolean(env?.jReplicas?.has(jurisdictionName));
    }, result.jurisdictionName),
    {
      timeout: 60_000,
      intervals: [250, 500, 1000],
      message: `${label} runtime must import rpc2 jurisdiction`,
    },
  ).toBe(true);

  const signer = deriveSigner(mnemonic, result.jurisdictionName);
  const sibling = await page.evaluate(async ({ signer, label, jurisdiction }) => {
    const view = window as CrossRuntimeWindow;
    const env = view.isolatedEnv;
    if (!env) throw new Error('isolatedEnv missing');
    const runtimeModule = view.XLN
      ?? view.__xln_instance
      ?? await import(/* @vite-ignore */ new URL('/runtime.js', window.location.origin).href) as any;
    view.XLN = runtimeModule;
    view.__xln_instance = runtimeModule;
    const privateKeyBytes = new Uint8Array(
      signer.privateKey.slice(2).match(/.{2}/g).map((byte: string) => Number.parseInt(byte, 16)),
    );
    runtimeModule.registerSignerKey(signer.address, privateKeyBytes);
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
      const account = replica?.state?.accounts?.get(hubId);
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
        XLN?: { refreshGossip?: (env: unknown) => void };
        p2p?: { refreshGossip?: () => void };
      };
      const env = view.isolatedEnv;
      view.XLN?.refreshGossip?.(env);
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
    const runtimeModule = view.XLN
      ?? view.__xln_instance
      ?? await import(/* @vite-ignore */ new URL('/runtime.js', window.location.origin).href) as {
        process?: (env: unknown, inputs?: unknown[], runtimeDelay?: number) => Promise<unknown>;
      };
    view.XLN = runtimeModule;
    view.__xln_instance = runtimeModule;
    if (typeof runtimeModule.process !== 'function') return;
    for (let index = 0; index < Math.max(1, Number(roundsToRun) || 1); index += 1) {
      await runtimeModule.process(env, [], 0);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    try {
      const runtimeStore = await import(/* @vite-ignore */ new URL('/src/lib/stores/runtimeStore.ts', window.location.origin).href);
      runtimeStore.runtimeOperations?.updateLocalEnv?.(env as never);
    } catch {
      // Dev-only e2e synchronization; the app store may not be importable in every build mode.
    }
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
        creditAmount: CREDIT_AMOUNT,
      },
    }]);
    await flushRuntime(page, 8);
  }
  await waitForAccountReady(page, identity, hubId, [USDC], timeoutMs);

  for (const tokenId of tokenIds) {
    const hasToken = await page.evaluate(({ identity, hubId, tokenId }) => {
      const env = (window as CrossRuntimeWindow).isolatedEnv;
      const replica = env?.eReplicas?.get(`${identity.entityId}:${identity.signerId}`.toLowerCase());
      const account = replica?.state?.accounts?.get(hubId);
      return Boolean(account?.deltas instanceof Map && account.deltas.has(tokenId));
    }, { identity, hubId, tokenId });
    if (hasToken) continue;
    await enqueueEntityTxs(page, identity.entityId, identity.signerId, [{
      type: 'extendCredit',
      data: {
        counterpartyEntityId: hubId,
        tokenId,
        amount: CREDIT_AMOUNT,
      },
    }]);
    await flushRuntime(page, 8);
    await waitForAccountReady(page, identity, hubId, [tokenId], timeoutMs);
  }
}

async function waitForDefaultJurisdictionReplicas(page: Page, label: string): Promise<void> {
  await expect.poll(
    async () => page.evaluate(() => {
      const env = (window as CrossRuntimeWindow).isolatedEnv;
      const jurisdictions = Array.from(env?.jReplicas?.keys?.() || []).map((name) => String(name));
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
  const runtimeId = await page.evaluate(async ({ label, mnemonic }) => {
    const ops = (window as typeof window & {
      __xlnVaultOperations?: {
        createRuntime?: (name: string, seed: string, options?: Record<string, unknown>) => Promise<{ id?: string }>;
      };
    }).__xlnVaultOperations;
    if (typeof ops?.createRuntime !== 'function') {
      throw new Error('__xlnVaultOperations.createRuntime unavailable');
    }
    const runtime = await ops.createRuntime(label, mnemonic, {
      loginType: 'manual',
      requiresOnboarding: false,
      mnemonic12: undefined,
    });
    return String(runtime?.id || '');
  }, { label, mnemonic: normalizedMnemonic });
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
  expect(response.ok(), `offchain faucet failed: ${response.status()} ${await response.text().catch(() => '')}`).toBe(true);
}

async function outCap(page: Page, entityId: string, counterpartyId: string, tokenId: number): Promise<bigint> {
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
  }, normalizeId(entityId) < normalizeId(counterpartyId)).outCapacity;
}

async function waitForOutCapAtLeast(
  page: Page,
  entityId: string,
  counterpartyId: string,
  tokenId: number,
  minimum: bigint,
): Promise<void> {
  await expect.poll(
    async () => (await outCap(page, entityId, counterpartyId, tokenId)) >= minimum,
    {
      timeout: 45_000,
      intervals: [250, 500, 1000],
      message: `${entityId.slice(0, 10)} outCap token=${tokenId} must reach ${minimum}`,
    },
  ).toBe(true);
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

async function openSwapWorkspace(page: Page): Promise<void> {
  const accountsTab = page.getByTestId('tab-accounts').first();
  await expect(accountsTab).toBeVisible({ timeout: 20_000 });
  await accountsTab.click();
  const swapTab = page.getByTestId('account-workspace-tab-swap').first();
  await expect(swapTab).toBeVisible({ timeout: 20_000 });
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
  const fromTokenSelect = page.getByTestId('swap-from-token-select').first();
  const toTokenSelect = page.getByTestId('swap-to-token-select').first();
  await expect(fromTokenSelect).toBeVisible({ timeout: 20_000 });
  await expect(toTokenSelect).toBeVisible({ timeout: 20_000 });
  await fromTokenSelect.selectOption(String(side === 'buy' ? USDC : WETH));
  await toTokenSelect.selectOption(String(side === 'buy' ? WETH : USDC));
}

async function selectCrossRoute(page: Page, targetEntityId: string): Promise<void> {
  const routeSelect = page.getByTestId('swap-route-select').first();
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
  await expect(page.getByTestId('swap-route-flow').first()).toContainText(/->|Tron|Local/i, { timeout: 10_000 });
}

async function placeCrossOrder(
  page: Page,
  params: {
    source: RuntimeIdentity;
    hubId: string;
    targetEntityId: string;
    side: 'buy' | 'sell';
    amount: string;
    price: string;
  },
): Promise<void> {
  await openSwapWorkspace(page);
  await selectSourceChainInSwap(page, params.source.entityId);
  await selectCounterpartyInSwap(page, params.hubId);
  await configurePair(page, params.side);
  await selectCrossRoute(page, params.targetEntityId);
  const amountInput = page.getByTestId('swap-order-amount').first();
  const priceInput = page.getByTestId('swap-order-price').first();
  const submit = page.getByTestId('swap-submit-order').first();
  await expect(amountInput).toBeVisible({ timeout: 20_000 });
  await expect(priceInput).toBeVisible({ timeout: 20_000 });
  const beforeSubmit = await readCrossState(page, params.source, params.hubId);
  const beforeRouteIds = new Set(beforeSubmit.routeSummaries.map(route => route.orderId));
  const beforeOfferIds = new Set(beforeSubmit.offerSummaries.map(offer => offer.offerId));
  const beforeMessageCount = beforeSubmit.messages.length;
  await amountInput.fill(params.amount);
  await priceInput.fill(params.price);
  await expect(submit).toBeEnabled({ timeout: 30_000 });
  await submit.click();
  let lastSubmitState: unknown = null;
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
          ok: newRoutes.length > 0 || newOffers.length > 0 || newMessages.some((message) => /Cross-j swap/i.test(message)),
          routes: state.routes,
          offers: state.offers,
          newRoutes: newRoutes.map(route => ({ orderId: route.orderId, status: route.status })),
          newOffers: newOffers.map(offer => ({ offerId: offer.offerId, status: offer.status })),
          formError: String(formError || '').trim(),
          formValues,
          recentMessages: state.messages.slice(-8),
        };
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
}

async function readCrossState(
  page: Page,
  identity: RuntimeIdentity,
  hubId: string,
): Promise<{
  offers: number;
  routes: number;
  pulls: number;
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
    bookOwnerEntityId: string;
    venueId: string;
    priceTicks: string;
    updatedAt: number;
  }>;
  offerSummaries: Array<{
    offerId: string;
    status: string;
    amount: string;
    cross: boolean;
  }>;
  pullIds: string[];
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
        bookOwnerEntityId: String(route?.bookOwnerEntityId || route?.source?.counterpartyEntityId || ''),
        venueId: String(route?.venueId || ''),
        priceTicks: String(route?.priceTicks ?? '0'),
        updatedAt: Number(route?.updatedAt || route?.createdAt || 0),
      });
    }
    return {
      offers,
      routes: Number(state?.crossJurisdictionSwaps?.size || 0),
      pulls: Number(account?.pulls?.size || 0),
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
    };
  }, { identity, hubId });
}

async function waitForCrossPullFlow(
  page: Page,
  source: RuntimeIdentity,
  target: RuntimeIdentity,
  sourceHubId: string,
  targetHubId: string,
): Promise<void> {
  try {
    await expect.poll(
      async () => {
        const sourceState = await readCrossState(page, source, sourceHubId);
        const targetState = await readCrossState(page, target, targetHubId);
        return {
          ok: (
            (sourceState.routes > 0 && targetState.routes > 0) &&
            (
              sourceState.pulls > 0 ||
              targetState.pulls > 0 ||
              sourceState.claimedRoutes > 0 ||
              targetState.claimedRoutes > 0
            )
          ),
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
    ).toMatchObject({ ok: true });
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

    const accountMatches = (accountKey: string, rawAccount: unknown): boolean => {
      const account = recordOf(rawAccount);
      const left = typeof account.leftEntity === 'string' ? account.leftEntity.toLowerCase() : '';
      const right = typeof account.rightEntity === 'string' ? account.rightEntity.toLowerCase() : '';
      const canonicalCp = typeof account.counterpartyEntityId === 'string' ? account.counterpartyEntityId.toLowerCase() : '';
      return accountKey.toLowerCase() === cp ||
        canonicalCp === cp ||
        Boolean(left && right && ((left === owner && right === cp) || (right === owner && left === cp)));
    };
    const collectResolveSnapshots = (history: unknown) => {
      if (!(history instanceof Map)) return;
      for (const [offerId, rawLifecycle] of history.entries()) {
        const resolves = recordOf(rawLifecycle).resolves;
        if (!Array.isArray(resolves)) continue;
        for (const rawResolve of resolves) {
          const resolve = recordOf(rawResolve);
          out.push({
            offerId: String(offerId || ''),
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
        collectResolveSnapshots(recordOf(rawAccount).swapOrderHistory);
        collectResolveSnapshots(recordOf(rawAccount).swapClosedOrders);
        return out;
      }
    }
    return out;
  }, { entityId, counterpartyId });
}

async function waitForLatestCrossResolveSnapshot(
  page: Page,
  entityId: string,
  counterpartyId: string,
  minimumCount: number,
): Promise<CrossResolveSnapshot> {
  await expect
    .poll(async () => (await readCrossResolveSnapshots(page, entityId, counterpartyId)).length, {
      timeout: 45_000,
      intervals: [250, 500, 1000],
      message: `cross resolve snapshots must reach ${minimumCount}`,
    })
    .toBeGreaterThanOrEqual(minimumCount);
  const latest = (await readCrossResolveSnapshots(page, entityId, counterpartyId)).at(-1);
  expect(latest, 'latest cross resolve snapshot must exist').toBeTruthy();
  return latest!;
}

async function waitForCrossOffersCleared(
  page: Page,
  identity: RuntimeIdentity,
  hubId: string,
  label: string,
): Promise<void> {
  try {
    await expect.poll(
      async () => {
        const state = await readCrossState(page, identity, hubId);
        return {
          offers: state.offers,
          replicaFound: state.replicaFound,
          accountFound: state.accountFound,
          accountKeys: state.accountKeys,
        };
      },
      {
        timeout: 45_000,
        intervals: [250, 500, 1000],
        message: `${label} cross order should resolve/cancel after match`,
      },
    ).toMatchObject({ offers: 0 });
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
    const runtimeModule = view.XLN
      ?? view.__xln_instance
      ?? await import(/* @vite-ignore */ new URL('/runtime.js', window.location.origin).href);
    view.XLN = runtimeModule;
    view.__xln_instance = runtimeModule;
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
  const blockNumber = 9001;
  const blockHash = `0x${'ab'.repeat(32)}`;
  const transactionHash = `0x${'cd'.repeat(32)}`;
  const signed = await signSyntheticJEventObservation(page, source, {
    event,
    blockNumber,
    blockHash,
    transactionHash,
  });
  await enqueueEntityTxs(page, source.entityId, source.signerId, [{
    type: 'j_event',
    data: {
      from: source.signerId,
      event,
      observedAt: Date.now(),
      blockNumber,
      blockHash,
      transactionHash,
      ...signed,
    },
  }]);
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
        return state.messages.some((message) =>
          (
            /Cross-j salvage queued/i.test(message) ||
            /Dispute started/i.test(message)
          ) && message.includes(routeId),
        );
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

  test('two users can place full, partial, and disputed cross-j swaps through the shared swap builder', async ({ browser, page }) => {
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

      const aliceMnemonic = selectDemoMnemonic('alice');
      const bobMnemonic = selectDemoMnemonic('bob');
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
        faucetOffchain(bobPage, primaryHubApiBaseUrl, bobRpc2.entityId, targetHubId, USDC, '200'),
      ]);
      await Promise.all([
        waitForOutCapAtLeast(alicePage, alice.entityId, hubId, WETH, 3n * 10n ** 16n),
        waitForOutCapAtLeast(bobPage, bobRpc2.entityId, targetHubId, USDC, 75n * 10n ** 18n),
      ]);

      await timedStep('cross_j_swap.full.alice_offer', () => placeCrossOrder(alicePage, {
        source: alice,
        hubId,
        targetEntityId: aliceRpc2.entityId,
        side: 'sell',
        amount: '0.03',
        price: '2500',
      }));
      await timedStep('cross_j_swap.full.bob_offer', () => placeCrossOrder(bobPage, {
        source: bobRpc2,
        hubId: targetHubId,
        targetEntityId: bob.entityId,
        side: 'buy',
        amount: '78',
        price: '2600',
      }));

      await Promise.all([
        waitForCrossPullFlow(alicePage, alice, aliceRpc2, hubId, targetHubId),
        waitForCrossPullFlow(bobPage, bobRpc2, bob, targetHubId, hubId),
      ]);

      await Promise.all([
        waitForCrossOffersCleared(alicePage, alice, hubId, 'Alice full'),
        waitForCrossOffersCleared(bobPage, bobRpc2, targetHubId, 'Bob full'),
      ]);
      const bobFullResolve = await timedStep('cross_j_swap.full.bob_price_improvement', () =>
        waitForLatestCrossResolveSnapshot(bobPage, bobRpc2.entityId, targetHubId, 1),
      );
      expect(bobFullResolve.fillRatio, 'Bob full source-savings must close the cross order').toBe(65_535);
      expect(bobFullResolve.cancelRemainder, 'Bob full source-savings must remove the terminal order').toBe(true);
      expect(bobFullResolve.executionGiveAmount, 'Bob spends execution source, not his 78 USDC limit').toBe('75000000000000000000');
      expect(bobFullResolve.executionWantAmount, 'Bob receives the full 0.03 WETH target').toBe('30000000000000000');

      await Promise.all([
        waitForOutCapAtLeast(alicePage, aliceRpc2.entityId, targetHubId, USDC, 25n * 10n ** 18n),
        waitForOutCapAtLeast(bobPage, bob.entityId, hubId, WETH, 5n * 10n ** 15n),
      ]);
      await timedStep('cross_j_swap.reverse.alice_offer', () => placeCrossOrder(alicePage, {
        source: aliceRpc2,
        hubId: targetHubId,
        targetEntityId: alice.entityId,
        side: 'buy',
        amount: '25',
        price: '2500',
      }));
      await timedStep('cross_j_swap.reverse.bob_offer', () => placeCrossOrder(bobPage, {
        source: bob,
        hubId,
        targetEntityId: bobRpc2.entityId,
        side: 'sell',
        amount: '0.01',
        price: '2500',
      }));
      await Promise.all([
        waitForCrossPullFlow(alicePage, aliceRpc2, alice, targetHubId, hubId),
        waitForCrossPullFlow(bobPage, bob, bobRpc2, hubId, targetHubId),
      ]);
      await Promise.all([
        waitForCrossOffersCleared(alicePage, aliceRpc2, targetHubId, 'Alice reverse'),
        waitForCrossOffersCleared(bobPage, bob, hubId, 'Bob reverse'),
      ]);

      await Promise.all([
        faucetOffchain(alicePage, primaryHubApiBaseUrl, alice.entityId, hubId, WETH, '1'),
        faucetOffchain(bobPage, primaryHubApiBaseUrl, bobRpc2.entityId, targetHubId, USDC, '100'),
      ]);
      await Promise.all([
        waitForOutCapAtLeast(alicePage, alice.entityId, hubId, WETH, 4n * 10n ** 16n),
        waitForOutCapAtLeast(bobPage, bobRpc2.entityId, targetHubId, USDC, 50n * 10n ** 18n),
      ]);

      await timedStep('cross_j_swap.partial.alice_offer', () => placeCrossOrder(alicePage, {
        source: alice,
        hubId,
        targetEntityId: aliceRpc2.entityId,
        side: 'sell',
        amount: '0.04',
        price: '2500',
      }));
      await timedStep('cross_j_swap.partial.bob_offer', () => placeCrossOrder(bobPage, {
        source: bobRpc2,
        hubId: targetHubId,
        targetEntityId: bob.entityId,
        side: 'buy',
        amount: '25',
        price: '2500',
      }));

      const [aliceFirstPartial] = await Promise.all([
        timedStep('cross_j_swap.partial.alice_pending_fill', () =>
          waitForCrossPendingFill(alicePage, alice, hubId, 'Alice partial'),
        ),
        timedStep('cross_j_swap.partial.bob_first_cleared', () =>
          waitForCrossOffersCleared(bobPage, bobRpc2, targetHubId, 'Bob first partial counter-order'),
        ),
      ]);

      await timedStep('cross_j_swap.partial.bob_second_offer', () => placeCrossOrder(bobPage, {
        source: bobRpc2,
        hubId: targetHubId,
        targetEntityId: bob.entityId,
        side: 'buy',
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
        waitForCrossOffersCleared(bobPage, bobRpc2, targetHubId, 'Bob second partial counter-order'),
      );

      await timedStep('cross_j_swap.partial.alice_cancel_clear', () =>
        requestCrossClear(alicePage, alice, aliceSecondPartial.routeId, { cancelRemainder: true }),
      );

      await Promise.all([
        timedStep('cross_j_swap.partial.alice_source_claimed', () =>
          waitForCrossRouteStatus(alicePage, alice, hubId, aliceSecondPartial.routeId, ['source_claimed', 'settled'], 'Alice source clear'),
        ),
        timedStep('cross_j_swap.partial.alice_target_settled', () =>
          waitForCrossRouteStatus(alicePage, aliceRpc2, targetHubId, aliceSecondPartial.routeId, ['settled'], 'Alice target clear'),
        ),
      ]);
      await timedStep('cross_j_swap.partial.alice_remainder_removed', () =>
        waitForCrossOffersCleared(alicePage, alice, hubId, 'Alice partial cancel-clear'),
      );

      await timedStep('cross_j_swap.dispute.alice_offer', () => placeCrossOrder(alicePage, {
        source: alice,
        hubId,
        targetEntityId: aliceRpc2.entityId,
        side: 'sell',
        amount: '0.04',
        price: '2500',
      }));
      await timedStep('cross_j_swap.dispute.bob_offer', () => placeCrossOrder(bobPage, {
        source: bobRpc2,
        hubId: targetHubId,
        targetEntityId: bob.entityId,
        side: 'buy',
        amount: '25',
        price: '2500',
      }));

      const [aliceDisputePartial] = await Promise.all([
        timedStep('cross_j_swap.dispute.alice_pending_fill', () =>
          waitForCrossPendingFill(alicePage, alice, hubId, 'Alice dispute route'),
        ),
        timedStep('cross_j_swap.dispute.bob_cleared', () =>
          waitForCrossOffersCleared(bobPage, bobRpc2, targetHubId, 'Bob dispute counter-order'),
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
