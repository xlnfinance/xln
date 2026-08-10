import {
  deriveSwapNetAuthorization,
  planSwapCommand,
  prepareSwapOrder,
} from '../../../runtime/runtime.ts';
import type { CliSession } from '../session';
import { submitAndWait } from '../session';
import { findAccount } from '../accounts';
import { resolveCliHubPartyRoles } from '../account-role-evidence';
import { ensureCliProfiles } from '../profile-barrier';

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
  await ensureCliProfiles(session, [hubEntityId], 'CLI_SWAP');
  const hubProfile = session.env.gossip.getProfiles().find(
    profile => String(profile.entityId || '').toLowerCase() === hubEntityId,
  );
  if (!hubProfile || hubProfile.metadata?.isHub !== true) {
    throw new Error(`CLI_SWAP_HUB_PROFILE_UNAVAILABLE:${hubEntityId}`);
  }

  const preparedOrder = prepareSwapOrder(
    args.giveTokenId,
    args.wantTokenId,
    args.giveAmount,
    args.wantAmount,
  );
  if (!preparedOrder) throw new Error('CLI_SWAP_ORDER_TOO_SMALL');
  const priceTicks = preparedOrder.priceTicks;
  const swapNetAuthorization = deriveSwapNetAuthorization(
    preparedOrder.effectiveWant,
    hubProfile.metadata.swapTakerFeeBps ?? 0,
  );

  // hubSignerId is the hub's validator id from gossip when known; for same-j
  // capacity planning the source account state is what matters. Use hub entity
  // id as a stable non-empty binder matching frontend when hub signer unknown.
  const hubSignerId = hubEntityId;
  const partyRoles = resolveCliHubPartyRoles(session, hubEntityId);
  const plan = planSwapCommand({
    mode: 'same',
    logicalTimestamp: session.env.state.timestamp,
    logicalHeight: session.env.state.height,
    routeValue: `same:${args.giveTokenId}/${args.wantTokenId}`,
    giveTokenId: args.giveTokenId,
    wantTokenId: args.wantTokenId,
    giveAmount: args.giveAmount,
    priceTicks,
    ...swapNetAuthorization,
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
