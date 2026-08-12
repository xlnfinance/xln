/**
 * Entity ID normalization, comparison, and universal parsing helpers.
 * Ensures deterministic ordering and cross-provider compatibility.
 */

import { ethers } from 'ethers';
import { normalizeEntityId } from '../protocol/identity/entity-id';

export { compareEntityIds, isLeftEntity, normalizeEntityId } from '../protocol/identity/entity-id';

// ═══════════════════════════════════════════════════════════════════════════════
// UNIVERSAL ENTITY ID PARSER
// Handles multiple input formats and resolves to provider-scoped 32-byte hash
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Universal Entity ID format:
 *   hash(abi.encodePacked(providerAddress, entityIdHash))
 *
 * This lets tooling address an entity under a specific EntityProvider.
 *   - Without this, same boardHash on different EPs would collide
 */

export interface ParsedEntityId {
  // The original input
  input: string;
  // Resolved entity ID (32-byte hash)
  entityId: string;
  // Provider address if specified (otherwise uses default)
  provider: string | undefined;
  // Input type detected
  inputType: 'full' | 'short' | 'numbered' | 'named' | 'provider-scoped';
  // Short ID for display (4 chars for hash, decimal for numbered)
  shortId: string;
  // Whether this needs profile lookup
  needsProfileLookup: boolean;
}

/**
 * Create a provider-scoped entity ID.
 * Universal format: keccak256(abi.encodePacked(provider, entityId))
 *
 * @param provider - EntityProvider contract address
 * @param entityId - The entity's ID within that provider (32 bytes)
 * @returns Globally unique 32-byte hash
 */
export function createProviderScopedEntityId(provider: string, entityId: string): string {
  // Normalize inputs
  const providerAddr = ethers.getAddress(provider); // Checksum address
  const normalizedEntity = normalizeEntityId(entityId);

  // ABI encode packed: address (20 bytes) + bytes32 (32 bytes)
  const packed = ethers.solidityPacked(['address', 'bytes32'], [providerAddr, normalizedEntity]);

  // Hash to get final 32-byte ID
  return ethers.keccak256(packed);
}

type EntityIdLookup = (query: string) => string | null;

const parsedEntityId = (
  input: string,
  entityId: string,
  provider: string | undefined,
  inputType: ParsedEntityId['inputType'],
  shortId: string,
  needsProfileLookup: boolean,
): ParsedEntityId => ({
  input,
  entityId,
  provider,
  inputType,
  shortId,
  needsProfileLookup,
});

const parseProviderScopedId = (input: string, lookupFn?: EntityIdLookup): ParsedEntityId | undefined => {
  const separator = input.indexOf(':');
  if (separator < 1 || separator !== input.lastIndexOf(':')) return undefined;
  const providerPart = input.slice(0, separator);
  const entityPart = input.slice(separator + 1);
  if (!entityPart) throw new Error('ENTITY_ID_PROVIDER_SCOPE_ENTITY_MISSING');
  const provider = providerPart.startsWith('0x') ? providerPart : `0x${providerPart}`;
  const inner = parseUniversalEntityId(entityPart, provider, lookupFn);
  return {
    ...inner,
    input,
    provider,
    inputType: 'provider-scoped',
    entityId: createProviderScopedEntityId(provider, inner.entityId),
  };
};

const parseFullEntityId = (input: string, provider?: string): ParsedEntityId | undefined => {
  const match = input.match(/^(0x)?([0-9a-fA-F]{64})$/);
  if (!match) return undefined;
  const entityId = normalizeEntityId(`0x${match[2]}`);
  return parsedEntityId(input, entityId, provider, 'full', getShortId(entityId), false);
};

const parseShortEntityId = (
  input: string,
  provider?: string,
  lookupFn?: EntityIdLookup,
): ParsedEntityId | undefined => {
  const match = input.match(/^#?([0-9a-fA-F]{4})$/i);
  if (!match) return undefined;
  const shortId = match[1]!.toLowerCase();
  const resolved = lookupFn?.(shortId);
  if (resolved) {
    return parsedEntityId(input, normalizeEntityId(resolved), provider, 'short', shortId.toUpperCase(), false);
  }
  return parsedEntityId(input, `0x${shortId.padEnd(64, '0')}`, provider, 'short', shortId.toUpperCase(), true);
};

const parseNumberedEntityId = (input: string, provider?: string): ParsedEntityId | undefined => {
  const match = input.match(/^#?(\d+)$/);
  if (!match) return undefined;
  const number = BigInt(match[1]!);
  if (number >= BigInt(256 ** 6)) return undefined;
  return parsedEntityId(
    input,
    `0x${number.toString(16).padStart(64, '0')}`,
    provider,
    'numbered',
    number.toString(),
    false,
  );
};

const parseNamedEntityId = (
  input: string,
  provider?: string,
  lookupFn?: EntityIdLookup,
): ParsedEntityId | undefined => {
  const match = input.match(/^@?([a-zA-Z][a-zA-Z0-9_.-]*)$/);
  if (!match) return undefined;
  const name = match[1]!.toLowerCase();
  const resolved = lookupFn?.(name);
  if (resolved) {
    return parsedEntityId(input, normalizeEntityId(resolved), provider, 'named', name, false);
  }
  const entityId = ethers.keccak256(ethers.toUtf8Bytes(name));
  return parsedEntityId(input, entityId, provider, 'named', name, true);
};

/**
 * Parse any entity ID input format and resolve to canonical form.
 *
 * Supported formats:
 * 1. Full 32-byte hex: "0x1234...5678" (64 hex chars)
 * 2. Short ID: "#1234" or "1234" (first 4 chars of hex)
 * 3. Numbered entity: "#5" or "5" (decimal < 256^6)
 * 4. Named entity: "@alice" or "alice.xln"
 * 5. Provider-scoped: "provider:entityId" or "0xe7f1...:0xb7aa..."
 *
 * @param input - Raw user input
 * @param defaultProvider - Default EntityProvider if not specified
 * @param lookupFn - Optional function to resolve short IDs / names
 * @returns Parsed entity ID with metadata
 */
export function parseUniversalEntityId(
  input: string,
  defaultProvider?: string,
  lookupFn?: (query: string) => string | null,
): ParsedEntityId {
  const trimmed = input.trim();
  if (!trimmed) throw new Error('ENTITY_ID_EMPTY');
  const parsed =
    parseProviderScopedId(trimmed, lookupFn) ??
    parseFullEntityId(trimmed, defaultProvider) ??
    parseShortEntityId(trimmed, defaultProvider, lookupFn) ??
    parseNumberedEntityId(trimmed, defaultProvider) ??
    parseNamedEntityId(trimmed, defaultProvider, lookupFn);
  if (parsed) return parsed;
  // There is no raw-hex fallback. Accepting malformed identifiers as if they
  // were canonical makes typos address a different Entity instead of failing.
  throw new Error(`ENTITY_ID_FORMAT_INVALID:${trimmed}`);
}

/**
 * Get short display ID for an entity.
 * Numbered entities: decimal string
 * Hash entities: first 4 hex chars uppercase
 */
export function getShortId(entityId: string): string {
  const normalized = normalizeEntityId(entityId);
  const hex = normalized.slice(2); // Remove 0x

  try {
    const value = BigInt(normalized);
    const NUMERIC_THRESHOLD = BigInt(256 ** 6);

    if (value >= 0n && value < NUMERIC_THRESHOLD) {
      return value.toString(); // Decimal for numbered entities
    }
  } catch {
    // Not a valid BigInt, use hash mode
  }

  // Hash mode: first 4 chars uppercase
  return hex.slice(0, 4).toUpperCase();
}
