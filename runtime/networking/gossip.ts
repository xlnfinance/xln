/**
 * Gossip Layer Implementation for XLN
 *
 * This module implements the gossip layer inside the runtime object.
 * It manages entity profiles and their capabilities in a distributed network.
 */

import { logDebug } from '../logger';
import { buildNetworkGraph } from '../routing/graph';
import { PathFinder } from '../routing/pathfinding';
import type { PaymentRoute } from '../routing/pathfinding';

export type BoardValidator = {
  signer: string; // canonical signer address (0x...) or signerId fallback
  weight: number; // uint16 voting power
  signerId: string; // runtime signerId for routing/debug
  publicKey: string; // hex public key
};

export type BoardMetadata = {
  threshold: number; // uint16 voting threshold
  validators: BoardValidator[];
};

export type ProfileMetadata = {
  entityEncPubKey: string;
  isHub: boolean;
  routingFeePPM: number;
  baseFee: bigint;
  board: BoardMetadata;
  entityPublicKey: string;
  profileHanko?: string;
  region?: string;
  version?: string;
  capacity?: number;
  uptime?: string;
  position?: { x: number; y: number; z: number };
  role?: string;
  relayUrl?: string;
  policyVersion?: number;
  rebalanceBaseFee?: string;
  rebalanceLiquidityFeeBps?: string;
  rebalanceGasFee?: string;
  rebalanceTimeoutMs?: number;
  [key: string]: unknown;
};

export type ProfileTokenCapacity = {
  inCapacity: bigint | string;
  outCapacity: bigint | string;
};

export type ProfileAccount = {
  counterpartyId: string;
  tokenCapacities:
    | Map<number | string, ProfileTokenCapacity>
    | Record<string, ProfileTokenCapacity>;
};

export type Profile = {
  entityId: string;
  name: string;
  avatar: string;
  bio: string;
  website: string;
  lastUpdated: number;
  runtimeId: string; // Runtime identity (usually signer1 address)
  runtimeEncPubKey: string;
  capabilities: string[]; // e.g. ["router", "swap:memecoins"]
  publicAccounts: string[]; // direct peers with inbound capacity
  endpoints: string[]; // websocket endpoints for this runtime
  relays: string[]; // preferred relay runtimes
  metadata: ProfileMetadata;
  accounts: ProfileAccount[];
};

export interface GossipLayer {
  profiles: Map<string, Profile>;
  announce: (profile: Profile) => void;
  getProfiles: () => Profile[];
  getHubs: () => Profile[];  // Get all profiles with isHub=true
  setProfiles?: (incoming: Iterable<Profile>) => void;
  getProfileBundle?: (entityId: string) => { profile?: Profile; peers: Profile[] };
  getNetworkGraph: () => {
    findPaths: (source: string, target: string, amount?: bigint, tokenId?: number) => Promise<PaymentRoute[]>;
  };
}

type GossipLayerOptions = {
  onAnnounce?: (profile: Profile) => void;
  getLiveProfiles?: () => Profile[];
};

const normalizeX25519Key = (raw: unknown): string | null => {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const prefixed = trimmed.startsWith('0x') ? trimmed : `0x${trimmed}`;
  return /^0x[0-9a-fA-F]{64}$/.test(prefixed) ? prefixed.toLowerCase() : null;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const hasOwn = (value: Record<string, unknown>, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(value, key);

const assertNoLegacyProfileFields = (
  rawProfile: Record<string, unknown>,
  metadataRaw: Record<string, unknown>,
  entityId: string,
): void => {
  if (hasOwn(rawProfile, 'hubs')) {
    throw new Error(`GOSSIP_PROFILE_HUBS_ALIAS_FORBIDDEN: entity=${entityId}`);
  }
  if (hasOwn(rawProfile, 'expiresAt')) {
    throw new Error(`GOSSIP_PROFILE_EXPIRES_AT_FORBIDDEN: entity=${entityId}`);
  }
  if (hasOwn(metadataRaw, 'name')) {
    throw new Error(`GOSSIP_PROFILE_METADATA_NAME_FORBIDDEN: entity=${entityId}`);
  }
  if (hasOwn(metadataRaw, 'avatar')) {
    throw new Error(`GOSSIP_PROFILE_METADATA_AVATAR_FORBIDDEN: entity=${entityId}`);
  }
  if (hasOwn(metadataRaw, 'bio')) {
    throw new Error(`GOSSIP_PROFILE_METADATA_BIO_FORBIDDEN: entity=${entityId}`);
  }
  if (hasOwn(metadataRaw, 'website')) {
    throw new Error(`GOSSIP_PROFILE_METADATA_WEBSITE_FORBIDDEN: entity=${entityId}`);
  }
  if (hasOwn(metadataRaw, 'lastUpdated')) {
    throw new Error(`GOSSIP_PROFILE_METADATA_LAST_UPDATED_FORBIDDEN: entity=${entityId}`);
  }
  if (hasOwn(metadataRaw, 'hankoSignature')) {
    throw new Error(`GOSSIP_PROFILE_METADATA_HANKO_SIGNATURE_FORBIDDEN: entity=${entityId}`);
  }
  if (hasOwn(metadataRaw, 'encryptionPubKey')) {
    throw new Error(`GOSSIP_PROFILE_METADATA_ENCRYPTION_PUBKEY_FORBIDDEN: entity=${entityId}`);
  }
  if (hasOwn(metadataRaw, 'cryptoPublicKey')) {
    throw new Error(`GOSSIP_PROFILE_METADATA_CRYPTO_PUBLIC_KEY_FORBIDDEN: entity=${entityId}`);
  }
  if (hasOwn(metadataRaw, 'encryptionPublicKey')) {
    throw new Error(`GOSSIP_PROFILE_METADATA_ENCRYPTION_PUBLIC_KEY_FORBIDDEN: entity=${entityId}`);
  }
  if (hasOwn(metadataRaw, 'threshold')) {
    throw new Error(`GOSSIP_PROFILE_METADATA_THRESHOLD_FORBIDDEN: entity=${entityId}`);
  }
  if (hasOwn(rawProfile, 'runtimeEncryptionPublicKey')) {
    throw new Error(`GOSSIP_PROFILE_RUNTIME_ENCRYPTION_PUBLIC_KEY_FORBIDDEN: entity=${entityId}`);
  }
};

const normalizeStringArray = (raw: unknown): string[] => {
  if (!Array.isArray(raw)) return [];
  const result: string[] = [];
  for (const item of raw) {
    if (typeof item !== 'string') continue;
    const normalized = item.trim();
    if (!normalized) continue;
    result.push(normalized);
  }
  return result;
};

const parsePositiveTimestamp = (raw: unknown, entityId: string): number => {
  const value = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`GOSSIP_PROFILE_LAST_UPDATED_REQUIRED: entity=${entityId}`);
  }
  return Math.floor(value);
};

const parseUint16 = (raw: unknown, field: string, entityId: string): number => {
  const value = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${field}: entity=${entityId}`);
  }
  return Math.min(65535, Math.floor(value));
};

const parseBigIntValue = (raw: unknown, field: string, entityId: string): bigint => {
  if (typeof raw === 'bigint') return raw;
  if (typeof raw === 'number' && Number.isInteger(raw)) return BigInt(raw);
  if (typeof raw === 'string' && /^-?\d+$/.test(raw)) return BigInt(raw);
  if (isRecord(raw) && raw.__xlnType === 'BigInt' && typeof raw.value === 'string' && /^-?\d+$/.test(raw.value)) {
    return BigInt(raw.value);
  }
  throw new Error(`${field}: entity=${entityId}`);
};

const stringifyBigIntLike = (raw: unknown): string => {
  if (typeof raw === 'bigint') return raw.toString();
  if (typeof raw === 'number' && Number.isFinite(raw)) return Math.floor(raw).toString();
  if (typeof raw === 'string' && /^-?\d+$/.test(raw)) return raw;
  if (isRecord(raw) && raw.__xlnType === 'BigInt' && typeof raw.value === 'string' && /^-?\d+$/.test(raw.value)) {
    return raw.value;
  }
  return '0';
};

const parseBoardValidator = (raw: unknown, entityId: string): BoardValidator => {
  if (!isRecord(raw)) {
    throw new Error(`GOSSIP_PROFILE_BOARD_VALIDATOR_INVALID: entity=${entityId}`);
  }
  const signer = typeof raw.signer === 'string' ? raw.signer.trim() : '';
  if (!signer) {
    throw new Error(`GOSSIP_PROFILE_BOARD_SIGNER_REQUIRED: entity=${entityId}`);
  }
  const weight = parseUint16(raw.weight, 'GOSSIP_PROFILE_BOARD_WEIGHT_INVALID', entityId);
  const signerId = typeof raw.signerId === 'string' ? raw.signerId.trim() : '';
  if (!signerId) {
    throw new Error(`GOSSIP_PROFILE_BOARD_SIGNER_ID_REQUIRED: entity=${entityId}`);
  }
  const publicKey = typeof raw.publicKey === 'string' ? raw.publicKey.trim() : '';
  if (!publicKey) {
    throw new Error(`GOSSIP_PROFILE_BOARD_PUBLIC_KEY_REQUIRED: entity=${entityId}`);
  }
  return {
    signer,
    weight,
    signerId,
    publicKey,
  };
};

const parseBoardMetadata = (raw: unknown, entityId: string): BoardMetadata => {
  if (!isRecord(raw)) {
    throw new Error(`GOSSIP_PROFILE_BOARD_REQUIRED: entity=${entityId}`);
  }
  const validatorsRaw = raw.validators;
  if (!Array.isArray(validatorsRaw) || validatorsRaw.length === 0) {
    throw new Error(`GOSSIP_PROFILE_BOARD_VALIDATORS_REQUIRED: entity=${entityId}`);
  }
  return {
    threshold: parseUint16(raw.threshold, 'GOSSIP_PROFILE_BOARD_THRESHOLD_INVALID', entityId),
    validators: validatorsRaw.map((validator) => parseBoardValidator(validator, entityId)),
  };
};

const parseProfileTokenCapacities = (
  raw: unknown,
  entityId: string,
  counterpartyId: string,
): Record<string, ProfileTokenCapacity> => {
  const record = isRecord(raw)
    ? raw
    : raw instanceof Map
      ? Object.fromEntries(raw.entries())
      : null;
  if (!record) {
    throw new Error(
      `GOSSIP_PROFILE_ACCOUNT_TOKEN_CAPACITIES_INVALID: entity=${entityId} counterparty=${counterpartyId}`,
    );
  }
  const capacities: Record<string, ProfileTokenCapacity> = {};
  for (const [tokenId, capacityRaw] of Object.entries(record)) {
    if (!isRecord(capacityRaw)) {
      throw new Error(
        `GOSSIP_PROFILE_ACCOUNT_TOKEN_CAPACITY_INVALID: entity=${entityId} counterparty=${counterpartyId} token=${tokenId}`,
      );
    }
    capacities[tokenId] = {
      inCapacity: stringifyBigIntLike(capacityRaw.inCapacity),
      outCapacity: stringifyBigIntLike(capacityRaw.outCapacity),
    };
  }
  return capacities;
};

const parseProfileAccounts = (raw: unknown, entityId: string): ProfileAccount[] => {
  if (!Array.isArray(raw)) return [];
  return raw.map((accountRaw) => {
    if (!isRecord(accountRaw)) {
      throw new Error(`GOSSIP_PROFILE_ACCOUNT_INVALID: entity=${entityId}`);
    }
    const counterpartyId = typeof accountRaw.counterpartyId === 'string'
      ? accountRaw.counterpartyId.trim()
      : '';
    if (!counterpartyId) {
      throw new Error(`GOSSIP_PROFILE_ACCOUNT_COUNTERPARTY_REQUIRED: entity=${entityId}`);
    }
    return {
      counterpartyId,
      tokenCapacities: parseProfileTokenCapacities(accountRaw.tokenCapacities, entityId, counterpartyId),
    };
  });
};

export const parseProfile = (raw: unknown): Profile => {
  if (!isRecord(raw)) {
    throw new Error('GOSSIP_PROFILE_OBJECT_REQUIRED');
  }
  const entityId = typeof raw.entityId === 'string' ? raw.entityId.trim() : '';
  if (!entityId) {
    throw new Error('GOSSIP_PROFILE_ENTITY_ID_REQUIRED');
  }
  const metadataRaw = raw.metadata;
  if (!isRecord(metadataRaw)) {
    throw new Error(`GOSSIP_PROFILE_METADATA_REQUIRED: entity=${entityId}`);
  }
  assertNoLegacyProfileFields(raw, metadataRaw, entityId);
  const entityEncPubKey = normalizeX25519Key(metadataRaw.entityEncPubKey);
  if (!entityEncPubKey) {
    throw new Error(`GOSSIP_PROFILE_MISSING_ENTITY_ENC_PUBKEY: entity=${entityId}`);
  }
  if (typeof raw.name !== 'string' || raw.name.trim().length === 0) {
    throw new Error(`GOSSIP_PROFILE_NAME_REQUIRED: entity=${entityId}`);
  }
  const name = normalizeEntityName(raw.name, entityId);
  const lastUpdated = parsePositiveTimestamp(raw.lastUpdated, entityId);
  const runtimeEncPubKey = normalizeX25519Key(raw.runtimeEncPubKey);
  if (!runtimeEncPubKey) {
    throw new Error(`GOSSIP_PROFILE_RUNTIME_ENC_PUBKEY_REQUIRED: entity=${entityId}`);
  }
  const runtimeId = typeof raw.runtimeId === 'string' ? raw.runtimeId.trim() : '';
  if (!runtimeId) {
    throw new Error(`GOSSIP_PROFILE_RUNTIME_ID_REQUIRED: entity=${entityId}`);
  }
  const entityPublicKey = typeof metadataRaw.entityPublicKey === 'string' ? metadataRaw.entityPublicKey.trim() : '';
  if (!entityPublicKey) {
    throw new Error(`GOSSIP_PROFILE_ENTITY_PUBLIC_KEY_REQUIRED: entity=${entityId}`);
  }
  const capabilities = normalizeStringArray(raw.capabilities);
  const publicAccounts = normalizeStringArray(raw.publicAccounts);
  const endpoints = normalizeStringArray(raw.endpoints);
  const relays = normalizeStringArray(raw.relays);
  const metadata: ProfileMetadata = {
    ...metadataRaw,
    entityEncPubKey,
    isHub:
      metadataRaw.isHub === true ||
      capabilities.includes('hub') ||
      capabilities.includes('routing'),
    routingFeePPM: Math.max(
      0,
      Number.isFinite(Number(metadataRaw.routingFeePPM)) ? Math.floor(Number(metadataRaw.routingFeePPM)) : 100,
    ),
    baseFee: parseBigIntValue(metadataRaw.baseFee ?? 0n, 'GOSSIP_PROFILE_BASE_FEE_INVALID', entityId),
    board: parseBoardMetadata(metadataRaw.board, entityId),
    entityPublicKey,
    ...(typeof metadataRaw.profileHanko === 'string' && metadataRaw.profileHanko.trim().length > 0
      ? { profileHanko: metadataRaw.profileHanko.trim() }
      : {}),
  };
  return {
    entityId,
    name,
    avatar: typeof raw.avatar === 'string' ? raw.avatar : '',
    bio: typeof raw.bio === 'string' ? raw.bio : '',
    website: typeof raw.website === 'string' ? raw.website : '',
    lastUpdated,
    runtimeId,
    runtimeEncPubKey,
    capabilities,
    publicAccounts,
    endpoints,
    relays,
    metadata,
    accounts: parseProfileAccounts(raw.accounts, entityId),
  };
};

export const normalizeEntityName = (raw: unknown, entityId: string): string => {
  if (typeof raw === 'string' && raw.trim().length > 0) return raw.trim();
  return `Entity ${entityId.slice(-4)}`;
};

export const canonicalizeProfile = (
  profile: Profile,
  _options: { existing?: Profile | null; now?: number } = {},
): Profile => {
  const entityId = profile.entityId.trim();
  if (!entityId) {
    throw new Error('GOSSIP_PROFILE_ENTITY_ID_REQUIRED');
  }

  const rawProfile = profile as unknown as Record<string, unknown>;
  const metadata = profile.metadata as Record<string, unknown>;
  assertNoLegacyProfileFields(rawProfile, metadata, entityId);
  if (typeof profile.name !== 'string' || profile.name.trim().length === 0) {
    throw new Error(`GOSSIP_PROFILE_NAME_REQUIRED: entity=${entityId}`);
  }
  const normalizedName = normalizeEntityName(profile.name, entityId);
  const incomingLastUpdated = parsePositiveTimestamp(profile.lastUpdated, entityId);
  const normalizedRuntimeEncPubKey = normalizeX25519Key(profile.runtimeEncPubKey);
  const normalizedEntityEncPubKey = normalizeX25519Key(metadata.entityEncPubKey);

  if (!normalizedRuntimeEncPubKey) {
    throw new Error(`GOSSIP_PROFILE_RUNTIME_ENC_PUBKEY_REQUIRED: entity=${entityId}`);
  }
  if (profile.runtimeEncPubKey !== normalizedRuntimeEncPubKey) {
    throw new Error(`GOSSIP_PROFILE_RUNTIME_ENC_PUBKEY_NOT_NORMALIZED: entity=${entityId}`);
  }
  if (!normalizedEntityEncPubKey) {
    throw new Error(`GOSSIP_PROFILE_MISSING_ENTITY_ENC_PUBKEY: entity=${entityId}`);
  }
  if (typeof profile.runtimeId !== 'string' || profile.runtimeId.trim().length === 0) {
    throw new Error(`GOSSIP_PROFILE_RUNTIME_ID_REQUIRED: entity=${entityId}`);
  }
  const normalizedRuntimeId = profile.runtimeId.trim();
  const entityPublicKey = typeof metadata.entityPublicKey === 'string' ? metadata.entityPublicKey.trim() : '';
  if (!entityPublicKey) {
    throw new Error(`GOSSIP_PROFILE_ENTITY_PUBLIC_KEY_REQUIRED: entity=${entityId}`);
  }
  if (typeof metadata.entityEncPubKey !== 'string' || metadata.entityEncPubKey !== normalizedEntityEncPubKey) {
    throw new Error(`GOSSIP_PROFILE_ENTITY_ENC_PUBKEY_NOT_NORMALIZED: entity=${entityId}`);
  }
  if (profile.name !== normalizedName) {
    throw new Error(`GOSSIP_PROFILE_NAME_NOT_NORMALIZED: entity=${entityId}`);
  }

  const capabilities = normalizeStringArray(profile.capabilities);
  const publicAccounts = normalizeStringArray(profile.publicAccounts);
  const endpoints = normalizeStringArray(profile.endpoints);
  const relays = normalizeStringArray(profile.relays);
  const board = parseBoardMetadata(metadata.board, entityId);
  const routingFeePPM = Math.max(0, Number.isFinite(Number(metadata.routingFeePPM)) ? Math.floor(Number(metadata.routingFeePPM)) : 100);
  const baseFee = parseBigIntValue(metadata.baseFee ?? 0n, 'GOSSIP_PROFILE_BASE_FEE_INVALID', entityId);
  return {
    ...profile,
    entityId,
    name: normalizedName,
    avatar: profile.avatar,
    bio: profile.bio,
    website: profile.website,
    lastUpdated: incomingLastUpdated,
    runtimeId: normalizedRuntimeId,
    runtimeEncPubKey: normalizedRuntimeEncPubKey,
    capabilities,
    publicAccounts,
    endpoints,
    relays,
    accounts: profile.accounts.map((account) => ({
      counterpartyId: account.counterpartyId,
      tokenCapacities: parseProfileTokenCapacities(account.tokenCapacities, entityId, account.counterpartyId),
    })),
    metadata: {
      ...metadata,
      entityEncPubKey: normalizedEntityEncPubKey,
      board,
      routingFeePPM,
      baseFee,
      entityPublicKey,
      ...(typeof metadata.profileHanko === 'string' && metadata.profileHanko.trim().length > 0
        ? { profileHanko: metadata.profileHanko.trim() }
        : {}),
      isHub:
        metadata.isHub === true ||
        capabilities.includes('hub') === true ||
        capabilities.includes('routing') === true,
    },
  };
};

export function createGossipLayer(options: GossipLayerOptions = {}): GossipLayer {
  const profiles = new Map<string, Profile>();

  const getLastUpdated = (profile: Profile): number => {
    return typeof profile.lastUpdated === 'number' ? profile.lastUpdated : 0;
  };

  const announce = (profile: Profile): void => {
    logDebug('GOSSIP', `📢 gossip.announce INPUT: ${profile.entityId.slice(-4)} accounts=${profile.accounts.length}`);
    const existingProfile = profiles.get(profile.entityId);
    const normalizedProfile = canonicalizeProfile(profile);

    logDebug('GOSSIP', `📢 After normalize: ${profile.entityId.slice(-4)} accounts=${normalizedProfile.accounts.length}`);
    // Only update if newer timestamp or no existing profile
    const existing = existingProfile;
    const newTimestamp = normalizedProfile.lastUpdated;
    const existingTimestamp = existing?.lastUpdated || 0;

    const shouldUpdate =
      !existing ||
      newTimestamp > existingTimestamp ||
      (newTimestamp === existingTimestamp && (
        (existing.runtimeId !== normalizedProfile.runtimeId) ||
        (existing.metadata.entityPublicKey !== normalizedProfile.metadata.entityPublicKey) ||
        (existing.accounts.length !== normalizedProfile.accounts.length)  // Accept if accounts changed
      ));

    if (shouldUpdate) {
      profiles.set(profile.entityId, normalizedProfile);
      logDebug('GOSSIP', `📡 Gossip SAVED: ${profile.entityId.slice(-4)} ts=${newTimestamp} accounts=${normalizedProfile.accounts.length}`);
      try {
        options.onAnnounce?.(normalizedProfile);
      } catch (error) {
        console.warn(
          `[GOSSIP] persist callback failed for ${profile.entityId.slice(-8)}:`,
          error instanceof Error ? error.message : String(error),
        );
      }

      // VERIFY: Check что profile действительно сохранился
      const verify = profiles.get(profile.entityId);
      logDebug('GOSSIP', `✅ VERIFY after SET: ${profile.entityId.slice(-4)} accounts=${verify?.accounts.length || 0} (should be ${normalizedProfile.accounts.length})`);
    } else {
      logDebug('GOSSIP', `📡 Gossip REJECTED: ${profile.entityId.slice(-4)} ts=${newTimestamp}<=${existingTimestamp}`);
    }
  };

  const getProfiles = (): Profile[] => {
    const result = Array.from(profiles.values());
    logDebug('GOSSIP', `🔍 getProfiles(): Returning ${result.length} profiles`);
    for (const p of result) {
      logDebug('GOSSIP', `  - ${p.entityId.slice(-4)}: accounts=${p.accounts.length} ts=${p.lastUpdated}`);
    }
    return result;
  };

  // Get all hubs (profiles with isHub=true)
  const getHubs = (): Profile[] => {
    const hubs = Array.from(profiles.values()).filter(
      p =>
        p.metadata.isHub === true ||
        p.capabilities.includes('hub') === true ||
        p.capabilities.includes('routing') === true
    );
    logDebug('GOSSIP', `🏠 getHubs(): Found ${hubs.length} hubs`);
    for (const h of hubs) {
      logDebug('GOSSIP', `  - ${h.entityId.slice(-4)}: ${h.name} region=${h.metadata.region || 'unknown'}`);
    }
    return hubs;
  };

  const getProfileBundle = (entityId: string): { profile?: Profile; peers: Profile[] } => {
    const profile = profiles.get(entityId);
    if (!profile) {
      return { peers: [] };
    }
    const peerIds = profile.publicAccounts;
    const peers = peerIds.map(id => profiles.get(id)).filter(Boolean) as Profile[];
    return { profile, peers };
  };

  const setProfiles = (incoming: Iterable<Profile>): void => {
    profiles.clear();
    for (const profile of incoming) {
      announce(profile);
    }
  };

  /**
   * Get network graph with pathfinding capabilities
   * Returns object with findPaths() method using Dijkstra pathfinder.
   */
  const getNetworkGraph = () => {
    return {
      findPaths: async (source: string, target: string, amount?: bigint, tokenId: number = 1) => {
        const requiredRecipientAmount = amount ?? 1n;
        const graphProfiles = new Map(profiles);
        for (const liveProfile of options.getLiveProfiles?.() || []) {
          graphProfiles.set(liveProfile.entityId, canonicalizeProfile(liveProfile));
        }
        const graph = buildNetworkGraph(graphProfiles, tokenId);
        const finder = new PathFinder(graph);
        return finder.findRoutes(source, target, requiredRecipientAmount, tokenId, 100);
      }
    };
  };

  return {
    profiles,
    announce,
    getProfiles,
    getHubs,
    setProfiles,
    getProfileBundle,
    getNetworkGraph,
  };
}
