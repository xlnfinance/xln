import { ethers } from 'ethers';
import { deriveSignerAddressSync, deriveSignerKeySync } from '../account-crypto';
import { encodeBoard, hashBoard } from '../entity-factory';
import { DEFAULT_SPREAD_DISTRIBUTION } from '../orderbook';
import { deserializeTaggedJson, serializeTaggedJson } from '../serialization-utils';
import type { ConsensusConfig, RoutedEntityInput, RuntimeInput } from '../types';

const DEFAULT_TIMEOUT_MS = 10_000;
const WAIT_POLL_MS = 100;
const DEFAULT_ROUTING_FEE_PPM = 1000;
const DEFAULT_ROUTING_BASE_FEE = 5n * 10n ** 18n;
const DEFAULT_REBALANCE_BASE_FEE = 10n ** 17n;
const DEFAULT_REBALANCE_LIQUIDITY_FEE_BPS = 1n;
const DEFAULT_REBALANCE_GAS_FEE = 0n;
const DEFAULT_REBALANCE_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_ORDERBOOK_MIN_TRADE_SIZE = 50n * 10n ** 18n;
const DEFAULT_ORDERBOOK_SUPPORTED_PAIRS = ['1/2', '1/3', '2/3'] as const;
const DEFAULT_CUSTODY_CREDIT_AMOUNT = 10_000n * 10n ** 18n;
const DEFAULT_CUSTODY_CREDIT_TOKEN_IDS = [1, 2, 3] as const;

export type ControlEntitySummary = {
  entityId: string;
  signerId: string;
  name: string;
  isRoutingEnabled: boolean;
  runtimeId: string | null;
  accountCount: number;
  publicAccountCount: number;
};

export type ControlQueueResponse = {
  ok: boolean;
  queued: {
    runtimeTxs: number;
    entityInputs: number;
    jInputs: number;
  };
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
  controlToken?: string;
  timeoutMs?: number;
};

const normalizeBaseUrl = (value: string): string => value.replace(/\/+$/, '');

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
  private controlToken?: string;
  private timeoutMs: number;

  constructor(options: DaemonControlClientOptions) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl);
    this.controlToken = options.controlToken;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  private buildHeaders(): HeadersInit {
    return {
      'content-type': 'application/json',
      ...(this.controlToken ? { 'x-daemon-control-token': this.controlToken } : {}),
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
    return await this.post<ControlQueueResponse, RuntimeInput>('/api/control/runtime-input', input);
  }

  async configureP2P(config: {
    relayUrls?: string[];
    advertiseEntityIds?: string[];
    isHub?: boolean;
    profileName?: string;
    gossipPollMs?: number;
  }): Promise<void> {
    await this.post<{ ok: boolean }, typeof config>('/api/control/p2p', config);
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
        rebalanceBaseFee: DEFAULT_REBALANCE_BASE_FEE,
        rebalanceLiquidityFeeBps: DEFAULT_REBALANCE_LIQUIDITY_FEE_BPS,
        rebalanceGasFee: DEFAULT_REBALANCE_GAS_FEE,
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
): RuntimeInput | null => {
  const hubEntityIds = (config.hubEntityIds || []).map(id => id.trim().toLowerCase()).filter(Boolean);
  if (hubEntityIds.length === 0) return null;
  const creditAmount = config.creditAmount ?? DEFAULT_CUSTODY_CREDIT_AMOUNT;
  const creditTokenIds = (config.creditTokenIds && config.creditTokenIds.length > 0
    ? config.creditTokenIds
    : [...DEFAULT_CUSTODY_CREDIT_TOKEN_IDS]
  )
    .map(value => Number(value))
    .filter(value => Number.isFinite(value) && value > 0);
  const entityTxs: RuntimeInput['entityInputs'][number]['entityTxs'] = [];
  for (const hubEntityId of hubEntityIds) {
    entityTxs.push({
      type: 'openAccount',
      data: { targetEntityId: hubEntityId },
    });
    for (const tokenId of creditTokenIds) {
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
    await client.queueRuntimeInput(buildImportReplicaInput(identity));
  }
  await client.waitForEntity(identity.entityId);
  return identity;
};

export const enableRouting = async (
  client: DaemonControlClient,
  config: EnableRoutingConfig,
): Promise<ManagedEntityIdentity> => {
  const identity = await ensureManagedEntity(client, config);
  await client.queueRuntimeInput({
    runtimeTxs: [],
    entityInputs: [buildEnableRoutingEntityInput(identity, config)],
  });
  await client.configureP2P({
    ...(config.relayUrl ? { relayUrls: [config.relayUrl] } : {}),
    advertiseEntityIds: [identity.entityId],
    isHub: true,
    profileName: config.name,
    gossipPollMs: config.gossipPollMs ?? 0,
  });
  return identity;
};

export const becomeHub = enableRouting;

export const setupCustody = async (
  client: DaemonControlClient,
  config: SetupCustodyConfig,
): Promise<ManagedEntityIdentity> => {
  const identity = await ensureManagedEntity(client, config);
  const connectivityInput = buildCustodyConnectivityInput(identity, config);
  if (connectivityInput) {
    await client.queueRuntimeInput(connectivityInput);
  }
  if (config.routingEnabled) {
    await enableRouting(client, {
      ...config,
      routingFeePPM: config.routingFeePPM,
      baseFee: config.baseFee,
    });
  } else {
    await client.configureP2P({
      ...(config.relayUrl ? { relayUrls: [config.relayUrl] } : {}),
      advertiseEntityIds: [identity.entityId],
      isHub: false,
      profileName: config.name,
      gossipPollMs: config.gossipPollMs ?? 5000,
    });
  }
  return identity;
};
