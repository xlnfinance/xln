/**
 * Gossip Layer Implementation for XLN
 *
 * This module implements the gossip layer inside the runtime object.
 * It manages entity profiles in a distributed network.
 */

import { compareCanonicalText } from '../../orderbook/swap-keys';
import { LIMITS, UINT16_MAX } from '../../config/constants';
import { encodeCanonicalConsensusValue } from '../../protocol/serialization/canonical-consensus-value';
import { MAX_ROUTING_FEE_PPM } from '../../routing/fees';
import type { AccountStateDomain } from '../../types/account';
import { normalizeAccountStateDomain } from '../../account/commitment/state-root';
import { HANKO_MAX_BYTES } from '../../hanko/codec';
import {
  toEntityId,
  toRuntimeId,
  type EntityId,
  type RuntimeId,
} from '../../protocol/identity';
import { toUnixMs, type UnixMs } from '../../protocol/units';

const utf8Bytes = (value: string): number => new TextEncoder().encode(value).byteLength;

const assertCanonicalStringList = (values: string[], maxCount: number, maxBytes: number, code: string): void => {
  if (values.length > maxCount) throw new Error(`${code}_COUNT`);
  let previous = '';
  for (const value of values) {
    if (utf8Bytes(value) > maxBytes || (previous && compareCanonicalText(previous, value) >= 0)) throw new Error(code);
    previous = value;
  }
};

/** Canonical display name used by both Entity consensus and network profiles. */
export const normalizeEntityName = (raw: unknown, entityId: string): string => {
  if (typeof raw === 'string' && raw.trim().length > 0) return raw.trim();
  return `Entity ${entityId.slice(-4)}`;
};

type ProfileMetadata = {
  isHub: boolean;
  hubName?: string;
  routingFeePPM: number;
  baseFee: bigint;
  swapTakerFeeBps?: number;
  jurisdiction?: ProfileJurisdiction;
  mirrors?: ProfileMirror[];
  profileHanko?: string;
  policyVersion?: number;
  rebalanceBaseFee?: string;
  rebalanceLiquidityFeeBps?: string;
  rebalanceGasFee?: string;
  rebalanceTimeoutMs?: number;
};

export type ProfileJurisdiction = {
  name: string;
  chainId?: number;
  entityProviderAddress?: string;
  depositoryAddress?: string;
};

export type ProfileMirror = {
  entityId: string;
  jurisdiction: ProfileJurisdiction;
};

export type ProfileTokenCapacity = {
  inCapacity: bigint;
  outCapacity: bigint;
};

export type ProfileAccount = {
  counterpartyId: string;
  domain: AccountStateDomain;
  tokenCapacities:
    | Map<number | string, ProfileTokenCapacity>
    | Record<string, ProfileTokenCapacity>;
};

const parseRoutingFeePPM = (raw: unknown, entityId: string): number => {
  const value = raw === undefined ? 1 : Number(raw);
  if (!Number.isInteger(value) || value < 0 || value > MAX_ROUTING_FEE_PPM) {
    throw new Error(`GOSSIP_PROFILE_ROUTING_FEE_PPM_INVALID: entity=${entityId}`);
  }
  return value;
};

export type Profile = {
  entityId: string;
  entityEncryptionPublicKey: string;
  name: string;
  avatar: string;
  bio: string;
  website: string;
  lastUpdated: number;
  runtimeId: string; // Runtime identity (usually signer1 address)
  runtimeEncPubKey: string;
  runtimeSignature?: string;
  publicAccounts: string[]; // direct peers with inbound capacity
  wsUrl: string | null; // public direct websocket endpoint for this runtime
  relays: string[]; // preferred relay runtimes
  metadata: ProfileMetadata;
  accounts: ProfileAccount[];
};

type DecodedProfileAccount = ProfileAccount & Readonly<{
  counterpartyId: EntityId;
}>;

export type DecodedProfile = Profile & Readonly<{
  entityId: EntityId;
  runtimeId: RuntimeId;
  lastUpdated: UnixMs;
  publicAccounts: EntityId[];
  accounts: DecodedProfileAccount[];
}>;

export const isHubProfile = (profile: Profile): boolean =>
  profile.metadata.isHub === true;

const normalizeX25519Key = (raw: unknown): string | null => {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const prefixed = trimmed.startsWith('0x') ? trimmed : `0x${trimmed}`;
  return /^0x[0-9a-fA-F]{64}$/.test(prefixed) ? prefixed.toLowerCase() : null;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const assertProfileByteLimit = (value: unknown, entityId: string): void => {
  const bytes = new TextEncoder().encode(encodeCanonicalConsensusValue(value)).byteLength;
  if (bytes > LIMITS.MAX_PROFILE_BYTES) {
    throw new Error(`GOSSIP_PROFILE_BYTE_LIMIT_EXCEEDED:entity=${entityId || 'unknown'}:bytes=${bytes}:max=${LIMITS.MAX_PROFILE_BYTES}`);
  }
};

const hasOwn = (value: object, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(value, key);

const assertOnlyAllowedKeys = (
  raw: object,
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
  'entityEncryptionPublicKey',
  'name',
  'avatar',
  'bio',
  'website',
  'lastUpdated',
  'runtimeId',
  'runtimeEncPubKey',
  'runtimeSignature',
  'publicAccounts',
  'wsUrl',
  'relays',
  'metadata',
  'accounts',
] as const;

const ALLOWED_PROFILE_METADATA_KEYS = [
  'isHub',
  'hubName',
  'routingFeePPM',
  'baseFee',
  'swapTakerFeeBps',
  'jurisdiction',
  'mirrors',
  'profileHanko',
  'policyVersion',
  'rebalanceBaseFee',
  'rebalanceLiquidityFeeBps',
  'rebalanceGasFee',
  'rebalanceTimeoutMs',
] as const;

const ALLOWED_PROFILE_ACCOUNT_KEYS = [
  'counterpartyId',
  'domain',
  'tokenCapacities',
] as const;

const ALLOWED_PROFILE_TOKEN_CAPACITY_KEYS = [
  'inCapacity',
  'outCapacity',
] as const;

const ALLOWED_PROFILE_JURISDICTION_KEYS = [
  'name',
  'chainId',
  'entityProviderAddress',
  'depositoryAddress',
] as const;

const ALLOWED_PROFILE_MIRROR_KEYS = [
  'entityId',
  'jurisdiction',
] as const;

const assertCanonicalProfileFields = (
  rawProfile: object,
  metadataRaw: object,
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
  if (
    typeof raw !== 'number' ||
    !Number.isSafeInteger(raw) ||
    raw < 0 ||
    raw > UINT16_MAX
  ) {
    throw new Error(`${field}: entity=${entityId}`);
  }
  return raw;
};

const parseBigIntValue = (raw: unknown, field: string, entityId: string): bigint => {
  if (typeof raw === 'bigint') return raw;
  if (typeof raw === 'number' && Number.isInteger(raw)) return BigInt(raw);
  if (typeof raw === 'string' && /^-?\d+$/.test(raw)) return BigInt(raw);
  if (isRecord(raw) && raw['__xlnType'] === 'BigInt' && typeof raw['value'] === 'string' && /^-?\d+$/.test(raw['value'])) {
    return BigInt(raw['value']);
  }
  throw new Error(`${field}: entity=${entityId}`);
};

const parseUint256Text = (raw: unknown, field: string, entityId: string): string | undefined => {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'string' || !/^(0|[1-9][0-9]{0,77})$/.test(raw)) throw new Error(`${field}: entity=${entityId}`);
  const value = BigInt(raw);
  if (value >= (1n << 256n)) throw new Error(`${field}: entity=${entityId}`);
  return value.toString();
};

const parseProfileJurisdiction = (raw: unknown, entityId: string, field: string): ProfileJurisdiction | undefined => {
  if (raw == null) return undefined;
  if (!isRecord(raw)) {
    throw new Error(`${field}_INVALID: entity=${entityId}`);
  }
  assertOnlyAllowedKeys(raw, ALLOWED_PROFILE_JURISDICTION_KEYS, `${field}_UNKNOWN_FIELD`, entityId);
  const name = typeof raw['name'] === 'string' ? raw['name'].trim() : '';
  if (!name || utf8Bytes(name) > 128) {
    throw new Error(`${field}_NAME_REQUIRED: entity=${entityId}`);
  }
  const chainIdRaw = raw['chainId'];
  const chainId = chainIdRaw === undefined ? undefined : Number(chainIdRaw);
  if (chainIdRaw !== undefined && (typeof chainId !== 'number' || !Number.isFinite(chainId) || chainId <= 0)) {
    throw new Error(`${field}_CHAIN_ID_INVALID: entity=${entityId}`);
  }
  const entityProviderAddress = typeof raw['entityProviderAddress'] === 'string'
    ? raw['entityProviderAddress'].trim()
    : '';
  const depositoryAddress = typeof raw['depositoryAddress'] === 'string'
    ? raw['depositoryAddress'].trim()
    : '';
  for (const [label, address] of [['entityProviderAddress', entityProviderAddress], ['depositoryAddress', depositoryAddress]] as const) {
    if (address && !/^0x[0-9a-f]{40}$/.test(address)) {
      throw new Error(`${field}_${label}_INVALID: entity=${entityId}`);
    }
  }
  return {
    name,
    ...(chainId !== undefined ? { chainId: Math.floor(chainId) } : {}),
    ...(entityProviderAddress ? { entityProviderAddress } : {}),
    ...(depositoryAddress ? { depositoryAddress } : {}),
  };
};

const parseProfileMirrors = (raw: unknown, entityId: string): ProfileMirror[] | undefined => {
  if (raw == null) return undefined;
  if (!Array.isArray(raw)) {
    throw new Error(`GOSSIP_PROFILE_MIRRORS_INVALID: entity=${entityId}`);
  }
  if (raw.length > 16) throw new Error(`GOSSIP_PROFILE_MIRRORS_COUNT_INVALID: entity=${entityId}`);
  const mirrors: ProfileMirror[] = [];
  const seen = new Set<string>();
  let previousKey = '';
  for (const item of raw) {
    if (!isRecord(item)) {
      throw new Error(`GOSSIP_PROFILE_MIRROR_INVALID: entity=${entityId}`);
    }
    assertOnlyAllowedKeys(item, ALLOWED_PROFILE_MIRROR_KEYS, 'GOSSIP_PROFILE_MIRROR_UNKNOWN_FIELD', entityId);
    const mirrorEntityId = typeof item['entityId'] === 'string' ? item['entityId'].trim() : '';
    if (!/^0x[0-9a-f]{64}$/.test(mirrorEntityId)) {
      throw new Error(`GOSSIP_PROFILE_MIRROR_ENTITY_REQUIRED: entity=${entityId}`);
    }
    if (seen.has(mirrorEntityId)) throw new Error(`GOSSIP_PROFILE_MIRROR_DUPLICATE: entity=${entityId}`);
    seen.add(mirrorEntityId);
    const jurisdiction = parseProfileJurisdiction(item['jurisdiction'], entityId, 'GOSSIP_PROFILE_MIRROR_JURISDICTION');
    if (!jurisdiction) {
      throw new Error(`GOSSIP_PROFILE_MIRROR_JURISDICTION_REQUIRED: entity=${entityId}`);
    }
    const key = `${mirrorEntityId}\u0000${jurisdiction.name}`;
    if (previousKey && compareCanonicalText(previousKey, key) >= 0) {
      throw new Error(`GOSSIP_PROFILE_MIRRORS_NONCANONICAL: entity=${entityId}`);
    }
    previousKey = key;
    mirrors.push({ entityId: mirrorEntityId, jurisdiction });
  }
  return mirrors;
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
  let previousTokenId = '';
  for (const [tokenId, capacityRaw] of Object.entries(record)) {
    if (!/^(0|[1-9][0-9]*)$/.test(tokenId) || BigInt(tokenId) > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error(`GOSSIP_PROFILE_ACCOUNT_TOKEN_ID_INVALID: entity=${entityId} counterparty=${counterpartyId} token=${tokenId}`);
    }
    if (previousTokenId && BigInt(previousTokenId) >= BigInt(tokenId)) {
      throw new Error(`GOSSIP_PROFILE_ACCOUNT_TOKENS_NONCANONICAL: entity=${entityId} counterparty=${counterpartyId}`);
    }
    previousTokenId = tokenId;
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
    const inCapacity = parseBigIntValue(
      capacityRaw['inCapacity'],
      'GOSSIP_PROFILE_ACCOUNT_IN_CAPACITY_INVALID',
      entityId,
    );
    const outCapacity = parseBigIntValue(
      capacityRaw['outCapacity'],
      'GOSSIP_PROFILE_ACCOUNT_OUT_CAPACITY_INVALID',
      entityId,
    );
    if (inCapacity < 0n || outCapacity < 0n) {
      throw new Error(
        `GOSSIP_PROFILE_ACCOUNT_CAPACITY_NEGATIVE: entity=${entityId} counterparty=${counterpartyId} token=${tokenId}`,
      );
    }
    capacities[tokenId] = { inCapacity, outCapacity };
  }
  return capacities;
};

const parseProfileAccounts = (raw: unknown, entityId: string): DecodedProfileAccount[] => {
  if (!Array.isArray(raw)) return [];
  if (raw.length > 1000) throw new Error(`GOSSIP_PROFILE_ACCOUNTS_COUNT_INVALID: entity=${entityId}`);
  let previousCounterparty = '';
  return raw.map((accountRaw) => {
    if (!isRecord(accountRaw)) {
      throw new Error(`GOSSIP_PROFILE_ACCOUNT_INVALID: entity=${entityId}`);
    }
    assertOnlyAllowedKeys(accountRaw, ALLOWED_PROFILE_ACCOUNT_KEYS, 'GOSSIP_PROFILE_ACCOUNT_UNKNOWN_FIELD', entityId);
    const rawCounterpartyId = typeof accountRaw['counterpartyId'] === 'string'
      ? accountRaw['counterpartyId'].trim()
      : '';
    if (!/^0x[0-9a-f]{64}$/.test(rawCounterpartyId) || rawCounterpartyId <= previousCounterparty) {
      throw new Error(`GOSSIP_PROFILE_ACCOUNT_COUNTERPARTY_REQUIRED: entity=${entityId}`);
    }
    const counterpartyId = toEntityId(rawCounterpartyId);
    previousCounterparty = counterpartyId;
    const tokenCapacities = parseProfileTokenCapacities(accountRaw['tokenCapacities'], entityId, counterpartyId);
    if (Object.keys(tokenCapacities).length > 16) {
      throw new Error(`GOSSIP_PROFILE_ACCOUNT_TOKEN_COUNT_INVALID: entity=${entityId} counterparty=${counterpartyId}`);
    }
    return {
      counterpartyId,
      domain: normalizeAccountStateDomain(
        accountRaw['domain'] as AccountStateDomain,
        `GOSSIP_PROFILE_ACCOUNT_DOMAIN:${entityId}:${counterpartyId}`,
      ),
      tokenCapacities,
    };
  });
};

const parseProfileMetadata = (
  metadataRaw: Record<string, unknown>,
  entityId: string,
): ProfileMetadata => {
  const profileHanko = metadataRaw['profileHanko'];
  if (typeof profileHanko === 'string' && (!/^0x(?:[0-9a-f]{2})*$/.test(profileHanko) || (profileHanko.length - 2) / 2 > HANKO_MAX_BYTES)) {
    throw new Error(`GOSSIP_PROFILE_HANKO_INVALID: entity=${entityId}`);
  }
  const jurisdiction = parseProfileJurisdiction(metadataRaw['jurisdiction'], entityId, 'GOSSIP_PROFILE_JURISDICTION');
  const mirrors = parseProfileMirrors(metadataRaw['mirrors'], entityId);
  const hubName = typeof metadataRaw['hubName'] === 'string' ? metadataRaw['hubName'].trim() : '';
  if (utf8Bytes(hubName) > 128) throw new Error(`GOSSIP_PROFILE_HUB_NAME_TOO_LONG: entity=${entityId}`);
  const policyVersion = metadataRaw['policyVersion'];
  if (policyVersion !== undefined && (!Number.isSafeInteger(policyVersion) || Number(policyVersion) < 0)) {
    throw new Error(`GOSSIP_PROFILE_POLICY_VERSION_INVALID: entity=${entityId}`);
  }
  const rebalanceTimeoutMs = metadataRaw['rebalanceTimeoutMs'];
  if (rebalanceTimeoutMs !== undefined && (!Number.isSafeInteger(rebalanceTimeoutMs) || Number(rebalanceTimeoutMs) < 0)) {
    throw new Error(`GOSSIP_PROFILE_REBALANCE_TIMEOUT_INVALID: entity=${entityId}`);
  }
  const uint = (key: string, code: string) => parseUint256Text(metadataRaw[key], code, entityId);
  const rebalanceBaseFee = uint('rebalanceBaseFee', 'GOSSIP_PROFILE_REBALANCE_BASE_FEE_INVALID');
  const rebalanceLiquidityFeeBps = uint('rebalanceLiquidityFeeBps', 'GOSSIP_PROFILE_REBALANCE_LIQUIDITY_FEE_INVALID');
  const rebalanceGasFee = uint('rebalanceGasFee', 'GOSSIP_PROFILE_REBALANCE_GAS_FEE_INVALID');
  return {
    isHub: metadataRaw['isHub'] === true,
    ...(hubName ? { hubName } : {}),
    routingFeePPM: parseRoutingFeePPM(metadataRaw['routingFeePPM'], entityId),
    baseFee: parseBigIntValue(metadataRaw['baseFee'] ?? 0n, 'GOSSIP_PROFILE_BASE_FEE_INVALID', entityId),
    ...(metadataRaw['swapTakerFeeBps'] !== undefined ? { swapTakerFeeBps: parseUint16(metadataRaw['swapTakerFeeBps'], 'GOSSIP_PROFILE_SWAP_TAKER_FEE_BPS_INVALID', entityId) } : {}),
    ...(jurisdiction ? { jurisdiction } : {}),
    ...(mirrors ? { mirrors } : {}),
    ...(typeof profileHanko === 'string' && profileHanko.trim() ? { profileHanko: profileHanko.trim() } : {}),
    ...(policyVersion !== undefined ? { policyVersion: Number(policyVersion) } : {}),
    ...(rebalanceBaseFee !== undefined ? { rebalanceBaseFee } : {}),
    ...(rebalanceLiquidityFeeBps !== undefined ? { rebalanceLiquidityFeeBps } : {}),
    ...(rebalanceGasFee !== undefined ? { rebalanceGasFee } : {}),
    ...(rebalanceTimeoutMs !== undefined ? { rebalanceTimeoutMs: Number(rebalanceTimeoutMs) } : {}),
  };
};

const assertProfileRouteFields = (
  raw: Record<string, unknown>,
  entityId: string,
  name: string,
  runtimeId: string,
  wsUrl: string | null,
): void => {
  if (utf8Bytes(name) > 128 || utf8Bytes(runtimeId) > 128) throw new Error(`GOSSIP_PROFILE_TEXT_TOO_LONG: entity=${entityId}`);
  if (typeof raw['bio'] === 'string' && utf8Bytes(raw['bio']) > 4096) throw new Error(`GOSSIP_PROFILE_BIO_TOO_LONG: entity=${entityId}`);
  if (typeof raw['avatar'] === 'string' && utf8Bytes(raw['avatar']) > 2048) throw new Error(`GOSSIP_PROFILE_AVATAR_TOO_LONG: entity=${entityId}`);
  if (typeof raw['website'] === 'string' && utf8Bytes(raw['website']) > 2048) throw new Error(`GOSSIP_PROFILE_WEBSITE_TOO_LONG: entity=${entityId}`);
  if (wsUrl && utf8Bytes(wsUrl) > 2048) throw new Error(`GOSSIP_PROFILE_WS_URL_TOO_LONG: entity=${entityId}`);
};

export const parseProfile = (raw: unknown): DecodedProfile => {
  if (!isRecord(raw)) {
    throw new Error('GOSSIP_PROFILE_OBJECT_REQUIRED');
  }
  const rawEntityId = typeof raw['entityId'] === 'string' ? raw['entityId'].trim() : '';
  assertProfileByteLimit(raw, rawEntityId);
  if (!/^0x[0-9a-f]{64}$/.test(rawEntityId)) {
    throw new Error('GOSSIP_PROFILE_ENTITY_ID_REQUIRED');
  }
  const entityId = toEntityId(rawEntityId);
  const entityEncryptionPublicKey = normalizeX25519Key(raw['entityEncryptionPublicKey']);
  if (!entityEncryptionPublicKey) {
    throw new Error(`GOSSIP_PROFILE_ENTITY_ENCRYPTION_PUBLIC_KEY_REQUIRED: entity=${entityId}`);
  }
  const metadataRaw = raw['metadata'];
  if (!isRecord(metadataRaw)) {
    throw new Error(`GOSSIP_PROFILE_METADATA_REQUIRED: entity=${entityId}`);
  }
  assertCanonicalProfileFields(raw, metadataRaw, entityId);
  if (typeof raw['name'] !== 'string' || raw['name'].trim().length === 0) {
    throw new Error(`GOSSIP_PROFILE_NAME_REQUIRED: entity=${entityId}`);
  }
  const name = normalizeEntityName(raw['name'], entityId);
  const lastUpdated = toUnixMs(parsePositiveTimestamp(raw['lastUpdated'], entityId));
  const runtimeEncPubKey = normalizeX25519Key(raw['runtimeEncPubKey']);
  if (!runtimeEncPubKey) {
    throw new Error(`GOSSIP_PROFILE_RUNTIME_ENC_PUBKEY_REQUIRED: entity=${entityId}`);
  }
  const rawRuntimeId = typeof raw['runtimeId'] === 'string' ? raw['runtimeId'].trim() : '';
  if (!rawRuntimeId) {
    throw new Error(`GOSSIP_PROFILE_RUNTIME_ID_REQUIRED: entity=${entityId}`);
  }
  const runtimeId = toRuntimeId(rawRuntimeId);
  const rawPublicAccounts = normalizeStringArray(raw['publicAccounts']);
  const wsUrl = normalizeWsUrl(raw['wsUrl']);
  const relays = normalizeStringArray(raw['relays']);
  assertCanonicalStringList(rawPublicAccounts, 1000, 66, `GOSSIP_PROFILE_PUBLIC_ACCOUNTS_NONCANONICAL: entity=${entityId}`);
  assertCanonicalStringList(relays, 8, 2048, `GOSSIP_PROFILE_RELAYS_NONCANONICAL: entity=${entityId}`);
  if (rawPublicAccounts.some(accountId => !/^0x[0-9a-f]{64}$/.test(accountId))) {
    throw new Error(`GOSSIP_PROFILE_PUBLIC_ACCOUNT_ID_INVALID: entity=${entityId}`);
  }
  const publicAccounts = rawPublicAccounts.map(toEntityId);
  if (relays.some(relay => normalizeWsUrl(relay) !== relay)) {
    throw new Error(`GOSSIP_PROFILE_RELAY_URL_INVALID: entity=${entityId}`);
  }
  assertProfileRouteFields(raw, entityId, name, runtimeId, wsUrl);
  const metadata = parseProfileMetadata(metadataRaw, entityId);
  const result: DecodedProfile = {
    entityId,
    entityEncryptionPublicKey,
    name,
    avatar: typeof raw['avatar'] === 'string' ? raw['avatar'] : '',
    bio: typeof raw['bio'] === 'string' ? raw['bio'] : '',
    website: typeof raw['website'] === 'string' ? raw['website'] : '',
    lastUpdated,
    runtimeId,
    runtimeEncPubKey,
    ...(typeof raw['runtimeSignature'] === 'string' && raw['runtimeSignature'].trim()
      ? { runtimeSignature: raw['runtimeSignature'].trim().toLowerCase() }
      : {}),
    publicAccounts,
    wsUrl,
    relays,
    metadata,
    accounts: parseProfileAccounts(raw['accounts'], entityId),
  };
  return result;
};

const canonicalizeProfileMetadata = (
  metadata: ProfileMetadata,
  entityId: string,
): ProfileMetadata => {
  const jurisdiction = parseProfileJurisdiction(metadata['jurisdiction'], entityId, 'GOSSIP_PROFILE_JURISDICTION');
  const mirrors = parseProfileMirrors(metadata['mirrors'], entityId);
  const hubName = typeof metadata['hubName'] === 'string' ? metadata['hubName'].trim() : '';
  const swapTakerFeeBps = metadata['swapTakerFeeBps'] !== undefined
    ? parseUint16(metadata['swapTakerFeeBps'], 'GOSSIP_PROFILE_SWAP_TAKER_FEE_BPS_INVALID', entityId)
    : undefined;
  const optionalText = (key: 'rebalanceBaseFee' | 'rebalanceLiquidityFeeBps' | 'rebalanceGasFee') =>
    typeof metadata[key] === 'string' && metadata[key]!.trim() ? metadata[key]!.trim() : undefined;
  return {
    ...(hubName ? { hubName } : {}),
    routingFeePPM: parseRoutingFeePPM(metadata['routingFeePPM'], entityId),
    baseFee: parseBigIntValue(metadata['baseFee'] ?? 0n, 'GOSSIP_PROFILE_BASE_FEE_INVALID', entityId),
    ...(swapTakerFeeBps !== undefined ? { swapTakerFeeBps } : {}),
    ...(jurisdiction ? { jurisdiction } : {}),
    ...(mirrors ? { mirrors } : {}),
    ...(typeof metadata['policyVersion'] === 'number' && Number.isFinite(metadata['policyVersion']) ? { policyVersion: Math.floor(metadata['policyVersion']) } : {}),
    ...(optionalText('rebalanceBaseFee') ? { rebalanceBaseFee: optionalText('rebalanceBaseFee')! } : {}),
    ...(optionalText('rebalanceLiquidityFeeBps') ? { rebalanceLiquidityFeeBps: optionalText('rebalanceLiquidityFeeBps')! } : {}),
    ...(optionalText('rebalanceGasFee') ? { rebalanceGasFee: optionalText('rebalanceGasFee')! } : {}),
    ...(typeof metadata['rebalanceTimeoutMs'] === 'number' && Number.isFinite(metadata['rebalanceTimeoutMs']) ? { rebalanceTimeoutMs: Math.floor(metadata['rebalanceTimeoutMs']) } : {}),
    ...(typeof metadata['profileHanko'] === 'string' && metadata['profileHanko'].trim() ? { profileHanko: metadata['profileHanko'].trim() } : {}),
    isHub: metadata['isHub'] === true,
  };
};

const canonicalizeProfileAccounts = (
  accounts: ProfileAccount[],
  entityId: string,
): ProfileAccount[] => accounts.map(account => ({
  counterpartyId: account.counterpartyId,
  domain: normalizeAccountStateDomain(
    account.domain,
    `GOSSIP_PROFILE_ACCOUNT_DOMAIN:${entityId}:${account.counterpartyId}`,
  ),
  tokenCapacities: parseProfileTokenCapacities(account.tokenCapacities, entityId, account.counterpartyId),
}));

export const canonicalizeProfile = (
  profile: Profile,
  _options: { existing?: Profile | null; now?: number } = {},
): Profile => {
  const entityId = profile.entityId.trim();
  assertProfileByteLimit(profile, entityId);
  if (!/^0x[0-9a-f]{64}$/.test(entityId)) {
    throw new Error('GOSSIP_PROFILE_ENTITY_ID_REQUIRED');
  }

  assertCanonicalProfileFields(profile, profile.metadata, entityId);
  const metadata = profile.metadata;
  if (typeof profile.name !== 'string' || profile.name.trim().length === 0) {
    throw new Error(`GOSSIP_PROFILE_NAME_REQUIRED: entity=${entityId}`);
  }
  const normalizedName = normalizeEntityName(profile.name, entityId);
  const incomingLastUpdated = parsePositiveTimestamp(profile.lastUpdated, entityId);
  const normalizedRuntimeEncPubKey = normalizeX25519Key(profile.runtimeEncPubKey);
  const normalizedEntityEncryptionPublicKey = normalizeX25519Key(profile.entityEncryptionPublicKey);

  if (!normalizedRuntimeEncPubKey) {
    throw new Error(`GOSSIP_PROFILE_RUNTIME_ENC_PUBKEY_REQUIRED: entity=${entityId}`);
  }
  if (!normalizedEntityEncryptionPublicKey || profile.entityEncryptionPublicKey !== normalizedEntityEncryptionPublicKey) {
    throw new Error(`GOSSIP_PROFILE_ENTITY_ENCRYPTION_PUBLIC_KEY_NOT_NORMALIZED: entity=${entityId}`);
  }
  if (profile.runtimeEncPubKey !== normalizedRuntimeEncPubKey) {
    throw new Error(`GOSSIP_PROFILE_RUNTIME_ENC_PUBKEY_NOT_NORMALIZED: entity=${entityId}`);
  }
  if (typeof profile.runtimeId !== 'string' || profile.runtimeId.trim().length === 0) {
    throw new Error(`GOSSIP_PROFILE_RUNTIME_ID_REQUIRED: entity=${entityId}`);
  }
  const normalizedRuntimeId = profile.runtimeId.trim();
  if (profile.name !== normalizedName) {
    throw new Error(`GOSSIP_PROFILE_NAME_NOT_NORMALIZED: entity=${entityId}`);
  }

  const publicAccounts = normalizeStringArray(profile.publicAccounts);
  const wsUrl = normalizeWsUrl(profile.wsUrl);
  const relays = normalizeStringArray(profile.relays);
  const result: Profile = {
    ...profile,
    entityId,
    entityEncryptionPublicKey: normalizedEntityEncryptionPublicKey,
    name: normalizedName,
    avatar: profile.avatar,
    bio: profile.bio,
    website: profile.website,
    lastUpdated: incomingLastUpdated,
    runtimeId: normalizedRuntimeId,
    runtimeEncPubKey: normalizedRuntimeEncPubKey,
    ...(typeof profile.runtimeSignature === 'string' && profile.runtimeSignature.trim()
      ? { runtimeSignature: profile.runtimeSignature.trim().toLowerCase() }
      : {}),
    publicAccounts,
    wsUrl,
    relays,
    accounts: canonicalizeProfileAccounts(profile.accounts, entityId),
    metadata: canonicalizeProfileMetadata(metadata, entityId),
  };
  return parseProfile(result);
};
