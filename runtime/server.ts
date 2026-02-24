/**
 * XLN Unified Server
 *
 * Single entry point combining:
 * - XLN Runtime (always running)
 * - Static file serving (SPA)
 * - WebSocket relay (/relay)
 * - RPC for remote UI (/rpc)
 * - REST API (/api/*)
 *
 * Usage:
 *   bun runtime/server.ts                    # Server on :8080
 *   bun runtime/server.ts --port 9000        # Custom port
 */

import { main, enqueueRuntimeInput, startP2P, startRuntimeLoop, registerEntityRuntimeHint, clearDB } from './runtime';
import { safeStringify } from './serialization-utils';
import type { Env, EntityInput, EntityTx, RoutedEntityInput, RuntimeInput } from './types';
import { encodeBoard, hashBoard } from './entity-factory';
import { deriveSignerKeySync } from './account-crypto';
import { createJAdapter, DEV_CHAIN_IDS, type JAdapter } from './jadapter';
import type { JEvent, JTokenInfo } from './jadapter/types';
import { DEFAULT_TOKENS, DEFAULT_TOKEN_SUPPLY, TOKEN_REGISTRATION_AMOUNT } from './jadapter/default-tokens';
import { resolveEntityProposerId } from './state-helpers';
import { deriveEncryptionKeyPair, encryptJSON, hexToPubKey, pubKeyToHex } from './networking/p2p-crypto';
import { buildEntityProfile } from './networking/gossip-helper';
import { encodeRebalancePolicyMemo } from './rebalance-policy';
import {
  type RelayStore,
  createRelayStore,
  normalizeRuntimeKey,
  nextWsTimestamp,
  pushDebugEvent,
  storeGossipProfile,
  getAllGossipProfiles,
  removeClient,
  resetStore as resetRelayStore,
  resolveEncryptionPublicKeyHex,
  cacheEncryptionKey,
} from './relay-store';
import { relayRoute, type RelayRouterConfig } from './relay-router';
import { createLocalDeliveryHandler } from './relay-local-delivery';
import { ethers } from 'ethers';
import { ERC20Mock__factory } from '../jurisdictions/typechain-types/factories/ERC20Mock__factory';

// Global J-adapter instance (set during startup)
let globalJAdapter: JAdapter | null = null;
// Server encryption keypair now managed by relay-local-delivery.ts
const HUB_SEED = process.env.HUB_SEED ?? 'xln-main-hub-2026';
let coldResetRebuildInFlight: Promise<void> | null = null;
let coldResetRebuildError: string | null = null;
let coldResetStartedAt = 0;
let coldResetCompletedAt = 0;

let tokenCatalogCache: JTokenInfo[] | null = null;
let tokenCatalogPromise: Promise<JTokenInfo[]> | null = null;
let processGuardsInstalled = false;
const ENTITY_ID_HEX_32_RE = /^0x[0-9a-fA-F]{64}$/;
const isEntityId32 = (value: unknown): value is string => typeof value === 'string' && ENTITY_ID_HEX_32_RE.test(value);

const oneShotLogs = new Map<string, number>();
const ONE_SHOT_TTL_MS = 60_000;
const logOneShot = (key: string, message: string) => {
  const nowMs = Date.now();
  const last = oneShotLogs.get(key) ?? 0;
  if (nowMs - last < ONE_SHOT_TTL_MS) return;
  oneShotLogs.set(key, nowMs);
  console.warn(message);
};

const applyJEventsToEnv = async (env: Env, events: JEvent[], label = 'J-EVENTS'): Promise<void> => {
  if (!events || events.length === 0) return;
  const grouped = new Map<
    string,
    {
      events: Array<{ type: string; data: Record<string, unknown> }>;
      blockNumber: number;
      blockHash: string;
      transactionHash: string;
    }
  >();

  for (const ev of events) {
    const entity = (ev as any)?.args?.entity || (ev as any)?.args?.entityId || (ev as any)?.args?.leftEntity;
    if (!entity) continue;
    const key = String(entity).toLowerCase();
    const entry = grouped.get(key) ?? {
      events: [],
      blockNumber: Number(ev.blockNumber ?? 0),
      blockHash: ev.blockHash ?? '0x',
      transactionHash: ev.transactionHash ?? '0x',
    };
    entry.events.push({ type: ev.name ?? (ev as any).type ?? 'Unknown', data: (ev as any).args ?? {} });
    grouped.set(key, entry);
  }

  const observedAt = Date.now();
  const entityInputs: EntityInput[] = [];
  for (const [entityId, entry] of grouped.entries()) {
    entityInputs.push({
      entityId,
      signerId: 'j-event',
      entityTxs: [
        {
          type: 'j_event',
          data: {
            from: 'j-event',
            events: entry.events,
            observedAt,
            blockNumber: entry.blockNumber,
            blockHash: entry.blockHash,
            transactionHash: entry.transactionHash,
          },
        },
      ],
    });
  }

  if (entityInputs.length === 0) return;
  console.log(`[${label}] Queueing ${entityInputs.length} J-events`);
  enqueueRuntimeInput(env, { runtimeTxs: [], entityInputs });
};

const hasPendingRuntimeWork = (env: Env): boolean => {
  if (env.pendingOutputs?.length) return true;
  if (env.networkInbox?.length) return true;
  if (env.runtimeInput?.runtimeTxs?.length) return true;
  // Check P2P mempool (where enqueueRuntimeInputs puts inbound messages)
  if ((env as any).runtimeMempool?.entityInputs?.length) return true;
  if ((env as any).runtimeMempool?.runtimeTxs?.length) return true;

  if (env.jReplicas) {
    for (const replica of env.jReplicas.values()) {
      if ((replica.mempool?.length ?? 0) > 0) return true;
    }
  }

  return false;
};

const waitForRuntimeIdle = async (env: Env, timeoutMs = 5000): Promise<boolean> => {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (!hasPendingRuntimeWork(env)) return true;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  return false;
};

const waitForJBatchClear = async (env: Env, timeoutMs = 5000): Promise<boolean> => {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const pendingJ = Array.from(env.jReplicas?.values?.() || []).some(j => (j.mempool?.length ?? 0) > 0);
    if (!pendingJ && !hasPendingRuntimeWork(env)) return true;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  return false;
};

const waitForReserveUpdate = async (
  entityId: string,
  tokenId: number,
  expectedMin: bigint,
  timeoutMs = 10000,
): Promise<bigint | null> => {
  if (!globalJAdapter) return null;
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const current = await globalJAdapter.getReserves(entityId, tokenId);
      if (current >= expectedMin) return current;
    } catch (err) {
      console.warn('[FAUCET] getReserves failed while waiting:', (err as Error).message);
    }
    await new Promise(resolve => setTimeout(resolve, 300));
  }
  return null;
};

const hubSignerLabels = new Map<string, string>();
const hubSignerAddresses = new Map<string, string>();
const HUB_MESH_TOKEN_ID = 1;
const HUB_MESH_CREDIT_AMOUNT = 1_000_000n * 10n ** 18n;
const HUB_MESH_REQUIRED_HUBS = 3;
const HUB_REQUIRED_TOKEN_COUNT = 2;
const HUB_RESERVE_TARGET_UNITS = 1_000_000_000n;
const HUB_RESERVE_ASSERT_TIMEOUT_MS = 30_000;
const HUB_MESH_ASSERT_TIMEOUT_MS = 20_000;

const getMapValueCaseInsensitive = <T>(map: Map<string, T>, key: string | undefined): T | undefined => {
  if (!key) return undefined;
  const needle = key.toLowerCase();
  for (const [mapKey, value] of map.entries()) {
    if (String(mapKey).toLowerCase() === needle) return value;
  }
  return undefined;
};

const getHubWallet = async (
  env: Env,
  hubEntityId?: string,
): Promise<{ hubEntityId: string; hubSignerId: string; wallet: ethers.Wallet } | null> => {
  if (!globalJAdapter) return null;
  const activeHubIds = relayStore.activeHubEntityIds;
  let targetEntityId = String(hubEntityId || '').toLowerCase();

  if (!targetEntityId) {
    const firstActiveWithSigner = activeHubIds.find(id => !!getMapValueCaseInsensitive(hubSignerLabels, id));
    if (firstActiveWithSigner) {
      targetEntityId = String(firstActiveWithSigner).toLowerCase();
    } else {
      const hubs = getFaucetHubProfiles(env);
      const firstFaucetWithSigner = hubs.find(h => !!getMapValueCaseInsensitive(hubSignerLabels, h?.entityId));
      if (!firstFaucetWithSigner?.entityId) return null;
      targetEntityId = String(firstFaucetWithSigner.entityId).toLowerCase();
    }
  }

  const signerLabel = getMapValueCaseInsensitive(hubSignerLabels, targetEntityId);
  if (!signerLabel) {
    console.warn(
      `[XLN] Hub signer label missing for ${targetEntityId.slice(0, 12)}... active=${activeHubIds.map(id => id.slice(-8)).join(',')}`,
    );
    return null;
  }
  const hubSignerAddress = getMapValueCaseInsensitive(hubSignerAddresses, targetEntityId);
  const hubPrivateKeyBytes = deriveSignerKeySync(HUB_SEED, signerLabel);
  const hubPrivateKeyHex = '0x' + Buffer.from(hubPrivateKeyBytes).toString('hex');
  const wallet = new ethers.Wallet(hubPrivateKeyHex, globalJAdapter.provider);
  if (hubSignerAddress && wallet.address.toLowerCase() !== hubSignerAddress.toLowerCase()) {
    console.error(
      `[XLN] Hub signer address mismatch for ${targetEntityId.slice(0, 12)}... expected=${hubSignerAddress} got=${wallet.address}`,
    );
    return null;
  }
  return { hubEntityId: targetEntityId, hubSignerId: hubSignerAddress ?? wallet.address, wallet };
};

const isHubProfile = (profile: any): boolean => {
  const caps: string[] = Array.isArray(profile?.capabilities) ? profile.capabilities : [];
  return profile?.metadata?.isHub === true || caps.includes('hub') || caps.includes('routing');
};

const isFaucetHubProfile = (profile: any): boolean => {
  if (!profile?.entityId) return false;
  const caps: string[] = Array.isArray(profile?.capabilities) ? profile.capabilities : [];
  if (caps.includes('faucet')) return true;
  return relayStore.activeHubEntityIds.some(id => id.toLowerCase() === String(profile.entityId).toLowerCase());
};

const getFaucetHubProfiles = (env: Env): any[] => {
  const profiles = env.gossip?.getProfiles?.() || [];
  const selected: any[] = [];
  for (const profile of profiles) {
    if (!isHubProfile(profile) || !isFaucetHubProfile(profile)) continue;
    selected.push(profile);
  }
  const activeSet = new Set(relayStore.activeHubEntityIds.map(id => id.toLowerCase()));
  selected.sort((a, b) => {
    const aActive = activeSet.has(String(a?.entityId || '').toLowerCase()) ? 1 : 0;
    const bActive = activeSet.has(String(b?.entityId || '').toLowerCase()) ? 1 : 0;
    return bActive - aActive;
  });
  if (selected.length === 0 && relayStore.activeHubEntityIds.length > 0) {
    // Fallback for cold gossip cache: active server hubs remain faucet-capable.
    return relayStore.activeHubEntityIds.map(entityId => ({
      entityId,
      metadata: { isHub: true },
      capabilities: ['hub', 'routing', 'faucet'],
      accounts: [],
    }));
  }
  return selected;
};

const sleep = async (ms: number): Promise<void> => {
  await new Promise(resolve => setTimeout(resolve, ms));
};

const getEntityReplicaById = (env: Env, entityId: string): any | null => {
  if (!env.eReplicas) return null;
  const target = entityId.toLowerCase();
  for (const [key, replica] of env.eReplicas.entries()) {
    if (typeof key === 'string' && key.toLowerCase().startsWith(`${target}:`)) {
      return replica;
    }
  }
  return null;
};

const accountMatchesCounterparty = (
  account: any,
  ownerEntityId: string,
  counterpartyId: string,
): boolean => {
  const needle = String(counterpartyId || '').toLowerCase();
  if (!needle) return false;

  const cp = typeof account?.counterpartyEntityId === 'string' ? account.counterpartyEntityId.toLowerCase() : '';
  if (cp === needle) return true;

  const me = String(ownerEntityId || '').toLowerCase();
  const left = typeof account?.leftEntity === 'string' ? account.leftEntity.toLowerCase() : '';
  const right = typeof account?.rightEntity === 'string' ? account.rightEntity.toLowerCase() : '';

  if (left && right) {
    if (left === me && right === needle) return true;
    if (right === me && left === needle) return true;
  }

  return false;
};

const getAccountDelta = (env: Env, entityId: string, counterpartyId: string, tokenId: number): any | null => {
  const account = getAccountMachine(env, entityId, counterpartyId);
  if (!account?.deltas) return null;
  return account.deltas.get(tokenId) ?? null;
};

const hasPairMutualCredit = (
  env: Env,
  leftEntityId: string,
  rightEntityId: string,
  tokenId: number,
  amount: bigint,
): boolean => {
  const delta = getAccountDelta(env, leftEntityId, rightEntityId, tokenId);
  if (!delta) return false;
  return (delta.leftCreditLimit ?? 0n) >= amount && (delta.rightCreditLimit ?? 0n) >= amount;
};

const hasAccount = (env: Env, entityId: string, counterpartyId: string): boolean => {
  const replica = getEntityReplicaById(env, entityId);
  if (!replica?.state?.accounts) return false;
  const needle = counterpartyId.toLowerCase();
  for (const [key, account] of replica.state.accounts.entries()) {
    if (typeof key === 'string' && key.toLowerCase() === needle) {
      return true;
    }
    if (accountMatchesCounterparty(account, entityId, counterpartyId)) return true;
  }
  return false;
};

const getAccountMachine = (env: Env, entityId: string, counterpartyId: string): any | null => {
  const replica = getEntityReplicaById(env, entityId);
  if (!replica?.state?.accounts) return null;
  const needle = counterpartyId.toLowerCase();
  for (const [key, account] of replica.state.accounts.entries()) {
    if (typeof key === 'string' && key.toLowerCase() === needle) {
      return account ?? null;
    }
    if (accountMatchesCounterparty(account, entityId, counterpartyId)) {
      return account ?? null;
    }
  }
  return null;
};

const getHubMeshHealth = (env: Env) => {
  const hubIds = relayStore.activeHubEntityIds.slice(0, HUB_MESH_REQUIRED_HUBS);
  const pairStatuses: Array<{
    left: string;
    right: string;
    tokenId: number;
    requiredCredit: string;
    leftHasAccount: boolean;
    rightHasAccount: boolean;
    leftToRightCredit: string;
    rightToLeftCredit: string;
    ok: boolean;
  }> = [];

  for (let i = 0; i < hubIds.length; i++) {
    for (let j = i + 1; j < hubIds.length; j++) {
      const left = hubIds[i]!;
      const right = hubIds[j]!;
      const leftDelta = getAccountDelta(env, left, right, HUB_MESH_TOKEN_ID);
      const rightDelta = getAccountDelta(env, right, left, HUB_MESH_TOKEN_ID);
      const leftHasAccount = hasAccount(env, left, right);
      const rightHasAccount = hasAccount(env, right, left);
      const leftToRightCredit = BigInt(leftDelta?.leftCreditLimit ?? 0n);
      const rightToLeftCredit = BigInt(rightDelta?.leftCreditLimit ?? 0n);
      const ok =
        leftHasAccount &&
        rightHasAccount &&
        leftToRightCredit >= HUB_MESH_CREDIT_AMOUNT &&
        rightToLeftCredit >= HUB_MESH_CREDIT_AMOUNT;

      pairStatuses.push({
        left,
        right,
        tokenId: HUB_MESH_TOKEN_ID,
        requiredCredit: HUB_MESH_CREDIT_AMOUNT.toString(),
        leftHasAccount,
        rightHasAccount,
        leftToRightCredit: leftToRightCredit.toString(),
        rightToLeftCredit: rightToLeftCredit.toString(),
        ok,
      });
    }
  }

  const ok = hubIds.length >= HUB_MESH_REQUIRED_HUBS && pairStatuses.length > 0 && pairStatuses.every(p => p.ok);

  return {
    requiredHubCount: HUB_MESH_REQUIRED_HUBS,
    tokenId: HUB_MESH_TOKEN_ID,
    requiredCredit: HUB_MESH_CREDIT_AMOUNT.toString(),
    hubIds,
    pairs: pairStatuses,
    ok,
  };
};

const getHubSignerForEntity = (env: Env, entityId: string): string => {
  return hubSignerAddresses.get(entityId) || resolveEntityProposerId(env, entityId, 'hub-mesh-bootstrap');
};

const waitUntil = async (predicate: () => boolean, maxAttempts = 120, stepMs = 200): Promise<boolean> => {
  for (let i = 0; i < maxAttempts; i++) {
    if (predicate()) return true;
    await sleep(stepMs);
  }
  return false;
};

const settleRuntimeFor = async (env: Env, rounds = 30): Promise<void> => {
  for (let i = 0; i < rounds; i++) {
    if (!hasPendingRuntimeWork(env)) break;
    await sleep(60);
  }
};

const ensureHubPairMeshCredit = async (env: Env, leftEntityId: string, rightEntityId: string): Promise<void> => {
  const leftSignerId = getHubSignerForEntity(env, leftEntityId);
  const rightSignerId = getHubSignerForEntity(env, rightEntityId);
  const alreadyReady = hasPairMutualCredit(env, leftEntityId, rightEntityId, HUB_MESH_TOKEN_ID, HUB_MESH_CREDIT_AMOUNT);
  if (alreadyReady) {
    console.log(`[XLN] Hub pair already funded: ${leftEntityId.slice(0, 8)}.. ↔ ${rightEntityId.slice(0, 8)}..`);
    return;
  }

  const entityInputs: EntityInput[] = [];
  const leftHasAccount = hasAccount(env, leftEntityId, rightEntityId);
  const rightHasAccount = hasAccount(env, rightEntityId, leftEntityId);

  if (!leftHasAccount) {
    entityInputs.push({
      entityId: leftEntityId,
      signerId: leftSignerId,
      entityTxs: [{ type: 'openAccount', data: { targetEntityId: rightEntityId, tokenId: HUB_MESH_TOKEN_ID } }],
    });
  }
  if (!rightHasAccount) {
    entityInputs.push({
      entityId: rightEntityId,
      signerId: rightSignerId,
      entityTxs: [{ type: 'openAccount', data: { targetEntityId: leftEntityId, tokenId: HUB_MESH_TOKEN_ID } }],
    });
  }
  if (entityInputs.length > 0) {
    console.log(`[XLN] Opening hub account pair ${leftEntityId.slice(0, 8)}.. ↔ ${rightEntityId.slice(0, 8)}..`);
    enqueueRuntimeInput(env, { runtimeTxs: [], entityInputs });
    await settleRuntimeFor(env, 35);
  }

  const hasBothAccounts = await waitUntil(
    () => hasAccount(env, leftEntityId, rightEntityId) && hasAccount(env, rightEntityId, leftEntityId),
    120,
    120,
  );
  if (!hasBothAccounts) {
    console.warn(
      `[XLN] Hub mesh account open timed out: ${leftEntityId.slice(0, 8)}.. ↔ ${rightEntityId.slice(0, 8)}..`,
    );
  }

  const creditInputs: EntityInput[] = [
    {
      entityId: leftEntityId,
      signerId: leftSignerId,
      entityTxs: [
        {
          type: 'extendCredit',
          data: {
            counterpartyEntityId: rightEntityId,
            tokenId: HUB_MESH_TOKEN_ID,
            amount: HUB_MESH_CREDIT_AMOUNT,
          },
        },
      ],
    },
    {
      entityId: rightEntityId,
      signerId: rightSignerId,
      entityTxs: [
        {
          type: 'extendCredit',
          data: {
            counterpartyEntityId: leftEntityId,
            tokenId: HUB_MESH_TOKEN_ID,
            amount: HUB_MESH_CREDIT_AMOUNT,
          },
        },
      ],
    },
  ];

  console.log(
    `[XLN] Extending $1M bidirectional credit for ${leftEntityId.slice(0, 8)}.. ↔ ${rightEntityId.slice(0, 8)}..`,
  );
  enqueueRuntimeInput(env, { runtimeTxs: [], entityInputs: creditInputs });
  await settleRuntimeFor(env, 45);

  const ready = hasPairMutualCredit(env, leftEntityId, rightEntityId, HUB_MESH_TOKEN_ID, HUB_MESH_CREDIT_AMOUNT);
  if (!ready) {
    console.warn(
      `[XLN] Hub pair credit still below target: ${leftEntityId.slice(0, 8)}.. ↔ ${rightEntityId.slice(0, 8)}..`,
    );
  } else {
    console.log(`[XLN] Hub pair credit ready: ${leftEntityId.slice(0, 8)}.. ↔ ${rightEntityId.slice(0, 8)}..`);
  }
};

const bootstrapHubMeshCredit = async (env: Env, requiredHubEntityIds: string[]): Promise<void> => {
  if (requiredHubEntityIds.length < 3) return;
  const normalized = requiredHubEntityIds.map(id => id.toLowerCase());
  const gossipReady = await waitUntil(
    () => {
      const profiles = env.gossip?.getProfiles?.() || [];
      const ids = new Set(profiles.map(p => p.entityId.toLowerCase()));
      return normalized.every(id => ids.has(id));
    },
    120,
    100,
  );

  if (!gossipReady) {
    console.warn('[XLN] Hub mesh bootstrap skipped: all hubs were not visible in gossip in time');
    return;
  }

  console.log('[XLN] Bootstrapping H1/H2/H3 mutual credit mesh ($1M each direction, tokenId=1)');
  for (let i = 0; i < requiredHubEntityIds.length; i++) {
    for (let j = i + 1; j < requiredHubEntityIds.length; j++) {
      const left = requiredHubEntityIds[i];
      const right = requiredHubEntityIds[j];
      if (!left || !right) continue;
      await ensureHubPairMeshCredit(env, left, right);
    }
  }
};

const assertHubBootstrapReadiness = async (
  env: Env,
  hubEntityIds: string[],
  tokenCatalog: JTokenInfo[],
): Promise<void> => {
  if (hubEntityIds.length < HUB_MESH_REQUIRED_HUBS) {
    const message =
      `HUB_BOOTSTRAP_FAILED: expected >=${HUB_MESH_REQUIRED_HUBS} hubs, got ${hubEntityIds.length}`;
    pushDebugEvent(relayStore, {
      event: 'error',
      status: 'failed',
      reason: 'HUB_BOOTSTRAP_HUB_COUNT',
      details: { expected: HUB_MESH_REQUIRED_HUBS, actual: hubEntityIds.length, hubEntityIds },
    });
    throw new Error(message);
  }

  const requiredTokens = tokenCatalog
    .map(token => ({
      tokenId: Number(token.tokenId),
      symbol: String(token.symbol || `token-${token.tokenId}`),
      decimals: Number.isFinite(token.decimals) ? Number(token.decimals) : 18,
    }))
    .filter(token => Number.isFinite(token.tokenId) && token.tokenId > 0)
    .slice(0, HUB_REQUIRED_TOKEN_COUNT);

  if (requiredTokens.length < HUB_REQUIRED_TOKEN_COUNT) {
    const message =
      `HUB_BOOTSTRAP_FAILED: expected >=${HUB_REQUIRED_TOKEN_COUNT} tokens, got ${requiredTokens.length}`;
    pushDebugEvent(relayStore, {
      event: 'error',
      status: 'failed',
      reason: 'HUB_BOOTSTRAP_TOKEN_COUNT',
      details: {
        expected: HUB_REQUIRED_TOKEN_COUNT,
        actual: requiredTokens.length,
        tokenCatalog: tokenCatalog.map(t => ({
          tokenId: Number(t.tokenId),
          symbol: t.symbol,
          decimals: t.decimals,
        })),
      },
    });
    throw new Error(message);
  }

  const expectedTargets = requiredTokens.map(token => ({
    ...token,
    target: HUB_RESERVE_TARGET_UNITS * 10n ** BigInt(token.decimals),
  }));

  const reserveReady = await waitUntil(
    () => {
      for (const hubEntityId of hubEntityIds) {
        const replica = getEntityReplicaById(env, hubEntityId);
        if (!replica?.state) return false;
        for (const token of expectedTargets) {
          const current = replica.state.reserves.get(String(token.tokenId)) ?? 0n;
          if (current < token.target) return false;
        }
      }
      return true;
    },
    Math.ceil(HUB_RESERVE_ASSERT_TIMEOUT_MS / 200),
    200,
  );

  if (!reserveReady) {
    const reserveState = hubEntityIds.map(hubEntityId => {
      const replica = getEntityReplicaById(env, hubEntityId);
      const reserves = expectedTargets.map(token => ({
        tokenId: token.tokenId,
        symbol: token.symbol,
        expectedMin: token.target.toString(),
        actual: (replica?.state?.reserves?.get(String(token.tokenId)) ?? 0n).toString(),
      }));
      return { hubEntityId, reserves };
    });
    pushDebugEvent(relayStore, {
      event: 'error',
      status: 'failed',
      reason: 'HUB_BOOTSTRAP_RESERVES',
      details: { reserveState },
    });
    throw new Error(`HUB_BOOTSTRAP_FAILED: reserves not funded for all hubs/tokens ${safeStringify(reserveState)}`);
  }

  const meshReady = await waitUntil(
    () => getHubMeshHealth(env).ok === true,
    Math.ceil(HUB_MESH_ASSERT_TIMEOUT_MS / 200),
    200,
  );
  if (!meshReady) {
    const mesh = getHubMeshHealth(env);
    pushDebugEvent(relayStore, {
      event: 'error',
      status: 'failed',
      reason: 'HUB_BOOTSTRAP_MESH',
      details: mesh,
    });
    throw new Error(`HUB_BOOTSTRAP_FAILED: hub mesh credit not ready ${safeStringify(mesh)}`);
  }
};

const deployDefaultTokensOnRpc = async (): Promise<void> => {
  if (!globalJAdapter || globalJAdapter.mode === 'browservm') return;
  const existing = await globalJAdapter.getTokenRegistry().catch(() => []);
  const existingSymbols = new Set(
    existing
      .map(token => String(token.symbol || '').trim().toUpperCase())
      .filter(symbol => symbol.length > 0),
  );

  const signer = globalJAdapter.signer;
  const depository = globalJAdapter.depository;
  const depositoryAddress = globalJAdapter.addresses?.depository;
  if (!depositoryAddress) {
    throw new Error('Depository address not available for token deployment');
  }

  console.log('[XLN] Deploying default ERC20 tokens to RPC...');
  const erc20Factory = new ERC20Mock__factory(signer as any);

  for (const token of DEFAULT_TOKEN_CATALOG) {
    if (existingSymbols.has(String(token.symbol || '').trim().toUpperCase())) {
      continue;
    }
    const tokenContract = await erc20Factory.deploy(token.name, token.symbol, DEFAULT_TOKEN_SUPPLY);
    await tokenContract.waitForDeployment();
    const tokenAddress = await tokenContract.getAddress();
    console.log(`[XLN] ${token.symbol} deployed at ${tokenAddress}`);

    const approveTx = await tokenContract.approve(depositoryAddress, TOKEN_REGISTRATION_AMOUNT);
    await approveTx.wait();

    const registerTx = await depository.connect(signer as any).externalTokenToReserve({
      entity: ethers.ZeroHash,
      contractAddress: tokenAddress,
      externalTokenId: 0,
      tokenType: 0,
      internalTokenId: 0,
      amount: TOKEN_REGISTRATION_AMOUNT,
    });
    await registerTx.wait();
    console.log(`[XLN] Token registered: ${token.symbol} @ ${tokenAddress.slice(0, 10)}...`);
  }
};

const TOKEN_CATALOG_TIMEOUT_MS = Math.max(1000, Number(process.env.TOKEN_CATALOG_TIMEOUT_MS || '6000'));

const withTimeout = async <T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race<T>([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timeout after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
};

const ensureTokenCatalog = async (): Promise<JTokenInfo[]> => {
  if (!globalJAdapter) return [];
  const fallbackTokens = tokenCatalogCache ?? [];
  const safeGetCode = async (address: string): Promise<string> => {
    try {
      return await withTimeout(
        globalJAdapter.provider.getCode(address).catch(() => '0x'),
        TOKEN_CATALOG_TIMEOUT_MS,
        'provider.getCode',
      );
    } catch (error) {
      console.warn(`[ensureTokenCatalog] getCode failed: ${(error as Error).message}`);
      return '0x';
    }
  };
  const safeGetRegistry = async (): Promise<JTokenInfo[]> => {
    try {
      return await withTimeout(
        globalJAdapter.getTokenRegistry().catch(() => []),
        TOKEN_CATALOG_TIMEOUT_MS,
        'getTokenRegistry',
      );
    } catch (error) {
      console.warn(`[ensureTokenCatalog] getTokenRegistry failed: ${(error as Error).message}`);
      return fallbackTokens;
    }
  };
  if (tokenCatalogCache && tokenCatalogCache.length > 0) {
    if (globalJAdapter.mode !== 'browservm') {
      const firstToken = tokenCatalogCache[0];
      if (firstToken?.address) {
        const code = await safeGetCode(firstToken.address);
        if (code !== '0x' && code.length > 10) {
          return tokenCatalogCache;
        }
        console.warn('[ensureTokenCatalog] Cached token registry appears stale - refreshing');
        tokenCatalogCache = null;
      }
    } else {
      return tokenCatalogCache;
    }
  }
  if (tokenCatalogPromise) return tokenCatalogPromise;

  tokenCatalogPromise = (async () => {
    const current = await safeGetRegistry();
    const needsMoreDefaultTokens = globalJAdapter.mode !== 'browservm' && current.length < HUB_REQUIRED_TOKEN_COUNT;

    // Verify tokens have actual code on-chain (not stale addresses)
    if (current.length > 0 && globalJAdapter.mode !== 'browservm') {
      const firstToken = current[0];
      if (firstToken?.address) {
        const code = await safeGetCode(firstToken.address);
        if (code === '0x' || code.length < 10) {
          console.warn(
            `[ensureTokenCatalog] Token ${firstToken.symbol} at ${firstToken.address} has no code - deploying fresh tokens`,
          );
          try {
            await withTimeout(deployDefaultTokensOnRpc(), TOKEN_CATALOG_TIMEOUT_MS * 2, 'deployDefaultTokensOnRpc');
          } catch (error) {
            console.warn(`[ensureTokenCatalog] Deploy fallback failed: ${(error as Error).message}`);
            return current;
          }
          const refreshed = await safeGetRegistry();
          return refreshed;
        }
      }
      if (needsMoreDefaultTokens) {
        try {
          await withTimeout(deployDefaultTokensOnRpc(), TOKEN_CATALOG_TIMEOUT_MS * 2, 'deployMissingDefaultTokensOnRpc');
        } catch (error) {
          console.warn(`[ensureTokenCatalog] Missing-token deploy fallback failed: ${(error as Error).message}`);
          return current;
        }
        const refreshed = await safeGetRegistry();
        return refreshed;
      }
      return current;
    }

    if (current.length > 0 || globalJAdapter.mode === 'browservm') {
      return current;
    }

    try {
      await withTimeout(deployDefaultTokensOnRpc(), TOKEN_CATALOG_TIMEOUT_MS * 2, 'deployDefaultTokensOnRpc');
    } catch (error) {
      console.warn(`[ensureTokenCatalog] Deploy fallback failed: ${(error as Error).message}`);
      return current;
    }
    const refreshed = await safeGetRegistry();
    return refreshed;
  })();

  const tokens = await tokenCatalogPromise;
  tokenCatalogPromise = null;
  if (tokens.length > 0) tokenCatalogCache = tokens;
  return tokens;
};

const updateJurisdictionsJson = async (
  contracts: JAdapter['addresses'],
  rpcUrl?: string,
  chainIdOverride?: number,
): Promise<void> => {
  try {
    const fs = await import('fs/promises');
    const path = await import('path');
    const canonicalPath = path.join(process.cwd(), 'jurisdictions', 'jurisdictions.json');
    const symlinkMirrors = [
      path.join(process.cwd(), 'jurisdictions.json'),
      path.join(process.cwd(), 'frontend', 'static', 'jurisdictions.json'),
    ];
    const copyMirrors = [
      path.join(process.cwd(), 'frontend', 'build', 'jurisdictions.json'),
      '/var/www/html/jurisdictions.json',
    ];
    const publicRpc = process.env.PUBLIC_RPC ?? rpcUrl ?? '/rpc';
    await fs.mkdir(path.dirname(canonicalPath), { recursive: true });

    let data: any = {};
    try {
      data = JSON.parse(await fs.readFile(canonicalPath, 'utf-8'));
    } catch {
      data = {};
    }
    data.version = data.version ?? '1.0.0';
    data.lastUpdated = new Date().toISOString();
    data.defaults = data.defaults ?? {
      timeout: 30000,
      retryAttempts: 3,
      gasLimit: 1_000_000,
      rebalancePolicyUsd: {
        softLimit: 500,
        hardLimit: 10_000,
        maxFee: 15,
      },
    };
    data.defaults.rebalancePolicyUsd = data.defaults.rebalancePolicyUsd ?? {
      softLimit: 500,
      hardLimit: 10_000,
      maxFee: 15,
    };
    if (data.testnet) delete data.testnet;
    data.jurisdictions = data.jurisdictions ?? {};
    const existingArrakis = data.jurisdictions.arrakis ?? {};
    data.jurisdictions.arrakis = {
      ...existingArrakis,
      name: 'Arrakis (Shared Anvil)',
      chainId: chainIdOverride ?? 31337,
      rpc: publicRpc,
      rebalancePolicyUsd: existingArrakis.rebalancePolicyUsd ?? data.defaults.rebalancePolicyUsd,
      contracts: {
        account: contracts.account,
        depository: contracts.depository,
        entityProvider: contracts.entityProvider,
        deltaTransformer: contracts.deltaTransformer,
      },
    };

    const payload = JSON.stringify(data, null, 2);
    await fs.writeFile(canonicalPath, payload);
    console.log(`[XLN] Updated jurisdictions.json: ${canonicalPath}`);

    for (const mirrorPath of symlinkMirrors) {
      try {
        await fs.mkdir(path.dirname(mirrorPath), { recursive: true });
      } catch {
        continue;
      }
      const linkTarget = path.relative(path.dirname(mirrorPath), canonicalPath) || path.basename(canonicalPath);
      let recreate = true;
      try {
        const stat = await fs.lstat(mirrorPath);
        if (stat.isSymbolicLink()) {
          const currentTarget = await fs.readlink(mirrorPath);
          const currentResolved = path.resolve(path.dirname(mirrorPath), currentTarget);
          if (currentResolved === canonicalPath) recreate = false;
        }
        if (recreate) await fs.unlink(mirrorPath);
      } catch {
        // Mirror doesn't exist yet; create below.
      }
      if (!recreate) continue;
      try {
        await fs.symlink(linkTarget, mirrorPath);
        console.log(`[XLN] Symlinked jurisdictions mirror: ${mirrorPath} -> ${linkTarget}`);
      } catch {
        await fs.writeFile(mirrorPath, payload);
        console.log(`[XLN] Mirrored jurisdictions via copy (symlink unavailable): ${mirrorPath}`);
      }
    }

    for (const mirrorPath of copyMirrors) {
      try {
        await fs.mkdir(path.dirname(mirrorPath), { recursive: true });
        await fs.writeFile(mirrorPath, payload);
        console.log(`[XLN] Mirrored jurisdictions copy: ${mirrorPath}`);
      } catch {
        // Optional mirror target; ignore when unavailable.
      }
    }
  } catch (err) {
    console.warn('[XLN] Failed to update jurisdictions.json:', (err as Error).message);
  }
};

// ============================================================================
// SERVER OPTIONS
// ============================================================================

export type XlnServerOptions = {
  port: number;
  host?: string;
  staticDir?: string;
  relaySeeds?: string[];
  serverId?: string;
};

const DEFAULT_OPTIONS: XlnServerOptions = {
  port: 8080,
  host: '0.0.0.0',
  staticDir: './frontend/build',
  relaySeeds: [],
  serverId: 'xln-server',
};
let activeServerOptions: XlnServerOptions = { ...DEFAULT_OPTIONS };
const DEFAULT_TOKEN_CATALOG = DEFAULT_TOKENS.map(token => ({ ...token }));
const getDefaultLocalRelayUrl = (port?: number): string => `ws://localhost:${port ?? DEFAULT_OPTIONS.port}/relay`;
const resolveUnifiedRelayUrl = (port?: number): string => {
  const fallback = getDefaultLocalRelayUrl(port);
  const candidates = [
    process.env.INTERNAL_RELAY_URL,
    process.env.RELAY_URL,
    process.env.PUBLIC_RELAY_URL,
  ]
    .map(value => String(value || '').trim())
    .filter(Boolean);
  const unique = Array.from(new Set(candidates));
  if (unique.length > 1) {
    throw new Error(
      `RELAY_URL_MISMATCH: expected single relay URL, got INTERNAL/RELAY/PUBLIC=${unique.join(', ')}`,
    );
  }
  return unique[0] || fallback;
};
const resolveConfiguredRelayUrl = (port?: number): string => resolveUnifiedRelayUrl(port);
const resolveAdvertisedRelayUrl = (port?: number): string => resolveUnifiedRelayUrl(port);

// ============================================================================
// RELAY STATE (single store for all relay concerns)
// ============================================================================

let relayStore = createRelayStore(DEFAULT_OPTIONS.serverId ?? 'xln-server');

const normalizeHubProfileForRelay = (profile: any): any => {
  if (!profile || !profile.entityId) return profile;
  const capabilities = Array.isArray(profile.capabilities) ? profile.capabilities : [];
  const rawBaseFee = profile.metadata?.rebalanceBaseFee;
  const rawLiquidityFeeBps = profile.metadata?.rebalanceLiquidityFeeBps;
  const rawGasFee = profile.metadata?.rebalanceGasFee;
  const rawPolicyVersion = Number(profile.metadata?.policyVersion ?? 1);
  const rawTimeoutMs = Number(profile.metadata?.rebalanceTimeoutMs ?? 10 * 60 * 1000);
  return {
    ...profile,
    capabilities: Array.from(new Set([...capabilities, 'hub', 'routing', 'faucet'])),
    metadata: {
      ...(profile.metadata || {}),
      isHub: true,
      name: profile.metadata?.name || String(profile.entityId).slice(0, 10),
      region: profile.metadata?.region || 'global',
      policyVersion: Number.isFinite(rawPolicyVersion) && rawPolicyVersion > 0 ? rawPolicyVersion : 1,
      rebalanceBaseFee:
        rawBaseFee !== undefined && rawBaseFee !== null
          ? String(rawBaseFee)
          : String(10n ** 17n),
      rebalanceLiquidityFeeBps:
        rawLiquidityFeeBps !== undefined && rawLiquidityFeeBps !== null
          ? String(rawLiquidityFeeBps)
          : '1',
      rebalanceGasFee:
        rawGasFee !== undefined && rawGasFee !== null
          ? String(rawGasFee)
          : '0',
      rebalanceTimeoutMs:
        Number.isFinite(rawTimeoutMs) && rawTimeoutMs > 0 ? Math.floor(rawTimeoutMs) : 10 * 60 * 1000,
      lastUpdated: profile.metadata?.lastUpdated || Date.now(),
    },
  };
};

const sendEntityInputDirectViaRelaySocket = (env: Env, targetRuntimeId: string, input: RoutedEntityInput): boolean => {
  const fromRuntimeId = String(env.runtimeId || '');
  if (!fromRuntimeId) return false;
  const targetKey = normalizeRuntimeKey(targetRuntimeId);
  const targetPubKeyHex = resolveEncryptionPublicKeyHex(relayStore, targetKey);
  if (!targetPubKeyHex) {
    logOneShot(
      `direct-dispatch-missing-key:${targetRuntimeId}`,
      `[RELAY] Direct dispatch missing encryption key for runtime ${targetRuntimeId.slice(0, 10)}`,
    );
    return false;
  }

  try {
    const payload = encryptJSON(input, hexToPubKey(targetPubKeyHex));
    const target = relayStore.clients.get(targetKey);
    const msg = {
      type: 'entity_input',
      id: `srv_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`,
      from: fromRuntimeId,
      to: target?.runtimeId || targetRuntimeId,
      timestamp: nextWsTimestamp(relayStore),
      payload,
      encrypted: true,
    };
    if (target) {
      target.ws.send(safeStringify(msg));
      pushDebugEvent(relayStore, {
        event: 'delivery',
        from: fromRuntimeId,
        to: targetRuntimeId,
        msgType: 'entity_input',
        encrypted: true,
        status: 'delivered-direct-local',
        details: {
          entityId: input.entityId,
          txs: input.entityTxs?.length ?? 0,
        },
      });
      return true;
    }

    // No local WS client for target runtime in this process.
    // IMPORTANT: return false so runtime falls back to normal P2P dispatch
    // via relay socket. Do not queue in local pendingMessages here because
    // that queue is process-local and can blackhole outputs when relay is
    // external to this API/runtime process.
    pushDebugEvent(relayStore, {
      event: 'delivery',
      from: fromRuntimeId,
      to: targetRuntimeId,
      msgType: 'entity_input',
      encrypted: true,
      status: 'direct-miss-fallback',
      details: {
        entityId: input.entityId,
        txs: input.entityTxs?.length ?? 0,
      },
    });
    return false;
  } catch (error) {
    logOneShot(
      `direct-dispatch-send-failed:${targetRuntimeId}`,
      `[RELAY] Direct dispatch send failed for runtime ${targetRuntimeId.slice(0, 10)}: ${(error as Error).message}`,
    );
    return false;
  }
};

const bootstrapServerHubsAndReserves = async (
  env: Env,
  options: XlnServerOptions,
  relayUrl: string,
  anvilRpc: string,
): Promise<string[]> => {
  const { bootstrapHubs } = await import('../scripts/bootstrap-hub');
  const publicRpc = process.env.PUBLIC_RPC ?? anvilRpc;
  const publicHttp = process.env.PUBLIC_HTTP ?? '';
  let relayHost = '';
  try {
    relayHost = new URL(relayUrl).hostname.toLowerCase();
  } catch {
    relayHost = '';
  }

  const explicitBootstrap = process.env.BOOTSTRAP_LOCAL_HUBS;
  const bootstrapLocalHubs = explicitBootstrap === '0' ? false : true;
  if (!bootstrapLocalHubs) {
    console.log(`[XLN] Hub bootstrap disabled by BOOTSTRAP_LOCAL_HUBS=0 (relayHost="${relayHost || 'unknown'}")`);
  }

  const hubConfigs = bootstrapLocalHubs
    ? [
        {
          name: 'H1',
          region: 'global',
          signerId: 'hub-1',
          seed: HUB_SEED,
          routingFeePPM: 100,
          relayUrl,
          rpcUrl: publicRpc,
          httpUrl: publicHttp,
          port: options.port,
          serverId: options.serverId ?? DEFAULT_OPTIONS.serverId ?? 'xln-server',
          capabilities: ['hub', 'routing', 'faucet'],
          position: { x: -80, y: 0, z: 0 },
        },
        {
          name: 'H2',
          region: 'global',
          signerId: 'hub-2',
          seed: HUB_SEED,
          routingFeePPM: 100,
          relayUrl,
          rpcUrl: publicRpc,
          httpUrl: publicHttp,
          port: options.port,
          serverId: options.serverId ?? DEFAULT_OPTIONS.serverId ?? 'xln-server',
          capabilities: ['hub', 'routing', 'faucet'],
          position: { x: 0, y: 0, z: 0 },
        },
        {
          name: 'H3',
          region: 'global',
          signerId: 'hub-3',
          seed: HUB_SEED,
          routingFeePPM: 100,
          relayUrl,
          rpcUrl: publicRpc,
          httpUrl: publicHttp,
          port: options.port,
          serverId: options.serverId ?? DEFAULT_OPTIONS.serverId ?? 'xln-server',
          capabilities: ['hub', 'routing', 'faucet'],
          position: { x: 80, y: 0, z: 0 },
        },
      ]
    : [];

  const hubBootstraps = await bootstrapHubs(env, hubConfigs);
  const hubEntityIds = hubBootstraps.map(h => String(h.entityId).toLowerCase());
  relayStore.activeHubEntityIds = [...hubEntityIds];
  hubSignerLabels.clear();
  hubSignerAddresses.clear();
  for (const hub of hubBootstraps) {
    const hubEntityId = String(hub.entityId).toLowerCase();
    hubSignerLabels.set(hubEntityId, hub.signerLabel);
    hubSignerAddresses.set(hubEntityId, hub.signerId);
  }

  if (hubEntityIds.length > 0) {
    seedHubProfilesInRelayCache(
      env,
      hubConfigs.map((cfg, idx) => ({
        entityId: hubEntityIds[idx],
        name: cfg.name,
        region: cfg.region,
        routingFeePPM: cfg.routingFeePPM,
        capabilities: cfg.capabilities,
      })),
      relayUrl,
    );
  }

  await new Promise(resolve => setTimeout(resolve, 100));

  const hubs = env.gossip?.getProfiles()?.filter(p => p.metadata?.isHub === true) || [];
  console.log(`[XLN] Found ${hubs.length} hubs in gossip`);

  if (hubEntityIds.length >= 3) {
    await bootstrapHubMeshCredit(env, hubEntityIds.slice(0, 3));
    seedHubProfilesInRelayCache(
      env,
      hubConfigs.map((cfg, idx) => ({
        entityId: hubEntityIds[idx],
        name: cfg.name,
        region: cfg.region,
        routingFeePPM: cfg.routingFeePPM,
        capabilities: cfg.capabilities,
      })),
      relayUrl,
    );
  }

  const activeJurisdictionName =
    env.activeJurisdiction || (env.jReplicas ? Array.from(env.jReplicas.keys())[0] : undefined);
  const activeJReplica = activeJurisdictionName ? env.jReplicas?.get(activeJurisdictionName) : undefined;
  const jurisdictionConfig = activeJReplica
    ? {
        name: activeJurisdictionName,
        chainId: Number(activeJReplica.jadapter?.chainId ?? activeJReplica.chainId ?? 0),
        address: activeJReplica.rpcs?.[0] ?? '',
        entityProviderAddress: activeJReplica.entityProviderAddress ?? activeJReplica.contracts?.entityProvider ?? '',
        depositoryAddress: activeJReplica.depositoryAddress ?? activeJReplica.contracts?.depository ?? '',
      }
    : undefined;

  for (const hubEntityId of hubEntityIds) {
    const replica = getEntityReplicaById(env, hubEntityId);
    if (!replica?.state) continue;
    replica.state.hubRebalanceConfig = {
      matchingStrategy: 'amount',
      policyVersion: 1,
      routingFeePPM: 1000,
      baseFee: 5n * 10n ** 18n,
      rebalanceBaseFee: 10n ** 17n,
      rebalanceLiquidityFeeBps: 1n,
      rebalanceGasFee: 0n,
      rebalanceTimeoutMs: 10 * 60 * 1000,
    };
    if (jurisdictionConfig && !replica.state.config?.jurisdiction) {
      replica.state.config.jurisdiction = jurisdictionConfig;
      console.log(
        `[XLN] Hub ${hubEntityId.slice(-8)} jurisdiction set: ${activeJurisdictionName} (depository=${jurisdictionConfig.depositoryAddress.slice(0, 10)}...)`,
      );
    }
    console.log(`[XLN] Hub ${hubEntityId.slice(-8)} rebalance config set (amount, 1000ppm, rebalance policy triplet)`);
  }

  if (globalJAdapter && hubEntityIds.length > 0) {
    console.log(`[XLN] Funding hub reserves (${hubEntityIds.length} hubs)...`);
    const tokenCatalog = await ensureTokenCatalog();
    const reserveTokens =
      tokenCatalog.length > 0 ? tokenCatalog : await globalJAdapter.getTokenRegistry().catch(() => []);
    // Keep bootstrap deterministic and aligned with readiness checks:
    // we only require/fund the first HUB_REQUIRED_TOKEN_COUNT tokens.
    const bootstrapTokens = reserveTokens.slice(0, HUB_REQUIRED_TOKEN_COUNT);

    try {
      if (DEV_CHAIN_IDS.has(globalJAdapter.chainId) && 'send' in globalJAdapter.provider) {
        const provider = globalJAdapter.provider as ethers.JsonRpcProvider;
        const deployerAddress = await globalJAdapter.signer.getAddress();
        const targetDeployerEth = ethers.parseEther('10000');
        await provider.send('anvil_setBalance', [deployerAddress, ethers.toBeHex(targetDeployerEth)]);
        console.log('[XLN] Anvil deployer balance topped up');
      }
    } catch (err) {
      console.warn('[XLN] Failed to top up anvil deployer:', (err as Error).message);
    }

    for (const hubEntityId of hubEntityIds) {
      const hub = await getHubWallet(env, hubEntityId);
      if (!hub) {
        const message = `HUB_BOOTSTRAP_FAILED: hub wallet unavailable for ${hubEntityId}`;
        pushDebugEvent(relayStore, {
          event: 'error',
          status: 'failed',
          reason: 'HUB_BOOTSTRAP_WALLET',
          details: { hubEntityId },
        });
        throw new Error(message);
      }
      const hubWalletAddress = await hub.wallet.getAddress();

      if (globalJAdapter.mode === 'browservm') {
        const browserVM = globalJAdapter.getBrowserVM();
        if (browserVM) {
          await (browserVM as any).fundSignerWallet(hubWalletAddress, 1_000_000_000n * 10n ** 18n);
        }
      } else {
        const deployer = globalJAdapter.signer;
        const erc20Abi = [
          'function transfer(address to, uint256 amount) returns (bool)',
          'function balanceOf(address) view returns (uint256)',
        ];

        for (const token of bootstrapTokens) {
          if (!token?.address) continue;
          try {
            const erc20 = new ethers.Contract(token.address, erc20Abi, deployer);
            const hubBalance = await erc20.balanceOf(hubWalletAddress);
            const targetBalance = 1_000_000_000n * 10n ** BigInt(token.decimals ?? 18);
            if (hubBalance < targetBalance) {
              const transferAmount = targetBalance - hubBalance;
              const tx = await erc20.transfer(hubWalletAddress, transferAmount);
              await tx.wait();
            }
          } catch (err) {
            console.warn(
              `[XLN] Hub ${hubEntityId.slice(-8)} wallet token topup failed (${token.symbol}):`,
              (err as Error).message,
            );
          }
        }

        try {
          const currentEth = await globalJAdapter.provider.getBalance(hubWalletAddress);
          const targetEth = ethers.parseEther('1000');
          if (currentEth < targetEth) {
            const topup = targetEth - currentEth;
            const ethTx = await deployer.sendTransaction({ to: hubWalletAddress, value: topup });
            await ethTx.wait();
          }
        } catch (err) {
          console.warn(`[XLN] Hub ${hubEntityId.slice(-8)} wallet ETH topup failed:`, (err as Error).message);
        }
      }

      for (const token of bootstrapTokens) {
        const tokenId = typeof token.tokenId === 'number' ? token.tokenId : undefined;
        if (!tokenId) continue;
        const decimals = typeof token.decimals === 'number' ? token.decimals : 18;
        const amount = 1_000_000_000n * 10n ** BigInt(decimals);
        try {
          const events = await globalJAdapter.debugFundReserves(hubEntityId, tokenId, amount);
          await applyJEventsToEnv(env, events, 'HUB-RESERVE-FUND');
          await settleRuntimeFor(env, 30);
          const onChainReserve = await waitForReserveUpdate(hubEntityId, tokenId, amount, 15_000);
          if (onChainReserve === null) {
            pushDebugEvent(relayStore, {
              event: 'error',
              status: 'failed',
              reason: 'HUB_BOOTSTRAP_RESERVE_TIMEOUT',
              details: {
                hubEntityId,
                tokenId,
                expectedMin: amount.toString(),
              },
            });
            throw new Error(
              `HUB_BOOTSTRAP_FAILED: reserve not visible on-chain for hub=${hubEntityId} token=${tokenId}`,
            );
          }
          const replica = getEntityReplicaById(env, hubEntityId);
          if (replica?.state) {
            replica.state.reserves.set(String(tokenId), onChainReserve);
          }
          console.log(
            `[XLN] Hub ${hubEntityId.slice(-8)} reserves funded: tokenId=${tokenId} amount=${ethers.formatUnits(onChainReserve, decimals)}`,
          );
        } catch (err) {
          console.warn(
            `[XLN] Hub ${hubEntityId.slice(-8)} reserve funding failed (tokenId=${tokenId}):`,
            (err as Error).message,
          );
          throw err;
        }
      }
    }
    console.log('[XLN] Hub reserve funding complete');
  } else {
    console.warn(`[XLN] Skipping hub reserve funding: globalJAdapter=${!!globalJAdapter} hubs=${hubEntityIds.length}`);
  }

  const assertTokens = await ensureTokenCatalog();
  await assertHubBootstrapReadiness(env, hubEntityIds, assertTokens);
  console.log(
    `[XLN] ✅ Hub bootstrap assertions passed: hubs=${hubEntityIds.length}, tokens=${Math.min(assertTokens.length, HUB_REQUIRED_TOKEN_COUNT)}, mesh=ok`,
  );

  return hubEntityIds;
};

const resetServerDebugState = (
  env: Env | null,
  preserveHubs = true,
): { remainingReplicas: number; remainingProfiles: number } => {
  resetRelayStore(relayStore);

  // Preserve full hub profiles (runtimeId + encryption keys) so immediate post-reset
  // routing does not fail with P2P_NO_PUBKEY before fresh gossip arrives.
  const hubSet = new Set(relayStore.activeHubEntityIds.map(id => id.toLowerCase()));
  const preservedHubProfiles = preserveHubs
    ? new Map(
        Array.from(relayStore.gossipProfiles.entries()).filter(([entityId]) =>
          hubSet.has(String(entityId).toLowerCase()),
        ),
      )
    : new Map<string, { profile: any; timestamp: number }>();

  if (env) {
    const runtimeState = env.runtimeState ?? {};
    if (runtimeState.entityRuntimeHints?.clear) {
      runtimeState.entityRuntimeHints.clear();
    }
    env.history = [];
    env.frameLogs = [];
    env.height = 0;
    env.runtimeInput = { runtimeTxs: [], entityInputs: [] };
    env.pendingOutputs = [];
    env.networkInbox = [];
    env.pendingNetworkOutputs = [];

    for (const [replicaKey, replica] of env.eReplicas.entries()) {
      const [entityId] = String(replicaKey).split(':');
      const isHubReplica = preserveHubs && !!entityId && hubSet.has(entityId.toLowerCase());
      if (!isHubReplica) {
        env.eReplicas.delete(replicaKey);
        continue;
      }

      // Keep hub replicas, but clear transient runtime state and user-facing queues/locks.
      replica.mempool = [];
      replica.proposal = undefined;
      replica.lockedFrame = undefined;
      replica.hankoWitness = new Map();
      replica.validatorComputedState = undefined;

      const state = replica.state;
      if (state) {
        state.messages = [];
        state.proposals = new Map();
        state.deferredAccountProposals = new Map();
        state.lockBook = new Map();
        state.swapBook = new Map();
        state.htlcRoutes = new Map();
        state.pendingSwapFillRatios = new Map();
        state.jBatchState = undefined;

        if (state.accounts) {
          for (const [counterpartyId, account] of state.accounts.entries()) {
            const isHubCounterparty = hubSet.has(String(counterpartyId).toLowerCase());
            if (!isHubCounterparty) {
              state.accounts.delete(counterpartyId);
              continue;
            }
            account.mempool = [];
            account.pendingFrame = undefined;
            account.pendingAccountInput = undefined;
            if (account.locks?.clear) account.locks.clear();
            if (account.swapOffers?.clear) account.swapOffers.clear();
            if (account.activeDispute) {
              account.activeDispute = undefined;
            }
          }
        }
      }
    }

    relayStore.gossipProfiles.clear();
    if (preserveHubs && preservedHubProfiles.size > 0) {
      for (const [entityId, entry] of preservedHubProfiles.entries()) {
        relayStore.gossipProfiles.set(entityId, { ...entry, profile: normalizeHubProfileForRelay(entry.profile) });
      }
    } else {
      // Fallback rebuild from current env gossip profile cache.
      const profiles = env.gossip?.getProfiles?.() || [];
      for (const profile of profiles) {
        const entityId = String(profile?.entityId || '').toLowerCase();
        if (!entityId) continue;
        if (preserveHubs && !hubSet.has(entityId)) continue;
        storeGossipProfile(relayStore, preserveHubs ? normalizeHubProfileForRelay(profile) : profile);
      }
    }
  } else {
    relayStore.gossipProfiles.clear();
    if (preserveHubs) {
      for (const [entityId, entry] of preservedHubProfiles.entries()) {
        relayStore.gossipProfiles.set(entityId, { ...entry, profile: normalizeHubProfileForRelay(entry.profile) });
      }
    }
  }

  return {
    remainingReplicas: env?.eReplicas?.size ?? 0,
    remainingProfiles: relayStore.gossipProfiles.size,
  };
};

const triggerColdReset = async (
  env: Env,
  opts: { resetRpc?: boolean; clearDb?: boolean; preserveHubs?: boolean; syncRebuild?: boolean } = {},
): Promise<{
  resetRpc: boolean;
  clearDb: boolean;
  activeClientsClosed: number;
  preserveHubs: boolean;
  rebuilding: boolean;
}> => {
  const resetRpc = opts.resetRpc !== false;
  const clearDbState = opts.clearDb !== false;
  const preserveHubs = opts.preserveHubs === true;
  const syncRebuild = opts.syncRebuild === true;
  const runtimeState = env.runtimeState;
  if (runtimeState) {
    runtimeState.persistencePaused = true;
  }

  const localRuntimeKey = normalizeRuntimeKey(env.runtimeId);
  const preservedRuntimeIds = new Set<string>();
  if (preserveHubs) {
    if (localRuntimeKey) preservedRuntimeIds.add(localRuntimeKey);
    for (const hubEntityId of relayStore.activeHubEntityIds) {
      const entry = relayStore.gossipProfiles.get(String(hubEntityId).toLowerCase());
      const hintedRuntime = normalizeRuntimeKey(
        entry?.profile?.runtimeId ?? entry?.profile?.metadata?.runtimeId ?? entry?.profile?.metadata?.runtime_id,
      );
      if (hintedRuntime) preservedRuntimeIds.add(hintedRuntime);
    }
  }

  let activeClientsClosed = 0;
  for (const [runtimeId, client] of relayStore.clients.entries()) {
    const isLocalHubRuntimeClient = preserveHubs && preservedRuntimeIds.has(runtimeId);
    if (isLocalHubRuntimeClient) {
      // Keep local hub runtime WS attached to relay so hub entities stay online
      // immediately after reset. User/browser clients are still dropped.
      continue;
    }
    try {
      client.ws.close(1012, 'server-reset');
    } catch {
      // Best effort; socket may already be closed.
    }
    relayStore.clients.delete(runtimeId);
    activeClientsClosed += 1;
  }

  relayStore.runtimeEncryptionKeys.clear();
  relayStore.pendingMessages.clear();

  if (clearDbState) {
    await clearDB(env);
  }
  // Full clean-room by default; preserve hubs only when explicitly requested.
  resetServerDebugState(env, preserveHubs);

  if (resetRpc && globalJAdapter?.mode === 'rpc') {
    try {
      const provider = globalJAdapter.provider as ethers.JsonRpcProvider;
      // Works on anvil nodes and gives a real cold chain reset.
      await provider.send('anvil_reset', []);
      console.log('[RESET] RPC reset via anvil_reset completed');
    } catch (error) {
      console.warn('[RESET] RPC reset skipped/failed:', (error as Error).message);
    }
  }

  const anvilRpc = process.env.ANVIL_RPC || 'http://localhost:8545';
  const advertisedRelayUrl = resolveAdvertisedRelayUrl(activeServerOptions.port);

  tokenCatalogCache = null;
  tokenCatalogPromise = null;

  const rebuildWork = async (): Promise<void> => {
    const internalRelayUrl = resolveConfiguredRelayUrl(activeServerOptions.port);
    if (globalJAdapter) {
      try {
        globalJAdapter.stopWatching();
      } catch (error) {
        console.warn('[RESET] Failed to stop J-event watcher before rebootstrap:', (error as Error).message);
      }

      if (resetRpc) {
        if (globalJAdapter.mode === 'rpc') {
          const freshChainId = Number(globalJAdapter.chainId);
          globalJAdapter = await createJAdapter({
            mode: 'rpc',
            chainId: freshChainId,
            rpcUrl: anvilRpc,
          });
          await globalJAdapter.deployStack();
          await updateJurisdictionsJson(globalJAdapter.addresses, anvilRpc, freshChainId);
        } else {
          await globalJAdapter.deployStack();
          await updateJurisdictionsJson(globalJAdapter.addresses, anvilRpc, Number(globalJAdapter.chainId));
        }
      }

      const jName = globalJAdapter.mode === 'rpc' ? 'arrakis' : 'local';
      if (!env.jReplicas) env.jReplicas = new Map();
      env.jReplicas.set(jName, {
        name: jName,
        blockNumber: 0n,
        stateRoot: new Uint8Array(32),
        mempool: [],
        blockDelayMs: 300,
        lastBlockTimestamp: env.timestamp,
        position: { x: 0, y: 50, z: 0 },
        depositoryAddress: globalJAdapter.addresses.depository,
        entityProviderAddress: globalJAdapter.addresses.entityProvider,
        contracts: globalJAdapter.addresses,
        rpcs: globalJAdapter.mode === 'rpc' ? [anvilRpc] : [],
        chainId: globalJAdapter.chainId,
        jadapter: globalJAdapter,
      });
      env.activeJurisdiction = jName;
      globalJAdapter.startWatching(env);
      console.log(`[RESET] J-event watcher restarted (${jName})`);
    }

    try {
      startP2P(env, {
        relayUrls: [internalRelayUrl],
        gossipPollMs: 0,
        serverId: activeServerOptions.serverId ?? DEFAULT_OPTIONS.serverId ?? 'xln-server',
      });
      console.log(`[RESET] P2P reconnected: ${internalRelayUrl}`);
    } catch (error) {
      console.warn('[RESET] Failed to reconnect P2P:', (error as Error).message);
    }

    await bootstrapServerHubsAndReserves(env, activeServerOptions, advertisedRelayUrl, anvilRpc);
    console.log('[RESET] Rebuild complete');
  };

  coldResetStartedAt = Date.now();
  coldResetCompletedAt = 0;
  coldResetRebuildError = null;
  coldResetRebuildInFlight = rebuildWork()
    .catch(error => {
      coldResetRebuildError = (error as Error).message;
      console.error('[RESET] Rebuild failed:', coldResetRebuildError);
    })
    .finally(() => {
      if (runtimeState) {
        runtimeState.persistencePaused = false;
      }
      coldResetCompletedAt = Date.now();
      coldResetRebuildInFlight = null;
    });

  if (syncRebuild) {
    await coldResetRebuildInFlight;
    return { resetRpc, clearDb: clearDbState, activeClientsClosed, preserveHubs, rebuilding: false };
  }

  return { resetRpc, clearDb: clearDbState, activeClientsClosed, preserveHubs, rebuilding: true };
};

const installProcessSafetyGuards = (): void => {
  if (processGuardsInstalled) return;
  processGuardsInstalled = true;

  process.on('unhandledRejection', reason => {
    const message = reason instanceof Error ? reason.message : String(reason);
    const stack = reason instanceof Error ? reason.stack : undefined;
    console.error(`[PROCESS] Unhandled rejection: ${message}`);
    pushDebugEvent(relayStore, {
      event: 'error',
      reason: 'UNHANDLED_REJECTION',
      details: { message, stack },
    });
  });

  process.on('uncaughtException', error => {
    const message = error?.message || 'Unknown uncaught exception';
    console.error(`[PROCESS] Uncaught exception: ${message}`);
    pushDebugEvent(relayStore, {
      event: 'error',
      reason: 'UNCAUGHT_EXCEPTION',
      details: { message, stack: error?.stack },
    });
  });
};

const seedHubProfilesInRelayCache = (
  env: Env,
  hubs: Array<{ entityId: string; name?: string; region?: string; routingFeePPM?: number; capabilities?: string[] }>,
  relayUrl: string,
): void => {
  const p2p = env.runtimeState?.p2p as { getEncryptionPublicKeyHex?: () => string } | undefined;
  const encryptionPublicKey = p2p?.getEncryptionPublicKeyHex?.()
    ?? (env.runtimeSeed ? pubKeyToHex(deriveEncryptionKeyPair(env.runtimeSeed).publicKey) : undefined);
  const seededAt = Date.now();

  for (const hub of hubs) {
    let hubState: any = null;
    for (const [replicaKey, replica] of env.eReplicas.entries()) {
      const [entityId] = String(replicaKey).split(':');
      if (entityId === hub.entityId) {
        hubState = replica.state;
        break;
      }
    }
    if (!hubState) continue;

    const profile = buildEntityProfile(hubState, hub.name, seededAt);
    profile.runtimeId = env.runtimeId;
    profile.capabilities = Array.from(
      new Set([...(profile.capabilities || []), ...(hub.capabilities || ['hub', 'routing', 'faucet'])]),
    );
    const hubPolicy = hubState.hubRebalanceConfig;
    profile.metadata = {
      ...(profile.metadata || {}),
      isHub: true,
      name: hub.name || profile.metadata?.name || hub.entityId.slice(0, 10),
      region: hub.region || 'global',
      relayUrl,
      routingFeePPM: hub.routingFeePPM ?? profile.metadata?.routingFeePPM ?? 100,
      policyVersion: hubPolicy?.policyVersion ?? 1,
      rebalanceBaseFee: String(hubPolicy?.rebalanceBaseFee ?? 10n ** 17n),
      rebalanceLiquidityFeeBps: String(hubPolicy?.rebalanceLiquidityFeeBps ?? hubPolicy?.minFeeBps ?? 1n),
      rebalanceGasFee: String(hubPolicy?.rebalanceGasFee ?? 0n),
      rebalanceTimeoutMs: hubPolicy?.rebalanceTimeoutMs ?? 10 * 60 * 1000,
      ...(encryptionPublicKey ? { encryptionPublicKey } : {}),
      lastUpdated: seededAt,
    };

    storeGossipProfile(relayStore, profile);
    env.gossip?.announce?.(profile);
  }
};

// ============================================================================
// FAUCET MUTEX (prevent nonce collisions from parallel requests)
// ============================================================================
const faucetLock = {
  locked: false,
  queue: [] as Array<() => void>,

  async acquire(): Promise<void> {
    if (!this.locked) {
      this.locked = true;
      return;
    }
    return new Promise(resolve => {
      this.queue.push(resolve);
    });
  },

  release(): void {
    const next = this.queue.shift();
    if (next) {
      next();
    } else {
      this.locked = false;
    }
  },
};
let faucetNonce: number | null = null;

// ============================================================================
// STATIC FILE SERVING
// ============================================================================

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

const getMimeType = (path: string): string | undefined => {
  const idx = path.lastIndexOf('.');
  if (idx === -1) return undefined;
  return MIME_TYPES[path.slice(idx)];
};

const serveStatic = async (pathname: string, staticDir: string): Promise<Response | null> => {
  // Try exact path
  const exactPath = `${staticDir}${pathname}`;
  let file = Bun.file(exactPath);
  if (await file.exists()) {
    const ct = getMimeType(pathname);
    return new Response(file, ct ? { headers: { 'content-type': ct } } : undefined);
  }

  // Try with .html extension
  if (!pathname.includes('.')) {
    const htmlPath = `${staticDir}${pathname}.html`;
    file = Bun.file(htmlPath);
    if (await file.exists()) {
      return new Response(file, { headers: { 'content-type': 'text/html; charset=utf-8' } });
    }
  }

  return null;
};

// Serve runtime bundle from canonical static/public locations.
// In dev, Vite serves frontend/static. In server mode, frontend/public/build
// may be used depending on deploy workflow.
const serveRuntimeBundle = async (): Promise<Response | null> => {
  const path = await import('path');
  const candidates = [
    path.join(process.cwd(), 'frontend', 'static', 'runtime.js'),
    path.join(process.cwd(), 'frontend', 'public', 'runtime.js'),
    path.join(process.cwd(), 'frontend', 'build', 'runtime.js'),
  ];
  for (const runtimePath of candidates) {
    const file = Bun.file(runtimePath);
    if (!(await file.exists())) continue;
    return new Response(file, {
      headers: {
        'content-type': 'text/javascript; charset=utf-8',
        // Prevent stale module cache across reloads while debugging/prod hotfixes.
        'cache-control': 'no-store, must-revalidate',
      },
    });
  }
  return null;
};

// ============================================================================
// RELAY PROTOCOL (now delegated to relay-router + relay-local-delivery)
// ============================================================================
// ============================================================================
// RPC PROTOCOL (for remote UI)
// ============================================================================

const handleRpcMessage = (ws: any, msg: any, env: Env | null) => {
  const { type, id } = msg;

  if (type === 'subscribe') {
    const client = Array.from(relayStore.clients.values()).find(c => c.ws === ws);
    if (client && msg.topics) {
      for (const topic of msg.topics) {
        client.topics.add(topic);
      }
    }
    ws.send(safeStringify({ type: 'ack', inReplyTo: id, status: 'subscribed' }));
    return;
  }

  if (type === 'get_env' && env) {
    // Serialize env for remote UI
    ws.send(
      safeStringify({
        type: 'env_snapshot',
        inReplyTo: id,
        data: {
          height: env.height,
          timestamp: env.timestamp,
          runtimeId: env.runtimeId,
          entityCount: env.eReplicas?.size || 0,
          // Add more fields as needed
        },
      }),
    );
    return;
  }

  ws.send(safeStringify({ type: 'error', error: `Unknown RPC type: ${type}` }));
};

// ============================================================================
// REST API
// ============================================================================

const handleApi = async (req: Request, pathname: string, env: Env | null): Promise<Response> => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': '*',
    'Access-Control-Allow-Headers': '*',
    'Content-Type': 'application/json',
  };

  if (req.method === 'OPTIONS') {
    return new Response(null, { headers });
  }

  // JSON-RPC proxy endpoint (single canonical path: /rpc).
  // Keep /api/rpc for compatibility with older clients.
  if ((pathname === '/api/rpc' || pathname === '/rpc') && req.method === 'POST') {
    const blockLocal = process.env.BLOCK_LOCAL_RPC_PROXY === 'true';
    const explicitUpstream = process.env.RPC_UPSTREAM_URL || process.env.PUBLIC_RPC_URL || process.env.ANVIL_RPC;
    const jMachineRpc = env?.activeJurisdiction ? env.jReplicas.get(env.activeJurisdiction)?.rpcUrl : undefined;
    const upstream = explicitUpstream || jMachineRpc || '';
    const isLocal = upstream.includes('localhost') || upstream.includes('127.0.0.1') || upstream.includes('0.0.0.0');

    if (!upstream) {
      pushDebugEvent(relayStore, {
        event: 'error',
        reason: 'RPC_PROXY_NO_UPSTREAM',
        details: { path: pathname },
      });
      return new Response(JSON.stringify({ error: 'RPC upstream not configured' }), { status: 503, headers });
    }
    if (isLocal && blockLocal) {
      pushDebugEvent(relayStore, {
        event: 'error',
        reason: 'RPC_PROXY_LOCAL_BLOCKED',
        details: { upstream, path: pathname },
      });
      return new Response(
        JSON.stringify({
          error: 'Local RPC upstream is blocked in this environment',
          upstream,
        }),
        { status: 503, headers },
      );
    }

    try {
      const bodyText = await req.text();
      const rpcRes = await fetch(upstream, {
        method: 'POST',
        headers: {
          'content-type': req.headers.get('content-type') || 'application/json',
        },
        body: bodyText,
      });
      const respBody = await rpcRes.text();
      return new Response(respBody, {
        status: rpcRes.status,
        headers: {
          ...headers,
          'Content-Type': rpcRes.headers.get('content-type') || 'application/json',
        },
      });
    } catch (error: any) {
      pushDebugEvent(relayStore, {
        event: 'error',
        reason: 'RPC_PROXY_FETCH_FAILED',
        details: { upstream, path: pathname, error: error?.message || String(error) },
      });
      return new Response(JSON.stringify({ error: error?.message || 'RPC proxy failed' }), { status: 502, headers });
    }
  }

  // Health check
  if (pathname === '/api/health') {
    const { getHealthStatus } = await import('./health.ts');
    const health = await getHealthStatus(env);
    const activeClientRuntimeIds = Array.from(relayStore.clients.keys());
    const activeClientsDetailed = Array.from(relayStore.clients.entries()).map(([runtimeId, client]) => ({
      runtimeId,
      lastSeen: client.lastSeen,
      ageMs: Math.max(0, Date.now() - client.lastSeen),
      topics: Array.from(client.topics || []),
    }));
    // Ensure hubs are visible even when env.gossip is stale by merging relay cache profiles.
    const relayHubProfiles = getAllGossipProfiles(relayStore).filter(
      (p: any) => p?.metadata?.isHub === true || (Array.isArray(p?.capabilities) && p.capabilities.includes('hub')),
    );
    const existing = new Set((health.hubs || []).map(h => String(h.entityId).toLowerCase()));
    for (const p of relayHubProfiles) {
      const entityId = String(p?.entityId || '');
      if (!entityId) continue;
      if (existing.has(entityId.toLowerCase())) continue;
      health.hubs.push({
        entityId,
        name: p?.metadata?.name || 'Unknown',
        region: p?.metadata?.region || 'global',
        relayUrl: p?.metadata?.relayUrl,
        status: 'healthy',
      });
      existing.add(entityId.toLowerCase());
    }

    const relayHubsByEntity = new Map<string, any>();
    for (const p of relayHubProfiles) {
      relayHubsByEntity.set(String(p?.entityId || '').toLowerCase(), p);
    }
    health.hubs = (health.hubs || []).map((hub: any) => {
      const entityId = String(hub?.entityId || '');
      const profile = relayHubsByEntity.get(entityId.toLowerCase());
      const runtimeId =
        typeof profile?.runtimeId === 'string'
          ? profile.runtimeId
          : typeof profile?.metadata?.runtimeId === 'string'
            ? profile.metadata.runtimeId
            : undefined;
      const normalizedRuntimeId = normalizeRuntimeKey(runtimeId);
      const activeClients =
        normalizedRuntimeId && relayStore.clients.has(normalizedRuntimeId) ? [normalizedRuntimeId] : [];
      return {
        ...hub,
        runtimeId: normalizedRuntimeId || runtimeId,
        online: activeClients.length > 0,
        activeClients,
      };
    });

    return new Response(
      JSON.stringify({
        ...health,
        hubMesh: getHubMeshHealth(env),
        reset: {
          inProgress: !!coldResetRebuildInFlight,
          lastError: coldResetRebuildError,
          startedAt: coldResetStartedAt || null,
          completedAt: coldResetCompletedAt || null,
        },
        relay: {
          activeClients: activeClientRuntimeIds,
          activeClientCount: activeClientRuntimeIds.length,
          clientsDetailed: activeClientsDetailed,
        },
      }),
      { headers },
    );
  }

  // Runtime state
  if (pathname === '/api/state' && env) {
    return new Response(
      JSON.stringify({
        height: env.height,
        timestamp: env.timestamp,
        runtimeId: env.runtimeId,
        entityCount: env.eReplicas?.size || 0,
      }),
      { headers },
    );
  }

  // Connected clients
  if (pathname === '/api/clients') {
    return new Response(
      JSON.stringify({
        count: relayStore.clients.size,
        clients: Array.from(relayStore.clients.keys()),
      }),
      { headers },
    );
  }

  // Relay debug timeline (single source for network + critical runtime events)
  if (pathname === '/api/debug/events') {
    const url = new URL(req.url);
    const last = Math.max(1, Math.min(5000, Number(url.searchParams.get('last') || '200')));
    const event = url.searchParams.get('event') || undefined;
    const runtimeId = url.searchParams.get('runtimeId') || undefined;
    const from = url.searchParams.get('from') || undefined;
    const to = url.searchParams.get('to') || undefined;
    const msgType = url.searchParams.get('msgType') || undefined;
    const status = url.searchParams.get('status') || undefined;
    const since = Number(url.searchParams.get('since') || '0');

    let filtered = relayStore.debugEvents;
    if (since > 0) filtered = filtered.filter(e => e.ts >= since);
    if (event) filtered = filtered.filter(e => e.event === event);
    if (runtimeId)
      filtered = filtered.filter(e => e.runtimeId === runtimeId || e.from === runtimeId || e.to === runtimeId);
    if (from) filtered = filtered.filter(e => e.from === from);
    if (to) filtered = filtered.filter(e => e.to === to);
    if (msgType) filtered = filtered.filter(e => e.msgType === msgType);
    if (status) filtered = filtered.filter(e => e.status === status);

    const events = filtered.slice(-last);
    return new Response(
      safeStringify({
        ok: true,
        total: relayStore.debugEvents.length,
        returned: events.length,
        serverTime: Date.now(),
        filters: { last, event, runtimeId, from, to, msgType, status, since: Number.isFinite(since) ? since : 0 },
        events,
      }),
      { headers },
    );
  }

  if (pathname === '/api/debug/reset' && req.method === 'POST') {
    const configuredToken = process.env.DEBUG_RESET_TOKEN;
    if (configuredToken) {
      const supplied = req.headers.get('x-debug-reset-token') || '';
      if (supplied !== configuredToken) {
        return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers });
      }
    }

    let preserveHubs = false;
    try {
      const body = await req.json().catch(() => ({}));
      if (typeof body?.preserveHubs === 'boolean') {
        preserveHubs = body.preserveHubs;
      }
    } catch {
      // Keep defaults for malformed/empty body.
    }

    const stats = resetServerDebugState(env, preserveHubs);
    pushDebugEvent(relayStore, {
      event: 'reset',
      status: 'ok',
      details: {
        preserveHubs,
        ...stats,
      },
    });
    return new Response(
      safeStringify({
        ok: true,
        preserveHubs,
        ...stats,
        ts: Date.now(),
      }),
      { headers },
    );
  }

  if ((pathname === '/api/reset' || pathname === '/reset') && (req.method === 'POST' || req.method === 'GET')) {
    const configuredToken = process.env.DEBUG_RESET_TOKEN;
    if (configuredToken) {
      const supplied = req.headers.get('x-debug-reset-token') || '';
      if (supplied !== configuredToken) {
        return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers });
      }
    }

    const url = new URL(req.url);
    const resetRpc = url.searchParams.get('rpc') !== '0';
    const clearDbState = url.searchParams.get('db') !== '0';
    // Full clean-room reset by default. Use preserveHubs=1 to keep hub entities/profiles.
    const preserveParam = url.searchParams.get('preserveHubs');
    const preserveHubs = preserveParam === '1';
    const syncRebuild = url.searchParams.get('sync') === '1';
    // Keep server alive by default (local dev/e2e). Supervisor restart is opt-in via exit=1.
    const shouldExit = url.searchParams.get('exit') === '1';

    const result = await triggerColdReset(env, { resetRpc, clearDb: clearDbState, preserveHubs, syncRebuild });
    pushDebugEvent(relayStore, {
      event: 'reset',
      status: 'ok',
      details: { mode: 'cold', ...result },
    });

    // Optional process restart for supervisor-managed environments.
    // In local dev/E2E we keep the API alive and continue on the same process.
    if (shouldExit) {
      setTimeout(() => process.exit(0), 250);
    }
    return new Response(
      safeStringify({
        ok: true,
        mode: 'cold',
        restarting: shouldExit,
        ...result,
        ts: Date.now(),
      }),
      { headers },
    );
  }

  // Registered gossip entities (single source from relay profile store)
  if (pathname === '/api/debug/entities') {
    const url = new URL(req.url);
    const q = (url.searchParams.get('q') || '').trim().toLowerCase();
    const limit = Math.max(1, Math.min(5000, Number(url.searchParams.get('limit') || '1000')));
    const onlineOnly = url.searchParams.get('online') === 'true';

    const entities = Array.from(relayStore.gossipProfiles.entries())
      .map(([entityId, entry]) => {
        const profile = entry.profile || {};
        const runtimeId = typeof profile.runtimeId === 'string' ? profile.runtimeId : undefined;
        const normalizedRuntimeId = normalizeRuntimeKey(runtimeId);
        const name =
          typeof profile?.metadata?.name === 'string' && profile.metadata.name.trim().length > 0
            ? profile.metadata.name.trim()
            : entityId;
        const isHub =
          profile?.metadata?.isHub === true ||
          (Array.isArray(profile?.capabilities) && profile.capabilities.includes('hub'));
        const online = normalizedRuntimeId ? relayStore.clients.has(normalizedRuntimeId) : false;
        return {
          entityId,
          runtimeId: normalizedRuntimeId || runtimeId,
          name,
          isHub,
          online,
          lastUpdated: Number(profile?.metadata?.lastUpdated || entry.timestamp || 0),
          capabilities: Array.isArray(profile?.capabilities) ? profile.capabilities : [],
          accounts: Array.isArray(profile?.accounts) ? profile.accounts : [],
          publicAccounts: Array.isArray(profile?.publicAccounts) ? profile.publicAccounts : [],
          metadata: profile?.metadata || {},
        };
      })
      .filter(e => {
        if (onlineOnly && !e.online) return false;
        if (!q) return true;
        const blob =
          `${e.entityId} ${e.runtimeId || ''} ${e.name} ${JSON.stringify(e.capabilities || [])}`.toLowerCase();
        return blob.includes(q);
      })
      .sort((a, b) => (b.lastUpdated || 0) - (a.lastUpdated || 0))
      .slice(0, limit);

    return new Response(
      safeStringify({
        ok: true,
        totalRegistered: relayStore.gossipProfiles.size,
        returned: entities.length,
        serverTime: Date.now(),
        entities,
      }),
      { headers },
    );
  }

  // J-event watching is handled by JAdapter.startWatching() per-jReplica

  // Token catalog (for UI token list + deposits)
  if (pathname === '/api/tokens') {
    try {
      if (!globalJAdapter) {
        return new Response(JSON.stringify({ error: 'J-adapter not initialized' }), { status: 503, headers });
      }

      const tokens = await ensureTokenCatalog();
      return new Response(JSON.stringify({ tokens }), { headers });
    } catch (error: any) {
      console.error('[API/TOKENS] Error:', error);
      return new Response(JSON.stringify({ error: error.message }), { status: 500, headers });
    }
  }

  // ============================================================================
  // FAUCET ENDPOINTS
  // ============================================================================

  // Faucet A: External ERC20 → user wallet
  if (pathname === '/api/faucet/erc20' && req.method === 'POST') {
    // Acquire mutex to prevent nonce collisions
    await faucetLock.acquire();
    try {
      const requestId =
        globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      const logPrefix = `FAUCET/ERC20 ${requestId}`;
      if (!globalJAdapter) {
        faucetLock.release();
        return new Response(JSON.stringify({ error: 'J-adapter not initialized' }), { status: 503, headers });
      }
      if (!env) {
        faucetLock.release();
        return new Response(JSON.stringify({ error: 'Runtime not initialized' }), { status: 503, headers });
      }

      const body = await req.json();
      const { userAddress, tokenSymbol = 'USDC', amount = '100' } = body;
      console.log(`[${logPrefix}] Request: to=${userAddress} token=${tokenSymbol} amount=${amount}`);

      if (!userAddress || !ethers.isAddress(userAddress)) {
        faucetLock.release();
        return new Response(JSON.stringify({ error: 'Invalid userAddress' }), { status: 400, headers });
      }

      if (globalJAdapter.mode === 'browservm') {
        const browserVM = globalJAdapter.getBrowserVM();
        if (!browserVM?.fundSignerWallet) {
          faucetLock.release();
          return new Response(JSON.stringify({ error: 'BrowserVM faucet unavailable' }), { status: 503, headers });
        }
        const amountWei = ethers.parseUnits(amount, 18);
        await (browserVM as any).fundSignerWallet(userAddress, amountWei);
        faucetLock.release();
        console.log(`[${logPrefix}] BrowserVM funded ${userAddress} amount=${amount}`);
        return new Response(
          JSON.stringify({
            success: true,
            type: 'erc20',
            amount,
            tokenSymbol,
            userAddress,
            requestId,
          }),
          { headers },
        );
      }

      if (tokenSymbol?.toUpperCase?.() === 'ETH') {
        const hub = await getHubWallet(env!);
        if (!hub) {
          faucetLock.release();
          return new Response(JSON.stringify({ error: 'No faucet hub available' }), { status: 503, headers });
        }
        const hubWallet = hub.wallet;
        const topupAmount = ethers.parseEther(amount);
        const pendingNonce = await hubWallet.getNonce('pending');
        if (faucetNonce === null || pendingNonce > faucetNonce) {
          faucetNonce = pendingNonce;
        }
        const nonce = faucetNonce;
        const tx = await hubWallet.sendTransaction({
          to: userAddress,
          value: topupAmount,
          nonce,
        });
        faucetNonce = nonce + 1;
        await tx.wait();
        faucetLock.release();
        console.log(`[${logPrefix}] ETH-only faucet tx=${tx.hash}`);
        return new Response(
          JSON.stringify({
            success: true,
            type: 'gas',
            amount,
            tokenSymbol: 'ETH',
            userAddress,
            txHash: tx.hash,
            requestId,
          }),
          { headers },
        );
      }

      const tokens = await ensureTokenCatalog();
      const tokenInfo = tokens.find(t => t.symbol?.toUpperCase() === tokenSymbol.toUpperCase());
      if (!tokenInfo?.address) {
        faucetLock.release();
        return new Response(JSON.stringify({ error: `Token ${tokenSymbol} not found` }), { status: 404, headers });
      }
      const amountWei = ethers.parseUnits(amount, tokenInfo.decimals ?? 18);
      console.log(`[${logPrefix}] Token resolved: ${tokenInfo.symbol} @ ${tokenInfo.address}`);

      const hub = await getHubWallet(env!);
      if (!hub) {
        faucetLock.release();
        return new Response(JSON.stringify({ error: 'No faucet hub available' }), { status: 503, headers });
      }

      const hubWallet = hub.wallet;
      console.log(`[${logPrefix}] Hub wallet: ${await hubWallet.getAddress()}`);

      // Transfer ERC20 from hub to user (with explicit nonce for safety)
      const ERC20_ABI = ['function transfer(address to, uint256 amount) returns (bool)'];
      const erc20 = new ethers.Contract(tokenInfo.address, ERC20_ABI, hubWallet);
      const pendingNonce = await hubWallet.getNonce('pending');
      if (faucetNonce === null || pendingNonce > faucetNonce) {
        faucetNonce = pendingNonce;
      }
      const nonce = faucetNonce;
      const tx = await erc20.transfer(userAddress, amountWei, { nonce });
      faucetNonce = nonce + 1;
      await tx.wait();
      console.log(`[${logPrefix}] ERC20 transfer tx=${tx.hash}`);

      // Only top up ETH if user is low on gas
      let ethTxHash: string | undefined;
      try {
        const userEth = await globalJAdapter.provider.getBalance(userAddress);
        const minBalance = ethers.parseEther('0.01');
        const targetBalance = ethers.parseEther('0.1');
        if (userEth < minBalance) {
          const topup = targetBalance - userEth;
          const ethNonce = faucetNonce;
          const ethTx = await hubWallet.sendTransaction({
            to: userAddress,
            value: topup,
            nonce: ethNonce,
          });
          faucetNonce = ethNonce + 1;
          await ethTx.wait();
          ethTxHash = ethTx.hash;
          console.log(`[${logPrefix}] ETH topup tx=${ethTx.hash} topup=${ethers.formatEther(topup)}`);
        } else {
          console.log(`[${logPrefix}] ETH topup skipped (balance=${ethers.formatEther(userEth)})`);
        }
      } catch (err) {
        console.warn(`[${logPrefix}] ETH topup check failed:`, (err as Error).message);
      }

      faucetLock.release();
      return new Response(
        JSON.stringify({
          success: true,
          type: 'erc20',
          amount,
          tokenSymbol,
          userAddress,
          txHash: tx.hash,
          ...(ethTxHash ? { ethTxHash } : {}),
          requestId,
        }),
        { headers },
      );
    } catch (error: any) {
      faucetLock.release();
      console.error('[FAUCET/ERC20] Error:', error);
      return new Response(JSON.stringify({ error: error.message }), { status: 500, headers });
    }
  }

  // Faucet A2: Gas-only topup (for approve/deposit)
  if (pathname === '/api/faucet/gas' && req.method === 'POST') {
    await faucetLock.acquire();
    try {
      const requestId =
        globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      const logPrefix = `FAUCET/GAS ${requestId}`;
      if (!globalJAdapter) {
        faucetLock.release();
        return new Response(JSON.stringify({ error: 'J-adapter not initialized' }), { status: 503, headers });
      }
      if (!env) {
        faucetLock.release();
        return new Response(JSON.stringify({ error: 'Runtime not initialized' }), { status: 503, headers });
      }

      const body = await req.json();
      const { userAddress, amount = '0.1' } = body;
      console.log(`[${logPrefix}] Request: to=${userAddress} amount=${amount}`);

      if (!userAddress || !ethers.isAddress(userAddress)) {
        faucetLock.release();
        return new Response(JSON.stringify({ error: 'Invalid userAddress' }), { status: 400, headers });
      }

      // Use hub wallet for gas topups (already funded on startup)
      const hub = await getHubWallet(env);
      if (!hub) {
        faucetLock.release();
        return new Response(JSON.stringify({ error: 'No faucet hub available' }), { status: 503, headers });
      }
      const hubWallet = hub.wallet;

      const topupAmount = ethers.parseEther(amount);
      const pendingNonce = await hubWallet.getNonce('pending');
      if (faucetNonce === null || pendingNonce > faucetNonce) {
        faucetNonce = pendingNonce;
      }
      const nonce = faucetNonce;
      const tx = await hubWallet.sendTransaction({
        to: userAddress,
        value: topupAmount,
        nonce,
      });
      faucetNonce = nonce + 1;
      await tx.wait();
      console.log(`[${logPrefix}] ETH topup tx=${tx.hash}`);

      faucetLock.release();
      return new Response(
        JSON.stringify({
          success: true,
          type: 'gas',
          amount,
          userAddress,
          txHash: tx.hash,
          requestId,
        }),
        { headers },
      );
    } catch (error: any) {
      faucetLock.release();
      console.error('[FAUCET/GAS] Error:', error);
      return new Response(JSON.stringify({ error: error.message }), { status: 500, headers });
    }
  }

  // Faucet B: Hub reserve → user reserve via processBatch
  if (pathname === '/api/faucet/reserve' && req.method === 'POST') {
    // Acquire mutex to prevent nonce collisions
    await faucetLock.acquire();
    try {
      if (!globalJAdapter) {
        faucetLock.release();
        return new Response(JSON.stringify({ error: 'J-adapter not initialized' }), { status: 503, headers });
      }
      if (!env) {
        faucetLock.release();
        return new Response(JSON.stringify({ error: 'Runtime not initialized' }), { status: 503, headers });
      }

      const body = await req.json();
      const userEntityId = body?.userEntityId;
      const rawTokenId = body?.tokenId ?? 1;
      let tokenId = typeof rawTokenId === 'number' ? rawTokenId : Number(rawTokenId);
      const tokenSymbol = typeof body?.tokenSymbol === 'string' ? body.tokenSymbol : undefined;
      const amount = typeof body?.amount === 'string' ? body.amount : String(body?.amount ?? '100');
      const requestId =
        globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      const logPrefix = `FAUCET/RESERVE ${requestId}`;

      if (!userEntityId) {
        faucetLock.release();
        return new Response(JSON.stringify({ error: 'Missing userEntityId' }), { status: 400, headers });
      }
      if (!Number.isFinite(tokenId)) {
        faucetLock.release();
        return new Response(JSON.stringify({ error: 'Invalid tokenId' }), { status: 400, headers });
      }

      // Get hub from server-authoritative hub set + gossip
      const hubs = getFaucetHubProfiles(env);
      if (hubs.length === 0) {
        faucetLock.release();
        return new Response(
          JSON.stringify({
            error: 'No faucet hub available',
            code: 'FAUCET_HUBS_EMPTY',
            profiles: env.gossip?.getProfiles?.()?.length || 0,
            activeHubEntityIds: relayStore.activeHubEntityIds,
          }),
          { status: 503, headers },
        );
      }
      const hubEntityId = hubs[0].entityId;

      const hubSignerId = resolveEntityProposerId(env, hubEntityId, 'faucet-reserve');
      const tokenCatalog = await ensureTokenCatalog();
      let tokenMeta = tokenCatalog.find(t => Number(t.tokenId) === Number(tokenId));
      if (!tokenMeta && tokenSymbol) {
        tokenMeta = tokenCatalog.find(t => t.symbol?.toUpperCase?.() === tokenSymbol.toUpperCase());
        if (tokenMeta?.tokenId !== undefined && tokenMeta?.tokenId !== null) {
          tokenId = Number(tokenMeta.tokenId);
        }
      }
      if (!tokenMeta) {
        faucetLock.release();
        return new Response(JSON.stringify({ error: `Unknown token for faucet`, tokenId, tokenSymbol }), {
          status: 400,
          headers,
        });
      }
      const decimals = typeof tokenMeta.decimals === 'number' ? tokenMeta.decimals : 18;
      const amountWei = ethers.parseUnits(amount, decimals);
      console.log(
        `[${logPrefix}] Request: hub=${hubEntityId.slice(0, 16)}... signer=${hubSignerId} → user=${userEntityId.slice(0, 16)}... tokenId=${tokenId} symbol=${tokenMeta.symbol} amount=${amount} decimals=${decimals}`,
      );

      const prevUserReserve = await globalJAdapter.getReserves(userEntityId, tokenId).catch(() => 0n);
      let hubReplicaKey = Array.from(env.eReplicas?.keys?.() || []).find(key => key.startsWith(`${hubEntityId}:`));
      let hubReplica = hubReplicaKey ? env.eReplicas?.get(hubReplicaKey) : null;
      const hubReserve = hubReplica?.state?.reserves?.get(String(tokenId)) ?? 0n;
      console.log(`[${logPrefix}] Hub reserve before R2R: token ${tokenId} = ${hubReserve.toString()}`);
      if (hubReserve < amountWei) {
        faucetLock.release();
        return new Response(
          JSON.stringify({
            error: `Hub has insufficient reserves for token ${tokenId}`,
            have: hubReserve.toString(),
            need: amountWei.toString(),
            requestId,
          }),
          { status: 409, headers },
        );
      }

      // Use entity txs (R2R + j_broadcast) instead of direct admin call.
      // Single-writer invariant: enqueue only; runtime loop applies.
      enqueueRuntimeInput(env, {
        runtimeTxs: [],
        entityInputs: [
          {
            entityId: hubEntityId,
            signerId: hubSignerId,
            entityTxs: [
              {
                type: 'reserve_to_reserve',
                data: {
                  toEntityId: userEntityId,
                  tokenId,
                  amount: amountWei,
                },
              },
              {
                type: 'j_broadcast',
                data: {},
              },
            ],
          },
        ],
      });
      // Log hub jBatchState summary after queuing
      hubReplicaKey = Array.from(env.eReplicas?.keys?.() || []).find(key => key.startsWith(`${hubEntityId}:`));
      hubReplica = hubReplicaKey ? env.eReplicas?.get(hubReplicaKey) : null;
      if (hubReplica?.state?.jBatchState?.batch) {
        const batch = hubReplica.state.jBatchState.batch as any;
        console.log(
          `[${logPrefix}] Hub jBatch: r2r=${batch.reserveToReserve?.length || 0}, r2c=${batch.reserveToCollateral?.length || 0}, c2r=${batch.collateralToReserve?.length || 0}, settlements=${batch.settlements?.length || 0}, sentPending=${hubReplica.state.jBatchState.sentBatch ? 'yes' : 'no'}`,
        );
      }
      if (env.jReplicas) {
        for (const [name, replica] of env.jReplicas.entries()) {
          if ((replica.mempool?.length ?? 0) > 0) {
            console.log(
              `[${logPrefix}] J-mempool "${name}": size=${replica.mempool.length}, block=${replica.blockNumber ?? 0}, lastTs=${replica.lastBlockTimestamp ?? 0}`,
            );
          }
        }
      }
      console.log(`[${logPrefix}] R2R + j_broadcast queued (waiting for J-event sync)`);
      await waitForRuntimeIdle(env, 5000);

      const jBatchCleared = await waitForJBatchClear(env, 5000);
      if (!jBatchCleared) {
        faucetLock.release();
        return new Response(
          JSON.stringify({
            error: 'J-batch did not broadcast in time',
            requestId,
          }),
          { status: 504, headers },
        );
      }

      const expectedMin = prevUserReserve + amountWei;
      const updatedReserve = await waitForReserveUpdate(userEntityId, tokenId, expectedMin, 10000);
      if (updatedReserve === null) {
        faucetLock.release();
        return new Response(
          JSON.stringify({
            error: 'Reserve update not confirmed on-chain',
            requestId,
          }),
          { status: 504, headers },
        );
      }

      faucetLock.release();
      return new Response(
        JSON.stringify({
          success: true,
          type: 'reserve',
          amount,
          tokenId,
          from: hubEntityId.slice(0, 16) + '...',
          to: userEntityId.slice(0, 16) + '...',
          requestId,
        }),
        { headers },
      );
    } catch (error: any) {
      faucetLock.release();
      console.error('[FAUCET/RESERVE] Error:', error);
      return new Response(JSON.stringify({ error: error.message }), { status: 500, headers });
    }
  }

  // Faucet C: Offchain payment via bilateral account
  if (pathname === '/api/faucet/offchain' && req.method === 'POST') {
    try {
      if (!env) {
        return new Response(JSON.stringify({ error: 'Runtime not initialized' }), { status: 503, headers });
      }

      const body = await req.json();
      const {
        userEntityId,
        userRuntimeId,
        tokenId = 1,
        amount = '100',
        hubEntityId: requestedHubEntityId,
        knownAccount,
      } = body;
      const requestId = `offchain_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

      if (!userEntityId) {
        return new Response(JSON.stringify({ error: 'Missing userEntityId' }), { status: 400, headers });
      }
      if (!isEntityId32(userEntityId)) {
        return new Response(
          JSON.stringify({
            error: `Invalid userEntityId: expected bytes32 hex, got "${String(userEntityId)}"`,
            code: 'FAUCET_INVALID_USER_ENTITY_ID',
          }),
          { status: 400, headers },
        );
      }
      if (
        requestedHubEntityId !== undefined &&
        requestedHubEntityId !== null &&
        requestedHubEntityId !== '' &&
        !isEntityId32(requestedHubEntityId)
      ) {
        return new Response(
          JSON.stringify({
            error: `Invalid hubEntityId: expected bytes32 hex, got "${String(requestedHubEntityId)}"`,
            code: 'FAUCET_INVALID_HUB_ENTITY_ID',
          }),
          { status: 400, headers },
        );
      }
      const normalizedUserEntityId = String(userEntityId).toLowerCase();
      const allProfiles = env.gossip?.getProfiles() || [];
      let normalizedUserRuntimeId = normalizeRuntimeKey(userRuntimeId);
      if (!normalizedUserRuntimeId) {
        const userProfile = allProfiles.find(
          (p: any) => String(p?.entityId || '').toLowerCase() === normalizedUserEntityId,
        );
        const profileRuntimeId = normalizeRuntimeKey(userProfile?.runtimeId);
        if (profileRuntimeId) {
          normalizedUserRuntimeId = profileRuntimeId;
        }
      }
      if (!normalizedUserRuntimeId) {
        return new Response(
          JSON.stringify({
            success: false,
            code: 'FAUCET_RUNTIME_REQUIRED',
            error: 'Missing userRuntimeId',
            message: 'Runtime is offline or not initialized yet. Re-open runtime and retry faucet.',
          }),
          { status: 400, headers },
        );
      }
      const normalizedRuntimeKey = normalizeRuntimeKey(normalizedUserRuntimeId);
      // Important: local relay client registry is authoritative only when faucet API
      // and relay endpoint are the same node. With external relay (e.g. wss://xln.finance/relay),
      // this process may not see the runtime socket directly. Treat local visibility as diagnostic,
      // not a hard reject.
      const runtimeSeenLocally = relayStore.clients.has(normalizedRuntimeKey);
      const runtimePubKey = relayStore.runtimeEncryptionKeys.get(normalizedRuntimeKey);
      if (!runtimeSeenLocally || !runtimePubKey) {
        pushDebugEvent(relayStore, {
          event: 'debug_event',
          status: 'warning',
          reason: !runtimeSeenLocally ? 'FAUCET_RUNTIME_NOT_LOCAL_RELAY_CLIENT' : 'FAUCET_RUNTIME_PUBKEY_MISSING_LOCAL',
          details: {
            endpoint: '/api/faucet/offchain',
            userEntityId: normalizedUserEntityId,
            userRuntimeId: normalizedUserRuntimeId,
            runtimeSeenLocally,
            hasRuntimePubKey: !!runtimePubKey,
          },
        });
      }
      // Get hub from server-authoritative hub set + gossip
      const userSuffix = normalizedUserEntityId.slice(-8);
      console.log(`[FAUCET/OFFCHAIN] profiles=${allProfiles.length} user=${userSuffix}`);
      for (const p of allProfiles) {
        const entityId = typeof p?.entityId === 'string' ? p.entityId : 'unknown';
        const capabilities = Array.isArray(p?.capabilities) ? p.capabilities.join(',') : '';
        console.log(
          `  profile: ${entityId === 'unknown' ? entityId : entityId.slice(-8)} isHub=${p?.metadata?.isHub === true} caps=[${capabilities}]`,
        );
      }
      const gossipHubs = getFaucetHubProfiles(env);
      const activeHubCandidates = relayStore.activeHubEntityIds
        .map(entityId => ({ entityId }))
        .filter(hub => !!hub.entityId);
      // Server authority first: if hubs are active on this server, faucet can always target them
      // without depending on client gossip freshness.
      const hubs = activeHubCandidates.length > 0 ? activeHubCandidates : gossipHubs;
      if (hubs.length === 0) {
        pushDebugEvent(relayStore, {
          event: 'error',
          status: 'rejected',
          reason: 'FAUCET_HUBS_EMPTY',
          details: {
            endpoint: '/api/faucet/offchain',
            profiles: allProfiles.length,
            activeHubEntityIds: relayStore.activeHubEntityIds,
            gossipHubCount: gossipHubs.length,
            hint: 'No faucet-capable hubs in server active set or gossip cache',
          },
        });
        return new Response(
          JSON.stringify({
            error: 'No faucet hub available in gossip',
            code: 'FAUCET_HUBS_EMPTY',
            profiles: allProfiles.length,
            activeHubEntityIds: relayStore.activeHubEntityIds,
            gossipHubCount: gossipHubs.length,
          }),
          { status: 503, headers },
        );
      }
      const requestedHubId =
        typeof requestedHubEntityId === 'string' && requestedHubEntityId.length > 0
          ? requestedHubEntityId.toLowerCase()
          : '';
      const requestedHub = requestedHubId ? hubs.find(hub => hub.entityId.toLowerCase() === requestedHubId) : undefined;
      if (requestedHubId && !requestedHub) {
        return new Response(
          JSON.stringify({
            error: `Requested hub not found: ${requestedHubId}`,
            code: 'FAUCET_REQUESTED_HUB_NOT_FOUND',
            requestedHubEntityId: requestedHubId,
            knownHubEntityIds: hubs.map(h => h.entityId),
          }),
          { status: 404, headers },
        );
      }
      const accountInfoByHub = hubs.map(hub => {
        const machine = getAccountMachine(env, hub.entityId, normalizedUserEntityId);
        const accountExists = hasAccount(env, hub.entityId, normalizedUserEntityId) || !!machine;
        return {
          hub,
          hasAccount: accountExists,
          pending: accountExists ? !!machine?.pendingFrame : false,
        };
      });
      const existingReadyHubAccount = accountInfoByHub.find(entry => entry.hasAccount && !entry.pending)?.hub;
      const existingHubAccount = accountInfoByHub.find(entry => entry.hasAccount)?.hub;
      // If caller requested a hub explicitly, always honor it.
      // Auto-open path will create account on that exact hub if needed.
      const selectedHub = requestedHub ?? existingReadyHubAccount ?? existingHubAccount ?? hubs[0];
      if (!selectedHub) {
        return new Response(JSON.stringify({ error: 'No faucet hub available' }), { status: 503, headers });
      }
      const hubEntityId = selectedHub.entityId;
      console.log(
        `[FAUCET/OFFCHAIN] selectedHub=${hubEntityId.slice(-8)} requested=${requestedHubId ? requestedHubId.slice(-8) : 'none'} ` +
          `existingHubAccount=${existingHubAccount?.entityId?.slice(-8) ?? 'none'}`,
      );
      if (!getEntityReplicaById(env, hubEntityId)) {
        return new Response(
          JSON.stringify({
            error: 'Faucet hub is not ready yet',
            code: 'FAUCET_HUB_NOT_READY',
            hubEntityId,
          }),
          { status: 503, headers },
        );
      }
      // Get actual signerId from entity's validators (not runtimeId!)
      let hubSignerId: string;
      try {
        hubSignerId = resolveEntityProposerId(env, hubEntityId, 'faucet-offchain');
      } catch (error) {
        return new Response(
          JSON.stringify({
            error: 'Faucet hub signer is unavailable',
            code: 'FAUCET_HUB_SIGNER_UNAVAILABLE',
            hubEntityId,
            details: (error as Error).message,
          }),
          { status: 503, headers },
        );
      }
      console.log(
        `[FAUCET/OFFCHAIN] hub=${hubEntityId.slice(-8)} signer=${hubSignerId.slice(-8)} amount=${amount} token=${tokenId}`,
      );
      pushDebugEvent(relayStore, {
        event: 'debug_event',
        status: 'info',
        reason: 'REB_STEP0_FAUCET_REQUEST',
        details: {
          requestId,
          hubEntityId,
          userEntityId: normalizedUserEntityId,
          userRuntimeId: normalizedUserRuntimeId,
          tokenId,
          amount,
        },
      });

      const amountWei = ethers.parseUnits(amount, 18);
      const accountMachine = getAccountMachine(env, hubEntityId, normalizedUserEntityId);
      const hasHubAccount = hasAccount(env, hubEntityId, normalizedUserEntityId) || !!accountMachine;
      const accountPending = hasHubAccount ? !!accountMachine?.pendingFrame : false;
      const serverCurrentHeight = Number(accountMachine?.currentHeight ?? 0);
      const serverPendingHeight = accountMachine?.pendingFrame?.height ?? null;
      const knownCurrentHeightRaw = (knownAccount as any)?.currentHeight;
      const knownCurrentHeight =
        knownCurrentHeightRaw !== undefined && Number.isFinite(Number(knownCurrentHeightRaw))
          ? Number(knownCurrentHeightRaw)
          : null;
      const knownPending = Boolean((knownAccount as any)?.hasPending);
      const knownPendingHeightRaw = (knownAccount as any)?.pendingHeight;
      const knownPendingHeight =
        knownPendingHeightRaw !== undefined && knownPendingHeightRaw !== null && Number.isFinite(Number(knownPendingHeightRaw))
          ? Number(knownPendingHeightRaw)
          : null;
      const knownAnchorHeight = Math.max(knownCurrentHeight ?? 0, knownPendingHeight ?? 0);
      const accountPresence = hubs.map(hub => ({
        hubEntityId: hub.entityId,
        hasAccount: hasAccount(env, hub.entityId, normalizedUserEntityId),
      }));
      const autoOpenAccount = false;

      // Fail-fast: client already has unresolved pending frame for this account.
      // Never enqueue new faucet payment in this state (prevents conflict loops).
      if (knownPending) {
        pushDebugEvent(relayStore, {
          event: 'error',
          status: 'rejected',
          reason: 'FAUCET_CLIENT_PENDING_FRAME',
          details: {
            requestId,
            hubEntityId,
            userEntityId: normalizedUserEntityId,
            knownCurrentHeight,
            knownPendingHeight,
            serverCurrentHeight,
            serverPendingHeight,
          },
        });
        return new Response(
          JSON.stringify({
            success: false,
            error: `Client reports pending frame (${knownPendingHeight ?? 'unknown'}). Wait for ACK/dispute before faucet.`,
            code: 'FAUCET_CLIENT_PENDING_FRAME',
            requestId,
            hubEntityId,
            userEntityId: normalizedUserEntityId,
            knownCurrentHeight,
            knownPendingHeight,
            serverCurrentHeight,
            serverPendingHeight,
          }),
          { status: 409, headers },
        );
      }

      // Fail-fast: never queue faucet tx while bilateral account has pending frame.
      // This avoids piling up directPayment/openAccount txs during stalled consensus.
      if (hasHubAccount && accountPending) {
        pushDebugEvent(relayStore, {
          event: 'error',
          status: 'rejected',
          reason: 'FAUCET_ACCOUNT_PENDING_FRAME',
          details: {
            requestId,
            hubEntityId,
            userEntityId: normalizedUserEntityId,
            pendingHeight: serverPendingHeight,
            currentHeight: serverCurrentHeight,
          },
        });
        return new Response(
          JSON.stringify({
            success: false,
            error: `Account with hub is pending at frame ${serverPendingHeight ?? 'unknown'}. Wait for ACK/dispute before new faucet.`,
            code: 'FAUCET_ACCOUNT_PENDING_FRAME',
            requestId,
            hubEntityId,
            userEntityId: normalizedUserEntityId,
            pendingHeight: serverPendingHeight,
            currentHeight: serverCurrentHeight,
          }),
          { status: 409, headers },
        );
      }

      // Explicit invariant: faucet never opens accounts on behalf of user.
      // User must create/open account first via regular bilateral flow.
      if (!hasHubAccount) {
        pushDebugEvent(relayStore, {
          event: 'error',
          status: 'rejected',
          reason: 'FAUCET_ACCOUNT_NOT_OPEN',
          details: {
            requestId,
            hubEntityId,
            userEntityId: normalizedUserEntityId,
            requestedHubEntityId: requestedHubId || null,
            accountPresence,
          },
        });
        return new Response(
          JSON.stringify({
            success: false,
            error: 'No bilateral account with selected hub. Open account first, then retry faucet.',
            code: 'FAUCET_ACCOUNT_NOT_OPEN',
            requestId,
            hubEntityId,
            userEntityId: normalizedUserEntityId,
            requestedHubEntityId: requestedHubId || null,
            accountPresence,
          }),
          { status: 409, headers },
        );
      }

      // Fail-fast: detect client/server account chain mismatch and refuse auto-open.
      // Typical case: server reset while browser kept old bilateral chain.
      if (knownAnchorHeight > 0 || knownPending) {
        const serverMissingOrFresh = !hasHubAccount || serverCurrentHeight === 0;
        const serverFarBehind = hasHubAccount && serverCurrentHeight + 3 < knownAnchorHeight;
        if (serverMissingOrFresh || serverFarBehind) {
          pushDebugEvent(relayStore, {
            event: 'error',
            status: 'rejected',
            reason: 'FAUCET_ACCOUNT_STATE_MISMATCH',
            details: {
              requestId,
              hubEntityId,
              userEntityId: normalizedUserEntityId,
              knownCurrentHeight,
              knownPending,
              knownPendingHeight,
              knownAnchorHeight,
              serverHasAccount: hasHubAccount,
              serverCurrentHeight,
              serverPendingHeight,
            },
          });
          return new Response(
            JSON.stringify({
              success: false,
              error:
                'Account state mismatch (client has older/newer chain than server). Reset runtime network or re-open runtime before faucet.',
              code: 'FAUCET_ACCOUNT_STATE_MISMATCH',
              requestId,
              hubEntityId,
              userEntityId: normalizedUserEntityId,
              knownCurrentHeight,
              knownPending,
              knownPendingHeight,
              knownAnchorHeight,
              serverHasAccount: hasHubAccount,
              serverCurrentHeight,
              serverPendingHeight,
            }),
            { status: 409, headers },
          );
        }
      }

      // Single-writer invariant: enqueue only; runtime loop applies.
      try {
        const hubPolicy = getEntityReplicaById(env, hubEntityId)?.state?.hubRebalanceConfig;
        const faucetDescription = encodeRebalancePolicyMemo('faucet-offchain', {
          policyVersion:
            Number.isFinite(Number(hubPolicy?.policyVersion)) && Number(hubPolicy?.policyVersion) > 0
              ? Number(hubPolicy?.policyVersion)
              : 1,
          baseFee: hubPolicy?.rebalanceBaseFee ?? 10n ** 17n,
          liquidityFeeBps: hubPolicy?.rebalanceLiquidityFeeBps ?? hubPolicy?.minFeeBps ?? 1n,
          gasFee: hubPolicy?.rebalanceGasFee ?? 0n,
        });
        const entityTxs: Array<{ type: string; data: Record<string, unknown> }> = [{
          type: 'directPayment',
          data: {
            targetEntityId: normalizedUserEntityId,
            tokenId,
            amount: amountWei,
            route: [hubEntityId, normalizedUserEntityId],
            description: faucetDescription,
          },
        }];
        enqueueRuntimeInput(env, {
          runtimeTxs: [],
          entityInputs: [
            {
              entityId: hubEntityId,
              signerId: hubSignerId,
              entityTxs,
            },
          ],
        });
      } catch (error) {
        return new Response(
          JSON.stringify({
            error: 'Failed to enqueue faucet payment',
            code: 'FAUCET_PAYMENT_ENQUEUE_FAILED',
            details: (error as Error).message,
          }),
          { status: 503, headers },
        );
      }
      console.log(`[FAUCET/OFFCHAIN] ✅ Payment accepted`);

      return new Response(
        JSON.stringify({
          success: true,
          type: 'offchain',
          status: 'queued',
          requestId,
          amount,
          tokenId,
          from: hubEntityId.slice(0, 16) + '...',
          to: normalizedUserEntityId.slice(0, 16) + '...',
          accountReady: hasHubAccount,
          accountPending,
          autoOpenAccount: false,
          accountPresence,
        }),
        { headers },
      );
    } catch (error: any) {
      console.error('[FAUCET/OFFCHAIN] Error:', error);
      const message = error?.message || 'Unknown faucet error';
      const status =
        message.includes('SIGNER_RESOLUTION_FAILED') || message.includes('RUNTIME_REPLICA_NOT_FOUND') ? 503 : 500;
      return new Response(JSON.stringify({ error: message }), { status, headers });
    }
  }

  return new Response(JSON.stringify({ error: 'Not found' }), { status: 404, headers });
};

// ============================================================================
// MAIN SERVER
// ============================================================================

export async function startXlnServer(opts: Partial<XlnServerOptions> = {}): Promise<void> {
  installProcessSafetyGuards();
  console.log('═══ startXlnServer() CALLED ═══');
  console.log('Options:', opts);
  const options = { ...DEFAULT_OPTIONS, ...opts };
  activeServerOptions = { ...options };
  relayStore = createRelayStore(options.serverId ?? DEFAULT_OPTIONS.serverId ?? 'xln-server');
  const advertisedRelayUrl = resolveAdvertisedRelayUrl(options.port);
  const internalRelayUrl = resolveConfiguredRelayUrl(options.port);

  // Always initialize runtime - every node needs it
  console.log('[XLN] Initializing runtime...');
  const env = await main(HUB_SEED);
  console.log('[XLN] Runtime initialized ✓');
  env.runtimeState = env.runtimeState ?? {};
  env.runtimeState.directEntityInputDispatch = (targetRuntimeId, input) =>
    sendEntityInputDirectViaRelaySocket(env, targetRuntimeId, input);
  startRuntimeLoop(env);
  console.log('[XLN] Runtime event loop started ✓');

  // Initialize J-adapter (anvil for testnet, browserVM for local)
  const anvilRpc = process.env.ANVIL_RPC || 'http://localhost:8545';
  const useAnvil = process.env.USE_ANVIL === 'true';

  console.log('[XLN] J-adapter mode check:');
  console.log('  USE_ANVIL =', useAnvil);
  console.log('  ANVIL_RPC =', anvilRpc);

  let activeJName: string | null = null;

  if (useAnvil) {
    console.log('[XLN] Connecting to Anvil testnet...');
    const usePredeployedAddresses = process.env.XLN_USE_PREDEPLOYED_ADDRESSES === 'true';

    // Optional: reuse addresses from jurisdictions.json (disabled by default).
    const fs = await import('fs/promises');
    const path = await import('path');
    let fromReplica = undefined;
    if (usePredeployedAddresses) {
      try {
        // Canonical source first, then legacy/root fallbacks.
        const candidates = [
          path.join(process.cwd(), 'jurisdictions', 'jurisdictions.json'),
          path.join(process.cwd(), 'jurisdictions.json'),
          '/root/xln/jurisdictions/jurisdictions.json',
          '/root/xln/jurisdictions.json',
        ];
        const jurisdictionsPath = await candidates.reduce<Promise<string>>(async (foundPromise, candidate) => {
          const found = await foundPromise;
          if (found) return found;
          try {
            await fs.access(candidate);
            return candidate;
          } catch {
            return '';
          }
        }, Promise.resolve(''));
        if (!jurisdictionsPath) {
          throw new Error('No jurisdictions.json found in canonical or legacy locations');
        }
        console.log(`[XLN] Loading predeployed addresses from: ${jurisdictionsPath}`);
        const jurisdictionsData = await fs.readFile(jurisdictionsPath, 'utf-8');
        const jurisdictions = JSON.parse(jurisdictionsData);
        const arrakisConfig = jurisdictions?.jurisdictions?.arrakis;

        if (arrakisConfig?.contracts) {
          fromReplica = {
            depositoryAddress: arrakisConfig.contracts.depository,
            entityProviderAddress: arrakisConfig.contracts.entityProvider,
            contracts: arrakisConfig.contracts,
            chainId: arrakisConfig.chainId ?? 31337,
          } as any;
          console.log('[XLN] Loaded predeployed contract addresses from jurisdictions.json');
        }
      } catch (err) {
        console.warn('[XLN] Could not load predeployed addresses, will deploy fresh:', (err as Error).message);
      }
    } else {
      console.log('[XLN] Fresh deploy mode enabled (XLN_USE_PREDEPLOYED_ADDRESSES!=true)');
    }

    // Wait for ANVIL to be ready (retry up to 30s)
    let detectedChainId = 31337;
    const maxRetries = 30;
    let anvilReady = false;
    for (let i = 0; i < maxRetries; i++) {
      try {
        const probe = new ethers.JsonRpcProvider(anvilRpc);
        const network = await probe.getNetwork();
        if (network?.chainId) detectedChainId = Number(network.chainId);
        anvilReady = true;
        console.log(`[XLN] ✅ ANVIL ready (chainId: ${detectedChainId})`);
        break;
      } catch (err) {
        if (i === 0) console.log(`[XLN] ⏳ Waiting for ANVIL at ${anvilRpc}...`);
        await new Promise(r => setTimeout(r, 1000));
      }
    }
    if (!anvilReady) {
      throw new Error(
        `❌ FAIL-FAST: ANVIL not reachable at ${anvilRpc} after ${maxRetries}s. Is anvil running?`,
      );
    }
    if (detectedChainId !== 31337) {
      throw new Error(`❌ FAIL-FAST: expected ANVIL chainId=31337, got ${detectedChainId} at ${anvilRpc}`);
    }

    // Ensure fromReplica carries correct chainId (override if stale)
    if (fromReplica && fromReplica.chainId !== detectedChainId) {
      console.warn(
        `[XLN] fromReplica chainId (${fromReplica.chainId}) does not match RPC chainId (${detectedChainId}) - overriding`,
      );
      fromReplica.chainId = detectedChainId as any;
    }

    globalJAdapter = await createJAdapter({
      mode: 'rpc',
      chainId: detectedChainId,
      rpcUrl: anvilRpc,
      fromReplica, // Pass pre-deployed addresses (if available)
    });

    const block = await globalJAdapter.provider.getBlockNumber();
    console.log(`[XLN] Anvil connected (block: ${block})`);

    // Ensure jurisdictions.json reflects current RPC + addresses (even if using fromReplica)
    if (globalJAdapter.addresses?.depository && globalJAdapter.addresses?.entityProvider) {
      await updateJurisdictionsJson(globalJAdapter.addresses, anvilRpc, detectedChainId);
    }

    const hasAddresses = !!globalJAdapter.addresses?.depository && !!globalJAdapter.addresses?.entityProvider;

    // Deploy if addresses missing (fresh anvil path).
    if (!hasAddresses) {
      console.log('[XLN] Deploying contracts to anvil (missing addresses)...');
      await globalJAdapter.deployStack();
      await updateJurisdictionsJson(globalJAdapter.addresses, anvilRpc, detectedChainId);
      console.log('[XLN] Contracts deployed');
    } else if (fromReplica) {
      console.log('[XLN] Using pre-deployed contracts from jurisdictions.json');
    } else {
      console.log('[XLN] Using existing contracts on anvil');
    }

    // Ensure env has a J-replica for this RPC jurisdiction (required for j_broadcast → j-mempool)
    if (globalJAdapter && env) {
      if (!env.jReplicas) env.jReplicas = new Map();
      const jName = 'arrakis';
      if (!env.jReplicas.has(jName)) {
        env.jReplicas.set(jName, {
          name: jName,
          blockNumber: 0n,
          stateRoot: new Uint8Array(32),
          mempool: [],
          blockDelayMs: 300,
          lastBlockTimestamp: env.timestamp,
          position: { x: 0, y: 50, z: 0 },
          depositoryAddress: globalJAdapter.addresses.depository,
          entityProviderAddress: globalJAdapter.addresses.entityProvider,
          contracts: globalJAdapter.addresses,
          rpcs: [anvilRpc],
          chainId: globalJAdapter.chainId,
          jadapter: globalJAdapter,
        });
        console.log(`[XLN] J-replica "${jName}" registered in env`);
      }
      if (!env.activeJurisdiction) env.activeJurisdiction = jName;
      activeJName = jName;
    }
  } else {
    console.log('[XLN] Using BrowserVM (local mode)');
    globalJAdapter = await createJAdapter({
      mode: 'browservm',
      chainId: 31337,
    });
    await globalJAdapter.deployStack();
    if (globalJAdapter && env) {
      if (!env.jReplicas) env.jReplicas = new Map();
      const jName = 'local';
      if (!env.jReplicas.has(jName)) {
        env.jReplicas.set(jName, {
          name: jName,
          blockNumber: 0n,
          stateRoot: new Uint8Array(32),
          mempool: [],
          blockDelayMs: 300,
          lastBlockTimestamp: env.timestamp,
          position: { x: 0, y: 50, z: 0 },
          depositoryAddress: globalJAdapter.addresses.depository,
          entityProviderAddress: globalJAdapter.addresses.entityProvider,
          contracts: globalJAdapter.addresses,
          rpcs: [],
          chainId: globalJAdapter.chainId,
          jadapter: globalJAdapter,
        });
        console.log(`[XLN] J-replica "${jName}" registered in env`);
      }
      if (!env.activeJurisdiction) env.activeJurisdiction = jName;
      activeJName = jName;
    }
  }

  // Start J-event watcher now that env + jReplica are wired.
  // Without this, AccountSettled/ReserveUpdated never enter runtimeInput.
  if (globalJAdapter && env) {
    try {
      globalJAdapter.startWatching(env);
      console.log(`[XLN] J-event watcher started (${activeJName || env.activeJurisdiction || 'unknown'})`);
    } catch (err) {
      console.error('[XLN] Failed to start J-event watcher:', err);
    }
  }

  const hubEntityIds = await bootstrapServerHubsAndReserves(env, options, advertisedRelayUrl, anvilRpc);

  // Wire relay-router + local delivery
  const localDeliver = createLocalDeliveryHandler(env, relayStore, getEntityReplicaById);
  const routerConfig: RelayRouterConfig = {
    store: relayStore,
    localRuntimeId: env.runtimeId,
    localDeliver,
    send: (ws, data) => ws.send(data),
    onGossipStore: profile => {
      try {
        env.gossip?.announce?.(profile);
      } catch {
        /* best effort */
      }
    },
  };

  const server = Bun.serve({
    port: options.port,
    hostname: options.host,

    async fetch(req, server) {
      const url = new URL(req.url);
      const pathname = url.pathname;

      // WebSocket upgrade
      if (req.headers.get('upgrade') === 'websocket') {
        const wsType = pathname === '/relay' ? 'relay' : pathname === '/rpc' ? 'rpc' : null;
        if (wsType) {
          const upgraded = server.upgrade(req, { data: { type: wsType, env } });
          if (upgraded) return undefined as any;
        }
        return new Response('WebSocket upgrade failed', { status: 400 });
      }

      // REST API (+ hard reset shortcut at /reset + JSON-RPC /rpc endpoint)
      if (
        pathname.startsWith('/api/') ||
        pathname === '/reset' ||
        pathname === '/rpc'
      ) {
        try {
          return await handleApi(req, pathname, env);
        } catch (error) {
          const message = (error as Error)?.message || 'API handler failed';
          console.error(`[API] Unhandled route error (${pathname}): ${message}`);
          pushDebugEvent(relayStore, {
            event: 'error',
            reason: 'API_HANDLER_EXCEPTION',
            details: { pathname, message },
          });
          return new Response(safeStringify({ error: message, code: 'API_HANDLER_EXCEPTION' }), {
            status: 500,
            headers: { 'Content-Type': 'application/json' },
          });
        }
      }

      // Static files
      if (options.staticDir) {
        // Runtime bundle is served from canonical runtime locations.
        if (pathname === '/runtime.js') {
          const runtimeBundle = await serveRuntimeBundle();
          if (runtimeBundle) return runtimeBundle;
        }

        // Root → index.html
        if (pathname === '/') {
          const index = await serveStatic('/index.html', options.staticDir);
          if (index) return index;
        }

        // Try static file
        const file = await serveStatic(pathname, options.staticDir);
        if (file) return file;

        // SPA fallback
        const fallback = await serveStatic('/index.html', options.staticDir);
        if (fallback) return fallback;
      }

      return new Response('Not found', { status: 404 });
    },

    websocket: {
      open(ws) {
        const data = (ws as any).data;
        console.log(`[WS] New ${data.type} connection`);
        pushDebugEvent(relayStore, {
          event: 'ws_open',
          details: { wsType: data.type },
        });
      },

      message(ws, message) {
        const data = (ws as any).data;
        const msgStr = message.toString();
        try {
          const msg = JSON.parse(msgStr);
          if (data.type === 'relay') {
            Promise.resolve(relayRoute(routerConfig, ws, msg)).catch(error => {
              const reason = (error as Error).message || 'relay handler error';
              console.error(`[WS] Relay handler error: ${reason}`);
              pushDebugEvent(relayStore, {
                event: 'error',
                reason: 'RELAY_HANDLER_EXCEPTION',
                details: {
                  error: reason,
                  msgType: msg?.type,
                  from: msg?.from,
                  to: msg?.to,
                },
              });
              try {
                ws.send(safeStringify({ type: 'error', error: 'Relay handler exception' }));
              } catch {
                // Socket may already be closed; ignore.
              }
            });
          } else if (data.type === 'rpc') {
            Promise.resolve(handleRpcMessage(ws, msg, data.env)).catch(error => {
              const reason = (error as Error).message || 'rpc handler error';
              console.error(`[WS] RPC handler error: ${reason}`);
              pushDebugEvent(relayStore, {
                event: 'error',
                reason: 'RPC_HANDLER_EXCEPTION',
                details: { error: reason, msgType: msg?.type },
              });
              try {
                ws.send(safeStringify({ type: 'error', error: 'RPC handler exception' }));
              } catch {
                // Socket may already be closed; ignore.
              }
            });
          }
        } catch (error) {
          console.error(`[WS] Parse error (type=${data.type}, len=${msgStr.length}):`, error);
          pushDebugEvent(relayStore, {
            event: 'error',
            reason: 'Invalid JSON',
            details: { wsType: data.type, len: msgStr.length, error: (error as Error).message },
          });
          ws.send(safeStringify({ type: 'error', error: 'Invalid JSON' }));
        }
      },

      close(ws) {
        const removedId = removeClient(relayStore, ws);
        if (removedId) {
          pushDebugEvent(relayStore, {
            event: 'ws_close',
            runtimeId: removedId,
            from: removedId,
            details: { wsType: ((ws as any).data || {}).type || 'unknown' },
          });
        }
      },
    },
  });

  // Start P2P overlay for hub announcements only after WS /relay is actually listening.
  if (hubEntityIds.length > 0) {
    startP2P(env, {
      relayUrls: [internalRelayUrl],
      advertiseEntityIds: hubEntityIds,
      isHub: true, // CRITICAL: Mark as hub so profiles get isHub metadata
      // Avoid background gossip request spam on the server runtime.
      // Hub profiles are pushed on connect and on major entity changes.
      gossipPollMs: 0,
    });
  }

  console.log(`
╔══════════════════════════════════════════════════════════════════╗
║                      XLN Unified Server                          ║
╠══════════════════════════════════════════════════════════════════╣
║  Port: ${String(options.port).padEnd(10)}                                       ║
║  Host: ${(options.host || '0.0.0.0').padEnd(10)}                                       ║
║  Mode: ${(globalJAdapter ? globalJAdapter.mode : 'no-jadapter').padEnd(10)}                                       ║
╠══════════════════════════════════════════════════════════════════╣
║  Endpoints:                                                      ║
║    GET  /                     → SPA                              ║
║    WS   /relay                → P2P relay                        ║
║    WS   /rpc                  → Remote UI                        ║
║    GET  /api/health           → Health check                     ║
║    GET  /api/state            → Runtime state                    ║
║    GET  /api/clients          → Connected clients                ║
║    POST /api/faucet/erc20     → Faucet A (wallet ERC20)          ║
║    POST /api/faucet/reserve   → Faucet B (reserve transfer)      ║
║    POST /api/faucet/offchain  → Faucet C (account payment)       ║
╚══════════════════════════════════════════════════════════════════╝
  `);

  return;
}

// ============================================================================
// CLI ENTRY POINT
// ============================================================================

if (import.meta.main) {
  console.log('═══ SERVER.TS ENTRY POINT ═══');
  console.log('ENV: USE_ANVIL =', process.env.USE_ANVIL);
  console.log('ENV: ANVIL_RPC =', process.env.ANVIL_RPC);
  console.log('Args:', process.argv.slice(2));

  const args = process.argv.slice(2);

  const getArg = (name: string, fallback?: string): string | undefined => {
    const idx = args.indexOf(name);
    if (idx === -1) return fallback;
    return args[idx + 1] || fallback;
  };

  const options: Partial<XlnServerOptions> = {
    port: Number(getArg('--port', '8080')),
    host: getArg('--host', '0.0.0.0'),
    staticDir: getArg('--static-dir', './frontend/build'),
    serverId: getArg('--server-id', 'xln-server'),
  };

  console.log('Calling startXlnServer with options:', options);

  startXlnServer(options)
    .then(() => {
      console.log('[XLN] Server started successfully');
    })
    .catch(error => {
      console.error('[XLN] Server failed:', error);
      console.error('Stack:', error.stack);
      process.exit(1);
    });
}
