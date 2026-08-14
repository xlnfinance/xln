/**
 * Signed, immutable discovery record for one verified V1 jurisdiction stack.
 * Gossip may advertise where a stack lives, but never makes it trusted for an
 * Entity: contract readiness and local operator admission remain mandatory. [96/100]
 */

import { Signature, Wallet, getAddress, hexlify, keccak256, recoverAddress } from 'ethers';
import {
  requireBoundaryInteger,
  requireBoundaryRecord,
  requireExactBoundaryKeys,
  requireString,
} from '../../protocol/boundary/boundary-primitives';
import { encodeCanonicalConsensusValue } from '../../protocol/serialization/canonical-consensus-value';

const JURISDICTION_GOSSIP_DOMAIN = 'xln-jurisdiction-gossip-v1' as const;
export const MAX_JURISDICTION_GOSSIP_RECORDS = 128;

type JurisdictionGossipScope = 'community' | 'official';

export type JurisdictionGossipAnnouncement = Readonly<{
  domain: typeof JURISDICTION_GOSSIP_DOMAIN;
  stackVersion: 'V1';
  scope: JurisdictionGossipScope;
  key: string;
  name: string;
  rpcUrl: string;
  blockTimeMs: number;
  currency: string;
  explorer: string;
  description?: string;
  chainId: number;
  deployer: string;
  foundationRecipient: string;
  entityProviderDeploymentBlock: number;
  contracts: Readonly<{
    account: string;
    depositoryBounds: string;
    hashLadderRegistry: string;
    nftCustody: string;
    hankoVerifier: string;
    entityProvider: string;
    depository: string;
    deltaTransformer: string;
  }>;
  stablecoin: Readonly<{ symbol: 'USDT'; address: string; tokenId: 1; decimals: 6 }>;
  signerId: string;
  signature: string;
}>;

type UnsignedAnnouncement = Omit<JurisdictionGossipAnnouncement, 'signature'>;

const ROOT_KEYS = [
  'domain', 'stackVersion', 'scope', 'key', 'name', 'rpcUrl', 'blockTimeMs',
  'currency', 'explorer', 'chainId', 'deployer', 'foundationRecipient',
  'entityProviderDeploymentBlock', 'contracts', 'stablecoin', 'signerId', 'signature',
] as const;
const CONTRACT_KEYS = [
  'account', 'depositoryBounds', 'hashLadderRegistry', 'nftCustody',
  'hankoVerifier', 'entityProvider', 'depository', 'deltaTransformer',
] as const;

const boundedText = (value: unknown, code: string, maxBytes: number): string => {
  const text = requireString(value, code);
  if (!text.trim() || text !== text.trim() || new TextEncoder().encode(text).byteLength > maxBytes) {
    throw new Error(code);
  }
  return text;
};

const boundedTrimmedText = (value: unknown, code: string, maxBytes: number): string => {
  if (typeof value !== 'string' || value !== value.trim() || new TextEncoder().encode(value).byteLength > maxBytes) {
    throw new Error(code);
  }
  return value;
};

const canonicalAddress = (value: unknown, code: string): string => {
  const text = requireString(value, code);
  let normalized: string;
  try {
    normalized = getAddress(text).toLowerCase();
  } catch {
    throw new Error(code);
  }
  if (text !== normalized) throw new Error(`${code}_NOT_CANONICAL`);
  return normalized;
};

const rpcUrl = (value: unknown): string => {
  const text = boundedText(value, 'JURISDICTION_GOSSIP_RPC_URL_INVALID', 2_048);
  let parsed: URL;
  try {
    parsed = new URL(text);
  } catch {
    throw new Error('JURISDICTION_GOSSIP_RPC_URL_INVALID');
  }
  if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || parsed.username || parsed.password) {
    throw new Error('JURISDICTION_GOSSIP_RPC_URL_INVALID');
  }
  return text;
};

const unsignedAnnouncement = (
  announcement: JurisdictionGossipAnnouncement,
): UnsignedAnnouncement => {
  const { signature: _signature, ...unsigned } = announcement;
  return unsigned;
};

export const computeJurisdictionGossipHash = (
  announcement: JurisdictionGossipAnnouncement | UnsignedAnnouncement,
): string => keccak256(new TextEncoder().encode(encodeCanonicalConsensusValue(
  'signature' in announcement ? unsignedAnnouncement(announcement) : announcement,
)));

const assertCanonicalSignature = (signature: string, hash: string, signerId: string): void => {
  if (!/^0x[0-9a-f]{130}$/.test(signature)) throw new Error('JURISDICTION_GOSSIP_SIGNATURE_INVALID');
  let parsed: Signature;
  try {
    parsed = Signature.from(signature);
  } catch {
    throw new Error('JURISDICTION_GOSSIP_SIGNATURE_INVALID');
  }
  if (parsed.serialized.toLowerCase() !== signature || recoverAddress(hash, parsed).toLowerCase() !== signerId) {
    throw new Error('JURISDICTION_GOSSIP_SIGNATURE_INVALID');
  }
};

const decodeAnnouncement = (
  value: unknown,
  officialFoundationSignerId?: string,
  requireOfficialAuthority = true,
): JurisdictionGossipAnnouncement => {
  const record = requireBoundaryRecord(value, 'JURISDICTION_GOSSIP_ANNOUNCEMENT_INVALID');
  requireExactBoundaryKeys(record, ROOT_KEYS, ['description'], 'JURISDICTION_GOSSIP_FIELDS_INVALID');
  if (record['domain'] !== JURISDICTION_GOSSIP_DOMAIN || record['stackVersion'] !== 'V1') {
    throw new Error('JURISDICTION_GOSSIP_VERSION_INVALID');
  }
  if (record['scope'] !== 'community' && record['scope'] !== 'official') {
    throw new Error('JURISDICTION_GOSSIP_SCOPE_INVALID');
  }
  const contractsRecord = requireBoundaryRecord(record['contracts'], 'JURISDICTION_GOSSIP_CONTRACTS_INVALID');
  requireExactBoundaryKeys(contractsRecord, CONTRACT_KEYS, [], 'JURISDICTION_GOSSIP_CONTRACT_FIELDS_INVALID');
  const contracts = Object.fromEntries(CONTRACT_KEYS.map((key) => [
    key,
    canonicalAddress(contractsRecord[key], `JURISDICTION_GOSSIP_CONTRACT_${key.toUpperCase()}_INVALID`),
  ])) as JurisdictionGossipAnnouncement['contracts'];
  const stablecoinRecord = requireBoundaryRecord(record['stablecoin'], 'JURISDICTION_GOSSIP_STABLECOIN_INVALID');
  requireExactBoundaryKeys(stablecoinRecord, ['symbol', 'address', 'tokenId', 'decimals'], [], 'JURISDICTION_GOSSIP_STABLECOIN_FIELDS_INVALID');
  if (stablecoinRecord['symbol'] !== 'USDT' || stablecoinRecord['tokenId'] !== 1 || stablecoinRecord['decimals'] !== 6) {
    throw new Error('JURISDICTION_GOSSIP_STABLECOIN_INVALID');
  }
  const announcement: JurisdictionGossipAnnouncement = {
    domain: JURISDICTION_GOSSIP_DOMAIN,
    stackVersion: 'V1',
    scope: record['scope'],
    key: boundedText(record['key'], 'JURISDICTION_GOSSIP_KEY_INVALID', 64),
    name: boundedText(record['name'], 'JURISDICTION_GOSSIP_NAME_INVALID', 128),
    rpcUrl: rpcUrl(record['rpcUrl']),
    blockTimeMs: requireBoundaryInteger(record['blockTimeMs'], 'JURISDICTION_GOSSIP_BLOCK_TIME_INVALID', 1),
    currency: boundedText(record['currency'], 'JURISDICTION_GOSSIP_CURRENCY_INVALID', 32),
    explorer: boundedTrimmedText(record['explorer'], 'JURISDICTION_GOSSIP_EXPLORER_INVALID', 2_048),
    ...(record['description'] === undefined ? {} : {
      description: boundedText(record['description'], 'JURISDICTION_GOSSIP_DESCRIPTION_INVALID', 1_024),
    }),
    chainId: requireBoundaryInteger(record['chainId'], 'JURISDICTION_GOSSIP_CHAIN_ID_INVALID', 1),
    deployer: canonicalAddress(record['deployer'], 'JURISDICTION_GOSSIP_DEPLOYER_INVALID'),
    foundationRecipient: canonicalAddress(record['foundationRecipient'], 'JURISDICTION_GOSSIP_FOUNDATION_INVALID'),
    entityProviderDeploymentBlock: requireBoundaryInteger(record['entityProviderDeploymentBlock'], 'JURISDICTION_GOSSIP_DEPLOYMENT_BLOCK_INVALID', 1),
    contracts,
    stablecoin: {
      symbol: 'USDT',
      address: canonicalAddress(stablecoinRecord['address'], 'JURISDICTION_GOSSIP_STABLECOIN_ADDRESS_INVALID'),
      tokenId: 1,
      decimals: 6,
    },
    signerId: canonicalAddress(record['signerId'], 'JURISDICTION_GOSSIP_SIGNER_INVALID'),
    signature: requireString(record['signature'], 'JURISDICTION_GOSSIP_SIGNATURE_INVALID'),
  };
  if (announcement.signerId !== announcement.deployer) {
    throw new Error('JURISDICTION_GOSSIP_DEPLOYER_SIGNATURE_REQUIRED');
  }
  if (announcement.scope === 'official') {
    if (announcement.signerId !== announcement.foundationRecipient) {
      throw new Error('JURISDICTION_GOSSIP_OFFICIAL_FOUNDATION_SIGNATURE_REQUIRED');
    }
    const trusted = officialFoundationSignerId
      ? canonicalAddress(officialFoundationSignerId.toLowerCase(), 'JURISDICTION_GOSSIP_OFFICIAL_AUTHORITY_INVALID')
      : '';
    if (requireOfficialAuthority && (!trusted || announcement.signerId !== trusted)) {
      throw new Error('JURISDICTION_GOSSIP_OFFICIAL_AUTHORITY_INVALID');
    }
  }
  assertCanonicalSignature(announcement.signature, computeJurisdictionGossipHash(announcement), announcement.signerId);
  return announcement;
};

export const decodeJurisdictionGossipAnnouncement = (
  value: unknown,
  officialFoundationSignerId?: string,
): JurisdictionGossipAnnouncement => decodeAnnouncement(value, officialFoundationSignerId, true);

/** Authenticated daemon responses already applied the local official trust root. */
export const decodeJurisdictionGossipAnnouncementStructure = (
  value: unknown,
): JurisdictionGossipAnnouncement => decodeAnnouncement(value, undefined, false);

export const createJurisdictionGossipAnnouncement = (
  input: Omit<UnsignedAnnouncement, 'domain' | 'stackVersion' | 'signerId'>,
  signerPrivateKey: Uint8Array,
  officialFoundationSignerId?: string,
): JurisdictionGossipAnnouncement => {
  const wallet = new Wallet(hexlify(signerPrivateKey));
  const unsigned: UnsignedAnnouncement = {
    domain: JURISDICTION_GOSSIP_DOMAIN,
    stackVersion: 'V1',
    ...input,
    deployer: input.deployer.toLowerCase(),
    foundationRecipient: input.foundationRecipient.toLowerCase(),
    contracts: Object.fromEntries(Object.entries(input.contracts).map(([key, address]) => [key, address.toLowerCase()])) as JurisdictionGossipAnnouncement['contracts'],
    stablecoin: { ...input.stablecoin, address: input.stablecoin.address.toLowerCase() },
    signerId: wallet.address.toLowerCase(),
  };
  const signature = wallet.signingKey.sign(computeJurisdictionGossipHash(unsigned)).serialized.toLowerCase();
  return decodeJurisdictionGossipAnnouncement({ ...unsigned, signature }, officialFoundationSignerId);
};
