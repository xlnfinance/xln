import {
  computeSwapPriceTicks,
  planSwapCommand,
} from '../../../runtime/runtime.ts';
import type { CliSession } from '../session';
import { submitAndWait } from '../session';
import { findAccount } from '../accounts';

export const placeSwap = async (
  session: CliSession,
  args: {
    hubEntityId: string;
    giveTokenId: number;
    wantTokenId: number;
    giveAmount: bigint;
    wantAmount: bigint;
  },
): Promise<void> => {
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
      account: accountReplica.state,
    },
  });

  await submitAndWait(session.env, plan.runtimeInput, () => true, 'swap', 45_000);
};
