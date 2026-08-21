import type { AccountTx , AccountOutput } from '../../../../types/account';
import type { AccountJClaimSession } from '../../../j-claims/j-claim-session';
import { getAccountPerspective } from '../../../state/perspective';
import { applyAccountJClaimTransition } from '../../../j-claims/j-claim-transition';
import { applyFinalizedAccountJEventsOnView } from './finality';
import {
  getAccountStateDomain,
  requireAccountDeltaTransformerAddress,
  type AccountJurisdictionView,
} from '../../../consensus/helpers';
import { createStructuredLogger, shortHash } from '../../../../support/logger';
import type { ApplyAccountTxResult } from '../../apply-types';
import { accountTxApplied } from '../../apply-result';
import type { AccountDraftReplica } from '../../../state/account-state-draft';

const jEventClaimLog = createStructuredLogger('account.j_event');

export function handleJEventClaim(
  account: AccountDraftReplica,
  accountTx: Extract<AccountTx, { type: 'j_event_claim' }>,
  byLeft: boolean,
  _currentTimestamp: number,
  myEntityId: string,
  candidateEffects: AccountOutput[],
  jurisdictions: AccountJurisdictionView,
  session: AccountJClaimSession,
): ApplyAccountTxResult {
  const { jHeight, jBlockHash } = accountTx.data;
  jEventClaimLog.debug('claim.received', { jHeight, hash: shortHash(jBlockHash), byLeft });
  const { counterparty } = getAccountPerspective(account.state, myEntityId);
  const transition = applyAccountJClaimTransition(
    account.state,
    accountTx,
    byLeft,
    getAccountStateDomain(account.state),
    session,
  );
  if (transition.status === 'pending' || transition.status === 'idempotent' || transition.status === 'stale') {
    account.state.leftPendingJClaims = transition.left;
    account.state.rightPendingJClaims = transition.right;
    return accountTxApplied([transition.status === 'pending'
        ? '📥 J-event claim authenticated and retained'
        : `ℹ️ j_event_claim ${transition.status}`]);
  }

  // `applyAccountTx` already owns the Account transition. Opening another
  // transition here would make draft Patricia collections appear committed and
  // break exact rollback. Finality mutates the existing owned view; rejection
  // discards that one owner at the Account-machine boundary.
  account.state.leftPendingJClaims = transition.left;
  account.state.rightPendingJClaims = transition.right;
  applyFinalizedAccountJEventsOnView(
    account,
    counterparty,
    transition.events,
    requireAccountDeltaTransformerAddress(jurisdictions, account.state),
  );
  account.state.lastFinalizedJHeight = jHeight;
  jEventClaimLog.debug('claim.applied_to_draft', { jHeight });

  const settledTokenId = Number(
    transition.events.find((event) => event.type === 'AccountSettled')?.data?.tokenId ?? 1,
  );
  const delta = account.state.deltas.get(settledTokenId);
  // This function only describes candidate effects; Runtime dispatch happens
  // after Entity commit. Retaining the effect during validation lets the
  // receiver install one verified Account transition instead of replaying it
  // merely to rediscover the same output. Rejected validation drops it.
  const data = {
    entityId: myEntityId,
    accountId: counterparty,
    tokenId: settledTokenId,
    jHeight,
    collateral: String(delta?.collateral ?? 0n),
    ondelta: String(delta?.ondelta ?? 0n),
  };
  candidateEffects.push({
    kind: 'runtimeEvent',
    eventName: 'account_settled_finalized_bilateral',
    data,
  });
  candidateEffects.push({
    kind: 'debug',
    payload: {
      level: 'info',
      code: 'REB_STEP',
      step: 5,
      status: 'ok',
      event: 'account_settled_finalized_bilateral',
      ...data,
    },
  });
  return accountTxApplied(['✅ J-event claim finalized bilaterally']);
}
