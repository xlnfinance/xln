import type { AccountMachine, AccountTx, Env } from '../../../types';
import type { AccountJClaimSession } from '../../j-claim-session';
import { getAccountPerspective } from '../../../state-helpers';
import { applyAccountJClaimTransition } from '../../j-claim-transition';
import { applyFinalizedAccountJEvents } from '../../../entity/tx/j-events-account';
import { getAccountStateDomain, requireAccountDeltaTransformerAddress } from '../../consensus/helpers';
import { createStructuredLogger, shortHash } from '../../../infra/logger';

const jEventClaimLog = createStructuredLogger('account.j_event');

export function handleJEventClaim(
  accountMachine: AccountMachine,
  accountTx: Extract<AccountTx, { type: 'j_event_claim' }>,
  byLeft: boolean,
  _currentTimestamp: number,
  isValidation: boolean,
  myEntityId: string,
  emitRebalanceDebug: (payload: Record<string, unknown>) => void,
  env: Env,
  session: AccountJClaimSession,
): { success: boolean; events: string[]; error?: string } {
  const { jHeight, jBlockHash } = accountTx.data;
  jEventClaimLog.debug('claim.received', { jHeight, hash: shortHash(jBlockHash), byLeft });
  const { counterparty } = getAccountPerspective(accountMachine, myEntityId);
  const transition = applyAccountJClaimTransition(
    accountMachine,
    accountTx,
    byLeft,
    getAccountStateDomain(accountMachine),
    session,
  );
  if (transition.status === 'pending' || transition.status === 'idempotent' || transition.status === 'stale') {
    accountMachine.leftPendingJClaims = transition.left;
    accountMachine.rightPendingJClaims = transition.right;
    return {
      success: true,
      events: [transition.status === 'pending'
        ? '📥 J-event claim authenticated and retained'
        : `ℹ️ j_event_claim ${transition.status}`],
    };
  }

  const staged = structuredClone(accountMachine);
  staged.leftPendingJClaims = transition.left;
  staged.rightPendingJClaims = transition.right;
  applyFinalizedAccountJEvents(
    staged,
    counterparty,
    transition.events,
    requireAccountDeltaTransformerAddress(env, staged),
  );
  staged.lastFinalizedJHeight = jHeight;
  Object.assign(accountMachine, staged);
  if (!staged.settlementWorkspace) delete accountMachine.settlementWorkspace;

  const settledTokenId = Number(
    transition.events.find((event) => event.type === 'AccountSettled')?.data?.tokenId ?? 1,
  );
  const delta = accountMachine.deltas.get(settledTokenId);
  if (!isValidation) {
    env.emit('account_settled_finalized_bilateral', {
      entityId: myEntityId,
      accountId: counterparty,
      tokenId: settledTokenId,
      jHeight,
      collateral: String(delta?.collateral ?? 0n),
      ondelta: String(delta?.ondelta ?? 0n),
    });
    emitRebalanceDebug({
      step: 5,
      status: 'ok',
      event: 'account_settled_finalized_bilateral',
      jHeight,
      accountId: counterparty,
      tokenId: settledTokenId,
      collateral: String(delta?.collateral ?? 0n),
      ondelta: String(delta?.ondelta ?? 0n),
    });
  }
  return { success: true, events: ['✅ J-event claim finalized bilaterally'] };
}
