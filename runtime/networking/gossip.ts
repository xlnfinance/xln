/**
 * Gossip Layer Implementation for XLN
 *
 * This module implements the gossip layer inside the runtime object.
 * It manages entity profiles in a distributed network.
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
  swapTakerFeeBps?: number;
  board: BoardMetadata;
  profileHanko?: string;
  policyVersion?: number;
  rebalanceBaseFee?: string;
  rebalanceLiquidityFeeBps?: string;
  rebalanceGasFee?: string;
  rebalanceTimeoutMs?: number;
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
  publicAccounts: string[]; // direct peers with inbound capacity
  wsUrl: string | null; // public direct websocket endpoint for this runtime
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

export const isHubProfile = (profile: Profile): boolean =>
  profile.metadata.isHub === true;

export const isRoutableProfile = (profile: Profile): boolean =>
  isHubProfile(profile);

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

const assertOnlyAllowedKeys = (
  raw: Record<string, unknown>,
  allowedKeys: readonly string[],
  errorPrefix: string,
  entityId: string,
): void => {
  const allowed = new Set(allowedKeys);
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) {
      throw new Error(`${errorPrefix}: entity=${entityId} key=${key}`);
    }
  }
};

const ALLOWED_PROFILE_KEYS = [
  'entityId',
  'name',
  'avatar',
  'bio',
  'website',
  'lastUpdated',
  'runtimeId',
  'runtimeEncPubKey',
  'publicAccounts',
  'wsUrl',
  'relays',
  'metadata',
  'accounts',
] as const;

const ALLOWED_PROFILE_METADATA_KEYS = [
  'entityEncPubKey',
  'isHub',
  'routingFeePPM',
  'baseFee',
  'swapTakerFeeBps',
  'board',
  'profileHanko',
  'policyVersion',
  'rebalanceBaseFee',
  'rebalanceLiquidityFeeBps',
  'rebalanceGasFee',
  'rebalanceTimeoutMs',
] as const;

const ALLOWED_PROFILE_ACCOUNT_KEYS = [
  'counterpartyId',
  'tokenCapacities',
] as const;

const ALLOWED_PROFILE_TOKEN_CAPACITY_KEYS = [
  'inCapacity',
  'outCapacity',
] as const;

const ALLOWED_BOARD_METADATA_KEYS = [
  'threshold',
  'validators',
] as const;

const ALLOWED_BOARD_VALIDATOR_KEYS = [
  'signer',
  'weight',
  'signerId',
  'publicKey',
] as const;

const assertNoLegacyProfileFields = (
  rawProfile: Record<string, unknown>,
  metadataRaw: Record<string, unknown>,
  entityId: string,
): void => {
  assertOnlyAllowedKeys(rawProfile, ALLOWED_PROFILE_KEYS, 'GOSSIP_PROFILE_UNKNOWN_FIELD', entityId);
  assertOnlyAllowedKeys(metadataRaw, ALLOWED_PROFILE_METADATA_KEYS, 'GOSSIP_PROFILE_METADATA_UNKNOWN_FIELD', entityId);
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

const normalizeWsUrl = (raw: unknown): string | null => {
  if (raw == null) return null;
  if (typeof raw !== 'string') {
    throw new Error('GOSSIP_PROFILE_WS_URL_INVALID');
  }
  const normalized = raw.trim();
  if (!normalized) return null;
  if (!normalized.startsWith('ws://') && !normalized.startsWith('wss://')) {
    throw new Error('GOSSIP_PROFILE_WS_URL_INVALID');
  }
  return normalized;
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
  assertOnlyAllowedKeys(raw, ALLOWED_BOARD_VALIDATOR_KEYS, 'GOSSIP_PROFILE_BOARD_VALIDATOR_UNKNOWN_FIELD', entityId);
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
  assertOnlyAllowedKeys(raw, ALLOWED_BOARD_METADATA_KEYS, 'GOSSIP_PROFILE_BOARD_UNKNOWN_FIELD', entityId);
  const validatorsRaw = raw.validators;
  if (!Array.isArray(validatorsRaw) || validatorsRaw.length === 0) {
    throw new Error(`GOSSIP_PROFILE_BOARD_VALIDATORS_REQUIRED: entity=${entityId}`);
  }
  return {
    threshold: parseUint16(raw.threshold, 'GOSSIP_PROFILE_BOARD_THRESHOLD_INVALID', entityId),
    validators: validatorsRaw.map((validator) => parseBoardValidator(validator, entityId)),
  };
};

export const getBoardPrimaryPublicKey = (board: BoardMetadata, entityId: string): string => {
  const publicKey = typeof board.validators[0]?.publicKey === 'string' ? board.validators[0].publicKey.trim() : '';
  if (!publicKey) {
    throw new Error(`GOSSIP_PROFILE_BOARD_PRIMARY_PUBLIC_KEY_REQUIRED: entity=${entityId}`);
  }
  return publicKey;
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
    assertOnlyAllowedKeys(
      capacityRaw,
      ALLOWED_PROFILE_TOKEN_CAPACITY_KEYS,
      'GOSSIP_PROFILE_ACCOUNT_TOKEN_CAPACITY_UNKNOWN_FIELD',
      entityId,
    );
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
    assertOnlyAllowedKeys(accountRaw, ALLOWED_PROFILE_ACCOUNT_KEYS, 'GOSSIP_PROFILE_ACCOUNT_UNKNOWN_FIELD', entityId);
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
  const publicAccounts = normalizeStringArray(raw.publicAccounts);
  const wsUrl = normalizeWsUrl(raw.wsUrl);
  const relays = normalizeStringArray(raw.relays);
  const board = parseBoardMetadata(metadataRaw.board, entityId);
  getBoardPrimaryPublicKey(board, entityId);
  const metadata: ProfileMetadata = {
    entityEncPubKey,
    isHub: metadataRaw.isHub === true,
    routingFeePPM: Math.max(
      0,
      Number.isFinite(Number(metadataRaw.routingFeePPM)) ? Math.floor(Number(metadataRaw.routingFeePPM)) : 1,
    ),
    baseFee: parseBigIntValue(metadataRaw.baseFee ?? 0n, 'GOSSIP_PROFILE_BASE_FEE_INVALID', entityId),
    ...(metadataRaw.swapTakerFeeBps !== undefined
      ? { swapTakerFeeBps: parseUint16(metadataRaw.swapTakerFeeBps, 'GOSSIP_PROFILE_SWAP_TAKER_FEE_BPS_INVALID', entityId) }
      : {}),
    board,
    ...(typeof metadataRaw.profileHanko === 'string' && metadataRaw.profileHanko.trim().length > 0
      ? { profileHanko: metadataRaw.profileHanko.trim() }
      : {}),
    ...(typeof metadataRaw.policyVersion === 'number' && Number.isFinite(metadataRaw.policyVersion)
      ? { policyVersion: Math.floor(metadataRaw.policyVersion) }
      : {}),
    ...(typeof metadataRaw.rebalanceBaseFee === 'string' && metadataRaw.rebalanceBaseFee.trim().length > 0
      ? { rebalanceBaseFee: metadataRaw.rebalanceBaseFee.trim() }
      : {}),
    ...(typeof metadataRaw.rebalanceLiquidityFeeBps === 'string' && metadataRaw.rebalanceLiquidityFeeBps.trim().length > 0
      ? { rebalanceLiquidityFeeBps: metadataRaw.rebalanceLiquidityFeeBps.trim() }
      : {}),
    ...(typeof metadataRaw.rebalanceGasFee === 'string' && metadataRaw.rebalanceGasFee.trim().length > 0
      ? { rebalanceGasFee: metadataRaw.rebalanceGasFee.trim() }
      : {}),
    ...(typeof metadataRaw.rebalanceTimeoutMs === 'number' && Number.isFinite(metadataRaw.rebalanceTimeoutMs)
      ? { rebalanceTimeoutMs: Math.floor(metadataRaw.rebalanceTimeoutMs) }
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
    publicAccounts,
    wsUrl,
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
  const metadata = profile.metadata as unknown as Record<string, unknown>;
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
  if (typeof metadata.entityEncPubKey !== 'string' || metadata.entityEncPubKey !== normalizedEntityEncPubKey) {
    throw new Error(`GOSSIP_PROFILE_ENTITY_ENC_PUBKEY_NOT_NORMALIZED: entity=${entityId}`);
  }
  if (profile.name !== normalizedName) {
    throw new Error(`GOSSIP_PROFILE_NAME_NOT_NORMALIZED: entity=${entityId}`);
  }

  const publicAccounts = normalizeStringArray(profile.publicAccounts);
  const wsUrl = normalizeWsUrl(profile.wsUrl);
  const relays = normalizeStringArray(profile.relays);
  const board = parseBoardMetadata(metadata.board, entityId);
  getBoardPrimaryPublicKey(board, entityId);
  const routingFeePPM = Math.max(0, Number.isFinite(Number(metadata.routingFeePPM)) ? Math.floor(Number(metadata.routingFeePPM)) : 1);
  const baseFee = parseBigIntValue(metadata.baseFee ?? 0n, 'GOSSIP_PROFILE_BASE_FEE_INVALID', entityId);
  const swapTakerFeeBps = metadata.swapTakerFeeBps !== undefined
    ? parseUint16(metadata.swapTakerFeeBps, 'GOSSIP_PROFILE_SWAP_TAKER_FEE_BPS_INVALID', entityId)
    : undefined;
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
    publicAccounts,
    wsUrl,
    relays,
    accounts: profile.accounts.map((account) => ({
      counterpartyId: account.counterpartyId,
      tokenCapacities: parseProfileTokenCapacities(account.tokenCapacities, entityId, account.counterpartyId),
    })),
    metadata: {
      entityEncPubKey: normalizedEntityEncPubKey,
      board,
      routingFeePPM,
      baseFee,
      ...(swapTakerFeeBps !== undefined ? { swapTakerFeeBps } : {}),
      ...(typeof metadata.policyVersion === 'number' && Number.isFinite(metadata.policyVersion)
        ? { policyVersion: Math.floor(metadata.policyVersion) }
        : {}),
      ...(typeof metadata.rebalanceBaseFee === 'string' && metadata.rebalanceBaseFee.trim().length > 0
        ? { rebalanceBaseFee: metadata.rebalanceBaseFee.trim() }
        : {}),
      ...(typeof metadata.rebalanceLiquidityFeeBps === 'string' && metadata.rebalanceLiquidityFeeBps.trim().length > 0
        ? { rebalanceLiquidityFeeBps: metadata.rebalanceLiquidityFeeBps.trim() }
        : {}),
      ...(typeof metadata.rebalanceGasFee === 'string' && metadata.rebalanceGasFee.trim().length > 0
        ? { rebalanceGasFee: metadata.rebalanceGasFee.trim() }
        : {}),
      ...(typeof metadata.rebalanceTimeoutMs === 'number' && Number.isFinite(metadata.rebalanceTimeoutMs)
        ? { rebalanceTimeoutMs: Math.floor(metadata.rebalanceTimeoutMs) }
        : {}),
      ...(typeof metadata.profileHanko === 'string' && metadata.profileHanko.trim().length > 0
        ? { profileHanko: metadata.profileHanko.trim() }
        : {}),
      isHub: metadata.isHub === true,
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
        (getBoardPrimaryPublicKey(existing.metadata.board, existing.entityId)
          !== getBoardPrimaryPublicKey(normalizedProfile.metadata.board, normalizedProfile.entityId)) ||
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
    const hubs = Array.from(profiles.values()).filter((p) => isHubProfile(p));
    logDebug('GOSSIP', `🏠 getHubs(): Found ${hubs.length} hubs`);
    for (const h of hubs) {
      logDebug('GOSSIP', `  - ${h.entityId.slice(-4)}: ${h.name}`);
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
