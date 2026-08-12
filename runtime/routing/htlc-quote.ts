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

const feeForHop = (profile: RoutingProfile, nextHop: string, tokenId: number) => {
  const account = profile.accounts.find(candidate => candidate.counterpartyId.toLowerCase() === nextHop);
  if (!account) throw new Error(`HTLC_PAYMENT_PROFILE_ACCOUNT_MISSING:${profile.entityId}:${nextHop}`);
  const capacity = getTokenCapacity(account.tokenCapacities, tokenId);
  if (!capacity) {
    throw new Error(`HTLC_PAYMENT_PROFILE_TOKEN_NOT_ADVERTISED:${profile.entityId}:${nextHop}:${tokenId}`);
  }
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
    const fee = feeForHop(uniqueProfile(profiles, intermediary), nextHop, tokenId);
    inbound = calculateRequiredInboundForDesiredForward(inbound, fee.feePpm, fee.baseFee);
  }
  return { senderLockAmount: inbound, hopForwardAmounts };
};
