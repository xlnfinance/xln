import { ethers } from 'ethers';
import { deriveSignerAddressSync, deriveSignerKeySync } from '../account/crypto';
import { getTokenInfo } from '../account/utils';
import { encodeBoard, hashBoard } from '../entity/factory';
import { DEFAULT_SPREAD_DISTRIBUTION } from '../orderbook';
import { deserializeTaggedJson, serializeTaggedJson } from '../protocol/serialization';
import type { ConsensusConfig } from '../entity/types';
import type { JurisdictionConfig } from '../protocol/config/jurisdiction-config';
import type { RoutedEntityInput, RuntimeInput } from '../runtime/types';
import { scaleWholeTokenAmount } from '../types/finance/rebalance';
import { defaultAccountDisputeConfigForRoleEvidence } from '../account/config/dispute-config';
import {
  requireBoundaryInteger,
  requireBoundaryRecord,
  requireExactBoundaryKeys,
} from '../protocol/boundary-validation';
import { canonicalEntitySeed, importEntity } from '../runtime/registration/entity-creation';
import { parseProfile, type DecodedProfile } from '../entity/profile';

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
  isHub: boolean;
  runtimeId: string | null;
  accountCount: number;
  publicAccountCount: number;
  accountEntityIds: string[];
};

type ControlQueueResponse = {
  ok: boolean;
  accepted?: {
    runtimeTxs: number;
    entityInputs: number;
    jInputs: number;
  };
  error?: string;
};

export type ControlRuntimeSnapshot = Readonly<{
  runtimeId: string;
  height: number;
  checkpointHash: string;
}>;

const decodeControlEntitySummary = (value: unknown): ControlEntitySummary => {
  const summary = requireBoundaryRecord(value, 'CONTROL_ENTITY_SUMMARY_INVALID');
  requireExactBoundaryKeys(
    summary,
    [
      'entityId', 'signerId', 'name', 'isRoutingEnabled', 'isHub', 'runtimeId',
      'accountCount', 'publicAccountCount', 'accountEntityIds',
    ],
    [],
    'CONTROL_ENTITY_SUMMARY_FIELDS_INVALID',
  );
  const requiredText = (key: 'entityId' | 'signerId' | 'name'): string => {
    const text = String(summary[key] || '').trim();
    if (!text || typeof summary[key] !== 'string') {
      throw new Error(`CONTROL_ENTITY_SUMMARY_${key.toUpperCase()}_INVALID`);
    }
    return text;
  };
  if (typeof summary['isRoutingEnabled'] !== 'boolean' || typeof summary['isHub'] !== 'boolean') {
    throw new Error('CONTROL_ENTITY_SUMMARY_ROLE_INVALID');
  }
  const runtimeId = summary['runtimeId'];
  if (runtimeId !== null && (typeof runtimeId !== 'string' || !runtimeId.trim())) {
    throw new Error('CONTROL_ENTITY_SUMMARY_RUNTIME_ID_INVALID');
  }
  const accountEntityIds = summary['accountEntityIds'];
  if (!Array.isArray(accountEntityIds) || accountEntityIds.some(value => typeof value !== 'string' || !value.trim())) {
    throw new Error('CONTROL_ENTITY_SUMMARY_ACCOUNT_IDS_INVALID');
  }
  return {
    entityId: requiredText('entityId').toLowerCase(),
    signerId: requiredText('signerId').toLowerCase(),
    name: requiredText('name'),
    isRoutingEnabled: summary['isRoutingEnabled'],
    isHub: summary['isHub'],
    runtimeId: runtimeId === null ? null : runtimeId.trim().toLowerCase(),
    accountCount: requireBoundaryInteger(summary['accountCount'], 'CONTROL_ENTITY_SUMMARY_ACCOUNT_COUNT_INVALID'),
    publicAccountCount: requireBoundaryInteger(summary['publicAccountCount'], 'CONTROL_ENTITY_SUMMARY_PUBLIC_ACCOUNT_COUNT_INVALID'),
    accountEntityIds: accountEntityIds.map(value => value.trim().toLowerCase()),
  };
};

type GossipProfileResponse = {
  ok: boolean;
  found: boolean;
  profile?: DecodedProfile | null;
};

const responseErrorMessage = (value: unknown, defaultMessage: string): string => {
  try {
    const response = requireBoundaryRecord(value, 'CONTROL_RESPONSE_INVALID');
    return typeof response['error'] === 'string' && response['error'].trim()
      ? response['error']
      : defaultMessage;
  } catch {
    return defaultMessage;
  }
};

const decodeNullableStringList = (value: unknown, code: string): void => {
  if (value === null) return;
  if (!Array.isArray(value) || value.some(entry => typeof entry !== 'string' || entry.length === 0)) {
    throw new Error(code);
  }
};

const decodeP2PControlResponse = (value: unknown): void => {
  const response = requireBoundaryRecord(value, 'CONTROL_P2P_RESPONSE_INVALID');
  requireExactBoundaryKeys(response, ['ok', 'config'], [], 'CONTROL_P2P_RESPONSE_FIELDS_INVALID');
  if (response['ok'] !== true) throw new Error('CONTROL_P2P_RESPONSE_INVALID');
  const config = requireBoundaryRecord(response['config'], 'CONTROL_P2P_RESPONSE_CONFIG_INVALID');
  requireExactBoundaryKeys(
    config,
    ['relayUrls', 'advertiseEntityIds', 'gossipPollMs'],
    [],
    'CONTROL_P2P_RESPONSE_CONFIG_FIELDS_INVALID',
  );
  decodeNullableStringList(config['relayUrls'], 'CONTROL_P2P_RESPONSE_RELAY_URLS_INVALID');
  decodeNullableStringList(config['advertiseEntityIds'], 'CONTROL_P2P_RESPONSE_ENTITY_IDS_INVALID');
  if (config['gossipPollMs'] !== null) {
    requireBoundaryInteger(config['gossipPollMs'], 'CONTROL_P2P_RESPONSE_GOSSIP_POLL_MS_INVALID', 250);
  }
};

const decodeControlQueueResponse = (value: unknown): ControlQueueResponse => {
  const response = requireBoundaryRecord(value, 'CONTROL_RUNTIME_INPUT_RESPONSE_INVALID');
  requireExactBoundaryKeys(
    response,
    ['ok'],
    ['accepted', 'error'],
    'CONTROL_RUNTIME_INPUT_RESPONSE_FIELDS_INVALID',
  );
  if (typeof response['ok'] !== 'boolean') throw new Error('CONTROL_RUNTIME_INPUT_RESPONSE_OK_INVALID');
  const acceptedRaw = response['accepted'];
  let accepted: ControlQueueResponse['accepted'];
  if (acceptedRaw !== undefined) {
    const raw = requireBoundaryRecord(acceptedRaw, 'CONTROL_RUNTIME_INPUT_ACCEPTED_INVALID');
    requireExactBoundaryKeys(raw, ['runtimeTxs', 'entityInputs', 'jInputs'], [], 'CONTROL_RUNTIME_INPUT_ACCEPTED_FIELDS_INVALID');
    accepted = {
      runtimeTxs: requireBoundaryInteger(raw['runtimeTxs'], 'CONTROL_RUNTIME_INPUT_ACCEPTED_RUNTIME_TXS_INVALID'),
      entityInputs: requireBoundaryInteger(raw['entityInputs'], 'CONTROL_RUNTIME_INPUT_ACCEPTED_ENTITY_INPUTS_INVALID'),
      jInputs: requireBoundaryInteger(raw['jInputs'], 'CONTROL_RUNTIME_INPUT_ACCEPTED_J_INPUTS_INVALID'),
    };
  }
  if (response['error'] !== undefined && typeof response['error'] !== 'string') {
    throw new Error('CONTROL_RUNTIME_INPUT_ERROR_INVALID');
  }
  return {
    ok: response['ok'],
    ...(accepted === undefined ? {} : { accepted }),
    ...(response['error'] === undefined ? {} : { error: response['error'] }),
  };
};

const decodeGossipProfileResponse = (value: unknown): GossipProfileResponse => {
  const response = requireBoundaryRecord(value, 'GOSSIP_PROFILE_RESPONSE_INVALID');
  requireExactBoundaryKeys(
    response,
    ['ok', 'entityId', 'found', 'profile', 'peers'],
    [],
    'GOSSIP_PROFILE_RESPONSE_FIELDS_INVALID',
  );
  if (typeof response['ok'] !== 'boolean' || typeof response['found'] !== 'boolean') {
    throw new Error('GOSSIP_PROFILE_RESPONSE_FLAGS_INVALID');
  }
  if (typeof response['entityId'] !== 'string' || response['entityId'].length === 0) {
    throw new Error('GOSSIP_PROFILE_RESPONSE_ENTITY_ID_INVALID');
  }
  const profile = response['profile'];
  if ((profile !== null) !== response['found']) {
    throw new Error('GOSSIP_PROFILE_RESPONSE_FOUND_MISMATCH');
  }
  const decodedProfile = profile === null ? null : parseProfile(profile);
  if (!Array.isArray(response['peers'])) throw new Error('GOSSIP_PROFILE_RESPONSE_PEERS_INVALID');
  for (const peer of response['peers']) {
    parseProfile(peer);
  }
  return {
    ok: response['ok'],
    found: response['found'],
    profile: decodedProfile,
  };
};

export type ManagedEntityConfig = {
  name: string;
  seed: string;
  signerLabel: string;
  position?: { x: number; y: number; z: number };
  jurisdiction?: JurisdictionConfig;
};

export type EnableRoutingConfig = ManagedEntityConfig & {
  usdQuoteAuthorityEntityId: string;
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
  usdQuoteAuthorityEntityId?: string;
  routingFeePPM?: number;
  baseFee?: bigint;
  swapTakerFeeBps?: number;
};

export type ManagedEntityIdentity = {
  entityId: string;
  signerId: string;
  privateKeyHex: string;
  entitySeed: string;
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
    ...(config.jurisdiction ? { jurisdiction: config.jurisdiction } : {}),
  };
  return {
    entityId: hashBoard(encodeBoard(consensusConfig)),
    signerId,
    privateKeyHex: ethers.hexlify(signerPrivateKey).toLowerCase(),
    entitySeed: canonicalEntitySeed(config.seed),
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

  private async get(path: string): Promise<unknown> {
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
    const payload = raw.trim().length > 0 ? deserializeTaggedJson(raw) : {};
    if (!response.ok) {
      throw new Error(responseErrorMessage(payload, `${response.status} ${response.statusText}`));
    }
    return payload;
  }

  private async post(path: string, body: unknown): Promise<unknown> {
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
    const payload = raw.trim().length > 0 ? deserializeTaggedJson(raw) : {};
    if (!response.ok) {
      throw new Error(responseErrorMessage(payload, `${response.status} ${response.statusText}`));
    }
    return payload;
  }

  async listEntities(): Promise<ControlEntitySummary[]> {
    const raw = await this.get('/api/control/entities');
    const response = requireBoundaryRecord(raw, 'CONTROL_ENTITIES_RESPONSE_INVALID');
    requireExactBoundaryKeys(
      response,
      ['ok', 'runtimeId', 'entities'],
      [],
      'CONTROL_ENTITIES_RESPONSE_FIELDS_INVALID',
    );
    if (response['ok'] !== true || !Array.isArray(response['entities'])) {
      throw new Error('CONTROL_ENTITIES_RESPONSE_INVALID');
    }
    const runtimeId = response['runtimeId'];
    if (runtimeId !== null && (typeof runtimeId !== 'string' || !runtimeId.trim())) {
      throw new Error('CONTROL_ENTITIES_RESPONSE_RUNTIME_ID_INVALID');
    }
    const normalizedRuntimeId = runtimeId === null ? null : runtimeId.trim().toLowerCase();
    const entities = response['entities'].map(decodeControlEntitySummary);
    if (entities.some(entity => entity.runtimeId !== normalizedRuntimeId)) {
      // Every row comes from this exact authenticated Runtime. A mismatched
      // provenance would let an operator bind a committed role from one
      // Runtime while opening the Account on another.
      throw new Error('CONTROL_ENTITIES_RESPONSE_RUNTIME_ID_MISMATCH');
    }
    return entities;
  }

  async registerSigner(signerId: string, privateKeyHex: string): Promise<void> {
    const raw = await this.post(
      '/api/control/signers/register',
      { signerId, privateKeyHex },
    );
    const response = requireBoundaryRecord(raw, 'CONTROL_SIGNER_REGISTER_RESPONSE_INVALID');
    requireExactBoundaryKeys(response, ['ok', 'signerId'], [], 'CONTROL_SIGNER_REGISTER_RESPONSE_FIELDS_INVALID');
    if (response['ok'] !== true || typeof response['signerId'] !== 'string' || !response['signerId']) {
      throw new Error('CONTROL_SIGNER_REGISTER_RESPONSE_INVALID');
    }
  }

  async queueRuntimeInput(input: RuntimeInput): Promise<void> {
    const response = decodeControlQueueResponse(await this.post('/api/control/runtime-input', input));
    if (response.ok !== true) {
      throw new Error(response.error || 'CONTROL_RUNTIME_INPUT_REJECTED');
    }
  }

  async hasGossipProfile(entityId: string): Promise<boolean> {
    const response = decodeGossipProfileResponse(await this.get(
      `/api/gossip/profile?entityId=${encodeURIComponent(entityId)}`,
    ));
    return response.ok === true && response.found === true;
  }

  /**
   * Send-readiness for encrypting straight to a runtime: the admitted profile
   * must bind the exact hub `runtimeId` and carry a valid X25519 key. A
   * `found: true` profile belonging to a retired hub runtime is not
   * send-ready, and neither is one whose key never propagated.
   */
  async hubProfileSendReady(entityId: string, hubRuntimeId: string): Promise<boolean> {
    const response = decodeGossipProfileResponse(await this.get(
      `/api/gossip/profile?entityId=${encodeURIComponent(entityId)}`,
    ));
    if (response.ok !== true || response.found !== true || !response.profile) return false;
    const profile = response.profile as { runtimeId?: unknown; runtimeEncPubKey?: unknown };
    return String(profile.runtimeId ?? '').trim().toLowerCase() === hubRuntimeId.trim().toLowerCase()
      && /^0x[0-9a-f]{64}$/.test(String(profile.runtimeEncPubKey ?? ''));
  }

  /**
   * Counterparties this Runtime currently sees in `entityId`'s gossip profile.
   * A routed payment is admitted against the sender's own gossip view, so a
   * load driver must observe that view rather than the Hub's own state.
   * Returns null when the profile has not propagated to this Runtime yet.
   */
  async gossipProfileCounterparties(entityId: string): Promise<string[] | null> {
    const response = decodeGossipProfileResponse(await this.get(
      `/api/gossip/profile?entityId=${encodeURIComponent(entityId)}`,
    ));
    if (response.ok !== true || response.found !== true || !response.profile) return null;
    return response.profile.accounts.map(account => account.counterpartyId.toLowerCase());
  }

  async gossipProfilesCounterparties(entityIds: readonly string[]): Promise<Map<string, string[] | null>> {
    const response = requireBoundaryRecord(
      await this.post('/api/control/gossip-profile-counterparties', { entityIds }),
      'CONTROL_GOSSIP_COUNTERPARTIES_RESPONSE_INVALID',
    );
    requireExactBoundaryKeys(
      response,
      ['ok', 'counterparties'],
      [],
      'CONTROL_GOSSIP_COUNTERPARTIES_RESPONSE_FIELDS_INVALID',
    );
    if (response['ok'] !== true) throw new Error('CONTROL_GOSSIP_COUNTERPARTIES_RESPONSE_NOT_OK');
    const raw = requireBoundaryRecord(
      response['counterparties'],
      'CONTROL_GOSSIP_COUNTERPARTIES_MAP_INVALID',
    );
    const counterparties = new Map<string, string[] | null>();
    for (const entityId of entityIds) {
      const key = entityId.toLowerCase();
      const value = raw[key];
      if (value === null) {
        counterparties.set(key, null);
        continue;
      }
      if (!Array.isArray(value) || value.some(counterparty => typeof counterparty !== 'string')) {
        throw new Error(`CONTROL_GOSSIP_COUNTERPARTIES_ENTRY_INVALID:entityId=${key}`);
      }
      counterparties.set(key, value.map(counterparty => counterparty.toLowerCase()));
    }
    return counterparties;
  }

  async configureP2P(config: {
    relayUrls?: string[];
    advertiseEntityIds?: string[];
    gossipPollMs?: number;
  }): Promise<void> {
    decodeP2PControlResponse(await this.post('/api/control/p2p', config));
  }

  async exportRuntimeSnapshot(): Promise<ControlRuntimeSnapshot> {
    const response = requireBoundaryRecord(
      await this.post('/api/control/runtime/snapshot', {}),
      'CONTROL_RUNTIME_SNAPSHOT_RESPONSE_INVALID',
    );
    requireExactBoundaryKeys(
      response,
      ['ok', 'runtimeId', 'height', 'checkpointHash'],
      [],
      'CONTROL_RUNTIME_SNAPSHOT_RESPONSE_FIELDS_INVALID',
    );
    const runtimeId = String(response['runtimeId'] || '').toLowerCase();
    const checkpointHash = String(response['checkpointHash'] || '').toLowerCase();
    if (response['ok'] !== true || !/^0x[0-9a-f]{40}$/.test(runtimeId)) {
      throw new Error('CONTROL_RUNTIME_SNAPSHOT_IDENTITY_INVALID');
    }
    if (!/^0x[0-9a-f]{64}$/.test(checkpointHash)) {
      throw new Error('CONTROL_RUNTIME_SNAPSHOT_HASH_INVALID');
    }
    return {
      runtimeId,
      height: requireBoundaryInteger(response['height'], 'CONTROL_RUNTIME_SNAPSHOT_HEIGHT_INVALID'),
      checkpointHash,
    };
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
    importEntity({
      entityId: identity.entityId,
      signerId: identity.signerId,
      entitySeed: ethers.getBytes(identity.entitySeed),
      data: {
        config: identity.consensusConfig,
        isProposer: true,
        profileName: identity.name,
        position: identity.position,
      },
    }),
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
            usdQuoteAuthorityEntityId: config.usdQuoteAuthorityEntityId,
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
  committedRoles: ReadonlyMap<string, boolean>,
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
      data: {
        targetEntityId: hubEntityId,
        disputeConfig: defaultAccountDisputeConfigForRoleEvidence(
          { entityId: identity.entityId, isHub: false, source: 'operator-config' },
          { entityId: hubEntityId, isHub: true, source: 'operator-config' },
          committedRoles,
        ),
      },
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

const ensureManagedEntity = async (
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
  await client.waitForEntity(identity.entityId);
  await configureManagedEntityP2P(client, identity, config);
  return identity;
};


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
    if (!custodySummary) throw new Error(`CUSTODY_COMMITTED_ENTITY_MISSING:${identity.entityId}`);
    const committedRoles = new Map(
      entities.map(entity => [entity.entityId.toLowerCase(), entity.isHub] as const),
    );
    const existingAccountEntityIds = new Set(
      Array.isArray(custodySummary?.accountEntityIds)
        ? custodySummary.accountEntityIds.map(value => String(value).toLowerCase())
        : [],
    );
    const missingHubEntityIds = hubEntityIds.filter(hubEntityId => !existingAccountEntityIds.has(hubEntityId));
    // Operator policy says custody is a User, but an already-imported Entity is
    // authoritative. Refuse a role conflict instead of silently signing 24h
    // clocks for a committed Hub identity.
    const connectivityInput = buildCustodyConnectivityInput(
      identity,
      config,
      missingHubEntityIds,
      committedRoles,
    );
    if (connectivityInput) {
      await client.queueRuntimeInput(connectivityInput);
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
    const usdQuoteAuthorityEntityId = String(config.usdQuoteAuthorityEntityId || '').trim().toLowerCase();
    if (!/^0x[0-9a-f]{64}$/.test(usdQuoteAuthorityEntityId)) {
      throw new Error('CUSTODY_USD_QUOTE_AUTHORITY_ENTITY_ID_REQUIRED');
    }
    await client.queueRuntimeInput({
      runtimeTxs: [],
      entityInputs: [buildEnableRoutingEntityInput(identity, {
        ...config,
        usdQuoteAuthorityEntityId,
      })],
    });
    await client.waitForEntity(identity.entityId);
  }
  return identity;
};
