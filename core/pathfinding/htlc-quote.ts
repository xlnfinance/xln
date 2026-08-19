import type { Profile } from '../entity/profile';
import { getTokenCapacity } from './capacity';
import { calculateDirectionalFeePPM, sanitizeBaseFee, sanitizeFeePPM } from './fees';
import { calculateRequiredInboundForDesiredForward } from '../protocol/htlc/utils';

export type RoutingProfile = Pick<Profile, 'entityId' | 'accounts' | 'entityEncryptionPublicKey'> & {
  metadata: Pick<Profile['metadata'], 'routingFeePPM' | 'baseFee'>;
};

/**
 * `entityId` (lowercased) -> every Profile advertising it. Built once per frame
 * so a route/frame touching many payments does one O(N) pass instead of an
 * O(N) `Array.filter` per lookup — this index is looked up ~10x per payment
 * (source profile, per-hop public key, per-hop account domain, per-hop fee),
 * so without it a frame of M payments costs O(N*M) instead of O(N+M).
 */
export type RoutingProfileIndex = ReadonlyMap<string, readonly RoutingProfile[]>;

export const buildRoutingProfileIndex = (profiles: readonly RoutingProfile[]): RoutingProfileIndex => {
  const index = new Map<string, RoutingProfile[]>();
  for (const profile of profiles) {
    const id = profile.entityId.toLowerCase();
    const bucket = index.get(id);
    if (bucket) bucket.push(profile); else index.set(id, [profile]);
  }
  return index;
};

/** The one canonical "exactly one Profile advertises this entity" lookup — reused by every HTLC routing helper. */
export const lookupUniqueRoutingProfile = (index: RoutingProfileIndex, entityId: string): RoutingProfile => {
  const id = entityId.toLowerCase();
  const matches = index.get(id) ?? [];
  if (matches.length !== 1) throw new Error(`HTLC_PAYMENT_PROFILE_MATCH_COUNT:${id}:${matches.length}`);
  return matches[0]!;
};

/**
 * Capacity of the `from -> to` lane as the forwarder would see it.
 *
 * Only the side that opened an Account advertises it, so exactly one of the two
 * Profiles carries the row for any lane. The counterparty's row describes the
 * same bilateral Account from the other end, so its directions are the mirror
 * of the forwarder's and are swapped rather than refused.
 */
const hopCapacity = (
  index: RoutingProfileIndex,
  from: string,
  to: string,
  tokenId: number,
): { outCapacity: bigint; inCapacity: bigint } => {
  const own = lookupUniqueRoutingProfile(index, from).accounts
    .find(candidate => candidate.counterpartyId.toLowerCase() === to);
  if (own) {
    const capacity = getTokenCapacity(own.tokenCapacities, tokenId);
    if (!capacity) throw new Error(`HTLC_PAYMENT_PROFILE_TOKEN_NOT_ADVERTISED:${from}:${to}:${tokenId}`);
    return { outCapacity: capacity.outCapacity, inCapacity: capacity.inCapacity };
  }
  const mirror = lookupUniqueRoutingProfile(index, to).accounts
    .find(candidate => candidate.counterpartyId.toLowerCase() === from);
  if (!mirror) throw new Error(`HTLC_PAYMENT_PROFILE_ACCOUNT_MISSING:${from}:${to}`);
  const capacity = getTokenCapacity(mirror.tokenCapacities, tokenId);
  if (!capacity) throw new Error(`HTLC_PAYMENT_PROFILE_TOKEN_NOT_ADVERTISED:${from}:${to}:${tokenId}`);
  return { outCapacity: capacity.inCapacity, inCapacity: capacity.outCapacity };
};

const feeForHop = (
  index: RoutingProfileIndex,
  intermediary: string,
  nextHop: string,
  tokenId: number,
) => {
  const profile = lookupUniqueRoutingProfile(index, intermediary);
  const capacity = hopCapacity(index, intermediary, nextHop, tokenId);
  return {
    feePpm: calculateDirectionalFeePPM(
      sanitizeFeePPM(profile.metadata.routingFeePPM ?? 1, 1),
      capacity.outCapacity,
      capacity.inCapacity,
    ),
    baseFee: sanitizeBaseFee(profile.metadata.baseFee ?? 0n),
  };
};

export const quoteHtlcPaymentRouteWithIndex = (
  index: RoutingProfileIndex,
  route: string[],
  tokenId: number,
  recipientAmount: bigint,
): { senderLockAmount: bigint; hopForwardAmounts: Map<string, bigint> } => {
  let inbound = recipientAmount;
  const hopForwardAmounts = new Map<string, bigint>();
  for (let index2 = route.length - 2; index2 >= 1; index2 -= 1) {
    const intermediary = route[index2]!;
    const nextHop = route[index2 + 1]!;
    hopForwardAmounts.set(intermediary, inbound);
    const fee = feeForHop(index, intermediary, nextHop, tokenId);
    inbound = calculateRequiredInboundForDesiredForward(inbound, fee.feePpm, fee.baseFee);
  }
  return { senderLockAmount: inbound, hopForwardAmounts };
};

/** Convenience wrapper for one-off callers (scenarios, tests) that don't already hold a prebuilt index. */
export const quoteHtlcPaymentRoute = (
  profiles: readonly RoutingProfile[],
  route: string[],
  tokenId: number,
  recipientAmount: bigint,
): { senderLockAmount: bigint; hopForwardAmounts: Map<string, bigint> } =>
  quoteHtlcPaymentRouteWithIndex(buildRoutingProfileIndex(profiles), route, tokenId, recipientAmount);
