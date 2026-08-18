import type { Profile } from '../entity/profile';
import { getTokenCapacity } from './capacity';
import { calculateDirectionalFeePPM, sanitizeBaseFee, sanitizeFeePPM } from './fees';
import { calculateRequiredInboundForDesiredForward } from '../protocol/htlc/utils';

export type RoutingProfile = Pick<Profile, 'entityId' | 'accounts' | 'entityEncryptionPublicKey'> & {
  metadata: Pick<Profile['metadata'], 'routingFeePPM' | 'baseFee'>;
};

const uniqueProfile = (profiles: readonly RoutingProfile[], entityId: string): RoutingProfile => {
  const matches = profiles.filter(profile => profile.entityId.toLowerCase() === entityId);
  if (matches.length !== 1) throw new Error(`HTLC_PAYMENT_PROFILE_MATCH_COUNT:${entityId}:${matches.length}`);
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
  profiles: readonly RoutingProfile[],
  from: string,
  to: string,
  tokenId: number,
): { outCapacity: bigint; inCapacity: bigint } => {
  const own = uniqueProfile(profiles, from).accounts
    .find(candidate => candidate.counterpartyId.toLowerCase() === to);
  if (own) {
    const capacity = getTokenCapacity(own.tokenCapacities, tokenId);
    if (!capacity) throw new Error(`HTLC_PAYMENT_PROFILE_TOKEN_NOT_ADVERTISED:${from}:${to}:${tokenId}`);
    return { outCapacity: capacity.outCapacity, inCapacity: capacity.inCapacity };
  }
  const mirror = uniqueProfile(profiles, to).accounts
    .find(candidate => candidate.counterpartyId.toLowerCase() === from);
  if (!mirror) throw new Error(`HTLC_PAYMENT_PROFILE_ACCOUNT_MISSING:${from}:${to}`);
  const capacity = getTokenCapacity(mirror.tokenCapacities, tokenId);
  if (!capacity) throw new Error(`HTLC_PAYMENT_PROFILE_TOKEN_NOT_ADVERTISED:${from}:${to}:${tokenId}`);
  return { outCapacity: capacity.inCapacity, inCapacity: capacity.outCapacity };
};

const feeForHop = (
  profiles: readonly RoutingProfile[],
  intermediary: string,
  nextHop: string,
  tokenId: number,
) => {
  const profile = uniqueProfile(profiles, intermediary);
  const capacity = hopCapacity(profiles, intermediary, nextHop, tokenId);
  return {
    feePpm: calculateDirectionalFeePPM(
      sanitizeFeePPM(profile.metadata.routingFeePPM ?? 1, 1),
      capacity.outCapacity,
      capacity.inCapacity,
    ),
    baseFee: sanitizeBaseFee(profile.metadata.baseFee ?? 0n),
  };
};

export const quoteHtlcPaymentRoute = (
  profiles: readonly RoutingProfile[],
  route: string[],
  tokenId: number,
  recipientAmount: bigint,
): { senderLockAmount: bigint; hopForwardAmounts: Map<string, bigint> } => {
  let inbound = recipientAmount;
  const hopForwardAmounts = new Map<string, bigint>();
  for (let index = route.length - 2; index >= 1; index -= 1) {
    const intermediary = route[index]!;
    const nextHop = route[index + 1]!;
    hopForwardAmounts.set(intermediary, inbound);
    const fee = feeForHop(profiles, intermediary, nextHop, tokenId);
    inbound = calculateRequiredInboundForDesiredForward(inbound, fee.feePpm, fee.baseFee);
  }
  return { senderLockAmount: inbound, hopForwardAmounts };
};
