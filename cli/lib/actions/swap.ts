import {
  computeSwapPriceTicks,
  planSwapCommand,
} from '../../../runtime/runtime.ts';
import type { CliSession } from '../session';
import { submitAndWait } from '../session';
import { findAccount } from '../accounts';

const normalizedId = (value: unknown): string => String(value || '').trim().toLowerCase();

export const resolveCliSwapPartyRoles = (
  session: CliSession,
  hubEntityId: string,
) => {
  const sourceEntityId = normalizedId(session.entityId);
  const hubId = normalizedId(hubEntityId);
  const committedRoles = new Map<string, boolean>();
  for (const replica of session.env.state.eReplicas.values()) {
    const entityId = normalizedId(replica.state.entityId);
    const isHub = replica.state.profile?.metadata?.isHub;
    if (entityId && typeof isHub === 'boolean') committedRoles.set(entityId, isHub);
  }
  const sourceIsHub = committedRoles.get(sourceEntityId);
  const committedHubRole = committedRoles.get(hubId);
  const gossipHub = session.env.gossip.getProfiles().find(profile => (
    normalizedId(profile.entityId) === hubId && profile.metadata?.isHub === true
  ));
  if (typeof sourceIsHub !== 'boolean' || (committedHubRole !== true && !gossipHub)) {
    throw new Error(`CLI_SWAP_PARTY_ROLE_UNAVAILABLE:${sourceEntityId}:${hubId}`);
  }
  return {
    entityRoleEvidence: {
      entityId: sourceEntityId,
      isHub: sourceIsHub,
      source: 'committed-profile' as const,
    },
    hubRoleEvidence: {
      entityId: hubId,
      isHub: true,
      source: committedHubRole === true
        ? 'committed-profile' as const
        : 'verified-gossip-profile' as const,
    },
    committedRoles,
  };
};

export const placeSwap = async (
  session: CliSession,
  args: {
    hubEntityId: string;
    giveTokenId: number;
    wantTokenId: number;
    giveAmount: bigint;
    wantAmount: bigint;
  },
): Promise<number> => {
  const hubEntityId = args.hubEntityId.toLowerCase();
  const accountReplica = findAccount(session.env, session.entityId, hubEntityId);
  if (!accountReplica) throw new Error(`No account with hub ${hubEntityId}. Open it first.`);

  const priceTicks = computeSwapPriceTicks(
    args.giveTokenId,
    args.wantTokenId,
    args.giveAmount,
    args.wantAmount,
  );

  // hubSignerId is the hub's validator id from gossip when known; for same-j
  // capacity planning the source account state is what matters. Use hub entity
  // id as a stable non-empty binder matching frontend when hub signer unknown.
  const hubSignerId = hubEntityId;
  const partyRoles = resolveCliSwapPartyRoles(session, hubEntityId);
  const plan = planSwapCommand({
    mode: 'same',
    logicalTimestamp: session.env.state.timestamp,
    logicalHeight: session.env.state.height,
    routeValue: `same:${args.giveTokenId}/${args.wantTokenId}`,
    giveTokenId: args.giveTokenId,
    wantTokenId: args.wantTokenId,
    giveAmount: args.giveAmount,
    priceTicks,
    source: {
      entityId: session.entityId,
      signerId: session.signerId,
      hubEntityId,
      hubSignerId,
      jurisdiction: session.jurisdictionName,
      ...partyRoles,
      account: accountReplica.state,
    },
  });

  return submitAndWait(session.env, plan.runtimeInput, () => true, 'swap', 45_000);
};
