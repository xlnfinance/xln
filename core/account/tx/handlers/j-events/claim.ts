import type { AccountTx , AccountOutput } from '../../../../types/account';
import type { AccountJClaimSession } from '../../../j-claims/j-claim-session';
import { getAccountPerspective } from '../../../state/perspective';
import {
  applyAccountJClaimTransition,
  validateAccountJEventClaimAdmission,
} from '../../../j-claims/j-claim-transition';
import { applyFinalizedAccountJEventsOnView } from './finality';
import {
  getAccountStateDomain,
  requireAccountDeltaTransformerAddress,
  type AccountJurisdictionView,
} from '../../../consensus/helpers';
import { createStructuredLogger, shortHash } from '../../../../support/logger';
import type { ApplyAccountTxResult } from '../../apply-types';
import { accountTxApplied, accountTxValidationRejected } from '../../apply-result';
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
  const admission = validateAccountJEventClaimAdmission(
    account.state,
    accountTx,
    getAccountStateDomain(account.state),
  );
  if (!admission.ok) return accountTxValidationRejected(admission.message, []);
  const transition = applyAccountJClaimTransition(
    account.state,
    accountTx,
    byLeft,
    session,
    admission.admission,
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
  const unadmitted = applyFinalizedAccountJEventsOnView(
    account,
    counterparty,
    transition.events,
    requireAccountDeltaTransformerAddress(jurisdictions, account.state),
  );
  account.state.lastFinalizedJHeight = jHeight;
  jEventClaimLog.debug('claim.applied_to_draft', { jHeight });

  const settled = transition.events.filter(event => event.type === 'AccountSettled');
  const first = settled[0];
  if (!first) throw new Error('ACCOUNT_J_CLAIM_ACCOUNT_SETTLED_REQUIRED');
  const last = settled.findLast(event => event.data.tokenId === first.data.tokenId);
  if (!last) throw new Error('ACCOUNT_J_CLAIM_ACCOUNT_SETTLED_REQUIRED');
  // This function only describes candidate effects; Runtime dispatch happens
  // after Entity commit. Retaining the effect during validation lets the
  // receiver install one verified Account transition instead of replaying it
  // merely to rediscover the same output. Rejected validation drops it.
  const data = {
    entityId: myEntityId,
    accountId: counterparty,
    tokenId: first.data.tokenId,
    jHeight,
    collateral: String(last.data.collateral),
    ondelta: String(last.data.ondelta),
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
  return accountTxApplied([unadmitted === 0
    ? '✅ J-event claim finalized bilaterally'
    : `✅ J-event claim finalized bilaterally; unadmitted asset rows excluded: ${unadmitted}`]);
}
