/**
 * Shared helpers for reading token capacities from gossip profiles.
 * Supports both Map-backed and JSON/plain-object-backed tokenCapacities.
 */

export type TokenCapacityLike = {
  inCapacity?: unknown;
  outCapacity?: unknown;
} | null | undefined;

export const normalizeBigInt = (value: unknown): bigint => {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return BigInt(Math.floor(value));
  if (typeof value === 'string' && value.trim() !== '') {
    const trimmed = value.trim();
    const parsed = trimmed.startsWith('BigInt(') && trimmed.endsWith(')')
      ? trimmed.slice(7, -1).trim()
      : trimmed;
    try {
      return BigInt(parsed);
    } catch {
      return 0n;
    }
  }
  return 0n;
};

type TokenCapContainer =
  | Map<number | string, TokenCapacityLike>
  | Record<string | number, TokenCapacityLike>
  | null
  | undefined;

export const getTokenCapacity = (
  tokenCapacities: TokenCapContainer,
  tokenId: number
): { inCapacity: bigint; outCapacity: bigint } | null => {
  if (!tokenCapacities) return null;

  let raw: TokenCapacityLike;
  if (tokenCapacities instanceof Map) {
    raw = tokenCapacities.get(tokenId) ?? tokenCapacities.get(String(tokenId));
  } else {
    raw = tokenCapacities[String(tokenId)] ?? tokenCapacities[tokenId];
  }

  if (!raw) return null;
  return {
    inCapacity: normalizeBigInt(raw.inCapacity ?? 0n),
    outCapacity: normalizeBigInt(raw.outCapacity ?? 0n),
  };
};

