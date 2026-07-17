import { ethers } from 'ethers';
import { deriveSignerAddressSync, deriveSignerKeySync } from '../account/crypto';
import { getTokenInfo } from '../account/utils';
import { encodeBoard, hashBoard } from '../entity/factory';
import { DEFAULT_SPREAD_DISTRIBUTION } from '../orderbook';
import { deserializeTaggedJson, serializeTaggedJson } from '../protocol/serialization';
import type { RuntimeIngressReceipt } from '../server/ingress-receipts';
import type { ConsensusConfig, RoutedEntityInput, RuntimeInput } from '../types';
import { scaleWholeTokenAmount } from '../types';

const DEFAULT_TIMEOUT_MS = 10_000;
const WAIT_POLL_MS = 100;
const DEFAULT_ROUTING_FEE_PPM = 1;
const DEFAULT_ROUTING_BASE_FEE = 0n;
const DEFAULT_SWAP_TAKER_FEE_BPS = 1;
const DEFAULT_REBALANCE_LIQUIDITY_FEE_BPS = 1n;
const DEFAULT_REBALANCE_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_ORDERBOOK_MIN_TRADE_SIZE = 10n * 10n ** 18n;
const DEFAULT_ORDERBOOK_SUPPORTED_PAIRS = ['1/2', '1/3', '2/3'] as const;
const DEFAULT_CUSTODY_CREDIT_WHOLE = 100_000_000_000n;
const DEFAULT_CUSTODY_CREDIT_TOKEN_IDS = [1, 2, 3] as const;

export type ControlEntitySummary = {
  entityId: string;
  signerId: string;
  name: string;
  isRoutingEnabled: boolean;
  runtimeId: string | null;
  accountCount: number;
  publicAccountCount: number;
  accountEntityIds: string[];
};

export type ControlQueueResponse = {
  ok: boolean;
  accepted?: {
    runtimeTxs: number;
    entityInputs: number;
    jInputs: number;
  };
  receipt?: RuntimeIngressReceipt;
  statusUrl?: string;
  error?: string;
};

type ControlRuntimeStatusResponse = {
  ok: boolean;
  receipt?: RuntimeIngressReceipt | null;
  currentHeight?: number;
  runtime?: {
    halted?: boolean;
    fatalDebugPayload?: unknown;
    latestQuarantine?: unknown;
  } | null;
  error?: string;
};

type GossipProfileResponse = {
  ok: boolean;
  found: boolean;
  profile?: { entityId?: string } | null;
};

export type ManagedEntityConfig = {
  name: string;
  seed: string;
  signerLabel: string;
  position?: { x: number; y: number; z: number };
};

export type EnableRoutingConfig = ManagedEntityConfig & {
  relayUrl?: string;
  routingFeePPM?: number;
  baseFee?: bigint;
  swapTakerFeeBps?: number;
  gossipPollMs?: number;
  initOrderbook?: boolean;
};

export type SetupCustodyConfig = ManagedEntityConfig & {
  relayUrl?: string;
  hubEntityIds?: string[];
  creditAmount?: bigint;
  creditTokenIds?: number[];
  gossipPollMs?: number;
  routingEnabled?: boolean;
  routingFeePPM?: number;
  baseFee?: bigint;
  swapTakerFeeBps?: number;
};

export type ManagedEntityIdentity = {
  entityId: string;
  signerId: string;
  privateKeyHex: string;
  consensusConfig: ConsensusConfig;
  position: { x: number; y: number; z: number };
  name: string;
};

export type DaemonControlClientOptions = {
  baseUrl: string;
  authKey?: string;
  timeoutMs?: number;
};

const normalizeBaseUrl = (value: string): string => {
  let normalized = value;
  while (normalized.endsWith('/')) normalized = normalized.slice(0, -1);
  return normalized;
};

const sleep = async (ms: number): Promise<void> => {
  await new Promise(resolve => setTimeout(resolve, ms));
};

const fetchWithTimeout = async (
  url: string,
  init: RequestInit,
  timeoutMs: number,
  label: string,
): Promise<Response> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(`${label} timed out after ${timeoutMs}ms`), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
};

export const deriveManagedEntityIdentity = (config: ManagedEntityConfig): ManagedEntityIdentity => {
  const signerPrivateKey = deriveSignerKeySync(config.seed, config.signerLabel);
  const signerId = deriveSignerAddressSync(config.seed, config.signerLabel).toLowerCase();
  const consensusConfig: ConsensusConfig = {
    mode: 'proposer-based',
    threshold: 1n,
    validators: [signerId],
    shares: { [signerId]: 1n },
  };
  return {
    entityId: hashBoard(encodeBoard(consensusConfig)),
    signerId,
    privateKeyHex: ethers.hexlify(signerPrivateKey).toLowerCase(),
    consensusConfig,
    position: config.position ?? { x: 0, y: 0, z: 0 },
    name: config.name,
  };
};

export class DaemonControlClient {
  private baseUrl: string;
  private authKey: string | undefined;
  private timeoutMs: number;

  constructor(options: DaemonControlClientOptions) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl);
    this.authKey = options.authKey;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  private buildHeaders(): HeadersInit {
    return {
      'content-type': 'application/json',
      ...(this.authKey ? { authorization: `Bearer ${this.authKey}` } : {}),
    };
  }

  private async get<T>(path: string): Promise<T> {
    const response = await fetchWithTimeout(
      `${this.baseUrl}${path}`,
      {
        method: 'GET',
        headers: this.buildHeaders(),
      },
      this.timeoutMs,
      `GET ${path}`,
    );
    const raw = await response.text();
    const payload = raw.trim().length > 0 ? deserializeTaggedJson<T | { error?: string }>(raw) : ({} as T);
    if (!response.ok) {
      const message =
        typeof (payload as { error?: string })?.error === 'string'
          ? (payload as { error?: string }).error!
          : `${response.status} ${response.statusText}`;
      throw new Error(message);
    }
    return payload as T;
  }

  private async post<TResponse, TBody>(path: string, body: TBody): Promise<TResponse> {
    const response = await fetchWithTimeout(
      `${this.baseUrl}${path}`,
      {
        method: 'POST',
        headers: this.buildHeaders(),
        body: serializeTaggedJson(body),
      },
      this.timeoutMs,
      `POST ${path}`,
    );
    const raw = await response.text();
    const payload = raw.trim().length > 0 ? deserializeTaggedJson<TResponse | { error?: string }>(raw) : ({} as TResponse);
    if (!response.ok) {
      const message =
        typeof (payload as { error?: string })?.error === 'string'
          ? (payload as { error?: string }).error!
          : `${response.status} ${response.statusText}`;
      throw new Error(message);
    }
    return payload as TResponse;
  }

  async listEntities(): Promise<ControlEntitySummary[]> {
    const response = await this.get<{ ok: boolean; entities: ControlEntitySummary[] }>('/api/control/entities');
    return Array.isArray(response.entities) ? response.entities : [];
  }

  async registerSigner(signerId: string, privateKeyHex: string): Promise<void> {
    await this.post<{ ok: boolean; signerId: string }, { signerId: string; privateKeyHex: string }>(
      '/api/control/signers/register',
      { signerId, privateKeyHex },
    );
  }

  async queueRuntimeInput(input: RuntimeInput): Promise<ControlQueueResponse> {
    const response = await this.post<ControlQueueResponse, RuntimeInput>('/api/control/runtime-input', input);
    if (response.ok !== true) {
      throw new Error(response.error || 'CONTROL_RUNTIME_INPUT_REJECTED');
    }
    if (!response.receipt || !response.statusUrl) {
      throw new Error(`CONTROL_RUNTIME_INPUT_NO_RECEIPT: ${serializeTaggedJson(response)}`);
    }
    return response;
  }

  async hasGossipProfile(entityId: string): Promise<boolean> {
    const response = await this.get<GossipProfileResponse>(
      `/api/gossip/profile?entityId=${encodeURIComponent(entityId)}`,
    );
    return response.ok === true && response.found === true;
  }

  async configureP2P(config: {
    relayUrls?: string[];
    advertiseEntityIds?: string[];
    gossipPollMs?: number;
  }): Promise<void> {
    await this.post<{ ok: boolean }, typeof config>('/api/control/p2p', config);
  }

  async getRuntimeInputStatus(statusUrl: string): Promise<ControlRuntimeStatusResponse> {
    const path = statusUrl.startsWith('/') ? statusUrl : `/${statusUrl}`;
    const response = await this.get<ControlRuntimeStatusResponse>(path);
    if (response.ok !== true) {
      throw new Error(response.error || 'CONTROL_RUNTIME_INPUT_STATUS_FAILED');
    }
    return response;
  }

  async waitForEntity(entityId: string, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<ControlEntitySummary> {
    const startedAt = Date.now();
    const target = entityId.toLowerCase();
    while (Date.now() - startedAt < timeoutMs) {
      const entities = await this.listEntities();
      const match = entities.find(entity => entity.entityId.toLowerCase() === target);
      if (match) return match;
      await sleep(WAIT_POLL_MS);
    }
    throw new Error(`Timed out waiting for entity ${entityId}`);
  }
}

const summarizeRuntimeInputStatus = (status: ControlRuntimeStatusResponse): string =>
  serializeTaggedJson({
    receipt: status.receipt
      ? {
          id: status.receipt.id,
          status: status.receipt.status,
          enqueuedHeight: status.receipt.enqueuedHeight,
          observedHeight: status.receipt.observedHeight ?? null,
          counts: status.receipt.counts,
          note: status.receipt.note ?? null,
        }
      : null,
    currentHeight: status.currentHeight ?? null,
    runtime: status.runtime ?? null,
  });

const waitForQueuedRuntimeInputObserved = async (
  client: DaemonControlClient,
  response: ControlQueueResponse,
  label: string,
  timeoutMs = 15_000,
): Promise<void> => {
  const statusUrl = response.statusUrl;
  if (!statusUrl) {
    throw new Error(`CONTROL_RUNTIME_INPUT_NO_STATUS_URL: ${label}`);
  }
  const deadline = Date.now() + timeoutMs;
  let lastStatus: ControlRuntimeStatusResponse | null = null;
  while (Date.now() < deadline) {
    const status = await client.getRuntimeInputStatus(statusUrl);
    lastStatus = status;
    const runtime = status.runtime;
    const quarantine = runtime?.latestQuarantine;
    if (runtime?.halted === true || quarantine) {
      throw new Error(
        `CONTROL_RUNTIME_INPUT_FAILED: ${label} status=${summarizeRuntimeInputStatus(status)}`,
      );
    }
    if (status.receipt?.status === 'observed') return;
    if (status.receipt?.status === 'expired') {
      throw new Error(
        `CONTROL_RUNTIME_INPUT_EXPIRED: ${label} status=${summarizeRuntimeInputStatus(status)}`,
      );
    }
    await sleep(WAIT_POLL_MS);
  }
  throw new Error(
    `CONTROL_RUNTIME_INPUT_NOT_OBSERVED: ${label} ` +
    `status=${lastStatus ? summarizeRuntimeInputStatus(lastStatus) : 'none'}`,
  );
};

const buildImportReplicaInput = (identity: ManagedEntityIdentity): RuntimeInput => ({
  runtimeTxs: [
    {
      type: 'importReplica',
      entityId: identity.entityId,
      signerId: identity.signerId,
      data: {
        config: identity.consensusConfig,
        isProposer: true,
        profileName: identity.name,
        position: identity.position,
      },
    },
  ],
  entityInputs: [],
});

const buildEnableRoutingEntityInput = (
  identity: ManagedEntityIdentity,
  config: EnableRoutingConfig,
): RoutedEntityInput => ({
  entityId: identity.entityId,
  signerId: identity.signerId,
  entityTxs: [
    {
      type: 'setHubConfig',
      data: {
        matchingStrategy: 'amount',
        policyVersion: 1,
        routingFeePPM: config.routingFeePPM ?? DEFAULT_ROUTING_FEE_PPM,
        baseFee: config.baseFee ?? DEFAULT_ROUTING_BASE_FEE,
        swapTakerFeeBps: config.swapTakerFeeBps ?? DEFAULT_SWAP_TAKER_FEE_BPS,
        rebalanceLiquidityFeeBps: DEFAULT_REBALANCE_LIQUIDITY_FEE_BPS,
        rebalanceTimeoutMs: DEFAULT_REBALANCE_TIMEOUT_MS,
      },
    },
    ...(config.initOrderbook === false
      ? []
      : [{
          type: 'initOrderbookExt' as const,
          data: {
            name: config.name,
            spreadDistribution: DEFAULT_SPREAD_DISTRIBUTION,
            referenceTokenId: 1,
            minTradeSize: DEFAULT_ORDERBOOK_MIN_TRADE_SIZE,
            supportedPairs: [...DEFAULT_ORDERBOOK_SUPPORTED_PAIRS],
          },
        }]),
  ],
});

const buildCustodyConnectivityInput = (
  identity: ManagedEntityIdentity,
  config: SetupCustodyConfig,
  missingHubEntityIds: readonly string[],
): RuntimeInput | null => {
  const hubEntityIds = (config.hubEntityIds || []).map(id => id.trim().toLowerCase()).filter(Boolean);
  if (hubEntityIds.length === 0) return null;
  const creditTokenIds = (config.creditTokenIds && config.creditTokenIds.length > 0
    ? config.creditTokenIds
    : [...DEFAULT_CUSTODY_CREDIT_TOKEN_IDS]
  )
    .map(value => Number(value))
    .filter(value => Number.isFinite(value) && value > 0);
  const entityTxs: RuntimeInput['entityInputs'][number]['entityTxs'] = [];
  for (const hubEntityId of missingHubEntityIds) {
    entityTxs.push({
      type: 'openAccount',
      data: { targetEntityId: hubEntityId },
    });
  }
  for (const hubEntityId of hubEntityIds) {
    for (const tokenId of creditTokenIds) {
      const creditAmount = config.creditAmount ?? scaleWholeTokenAmount(
        DEFAULT_CUSTODY_CREDIT_WHOLE,
        getTokenInfo(tokenId).decimals,
      );
      entityTxs.push({
        type: 'extendCredit',
        data: {
          counterpartyEntityId: hubEntityId,
          tokenId,
          amount: creditAmount,
        },
      });
    }
  }
  return {
    runtimeTxs: [],
    entityInputs: [
      {
        entityId: identity.entityId,
        signerId: identity.signerId,
        entityTxs,
      },
    ],
  };
};

export const ensureManagedEntity = async (
  client: DaemonControlClient,
  config: ManagedEntityConfig,
): Promise<ManagedEntityIdentity> => {
  const identity = deriveManagedEntityIdentity(config);
  await client.registerSigner(identity.signerId, identity.privateKeyHex);
  const existing = await client.listEntities();
  const alreadyPresent = existing.some(entity => entity.entityId.toLowerCase() === identity.entityId.toLowerCase());
  if (!alreadyPresent) {
    const response = await client.queueRuntimeInput(buildImportReplicaInput(identity));
    await waitForQueuedRuntimeInputObserved(client, response, `importReplica:${identity.entityId}`);
  }
  await client.waitForEntity(identity.entityId);
  return identity;
};

export const enableRouting = async (
  client: DaemonControlClient,
  config: EnableRoutingConfig,
): Promise<ManagedEntityIdentity> => {
  const identity = await ensureManagedEntity(client, config);
  const response = await client.queueRuntimeInput({
    runtimeTxs: [],
    entityInputs: [buildEnableRoutingEntityInput(identity, config)],
  });
  await waitForQueuedRuntimeInputObserved(client, response, `enableRouting:${identity.entityId}`);
  await configureManagedEntityP2P(client, identity, config);
  return identity;
};

export const becomeHub = enableRouting;

const configureManagedEntityP2P = async (
  client: DaemonControlClient,
  identity: ManagedEntityIdentity,
  config: Pick<SetupCustodyConfig, 'relayUrl' | 'gossipPollMs'>,
): Promise<void> => {
  await client.configureP2P({
    ...(config.relayUrl ? { relayUrls: [config.relayUrl] } : {}),
    advertiseEntityIds: [identity.entityId],
    gossipPollMs: config.gossipPollMs ?? 1000,
  });
};

const waitForGossipProfiles = async (
  client: DaemonControlClient,
  entityIds: readonly string[],
  timeoutMs = 15_000,
): Promise<void> => {
  const normalizedIds = entityIds.map(id => id.trim().toLowerCase()).filter(Boolean);
  const deadline = Date.now() + timeoutMs;
  let missingIds = [...normalizedIds];
  while (Date.now() < deadline) {
    const visible: string[] = [];
    for (const entityId of normalizedIds) {
      if (await client.hasGossipProfile(entityId)) visible.push(entityId);
    }
    missingIds = normalizedIds.filter(entityId => !visible.includes(entityId));
    if (missingIds.length === 0) return;
    await sleep(250);
  }
  throw new Error(`CUSTODY_HUB_PROFILES_NOT_VISIBLE: missing=${missingIds.join(',')}`);
};

export const setupCustody = async (
  client: DaemonControlClient,
  config: SetupCustodyConfig,
): Promise<ManagedEntityIdentity> => {
  const identity = await ensureManagedEntity(client, config);
  await configureManagedEntityP2P(client, identity, config);
  const hubEntityIds = (config.hubEntityIds || []).map(id => id.trim().toLowerCase()).filter(Boolean);
  if (hubEntityIds.length > 0) {
    await waitForGossipProfiles(client, hubEntityIds);
    const entities = await client.listEntities();
    const custodySummary = entities.find(entity => entity.entityId.toLowerCase() === identity.entityId.toLowerCase());
    const existingAccountEntityIds = new Set(
      Array.isArray(custodySummary?.accountEntityIds)
        ? custodySummary.accountEntityIds.map(value => String(value).toLowerCase())
        : [],
    );
    const missingHubEntityIds = hubEntityIds.filter(hubEntityId => !existingAccountEntityIds.has(hubEntityId));
    const connectivityInput = buildCustodyConnectivityInput(identity, config, missingHubEntityIds);
    if (connectivityInput) {
      const response = await client.queueRuntimeInput(connectivityInput);
      await waitForQueuedRuntimeInputObserved(client, response, `custodyConnectivity:${identity.entityId}`);
      if (missingHubEntityIds.length > 0) {
        let latestAccountEntityIds = existingAccountEntityIds;
        const deadline = Date.now() + 15_000;
        while (Date.now() < deadline) {
          const refreshedEntities = await client.listEntities();
          const refreshedSummary = refreshedEntities.find(entity => entity.entityId.toLowerCase() === identity.entityId.toLowerCase());
          const refreshedAccountEntityIds = new Set(
            Array.isArray(refreshedSummary?.accountEntityIds)
              ? refreshedSummary.accountEntityIds.map(value => String(value).toLowerCase())
              : [],
          );
          latestAccountEntityIds = refreshedAccountEntityIds;
          if (hubEntityIds.every(hubEntityId => refreshedAccountEntityIds.has(hubEntityId))) {
            break;
          }
          await sleep(250);
        }
        const stillMissingHubIds = hubEntityIds.filter(hubEntityId => !latestAccountEntityIds.has(hubEntityId));
        if (stillMissingHubIds.length > 0) {
          throw new Error(
            `CUSTODY_CONNECTIVITY_ACCOUNTS_NOT_OPEN: entity=${identity.entityId} ` +
            `missing=${stillMissingHubIds.join(',')} accounts=${Array.from(latestAccountEntityIds).join(',')}`,
          );
        }
      }
    }
  }
  if (config.routingEnabled) {
    const response = await client.queueRuntimeInput({
      runtimeTxs: [],
      entityInputs: [buildEnableRoutingEntityInput(identity, config)],
    });
    await waitForQueuedRuntimeInputObserved(client, response, `custodyRouting:${identity.entityId}`);
  }
  return identity;
};
