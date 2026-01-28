/**
 * Entity ID normalization, comparison, and universal parsing helpers.
 * Ensures deterministic ordering and cross-provider compatibility.
 */

import { ethers } from 'ethers';

/**
 * Normalize entity ID to consistent 0x-prefixed 64-char hex (32 bytes).
 */
export function normalizeEntityId(id: string): string {
  const raw = String(id).toLowerCase();
  if (!raw.startsWith('0x')) {
    return raw;
  }
  const hex = raw.slice(2);
  if (!/^[0-9a-f]*$/.test(hex)) {
    return raw;
  }
  if (hex.length === 64) {
    return raw;
  }
  if (hex.length < 64) {
    return `0x${hex.padStart(64, '0')}`;
  }
  return raw;
}

/**
 * Compare two entity IDs lexicographically.
 * Returns negative if a < b, 0 if equal, positive if a > b.
 */
export function compareEntityIds(a: string, b: string): number {
  const left = normalizeEntityId(a);
  const right = normalizeEntityId(b);
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

/**
 * Check if entity A is the "left" side of a bilateral account.
 * Left entity always has the lexicographically smaller ID.
 */
export function isLeftEntity(a: string, b: string): boolean {
  return compareEntityIds(a, b) < 0;
}

// ═══════════════════════════════════════════════════════════════════════════════
// UNIVERSAL ENTITY ID PARSER
// Handles multiple input formats and resolves to provider-scoped 32-byte hash
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Universal Entity ID format:
 *   hash(abi.encodePacked(providerAddress, entityIdHash))
 *
 * This allows the same entity ID to exist on different EntityProviders
 * (similar to OAuth where user@google differs from user@github).
 *
 * TODO(provider-scoped-entities): This format is DEFINED but NOT YET USED
 *
 * Current state (MVP):
 *   - entityId = boardHash (lazy entities)
 *   - Single EntityProvider per Depository
 *   - 65-byte short hanko (signature only)
 *
 * Future state (multi-EP):
 *   - entityAddress = createProviderScopedEntityId(provider, entityId)
 *   - Multiple EPs can authenticate in same Depository
 *   - Extended hanko format: sig(65) + entityId(32) + providerAddress(20) = 117 bytes
 *   - Hanko verifier reconstructs entityAddress from embedded fields
 *
 * Why extend hanko?
 *   - Signature alone can't prove which EP the entity belongs to
 *   - Verifier needs (provider, entityId) to compute entityAddress
 *   - Without this, same boardHash on different EPs would collide
 *
 * Migration path:
 *   1. Keep short hanko for self-entities (single signer, known EP)
 *   2. Use extended hanko for cross-EP operations
 *   3. Hanko version byte (0x00=short, 0x01=extended) for backwards compat
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
  const packed = ethers.solidityPacked(
    ['address', 'bytes32'],
    [providerAddr, normalizedEntity]
  );

  // Hash to get final 32-byte ID
  return ethers.keccak256(packed);
}

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
  lookupFn?: (query: string) => string | null
): ParsedEntityId {
  const trimmed = input.trim();

  // Provider-scoped format: "provider:entityId"
  if (trimmed.includes(':') && !trimmed.startsWith('0x')) {
    const [providerPart, entityPart] = trimmed.split(':', 2);
    if (providerPart && entityPart) {
      const provider = providerPart.startsWith('0x') ? providerPart : `0x${providerPart}`;
      const innerParsed = parseUniversalEntityId(entityPart, provider, lookupFn);
      return {
        ...innerParsed,
        provider,
        inputType: 'provider-scoped',
        // Create provider-scoped hash
        entityId: createProviderScopedEntityId(provider, innerParsed.entityId),
      };
    }
  }

  // Full 32-byte hex (with or without 0x)
  const hexMatch = trimmed.match(/^(0x)?([0-9a-fA-F]{64})$/);
  if (hexMatch) {
    const entityId = normalizeEntityId(`0x${hexMatch[2]}`);
    return {
      input: trimmed,
      entityId,
      provider: defaultProvider,
      inputType: 'full',
      shortId: getShortId(entityId),
      needsProfileLookup: false,
    };
  }

  // Short hex ID: "#ABCD" or "ABCD" (4 hex chars)
  const shortHexMatch = trimmed.match(/^#?([0-9a-fA-F]{4})$/i);
  if (shortHexMatch) {
    const shortHex = shortHexMatch[1]!.toLowerCase();
    // Try lookup function first
    if (lookupFn) {
      const resolved = lookupFn(shortHex);
      if (resolved) {
        return {
          input: trimmed,
          entityId: normalizeEntityId(resolved),
          provider: defaultProvider,
          inputType: 'short',
          shortId: shortHex.toUpperCase(),
          needsProfileLookup: false,
        };
      }
    }
    // Can't resolve without lookup - mark as needing profile
    return {
      input: trimmed,
      entityId: `0x${shortHex.padEnd(64, '0')}`, // Placeholder
      provider: defaultProvider,
      inputType: 'short',
      shortId: shortHex.toUpperCase(),
      needsProfileLookup: true,
    };
  }

  // Numbered entity: "#5" or "5" (decimal)
  const numberedMatch = trimmed.match(/^#?(\d+)$/);
  if (numberedMatch) {
    const num = BigInt(numberedMatch[1]!);
    const NUMERIC_THRESHOLD = BigInt(256 ** 6); // 281 trillion

    if (num >= 0n && num < NUMERIC_THRESHOLD) {
      const entityId = `0x${num.toString(16).padStart(64, '0')}`;
      return {
        input: trimmed,
        entityId,
        provider: defaultProvider,
        inputType: 'numbered',
        shortId: num.toString(),
        needsProfileLookup: false,
      };
    }
  }

  // Named entity: "@alice" or "alice.xln"
  const namedMatch = trimmed.match(/^@?([a-zA-Z][a-zA-Z0-9_.-]*)$/);
  if (namedMatch) {
    const name = namedMatch[1]!.toLowerCase();
    // Try lookup function
    if (lookupFn) {
      const resolved = lookupFn(name);
      if (resolved) {
        return {
          input: trimmed,
          entityId: normalizeEntityId(resolved),
          provider: defaultProvider,
          inputType: 'named',
          shortId: name,
          needsProfileLookup: false,
        };
      }
    }
    // Hash the name as entity ID (on-chain name resolution)
    const entityId = ethers.keccak256(ethers.toUtf8Bytes(name));
    return {
      input: trimmed,
      entityId,
      provider: defaultProvider,
      inputType: 'named',
      shortId: name,
      needsProfileLookup: true,
    };
  }

  // Fallback: treat as raw hex
  const rawHex = trimmed.startsWith('0x') ? trimmed : `0x${trimmed}`;
  return {
    input: trimmed,
    entityId: normalizeEntityId(rawHex),
    provider: defaultProvider,
    inputType: 'full',
    shortId: getShortId(rawHex),
    needsProfileLookup: false,
  };
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

/**
 * Format entity ID for display with optional provider prefix.
 * @param entityId - The entity ID
 * @param provider - Optional provider address
 * @returns Display string like "#1234" or "e7f1:#1234"
 */
export function formatEntityIdDisplay(entityId: string, provider?: string): string {
  const shortId = getShortId(entityId);

  if (provider) {
    const providerShort = provider.slice(2, 6).toLowerCase();
    return `${providerShort}:#${shortId}`;
  }

  return `#${shortId}`;
}

/**
 * Check if two entity IDs refer to the same entity (ignoring provider scope).
 * Use this for local comparisons within the same provider.
 */
export function entityIdsEqual(a: string, b: string): boolean {
  return normalizeEntityId(a) === normalizeEntityId(b);
}

/**
 * Extract provider address from a provider-scoped entity ID input.
 * Returns null if no provider specified.
 */
export function extractProvider(input: string): string | null {
  const trimmed = input.trim();
  if (trimmed.includes(':') && !trimmed.startsWith('0x')) {
    const [providerPart] = trimmed.split(':', 2);
    if (providerPart) {
      return providerPart.startsWith('0x') ? providerPart : `0x${providerPart}`;
    }
  }
  return null;
}
