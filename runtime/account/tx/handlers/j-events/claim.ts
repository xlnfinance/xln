import type { AccountReplica, AccountTx } from '../../../../types/account';
import type { AccountOutput } from '../../../../types/account';
import type { AccountJClaimSession } from '../../../j-claims/j-claim-session';
import { getAccountPerspective } from '../../../state/perspective';
import { applyAccountJClaimTransition } from '../../../j-claims/j-claim-transition';
import { applyFinalizedAccountJEvents } from './finality';
import {
  getAccountStateDomain,
  requireAccountDeltaTransformerAddress,
  type AccountJurisdictionView,
} from '../../../consensus/helpers';
import { createStructuredLogger, shortHash } from '../../../../infra/logger';
import type { ApplyAccountTxResult } from '../../apply-types';
import { accountTxApplied } from '../../apply-result';

const jEventClaimLog = createStructuredLogger('account.j_event');

export function handleJEventClaim(
  account: AccountReplica,
  accountTx: Extract<AccountTx, { type: 'j_event_claim' }>,
  byLeft: boolean,
  _currentTimestamp: number,
  isValidation: boolean,
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

  const staged = structuredClone(account);
  staged.state.leftPendingJClaims = transition.left;
  staged.state.rightPendingJClaims = transition.right;
  applyFinalizedAccountJEvents(
    staged,
    counterparty,
    transition.events,
    requireAccountDeltaTransformerAddress(jurisdictions, staged.state),
  );
  staged.state.lastFinalizedJHeight = jHeight;
  Object.assign(account, staged);
  if (!staged.state.settlementWorkspace) delete account.state.settlementWorkspace;

  const settledTokenId = Number(
    transition.events.find((event) => event.type === 'AccountSettled')?.data?.tokenId ?? 1,
  );
  const delta = account.state.deltas.get(settledTokenId);
  if (!isValidation) {
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
  }
  return accountTxApplied(['✅ J-event claim finalized bilaterally']);
}
