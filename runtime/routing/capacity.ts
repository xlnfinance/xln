/** Read already-canonical BigInt capacities from a parsed gossip profile. */

export type TokenCapacityLike = {
  inCapacity: bigint;
  outCapacity: bigint;
} | null | undefined;

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
  return raw;
};
