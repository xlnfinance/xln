/** An HTLC is active only while the Entity timestamp is strictly before its timelock. */
export const isHtlcTimelockExpired = (entityTimestamp: number, timelock: bigint): boolean =>
  BigInt(entityTimestamp) >= timelock;
